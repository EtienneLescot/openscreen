//! H.264 encoding and MP4 muxing for the captured screen.
//!
//! THE LADDER. Three backends are tried in order and the first one that actually
//! opens wins. "Actually opens" is the whole point: `avcodec_find_encoder_by_name`
//! succeeds for every encoder compiled into the library, including ones this
//! machine's GPU cannot run, so the only honest capability probe is to open the
//! encoder with the real parameters and see what happens.
//!
//!   1. VAAPI   — the broadest hardware path on Linux (AMD, Intel, and NVIDIA
//!                through nvidia-vaapi-driver).
//!   2. Vulkan  — VK_KHR_video_encode_queue. Newer, and on RADV it needs
//!                `RADV_PERFTEST=video_encode`; see [`prepare_environment`].
//!   3. libopenh264 — software. Always available, always last.
//!
//! WHY VAAPI IS GUARDED BY A dlsym. The vendored ffmpeg 8.1 calls `vaMapBuffer2`,
//! which libva only grew in 2.22. On a system with an older libva (Ubuntu 24.04
//! ships 2.20) the call goes through an implib-generated trampoline that does not
//! return an error — it calls `assert(0)` and the process dumps core. A probe
//! that crashes the helper is worse than no probe, so the symbol is checked
//! before libavutil is ever allowed to touch VA-API.

use std::ffi::{CStr, CString};
use std::path::Path;
use std::ptr;

use crate::capture::BYTES_PER_SOURCE_PIXEL;
use crate::ffmpeg as ff;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    Vaapi,
    Vulkan,
    Software,
}

/// Whether the dmabuf → VAAPI zero-copy import may be used for a `forced` encoder
/// choice. The import can only feed VAAPI, so `software`/`vulkan` must skip it —
/// otherwise the documented `OPENSCREEN_LINUX_ENCODER` override is silently
/// ignored on the dmabuf path.
///
/// The SINGLE source of truth for this: the negotiation offer (`prefer_dmabuf` in
/// main) and the importer build (`Capture::start`) both call it, so they cannot
/// drift into offering dmabuf that no importer will consume.
pub fn forced_allows_dmabuf(forced: Option<Backend>) -> bool {
    matches!(forced, None | Some(Backend::Vaapi))
}

impl Backend {
    /// The name the app reports and the tests match on. Kept in the same
    /// vocabulary as the Windows helper's `encoder-selection` event.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Vaapi => "vaapi",
            Self::Vulkan => "vulkan",
            Self::Software => "software",
        }
    }

    fn codec_name(self) -> &'static CStr {
        match self {
            Self::Vaapi => c"h264_vaapi",
            Self::Vulkan => c"h264_vulkan",
            Self::Software => c"libopenh264",
        }
    }

    fn hw_device_type(self) -> Option<ff::AVHWDeviceType> {
        match self {
            Self::Vaapi => Some(ff::AV_HWDEVICE_TYPE_VAAPI),
            Self::Vulkan => Some(ff::AV_HWDEVICE_TYPE_VULKAN),
            Self::Software => None,
        }
    }

    /// The pixel format the codec context takes. Hardware encoders take an
    /// opaque handle; the real pixels live in [`Self::upload_format`].
    fn codec_pixel_format(self) -> ff::AVPixelFormat {
        match self {
            Self::Vaapi => ff::AV_PIX_FMT_VAAPI,
            Self::Vulkan => ff::AV_PIX_FMT_VULKAN,
            Self::Software => ff::AV_PIX_FMT_YUV420P,
        }
    }

    /// What swscale converts the captured RGB into.
    fn upload_format(self) -> ff::AVPixelFormat {
        match self {
            // Every VCN/QuickSync/NVENC block wants NV12; YUV420P would force
            // ffmpeg into an extra internal conversion on upload.
            Self::Vaapi | Self::Vulkan => ff::AV_PIX_FMT_NV12,
            Self::Software => ff::AV_PIX_FMT_YUV420P,
        }
    }
}

/// Order of preference. Public so the probe can be driven from a test or from
/// `OPENSCREEN_LINUX_ENCODER` without duplicating the list.
pub const LADDER: [Backend; 3] = [Backend::Vaapi, Backend::Vulkan, Backend::Software];

/// Must run before anything creates a Vulkan instance — which, in this process,
/// means before the first `av_hwdevice_ctx_create`.
///
/// Mesa gates RADV's video encode queues behind a perf-test flag; without it
/// `h264_vulkan` fails with "Device does not support the VK_KHR_video_encode_queue
/// extension" on hardware that supports it perfectly well. Setting the variable
/// only affects this process, and drivers that do not know it ignore it. An
/// existing value is left alone so a developer can experiment.
pub fn prepare_environment() {
    const KEY: &str = "RADV_PERFTEST";
    match std::env::var(KEY) {
        Ok(existing) if existing.split(',').any(|flag| flag.trim() == "video_encode") => {}
        Ok(existing) if !existing.is_empty() => {
            std::env::set_var(KEY, format!("{existing},video_encode"));
        }
        _ => std::env::set_var(KEY, "video_encode"),
    }
}

/// True when libva is new enough that libavutil's VA-API code will not abort.
///
/// See the module header. This deliberately checks the SYMBOL rather than a
/// version string: the version macro reflects the headers ffmpeg was built
/// against, and what matters is what is loadable here and now.
fn vaapi_is_safe_to_probe() -> bool {
    // SAFETY: dlopen/dlsym with a literal name; every pointer is checked before
    // use and the handle is closed on both paths.
    unsafe {
        let handle = dlopen(c"libva.so.2".as_ptr(), RTLD_LAZY | RTLD_LOCAL);
        if handle.is_null() {
            return false;
        }
        let symbol = dlsym(handle, c"vaMapBuffer2".as_ptr());
        dlclose(handle);
        !symbol.is_null()
    }
}

const RTLD_LAZY: i32 = 1;
const RTLD_LOCAL: i32 = 0;

extern "C" {
    fn dlopen(filename: *const std::ffi::c_char, flags: i32) -> *mut std::ffi::c_void;
    fn dlsym(
        handle: *mut std::ffi::c_void,
        symbol: *const std::ffi::c_char,
    ) -> *mut std::ffi::c_void;
    fn dlclose(handle: *mut std::ffi::c_void) -> i32;
}

pub struct VideoParams {
    pub width: i32,
    pub height: i32,
    pub fps: i32,
    pub bitrate: i64,
}

/// Where the per-frame time actually goes.
///
/// Not debug scaffolding: the capture loop has a hard real-time budget (16.7 ms
/// at 60 fps) and when it is missed the useful question is always *which* of the
/// three stages missed it. Reported on `capture-stopped` so a slow recording on
/// a user's machine is diagnosable without a rebuild. Three `Instant::now()`
/// calls per frame is about 60 ns against a budget four orders of magnitude
/// larger.
#[derive(Debug, Default, Clone, Copy)]
pub struct EncodeStats {
    pub frames: u64,
    /// swscale: captured RGB → NV12/YUV420P in system memory.
    pub convert_ns: u128,
    /// `av_hwframe_transfer_data`: system memory → GPU. Zero for software.
    pub upload_ns: u128,
    /// `avcodec_send_frame` plus draining whatever packets came back.
    pub encode_ns: u128,
}

