//! NDJSON protocol spoken on stdout: one JSON object per line, flushed per
//! line, every object carrying `event` and `schemaVersion`.
//!
//! The vocabulary is the ScreenCaptureKit helper's (`ready` / `warning` /
//! `error`, see electron/native/screencapturekit/…/main.swift) plus what this
//! helper needs on top:
//!
//!   * `stream-started` — the portal dialog is done and PipeWire is streaming.
//!     It is separate from `ready` on purpose. `ready` fires in milliseconds,
//!     before the portal picker is raised; `stream-started` cannot fire until
//!     the user has clicked through a dialog, which has no upper bound. The
//!     Electron session resolves `start()` on `ready` so its readiness timeout
//!     does not have to accommodate a human.
//!   * `cursor-sample` — one cursor observation.
//!   * `encoder-selection` / `capture-started` / `capture-stopped` — Stage 2's
//!     video half. `capture-started` is the Linux spelling of the "Recording
//!     started" line the Windows helper prints, and the parent waits on it
//!     before telling the UI that recording has begun.
//!   * `debug` — the Stage 1 instrumentation, gated on OPENSCREEN_PIPEWIRE_DEBUG.

use std::io::{self, Write};

use serde::Serialize;

pub const SCHEMA_VERSION: u32 = 1;

/// The cursor sprite, sent once per distinct shape. Field names match
/// `NativeCursorAsset` in src/native/contracts.ts, minus `platform`, which the
/// Electron side fills in.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CursorAsset {
    pub id: String,
    pub image_data_url: String,
    pub width: u32,
    pub height: u32,
    pub hotspot_x: i32,
    pub hotspot_y: i32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "event", rename_all = "kebab-case")]
pub enum Event {
    #[serde(rename_all = "camelCase")]
    Ready {
        timestamp_ms: u64,
        /// Runtime libpipewire version, not the vendored header version.
        pipewire_version: Option<String>,
        /// Whether the portal advertises METADATA cursor mode at all.
        cursor_metadata_supported: bool,
    },
    /// The user has answered the compositor's picker and a source was granted.
    ///
    /// A DIFFERENT MOMENT from [`Self::StreamStarted`], and the distinction is
    /// the point: this fires when the choice is made, before any pixel has moved.
    /// It is what lets a caller run a countdown after the user has been asked
    /// what to share rather than before — the picker's wait has no upper bound,
    /// so a countdown started ahead of it just freezes on screen.
    #[serde(rename_all = "camelCase")]
    SourceSelected {
        timestamp_ms: u64,
        node_id: u32,
        /// `"monitor"`, `"window"` or `"virtual"`, when the portal says.
        source_kind: Option<String>,
        position_x: Option<i32>,
        position_y: Option<i32>,
    },
    #[serde(rename_all = "camelCase")]
    StreamStarted {
        timestamp_ms: u64,
        node_id: u32,
        width: i32,
        height: i32,
        /// Position of the captured region in the compositor's coordinate
        /// space, when the portal reports one (monitor streams only).
        position_x: Option<i32>,
        position_y: Option<i32>,
        /// `"monitor"`, `"window"` or `"virtual"` — what the compositor
        /// actually handed over, straight from the portal's reply. Absent when
        /// the backend omits it. This is the only honest answer to "what am I
        /// recording?": the app cannot name a source when asking, so it can
        /// only be told after the fact.
        source_kind: Option<String>,
    },
    /// Cursor position in stream pixels. `width`/`height` repeat on every
    /// sample so a consumer never has to correlate with an earlier event to
    /// normalise, and so a mid-stream resolution change cannot desynchronise it.
    #[serde(rename_all = "camelCase")]
    CursorSample {
        timestamp_ms: u64,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        visible: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        asset_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        asset: Option<CursorAsset>,
        /// `"click"` on the sample that coincides with a left-button press read
        /// from evdev (see `input.rs`), absent otherwise. Omitted rather than
        /// defaulted to `"move"` so the accumulator keeps that fallback in one
        /// place and the wire stays quiet on the common case.
        #[serde(skip_serializing_if = "Option::is_none")]
        interaction_type: Option<String>,
    },
    /// Which capture node each audio source was linked to.
    ///
    /// NOT a debug event, deliberately. This started life as one and was
    /// therefore suppressed unless OPENSCREEN_PIPEWIRE_DEBUG was set — so when
    /// a user reported "that is not my microphone", the one line that would
    /// have answered it was missing from their log. The resolved node is the
    /// first thing anyone needs when audio comes from the wrong device.
    #[serde(rename_all = "camelCase")]
    AudioSource {
        /// "system" or "microphone".
        role: String,
        /// What the app asked for: a device label from the picker, or absent
        /// when it did not name one.
        requested: Option<String>,
        /// The PipeWire `node.name` the stream was pointed at. `None` means no
        /// target was set, so PipeWire linked to the session default — which is
        /// often NOT the device the user selected.
        node: Option<String>,
    },
    /// Which rung of the encoder ladder won, and why the ones above it did not.
    /// Emitted before `capture-started` so a helper that then fails to start
    /// still leaves the selection in the log.
    #[serde(rename_all = "camelCase")]
    EncoderSelection {
        /// "vaapi" | "vulkan" | "software".
        video: String,
        /// One line per backend that was tried and refused, in ladder order.
        rejected: Vec<String>,
    },
    /// The output file is open and the first frame has been encoded. The parent
    /// treats this the way it treats Windows's "Recording started".
    #[serde(rename_all = "camelCase")]
    CaptureStarted {
        timestamp_ms: u64,
        path: String,
        width: i32,
        height: i32,
        fps: i32,
    },
    /// The trailer is written and the file is closed and playable.
    #[serde(rename_all = "camelCase")]
    CaptureStopped {
        timestamp_ms: u64,
        path: String,
        duration_ms: u64,
        /// Frames written to the file, including any duplicated to hold the
        /// constant frame rate.
        frames: u64,
        /// Frames the compositor delivered that the encoder never saw, because a
        /// newer one replaced them in the mailbox first. A non-zero value here
        /// means the machine could not keep up.
        dropped: u64,
        /// Mean milliseconds per frame in each stage, so a slow recording is
        /// diagnosable from the log alone.
        convert_ms: f64,
        upload_ms: f64,
        encode_ms: f64,
    },
    #[serde(rename_all = "camelCase")]
    Warning { code: String, message: String },
    #[serde(rename_all = "camelCase")]
    Error { code: String, message: String },
    /// Stage 1 instrumentation. `data` is free-form on purpose: these are
    /// answers to open questions, not a contract anything parses.
    #[serde(rename_all = "camelCase")]
    Debug {
        code: String,
        #[serde(flatten)]
        data: serde_json::Map<String, serde_json::Value>,
    },
}

