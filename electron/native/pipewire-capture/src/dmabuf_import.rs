//! Zero-copy import of a compositor dmabuf into a VAAPI NV12 surface (issue #507).
//!
//! On GNOME/Wayland + AMD a whole-monitor capture arrives as a *tiled* dmabuf
//! that cannot be CPU-mapped. Rather than fall back to the shm path (which mutter
//! throttles hard), we keep the frame on the GPU: wrap the dmabuf as a
//! `DRM_PRIME` frame, [`av_hwframe_map`] it into a VAAPI surface, and run it
//! through a `scale_vaapi` VPP that converts the BGRx layout to the NV12 the
//! H.264 VAAPI encoder wants. Nothing is read back to system memory.
//!
//! The importer owns the VAAPI device and the filtergraph. The encoder is opened
//! against [`Self::output_frames_ctx`] so the NV12 surface this produces is one
//! `avcodec_send_frame` accepts directly. See docs/dmabuf-vaapi-plan.md.

use crate::ffmpeg as ff;
use std::ptr;

/// `av_frame_free` wants a `**AVFrame`; wrap the pointer in a local so the null
/// it writes back does not land in a temporary.
unsafe fn free_frame(frame: *mut ff::AVFrame) {
    let mut p = frame;
    ff::av_frame_free(&mut p);
}

/// The AVBufferRef around the DRM descriptor owns nothing heap-allocated (the
/// descriptor is a stack local that outlives the map), so freeing it is a no-op.
unsafe extern "C" fn noop_buffer_free(_opaque: *mut std::ffi::c_void, _data: *mut u8) {}

/// One dmabuf plane. `fd` is borrowed for the duration of [`DmabufImporter::import`]
/// only — VAAPI dups it during surface creation, so the caller may close it after.
pub struct DmabufPlane {
    pub fd: i32,
    pub offset: i32,
    pub stride: i32,
}

/// A dmabuf frame to import. Borrows the fds; see [`DmabufPlane`].
pub struct DmabufFrame<'a> {
    pub width: i32,
    pub height: i32,
    pub drm_fourcc: u32,
    pub modifier: u64,
    pub planes: &'a [DmabufPlane],
}

/// The pixel format the VAAPI-mapped surface presents, derived from the dmabuf's
/// DRM fourcc. Only the 32-bit RGB layouts we negotiate are handled.
fn sw_format_for_fourcc(drm_fourcc: u32) -> Option<ff::AVPixelFormat> {
    // DRM fourccs (little-endian) → the matching packed ffmpeg format.
    const XRGB8888: u32 = 0x34325258; // SPA BGRx
    const ARGB8888: u32 = 0x34325241; // SPA BGRA
    const XBGR8888: u32 = 0x34324258; // SPA RGBx
    const ABGR8888: u32 = 0x34324241; // SPA RGBA
    match drm_fourcc {
        XRGB8888 => Some(ff::AV_PIX_FMT_BGR0),
        ARGB8888 => Some(ff::AV_PIX_FMT_BGRA),
        XBGR8888 => Some(ff::AV_PIX_FMT_0BGR),
        ABGR8888 => Some(ff::AV_PIX_FMT_ABGR),
        _ => None,
    }
}

/// Whether the zero-copy VAAPI dmabuf-import pipeline can be built on this
/// machine. Constructs a nominal importer, which exercises the DRM→VAAPI device
/// creation, the frames contexts and the `scale_vaapi` graph — everything that
/// fails on a non-VAAPI GPU or a driver that cannot map a dmabuf. Success does
/// not depend on the exact dimensions, so a fixed probe size is representative.
/// When this is true the stream prefers dmabuf; when false it stays on shm.
pub fn available() -> bool {
    const XRGB8888: u32 = 0x34325258;
    DmabufImporter::new(1920, 1080, 1920, 1080, XRGB8888).is_ok()
}