impl EncodeStats {
    fn mean_ms(total_ns: u128, frames: u64) -> f64 {
        if frames == 0 {
            return 0.0;
        }
        total_ns as f64 / frames as f64 / 1_000_000.0
    }

    pub fn convert_ms(&self) -> f64 {
        Self::mean_ms(self.convert_ns, self.frames)
    }

    pub fn upload_ms(&self) -> f64 {
        Self::mean_ms(self.upload_ns, self.frames)
    }

    pub fn encode_ms(&self) -> f64 {
        Self::mean_ms(self.encode_ns, self.frames)
    }
}

/// Everything the encoder owns, freed in reverse order of acquisition by `Drop`.
pub struct VideoEncoder {
    backend: Backend,
    codec_ctx: *mut ff::AVCodecContext,
    hw_device: *mut ff::AVBufferRef,
    hw_frames: *mut ff::AVBufferRef,
    /// NV12/YUV420P staging in system memory; the target of swscale and the
    /// source of the hardware upload.
    sw_frame: *mut ff::AVFrame,
    /// The GPU-side frame handed to a hardware encoder. Null for software.
    hw_frame: *mut ff::AVFrame,
    /// A ready-to-encode VAAPI NV12 surface produced by the dmabuf importer
    /// (issue #507). When non-null it is sent directly — no sws_scale, no upload —
    /// and held across the clock-driven re-encodes until the next frame replaces
    /// it. Null on the shm/software path.
    hw_staged: *mut ff::AVFrame,
    sws: *mut ff::SwsContext,
    sws_src_format: ff::AVPixelFormat,
    packet: *mut ff::AVPacket,
    params: VideoParams,
    stats: EncodeStats,
    /// Whether `sw_frame` holds a real picture yet.
    staged: bool,
    /// What libswscale reported back after `sws_init_context`, not what we asked
    /// for. Requesting threads and silently getting one is indistinguishable
    /// from threading not helping.
    sws_threads: i64,
}

impl VideoEncoder {
    /// Walks [`LADDER`] and returns the first backend that opens, or every
    /// backend's error if none does.
    ///
    /// `forced` short-circuits the walk — it is how the verification step
    /// compares backends on the same machine, and how a user works around a
    /// driver that opens successfully and then produces garbage.
    pub fn open(
        params: VideoParams,
        forced: Option<Backend>,
        mut on_attempt: impl FnMut(Backend, &str),
    ) -> Result<Self, String> {
        prepare_environment();

        let candidates: Vec<Backend> = match forced {
            Some(backend) => vec![backend],
            None => LADDER.to_vec(),
        };

        let mut failures = Vec::new();
        for backend in candidates {
            if backend == Backend::Vaapi && forced.is_none() && !vaapi_is_safe_to_probe() {
                let reason = "libva.so.2 does not export vaMapBuffer2, so this ffmpeg build \
                              would abort inside VA-API rather than fail cleanly"
                    .to_owned();
                on_attempt(backend, &reason);
                failures.push(format!("{}: {reason}", backend.as_str()));
                continue;
            }
            match Self::open_backend(backend, &params, None) {
                Ok(encoder) => return Ok(encoder),
                Err(error) => {
                    on_attempt(backend, &error);
                    failures.push(format!("{}: {error}", backend.as_str()));
                }
            }
        }

        Err(format!(
            "no H.264 encoder could be opened at {}x{}. Attempts: {}",
            params.width,
            params.height,
            failures.join(" | ")
        ))
    }

    /// Opens the VAAPI encoder to consume surfaces from an EXISTING device and
    /// NV12 frames pool — the ones the dmabuf importer built. Sharing the pool is
    /// what lets `encode_staged` send an imported surface straight to
    /// `avcodec_send_frame` without a copy (issue #507).
    ///
    /// SAFETY: `device` and `frames_ctx` must be a live VAAPI device and an NV12
    /// VAAPI frames context on it; the encoder takes its own references.
    pub unsafe fn open_importing(
        params: VideoParams,
        device: *mut ff::AVBufferRef,
        frames_ctx: *mut ff::AVBufferRef,
    ) -> Result<Self, String> {
        Self::open_backend(Backend::Vaapi, &params, Some((device, frames_ctx)))
    }

    fn open_backend(
        backend: Backend,
        params: &VideoParams,
        external: Option<(*mut ff::AVBufferRef, *mut ff::AVBufferRef)>,
    ) -> Result<Self, String> {
        // SAFETY: this whole function is a single ffmpeg setup sequence. Every
        // allocation is stored in `encoder` as soon as it succeeds, so the Drop
        // impl frees whatever was reached if a later step fails.
        unsafe {
            let codec = ff::avcodec_find_encoder_by_name(backend.codec_name().as_ptr());
            if codec.is_null() {
                return Err(format!(
                    "{} is not compiled into this ffmpeg build",
                    backend.codec_name().to_string_lossy()
                ));
            }

            let codec_ctx = ff::avcodec_alloc_context3(codec);
            if codec_ctx.is_null() {
                return Err("avcodec_alloc_context3 returned null".to_owned());
            }

            let mut encoder = Self {
                backend,
                codec_ctx,
                hw_device: ptr::null_mut(),
                hw_frames: ptr::null_mut(),
                sw_frame: ptr::null_mut(),
                hw_frame: ptr::null_mut(),
                hw_staged: ptr::null_mut(),
                sws: ptr::null_mut(),
                sws_src_format: ff::AV_PIX_FMT_NONE,
                packet: ptr::null_mut(),
                params: VideoParams {
                    width: params.width,
                    height: params.height,
                    fps: params.fps,
                    bitrate: params.bitrate,
                },
                stats: EncodeStats::default(),
                staged: false,
                sws_threads: 0,
            };

            (*codec_ctx).width = params.width;
            (*codec_ctx).height = params.height;
            // Constant frame rate: `time_base` is one frame, so a PTS is simply
            // a frame index. Everything downstream — the muxer, the editor's
            // timeline, the audio interleave — is easier to reason about than it
            // would be with wall-clock timestamps, and duplicated frames of a
            // static screen cost a few hundred bytes each.
            (*codec_ctx).time_base = ff::AVRational { num: 1, den: params.fps };
            (*codec_ctx).framerate = ff::AVRational { num: params.fps, den: 1 };
            (*codec_ctx).pix_fmt = backend.codec_pixel_format();
            (*codec_ctx).bit_rate = params.bitrate;
            // Half a second, not the two seconds a streaming preset would use.
            //
            // This file is an EDITING SOURCE, and the editor scrubs it. Seeking
            // to an arbitrary point means decoding forward from the previous
            // keyframe, so the GOP length is exactly the worst-case scrub cost:
            // at 60 fps a two-second GOP makes the editor decode up to 120
            // frames to show one. Halving it to 30 quarters that, and the extra
            // keyframes cost a few percent of bitrate on screen content, which
            // is mostly static and compresses well anyway.
            (*codec_ctx).gop_size = (params.fps / 2).max(1);
            // No B-frames. A screen recording has no use for them, they add
            // reorder delay, and they force DTS bookkeeping the muxer would
            // otherwise not need.
            (*codec_ctx).max_b_frames = 0;
            // The muxer needs an extradata-carrying global header for MP4.
            (*codec_ctx).flags |= ff::AV_CODEC_FLAG_GLOBAL_HEADER as i32;

            if let Some(device_type) = backend.hw_device_type() {
                encoder.attach_hardware(device_type, params, external)?;
            }

            let opened = ff::avcodec_open2(codec_ctx, codec, ptr::null_mut());
            if opened < 0 {
                return Err(format!("avcodec_open2: {}", ff::err_to_string(opened)));
            }

            encoder.packet = ff::av_packet_alloc();
            if encoder.packet.is_null() {
                return Err("av_packet_alloc returned null".to_owned());
            }

            encoder.alloc_software_frame(backend, params)?;
            if backend.hw_device_type().is_some() {
                encoder.hw_frame = ff::av_frame_alloc();
                if encoder.hw_frame.is_null() {
                    return Err("av_frame_alloc returned null".to_owned());
                }
            }

            Ok(encoder)
        }
    }