/// Writes events as NDJSON. Generic over the sink so the framing can be tested
/// without a process.
pub struct Emitter<W: Write> {
    out: W,
    debug: bool,
}

impl<W: Write> Emitter<W> {
    pub fn new(out: W, debug: bool) -> Self {
        Self { out, debug }
    }

    /// `debug` events are dropped unless OPENSCREEN_PIPEWIRE_DEBUG was set.
    pub fn emit(&mut self, event: &Event) -> io::Result<()> {
        if matches!(event, Event::Debug { .. }) && !self.debug {
            return Ok(());
        }

        // Round-tripping through Value is what lets `schemaVersion` be added in
        // one place instead of being restated in every variant.
        let mut value = serde_json::to_value(event).expect("event serialisation is infallible");
        if let Some(object) = value.as_object_mut() {
            object.insert("schemaVersion".to_owned(), SCHEMA_VERSION.into());
            // Every line carries a wall clock, including `debug` and `warning`.
            // Without it a log can show a warning after a buffer report and give
            // no way to tell whether they were a millisecond or a minute apart —
            // which is exactly the difference between "the stream died instantly"
            // and "the stream ran fine and this is teardown". `or_insert` so the
            // events that carry a meaningful timestamp of their own (a sample's
            // capture time) keep it.
            object
                .entry("timestampMs".to_owned())
                .or_insert_with(|| timestamp_ms().into());
        }

        writeln!(self.out, "{value}")?;
        // Per line, not per buffer: the parent process reads this incrementally
        // and a half-written line would be a parse error on the other side.
        self.out.flush()
    }

    pub fn debug_enabled(&self) -> bool {
        self.debug
    }
}

