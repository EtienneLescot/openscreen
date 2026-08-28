//! OpenScreen Linux capture helper.
//!
//! WHY THIS EXISTS. Two reasons, and they turned out to be the same reason.
//!
//! `screen.getCursorScreenPoint()` returns {0,0} under Wayland, so
//! `TelemetryRecordingSession` produced recordings whose every cursor sample sat
//! in the screen's top-left corner while looking perfectly well-formed. The only
//! source of truth for the pointer on Wayland is the ScreenCast portal's
//! METADATA cursor mode.
//!
//! And in that same mode the compositor keeps the cursor OUT of the captured
//! pixels — which is what the editor needs in order to draw its own. Chromium's
//! `getDisplayMedia` gives the opposite: a frame with the pointer already
//! painted in, and no way to know where it was. One portal session answers both,
//! and it has to be one session because SelectSources may only be called once.
//!
//! SHAPE. A stdio sidecar, like the macOS and Windows helpers: JSON request in
//! argv[1], NDJSON events on stdout, `stop`/`pause`/`resume` (or EOF) on stdin.
//! With `outputPath` it also encodes H.264 and writes an MP4; without it, it is
//! the cursor-only session Stage 1 shipped, which is what
//! `PipeWireCursorRecordingSession` still uses.
//!
//! MOUSE BUTTONS. Not from the portal — Wayland exposes no portal for input
//! events. The one source left is evdev (/dev/input/event*), which is root:input
//! and so needs the user in the `input` group. When that permission exists the
//! helper reads left-button presses and tags the coinciding sample "click"; when
//! it does not, every sample is a "move", as before. See `input.rs` for the
//! reader and its deliberately narrow scope (BTN_LEFT only, never keystrokes).

mod bitmap;
mod capture;
mod dmabuf_import;
mod encoder;
mod events;
mod ffmpeg;
mod input;
mod portal;
mod shim;

use std::collections::HashSet;
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Deserialize;

use capture::Capture;
use events::{timestamp_ms, CursorAsset, Emitter, Event};
use shim::{FrameMailbox, StreamEvent};

/// Matches the macOS helper's default and the Electron side's sampleIntervalMs.
const DEFAULT_SAMPLE_INTERVAL_MS: u64 = 33;
const MIN_SAMPLE_INTERVAL_MS: u64 = 8;

const DEFAULT_FPS: i32 = 30;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct VideoRequest {
    fps: Option<i32>,
    bitrate: Option<i64>,
}