    /// SAFETY: called only from `open_backend`, with `self.codec_ctx` valid.
    unsafe fn attach_hardware(
        &mut self,
        device_type: ff::AVHWDeviceType,
        params: &VideoParams,
        external: Option<(*mut ff::AVBufferRef, *mut ff::AVBufferRef)>,
    ) -> Result<(), String> {
        // The dmabuf importer already built a VAAPI device and an NV12 pool; the
        // encoder must consume from THAT pool, so take references to it instead of
        // creating a second, incompatible one. See `open_importing`.
        if let Some((device, frames_ctx)) = external {
            // The guard belongs on the INPUTS, before the refs are taken:
            // av_buffer_ref dereferences its argument (`*ret = *buf`), so a null
            // one faults inside ffmpeg instead of coming back as a null return
            // value the old check could inspect. And null IS reachable here --
            // `DmabufImporter::output_frames_ctx` is av_buffersink_get_hw_frames_ctx,
            // which returns NULL whenever the sink's input link carries no hw
            // frames context.
            if device.is_null() || frames_ctx.is_null() {
                return Err("av_buffer_ref on the shared VAAPI context returned null".to_owned());
            }
            self.hw_device = ff::av_buffer_ref(device);
            self.hw_frames = ff::av_buffer_ref(frames_ctx);
            // The results still get checked: av_buffer_ref allocates, and the
            // hw_frames_ctx ref below would dereference whatever it handed back.
            if self.hw_device.is_null() || self.hw_frames.is_null() {
                return Err("av_buffer_ref on the shared VAAPI context returned null".to_owned());
            }
            (*self.codec_ctx).hw_frames_ctx = ff::av_buffer_ref(self.hw_frames);
            if (*self.codec_ctx).hw_frames_ctx.is_null() {
                return Err("av_buffer_ref on the shared frames context returned null".to_owned());
            }
            return Ok(());
        }

        let created = ff::av_hwdevice_ctx_create(
            &mut self.hw_device,
            device_type,
            ptr::null(),
            ptr::null_mut(),
            0,
        );
        if created < 0 {
            return Err(format!(
                "av_hwdevice_ctx_create: {}",
                ff::err_to_string(created)
            ));
        }

        self.hw_frames = ff::av_hwframe_ctx_alloc(self.hw_device);
        if self.hw_frames.is_null() {
            return Err("av_hwframe_ctx_alloc returned null".to_owned());
        }
        let frames_ctx = (*self.hw_frames).data as *mut ff::AVHWFramesContext;
        (*frames_ctx).format = self.backend.codec_pixel_format();
        (*frames_ctx).sw_format = self.backend.upload_format();
        (*frames_ctx).width = params.width;
        (*frames_ctx).height = params.height;
        // Enough surfaces that the encoder can hold a few references while we
        // are filling the next one. Too small a pool stalls; too large just
        // wastes VRAM.
        (*frames_ctx).initial_pool_size = 8;

        let initialised = ff::av_hwframe_ctx_init(self.hw_frames);
        if initialised < 0 {
            return Err(format!(
                "av_hwframe_ctx_init: {}",
                ff::err_to_string(initialised)
            ));
        }

        (*self.codec_ctx).hw_frames_ctx = ff::av_buffer_ref(self.hw_frames);
        if (*self.codec_ctx).hw_frames_ctx.is_null() {
            return Err("av_buffer_ref on the frames context returned null".to_owned());
        }
        Ok(())
    }

    /// SAFETY: called only from `open_backend`.
    unsafe fn alloc_software_frame(
        &mut self,
        backend: Backend,
        params: &VideoParams,
    ) -> Result<(), String> {
        self.sw_frame = ff::av_frame_alloc();
        if self.sw_frame.is_null() {
            return Err("av_frame_alloc returned null".to_owned());
        }
        (*self.sw_frame).format = backend.upload_format();
        (*self.sw_frame).width = params.width;
        (*self.sw_frame).height = params.height;
        let allocated = ff::av_frame_get_buffer(self.sw_frame, 0);
        if allocated < 0 {
            return Err(format!(
                "av_frame_get_buffer: {}",
                ff::err_to_string(allocated)
            ));
        }
        Ok(())
    }

    pub fn backend(&self) -> Backend {
        self.backend
    }

    /// Borrows the opened codec context so the muxer can copy its parameters.
    pub fn codec_context(&self) -> *mut ff::AVCodecContext {
        self.codec_ctx
    }