pub struct DmabufImporter {
    /// Size of the incoming dmabuf (the whole stream). For a window this is the
    /// monitor; for a monitor it equals the output size.
    src_width: i32,
    src_height: i32,
    /// Size of the NV12 the graph emits — the recorded size. For a window this is
    /// the committed crop rectangle; for a monitor it equals the source size.
    out_width: i32,
    out_height: i32,
    sw_format: ff::AVPixelFormat,
    /// VAAPI device, shared with the encoder (whose `hw_frames_ctx` comes from
    /// [`Self::output_frames_ctx`]).
    va_device: *mut ff::AVBufferRef,
    /// DRM device derived from `va_device`; backs the DRM_PRIME source frames.
    drm_device: *mut ff::AVBufferRef,
    /// Frames context for the incoming DRM_PRIME buffers.
    drm_frames: *mut ff::AVBufferRef,
    /// Frames context for the VAAPI surface the dmabuf maps into (still BGRx).
    va_map_frames: *mut ff::AVBufferRef,
    graph: *mut ff::AVFilterGraph,
    buffersrc_ctx: *mut ff::AVFilterContext,
    buffersink_ctx: *mut ff::AVFilterContext,
}

impl DmabufImporter {
    /// Builds the device, frames contexts and `scale_vaapi` graph. `src` is the
    /// incoming dmabuf size (the whole stream); `out` is the recorded size — equal
    /// to `src` for a monitor, or the window's crop rectangle for a window (the
    /// graph then crops the source region down to it, on the GPU).
    pub fn new(
        src_width: i32,
        src_height: i32,
        out_width: i32,
        out_height: i32,
        drm_fourcc: u32,
    ) -> Result<Self, String> {
        let sw_format =
            sw_format_for_fourcc(drm_fourcc).ok_or_else(|| format!("unsupported dmabuf fourcc {drm_fourcc:#x}"))?;

        // SAFETY: every pointer is checked before use and freed in Drop.
        unsafe {
            let mut me = DmabufImporter {
                src_width,
                src_height,
                out_width,
                out_height,
                sw_format,
                va_device: ptr::null_mut(),
                drm_device: ptr::null_mut(),
                drm_frames: ptr::null_mut(),
                va_map_frames: ptr::null_mut(),
                graph: ptr::null_mut(),
                buffersrc_ctx: ptr::null_mut(),
                buffersink_ctx: ptr::null_mut(),
            };

            // Order matters: create the DRM device on the render node FIRST, then
            // derive VAAPI from it. The reverse (DRM derived from VAAPI) returns
            // ENOSYS on radeonsi — VAAPI knows how to open on a DRM fd, but not the
            // other way round. The DRM device backs the DRM_PRIME source frames;
            // the derived VAAPI device backs the mapped surface and the encoder.
            let node = c"/dev/dri/renderD128";
            let created = ff::av_hwdevice_ctx_create(
                &mut me.drm_device,
                ff::AV_HWDEVICE_TYPE_DRM,
                node.as_ptr(),
                ptr::null_mut(),
                0,
            );
            if created < 0 {
                return Err(format!("av_hwdevice_ctx_create(DRM): {}", ff::err_to_string(created)));
            }

            let derived = ff::av_hwdevice_ctx_create_derived(
                &mut me.va_device,
                ff::AV_HWDEVICE_TYPE_VAAPI,
                me.drm_device,
                0,
            );
            if derived < 0 {
                return Err(format!(
                    "av_hwdevice_ctx_create_derived(VAAPI): {}",
                    ff::err_to_string(derived)
                ));
            }

            me.drm_frames = me.alloc_frames(me.drm_device, ff::AV_PIX_FMT_DRM_PRIME)?;
            me.va_map_frames = me.alloc_frames(me.va_device, ff::AV_PIX_FMT_VAAPI)?;
            me.build_graph()?;
            Ok(me)
        }
    }