/// Mirrors the `audio` block of `NativeWindowsRecordingRequest`
/// (src/lib/nativeWindowsRecording.ts) so the three platforms take the same
/// request shape.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct AudioRequest {
    system: SystemAudioRequest,
    microphone: MicrophoneRequest,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct SystemAudioRequest {
    enabled: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct MicrophoneRequest {
    enabled: bool,
    /// A PipeWire node name (`node.name`), not the browser device id the UI
    /// carries: the two namespaces are unrelated and there is no mapping
    /// between them. Absent means the session default source.
    device_name: Option<String>,
    /// Linear multiplier the UI applies to microphone level.
    gain: Option<f32>,
}

const DEFAULT_AUDIO_BITRATE: i64 = 128_000;
/// How many frames a window stream may deliver without a crop rectangle before
/// the helper gives up waiting and records the whole stream.
///
/// mutter records one frame synchronously when the stream is enabled, which can
/// land before the picked window is mapped and therefore carry an empty rect. A
/// handful of frames is ~100 ms at 60 fps — long enough to skip that, short
/// enough that a compositor which never sends a crop still starts recording.
const MAX_FRAMES_AWAITING_CROP: u32 = 8;
/// How much audio may queue before the oldest is discarded. Generous: the drain
/// runs every loop tick, so reaching this means the encoder stopped entirely.
const AUDIO_RING_SECONDS: usize = 2;
/// How many dmabuf imports may fail in a row before the recording gives up. One
/// failure is a recoverable dropped frame (the previous is held forward), but this
/// many in a row means the import path is broken — typically a render node that
/// cannot map the compositor's GPU buffers — and the file would otherwise be empty
/// behind a wall of `frame-dropped` warnings. ~1–2 s at 30–60 fps.
const MAX_CONSECUTIVE_IMPORT_FAILURES: u32 = 60;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Request {
    sample_interval_ms: Option<u64>,
    /// Where to write the MP4. Absent means cursor-only: no pixels are mapped,
    /// no encoder is opened, and the helper behaves exactly as Stage 1 did.
    output_path: Option<String>,
    /// `"metadata"` (default) keeps the pointer out of the pixels so the editor
    /// can draw its own; `"embedded"` asks the compositor to paint it in. These
    /// are the two halves of the HUD's cursor-mode toggle.
    cursor_mode: Option<String>,
    video: Option<VideoRequest>,
    audio: Option<AudioRequest>,
    /// Negotiate the portal, report `source-selected`, then WAIT for `record` on
    /// stdin before connecting to PipeWire.
    ///
    /// Splits "the user has chosen what to share" from "pixels are flowing", so a
    /// caller can put a countdown between them instead of counting down before
    /// the picker has even appeared. Defaults to false, which keeps the
    /// single-shot behaviour every existing caller relies on.
    defer_start: bool,
    /// Emit `ready` and exit, without ever calling the portal's `Start()`.
    ///
    /// Everything up to that point is non-interactive; `Start()` is the single
    /// call that raises the compositor's source picker. This flag is what makes
    /// the dlopen path, the portal connection and the cursor-mode check testable
    /// — in CI or by hand — without hijacking someone's screen.
    probe_only: bool,
}

impl Request {
    fn cursor_mode(&self) -> Result<portal::CursorMode, String> {
        match self.cursor_mode.as_deref() {
            None | Some("") | Some("metadata") => Ok(portal::CursorMode::Metadata),
            Some("embedded") => Ok(portal::CursorMode::Embedded),
            Some("hidden") => Ok(portal::CursorMode::Hidden),
            Some(other) => Err(format!(
                "cursorMode must be one of metadata, embedded, hidden — got {other:?}"
            )),
        }
    }

    fn fps(&self) -> i32 {
        self.video
            .as_ref()
            .and_then(|video| video.fps)
            .filter(|fps| *fps > 0 && *fps <= 240)
            .unwrap_or(DEFAULT_FPS)
    }

    /// An explicit override, or `None` to let the encoder derive one from the
    /// size the compositor negotiates. `None` is the normal case: on Wayland the
    /// app cannot know the capture resolution in advance, so a bitrate chosen
    /// caller-side is a guess about a picture nobody has seen yet.
    fn bitrate(&self) -> Option<i64> {
        self.video
            .as_ref()
            .and_then(|video| video.bitrate)
            .filter(|bitrate| *bitrate > 0)
    }

    /// The audio streams to open, in the order they become MP4 tracks.
    ///
    /// Empty when no output file was requested: a cursor-only session has
    /// nothing to mux audio into, and opening a capture stream would show the
    /// user a recording indicator for a recording that is not happening.
    fn audio_sources(&self) -> Vec<AudioSourceConfig> {
        if self.output_path.is_none() {
            return Vec::new();
        }
        let Some(audio) = self.audio.as_ref() else {
            return Vec::new();
        };
        let mut sources = Vec::new();
        if audio.system.enabled {
            sources.push(AudioSourceConfig {
                label: "system",
                target: None,
                // The default SINK's monitor: what is being played, not what a
                // microphone hears.
                capture_sink: true,
                gain: 1.0,
                bitrate: DEFAULT_AUDIO_BITRATE,
            });
        }
        if audio.microphone.enabled {
            sources.push(AudioSourceConfig {
                label: "microphone",
                target: audio.microphone.device_name.clone(),
                capture_sink: false,
                gain: audio.microphone.gain.filter(|gain| *gain > 0.0).unwrap_or(1.0),
                bitrate: DEFAULT_AUDIO_BITRATE,
            });
        }
        sources
    }
}

struct AudioSourceConfig {
    label: &'static str,
    target: Option<String>,
    capture_sink: bool,
    gain: f32,
    bitrate: i64,
}

enum Message {
    Portal(Box<Result<portal::PortalStream, portal::PortalError>>),
    Stream(StreamEvent),
    /// A left mouse-button press observed on evdev, carrying the press time in
    /// milliseconds so the emitted click sample is stamped when it happened
    /// rather than at the next throttled sample. See [`input`] for why this is
    /// the only way to see a button on Wayland, and for its permission and
    /// privacy model.
    PointerButton(u64),
    /// A pointer reader thread stopped on a device error (typically an unplug);
    /// the string is the OS error. Surfaced as a warning so click capture going
    /// quiet mid-recording is not silent.
    PointerDeviceLost(String),
    /// Arm a deferred session: connect to PipeWire and start encoding.
    Record,
    Pause,
    Resume,
    Stop,
}

fn main() {
    let debug = std::env::var("OPENSCREEN_PIPEWIRE_DEBUG")
        .map(|value| !matches!(value.as_str(), "" | "0" | "false"))
        .unwrap_or(false);
    let mut emitter = Emitter::new(std::io::stdout(), debug);

    let request = match parse_request() {
        Ok(request) => request,
        Err(message) => {
            fail(&mut emitter, "invalid-arguments", &message);
        }
    };
    let cursor_mode = match request.cursor_mode() {
        Ok(mode) => mode,
        Err(message) => fail(&mut emitter, "invalid-arguments", &message),
    };
    let output_path = request.output_path.as_deref().map(PathBuf::from);
    let forced_encoder = match encoder::forced_backend_from_env() {
        Ok(backend) => backend,
        Err(message) => fail(&mut emitter, "invalid-arguments", &message),
    };

    // The loop has to serve two clocks: cursor samples at the requested interval
    // and video frames at the video frame rate. It ticks at whichever is
    // shorter, so neither is ever late by more than the other's period.
    let sample_interval = Duration::from_millis(
        request
            .sample_interval_ms
            .unwrap_or(DEFAULT_SAMPLE_INTERVAL_MS)
            .max(MIN_SAMPLE_INTERVAL_MS),
    );
    let tick = match output_path {
        Some(_) => sample_interval.min(Duration::from_nanos(
            1_000_000_000 / request.fps().max(1) as u64,
        )),
        None => sample_interval,
    };

    if let Err(message) = shim::load() {
        fail(&mut emitter, "pipewire-unavailable", &message);
    }

    // Probed before `ready` so the event can report it, and so an unsupported
    // compositor fails immediately instead of after a pointless picker. Only
    // fatal when METADATA is the mode actually requested — a recording that
    // wants the system cursor painted in has no use for it.
    let cursor_metadata_supported = match pollster::block_on(portal::cursor_metadata_supported()) {
        Ok(supported) => supported,
        Err(error) => fail(&mut emitter, error.code(), &error.message()),
    };
    if !cursor_metadata_supported && cursor_mode.reports_cursor() {
        let error = portal::PortalError::CursorMetadataUnsupported;
        fail(&mut emitter, error.code(), &error.message());
    }

    let _ = emitter.emit(&Event::Ready {
        timestamp_ms: timestamp_ms(),
        pipewire_version: shim::library_version(),
        cursor_metadata_supported,
    });

    if request.probe_only {
        std::process::exit(0);
    }

    let (sender, receiver) = mpsc::channel::<Message>();
    spawn_stdin_reader(sender.clone());
    spawn_portal(sender.clone(), cursor_mode);
    // Left-button telemetry from evdev. Gated on the cursor mode FIRST: a session
    // that paints no cursor emits no samples to tag, so opening every pointer node
    // and blocking a thread on each would buy nothing. Warn only when the devices
    // are unreadable — never when the operator opted out through the env var,
    // which would recommend the permission they just declined — so a "clicks do
    // nothing on Linux" report is answerable from the log alone rather than
    // looking like a capture bug.
    if cursor_mode.reports_cursor()
        && input::spawn_readers(&sender) == input::ClickCapture::NoDevice
    {
        let _ = emitter.emit(&Event::Warning {
            code: "click-capture-unavailable".to_owned(),
            message: "no readable /dev/input pointer device — add this user to the 'input' \
                      group to record click telemetry; cursor samples will otherwise all be moves"
                .to_owned(),
        });
    }

    let session = RunConfig {
        tick,
        sample_interval,
        output_path,
        fps: request.fps(),
        bitrate: request.bitrate(),
        forced_encoder,
        cursor_mode,
        audio: request.audio_sources(),
        defer_start: request.defer_start,
    };
    let exit_code = run(&mut emitter, receiver, sender, session);
    std::process::exit(exit_code);
}

struct RunConfig {
    /// How often the loop wakes when nothing arrives.
    tick: Duration,
    /// Minimum spacing between cursor samples on stdout.
    sample_interval: Duration,
    /// `None` for a cursor-only session.
    output_path: Option<PathBuf>,
    fps: i32,
    /// `None` lets the encoder derive one from the negotiated size.
    bitrate: Option<i64>,
    forced_encoder: Option<encoder::Backend>,
    cursor_mode: portal::CursorMode,
    audio: Vec<AudioSourceConfig>,
    /// Wait for `record` on stdin before connecting to PipeWire. See
    /// [`Request::defer_start`].
    defer_start: bool,
}

/// Opens every requested audio stream, returning the live sessions (which must
/// outlive the loop) and the sources to hand to the muxer.
///
/// A stream that fails to open is a warning, not a failure: a recording with
/// picture and no system audio is worth far more to the user than no recording
/// at all, and the most likely cause — a sandbox without the PipeWire socket —
/// is not something the helper can fix.
fn start_audio<W: Write>(
    emitter: &mut Emitter<W>,
    configs: &[AudioSourceConfig],
) -> (Vec<shim::AudioSession>, Vec<capture::AudioSource>) {
    let mut sessions = Vec::new();
    let mut sources = Vec::new();
    // Enumerated ONCE for the whole recording, not per stream: it opens its own
    // PipeWire connection and runs a loop to completion, so doing it per source
    // would pay that cost twice for no new information.
    let graph = if configs.iter().any(|c| c.target.is_some()) {
        match shim::list_audio_sources() {
            Ok(list) => list,
            Err(message) => {
                let _ = emitter.emit(&Event::Warning {
                    code: "audio-enumeration-failed".to_owned(),
                    message: format!(
                        "the PipeWire graph could not be listed, so the requested microphone \
                         cannot be resolved and the session default will be used instead: {message}"
                    ),
                });
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };

    for config in configs {
        let ring = Arc::new(shim::AudioRing::new(
            AUDIO_RING_SECONDS,
            encoder::AUDIO_SAMPLE_RATE as usize,
            encoder::AUDIO_CHANNELS,
        ));
        let label = config.label;
        // A label we cannot place resolves to None, which means "no target" —
        // PipeWire then links to the session default source. That is the old
        // behaviour and the right fallback: a default microphone beats none.
        let resolved = config
            .target
            .as_deref()
            .and_then(|wanted| resolve_microphone_node(wanted, &graph));
        let _ = emitter.emit(&Event::AudioSource {
            role: label.to_owned(),
            requested: config.target.clone(),
            node: resolved.clone(),
        });
        if let Some(wanted) = config.target.as_deref() {
            if resolved.is_none() {
                let _ = emitter.emit(&Event::Warning {
                    code: "microphone-not-found".to_owned(),
                    message: format!(
                        "no PipeWire capture node matches {wanted:?}, so the session default \
                         source will be recorded instead — which is often not the microphone \
                         the user picked."
                    ),
                });
            }
        }
        let session = shim::AudioSession::start(
            resolved.as_deref(),
            config.capture_sink,
            encoder::AUDIO_SAMPLE_RATE as u32,
            encoder::AUDIO_CHANNELS as u32,
            ring.clone(),
            Box::new(move |state, error| {
                if let Some(error) = error {
                    eprintln!("[audio:{label}] stream error in state {state}: {error}");
                }
            }),
        );
        match session {
            Ok(session) => {
                sessions.push(session);
                sources.push(capture::AudioSource {
                    label: config.label,
                    ring,
                    gain: config.gain,
                    bitrate: config.bitrate,
                });
            }
            Err(message) => {
                let _ = emitter.emit(&Event::Warning {
                    code: "audio-unavailable".to_owned(),
                    message: format!(
                        "the {} audio stream could not be opened, so the recording will \
                         have no {} track: {message}",
                        config.label, config.label
                    ),
                });
            }
        }
    }
    (sessions, sources)
}

fn parse_request() -> Result<Request, String> {
    match std::env::args().nth(1) {
        None => Ok(Request::default()),
        Some(raw) => serde_json::from_str(&raw)
            .map_err(|error| format!("could not parse the request argument as JSON: {error}")),
    }
}

fn fail<W: Write>(emitter: &mut Emitter<W>, code: &str, message: &str) -> ! {
    let _ = emitter.emit(&Event::Error {
        code: code.to_owned(),
        message: message.to_owned(),
    });
    std::process::exit(1);
}

/// EOF counts as `stop`: if the parent dies, so do we.
///
/// The command vocabulary is the Windows and macOS helpers': `stop`, `pause`,
/// `resume`, one per line on stdin (see the `proc.stdin.write("pause\n")` calls
/// in electron/ipc/handlers.ts). Unknown lines are ignored rather than fatal —
/// a newer parent talking to an older helper should degrade, not crash.
fn spawn_stdin_reader(sender: Sender<Message>) {
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else { break };
            match line.trim() {
                "stop" => break,
                // Arms a `deferStart` session. Ignored by a session that was not
                // deferred, and unknown verbs already fall through to `continue`,
                // so an older helper receiving this degrades instead of dying.
                "record" => {
                    if sender.send(Message::Record).is_err() {
                        return;
                    }
                }
                "pause" => {
                    if sender.send(Message::Pause).is_err() {
                        return;
                    }
                }
                "resume" => {
                    if sender.send(Message::Resume).is_err() {
                        return;
                    }
                }
                _ => continue,
            }
        }
        let _ = sender.send(Message::Stop);
    });
}

