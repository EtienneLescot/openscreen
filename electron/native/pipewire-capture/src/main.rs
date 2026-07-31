//! OpenScreen Linux capture helper — Stage 1: cursor samples only.
//!
//! WHY THIS EXISTS. `screen.getCursorScreenPoint()` returns {0,0} under Wayland,
//! so `TelemetryRecordingSession` produced recordings whose every cursor sample
//! sat in the screen's top-left corner while looking perfectly well-formed. The
//! only source of truth for the pointer on Wayland is the ScreenCast portal's
//! METADATA cursor mode, where the compositor keeps the cursor out of the pixels
//! and attaches a SPA_META_Cursor to each frame instead.
//!
//! SHAPE. A stdio sidecar, like the macOS and Windows helpers: JSON request in
//! argv[1], NDJSON events on stdout, `stop` (or EOF) on stdin. It captures no
//! video and writes no file — that is Stage 2's job, and it will reuse this same
//! portal session because SelectSources may only be called once per session.
//!
//! WHAT IT CANNOT DO. Mouse buttons. Wayland exposes no portal for input
//! events, and /dev/input/event* is root:input. Every sample is therefore a
//! "move"; there is no click detection to be had here at any effort level.

mod bitmap;
mod events;
mod portal;
mod shim;

use std::collections::HashSet;
use std::io::{BufRead, Write};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

use serde::Deserialize;

use events::{timestamp_ms, CursorAsset, Emitter, Event};
use shim::StreamEvent;

/// Matches the macOS helper's default and the Electron side's sampleIntervalMs.
const DEFAULT_SAMPLE_INTERVAL_MS: u64 = 33;
const MIN_SAMPLE_INTERVAL_MS: u64 = 8;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Request {
    sample_interval_ms: Option<u64>,
    /// Token from a previous run's `stream-started`. Lets the portal skip the
    /// picker for a source the user already approved.
    restore_token: Option<String>,
    /// Emit `ready` and exit, without ever calling the portal's `Start()`.
    ///
    /// Everything up to that point is non-interactive; `Start()` is the single
    /// call that raises the compositor's source picker. This flag is what makes
    /// the dlopen path, the portal connection and the cursor-mode check testable
    /// — in CI or by hand — without hijacking someone's screen.
    probe_only: bool,
}

enum Message {
    Portal(Box<Result<portal::PortalStream, portal::PortalError>>),
    Stream(StreamEvent),
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
    let interval = Duration::from_millis(
        request
            .sample_interval_ms
            .unwrap_or(DEFAULT_SAMPLE_INTERVAL_MS)
            .max(MIN_SAMPLE_INTERVAL_MS),
    );

    if let Err(message) = shim::load() {
        fail(&mut emitter, "pipewire-unavailable", &message);
    }

    // Probed before `ready` so the event can report it, and so an unsupported
    // compositor fails immediately instead of after a pointless picker.
    match pollster::block_on(portal::cursor_metadata_supported()) {
        Ok(true) => {}
        Ok(false) => {
            let error = portal::PortalError::CursorMetadataUnsupported;
            fail(&mut emitter, error.code(), &error.message());
        }
        Err(error) => fail(&mut emitter, error.code(), &error.message()),
    }

    let _ = emitter.emit(&Event::Ready {
        timestamp_ms: timestamp_ms(),
        pipewire_version: shim::library_version(),
        cursor_metadata_supported: true,
    });

    if request.probe_only {
        std::process::exit(0);
    }

    let (sender, receiver) = mpsc::channel::<Message>();
    spawn_stdin_reader(sender.clone());
    spawn_portal(sender.clone(), request.restore_token.clone());

    let exit_code = run(&mut emitter, receiver, sender, interval);
    std::process::exit(exit_code);
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
fn spawn_stdin_reader(sender: Sender<Message>) {
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            match line {
                Ok(line) if line.trim() == "stop" => break,
                Ok(_) => continue,
                Err(_) => break,
            }
        }
        let _ = sender.send(Message::Stop);
    });
}

/// The portal runs on its own thread because `Start()` blocks on the user for
/// an unbounded time, and a `stop` arriving during the picker must still be
/// honoured.
fn spawn_portal(sender: Sender<Message>, restore_token: Option<String>) {
    std::thread::spawn(move || {
        let result = pollster::block_on(portal::negotiate(restore_token.as_deref()));
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
    interval: Duration,
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
    // Backdated so the very first sample is not held back by the throttle.
    // `checked_sub` because a bare `Instant - Duration` panics on underflow, and
    // this runs milliseconds after process start.
    let mut last_emit = Instant::now().checked_sub(interval).unwrap_or_else(Instant::now);
    let mut exit_code = 0;

    loop {
        match receiver.recv_timeout(interval) {
            Ok(Message::Stop) => break,

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
                if asset_is_new || last_emit.elapsed() >= interval {
                    emit_sample(emitter, &cursor, size, &mut pending_asset);
                    last_emit = Instant::now();
                }
            }

            Err(RecvTimeoutError::Timeout) => {
                if cursor.is_some() {
                    emit_sample(emitter, &cursor, size, &mut pending_asset);
                    last_emit = Instant::now();
                }
            }

            Err(RecvTimeoutError::Disconnected) => break,
        }
    }

    // Explicit: this joins the PipeWire thread before the process exits, so no
    // callback can fire against a freed Sender.
    drop(session);
    exit_code
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

