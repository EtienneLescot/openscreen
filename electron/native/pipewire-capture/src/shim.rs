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
use std::os::fd::{BorrowedFd, IntoRawFd, OwnedFd};
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
#[derive(Debug)]
pub struct RawFrame {
    pub data: *const u8,
    pub size: usize,
    pub stride: i32,
    pub width: i32,
    pub height: i32,
    pub video_format: u32,
    pub pts_ns: i64,
    pub crop_x: i32,
    pub crop_y: i32,
    pub crop_width: i32,
    pub crop_height: i32,
    pub has_crop: i32,
    /// Zero-copy dmabuf hand-off (issue #507). When non-zero, `data` is null and
    /// the frame is a tiled GPU buffer described by the fields below — imported
    /// as a VAAPI surface rather than read from `data`. Layout mirrors
    /// `struct osc_pw_frame` in pw_shim.h exactly.
    pub is_dmabuf: i32,
    pub modifier: u64,
    pub drm_fourcc: u32,
    pub n_planes: i32,
    pub plane_fd: [i32; 4],
    pub plane_offset: [i32; 4],
    pub plane_stride: [i32; 4],
    /// The `struct pw_buffer *` this frame came from (opaque). Returned to
    /// `osc_pw_requeue_buffer` once the dmabuf import has copied the pixels, if
    /// `on_frame` took ownership of it. Null/unused on the CPU path.
    pub buffer_handle: *mut c_void,
    /// Registration generation of `buffer_handle`, handed back with it so the
    /// re-queue can reject a stale pointer a renegotiation reused (see the C side).
    pub buffer_generation: u64,
}

/// A `struct pw_buffer *` we are holding out of PipeWire's queue until its dmabuf
/// content has been imported, tagged with its registration `generation` so the
/// re-queue can tell it from a newer buffer reusing the same slot. Send so it can
/// travel through the mailbox; the pointer is only ever handed back to
/// `osc_pw_requeue_buffer`, never dereferenced on the Rust side.
#[derive(Debug, Clone, Copy)]
pub struct BufferHandle {
    pub ptr: *mut c_void,
    pub generation: u64,
}
// SAFETY: the pointer is an opaque token owned by libpipewire; Rust neither reads
// nor writes through it, only returns it to the shim's locked requeue.
unsafe impl Send for BufferHandle {}

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
    on_frame: extern "C" fn(*mut c_void, *const RawFrame) -> i32,
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
    #[cfg(test)]
    fn osc_pw_enum_format_accepts_dmabuf_producer(
        with_modifier: i32,
        producer_modifier: i64,
    ) -> i32;
    fn osc_pw_start(
        fd: i32,
        node_id: u32,
        want_video: i32,
        prefer_dmabuf: i32,
        callbacks: *const RawCallbacks,
        err: *mut c_char,
        err_len: usize,
    ) -> *mut RawSession;
    fn osc_pw_stop(session: *mut RawSession);
    fn osc_pw_requeue_buffer(
        session: *mut RawSession,
        buffer_handle: *mut c_void,
        buffer_generation: u64,
    );
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
    /// A frame is waiting in the [`FrameMailbox`]. Carries no payload on
    /// purpose: an 8 MB frame per channel message would allocate and copy far
    /// more than the mailbox does, and a notification that arrives after its
    /// frame was superseded is harmless — `take()` simply returns `None`.
    FrameReady,
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

/// One captured frame, copied out of the PipeWire buffer.
#[derive(Debug, Default)]
pub struct Frame {
    pub pixels: Vec<u8>,
    pub stride: usize,
    pub width: i32,
    pub height: i32,
    pub video_format: u32,
    /// Compositor monotonic clock in nanoseconds, or -1 when the buffer carried
    /// no SPA_META_Header.
    pub pts_ns: i64,
    /// The sub-rectangle of `pixels` holding content, from SPA_META_VideoCrop.
    /// Defaults to the whole frame, so it is always safe to read.
    pub crop: CropRect,
    /// The crop is real and narrower than the frame. False covers "no meta",
    /// "invalid meta" and "meta covering everything" alike — none of which is a
    /// reason to crop, and none of which may be guessed apart.
    pub has_crop: bool,
    /// Set for a tiled dmabuf frame (issue #507): `pixels` is empty and the
    /// content is on the GPU, described here for a VAAPI import instead. The
    /// owned fds close when the frame is dropped or superseded.
    pub dmabuf: Option<DmabufDesc>,
}

/// A tiled dmabuf handed up for GPU import. Holds the PipeWire buffer OUT of the
/// queue (via `buffer_handle`) so the plane fds AND their content stay valid until
/// the import copies the surface — dup'ing the fds alone would preserve the object
/// but not a content snapshot, letting the compositor overwrite a re-queued buffer
/// (CodeRabbit / issue #507). On drop the handle is pushed to `requeue`, which the
/// main loop drains and hands back to the shim's locked re-queue.
pub struct DmabufDesc {
    pub width: i32,
    pub height: i32,
    pub drm_fourcc: u32,
    pub modifier: u64,
    pub planes: Vec<DmabufPlane>,
    buffer_handle: BufferHandle,
    requeue: std::sync::Arc<std::sync::Mutex<Vec<BufferHandle>>>,
}

impl std::fmt::Debug for DmabufDesc {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DmabufDesc")
            .field("width", &self.width)
            .field("height", &self.height)
            .field("drm_fourcc", &self.drm_fourcc)
            .field("modifier", &self.modifier)
            .field("planes", &self.planes)
            .finish_non_exhaustive()
    }
}