/// The portal runs on its own thread because `Start()` blocks on the user for
/// an unbounded time, and a `stop` arriving during the picker must still be
/// honoured.
fn spawn_portal(sender: Sender<Message>, cursor_mode: portal::CursorMode) {
    std::thread::spawn(move || {
        let result = pollster::block_on(portal::negotiate(cursor_mode));
        let _ = sender.send(Message::Portal(Box::new(result)));
    });
}

/// Latest known cursor state, resent on the heartbeat so a motionless pointer
/// still produces the steady sample cadence the editor's cursor track expects.
struct CursorState {
    x: i32,
    y: i32,
    asset_id: Option<String>,
}

/// Connects the PipeWire consumer to a grant the portal already made.
///
/// Split out because it runs from two places: straight off the portal reply in
/// the single-shot path, and from `record` in the deferred path where the grant
/// has been sitting in `pending_portal` while the caller ran its countdown.
#[allow(clippy::too_many_arguments)]
fn begin_stream<W: Write>(
    emitter: &mut Emitter<W>,
    sender: &Sender<Message>,
    frames: &Option<Arc<shim::FrameMailbox>>,
    session: &mut Option<shim::Session>,
    portal_stream: &mut Option<StreamInfo>,
    granted_kind: &mut Option<portal::SourceKind>,
    stream: portal::PortalStream,
    prefer_dmabuf: bool,
) -> Result<(), ()> {
    // The fd is consumed by libpipewire; the rest is kept for the
    // `stream-started` event, emitted once the format is negotiated.
    let portal::PortalStream { fd, node_id, position, source_kind, .. } = stream;
    let forward = sender.clone();
    match shim::Session::start(
        fd,
        node_id,
        Box::new(move |event| {
            let _ = forward.send(Message::Stream(event));
        }),
        frames.clone(),
        prefer_dmabuf,
    ) {
        Ok(started) => {
            *session = Some(started);
            *granted_kind = source_kind;
            *portal_stream = Some(StreamInfo { node_id, position, source_kind });
            Ok(())
        }
        Err(message) => {
            let _ = emitter.emit(&Event::Error {
                code: "pipewire-connect-failed".to_owned(),
                message,
            });
            Err(())
        }
    }
}

