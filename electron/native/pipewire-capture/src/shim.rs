//! Rust half of the C ABI declared in `csrc/pw_shim.h`.
//!
//! Every struct below mirrors its C counterpart field for field. They are a
//! matched pair; the compiler cannot check that for you, so if you touch one,
//! touch the other.
//!
//! Nothing here interprets PipeWire semantics — the shim already validated the
//! metadata offsets. This module's only jobs are (1) owning the raw handle
//! safely and (2) turning callback pointers into channel messages without ever
//! letting a Rust panic unwind into C.

use std::ffi::{c_char, c_void, CStr};
use std::os::fd::{IntoRawFd, OwnedFd};
use std::panic::{catch_unwind, AssertUnwindSafe};

#[repr(C)]
#[derive(Debug)]
pub struct RawCursor {
    pub x: i32,
    pub y: i32,
    pub hotspot_x: i32,
    pub hotspot_y: i32,
    pub id: u32,
    pub flags: u32,
    pub has_bitmap: i32,
    pub bitmap_format: u32,
    pub bitmap_width: i32,
    pub bitmap_height: i32,
    pub bitmap_stride: i32,
    pub bitmap_data: *const u8,
    pub bitmap_len: usize,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct RawFormat {
    pub width: i32,
    pub height: i32,
    pub video_format: u32,
    pub framerate_num: i32,
    pub framerate_denom: i32,
}

#[repr(C)]
struct RawCallbacks {
    user: *mut c_void,
    on_format: extern "C" fn(*mut c_void, *const RawFormat),
    on_cursor: extern "C" fn(*mut c_void, *const RawCursor),
    on_buffer_info: extern "C" fn(*mut c_void, u32, u32, i32, u32, *const c_char),
    on_state: extern "C" fn(*mut c_void, *const c_char, *const c_char),
}

#[repr(C)]
#[derive(Debug, Default, Clone, Copy)]
pub struct Constants {
    pub video_format_rgbx: u32,
    pub video_format_bgrx: u32,
    pub video_format_xrgb: u32,
    pub video_format_xbgr: u32,
    pub video_format_rgba: u32,
    pub video_format_bgra: u32,
    pub video_format_argb: u32,
    pub video_format_abgr: u32,
    pub data_mem_ptr: u32,
    pub data_mem_fd: u32,
    pub data_dma_buf: u32,
}

#[repr(C)]
struct RawSession {
    _private: [u8; 0],
}

extern "C" {
    fn osc_pw_load(err: *mut c_char, err_len: usize) -> i32;
    fn osc_pw_library_version() -> *const c_char;
    fn osc_pw_constants(out: *mut Constants);
    /// Test-only: the shipped binary never negotiates against a synthetic
    /// producer, but the unit tests do. The C side is always compiled.
    #[cfg(test)]
    fn osc_pw_cursor_meta_accepts_producer_size(width: u32, height: u32) -> i32;
    fn osc_pw_start(
        fd: i32,
        node_id: u32,
        callbacks: *const RawCallbacks,
        err: *mut c_char,
        err_len: usize,
    ) -> *mut RawSession;
    fn osc_pw_stop(session: *mut RawSession);
}

/// Where stream events go. Called on the PipeWire thread, so it must not block:
/// the helper only forwards onto an unbounded channel.
pub type Sink = Box<dyn Fn(StreamEvent) + Send>;

/// What the PipeWire thread reports back. Owned data only: the bitmap pointer
/// handed to the callback dies when the callback returns, so it is copied.
#[derive(Debug)]
pub enum StreamEvent {
    Format(RawFormat),
    BufferInfo {
        data_type: u32,
        n_datas: u32,
        has_cursor_meta: bool,
        cursor_meta_size: u32,
        /// "Header:12,Cursor:589872" — every metadata block that survived
        /// negotiation. Empty when the buffers carry none at all.
        metas: String,
    },
    Cursor(CursorEvent),
    State {
        state: String,
        error: Option<String>,
    },
}

#[derive(Debug)]
pub struct CursorEvent {
    pub x: i32,
    pub y: i32,
    pub hotspot_x: i32,
    pub hotspot_y: i32,
    pub id: u32,
    pub bitmap: Option<CursorBitmap>,
}

#[derive(Debug)]
pub struct CursorBitmap {
    pub format: u32,
    pub width: i32,
    pub height: i32,
    pub stride: i32,
    pub pixels: Vec<u8>,
}

const ERR_LEN: usize = 256;

fn take_error(buffer: &[c_char; ERR_LEN]) -> String {
    // SAFETY: the shim always NUL-terminates within ERR_LEN, and the buffer is
    // zero-initialised, so a missing write still yields an empty C string.
    let text = unsafe { CStr::from_ptr(buffer.as_ptr()) };
    text.to_string_lossy().into_owned()
}

/// dlopen libpipewire and resolve its symbols. Idempotent.
pub fn load() -> Result<(), String> {
    let mut err = [0 as c_char; ERR_LEN];
    // SAFETY: `err` is a live, correctly sized buffer for the duration of the call.
    let result = unsafe { osc_pw_load(err.as_mut_ptr(), ERR_LEN) };
    if result != 0 {
        return Err(take_error(&err));
    }
    Ok(())
}

/// Runtime libpipewire version, or `None` before a successful [`load`].
pub fn library_version() -> Option<String> {
    // SAFETY: returns a static string owned by libpipewire, or NULL.
    let raw = unsafe { osc_pw_library_version() };
    if raw.is_null() {
        return None;
    }
    // SAFETY: non-NULL implies a NUL-terminated string from pw_get_library_version.
    Some(unsafe { CStr::from_ptr(raw) }.to_string_lossy().into_owned())
}

/// Would our SPA_META_Cursor declaration survive negotiation against a producer
/// declaring a fixed `width` x `height` cursor plane?
#[cfg(test)]
pub fn cursor_meta_accepts_producer_size(width: u32, height: u32) -> i32 {
    // SAFETY: no arguments to validate; the shim builds and frees its own PODs.
    unsafe { osc_pw_cursor_meta_accepts_producer_size(width, height) }
}

/// SPA enum values as compiled from the vendored headers.
pub fn constants() -> Constants {
    let mut out = Constants::default();
    // SAFETY: `out` is a live, correctly typed destination.
    unsafe { osc_pw_constants(&mut out) };
    out
}

/// A running PipeWire stream. Dropping it stops and joins the PipeWire thread.
pub struct Session {
    raw: *mut RawSession,
    // Kept alive for exactly as long as `raw`: the C side holds a pointer to it
    // and hands it back to every callback. Dropped after osc_pw_stop has joined
    // the loop thread, so no callback can be in flight at that point. The outer
    // Box exists to give the fat `dyn Fn` pointer a stable thin address.
    _sink: Box<Sink>,
}

impl Session {
    /// Consumes `fd` — libpipewire closes it, on the success and failure paths alike.
    pub fn start(fd: OwnedFd, node_id: u32, sink: Sink) -> Result<Self, String> {
        let boxed: Box<Sink> = Box::new(sink);
        let user = &*boxed as *const Sink as *mut c_void;
        let callbacks = RawCallbacks {
            user,
            on_format,
            on_cursor,
            on_buffer_info,
            on_state,
        };

        let mut err = [0 as c_char; ERR_LEN];
        // SAFETY: `callbacks` and `err` outlive the call; `boxed` outlives the
        // returned session, which is what keeps `user` valid for the callbacks.
        let raw = unsafe {
            osc_pw_start(fd.into_raw_fd(), node_id, &callbacks, err.as_mut_ptr(), ERR_LEN)
        };
        if raw.is_null() {
            return Err(take_error(&err));
        }

        Ok(Self { raw, _sink: boxed })
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        // SAFETY: `raw` came from osc_pw_start and is stopped exactly once.
        unsafe { osc_pw_stop(self.raw) };
    }
}

/// Recovers the sink the C side is carrying and runs `body` with it.
///
/// `catch_unwind` is not defensive programming here: unwinding across an
/// `extern "C"` boundary is undefined behaviour, and these functions run on
/// PipeWire's thread where a panic would otherwise abort mid-callback.
fn with_sink<F>(user: *mut c_void, body: F)
where
    F: FnOnce(&Sink),
{
    if user.is_null() {
        return;
    }
    // SAFETY: `user` is the pointer we handed to osc_pw_start, pointing at a
    // sink owned by the live Session. Callbacks cannot outlive it: osc_pw_stop
    // joins the loop thread before the Session drops the box.
    let sink = unsafe { &*(user as *const Sink) };
    let _ = catch_unwind(AssertUnwindSafe(|| body(sink)));
}

extern "C" fn on_format(user: *mut c_void, format: *const RawFormat) {
    with_sink(user, |sink| {
        if format.is_null() {
            return;
        }
        // SAFETY: non-NULL for the duration of the callback, by contract.
        let format = unsafe { &*format };
        sink(StreamEvent::Format(*format));
    });
}

extern "C" fn on_buffer_info(
    user: *mut c_void,
    data_type: u32,
    n_datas: u32,
    has_cursor_meta: i32,
    cursor_meta_size: u32,
    metas: *const c_char,
) {
    with_sink(user, |sink| {
        let metas = if metas.is_null() {
            String::new()
        } else {
            // SAFETY: the shim always passes a NUL-terminated stack buffer that
            // outlives the callback.
            unsafe { CStr::from_ptr(metas) }.to_string_lossy().into_owned()
        };
        sink(StreamEvent::BufferInfo {
            data_type,
            n_datas,
            has_cursor_meta: has_cursor_meta != 0,
            cursor_meta_size,
            metas,
        });
    });
}

extern "C" fn on_cursor(user: *mut c_void, cursor: *const RawCursor) {
    with_sink(user, |sink| {
        if cursor.is_null() {
            return;
        }
        // SAFETY: non-NULL for the duration of the callback, by contract.
        let cursor = unsafe { &*cursor };

        let bitmap = if cursor.has_bitmap != 0
            && !cursor.bitmap_data.is_null()
            && cursor.bitmap_len > 0
        {
            // SAFETY: the shim validated that `bitmap_len` bytes starting at
            // `bitmap_data` lie inside the metadata block before setting
            // has_bitmap; the region stays mapped until the callback returns.
            let pixels =
                unsafe { std::slice::from_raw_parts(cursor.bitmap_data, cursor.bitmap_len) };
            Some(CursorBitmap {
                format: cursor.bitmap_format,
                width: cursor.bitmap_width,
                height: cursor.bitmap_height,
                stride: cursor.bitmap_stride,
                pixels: pixels.to_vec(),
            })
        } else {
            None
        };

        sink(StreamEvent::Cursor(CursorEvent {
            x: cursor.x,
            y: cursor.y,
            hotspot_x: cursor.hotspot_x,
            hotspot_y: cursor.hotspot_y,
            id: cursor.id,
            bitmap,
        }));
    });
}

extern "C" fn on_state(user: *mut c_void, state: *const c_char, error: *const c_char) {
    with_sink(user, |sink| {
        let to_string = |raw: *const c_char| {
            if raw.is_null() {
                None
            } else {
                // SAFETY: libpipewire hands us NUL-terminated static/owned strings.
                Some(unsafe { CStr::from_ptr(raw) }.to_string_lossy().into_owned())
            }
        };
        sink(StreamEvent::State {
            state: to_string(state).unwrap_or_else(|| "unknown".to_owned()),
            error: to_string(error),
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixStream;
    use std::sync::mpsc;
    use std::time::Duration;

    /// The bound that made Stage 1 produce nothing on the first real run.
    ///
    /// Compositors declare SPA_PARAM_META_size for the cursor as a FIXED
    /// SPA_POD_Int; PipeWire then intersects it with the consumer's declaration
    /// via `spa_pod_filter`. If the consumer's accepted range does not contain
    /// that constant, the ENTIRE ParamMeta object is filtered out and the
    /// buffers arrive with no cursor metadata — no error, no warning, a stream
    /// that negotiates and runs perfectly while reporting nothing.
    ///
    /// mutter 46.2 declares CURSOR_META_SIZE(384, 384) = 589872 bytes
    /// (src/backends/meta-screen-cast-stream-src.c). The original ceiling of
    /// 256x256 = 262192 bytes sat below it, so every buffer came back with
    /// hasCursorMeta=false against real GNOME.
    ///
    /// This runs the same `spa_pod_filter` the link uses, against the same POD
    /// `param_changed` sends, so it fails here instead of on someone's desktop.
    #[test]
    fn cursor_meta_range_contains_what_real_compositors_declare() {
        // mutter 46.2. The regression case: this returned 0 before the fix.
        assert_eq!(
            cursor_meta_accepts_producer_size(384, 384),
            1,
            "mutter 46.2 declares a fixed CURSOR_META_SIZE(384, 384); our range must contain it"
        );
        // Headroom for compositors with larger or smaller cursor planes.
        for (width, height) in [(1, 1), (64, 64), (256, 256), (512, 512), (1024, 1024)] {
            assert_eq!(
                cursor_meta_accepts_producer_size(width, height),
                1,
                "a producer declaring {width}x{height} must still intersect"
            );
        }
        // And the bound is a real bound, not an accident of the filter always
        // succeeding: something past the ceiling must still be rejected.
        assert_eq!(
            cursor_meta_accepts_producer_size(2048, 2048),
            0,
            "beyond the declared ceiling the intersection must genuinely be empty"
        );
    }

    /// End-to-end exercise of the PipeWire half with NO portal involved.
    ///
    /// `pw_context_connect_fd` accepts any socket already connected to a
    /// PipeWire daemon — the portal's `OpenPipeWireRemote` fd is exactly that,
    /// just pointed at a restricted instance. Connecting to the session daemon
    /// directly therefore drives the identical code path (POD negotiation,
    /// param_changed, on_process, buffer inspection) without raising a picker
    /// or capturing anyone's screen.
    ///
    /// Ignored by default: it needs a running PipeWire and a video node to read.
    /// The node has to offer one of the 32-bit packed formats the shim asks for
    /// (SPA's own `videotestsrc` plugin only offers RGB24 and UYVY, so it
    /// negotiates to "no more input formats" — that is the source's limitation,
    /// not a bug). GStreamer can publish a suitable one:
    ///
    /// ```sh
    /// gst-launch-1.0 videotestsrc is-live=true \
    ///   ! video/x-raw,format=BGRx,width=640,height=480,framerate=30/1 \
    ///   ! pipewiresink stream-properties="props,node.name=oscbgrxtest,media.class=Video/Source" &
    /// OPENSCREEN_PIPEWIRE_TEST_NODE=$(pw-dump | jq '.[]
    ///   | select(.info.props["node.name"] == "oscbgrxtest") | .id') \
    ///   cargo test -- --ignored --nocapture
    /// ```
    ///
    /// `cursorMeta` is expected to be false here: only a compositor's screencast
    /// source attaches SPA_META_Cursor. That part still needs the portal.
    #[test]
    #[ignore = "needs a live PipeWire daemon and OPENSCREEN_PIPEWIRE_TEST_NODE"]
    fn negotiates_a_stream_against_a_local_pipewire_node() {
        let node_id: u32 = std::env::var("OPENSCREEN_PIPEWIRE_TEST_NODE")
            .expect("set OPENSCREEN_PIPEWIRE_TEST_NODE to a video node id")
            .parse()
            .expect("node id must be an integer");

        load().expect("libpipewire must load");
        let runtime = std::env::var("XDG_RUNTIME_DIR").expect("XDG_RUNTIME_DIR");
        let socket = UnixStream::connect(format!("{runtime}/pipewire-0"))
            .expect("PipeWire daemon socket");

        let (sender, receiver) = mpsc::channel();
        let session = Session::start(
            socket.into(),
            node_id,
            Box::new(move |event| {
                let _ = sender.send(event);
            }),
        )
        .expect("stream must connect");

        let started = std::time::Instant::now();
        let stamp = |at: std::time::Instant| at.duration_since(started).as_millis();

        let mut format = None;
        let mut buffer_info = None;
        let mut buffer_reports = 0;
        // Run well past the first buffer. A stream that dies after one buffer and
        // a stream that runs for seconds look identical if you stop watching at
        // the first one — that ambiguity is what sent the last debugging round
        // down the wrong path.
        let observe_until = started + Duration::from_secs(5);
        while std::time::Instant::now() < observe_until {
            match receiver.recv_timeout(Duration::from_millis(250)) {
                Ok(StreamEvent::Format(value)) => {
                    println!("[{:>5}ms] format {}x{}", stamp(std::time::Instant::now()), value.width, value.height);
                    format = Some(value);
                }
                Ok(StreamEvent::BufferInfo {
                    data_type,
                    n_datas,
                    has_cursor_meta,
                    cursor_meta_size,
                    metas,
                }) => {
                    buffer_reports += 1;
                    println!(
                        "[{:>5}ms] buffer #{buffer_reports} dataType={data_type} nDatas={n_datas} \
                         cursorMeta={has_cursor_meta} cursorMetaSize={cursor_meta_size} metas=[{metas}]",
                        stamp(std::time::Instant::now())
                    );
                    buffer_info =
                        Some((data_type, n_datas, has_cursor_meta, cursor_meta_size, metas));
                }
                Ok(StreamEvent::State { state, error }) => {
                    println!(
                        "[{:>5}ms] state {state}{}",
                        stamp(std::time::Instant::now()),
                        error.map(|e| format!(" error={e}")).unwrap_or_default()
                    );
                }
                Ok(StreamEvent::Cursor(cursor)) => {
                    println!("[{:>5}ms] cursor {cursor:?}", stamp(std::time::Instant::now()));
                }
                Err(_) => {}
            }
        }

        // Teardown, watched. Whatever the stream reports while being stopped is
        // what a maintainer's log will show at the end of every clean run, so it
        // must not be mistaken for a failure.
        println!("[{:>5}ms] -- dropping session --", stamp(std::time::Instant::now()));
        drop(session);
        println!("[{:>5}ms] -- session dropped --", stamp(std::time::Instant::now()));
        while let Ok(event) = receiver.recv_timeout(Duration::from_millis(250)) {
            println!("[{:>5}ms] after-drop {event:?}", stamp(std::time::Instant::now()));
        }

        let format = format.expect("param_changed must deliver a negotiated format");
        let (_, n_datas, _, _, _) = buffer_info.expect("on_process must run at least once");
        assert!(format.width > 0 && format.height > 0);
        assert!(n_datas > 0);
        assert!(
            buffer_reports > 1,
            "the stream delivered only {buffer_reports} buffer report(s); it is not staying alive"
        );
    }
}