impl Drop for DmabufDesc {
    fn drop(&mut self) {
        // Return the held PipeWire buffer once the import that read it is done
        // (which is why this runs at drop, after `Capture::stage`). Pushed to the
        // queue rather than re-queued here because re-queue must run on the main
        // loop, not the PipeWire thread that supersedes a frame — see
        // FrameMailbox and osc_pw_requeue_buffer.
        if !self.buffer_handle.ptr.is_null() {
            if let Ok(mut queue) = self.requeue.lock() {
                queue.push(self.buffer_handle);
            }
        }
    }
}

/// One dmabuf plane: an OWNED (dup'd) fd plus its layout. The dup is taken when the
/// frame is claimed and closed when the owning `DmabufDesc` drops. Owning it — not
/// borrowing the PipeWire buffer's fd — is what keeps the plane valid if a
/// renegotiation destroys the buffer set (which closes the original fds and reuses
/// the numbers) while this plane is still queued for import.
#[derive(Debug)]
pub struct DmabufPlane {
    pub fd: OwnedFd,
    pub offset: i32,
    pub stride: i32,
}

/// A rectangle inside a captured frame, in stream pixels.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct CropRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// A one-slot mailbox between the PipeWire thread and the encoder.
///
/// NEWEST WINS. When the encoder falls behind, an unconsumed frame is
/// overwritten rather than queued. A queue would be the wrong shape twice over:
/// it would grow without bound at 8 MB per 1080p frame, and every frame it held
/// would add latency to a recording that is supposed to track the screen. A
/// dropped frame costs one duplicated frame in the output; a queued one costs
/// memory and drift forever.
///
/// The buffer of an overwritten or consumed frame is recycled, so after the
/// first few frames this allocates nothing.
#[derive(Debug, Default)]
pub struct FrameMailbox {
    inner: std::sync::Mutex<Mailbox>,
    received: std::sync::atomic::AtomicU64,
    dropped: std::sync::atomic::AtomicU64,
    /// PipeWire buffers held for a dmabuf import, to be re-queued once their
    /// `DmabufDesc` drops (import done, or frame superseded). Drained by the main
    /// loop, which re-queues each through the shim's locked path. Shared into each
    /// `DmabufDesc` so its Drop can push here from either thread.
    requeue: std::sync::Arc<std::sync::Mutex<Vec<BufferHandle>>>,
}

#[derive(Debug, Default)]
struct Mailbox {
    pending: Option<Frame>,
    /// Returned by the consumer, reused by the next copy.
    spare: Option<Vec<u8>>,
}

impl FrameMailbox {
    /// Copies `pixels` into the slot, replacing whatever was there.
    ///
    /// Runs on the PipeWire thread and must stay short: the buffer it reads from
    /// is re-queued to the compositor the moment the callback returns.
    fn put(&self, source: &[u8], meta: &RawFrame) {
        use std::sync::atomic::Ordering;

        let Ok(mut inner) = self.inner.lock() else {
            // A poisoned lock means a previous holder panicked. Dropping the
            // frame is the only safe option, and it is already counted below.
            self.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        };

        // Recycle, in order of preference: the buffer of the frame we are about
        // to discard, then the one the consumer handed back, then a new one.
        let mut pixels = match inner.pending.take() {
            Some(stale) => {
                self.dropped.fetch_add(1, Ordering::Relaxed);
                stale.pixels
            }
            None => inner.spare.take().unwrap_or_default(),
        };
        pixels.clear();
        pixels.extend_from_slice(source);

        inner.pending = Some(Frame {
            pixels,
            stride: meta.stride as usize,
            width: meta.width,
            height: meta.height,
            video_format: meta.video_format,
            pts_ns: meta.pts_ns,
            crop: CropRect {
                x: meta.crop_x,
                y: meta.crop_y,
                width: meta.crop_width,
                height: meta.crop_height,
            },
            has_crop: meta.has_crop != 0,
            dmabuf: None,
        });
        self.received.fetch_add(1, Ordering::Relaxed);
    }

    /// Stores a tiled dmabuf frame — the descriptor only, no pixel copy. Same
    /// newest-wins discipline as [`Self::put`]; a superseded frame's owned fds
    /// close when its `Frame` drops here.
    fn put_dmabuf(&self, desc: DmabufDesc, meta: &RawFrame) {
        use std::sync::atomic::Ordering;

        let Ok(mut inner) = self.inner.lock() else {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        };
        let pixels = match inner.pending.take() {
            Some(stale) => {
                self.dropped.fetch_add(1, Ordering::Relaxed);
                stale.pixels
            }
            None => inner.spare.take().unwrap_or_default(),
        };
        inner.pending = Some(Frame {
            pixels,
            stride: meta.stride as usize,
            width: meta.width,
            height: meta.height,
            video_format: meta.video_format,
            pts_ns: meta.pts_ns,
            crop: CropRect {
                x: meta.crop_x,
                y: meta.crop_y,
                width: meta.crop_width,
                height: meta.crop_height,
            },
            has_crop: meta.has_crop != 0,
            dmabuf: Some(desc),
        });
        self.received.fetch_add(1, Ordering::Relaxed);
    }

    /// Takes the pending frame, if any. Returns `None` when the consumer was
    /// woken by a notification whose frame has already been superseded.
    pub fn take(&self) -> Option<Frame> {
        self.inner.lock().ok()?.pending.take()
    }