    /// Converts one captured RGB frame into the staging buffer, without encoding
    /// it.
    ///
    /// Split from [`Self::encode_staged`] so that a screen which stops changing
    /// still produces frames: the capture writes at a constant rate, and holding
    /// the last picture costs an upload and an encode but no conversion, which
    /// is where three quarters of the per-frame time goes.
    ///
    /// `src_format` is whatever PipeWire negotiated; the swscale context is
    /// rebuilt if it ever changes, which it should not mid-stream.
    pub fn stage(
        &mut self,
        pixels: &[u8],
        stride: usize,
        src_format: ff::AVPixelFormat,
    ) -> Result<(), String> {
        // The LAST row needs only its own pixels, not a further stride's worth of
        // padding. Demanding `stride * height` rejected exactly the frames a
        // window crop produces: `pixels` there starts partway into the buffer, so
        // the tail is short by the offset even though every row is complete.
        let needed = stride
            .checked_mul(self.params.height.saturating_sub(1) as usize)
            .and_then(|rows| {
                rows.checked_add(self.params.width as usize * BYTES_PER_SOURCE_PIXEL)
            })
            .ok_or_else(|| "frame size overflows".to_owned())?;
        if pixels.len() < needed {
            return Err(format!(
                "captured frame is truncated: {} bytes for {} rows of {} px at stride {stride}",
                pixels.len(),
                self.params.height,
                self.params.width
            ));
        }

        // SAFETY: the slice was just bounds-checked against the geometry we hand
        // to swscale, and every ffmpeg pointer below is owned by `self`.
        unsafe {
            self.ensure_sws(src_format)?;

            // The staging frame is reused every frame; ffmpeg requires it be
            // writable before we scribble into it, which matters once the
            // encoder starts holding references to earlier frames.
            let writable = ff::av_frame_make_writable(self.sw_frame);
            if writable < 0 {
                return Err(format!(
                    "av_frame_make_writable: {}",
                    ff::err_to_string(writable)
                ));
            }

            let src_data = [pixels.as_ptr(), ptr::null(), ptr::null(), ptr::null()];
            let src_stride = [stride as i32, 0, 0, 0];
            let convert_started = std::time::Instant::now();
            let scaled = ff::sws_scale(
                self.sws,
                src_data.as_ptr(),
                src_stride.as_ptr(),
                0,
                self.params.height,
                (*self.sw_frame).data.as_mut_ptr(),
                (*self.sw_frame).linesize.as_mut_ptr(),
            );
            self.stats.convert_ns += convert_started.elapsed().as_nanos();
            if scaled < 0 {
                return Err(format!("sws_scale: {}", ff::err_to_string(scaled)));
            }
            // This CPU frame is now what `encode_staged` must send, so drop any hw
            // surface a previous dmabuf frame left staged — e.g. after the stream
            // renegotiates to a modifier-less format and frames start arriving on
            // the sws path. `encode_staged` prefers `hw_staged` whenever it is
            // non-null, so without this it would keep re-sending that stale surface
            // and freeze the video. `av_frame_free` nulls the pointer.
            if !self.hw_staged.is_null() {
                ff::av_frame_free(&mut self.hw_staged);
            }
            self.staged = true;
        }
        Ok(())
    }

    /// Stages a ready VAAPI NV12 surface produced by the dmabuf importer. Takes
    /// ownership of `frame`; the previous one is released. Unlike [`Self::stage`]
    /// there is no conversion or upload — the surface is encoded as-is and held
    /// across the clock-driven re-encodes until the next frame replaces it.
    ///
    /// SAFETY: `frame` must be a valid VAAPI NV12 `AVFrame` from the shared pool
    /// the encoder was opened against (see `open_importing`).
    pub unsafe fn stage_hw(&mut self, frame: *mut ff::AVFrame) {
        if !self.hw_staged.is_null() {
            let mut old = self.hw_staged;
            ff::av_frame_free(&mut old);
        }
        self.hw_staged = frame;
        self.staged = true;
    }

    /// True once a picture has been staged — via [`Self::stage`] (shm/software)
    /// or [`Self::stage_hw`] (dmabuf). Before that there is nothing to encode.
    pub fn has_staged_frame(&self) -> bool {
        self.staged
    }

    /// Encodes whatever is currently staged at `pts` (a frame index).
    ///
    /// Called once per staged frame and then once more per frame of a static
    /// screen, which is what holds the constant frame rate.
    pub fn encode_staged(
        &mut self,
        pts: i64,
        mut on_packet: impl FnMut(*mut ff::AVPacket) -> Result<(), String>,
    ) -> Result<(), String> {
        if !self.staged {
            return Err("encode_staged called before any frame was staged".to_owned());
        }
        // SAFETY: `staged` is only set after a successful sws_scale into
        // `sw_frame`, and every pointer below is owned by `self`.
        unsafe {
            let upload_started = std::time::Instant::now();
            let mut used_upload = false;
            let frame = if !self.hw_staged.is_null() {
                // Imported dmabuf surface: already NV12 on the GPU. No upload, no
                // conversion — just timestamp it. Held for the next re-encode.
                (*self.hw_staged).pts = pts;
                self.hw_staged
            } else if self.hw_frames.is_null() {
                (*self.sw_frame).pts = pts;
                self.sw_frame
            } else {
                let got = ff::av_hwframe_get_buffer(self.hw_frames, self.hw_frame, 0);
                if got < 0 {
                    return Err(format!(
                        "av_hwframe_get_buffer: {}",
                        ff::err_to_string(got)
                    ));
                }
                let transferred = ff::av_hwframe_transfer_data(self.hw_frame, self.sw_frame, 0);
                if transferred < 0 {
                    return Err(format!(
                        "av_hwframe_transfer_data: {}",
                        ff::err_to_string(transferred)
                    ));
                }
                (*self.hw_frame).pts = pts;
                used_upload = true;
                self.hw_frame
            };
            self.stats.upload_ns += upload_started.elapsed().as_nanos();

            let encode_started = std::time::Instant::now();
            self.send_and_drain(frame, &mut on_packet)?;
            self.stats.encode_ns += encode_started.elapsed().as_nanos();
            self.stats.frames += 1;

            if used_upload {
                // Release our reference to the per-encode upload surface; the
                // encoder keeps its own for as long as it needs one. Without this
                // the pool drains after `initial_pool_size` frames and every
                // subsequent av_hwframe_get_buffer blocks. The imported
                // `hw_staged` surface is NOT released here — it is held for the
                // next clock-driven re-encode and freed in `stage_hw`/`Drop`.
                ff::av_frame_unref(self.hw_frame);
            }
        }
        Ok(())
    }

    /// [`Self::stage`] then [`Self::encode_staged`], for callers with nothing to
    /// gain from the split.
    pub fn submit(
        &mut self,
        pixels: &[u8],
        stride: usize,
        src_format: ff::AVPixelFormat,
        pts: i64,
        on_packet: impl FnMut(*mut ff::AVPacket) -> Result<(), String>,
    ) -> Result<(), String> {
        self.stage(pixels, stride, src_format)?;
        self.encode_staged(pts, on_packet)
    }

    /// Flushes the encoder. Call once, at stop.
    pub fn finish(
        &mut self,
        mut on_packet: impl FnMut(*mut ff::AVPacket) -> Result<(), String>,
    ) -> Result<(), String> {
        // SAFETY: a null frame is how ffmpeg is told to drain.
        unsafe { self.send_and_drain(ptr::null_mut(), &mut on_packet) }
    }