/// Millisecond wall clock, matching the `timestampMs` the macOS and Windows
/// helpers emit (the Electron sessions subtract their own start time from it).
pub fn timestamp_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn emit_one(event: &Event, debug: bool) -> String {
        let mut buffer = Vec::new();
        Emitter::new(&mut buffer, debug).emit(event).expect("emit");
        String::from_utf8(buffer).expect("utf8")
    }

    fn parse_one(event: &Event) -> serde_json::Value {
        serde_json::from_str(&emit_one(event, true)).expect("valid json")
    }

    #[test]
    fn every_event_is_one_line_terminated_by_a_newline() {
        let text = emit_one(
            &Event::Ready {
                timestamp_ms: 42,
                pipewire_version: Some("1.0.5".to_owned()),
                cursor_metadata_supported: true,
            },
            false,
        );
        assert!(text.ends_with('\n'));
        assert_eq!(text.matches('\n').count(), 1);
    }

    #[test]
    fn every_event_carries_a_schema_version() {
        let value = parse_one(&Event::Warning {
            code: "x".to_owned(),
            message: "y".to_owned(),
        });
        assert_eq!(value["schemaVersion"], 1);
    }

    #[test]
    fn ready_uses_the_shared_helper_vocabulary() {
        let value = parse_one(&Event::Ready {
            timestamp_ms: 7,
            pipewire_version: None,
            cursor_metadata_supported: false,
        });
        assert_eq!(value["event"], "ready");
        assert_eq!(value["timestampMs"], 7);
        assert!(value["pipewireVersion"].is_null());
        assert_eq!(value["cursorMetadataSupported"], false);
    }

    #[test]
    fn stream_started_is_kebab_case_with_camel_case_fields() {
        let value = parse_one(&Event::StreamStarted {
            timestamp_ms: 1,
            node_id: 55,
            width: 2560,
            height: 1440,
            position_x: Some(0),
            position_y: Some(-1080),
            source_kind: Some("window".to_owned()),
        });
        assert_eq!(value["event"], "stream-started");
        assert_eq!(value["nodeId"], 55);
        assert_eq!(value["positionY"], -1080);
        assert_eq!(value["sourceKind"], "window");
    }

    #[test]
    fn cursor_samples_omit_asset_fields_when_absent() {
        let value = parse_one(&Event::CursorSample {
            timestamp_ms: 12,
            x: 100,
            y: 200,
            width: 1920,
            height: 1080,
            visible: true,
            asset_id: None,
            asset: None,
            interaction_type: None,
        });
        assert_eq!(value["event"], "cursor-sample");
        assert_eq!(value["x"], 100);
        assert_eq!(value["visible"], true);
        assert!(value.get("assetId").is_none());
        assert!(value.get("asset").is_none());
        // A plain move stays silent about its interaction so the accumulator's
        // "move" default is the single source of that word.
        assert!(value.get("interactionType").is_none());
    }

    #[test]
    fn cursor_samples_report_a_click_when_tagged() {
        let value = parse_one(&Event::CursorSample {
            timestamp_ms: 12,
            x: 100,
            y: 200,
            width: 1920,
            height: 1080,
            visible: true,
            asset_id: None,
            asset: None,
            interaction_type: Some("click".to_owned()),
        });
        assert_eq!(value["interactionType"], "click");
    }

    #[test]
    fn cursor_assets_match_the_native_cursor_asset_contract() {
        let value = parse_one(&Event::CursorSample {
            timestamp_ms: 12,
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            visible: true,
            asset_id: Some("abc".to_owned()),
            asset: Some(CursorAsset {
                id: "abc".to_owned(),
                image_data_url: "data:image/png;base64,AA==".to_owned(),
                width: 24,
                height: 24,
                hotspot_x: 4,
                hotspot_y: 3,
            }),
            interaction_type: None,
        });
        assert_eq!(value["assetId"], "abc");
        assert_eq!(value["asset"]["imageDataUrl"], "data:image/png;base64,AA==");
        assert_eq!(value["asset"]["hotspotX"], 4);
        assert_eq!(value["asset"]["hotspotY"], 3);
    }

    #[test]
    fn events_without_their_own_clock_get_one() {
        let value = parse_one(&Event::Warning {
            code: "no-cursor-metadata".to_owned(),
            message: "x".to_owned(),
        });
        assert!(
            value["timestampMs"].as_u64().unwrap_or(0) > 0,
            "warnings must be timestamped so stream lifetime is readable from a log"
        );
    }

    #[test]
    fn events_carrying_a_meaningful_timestamp_keep_it() {
        let value = parse_one(&Event::CursorSample {
            timestamp_ms: 1234,
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            visible: true,
            asset_id: None,
            asset: None,
            interaction_type: None,
        });
        assert_eq!(value["timestampMs"], 1234, "a sample's capture time must not be overwritten");
    }

    #[test]
    fn debug_events_are_suppressed_unless_enabled() {
        let event = Event::Debug {
            code: "buffer-info".to_owned(),
            data: serde_json::Map::new(),
        };
        assert_eq!(emit_one(&event, false), "");
        assert!(!emit_one(&event, true).is_empty());
    }

    #[test]
    fn debug_payloads_are_flattened_next_to_the_code() {
        let mut data = serde_json::Map::new();
        data.insert("dataType".to_owned(), "MemFd".into());
        let value = parse_one(&Event::Debug {
            code: "buffer-info".to_owned(),
            data,
        });
        assert_eq!(value["event"], "debug");
        assert_eq!(value["code"], "buffer-info");
        assert_eq!(value["dataType"], "MemFd");
    }
}