    /// Hands a consumed frame's allocation back for reuse.
    pub fn recycle(&self, mut pixels: Vec<u8>) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        pixels.clear();
        inner.spare = Some(pixels);
    }

    /// A clone of the held-buffer re-queue queue, for a `DmabufDesc` to push its
    /// PipeWire buffer to when it drops.
    fn requeue_queue(&self) -> std::sync::Arc<std::sync::Mutex<Vec<BufferHandle>>> {
        self.requeue.clone()
    }

    /// Takes the PipeWire buffers whose dmabuf imports have completed (or were
    /// superseded), for the main loop to re-queue through the shim.
    pub fn drain_requeue(&self) -> Vec<BufferHandle> {
        match self.requeue.lock() {
            Ok(mut queue) => std::mem::take(&mut *queue),
            Err(_) => Vec::new(),
        }
    }

    /// Frames the compositor delivered.
    pub fn received(&self) -> u64 {
        self.received.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Frames overwritten before the encoder could take them.
    pub fn dropped(&self) -> u64 {
        self.dropped.load(std::sync::atomic::Ordering::Relaxed)
    }
}

/// Interleaved samples waiting to be encoded.
///
/// UNLIKE THE VIDEO MAILBOX, THIS IS A QUEUE. A dropped video frame costs one
/// duplicated picture that nobody notices; a dropped audio buffer is an audible
/// click. So samples accumulate rather than being replaced, and the cap exists
/// only as a backstop against a consumer that has stopped consuming entirely —
/// 48 kHz stereo f32 is 384 KB/s, so two seconds is under a megabyte.
///
/// Overflow drops the OLDEST samples and OWES THE SAME NUMBER BACK AS SILENCE.
/// Dropping the oldest is the easy half: if the encoder is that far behind, the
/// recent audio is the part still worth keeping, and refusing new samples
/// instead would freeze the track at the moment of the stall.
///
/// The silence is the half that matters, because a drop here leaves no hole.
/// The encoder's presentation time is a running count of the samples handed to
/// it (`AudioEncoder::next_pts`, encoder.rs), so removing samples does not shift
/// the ones after them late — it pulls them EARLY, by the dropped duration, for
/// the rest of the take. Every later sound would then sit before the picture it
/// belongs to, permanently and by an amount nothing records. Standing in
/// silence of exactly the dropped length keeps that count right, so an overflow
/// costs a gap where it happened and nothing after it. The debt is a counter
/// until someone drains, which is also the only thing that can stop it growing —
/// and it stops being exact at [`MAX_SILENCE_SECONDS`], which is where a bounded
/// allocation starts to matter more than sync nobody can still use.
/// How much silence the ring will stand in for before it stops trying.
///
/// The debt costs a counter while it is owed and only becomes memory when
/// someone drains — 384 KB per second of it, at 48 kHz stereo f32. A drain runs
/// on every tick of the main loop, heartbeat included (`Capture::advance` from
/// the `RecvTimeoutError::Timeout` arm in main.rs), so a debt worth seconds
/// means the loop itself has stopped. There is no bound on how long a stopped
/// loop stays stopped, and one that comes back materialises the whole stall in a
/// single allocation — which is also the one place the ring's own two-second cap
/// does not reach. There is a second, quieter way to get there: nothing drains
/// before the first video frame either, so the debt grows for as long as the
/// portal picker is up. That normally ends in `clear` rather than a drain, but
/// not if staging that first frame fails, and the stop path flushes the ring.
///
/// Thirty seconds is far past any stall a recording survives, and past it the
/// take has a hole half a minute wide — the cap trades sync that is already lost
/// for an allocation that stays bounded. `dropped_samples` keeps counting the
/// whole loss regardless, so the `audio-dropped` warning still reports what
/// really happened rather than what could be paid back.
const MAX_SILENCE_SECONDS: usize = 30;

#[derive(Debug)]
pub struct AudioRing {
    inner: std::sync::Mutex<RingInner>,
    capacity: usize,
    /// Ceiling on `RingInner::silence_owed`. See [`MAX_SILENCE_SECONDS`].
    max_silence_owed: usize,
    dropped: std::sync::atomic::AtomicU64,
}

/// Everything the ring's correctness rests on, under one lock: the queue, the
/// silence owed in front of it, and whether samples are being taken at all.
///
/// `accepting` LIVES HERE rather than in an atomic beside the mutex, and that is
/// not a matter of taste. Read before the lock, a producer could pass the check,
/// wait for a whole `pause` to run, and only then append — putting audio from
/// the far side of a pause into the take, where a pause-then-stop would flush it
/// into the file. Under the lock, "pause has returned" and "no further sample
/// can enter" are the same instant.
#[derive(Debug)]
struct RingInner {
    queue: std::collections::VecDeque<f32>,
    /// Samples dropped on overflow and not yet stood in for.
    silence_owed: usize,
    accepting: bool,
}

impl AudioRing {
    pub fn new(seconds: usize, sample_rate: usize, channels: usize) -> Self {
        Self {
            inner: std::sync::Mutex::new(RingInner {
                queue: std::collections::VecDeque::new(),
                silence_owed: 0,
                accepting: true,
            }),
            capacity: seconds * sample_rate * channels,
            max_silence_owed: MAX_SILENCE_SECONDS * sample_rate * channels,
            dropped: std::sync::atomic::AtomicU64::new(0),
        }
    }