/// What survives from the portal reply after its fd has been handed to
/// libpipewire — everything `stream-started` needs to report.
struct StreamInfo {
    node_id: u32,
    position: Option<(i32, i32)>,
    source_kind: Option<portal::SourceKind>,
}

fn run<W: Write>(
    emitter: &mut Emitter<W>,
    receiver: mpsc::Receiver<Message>,
    sender: Sender<Message>,
    config: RunConfig,
) -> i32 {
    let constants = shim::constants();
    // Held for the whole loop: dropping it stops and joins the PipeWire thread.
    let mut session: Option<shim::Session> = None;
    let mut portal_stream: Option<StreamInfo> = None;
    let mut size: Option<(i32, i32)> = None;
    // What the portal granted, kept past the `StreamInfo` that is consumed at
    // Format: only a window stream is expected to carry a crop.
    let mut granted_kind: Option<portal::SourceKind> = None;
    // Frames skipped while waiting for a window's first usable crop rectangle.
    let mut frames_awaiting_crop: u32 = 0;
    // A crop change is reported once, not once per frame.
    let mut crop_change_reported = false;
    // A `deferStart` grant held while the caller runs its countdown.
    let mut pending_portal: Option<portal::PortalStream> = None;
    // `record` has been received. Latched, because it can arrive before the
    // picker has been answered.
    let mut armed = false;
    let mut cursor: Option<CursorState> = None;
    let mut known_assets: HashSet<String> = HashSet::new();
    let mut pending_asset: Option<CursorAsset> = None;
    // Wall-clock ms at which the pw_stream last reached `streaming` (mutter began
    // handing us frames), or `None` when it is not streaming. A press counts only
    // if its own read time is at or after this: before streaming the only thing on
    // screen is the portal picker, and the click that dismisses it (its "Share"
    // button) would otherwise ride out on the first sample as a phantom click at
    // t≈0. Comparing timestamps rather than a bare flag closes two gaps: the press
    // and the stream-state arrive on DIFFERENT channels, so a pre-stream press can
    // be dequeued after the flag flips (it is still dropped, its time is older);
    // and clearing it on disconnect stops clicks emitting against a stale cursor
    // after capture has stopped.
    let mut streaming_since: Option<u64> = None;
    let mut reported_cursor_meta = false;
    // Allocated up front so the PipeWire callback has somewhere to put frames
    // from the very first buffer; `None` in cursor-only mode, which is also what
    // tells `Session::start` not to map the buffers at all.
    let frames: Option<Arc<FrameMailbox>> = config
        .output_path
        .as_ref()
        .map(|_| Arc::new(FrameMailbox::default()));
    // Offer dmabuf ahead of shm (issue #507) only for a video session, only when
    // the VAAPI import pipeline actually builds on this GPU, AND only when the
    // forced-encoder choice can consume it — `software`/`vulkan` cannot, and
    // offering dmabuf they can't import makes the first frame fail. The available()
    // probe constructs a VAAPI device and filtergraph once here, so a machine that
    // cannot import keeps the shm path with no per-recording cost.
    let prefer_dmabuf = frames.is_some()
        && crate::dmabuf_import::available()
        && encoder::forced_allows_dmabuf(config.forced_encoder);
    if frames.is_some() {
        let _ = emitter.emit(&Event::Debug {
            code: "dmabuf-import".to_owned(),
            data: json_map([("available", prefer_dmabuf.into())]),
        });
    }
    let mut capture: Option<Capture> = None;
    // Started before the portal picker so the streams are warm and the graph
    // has settled by the time the first video frame arrives. Everything they
    // record before that first frame is discarded — see `Capture::stage`.
    // `_audio_sessions` is bound, not dropped: dropping one stops its thread.
    let (_audio_sessions, mut audio_sources) = start_audio(emitter, &config.audio);
    // Buffered until the format is negotiated: the encoder cannot be opened
    // before the frame size is known, and `pause` can arrive first.
    let mut paused = false;
    // Backdated so the very first sample is not held back by the throttle.
    // `checked_sub` because a bare `Instant - Duration` panics on underflow, and
    // this runs milliseconds after process start.
    let mut last_emit = Instant::now()
        .checked_sub(config.sample_interval)
        .unwrap_or_else(Instant::now);
    let mut exit_code = 0;
    // Consecutive dmabuf import failures; reset on any staged frame. A run of them
    // means the import never works, which would otherwise record nothing — see
    // MAX_CONSECUTIVE_IMPORT_FAILURES.
    let mut consecutive_drops: u32 = 0;

    loop {
        // Return PipeWire buffers whose dmabuf imports completed last iteration
        // (or that were superseded on the capture thread). This MUST run on this
        // loop, not the PipeWire thread — `Session::requeue` takes the thread-loop
        // lock, which would deadlock from inside the loop. The one-tick delay is
        // harmless: the import has already copied the pixels, so the buffer is
        // free, and the pool has other buffers in flight meanwhile.
        if let (Some(session), Some(mailbox)) = (session.as_ref(), frames.as_ref()) {
            for handle in mailbox.drain_requeue() {
                session.requeue(handle);
            }
        }

        match receiver.recv_timeout(config.tick) {
            Ok(Message::Stop) => break,

            // Emit a click sample straight away at the current cursor position,
            // stamped with the press time the reader captured: immediate so it is
            // not backdated to the next throttled sample, and one sample per press
            // so a rapid double-click reads as two clicks rather than collapsing
            // into one. Counted only if the press happened at or after streaming
            // began (see `streaming_since`): a press while the picker is still up —
            // the click on its "Share" button — is older, so it is dropped even if
            // its message is delivered after the stream-state one.
            Ok(Message::PointerButton(press_ms)) => {
                if streaming_since.is_some_and(|since| press_ms >= since) {
                    emit_sample(emitter, &cursor, size, &mut pending_asset, Some(press_ms));
                }
            }

            // A reader lost its device (typically an unplug). Report it — if it
            // was the only pointer, clicks stop until one is (re)connected, which
            // the input watcher will pick up.
            Ok(Message::PointerDeviceLost(reason)) => {
                let _ = emitter.emit(&Event::Warning {
                    code: "click-capture-device-lost".to_owned(),
                    message: format!(
                        "a pointer device stopped delivering clicks ({reason}); if it was the \
                         only one, clicks are not captured until a device is reconnected"
                    ),
                });
            }

            Ok(Message::Pause) => {
                paused = true;
                if let Some(capture) = capture.as_mut() {
                    capture.pause();
                }
            }

            Ok(Message::Resume) => {
                paused = false;
                if let Some(capture) = capture.as_mut() {
                    capture.resume();
                }
            }

            Ok(Message::Stream(StreamEvent::FrameReady)) => {
                let Some(mailbox) = frames.as_ref() else {
                    continue;
                };
                // `take` can legitimately return None: several FrameReady
                // notifications can arrive for frames that superseded each other
                // in the mailbox before the loop got here.
                if let Some(frame) = mailbox.take() {
                    // Opening the encoder is deferred to here because only a
                    // frame carries the crop, and the crop — not the negotiated
                    // format — is the size of a window.
                    if capture.is_none() {
                        if let Some(path) = config.output_path.as_ref() {
                            // A WINDOW WITHOUT A CROP IS NOT YET TRUSTWORTHY.
                            // mutter's rectangle intersection reports success
                            // even when it produced an empty rect, and it records
                            // one frame synchronously from `enable()` — before
                            // the picked window is necessarily mapped. Committing
                            // the encoder to that frame would pin a window
                            // recording at monitor size for its whole duration,
                            // which is the very bug being fixed, only intermittent.
                            let expecting_crop =
                                granted_kind == Some(portal::SourceKind::Window) && !frame.has_crop;
                            if expecting_crop && frames_awaiting_crop < MAX_FRAMES_AWAITING_CROP {
                                frames_awaiting_crop += 1;
                                mailbox.recycle(frame.pixels);
                                continue;
                            }
                            if expecting_crop {
                                let _ = emitter.emit(&Event::Warning {
                                    code: "window-crop-missing".to_owned(),
                                    message: format!(
                                        "a window was granted but no crop rectangle arrived in \
                                         {frames_awaiting_crop} frames; recording the full \
                                         {}x{} stream instead",
                                        frame.width, frame.height
                                    ),
                                });
                            }

                            // H.264 chroma is subsampled 2x2, so odd dimensions
                            // are a per-encoder lottery. A window's rect is its
                            // own pixel size and is routinely odd.
                            let width = frame.crop.width & !1;
                            let height = frame.crop.height & !1;
                            if width <= 0 || height <= 0 {
                                let _ = emitter.emit(&Event::Error {
                                    code: "encoder-unavailable".to_owned(),
                                    message: format!(
                                        "the compositor reported a {}x{} content rectangle, which \
                                         cannot be encoded",
                                        frame.crop.width, frame.crop.height
                                    ),
                                });
                                exit_code = 1;
                                break;
                            }
                            let _ = emitter.emit(&Event::Debug {
                                code: "crop".to_owned(),
                                data: json_map([
                                    ("streamWidth", frame.width.into()),
                                    ("streamHeight", frame.height.into()),
                                    ("cropX", frame.crop.x.into()),
                                    ("cropY", frame.crop.y.into()),
                                    ("cropWidth", frame.crop.width.into()),
                                    ("cropHeight", frame.crop.height.into()),
                                    ("encodedWidth", width.into()),
                                    ("encodedHeight", height.into()),
                                    ("hasCrop", frame.has_crop.into()),
                                    ("framesAwaited", frames_awaiting_crop.into()),
                                ]),
                            });

                            match Capture::start(
                                path,
                                width,
                                height,
                                config.fps,
                                config.bitrate,
                                config.forced_encoder,
                                std::mem::take(&mut audio_sources),
                                frame.dmabuf.as_ref(),
                            ) {
                                Ok((started, selection)) => {
                                    let _ = emitter.emit(&Event::EncoderSelection {
                                        video: selection.backend.as_str().to_owned(),
                                        rejected: selection.rejected,
                                    });
                                    capture = Some(started);
                                    if paused {
                                        // A `pause` that arrived while the portal
                                        // picker was still up applies to the
                                        // capture that picker was for.
                                        if let Some(capture) = capture.as_mut() {
                                            capture.pause();
                                        }
                                    }
                                }
                                Err(message) => {
                                    let _ = emitter.emit(&Event::Error {
                                        code: "encoder-unavailable".to_owned(),
                                        message,
                                    });
                                    exit_code = 1;
                                    break;
                                }
                            }
                        }
                    }

                    let Some(capture) = capture.as_mut() else {
                        // Cursor-only session: no encoder, nothing to stage. The
                        // recycle below still has to run.
                        mailbox.recycle(frame.pixels);
                        continue;
                    };

                    // A window that was resized mid-recording. The file keeps its
                    // original dimensions — an MP4 track cannot change resolution
                    // — so this is reported rather than silently reframed.
                    if !crop_change_reported && capture.crop_diverged(&frame) {
                        crop_change_reported = true;
                        let _ = emitter.emit(&Event::Warning {
                            code: "crop-changed".to_owned(),
                            message: format!(
                                "the recorded window changed size to {}x{} mid-recording; the \
                                 file keeps the size it started at, so the framing may be cut \
                                 off or padded from here on",
                                frame.crop.width, frame.crop.height
                            ),
                        });
                    }

                    let first = !capture.started();
                    let staged = capture.stage(&frame);
                    let (width, height) = (frame.crop.width, frame.crop.height);
                    mailbox.recycle(frame.pixels);
                    match staged {
                        Ok(capture::StageOutcome::Staged) => {
                            consecutive_drops = 0;
                        }
                        // Recoverable: one frame the GPU could not import. Warn so it
                        // is answerable from the log, then carry on — `advance` holds
                        // the previous frame — rather than ending the file. But a long
                        // RUN of failures means the import path is broken and the file
                        // would be empty, so past the threshold fail loudly with a way
                        // out (the full auto-downgrade to shm remains a follow-up).
                        Ok(capture::StageOutcome::Dropped(reason)) => {
                            consecutive_drops += 1;
                            if consecutive_drops >= MAX_CONSECUTIVE_IMPORT_FAILURES {
                                let _ = emitter.emit(&Event::Error {
                                    code: "encode-failed".to_owned(),
                                    message: format!(
                                        "the GPU could not import {consecutive_drops} captured \
                                         frames in a row ({reason}); the render node likely \
                                         cannot map the compositor's buffers. Set \
                                         OPENSCREEN_LINUX_RENDER_NODE to the correct /dev/dri \
                                         node, or OPENSCREEN_LINUX_ENCODER=software for the CPU \
                                         path."
                                    ),
                                });
                                exit_code = 1;
                                break;
                            }
                            let _ = emitter.emit(&Event::Warning {
                                code: "frame-dropped".to_owned(),
                                message: reason,
                            });
                        }
                        Err(message) => {
                            let _ = emitter.emit(&Event::Error {
                                code: "encode-failed".to_owned(),
                                message,
                            });
                            exit_code = 1;
                            break;
                        }
                    }
                    // Only once a frame has actually staged — a first frame that
                    // dropped leaves capture unstarted, so this waits for a real one.
                    if first && capture.started() {
                        let _ = emitter.emit(&Event::CaptureStarted {
                            timestamp_ms: timestamp_ms(),
                            path: config
                                .output_path
                                .as_ref()
                                .map(|path| path.display().to_string())
                                .unwrap_or_default(),
                            width,
                            height,
                            fps: config.fps,
                        });
                    }
                }
                if let Some(capture) = capture.as_mut() {
                    if let Err(message) = capture.advance() {
                        let _ = emitter.emit(&Event::Error {
                            code: "encode-failed".to_owned(),
                            message,
                        });
                        exit_code = 1;
                        break;
                    }
                }
            }

            Ok(Message::Record) => {
                // Arming is idempotent and may arrive before OR after the picker
                // is answered — the user can be slower than the countdown, or
                // faster. Both orderings have to converge on the same state, or a
                // slow picker produces a recording that never starts.
                armed = true;
                if let Some(stream) = pending_portal.take() {
                    if let Err(()) = begin_stream(
                        emitter,
                        &sender,
                        &frames,
                        &mut session,
                        &mut portal_stream,
                        &mut granted_kind,
                        stream,
                        prefer_dmabuf,
                    ) {
                        exit_code = 1;
                        break;
                    }
                }
            }

            Ok(Message::Portal(result)) => match *result {
                Ok(stream) => {
                    // The portal's size is in the compositor's coordinate space
                    // and can differ from the negotiated pixel size on a scaled
                    // display. Logged rather than used: cursor positions arrive
                    // in stream pixels, so only the negotiated size normalises them.
                    let _ = emitter.emit(&Event::Debug {
                        code: "portal-stream".to_owned(),
                        data: json_map([
                            ("nodeId", stream.node_id.into()),
                            ("logicalWidth", stream.size.map(|(w, _)| w).into()),
                            ("logicalHeight", stream.size.map(|(_, h)| h).into()),
                            ("positionX", stream.position.map(|(x, _)| x).into()),
                            ("positionY", stream.position.map(|(_, y)| y).into()),
                            (
                                "sourceKind",
                                stream.source_kind.map(|kind| kind.as_str()).into(),
                            ),
                        ]),
                    });
                    // PROTOCOL, NOT DIAGNOSTICS. The picker has been answered —
                    // which is a different moment from "pixels are flowing", and
                    // the only one at which an app can start a countdown without
                    // it running before the user has been asked anything.
                    let _ = emitter.emit(&Event::SourceSelected {
                        timestamp_ms: timestamp_ms(),
                        node_id: stream.node_id,
                        source_kind: stream.source_kind.map(|kind| kind.as_str().to_owned()),
                        position_x: stream.position.map(|(x, _)| x),
                        position_y: stream.position.map(|(_, y)| y),
                    });
                    granted_kind = stream.source_kind;

                    if config.defer_start && !armed {
                        // Hold the grant WITHOUT connecting a pw_stream. mutter
                        // only enables its capture source on STREAMING, so an
                        // unconnected session costs the compositor nothing and
                        // produces no frames to throw away. Connecting it
                        // inactive instead — OBS's pattern — would expose it to
                        // WirePlumber's idle-node suspend, which tears down the
                        // negotiated format after a few seconds and would lose it
                        // during a countdown.
                        pending_portal = Some(stream);
                    } else if let Err(()) = begin_stream(
                        emitter,
                        &sender,
                        &frames,
                        &mut session,
                        &mut portal_stream,
                        &mut granted_kind,
                        stream,
                        prefer_dmabuf,
                    ) {
                        exit_code = 1;
                        break;
                    }
                }
                Err(error) => {
                    let _ = emitter.emit(&Event::Error {
                        code: error.code().to_owned(),
                        message: error.message(),
                    });
                    exit_code = 1;
                    break;
                }
            },

            Ok(Message::Stream(StreamEvent::Format(format))) => {
                size = Some((format.width, format.height));
                let _ = emitter.emit(&Event::Debug {
                    code: "format".to_owned(),
                    data: json_map([
                        ("videoFormatId", format.video_format.into()),
                        ("framerateNum", format.framerate_num.into()),
                        ("framerateDenom", format.framerate_denom.into()),
                    ]),
                });
                if let Some(stream) = portal_stream.take() {
                    let _ = emitter.emit(&Event::StreamStarted {
                        timestamp_ms: timestamp_ms(),
                        node_id: stream.node_id,
                        width: format.width,
                        height: format.height,
                        position_x: stream.position.map(|(x, _)| x),
                        position_y: stream.position.map(|(_, y)| y),
                        source_kind: stream
                            .source_kind
                            .map(|kind| kind.as_str().to_owned()),
                    });
                }

                // THE ENCODER IS NOT OPENED HERE ANY MORE, and that is the whole
                // window-capture fix. `format` is the size of the STREAM, which
                // for a window is the size of its monitor: a PipeWire stream
                // cannot be resized once negotiated but a window can, so mutter
                // pins the stream to the monitor and reports the window's live
                // rectangle as SPA_META_VideoCrop instead. Sizing the encoder
                // from `format` is what produced window recordings padded out to
                // screen size with black. The size now comes from the first frame
                // carrying a usable crop — see the FrameReady arm.
                if config.output_path.is_some() {
                    if capture.is_some() {
                        let _ = emitter.emit(&Event::Warning {
                            code: "format-renegotiated".to_owned(),
                            message: format!(
                                "the compositor renegotiated to {}x{} mid-recording; the \
                                 encoder keeps its original size and the file may be letterboxed \
                                 or cropped from here on",
                                format.width, format.height
                            ),
                        });
                    }
                }
            }

            Ok(Message::Stream(StreamEvent::BufferInfo {
                data_type,
                n_datas,
                has_cursor_meta,
                cursor_meta_size,
                metas,
            })) => {
                // What memory type does the compositor hand us, and which
                // metadata blocks survived negotiation? `metas` is the load-
                // bearing field: a missing Cursor next to a present Header means
                // our ParamMeta was sent and lost the size intersection, which is
                // otherwise indistinguishable from never having sent it.
                let _ = emitter.emit(&Event::Debug {
                    code: "buffer-info".to_owned(),
                    data: json_map([
                        ("dataType", data_type_name(&constants, data_type).into()),
                        ("dataTypeId", data_type.into()),
                        ("nDatas", n_datas.into()),
                        ("hasCursorMeta", has_cursor_meta.into()),
                        ("cursorMetaSize", cursor_meta_size.into()),
                        ("metas", metas.clone().into()),
                    ]),
                });
                if !has_cursor_meta {
                    let _ = emitter.emit(&Event::Warning {
                        code: "no-cursor-metadata".to_owned(),
                        message: format!(
                            "The negotiated buffers carry no SPA_META_Cursor, so no cursor \
                             samples will be produced. Metadata present: [{metas}]. A cursor \
                             block is dropped when the compositor's fixed SPA_PARAM_META_size \
                             falls outside the range this helper accepts."
                        ),
                    });
                }
            }

            Ok(Message::Stream(StreamEvent::State { state, error })) => {
                // Every transition, not just the failures. Without this a run
                // that ends in "target not found" is ambiguous: there is no way
                // to tell a stream that never reached `streaming` from one that
                // streamed happily and then hit the error on teardown.
                let _ = emitter.emit(&Event::Debug {
                    code: "stream-state".to_owned(),
                    data: json_map([
                        ("state", state.clone().into()),
                        ("error", error.clone().into()),
                    ]),
                });
                // Once frames are flowing, presses land on recorded content; the
                // picker (and the "Share" click that dismissed it) is behind us.
                // Stamped so a press read before this instant is dropped by time,
                // and cleared on disconnect so clicks stop emitting against a stale
                // cursor after capture ends. Only set on the FIRST streaming edge so
                // a transient renegotiation `paused`→`streaming` does not re-arm it.
                if state == "streaming" {
                    if streaming_since.is_none() {
                        streaming_since = Some(timestamp_ms());
                    }
                } else if state == "unconnected" {
                    streaming_since = None;
                }
                if let Some(error) = error {
                    let _ = emitter.emit(&Event::Warning {
                        code: "stream-error".to_owned(),
                        message: format!("PipeWire stream reported an error in state {state}: {error}"),
                    });
                }
                if state == "unconnected" && session.is_some() {
                    let _ = emitter.emit(&Event::Warning {
                        code: "stream-unconnected".to_owned(),
                        message: "The PipeWire stream disconnected; no further cursor samples \
                                  will arrive."
                            .to_owned(),
                    });
                }
            }

            Ok(Message::Stream(StreamEvent::Cursor(event))) => {
                // Open question #2: does SPA_META_Cursor actually carry a bitmap?
                if !reported_cursor_meta {
                    reported_cursor_meta = true;
                    let _ = emitter.emit(&Event::Debug {
                        code: "cursor-meta".to_owned(),
                        data: json_map([
                            ("hasBitmap", event.bitmap.is_some().into()),
                            ("cursorId", event.id.into()),
                            ("hotspotX", event.hotspot_x.into()),
                            ("hotspotY", event.hotspot_y.into()),
                        ]),
                    });
                }

                let mut asset_is_new = false;
                if let Some(raw) = &event.bitmap {
                    if emitter.debug_enabled() {
                        let _ = emitter.emit(&Event::Debug {
                            code: "cursor-bitmap".to_owned(),
                            data: json_map([
                                ("formatId", raw.format.into()),
                                ("width", raw.width.into()),
                                ("height", raw.height.into()),
                                ("stride", raw.stride.into()),
                                ("bytes", raw.pixels.len().into()),
                            ]),
                        });
                    }
                    match bitmap::encode(&constants, raw) {
                        Ok(encoded) => {
                            if known_assets.insert(encoded.id.clone()) {
                                asset_is_new = true;
                                pending_asset = Some(CursorAsset {
                                    id: encoded.id.clone(),
                                    image_data_url: encoded.image_data_url,
                                    width: encoded.width,
                                    height: encoded.height,
                                    hotspot_x: event.hotspot_x,
                                    hotspot_y: event.hotspot_y,
                                });
                            }
                            cursor = Some(CursorState {
                                x: event.x,
                                y: event.y,
                                asset_id: Some(encoded.id),
                            });
                        }
                        Err(message) => {
                            let _ = emitter.emit(&Event::Warning {
                                code: "cursor-bitmap-unusable".to_owned(),
                                message,
                            });
                            cursor = Some(CursorState {
                                x: event.x,
                                y: event.y,
                                asset_id: cursor.and_then(|state| state.asset_id),
                            });
                        }
                    }
                } else {
                    cursor = Some(CursorState {
                        x: event.x,
                        y: event.y,
                        asset_id: cursor.and_then(|state| state.asset_id),
                    });
                }

                // A new sprite ships immediately; positions respect the sample
                // interval so a 120fps compositor cannot flood stdout.
                if asset_is_new || last_emit.elapsed() >= config.sample_interval {
                    emit_sample(emitter, &cursor, size, &mut pending_asset, None);
                    last_emit = Instant::now();
                }
            }

            Err(RecvTimeoutError::Timeout) => {
                if cursor.is_some() && last_emit.elapsed() >= config.sample_interval {
                    emit_sample(emitter, &cursor, size, &mut pending_asset, None);
                    last_emit = Instant::now();
                }
                // The heartbeat that keeps the output at a constant frame rate
                // while the screen is static: no frame arrived, but the clock
                // moved, so the last picture is held forward.
                if let Some(capture) = capture.as_mut() {
                    if let Err(message) = capture.advance() {
                        let _ = emitter.emit(&Event::Error {
                            code: "encode-failed".to_owned(),
                            message,
                        });
                        exit_code = 1;
                        break;
                    }
                }
            }

            Err(RecvTimeoutError::Disconnected) => break,
        }
    }

    // Before the file is closed: this joins the PipeWire thread, so no callback
    // can fire against a freed Sender or write into a mailbox that is about to
    // be dropped.
    drop(session);

    if let Some(capture) = capture {
        finish_capture(emitter, capture, frames.as_deref(), &mut exit_code);
    }
    exit_code
}

