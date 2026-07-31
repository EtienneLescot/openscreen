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
//! WHAT IT CANNOT DO. Mouse buttons. Wayland exposes no portal for input
//! events, and /dev/input/event* is root:input. Every sample is therefore a
//! "move"; there is no click detection to be had here at any effort level.

mod bitmap;
mod capture;
mod encoder;
mod events;
mod ffmpeg;
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
const DEFAULT_BITRATE: i64 = 8_000_000;

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
/// How much audio may queue before the oldest is discarded. Generous: the drain
/// runs every loop tick, so reaching this means the encoder stopped entirely.
const AUDIO_RING_SECONDS: usize = 2;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Request {
    sample_interval_ms: Option<u64>,
    /// Token from a previous run's `stream-started`. Lets the portal skip the
    /// picker for a source the user already approved.
    restore_token: Option<String>,
    /// Where to write the MP4. Absent means cursor-only: no pixels are mapped,
    /// no encoder is opened, and the helper behaves exactly as Stage 1 did.
    output_path: Option<String>,
    /// `"metadata"` (default) keeps the pointer out of the pixels so the editor
    /// can draw its own; `"embedded"` asks the compositor to paint it in. These
    /// are the two halves of the HUD's cursor-mode toggle.
    cursor_mode: Option<String>,
    video: Option<VideoRequest>,
    audio: Option<AudioRequest>,
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

    fn bitrate(&self) -> i64 {
        self.video
            .as_ref()
            .and_then(|video| video.bitrate)
            .filter(|bitrate| *bitrate > 0)
            .unwrap_or(DEFAULT_BITRATE)
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
    spawn_portal(sender.clone(), request.restore_token.clone(), cursor_mode);

    let session = RunConfig {
        tick,
        sample_interval,
        output_path,
        fps: request.fps(),
        bitrate: request.bitrate(),
        forced_encoder,
        cursor_mode,
        audio: request.audio_sources(),
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
    bitrate: i64,
    forced_encoder: Option<encoder::Backend>,
    cursor_mode: portal::CursorMode,
    audio: Vec<AudioSourceConfig>,
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
    for config in configs {
        let ring = Arc::new(shim::AudioRing::new(
            AUDIO_RING_SECONDS,
            encoder::AUDIO_SAMPLE_RATE as usize,
            encoder::AUDIO_CHANNELS,
        ));
        let label = config.label;
        let session = shim::AudioSession::start(
            config.target.as_deref(),
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
fn spawn_portal(
    sender: Sender<Message>,
    restore_token: Option<String>,
    cursor_mode: portal::CursorMode,
) {
    std::thread::spawn(move || {
        let result = pollster::block_on(portal::negotiate(restore_token.as_deref(), cursor_mode));
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

/// What survives from the portal reply after its fd has been handed to
/// libpipewire — everything `stream-started` needs to report.
struct StreamInfo {
    node_id: u32,
    position: Option<(i32, i32)>,
    restore_token: Option<String>,
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
    let mut cursor: Option<CursorState> = None;
    let mut known_assets: HashSet<String> = HashSet::new();
    let mut pending_asset: Option<CursorAsset> = None;
    let mut reported_cursor_meta = false;
    // Allocated up front so the PipeWire callback has somewhere to put frames
    // from the very first buffer; `None` in cursor-only mode, which is also what
    // tells `Session::start` not to map the buffers at all.
    let frames: Option<Arc<FrameMailbox>> = config
        .output_path
        .as_ref()
        .map(|_| Arc::new(FrameMailbox::default()));
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

    loop {
        match receiver.recv_timeout(config.tick) {
            Ok(Message::Stop) => break,

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
                let (Some(mailbox), Some(capture)) = (frames.as_ref(), capture.as_mut()) else {
                    continue;
                };
                // `take` can legitimately return None: several FrameReady
                // notifications can arrive for frames that superseded each other
                // in the mailbox before the loop got here.
                if let Some(frame) = mailbox.take() {
                    let first = !capture.started();
                    if let Err(message) = capture.stage(&frame) {
                        let _ = emitter.emit(&Event::Error {
                            code: "encode-failed".to_owned(),
                            message,
                        });
                        exit_code = 1;
                        break;
                    }
                    if first {
                        let _ = emitter.emit(&Event::CaptureStarted {
                            timestamp_ms: timestamp_ms(),
                            path: config
                                .output_path
                                .as_ref()
                                .map(|path| path.display().to_string())
                                .unwrap_or_default(),
                            width: frame.width,
                            height: frame.height,
                            fps: config.fps,
                        });
                    }
                    mailbox.recycle(frame.pixels);
                }
                if let Err(message) = capture.advance() {
                    let _ = emitter.emit(&Event::Error {
                        code: "encode-failed".to_owned(),
                        message,
                    });
                    exit_code = 1;
                    break;
                }
            }

            Ok(Message::Portal(result)) => match *result {
                Ok(stream) => {
                    // The fd is consumed by libpipewire; the rest is kept for the
                    // `stream-started` event, emitted once the format is negotiated.
                    let portal::PortalStream {
                        fd,
                        node_id,
                        position,
                        size: logical_size,
                        restore_token,
                    } = stream;
                    // The portal's size is in the compositor's coordinate space
                    // and can differ from the negotiated pixel size on a scaled
                    // display. Logged rather than used: cursor positions arrive
                    // in stream pixels, so only the negotiated size normalises them.
                    let _ = emitter.emit(&Event::Debug {
                        code: "portal-stream".to_owned(),
                        data: json_map([
                            ("nodeId", node_id.into()),
                            ("logicalWidth", logical_size.map(|(w, _)| w).into()),
                            ("logicalHeight", logical_size.map(|(_, h)| h).into()),
                            ("positionX", position.map(|(x, _)| x).into()),
                            ("positionY", position.map(|(_, y)| y).into()),
                        ]),
                    });
                    let forward = sender.clone();
                    match shim::Session::start(
                        fd,
                        node_id,
                        Box::new(move |event| {
                            let _ = forward.send(Message::Stream(event));
                        }),
                        frames.clone(),
                    ) {
                        Ok(started) => {
                            session = Some(started);
                            portal_stream = Some(StreamInfo {
                                node_id,
                                position,
                                restore_token,
                            });
                        }
                        Err(message) => {
                            let _ = emitter.emit(&Event::Error {
                                code: "pipewire-connect-failed".to_owned(),
                                message,
                            });
                            exit_code = 1;
                            break;
                        }
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
                        restore_token: stream.restore_token,
                    });
                }

                // The encoder cannot be opened until now: its dimensions are the
                // negotiated ones, which the compositor picks. Renegotiation
                // mid-stream would deliver a second Format; the encoder is left
                // alone in that case, because an MP4 cannot change resolution
                // mid-file and the alternative — silently starting a new one —
                // would lose the recording.
                if let Some(path) = config.output_path.as_ref() {
                    if capture.is_none() {
                        match Capture::start(
                            path,
                            format.width,
                            format.height,
                            config.fps,
                            config.bitrate,
                            config.forced_encoder,
                            std::mem::take(&mut audio_sources),
                        ) {
                            Ok((started, selection)) => {
                                let _ = emitter.emit(&Event::EncoderSelection {
                                    video: selection.backend.as_str().to_owned(),
                                    rejected: selection.rejected,
                                });
                                capture = Some(started);
                                if paused {
                                    // A `pause` that arrived while the portal
                                    // picker was still up applies to the capture
                                    // that picker was for.
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
                    } else {
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
                    emit_sample(emitter, &cursor, size, &mut pending_asset);
                    last_emit = Instant::now();
                }
            }

            Err(RecvTimeoutError::Timeout) => {
                if cursor.is_some() && last_emit.elapsed() >= config.sample_interval {
                    emit_sample(emitter, &cursor, size, &mut pending_asset);
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
                 keep up. Unlike a dropped video frame, this is audible."
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

fn emit_sample<W: Write>(
    emitter: &mut Emitter<W>,
    cursor: &Option<CursorState>,
    size: Option<(i32, i32)>,
    pending_asset: &mut Option<CursorAsset>,
) {
    let (Some(state), Some((width, height))) = (cursor, size) else {
        return;
    };
    let visible = state.x >= 0 && state.y >= 0 && state.x < width && state.y < height;
    let _ = emitter.emit(&Event::CursorSample {
        timestamp_ms: timestamp_ms(),
        x: state.x,
        y: state.y,
        width,
        height,
        visible,
        asset_id: state.asset_id.clone(),
        asset: pending_asset.take(),
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