    /// SAFETY: `frame` is either null (drain) or a frame this encoder owns.
    unsafe fn send_and_drain(
        &mut self,
        frame: *mut ff::AVFrame,
        on_packet: &mut impl FnMut(*mut ff::AVPacket) -> Result<(), String>,
    ) -> Result<(), String> {
        let sent = ff::avcodec_send_frame(self.codec_ctx, frame);
        if sent < 0 && sent != ff::AVERROR_EOF {
            return Err(format!("avcodec_send_frame: {}", ff::err_to_string(sent)));
        }

        loop {
            let received = ff::avcodec_receive_packet(self.codec_ctx, self.packet);
            if received == ff::AVERROR_EAGAIN || received == ff::AVERROR_EOF {
                return Ok(());
            }
            if received < 0 {
                return Err(format!(
                    "avcodec_receive_packet: {}",
                    ff::err_to_string(received)
                ));
            }
            let result = on_packet(self.packet);
            ff::av_packet_unref(self.packet);
            result?;
        }
    }

    /// SAFETY: called with `self` valid; rebuilds `self.sws` when the source
    /// format changes.
    unsafe fn ensure_sws(&mut self, src_format: ff::AVPixelFormat) -> Result<(), String> {
        if !self.sws.is_null() && self.sws_src_format == src_format {
            return Ok(());
        }
        if !self.sws.is_null() {
            ff::sws_freeContext(self.sws);
            self.sws = ptr::null_mut();
        }
        // Built through the option API rather than `sws_getContext` so that
        // `threads` can be set at all — `sws_getContext` has no way to express
        // it. It is set to 1 by default; see [`sws_thread_count`] for the
        // measurement behind that.
        //
        // Source and destination are the same size, so no resampling filter is
        // involved and the cheapest kernel is the right one: this is a pure
        // colour-space conversion, and a bilinear kernel would cost more for
        // pixels it never moves.
        self.sws = ff::sws_alloc_context();
        if self.sws.is_null() {
            return Err("sws_alloc_context returned null".to_owned());
        }
        let dst_format = self.backend.upload_format();
        let options: [(&CStr, i64); 8] = [
            (c"srcw", self.params.width as i64),
            (c"srch", self.params.height as i64),
            (c"src_format", src_format as i64),
            (c"dstw", self.params.width as i64),
            (c"dsth", self.params.height as i64),
            (c"dst_format", dst_format as i64),
            (c"sws_flags", ff::SWS_POINT as i64),
            (c"threads", sws_thread_count() as i64),
        ];
        for (name, value) in options {
            let set = ff::av_opt_set_int(self.sws.cast(), name.as_ptr(), value, 0);
            if set < 0 {
                return Err(format!(
                    "av_opt_set_int({}, {value}): {}",
                    name.to_string_lossy(),
                    ff::err_to_string(set)
                ));
            }
        }
        let initialised = ff::sws_init_context(self.sws, ptr::null_mut(), ptr::null_mut());
        if initialised < 0 {
            return Err(format!(
                "sws_init_context could not convert pixel format {src_format} to {dst_format}: {}",
                ff::err_to_string(initialised)
            ));
        }
        // Read back rather than assume: libswscale is free to ignore a thread
        // count it cannot use for a given conversion, and a request that was
        // silently dropped looks exactly like threading that did not help.
        let mut granted = 0i64;
        if ff::av_opt_get_int(self.sws.cast(), c"threads".as_ptr(), 0, &mut granted) >= 0 {
            self.sws_threads = granted;
        }
        self.sws_src_format = src_format;
        Ok(())
    }

    pub fn stats(&self) -> EncodeStats {
        self.stats
    }

    /// Threads libswscale actually granted, once a frame has been submitted.
    pub fn sws_threads(&self) -> i64 {
        self.sws_threads
    }
}

impl Drop for VideoEncoder {
    fn drop(&mut self) {
        // SAFETY: every pointer is either null or owned by this struct, and each
        // free function tolerates a pointer-to-null.
        unsafe {
            if !self.sws.is_null() {
                ff::sws_freeContext(self.sws);
            }
            if !self.packet.is_null() {
                ff::av_packet_free(&mut self.packet);
            }
            if !self.hw_frame.is_null() {
                ff::av_frame_free(&mut self.hw_frame);
            }
            if !self.hw_staged.is_null() {
                ff::av_frame_free(&mut self.hw_staged);
            }
            if !self.sw_frame.is_null() {
                ff::av_frame_free(&mut self.sw_frame);
            }
            if !self.codec_ctx.is_null() {
                ff::avcodec_free_context(&mut self.codec_ctx);
            }
            if !self.hw_frames.is_null() {
                ff::av_buffer_unref(&mut self.hw_frames);
            }
            if !self.hw_device.is_null() {
                ff::av_buffer_unref(&mut self.hw_device);
            }
        }
    }
}

/// Sample rate every audio track is captured and encoded at. PipeWire's stream
/// adapter converts whatever the device runs at, so this is a free choice, and
/// 48 kHz is what the rest of the pipeline (and MP4) expects.
pub const AUDIO_SAMPLE_RATE: i32 = 48_000;
pub const AUDIO_CHANNELS: usize = 2;

/// One AAC track, fed interleaved stereo f32.
///
/// AAC encodes in fixed blocks (1024 samples per channel), but PipeWire delivers
/// whatever quantum the graph is running — 512, 1024, 2048, and it changes at
/// runtime. So samples accumulate here until a full block exists rather than the
/// caller having to buffer.
pub struct AudioEncoder {
    codec_ctx: *mut ff::AVCodecContext,
    frame: *mut ff::AVFrame,
    packet: *mut ff::AVPacket,
    /// Interleaved samples not yet forming a whole AAC block.
    pending: Vec<f32>,
    /// Samples per channel in one block.
    block: usize,
    /// Presentation time of the next block, counted in samples — which is
    /// exactly the codec's time base, so no rounding accumulates.
    next_pts: i64,
}

impl AudioEncoder {
    pub fn open(bitrate: i64) -> Result<Self, String> {
        // SAFETY: an ffmpeg setup sequence; every allocation is stored in
        // `encoder` as soon as it succeeds so Drop can free it.
        unsafe {
            let codec = ff::avcodec_find_encoder_by_name(c"aac".as_ptr());
            if codec.is_null() {
                return Err("the vendored ffmpeg has no AAC encoder".to_owned());
            }
            let codec_ctx = ff::avcodec_alloc_context3(codec);
            if codec_ctx.is_null() {
                return Err("avcodec_alloc_context3 returned null".to_owned());
            }
            let mut encoder = Self {
                codec_ctx,
                frame: ptr::null_mut(),
                packet: ptr::null_mut(),
                pending: Vec::new(),
                block: 0,
                next_pts: 0,
            };

            (*codec_ctx).sample_rate = AUDIO_SAMPLE_RATE;
            // The native AAC encoder takes PLANAR float; interleaved is rejected
            // outright by avcodec_open2, which is why `push` deinterleaves.
            (*codec_ctx).sample_fmt = ff::AV_SAMPLE_FMT_FLTP;
            (*codec_ctx).bit_rate = bitrate;
            (*codec_ctx).time_base = ff::AVRational { num: 1, den: AUDIO_SAMPLE_RATE };
            ff::av_channel_layout_default(&mut (*codec_ctx).ch_layout, AUDIO_CHANNELS as i32);
            (*codec_ctx).flags |= ff::AV_CODEC_FLAG_GLOBAL_HEADER as i32;

            let opened = ff::avcodec_open2(codec_ctx, codec, ptr::null_mut());
            if opened < 0 {
                return Err(format!("aac avcodec_open2: {}", ff::err_to_string(opened)));
            }
            // Only valid after open: the encoder decides its own block size.
            encoder.block = match (*codec_ctx).frame_size {
                size if size > 0 => size as usize,
                _ => 1024,
            };

            encoder.packet = ff::av_packet_alloc();
            encoder.frame = ff::av_frame_alloc();
            if encoder.packet.is_null() || encoder.frame.is_null() {
                return Err("av_packet_alloc/av_frame_alloc returned null".to_owned());
            }
            (*encoder.frame).format = ff::AV_SAMPLE_FMT_FLTP as i32;
            (*encoder.frame).nb_samples = encoder.block as i32;
            (*encoder.frame).sample_rate = AUDIO_SAMPLE_RATE;
            ff::av_channel_layout_default(
                &mut (*encoder.frame).ch_layout,
                AUDIO_CHANNELS as i32,
            );
            let allocated = ff::av_frame_get_buffer(encoder.frame, 0);
            if allocated < 0 {
                return Err(format!(
                    "audio av_frame_get_buffer: {}",
                    ff::err_to_string(allocated)
                ));
            }

            Ok(encoder)
        }
    }