    /// Allocates and initialises a frames context of `hw_format` (VAAPI or
    /// DRM_PRIME) whose software format is the stream's RGB layout.
    unsafe fn alloc_frames(
        &self,
        device: *mut ff::AVBufferRef,
        hw_format: ff::AVPixelFormat,
    ) -> Result<*mut ff::AVBufferRef, String> {
        let frames = ff::av_hwframe_ctx_alloc(device);
        if frames.is_null() {
            return Err("av_hwframe_ctx_alloc failed".to_owned());
        }
        let ctx = (*frames).data as *mut ff::AVHWFramesContext;
        (*ctx).format = hw_format;
        (*ctx).sw_format = self.sw_format;
        (*ctx).width = self.src_width;
        (*ctx).height = self.src_height;
        // Pool size 0: these contexts only WRAP/MAP externally-supplied surfaces
        // (the DRM_PRIME source is our imported dmabuf; the VAAPI context is filled
        // by av_hwframe_map DIRECT). Asking for a pre-allocated pool makes
        // av_hwframe_ctx_init reject the format with EINVAL, since neither has an
        // allocator for these RGB layouts.
        (*ctx).initial_pool_size = 0;
        let init = ff::av_hwframe_ctx_init(frames);
        if init < 0 {
            let mut f = frames;
            ff::av_buffer_unref(&mut f);
            return Err(format!("av_hwframe_ctx_init: {}", ff::err_to_string(init)));
        }
        Ok(frames)
    }

    /// Builds `buffer (VAAPI/BGRx) -> scale_vaapi=format=nv12 -> buffersink`.
    unsafe fn build_graph(&mut self) -> Result<(), String> {
        self.graph = ff::avfilter_graph_alloc();
        if self.graph.is_null() {
            return Err("avfilter_graph_alloc failed".to_owned());
        }

        let buffersrc = ff::avfilter_get_by_name(c"buffer".as_ptr());
        let buffersink = ff::avfilter_get_by_name(c"buffersink".as_ptr());
        let scale = ff::avfilter_get_by_name(c"scale_vaapi".as_ptr());
        if buffersrc.is_null() || buffersink.is_null() || scale.is_null() {
            return Err("a required filter (buffer/buffersink/scale_vaapi) is missing".to_owned());
        }

        // buffersrc: the input is a VAAPI surface. Allocate WITHOUT initialising
        // (avfilter_graph_alloc_filter, not ..._create_filter): a hardware pix_fmt
        // is rejected at init unless hw_frames_ctx is already set, and only
        // av_buffersrc_parameters_set can set it. So: alloc → set params → init.
        self.buffersrc_ctx = ff::avfilter_graph_alloc_filter(self.graph, buffersrc, c"in".as_ptr());
        if self.buffersrc_ctx.is_null() {
            return Err("avfilter_graph_alloc_filter(buffersrc) failed".to_owned());
        }
        let par = ff::av_buffersrc_parameters_alloc();
        if par.is_null() {
            return Err("av_buffersrc_parameters_alloc failed".to_owned());
        }
        (*par).format = ff::AV_PIX_FMT_VAAPI as i32;
        (*par).width = self.src_width;
        (*par).height = self.src_height;
        (*par).time_base = ff::AVRational { num: 1, den: 1_000_000 };
        (*par).hw_frames_ctx = ff::av_buffer_ref(self.va_map_frames);
        let set = ff::av_buffersrc_parameters_set(self.buffersrc_ctx, par);
        ff::av_free(par as *mut _);
        if set < 0 {
            return Err(format!("av_buffersrc_parameters_set: {}", ff::err_to_string(set)));
        }
        let inited = ff::avfilter_init_str(self.buffersrc_ctx, ptr::null());
        if inited < 0 {
            return Err(format!("avfilter_init_str(buffersrc): {}", ff::err_to_string(inited)));
        }

        let rc = ff::avfilter_graph_create_filter(
            &mut self.buffersink_ctx,
            buffersink,
            c"out".as_ptr(),
            ptr::null(),
            ptr::null_mut(),
            self.graph,
        );
        if rc < 0 {
            return Err(format!("create buffersink: {}", ff::err_to_string(rc)));
        }

        // Output size = the recorded (out) size. For a monitor that equals the
        // source; for a window it is the crop rectangle, and the per-frame crop
        // fields set in `import` pick which region of the source is scaled into it.
        let scale_args = std::ffi::CString::new(format!(
            "w={}:h={}:format=nv12",
            self.out_width, self.out_height
        ))
        .map_err(|_| "scale_vaapi args contained a NUL".to_owned())?;
        let mut scale_ctx: *mut ff::AVFilterContext = ptr::null_mut();
        let rc = ff::avfilter_graph_create_filter(
            &mut scale_ctx,
            scale,
            c"vpp".as_ptr(),
            scale_args.as_ptr(),
            ptr::null_mut(),
            self.graph,
        );
        if rc < 0 {
            return Err(format!("create scale_vaapi: {}", ff::err_to_string(rc)));
        }
        // scale_vaapi needs a device to allocate its NV12 output pool; take it
        // from the shared VAAPI device rather than relying on propagation.
        (*scale_ctx).hw_device_ctx = ff::av_buffer_ref(self.va_device);

        let rc = ff::avfilter_link(self.buffersrc_ctx, 0, scale_ctx, 0);
        if rc >= 0 {
            ff::avfilter_link(scale_ctx, 0, self.buffersink_ctx, 0);
        }
        if rc < 0 {
            return Err(format!("avfilter_link: {}", ff::err_to_string(rc)));
        }

        let rc = ff::avfilter_graph_config(self.graph, ptr::null_mut());
        if rc < 0 {
            return Err(format!("avfilter_graph_config: {}", ff::err_to_string(rc)));
        }
        Ok(())
    }