    fn push(&self, samples: &[f32]) {
        use std::sync::atomic::Ordering;

        let Ok(mut inner) = self.inner.lock() else {
            self.dropped.fetch_add(samples.len() as u64, Ordering::Relaxed);
            return;
        };
        // Paused: refused at the door rather than queued and discarded later.
        // See `pause` for why the discard had to go.
        if !inner.accepting {
            return;
        }
        inner.queue.extend(samples.iter().copied());
        if inner.queue.len() > self.capacity {
            let excess = inner.queue.len() - self.capacity;
            inner.queue.drain(..excess);
            // Capped, so one drain can never be asked for more than the ring's
            // own capacity plus this. The tally below is NOT capped: what the
            // warning reports is the loss, not the part of it that was paid for.
            inner.silence_owed = (inner.silence_owed + excess).min(self.max_silence_owed);
            self.dropped.fetch_add(excess as u64, Ordering::Relaxed);
        }
    }

    /// Moves everything queued into `out`, appending — behind any silence the
    /// ring owes for samples it had to drop.
    pub fn drain_into(&self, out: &mut Vec<f32>) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        let owed = std::mem::take(&mut inner.silence_owed);
        out.reserve(owed + inner.queue.len());
        out.resize(out.len() + owed, 0.0);
        out.extend(inner.queue.drain(..));
    }

    /// Discards everything queued, and forgets any overflow so far.
    ///
    /// Called when the video epoch is set: audio captured before the first frame
    /// belongs to no part of the recording, and keeping it would offset the
    /// whole track.
    ///
    /// Resetting `dropped` is the point, not an afterthought. The stream is
    /// opened before the portal picker is raised, so it records for however long
    /// the user takes to click — easily past the ring's two-second cap. Counting
    /// that overflow would report "the encoder could not keep up" on every
    /// single recording, for audio that was always going to be thrown away. The
    /// reset happens under the lock with the rest: outside it, a producer could
    /// slip an overflow between the queue being emptied and the tally being
    /// forgiven, and have a real loss forgiven along with the pre-roll.
    pub fn clear(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.queue.clear();
            inner.silence_owed = 0;
            self.dropped.store(0, std::sync::atomic::Ordering::Relaxed);
        }
    }

    /// Stops taking samples. WHAT IS ALREADY QUEUED STAYS.
    ///
    /// Audio arriving while the recording is paused belongs to no part of it —
    /// the video timeline does not advance across a pause, so keeping it would
    /// push every later sample out of sync by the pause's length. Refusing it at
    /// the door is what makes a discard at resume unnecessary, and the discard
    /// is what did the damage. It threw away three things at once, all of them
    /// from BEFORE the pause and all of them part of the take:
    ///
    ///   * the overflow tally, so a real mid-take drop never reached the
    ///     `audio-dropped` warning (main.rs) — the only place a user is ever
    ///     told a recording lost audio;
    ///   * the silence owed for that drop, so the gap went unfilled and every
    ///     later sample moved early anyway, which is the desync this ring
    ///     exists to prevent;
    ///   * and the queued samples themselves, up to a drain's worth of real
    ///     recorded sound.
    ///
    /// With nothing able to enter while paused, what the ring holds at resume is
    /// exactly what it held at pause, and the first drain after resume places it
    /// where it belongs: the pause is spliced out of the video timeline too, so
    /// the two sides join with no gap on either.
    pub fn pause(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.accepting = false;
        }
    }

    /// Takes samples again, from now.
    pub fn resume(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.accepting = true;
        }
    }

    pub fn dropped_samples(&self) -> u64 {
        self.dropped.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Feeds samples as the PipeWire callback would. Test-only: in the shipped
    /// binary the only writer is `on_audio_samples`.
    #[cfg(test)]
    pub fn push_for_test(&self, samples: &[f32]) {
        self.push(samples);
    }
}

#[repr(C)]
struct RawAudioCallbacks {
    user: *mut c_void,
    on_samples: extern "C" fn(*mut c_void, *const f32, u32),
    on_state: extern "C" fn(*mut c_void, *const c_char, *const c_char),
}

#[repr(C)]
struct RawAudioSession {
    _private: [u8; 0],
}

extern "C" {
    fn osc_pw_audio_start(
        target_object: *const c_char,
        capture_sink: i32,
        rate: u32,
        channels: u32,
        callbacks: *const RawAudioCallbacks,
        err: *mut c_char,
        err_len: usize,
    ) -> *mut RawAudioSession;
    fn osc_pw_audio_stop(session: *mut RawAudioSession);
    fn osc_pw_list_audio_sources(
        out: *mut c_char,
        out_len: usize,
        err: *mut c_char,
        err_len: usize,
    ) -> i32;
}

/// One capture node in the PipeWire graph.
#[derive(Debug, Clone, PartialEq)]
pub struct AudioSourceInfo {
    /// `node.name` — the only thing PW_KEY_TARGET_OBJECT accepts.
    pub name: String,
    /// `node.description` — the human string, and the one Chromium surfaces as
    /// a device label on a PipeWire system. This is what makes matching the
    /// app's microphone picker to a graph node possible at all.
    pub description: String,
}

/// Lists the graph's audio capture nodes.
///
/// Synchronous and self-contained: it opens its own connection, runs a main loop
/// until the registry has replayed every global, and tears down. Called once per
/// recording, before the streams start.
pub fn list_audio_sources() -> Result<Vec<AudioSourceInfo>, String> {
    // 16 KiB holds ~200 nodes; a graph that large is already pathological, and
    // the C side stops at a record boundary rather than truncating one.
    let mut buffer = vec![0 as c_char; 16 * 1024];
    let mut err = [0 as c_char; ERR_LEN];
    // SAFETY: both buffers are live and correctly sized for the duration.
    let result = unsafe {
        osc_pw_list_audio_sources(buffer.as_mut_ptr(), buffer.len(), err.as_mut_ptr(), ERR_LEN)
    };
    if result != 0 {
        return Err(take_error(&err));
    }
    // SAFETY: the C side always NUL-terminates within the buffer it was given.
    let text = unsafe { CStr::from_ptr(buffer.as_ptr()) }.to_string_lossy().into_owned();
    Ok(text
        .split('\u{1e}')
        .filter(|record| !record.is_empty())
        .filter_map(|record| {
            let (name, description) = record.split_once('\u{1f}')?;
            Some(AudioSourceInfo {
                name: name.to_owned(),
                description: description.to_owned(),
            })
        })
        .collect())
}