    pub fn codec_context(&self) -> *mut ff::AVCodecContext {
        self.codec_ctx
    }

    /// Feeds interleaved stereo samples, encoding every whole block they complete.
    pub fn push(
        &mut self,
        interleaved: &[f32],
        mut on_packet: impl FnMut(*mut ff::AVPacket) -> Result<(), String>,
    ) -> Result<(), String> {
        self.pending.extend_from_slice(interleaved);
        let per_block = self.block * AUDIO_CHANNELS;
        while self.pending.len() >= per_block {
            // SAFETY: the frame was allocated for exactly `block` samples per
            // channel, and `pending` has been checked to hold a whole block.
            unsafe { self.encode_block(per_block, &mut on_packet)? };
        }
        Ok(())
    }

    /// SAFETY: `self.pending` must hold at least `per_block` samples.
    unsafe fn encode_block(
        &mut self,
        per_block: usize,
        on_packet: &mut impl FnMut(*mut ff::AVPacket) -> Result<(), String>,
    ) -> Result<(), String> {
        let writable = ff::av_frame_make_writable(self.frame);
        if writable < 0 {
            return Err(format!(
                "audio av_frame_make_writable: {}",
                ff::err_to_string(writable)
            ));
        }
        // Interleaved LRLRLR… in, one contiguous plane per channel out.
        for channel in 0..AUDIO_CHANNELS {
            let plane = (*self.frame).data[channel] as *mut f32;
            for sample in 0..self.block {
                *plane.add(sample) = self.pending[sample * AUDIO_CHANNELS + channel];
            }
        }
        (*self.frame).pts = self.next_pts;
        self.next_pts += self.block as i64;
        self.pending.drain(..per_block);

        self.send_and_drain(self.frame, on_packet)
    }

    /// Pads any partial block with silence, encodes it, and flushes.
    pub fn finish(
        &mut self,
        mut on_packet: impl FnMut(*mut ff::AVPacket) -> Result<(), String>,
    ) -> Result<(), String> {
        // SAFETY: padding only grows `pending` to exactly one block, which is
        // what encode_block requires; a null frame is how ffmpeg is drained.
        unsafe {
            if !self.pending.is_empty() {
                let per_block = self.block * AUDIO_CHANNELS;
                self.pending.resize(per_block, 0.0);
                self.encode_block(per_block, &mut on_packet)?;
            }
            self.send_and_drain(ptr::null_mut(), &mut on_packet)
        }
    }

    /// SAFETY: `frame` is either null (drain) or the frame this encoder owns.
    unsafe fn send_and_drain(
        &mut self,
        frame: *mut ff::AVFrame,
        on_packet: &mut impl FnMut(*mut ff::AVPacket) -> Result<(), String>,
    ) -> Result<(), String> {
        let sent = ff::avcodec_send_frame(self.codec_ctx, frame);
        if sent < 0 && sent != ff::AVERROR_EOF {
            return Err(format!("aac avcodec_send_frame: {}", ff::err_to_string(sent)));
        }
        loop {
            let received = ff::avcodec_receive_packet(self.codec_ctx, self.packet);
            if received == ff::AVERROR_EAGAIN || received == ff::AVERROR_EOF {
                return Ok(());
            }
            if received < 0 {
                return Err(format!(
                    "aac avcodec_receive_packet: {}",
                    ff::err_to_string(received)
                ));
            }
            let result = on_packet(self.packet);
            ff::av_packet_unref(self.packet);
            result?;
        }
    }
}

impl Drop for AudioEncoder {
    fn drop(&mut self) {
        // SAFETY: every pointer is either null or owned here.
        unsafe {
            if !self.packet.is_null() {
                ff::av_packet_free(&mut self.packet);
            }
            if !self.frame.is_null() {
                ff::av_frame_free(&mut self.frame);
            }
            if !self.codec_ctx.is_null() {
                ff::avcodec_free_context(&mut self.codec_ctx);
            }
        }
    }
}

/// Identifies a track added with [`Muxer::add_stream`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrackId(usize);

struct MuxTrack {
    /// libavformat's own stream index, which need not equal our `TrackId`.
    index: i32,
    /// The time base packets arrive in.
    source_time_base: ff::AVRational,
    /// The time base libavformat CHOSE, which is what they must be rescaled to.
    stream_time_base: ff::AVRational,
}

/// An MP4 writer, taking however many streams [`Self::add_stream`] is called for.
///
/// WHAT A RECORDING ACTUALLY USES IS TWO: one H.264 video stream and one AAC
/// track carrying system audio and the microphone already mixed together
/// (`AudioMix` in crate::capture). This wrote them as two separate audio tracks
/// once, matching what the macOS helper did, on the grounds that the export path
/// mixes every track it finds (crates/compositor/src/audio.rs). The preview does
/// not: it is an HTML5 `<video>`, which plays the default audio track and cannot
/// be told to switch, because Chromium implements no `audioTracks` API — so a
/// take with silent system audio played silence while the microphone sat in a
/// track nothing would ever select. Mixing before the muxer is what fixed it,
/// and it also removes the question of reconciling two capture clocks in the
/// container: there is only one audio timeline now, built in `AudioMix::pump`.
///
/// `+faststart` is not used: it rewrites the whole file on close, which on a
/// long recording means copying gigabytes. The moov atom is written at the end
/// as usual, and the app reads these files locally, where a trailing moov costs
/// nothing. This is the difference from the WebM path, which had NO index at all
/// and could not be seeked even locally (see electron/recording/webm-seek-index.ts).
pub struct Muxer {
    fmt: *mut ff::AVFormatContext,
    tracks: Vec<MuxTrack>,
    header_written: bool,
}