/// Writes the trailer and reports what the recording cost.
///
/// Runs even when the loop broke on an error: a file whose moov atom was never
/// written is unplayable, and a partial recording is worth more to the user than
/// none.
fn finish_capture<W: Write>(
    emitter: &mut Emitter<W>,
    capture: Capture,
    frames: Option<&FrameMailbox>,
    exit_code: &mut i32,
) {
    for (label, samples) in capture.dropped_audio() {
        let _ = emitter.emit(&Event::Warning {
            code: "audio-dropped".to_owned(),
            message: format!(
                "{samples} {label} sample(s) were discarded because the encoder could not \
                 keep up, and stand in the recording as that much silence. Unlike a dropped \
                 video frame, this is audible."
            ),
        });
    }

    match capture.finish() {
        Ok(summary) => {
            let dropped = frames.map(FrameMailbox::dropped).unwrap_or(0);
            if dropped > 0 {
                let _ = emitter.emit(&Event::Warning {
                    code: "frames-dropped".to_owned(),
                    message: format!(
                        "{dropped} captured frame(s) were replaced before the encoder could \
                         take them, so the recording holds an older picture across those \
                         moments. The machine could not keep up with the capture rate."
                    ),
                });
            }
            let _ = emitter.emit(&Event::CaptureStopped {
                timestamp_ms: timestamp_ms(),
                path: summary.path.display().to_string(),
                duration_ms: summary.duration_ms,
                frames: summary.frames,
                dropped,
                convert_ms: summary.stats.convert_ms(),
                upload_ms: summary.stats.upload_ms(),
                encode_ms: summary.stats.encode_ms(),
            });
        }
        Err(message) => {
            let _ = emitter.emit(&Event::Error {
                code: "capture-finish-failed".to_owned(),
                message,
            });
            *exit_code = 1;
        }
    }
}