/// What an audio stream reports besides samples.
pub type AudioStateSink = Box<dyn Fn(String, Option<String>) + Send>;

struct AudioCallbackState {
    ring: std::sync::Arc<AudioRing>,
    on_state: AudioStateSink,
}

/// One running audio capture stream. Dropping it joins its PipeWire thread.
pub struct AudioSession {
    raw: *mut RawAudioSession,
    _state: Box<AudioCallbackState>,
}

impl AudioSession {
    /// `target` names a specific PipeWire node, or `None` for the session
    /// default. `capture_sink` selects a sink's monitor (the system mix) rather
    /// than a source (a microphone).
    pub fn start(
        target: Option<&str>,
        capture_sink: bool,
        rate: u32,
        channels: u32,
        ring: std::sync::Arc<AudioRing>,
        on_state: AudioStateSink,
    ) -> Result<Self, String> {
        let target_c = match target.filter(|name| !name.is_empty()) {
            Some(name) => Some(
                std::ffi::CString::new(name)
                    .map_err(|_| "the audio target name contains a NUL byte".to_owned())?,
            ),
            None => None,
        };
        let state = Box::new(AudioCallbackState { ring, on_state });
        let callbacks = RawAudioCallbacks {
            user: &*state as *const AudioCallbackState as *mut c_void,
            on_samples: on_audio_samples,
            on_state: on_audio_state,
        };

        let mut err = [0 as c_char; ERR_LEN];
        // SAFETY: `callbacks`, `target_c` and `err` all outlive the call, and
        // `state` outlives the returned session, which keeps `user` valid for
        // every callback.
        let raw = unsafe {
            osc_pw_audio_start(
                target_c.as_ref().map_or(std::ptr::null(), |name| name.as_ptr()),
                i32::from(capture_sink),
                rate,
                channels,
                &callbacks,
                err.as_mut_ptr(),
                ERR_LEN,
            )
        };
        if raw.is_null() {
            return Err(take_error(&err));
        }
        Ok(Self { raw, _state: state })
    }
}

impl Drop for AudioSession {
    fn drop(&mut self) {
        // SAFETY: `raw` came from osc_pw_audio_start and is stopped exactly once.
        unsafe { osc_pw_audio_stop(self.raw) };
    }
}

fn with_audio_state<F>(user: *mut c_void, body: F)
where
    F: FnOnce(&AudioCallbackState),
{
    if user.is_null() {
        return;
    }
    // SAFETY: `user` points at state owned by a live AudioSession;
    // osc_pw_audio_stop joins the loop thread before the box is dropped.
    let state = unsafe { &*(user as *const AudioCallbackState) };
    let _ = catch_unwind(AssertUnwindSafe(|| body(state)));
}

extern "C" fn on_audio_samples(user: *mut c_void, samples: *const f32, count: u32) {
    with_audio_state(user, |state| {
        if samples.is_null() || count == 0 {
            return;
        }
        // SAFETY: the shim clamped `count` against the buffer's mapped size
        // before the call, and the mapping outlives it.
        let slice = unsafe { std::slice::from_raw_parts(samples, count as usize) };
        state.ring.push(slice);
    });
}