impl Muxer {
    /// Allocates the output and opens the file. No stream exists yet: add them
    /// all with [`Self::add_stream`], then call [`Self::write_header`].
    pub fn create(path: &Path) -> Result<Self, String> {
        let path_c = CString::new(path.as_os_str().as_encoded_bytes())
            .map_err(|_| "output path contains a NUL byte".to_owned())?;

        // SAFETY: standard libavformat output setup; `fmt` is stored before any
        // fallible step so Drop can clean up.
        unsafe {
            let mut fmt: *mut ff::AVFormatContext = ptr::null_mut();
            let allocated = ff::avformat_alloc_output_context2(
                &mut fmt,
                ptr::null_mut(),
                c"mp4".as_ptr(),
                path_c.as_ptr(),
            );
            if allocated < 0 || fmt.is_null() {
                return Err(format!(
                    "avformat_alloc_output_context2: {}",
                    ff::err_to_string(allocated)
                ));
            }

            let muxer = Self { fmt, tracks: Vec::new(), header_written: false };

            let opened = ff::avio_open(&mut (*fmt).pb, path_c.as_ptr(), ff::AVIO_FLAG_WRITE as i32);
            if opened < 0 {
                return Err(format!(
                    "avio_open({}): {}",
                    path.display(),
                    ff::err_to_string(opened)
                ));
            }

            Ok(muxer)
        }
    }

    /// Adds a track fed by `codec_ctx`. Every track must be added before
    /// [`Self::write_header`]: MP4 fixes its track list in the header.
    pub fn add_stream(&mut self, codec_ctx: *mut ff::AVCodecContext) -> Result<TrackId, String> {
        if self.header_written {
            return Err("a stream cannot be added after the header is written".to_owned());
        }
        // SAFETY: `codec_ctx` is an opened context owned by the caller, and
        // `fmt` is ours.
        unsafe {
            let stream = ff::avformat_new_stream(self.fmt, ptr::null());
            if stream.is_null() {
                return Err("avformat_new_stream returned null".to_owned());
            }
            let source_time_base = (*codec_ctx).time_base;
            (*stream).time_base = source_time_base;
            let copied = ff::avcodec_parameters_from_context((*stream).codecpar, codec_ctx);
            if copied < 0 {
                return Err(format!(
                    "avcodec_parameters_from_context: {}",
                    ff::err_to_string(copied)
                ));
            }
            self.tracks.push(MuxTrack {
                index: (*stream).index,
                source_time_base,
                // Filled in by write_header, which is free to change it.
                stream_time_base: source_time_base,
            });
            Ok(TrackId(self.tracks.len() - 1))
        }
    }

    pub fn write_header(&mut self) -> Result<(), String> {
        if self.tracks.is_empty() {
            return Err("the output has no streams".to_owned());
        }
        // SAFETY: `fmt` is ours and every stream was added through add_stream.
        unsafe {
            let header = ff::avformat_write_header(self.fmt, ptr::null_mut());
            if header < 0 {
                return Err(format!(
                    "avformat_write_header: {}",
                    ff::err_to_string(header)
                ));
            }
            self.header_written = true;
            // libavformat may have rewritten a stream's time base while writing
            // the header (MP4 prefers 1/90000-style bases for video and the
            // sample rate for audio). Everything after this must rescale into
            // the value it CHOSE, not the value we asked for — using ours
            // produces a file whose duration is wrong by the ratio between them.
            for track in &mut self.tracks {
                let stream = *(*self.fmt).streams.add(track.index as usize);
                track.stream_time_base = (*stream).time_base;
            }
        }
        Ok(())
    }

    /// Writes one encoded packet, rescaling it out of its encoder's time base.
    pub fn write(&mut self, track: TrackId, packet: *mut ff::AVPacket) -> Result<(), String> {
        let Some(track) = self.tracks.get(track.0) else {
            return Err("packet written to a track that was never added".to_owned());
        };
        // SAFETY: `packet` comes from the encoder this track was added for, and
        // is valid until the caller unrefs it.
        unsafe {
            (*packet).stream_index = track.index;
            ff::av_packet_rescale_ts(packet, track.source_time_base, track.stream_time_base);
            let written = ff::av_interleaved_write_frame(self.fmt, packet);
            if written < 0 {
                return Err(format!(
                    "av_interleaved_write_frame: {}",
                    ff::err_to_string(written)
                ));
            }
        }
        Ok(())
    }

    /// Writes the trailer and closes the file. Consuming `self` makes it a
    /// compile error to write another packet afterwards.
    pub fn finish(mut self) -> Result<(), String> {
        // SAFETY: `fmt` is valid and the header was written, which is what
        // av_write_trailer requires.
        unsafe {
            let written = ff::av_write_trailer(self.fmt);
            self.header_written = false;
            if written < 0 {
                return Err(format!("av_write_trailer: {}", ff::err_to_string(written)));
            }
        }
        Ok(())
    }
}

impl Drop for Muxer {
    fn drop(&mut self) {
        // SAFETY: `fmt` is either null or ours. `header_written` is still true
        // only on the error path — `finish` clears it — and a file left without
        // its trailer would be unplayable, so write one on the way out.
        unsafe {
            if self.fmt.is_null() {
                return;
            }
            if self.header_written {
                ff::av_write_trailer(self.fmt);
            }
            if !(*self.fmt).pb.is_null() {
                ff::avio_closep(&mut (*self.fmt).pb);
            }
            ff::avformat_free_context(self.fmt);
            self.fmt = ptr::null_mut();
        }
    }
}

/// Threads to give libswscale. One, by measurement.
///
/// BGRA→NV12 at 1920×1080 was timed at 3.80 ms/frame with one thread and
/// 3.84 ms with eight, on an 8-thread Radeon 610M APU. The request is not being
/// ignored — [`VideoEncoder::sws_threads`] reads the granted count back out of
/// libswscale and it matches — the conversion is simply memory-bandwidth bound,
/// and extra threads contend for the same bandwidth instead of adding any.
/// Spawning eight threads per recording to gain 1% of nothing is not worth the
/// scheduler churn on a machine that is simultaneously compositing the screen
/// being captured.
///
/// The override exists because that measurement is one machine at one
/// resolution; a 4K capture on a many-core desktop with more memory channels may
/// well behave differently, and this makes checking it a one-liner.
fn sws_thread_count() -> usize {
    if let Ok(raw) = std::env::var("OPENSCREEN_LINUX_SWS_THREADS") {
        if let Ok(count) = raw.trim().parse::<usize>() {
            return count.clamp(1, 32);
        }
    }
    1
}

