# Zero-copy dmabuf → VAAPI capture (fix for #507)

## Problem

On GNOME/mutter + AMD, the helper only advertises `LINEAR`/`INVALID` dmabuf
modifiers (it reads frames via CPU `mmap`, which needs linear). AMD monitor
buffers are **tiled**, so dmabuf negotiation can't succeed and we fall back to
**shm/memfd**. mutter throttles whole-monitor shm delivery hard (GPU→CPU copy
per frame), starving the recorder to ~2–11 distinct fps while OBS gets ~24 over
dmabuf. Result: whole-screen recordings look frozen. Window capture is less
affected (smaller surface → shm copy keeps up).

Goal: import the compositor's **tiled** dmabuf directly as a VAAPI surface and
encode with the existing `h264_vaapi` path — no CPU readback, no shm.

## Constraint that shapes the design: the clock-driven encoder

`capture.rs` writes constant-frame-rate output by *holding the last staged
picture* across gaps (a static screen delivers no frames). We therefore cannot
pin the PipeWire dmabuf across that gap — the pool is 4–16 buffers. So on each
arriving frame we must copy it into a surface **we own**, then requeue the
compositor buffer promptly. The copy stays on the GPU (VAAPI VPP), so it's cheap.

## Pipeline (new dmabuf path, shm path kept as fallback)

1. **Negotiation** — advertise the dmabuf modifiers our importer supports.
   Enumerate them from the DRM render node (VAAPI/`vaQuerySurfaceAttributes` or
   EGL `eglQueryDmaBufModifiersEXT`), per fourcc, like OBS. Offer that list in
   `osc_build_enum_format_dmabuf` instead of just LINEAR/INVALID.
2. **C shim** — on `SPA_DATA_DmaBuf`, stop mmap'ing. Extract the raw descriptor:
   fd(s), `format_modifier`, and per-plane `offset`/`stride`, plus fourcc. Pass
   them to Rust via an extended `osc_pw_frame`/`RawFrame`. Keep the
   `DMA_BUF_IOCTL_SYNC` bracket only for the (unused-on-dmabuf) CPU path.
3. **Frame lifecycle** — the mailbox must not `memcpy` for dmabuf. It holds the
   descriptor + a handle that keeps the PipeWire buffer un-requeued until the
   main loop imports it; newest-wins requeues the superseded buffer. Requeue
   happens right after import (fast), never across the clock gap.
4. **Encoder** — build an `AVFrame` of `AV_PIX_FMT_DRM_PRIME` wrapping an
   `AVDRMFrameDescriptor`, `av_hwframe_map()` it to a VAAPI frame (DRM→VAAPI
   zero-copy), then VPP (`scale_vaapi`/`vpp_vaapi`) into our own NV12 VAAPI pool
   surface — this also applies the **crop** (VideoCrop) on the GPU, replacing the
   current CPU pointer-offset crop. That owned surface becomes the staged frame;
   `encode_staged` sends it directly (no `av_hwframe_transfer_data` upload).
5. **Fallback** — the dmabuf path is NOT GNOME-specific: it applies to any
   compositor that offers dmabuf (GNOME/mutter, KDE/kwin, most wlroots) whenever
   the encoder is **VAAPI** (the default Linux backend with any GPU), so the large
   majority of PipeWire desktop users benefit. shm stays as the fallback only for:
   (a) compositors that offer *only* shm (some `xdg-desktop-portal-wlr` configs —
   why shm is listed first today), and (b) non-VAAPI encoders (software
   libopenh264 / Vulkan), whose dmabuf import isn't wired yet — they keep today's
   shm + sws_scale + hwupload path. Also fall back if enumeration/import/VPP fails.
   Never regress software-encode or shm-only-compositor users.

## Decision: zero-copy (option B)

Chosen over the pragmatic GPU-detile→CPU-readback path. The dmabuf stays on the
GPU end to end: `av_hwframe_map` (DRM_PRIME→VAAPI) → `scale_vaapi` VPP (format +
crop) into our own NV12 surface → encode. No CPU readback.

Key architecture calls:
- **One shared VAAPI `AVHWDeviceContext`** created up front, used by BOTH the
  importer (PipeWire thread) and the encoder (main loop). A single mutex guards
  all VADisplay ops (import+VPP vs encode) since libva isn't thread-safe per
  display. Contention is negligible (both are GPU-driven).
- **Import runs on the PipeWire thread inside `on_frame`**, while the PW buffer is
  still held (before requeue), so the dmabuf content is stable during the map+VPP
  copy. The result is our own NV12 VAAPI surface (ref-counted `AVFrame`) placed in
  the mailbox; the PW buffer requeues immediately after. This preserves the
  clock-driven hold (we own the surface; the compositor buffer is returned).
- **v1 targets full monitor (no crop)**: importer/VPP sized to the stream at
  `stream-started`. Window crop via VPP is a follow-up.
- **Fallback** to the existing shm + sws_scale + hwupload path when: backend isn't
  VAAPI, the compositor only offers shm, or any of map/VPP/import fails.

## Status / steps

- [x] **Foundation**: generate ffmpeg DRM bindings (`build.rs` +
  `hwcontext_drm.h`). Verified `AVDRMFrameDescriptor`, `AV_PIX_FMT_DRM_PRIME`,
  `AV_HWDEVICE_TYPE_DRM` present.
- [x] **Negotiation** (validated on AMD/mutter): enumerate importable modifiers
  via EGL surfaceless (`csrc/dmabuf_modifiers.c`) and advertise them in
  `osc_build_enum_format_dmabuf`. Confirmed mutter now negotiates a **tiled
  dmabuf** (`stream-started` fires) where before it failed with "no more input
  formats". Enumeration returns 10 AMD GFX9 modifiers for XRGB8888. The existing
  `mmap` path then correctly reports "driver does not allow CPU mapping" — the
  exact branch point for the GPU import below.
- [x] Extend `osc_pw_frame` (pw_shim.h) + `RawFrame` (shim.rs) with
  is_dmabuf/modifier/fourcc/n_planes/plane_fd/offset/stride. Layouts mirror
  exactly; builds green.
- [x] C: `osc_read_frame` populates the descriptor for a tiled dmabuf;
  `osc_on_add_buffer` latches `import_dmabuf` on mmap failure instead of erroring;
  fourcc mapping added. shm/linear-dmabuf paths unchanged. `on_frame` currently
  skips dmabuf frames (data==null) — safe no-op until the importer lands.
- [ ] Mailbox + requeue-handle rework (no memcpy for dmabuf).
- [ ] Encoder: DRM_PRIME → `av_hwframe_map` → VAAPI VPP (crop) → NV12 pool
  surface; `encode_staged` direct.
- [ ] Shm fallback guard + error paths.
- [ ] Test on AMD/GNOME: confirm `uses_dmabuf=1`, distinct-fps ≈ OBS (~24),
  crop correct for window captures, cursor unaffected. Regression-check
  software encode and a wlroots/niri compositor.

## Risk notes

- radeonsi VAAPI must import the specific tiled modifier mutter exports — highly
  likely OK (GNOME/OBS do DRM→VAAPI on this GPU), but the concrete failure mode
  is `av_hwframe_map` returning an error → must fall back cleanly.
- Concurrency: import/VPP needs the VAAPI context; keep it on the main loop
  (as sws_scale is today), holding the PW buffer only until the next tick.