/// Emits one cursor sample at the current position. `click` is `Some(press_ms)`
/// for a left-button press — the sample is then tagged `"click"` and stamped with
/// that press time — or `None` for an ordinary throttled position sample stamped
/// now. Either way a pending new sprite rides out on it.
fn emit_sample<W: Write>(
    emitter: &mut Emitter<W>,
    cursor: &Option<CursorState>,
    size: Option<(i32, i32)>,
    pending_asset: &mut Option<CursorAsset>,
    click: Option<u64>,
) {
    let (Some(state), Some((width, height))) = (cursor, size) else {
        return;
    };
    let visible = state.x >= 0 && state.y >= 0 && state.x < width && state.y < height;
    // A click carries its own press time so the bounce lands when the button went
    // down, not up to a sample interval later; the position is the latest known,
    // which at the sample cadence has not moved enough to be wrong.
    let (timestamp, interaction_type) = match click {
        Some(press_ms) => (press_ms, Some("click".to_owned())),
        None => (timestamp_ms(), None),
    };
    let _ = emitter.emit(&Event::CursorSample {
        timestamp_ms: timestamp,
        x: state.x,
        y: state.y,
        width,
        height,
        visible,
        asset_id: state.asset_id.clone(),
        asset: pending_asset.take(),
        interaction_type,
    });
}