    /// The NV12 VAAPI frames context the graph emits into — the encoder opens
    /// against this so it accepts the surfaces [`Self::import`] returns.
    pub fn output_frames_ctx(&self) -> *mut ff::AVBufferRef {
        // SAFETY: valid after a successful `build_graph`; the sink has one input.
        unsafe { ff::av_buffersink_get_hw_frames_ctx(self.buffersink_ctx) }
    }

    /// The shared VAAPI device, for the encoder's `hwaccel` context.
    pub fn device(&self) -> *mut ff::AVBufferRef {
        self.va_device
    }

    /// Maps one dmabuf and returns an NV12 VAAPI frame (caller unrefs it). The
    /// plane fds are only touched during this call. `crop_x`/`crop_y` are the
    /// origin of the recorded region within the source; the region size is the
    /// importer's output size. For a monitor both are 0 and out == src (no crop).
    pub fn import(
        &mut self,
        frame: &DmabufFrame,
        crop_x: i32,
        crop_y: i32,
    ) -> Result<*mut ff::AVFrame, String> {
        if frame.planes.is_empty() || frame.planes.len() > 4 {
            return Err(format!("dmabuf has {} planes", frame.planes.len()));
        }
        // SAFETY: the descriptor outlives the map call it is passed to; every
        // allocated frame is unref'd on the error paths and on success ownership
        // of the NV12 frame passes to the caller.
        unsafe {
            // Build the DRM PRIME descriptor. One object per unique fd; our RGB
            // formats are a single object with a single layer and plane.
            let mut desc: ff::AVDRMFrameDescriptor = std::mem::zeroed();
            desc.nb_objects = 1;
            desc.objects[0].fd = frame.planes[0].fd;
            desc.objects[0].size = 0; // recovered by the driver from the fd
            desc.objects[0].format_modifier = frame.modifier;
            desc.nb_layers = 1;
            desc.layers[0].format = frame.drm_fourcc;
            desc.layers[0].nb_planes = frame.planes.len() as i32;
            for (i, plane) in frame.planes.iter().enumerate() {
                desc.layers[0].planes[i].object_index = 0;
                desc.layers[0].planes[i].offset = plane.offset as isize;
                desc.layers[0].planes[i].pitch = plane.stride as isize;
            }

            let src = ff::av_frame_alloc();
            if src.is_null() {
                return Err("av_frame_alloc(src) failed".to_owned());
            }
            (*src).format = ff::AV_PIX_FMT_DRM_PRIME as i32;
            (*src).width = self.src_width;
            (*src).height = self.src_height;
            // av_hwframe_map rejects a source frame that is not ref-counted, so
            // wrap the descriptor in an AVBufferRef (freed as a no-op — `desc`
            // lives on the stack until this function returns, past the map).
            let buf = ff::av_buffer_create(
                &mut desc as *mut _ as *mut u8,
                std::mem::size_of::<ff::AVDRMFrameDescriptor>(),
                Some(noop_buffer_free),
                ptr::null_mut(),
                0,
            );
            if buf.is_null() {
                free_frame(src);
                return Err("av_buffer_create(drm descriptor) failed".to_owned());
            }
            (*src).buf[0] = buf;
            (*src).data[0] = (*buf).data;
            (*src).hw_frames_ctx = ff::av_buffer_ref(self.drm_frames);

            // Map the dmabuf into a VAAPI (BGRx) surface, zero-copy.
            let mapped = ff::av_frame_alloc();
            if mapped.is_null() {
                free_frame(src);
                return Err("av_frame_alloc(mapped) failed".to_owned());
            }
            (*mapped).format = ff::AV_PIX_FMT_VAAPI as i32;
            (*mapped).hw_frames_ctx = ff::av_buffer_ref(self.va_map_frames);
            let mrc = ff::av_hwframe_map(
                mapped,
                src,
                (ff::AV_HWFRAME_MAP_DIRECT | ff::AV_HWFRAME_MAP_READ) as i32,
            );
            // `src` (and thus `desc`) is no longer needed once mapped.
            free_frame(src);
            if mrc < 0 {
                free_frame(mapped);
                return Err(format!("av_hwframe_map: {}", ff::err_to_string(mrc)));
            }

            // Crop the source down to the recorded region at the live origin.
            // scale_vaapi reads these fields to set the VA source rectangle, so a
            // window is cropped on the GPU before scaling. A monitor leaves them
            // at 0 (crop_x/y are 0 and out == src), so nothing is cropped.
            (*mapped).crop_left = crop_x.max(0) as usize;
            (*mapped).crop_top = crop_y.max(0) as usize;
            (*mapped).crop_right = (self.src_width - crop_x - self.out_width).max(0) as usize;
            (*mapped).crop_bottom = (self.src_height - crop_y - self.out_height).max(0) as usize;

            // Push through scale_vaapi → NV12.
            let pushed = ff::av_buffersrc_add_frame(self.buffersrc_ctx, mapped);
            free_frame(mapped);
            if pushed < 0 {
                return Err(format!("av_buffersrc_add_frame: {}", ff::err_to_string(pushed)));
            }

            let nv12 = ff::av_frame_alloc();
            if nv12.is_null() {
                return Err("av_frame_alloc(nv12) failed".to_owned());
            }
            let got = ff::av_buffersink_get_frame(self.buffersink_ctx, nv12);
            if got < 0 {
                free_frame(nv12);
                return Err(format!("av_buffersink_get_frame: {}", ff::err_to_string(got)));
            }
            Ok(nv12)
        }
    }
}

impl Drop for DmabufImporter {
    fn drop(&mut self) {
        // SAFETY: each pointer is freed once; nulls are ignored by the ffmpeg
        // frees, and the order is graph → frames → devices.
        unsafe {
            if !self.graph.is_null() {
                ff::avfilter_graph_free(&mut self.graph);
            }
            for frames in [&mut self.drm_frames, &mut self.va_map_frames] {
                if !frames.is_null() {
                    ff::av_buffer_unref(frames);
                }
            }
            for device in [&mut self.drm_device, &mut self.va_device] {
                if !device.is_null() {
                    ff::av_buffer_unref(device);
                }
            }
        }
    }
}