/// Parses `OPENSCREEN_LINUX_ENCODER`. Returns `None` when unset, which means
/// "walk the ladder".
pub fn forced_backend_from_env() -> Result<Option<Backend>, String> {
    let Ok(raw) = std::env::var("OPENSCREEN_LINUX_ENCODER") else {
        return Ok(None);
    };
    match raw.trim().to_ascii_lowercase().as_str() {
        "" | "auto" => Ok(None),
        "vaapi" => Ok(Some(Backend::Vaapi)),
        "vulkan" => Ok(Some(Backend::Vulkan)),
        "software" | "openh264" | "libopenh264" => Ok(Some(Backend::Software)),
        other => Err(format!(
            "OPENSCREEN_LINUX_ENCODER={other} is not one of auto, vaapi, vulkan, software"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_ladder_entry_names_a_codec_this_build_has() {
        // Catches a vendored-ffmpeg swap that drops an encoder we depend on:
        // without this the loss shows up only as a silent fall through to
        // software on a user's machine.
        for backend in LADDER {
            // SAFETY: a lookup by name against a static string.
            let codec = unsafe { ff::avcodec_find_encoder_by_name(backend.codec_name().as_ptr()) };
            assert!(
                !codec.is_null(),
                "{} is missing from the vendored ffmpeg",
                backend.codec_name().to_string_lossy()
            );
        }
    }

    #[test]
    fn software_always_opens() {
        // The bottom of the ladder is the one rung that must never fail, on any
        // machine, with no GPU at all.
        let encoder = VideoEncoder::open(
            VideoParams { width: 320, height: 240, fps: 30, bitrate: 1_000_000 },
            Some(Backend::Software),
            |_, _| {},
        )
        .expect("libopenh264 must open");
        assert_eq!(encoder.backend(), Backend::Software);
    }

    #[test]
    fn software_encodes_a_frame_into_packets() {
        let mut encoder = VideoEncoder::open(
            VideoParams { width: 320, height: 240, fps: 30, bitrate: 1_000_000 },
            Some(Backend::Software),
            |_, _| {},
        )
        .expect("open");
        let stride = 320 * 4;
        let pixels = vec![0x40u8; stride * 240];
        let mut packets = 0;
        for pts in 0..10 {
            encoder
                .submit(&pixels, stride, ff::AV_PIX_FMT_BGRA, pts, |_| {
                    packets += 1;
                    Ok(())
                })
                .expect("submit");
        }
        encoder
            .finish(|_| {
                packets += 1;
                Ok(())
            })
            .expect("finish");
        assert!(packets > 0, "encoder produced no packets at all");
    }

    #[test]
    fn a_truncated_frame_is_refused_rather_than_read_past() {
        let mut encoder = VideoEncoder::open(
            VideoParams { width: 320, height: 240, fps: 30, bitrate: 1_000_000 },
            Some(Backend::Software),
            |_, _| {},
        )
        .expect("open");
        let error = encoder
            .submit(&[0u8; 16], 320 * 4, ff::AV_PIX_FMT_BGRA, 0, |_| Ok(()))
            .expect_err("must refuse");
        assert!(error.contains("truncated"), "{error}");
    }

    #[test]
    fn forced_backend_parsing_rejects_typos_instead_of_falling_back() {
        std::env::set_var("OPENSCREEN_LINUX_ENCODER", "vulcan");
        let error = forced_backend_from_env().expect_err("must reject");
        assert!(error.contains("vulcan"), "{error}");
        std::env::set_var("OPENSCREEN_LINUX_ENCODER", "vaapi");
        assert_eq!(forced_backend_from_env().unwrap(), Some(Backend::Vaapi));
        std::env::remove_var("OPENSCREEN_LINUX_ENCODER");
        assert_eq!(forced_backend_from_env().unwrap(), None);
    }

    /// The whole pipeline — ladder, encode, mux — against a real file, with no
    /// portal and no compositor involved.
    ///
    /// Opt-in via `OPENSCREEN_LINUX_ENCODE_TEST=1` because it depends on the
    /// GPU: on this hardware it selects Vulkan, on a headless CI box it falls
    /// through to software, and both are correct. Run it after any change to the
    /// ladder, and read the printed backend — that line is the measurement.
    #[test]
    fn ladder_encodes_a_playable_mp4() {
        if std::env::var("OPENSCREEN_LINUX_ENCODE_TEST").is_err() {
            eprintln!("skipped: set OPENSCREEN_LINUX_ENCODE_TEST=1 to run");
            return;
        }
        let (width, height, fps) = (1920, 1080, 60);
        let output = std::env::temp_dir().join("openscreen-encoder-smoke.mp4");
        let _ = std::fs::remove_file(&output);

        let mut encoder = VideoEncoder::open(
            VideoParams { width, height, fps, bitrate: 8_000_000 },
            forced_backend_from_env().expect("valid encoder override"),
            |backend, error| eprintln!("  {} unavailable: {error}", backend.as_str()),
        )
        .expect("some backend must open");
        eprintln!("selected backend: {}", encoder.backend().as_str());

        let mut muxer = Muxer::create(&output).expect("muxer");
        let track = muxer.add_stream(encoder.codec_context()).expect("video track");
        muxer.write_header().expect("header");
        let stride = width as usize * 4;
        let mut frame = vec![0u8; stride * height as usize];
        let started = std::time::Instant::now();
        const FRAMES: i64 = 120;
        for pts in 0..FRAMES {
            // Vary the content so the encoder cannot collapse the whole clip
            // into one keyframe plus 119 skip frames, which would make the
            // timing meaningless.
            for (index, byte) in frame.iter_mut().enumerate() {
                *byte = ((index as i64 + pts * 7919) % 251) as u8;
            }
            encoder
                .submit(&frame, stride, ff::AV_PIX_FMT_BGRA, pts, |packet| muxer.write(track, packet))
                .expect("submit");
        }
        encoder.finish(|packet| muxer.write(track, packet)).expect("finish");
        let elapsed = started.elapsed();
        muxer.finish().expect("trailer");

        let stats = encoder.stats();
        eprintln!(
            "{FRAMES} frames of {width}x{height} in {:.2}s = {:.0} fps\n  \
             convert {:.2} ms/frame ({} swscale threads) | upload {:.2} ms | encode {:.2} ms",
            elapsed.as_secs_f64(),
            FRAMES as f64 / elapsed.as_secs_f64(),
            stats.convert_ms(),
            encoder.sws_threads(),
            stats.upload_ms(),
            stats.encode_ms(),
        );

        let size = std::fs::metadata(&output).expect("output exists").len();
        assert!(size > 1024, "the muxed file is {size} bytes, which cannot be 120 frames");
    }

    #[test]
    fn radv_perftest_is_added_without_clobbering_an_existing_value() {
        std::env::set_var("RADV_PERFTEST", "gpl");
        prepare_environment();
        let value = std::env::var("RADV_PERFTEST").unwrap();
        assert!(value.contains("gpl"), "existing flags must survive: {value}");
        assert!(value.contains("video_encode"), "{value}");
        // Idempotent: a second call must not append a duplicate.
        prepare_environment();
        assert_eq!(std::env::var("RADV_PERFTEST").unwrap(), value);
        std::env::remove_var("RADV_PERFTEST");
    }
}