fn data_type_name(constants: &shim::Constants, data_type: u32) -> &'static str {
    if data_type == constants.data_mem_ptr {
        "MemPtr"
    } else if data_type == constants.data_mem_fd {
        "MemFd"
    } else if data_type == constants.data_dma_buf {
        "DmaBuf"
    } else {
        "unknown"
    }
}

fn json_map<const N: usize>(
    entries: [(&str, serde_json::Value); N],
) -> serde_json::Map<String, serde_json::Value> {
    entries
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value))
        .collect()
}


/// Resolves the microphone the user picked in the app to a PipeWire `node.name`.
///
/// WHY A MATCH AND NOT A LOOKUP. The picker lists Chromium `MediaDeviceInfo`,
/// whose `deviceId` is an opaque per-origin hash and whose `label` is a human
/// string. Neither is a PipeWire node name, and `PW_KEY_TARGET_OBJECT` takes
/// nothing else. On a PipeWire system Chromium's label IS the node's
/// `node.description`, so matching on that is the bridge between the two
/// namespaces — there is no id to look up.
///
/// Returning `None` is a real answer, not a failure: the caller then passes no
/// target and PipeWire links to the session default source. That is the old
/// behaviour, and it is the right fallback for a label we cannot place.
fn resolve_microphone_node(label: &str, sources: &[shim::AudioSourceInfo]) -> Option<String> {
    let wanted = label.trim();
    if wanted.is_empty() {
        return None;
    }
    // A caller that already knows the node name (a config file, a future
    // picker) should not be forced through fuzzy matching.
    if let Some(exact) = sources.iter().find(|s| s.name == wanted) {
        return Some(exact.name.clone());
    }
    let folded = wanted.to_lowercase();
    if let Some(exact) = sources.iter().find(|s| s.description.to_lowercase() == folded) {
        return Some(exact.name.clone());
    }
    // Chromium decorates labels ("Digital Microphone (Family 17h/19h ...)"),
    // and some descriptions are longer than the label, so containment is
    // checked BOTH ways. Longest description first, so that when several nodes
    // match a short label the most specific one wins rather than whichever the
    // registry happened to announce first.
    let mut candidates: Vec<&shim::AudioSourceInfo> = sources
        .iter()
        .filter(|s| {
            let d = s.description.to_lowercase();
            !d.is_empty() && (d.contains(&folded) || folded.contains(&d))
        })
        .collect();
    candidates.sort_by_key(|s| std::cmp::Reverse(s.description.len()));
    candidates.first().map(|s| s.name.clone())
}