extern "C" fn on_audio_state(user: *mut c_void, state_name: *const c_char, error: *const c_char) {
    with_audio_state(user, |state| {
        let name = if state_name.is_null() {
            String::new()
        } else {
            // SAFETY: libpipewire's pw_stream_state_as_string returns a static
            // NUL-terminated string.
            unsafe { CStr::from_ptr(state_name) }.to_string_lossy().into_owned()
        };
        let error = if error.is_null() {
            None
        } else {
            // SAFETY: non-NULL implies a NUL-terminated string that outlives the call.
            Some(unsafe { CStr::from_ptr(error) }.to_string_lossy().into_owned())
        };
        (state.on_state)(name, error);
    });
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

/// DRM format modifiers, as spelled in `pw_shim.c`.
#[cfg(test)]
pub const DRM_FORMAT_MOD_LINEAR: i64 = 0;
#[cfg(test)]
pub const DRM_FORMAT_MOD_INVALID: i64 = 0x00ff_ffff_ffff_ffff;

/// Would our EnumFormat survive negotiation against a DMA-BUF-only producer
/// declaring `producer_modifier` as MANDATORY? `with_modifier` selects which of
/// our two objects to test: `false` for the shared-memory one, `true` for the
/// DMA-BUF fallback.
#[cfg(test)]
pub fn enum_format_accepts_dmabuf_producer(with_modifier: bool, producer_modifier: i64) -> i32 {
    // SAFETY: no arguments to validate; the shim builds and frees its own PODs.
    unsafe { osc_pw_enum_format_accepts_dmabuf_producer(i32::from(with_modifier), producer_modifier) }
}

/// SPA enum values as compiled from the vendored headers.
pub fn constants() -> Constants {
    let mut out = Constants::default();
    // SAFETY: `out` is a live, correctly typed destination.
    unsafe { osc_pw_constants(&mut out) };
    out
}

/// What the C side carries as its opaque `user` pointer.
struct CallbackState {
    sink: Sink,
    /// `None` in cursor-only mode, in which case the C side is not asked for
    /// frames either and `on_frame` can never fire.
    frames: Option<std::sync::Arc<FrameMailbox>>,
}

/// A running PipeWire stream. Dropping it stops and joins the PipeWire thread.
pub struct Session {
    raw: *mut RawSession,
    // Kept alive for exactly as long as `raw`: the C side holds a pointer to it
    // and hands it back to every callback. Dropped after osc_pw_stop has joined
    // the loop thread, so no callback can be in flight at that point.
    _state: Box<CallbackState>,
}

impl Session {
    /// Consumes `fd` — libpipewire closes it, on the success and failure paths alike.
    ///
    /// `frames` decides the mode. `Some` maps the buffers and copies each frame
    /// into the mailbox, announcing it with [`StreamEvent::FrameReady`]; `None`
    /// never maps a pixel, which is what keeps a cursor-only session cheap.
    pub fn start(
        fd: OwnedFd,
        node_id: u32,
        sink: Sink,
        frames: Option<std::sync::Arc<FrameMailbox>>,
        // Offer dmabuf before shm for a whole-monitor GPU import (issue #507).
        // Only honoured for a video session; ignored for cursor-only.
        prefer_dmabuf: bool,
    ) -> Result<Self, String> {
        let want_video = i32::from(frames.is_some());
        let prefer_dmabuf = i32::from(want_video != 0 && prefer_dmabuf);
        let state = Box::new(CallbackState { sink, frames });
        let user = &*state as *const CallbackState as *mut c_void;
        let callbacks = RawCallbacks {
            user,
            on_format,
            on_cursor,
            on_frame,
            on_buffer_info,
            on_state,
        };

        let mut err = [0 as c_char; ERR_LEN];
        // SAFETY: `callbacks` and `err` outlive the call; `state` outlives the
        // returned session, which is what keeps `user` valid for the callbacks.
        let raw = unsafe {
            osc_pw_start(
                fd.into_raw_fd(),
                node_id,
                want_video,
                prefer_dmabuf,
                &callbacks,
                err.as_mut_ptr(),
                ERR_LEN,
            )
        };
        if raw.is_null() {
            return Err(take_error(&err));
        }

        Ok(Self { raw, _state: state })
    }

    /// Re-queues a PipeWire buffer a dmabuf frame took ownership of, once its
    /// import has copied the pixels. Call from the main loop (NOT the PipeWire
    /// thread) — the shim takes the thread-loop lock. Drain the mailbox's
    /// `drain_requeue` for the handles.
    pub fn requeue(&self, handle: BufferHandle) {
        // SAFETY: `raw` is a live session for the lifetime of `self`; the handle
        // is an opaque pw_buffer token the shim validates and only re-queues.
        unsafe { osc_pw_requeue_buffer(self.raw, handle.ptr, handle.generation) };
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
fn with_state<F>(user: *mut c_void, body: F)
where
    F: FnOnce(&CallbackState),
{
    if user.is_null() {
        return;
    }
    // SAFETY: `user` is the pointer we handed to osc_pw_start, pointing at state
    // owned by the live Session. Callbacks cannot outlive it: osc_pw_stop joins
    // the loop thread before the Session drops the box.
    let state = unsafe { &*(user as *const CallbackState) };
    let _ = catch_unwind(AssertUnwindSafe(|| body(state)));
}

fn with_sink<F>(user: *mut c_void, body: F)
where
    F: FnOnce(&Sink),
{
    with_state(user, |state| body(&state.sink));
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

/// Returns 1 when we TAKE OWNERSHIP of the PipeWire buffer — a tiled dmabuf held
/// out of the queue until the main loop imports it — so the shim must not re-queue
/// it. 0 otherwise (the CPU path, or any frame we decline), which re-queues as
/// before.
extern "C" fn on_frame(user: *mut c_void, frame: *const RawFrame) -> i32 {
    if user.is_null() || frame.is_null() {
        return 0;
    }
    // SAFETY: `user` is the CallbackState pointer given to osc_pw_start, valid for
    // the session's lifetime; `frame` is valid for the callback's duration.
    let state = unsafe { &*(user as *const CallbackState) };
    // Same guard `with_state` gives every other callback, which this one cannot use
    // because it returns a value: a panic (an allocation failure in
    // `Vec::with_capacity`, a capacity overflow in `put`) must not unwind across the
    // `extern "C"` boundary and abort the helper. Decline the frame on panic (0) so
    // the shim re-queues it rather than leaking the buffer.
    catch_unwind(AssertUnwindSafe(|| on_frame_inner(state, frame))).unwrap_or(0)
}

/// The body of [`on_frame`], split out so the callback can wrap it in
/// `catch_unwind`. `frame` is non-null (checked by the caller) and valid for the
/// callback's duration.
fn on_frame_inner(state: &CallbackState, frame: *const RawFrame) -> i32 {
    let Some(mailbox) = state.frames.as_ref() else {
        return 0;
    };
    // SAFETY: non-null (checked in `on_frame`) and valid for the callback duration.
    let frame = unsafe { &*frame };

    // Tiled dmabuf: no pixels to copy. Take the PipeWire buffer (hold it out of
    // the queue) so the plane fds AND their content stay valid until the main-loop
    // import copies the surface; the buffer is re-queued when the DmabufDesc drops.
    if frame.is_dmabuf != 0 {
        // Decline a buffer the C side could not register (its live-buffer table was
        // full — two overlapping sets across a renegotiation). Its generation is 0,
        // which `osc_pw_requeue_buffer` refuses to re-queue, so holding it would
        // leak it out of the pool for good. Returning 0 lets the shim re-queue it
        // now; the frame is dropped instead (the previous one is held forward).
        if frame.buffer_generation == 0 {
            return 0;
        }
        let n = frame.n_planes.clamp(0, 4) as usize;
        if n == 0 {
            return 0;
        }
        let mut planes = Vec::with_capacity(n);
        for i in 0..n {
            let fd = frame.plane_fd[i];
            if fd < 0 {
                return 0;
            }
            // Dup the plane fd so the descriptor owns a handle independent of the
            // PipeWire buffer's lifetime: if a renegotiation destroys the buffer set
            // while this desc is still queued for import, the original fds are closed
            // and their numbers reused, and a borrowed fd would then import an
            // unrelated buffer. The dup keeps the dmabuf alive until the OwnedFd drops
            // with the desc, after `Capture::stage`; VAAPI dups again during surface
            // creation, so it costs nothing past import.
            // SAFETY: `fd` is valid for this callback; `try_clone_to_owned` dups it.
            let Ok(owned) = (unsafe { BorrowedFd::borrow_raw(fd) }).try_clone_to_owned() else {
                // fd exhaustion: decline. `planes` drops here, closing the dups taken
                // so far, and the shim re-queues the buffer.
                return 0;
            };
            planes.push(DmabufPlane {
                fd: owned,
                offset: frame.plane_offset[i],
                stride: frame.plane_stride[i],
            });
        }
        mailbox.put_dmabuf(
            DmabufDesc {
                width: frame.width,
                height: frame.height,
                drm_fourcc: frame.drm_fourcc,
                modifier: frame.modifier,
                planes,
                buffer_handle: BufferHandle {
                    ptr: frame.buffer_handle,
                    generation: frame.buffer_generation,
                },
                requeue: mailbox.requeue_queue(),
            },
            frame,
        );
        (state.sink)(StreamEvent::FrameReady);
        return 1;
    }

    if frame.data.is_null() || frame.stride <= 0 || frame.height <= 0 {
        return 0;
    }
    // Copy only the rows, not the whole mapping. `size` can include trailing
    // slack the compositor allocated, and re-checking the product here means
    // the slice below cannot outrun the region the C side validated.
    let Some(rows) = (frame.stride as usize).checked_mul(frame.height as usize) else {
        return 0;
    };
    if rows > frame.size {
        return 0;
    }
    // SAFETY: the shim clamped `size` against the mapping's `maxsize` before
    // the callback, `rows <= size` was just checked, and the mapping stays
    // live until this returns.
    let pixels = unsafe { std::slice::from_raw_parts(frame.data, rows) };
    mailbox.put(pixels, frame);
    (state.sink)(StreamEvent::FrameReady);
    0
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

    /// Issue #287, reproduced without niri, a portal or a screen.
    ///
    /// A DMA-BUF-only compositor publishes its EnumFormat with
    /// `SPA_FORMAT_VIDEO_modifier` carrying `SPA_POD_PROP_FLAG_MANDATORY`.
    /// `spa_pod_filter` (spa/pod/filter.h:352) turns a mandatory producer
    /// property the consumer never mentions into `-EINVAL` for the WHOLE object,
    /// so every format is filtered out and the link dies reporting "no more
    /// input formats" — the exact string from the report, on Arch + niri, on
    /// both 1.8.0 and 1.9.0-rc.3.
    ///
    /// The fix is a second EnumFormat object that does declare a modifier, sent
    /// after the shared-memory one so compositors that can do shm are unaffected.
    /// Both halves are asserted here, because "the new object is accepted" alone
    /// would still hold if the old one had been silently made to match too —
    /// and that would mean GNOME had quietly moved to the DMA-BUF path.
    #[test]
    fn enum_format_survives_a_dmabuf_only_producer() {
        for modifier in [DRM_FORMAT_MOD_LINEAR, DRM_FORMAT_MOD_INVALID] {
            assert_eq!(
                enum_format_accepts_dmabuf_producer(false, modifier),
                0,
                "the shm object must still be rejected by a mandatory-modifier producer \
                 (modifier {modifier:#x}) — that rejection is why the second object exists"
            );
            assert_eq!(
                enum_format_accepts_dmabuf_producer(true, modifier),
                1,
                "the dmabuf object must intersect a producer declaring modifier {modifier:#x}"
            );
        }

        // The advertised modifier set is a real set, not a wildcard: a tiled or
        // compressed buffer cannot be read through a plain mmap, so it must fail
        // negotiation rather than be accepted and decoded into garbage.
        // 0x0300000000000001 = a vendor (NVIDIA — modifier vendor byte 0x03) modifier,
        // neither LINEAR nor INVALID.
        assert_eq!(
            enum_format_accepts_dmabuf_producer(true, 0x0300_0000_0000_0001),
            0,
            "a modifier we cannot mmap must not intersect — accepting it would ship \
             a scrambled recording instead of an error"
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
            // Cursor-only: this test is about negotiation reaching `streaming`
            // and about which metadata survives, neither of which needs pixels.
            None,
            // Cursor-only, so dmabuf preference is irrelevant.
            false,
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
                // Unreachable: this session was started with no mailbox, so the
                // C side was never asked for frames. Matched rather than
                // wildcarded so that adding a variant is a compile error here
                // too, which is how this test stays a full protocol trace.
                Ok(StreamEvent::FrameReady) => unreachable!("cursor-only session yielded a frame"),
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

#[cfg(test)]
mod source_tests {
    /// Prints the graph's capture nodes. Opt-in — it needs a live PipeWire
    /// session, so CI skips it; run it by hand when the microphone a user picked
    /// does not match what got recorded.
    #[test]
    fn lists_the_audio_sources_of_a_live_session() {
        if std::env::var("OPENSCREEN_PIPEWIRE_LIST").is_err() {
            eprintln!("skipped: set OPENSCREEN_PIPEWIRE_LIST=1 with a running PipeWire");
            return;
        }
        super::load().expect("libpipewire must load");
        let sources = super::list_audio_sources().expect("enumeration");
        for source in &sources {
            println!("  {}  <-  {}", source.name, source.description);
        }
        assert!(!sources.is_empty(), "a desktop session always has at least one capture node");
    }
}

#[cfg(test)]
mod audio_ring_tests {
    use super::AudioRing;

    /// Capacity 16 samples — small enough to overflow by hand, and the unit the
    /// ring counts in is interleaved samples, not frames.
    fn ring() -> AudioRing {
        AudioRing::new(1, 8, 2)
    }

    #[test]
    fn overflow_is_stood_in_for_by_silence_rather_than_pulling_the_take_earlier() {
        // THE regression. The encoder's timestamps are a running count of the
        // samples it was handed (`AudioEncoder::next_pts`), so samples removed
        // from the middle of the stream do not leave a hole — every later sound
        // arrives that much earlier than the picture it belongs to, for the rest
        // of the take, and nothing in the file records that it happened.
        let ring = ring();
        ring.push_for_test(&vec![1.0; 40]);
        assert_eq!(ring.dropped_samples(), 24, "40 samples into a 16-sample ring drops 24");

        let mut out = Vec::new();
        ring.drain_into(&mut out);

        assert_eq!(out.len(), 40, "the drain must cover as much time as was pushed");
        assert!(out[..24].iter().all(|sample| *sample == 0.0), "the drop reads as silence");
        assert!(out[24..].iter().all(|sample| *sample == 1.0), "the survivors are the newest");
    }

    #[test]
    fn the_silence_owed_stops_growing_before_the_allocation_does() {
        // A drain turns the debt into real samples, and nothing else bounds how
        // large it can get: the loop can stop for an unbounded stretch and then
        // come back. `ring()` is 8 Hz stereo, so the cap is 30 s = 480 samples.
        let ring = ring();
        ring.push_for_test(&vec![1.0; 5_000]);

        let mut out = Vec::new();
        ring.drain_into(&mut out);
        assert_eq!(
            out.len(),
            480 + 16,
            "a drain may never be asked for more than the cap plus the ring's own capacity"
        );
        assert_eq!(
            ring.dropped_samples(),
            4_984,
            "and the tally still reports the whole loss, not the part paid back"
        );
    }

    #[test]
    fn the_silence_owed_is_paid_once() {
        let ring = ring();
        ring.push_for_test(&vec![1.0; 40]);
        let mut first = Vec::new();
        ring.drain_into(&mut first);

        ring.push_for_test(&[0.5, 0.5]);
        let mut second = Vec::new();
        ring.drain_into(&mut second);
        assert_eq!(second, vec![0.5, 0.5], "a settled debt must not be paid again");
    }

    #[test]
    fn a_pause_refuses_what_arrives_and_keeps_what_was_already_there() {
        // Both halves matter. What arrives during a pause must not enter — the
        // video timeline does not advance across one, so encoding it would push
        // every later sample out by the pause's length. What was already queued
        // must not leave: it was captured BEFORE the pause and is take audio.
        let ring = ring();
        ring.push_for_test(&[1.0; 10]);

        ring.pause();
        ring.push_for_test(&[0.75; 400]);
        assert_eq!(ring.dropped_samples(), 0, "a pause discards, it does not drop");

        ring.resume();
        let mut out = Vec::new();
        ring.drain_into(&mut out);
        assert_eq!(out, vec![1.0; 10], "the pre-pause audio is still there, and only it");

        // `drain_into` appends, so this asks the question of a fresh buffer.
        let mut after = Vec::new();
        ring.push_for_test(&[0.25, 0.25]);
        ring.drain_into(&mut after);
        assert_eq!(after, vec![0.25, 0.25], "and the ring takes samples again after it");
    }

    #[test]
    fn a_drop_before_a_pause_is_still_stood_in_for_after_it() {
        // The pause used to clear the ring, which deleted the silence owed for
        // an overflow that had happened before it while LEAVING the tally that
        // reports it. Both halves were wrong at once: the recording lost the
        // compensation, so everything after the pause moved early, and the
        // `audio-dropped` warning claimed a silence that was never written.
        let ring = ring();
        ring.push_for_test(&vec![1.0; 40]);
        assert_eq!(ring.dropped_samples(), 24);

        ring.pause();
        ring.resume();

        let mut out = Vec::new();
        ring.drain_into(&mut out);
        assert_eq!(out.len(), 40, "the pause must not eat the time the drop stands for");
        assert!(out[..24].iter().all(|sample| *sample == 0.0));
        assert_eq!(
            ring.dropped_samples(),
            24,
            "and what the warning reports still matches what the track got"
        );
    }

    #[test]
    fn clearing_forgets_the_overflow_and_the_silence_it_owed() {
        // The pre-roll case: everything captured before the first video frame is
        // thrown away wholesale, so neither the drop nor the gap it left is part
        // of any recording.
        let ring = ring();
        ring.push_for_test(&vec![1.0; 40]);
        ring.clear();
        assert_eq!(ring.dropped_samples(), 0);

        let mut out = Vec::new();
        ring.drain_into(&mut out);
        assert!(out.is_empty(), "a cleared ring owes no silence");
    }
}