#[cfg(test)]
mod microphone_resolution_tests {
    use super::*;

    fn sources() -> Vec<shim::AudioSourceInfo> {
        // The real graph of the machine this was debugged on.
        vec![
            shim::AudioSourceInfo {
                name: "alsa_input.pci-0000_03_00.6.HiFi__hw_Generic_1__source".into(),
                description: "Family 17h/19h HD Audio Controller Headphones Stereo Microphone"
                    .into(),
            },
            shim::AudioSourceInfo {
                name: "alsa_input.pci-0000_03_00.6.HiFi__hw_acp6x__source".into(),
                description: "Family 17h/19h HD Audio Controller Digital Microphone".into(),
            },
        ]
    }

    #[test]
    fn matches_the_description_chromium_reports_as_the_label() {
        // THE bug this exists for: the user picked the built-in microphone and
        // the recording captured the empty headphone jack, because no target was
        // passed and PipeWire fell back to the default source.
        let node = resolve_microphone_node(
            "Family 17h/19h HD Audio Controller Digital Microphone",
            &sources(),
        );
        assert_eq!(node.as_deref(), Some("alsa_input.pci-0000_03_00.6.HiFi__hw_acp6x__source"));
    }

    #[test]
    fn matches_a_decorated_or_shortened_label() {
        // Chromium is not obliged to hand back the description verbatim.
        assert_eq!(
            resolve_microphone_node("Digital Microphone", &sources()).as_deref(),
            Some("alsa_input.pci-0000_03_00.6.HiFi__hw_acp6x__source")
        );
    }

    #[test]
    fn a_node_name_passes_straight_through() {
        let name = "alsa_input.pci-0000_03_00.6.HiFi__hw_Generic_1__source";
        assert_eq!(resolve_microphone_node(name, &sources()).as_deref(), Some(name));
    }

    #[test]
    fn an_unknown_label_falls_back_to_the_default_source() {
        // `None` means "pass no target", which is the pre-fix behaviour. Better
        // a default microphone than no audio at all.
        assert_eq!(resolve_microphone_node("Blue Yeti", &sources()), None);
        assert_eq!(resolve_microphone_node("   ", &sources()), None);
    }

    #[test]
    fn prefers_the_most_specific_description_when_several_contain_the_label() {
        // "Microphone" is a substring of both. Picking the first announced would
        // make the result depend on registry ordering, which is not stable.
        let node = resolve_microphone_node("Microphone", &sources());
        assert_eq!(
            node.as_deref(),
            Some("alsa_input.pci-0000_03_00.6.HiFi__hw_Generic_1__source"),
            "the longer description should win, deterministically"
        );
    }
}
