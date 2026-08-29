# Porting webcam segmentation to a compositor back-end

What a macOS or Linux port has to add, what it must not change, and how it is verified.

Context and the measurements behind the design: [webcam-segmentation.md](webcam-segmentation.md).

## Where it stands

The feature is complete on all three back-ends.

| piece | Windows | macOS | Linux |
|---|---|---|---|
| shader branch on `fx.z` | done | done | done |
| mask texture binding | `t3` | `texture(3)` | `@binding(4)` |
| `capture_webcam_rgb` | done | done | done |
| `set_webcam_mask` | done | done | done |
| `pump_segmentation` call | done | done | done |
| `fx` on the webcam layer | done | done | done |
| inference (`segmentation.rs`) | shared | shared | shared |

The shader half landed on all three at once on purpose: it is the part that must not drift
between back-ends, it is mechanical, and the Metal and WGSL versions are checked by CI (see
Verification). Everything below is the per-back-end half, and it is what each port added.

`RightPanes.tsx`'s `supportsWebcamSegmentation()` is **gone**: it existed so users were not
offered a setting that did nothing, and once the last back-end captured a frame it admitted every
platform and had become a lie. A fourth back-end would need it back — and would need to land the
gate and the port in the same PR, as the first three did.

## What you are adding

Four things, in this order. `compositor_windows.rs` is the reference for all of them.

**1. `capture_webcam_rgb(wy, wuv, src, w, h, &mut out)`** — render the webcam NV12 into a
256x144 RGBA offscreen target through the back-end's existing layer draw, read it back, and write
interleaved RGB8 into `out`.

- Pass **the whole valid frame** as `src`, not the sub-rect being drawn: `[0, 0, wcw/wtw,
  wch/wth]`. A tight user crop would otherwise amputate the subject at the model's input and the
  mask would be wrong exactly where it matters. The shader maps uv back into that space through
  `fx.xy`.
- It takes the render target and does not restore it, so it must run **before** the compose pass
  begins. The Windows version documents this on the function.
- `out` is reused across frames; do not allocate per call.

**2. `set_webcam_mask(&[u8], width, height)`** — upload the R8 mask into a texture that is
reallocated only when the model resolution changes, which in practice is never.

**3. `pump_segmentation(wy, wuv, valid)`** — call it at the top of `compose_frame`, right after
the webcam SRVs/textures exist. It uploads whatever mask the worker finished, then submits a new
frame if the 30 Hz limiter allows. The two halves are deliberately out of step: the mask uploaded
is from the previous frame, because one frame of lag on a silhouette is invisible while waiting on
inference would block the render.

Copy the Windows body nearly verbatim — the worker, the inbox, the rate limiter, the lazy start
from `scene.webcam_effect.model_path` and the `seg_failed` latch are all platform-independent.

**4. `fx` and `color` on the webcam layer.** Where the back-end builds the webcam `LayerCB` (search
`has_webcam`), carry:

```
fx    = [valid_w, valid_h, effect_code, blur_intensity]
color = the custom background colour (mode 3), else [0, 0, 0, 1]
```

`effect_code` comes from `SceneWebcamEffect::shader_code()` and must stay **0 unless a mask has
actually been uploaded** — otherwise cutout mode renders an invisible webcam on the first frames.
Also suppress the PiP drop shadow in cutout mode, as Windows does: a shadow cast by an invisible
box reads as an artifact.

## What you must not change

- **The shader contract.** `fx.z` is the mode, `fx.w` the blur intensity, `fx.xy` the valid
  extent, the mask is sampled at `uv / fx.xy`. Windows, Metal and WGSL agree today; changing one
  silently desynchronises the three.
- **The 25-tap background blur.** Same weights, same radius in all three. It is what makes blur
  mode look identical across platforms.
- **`segmentation.rs`.** It is shared and already cross-platform. If you find yourself editing it
  for a platform reason, that is a design smell worth raising instead.

## Verification

Both platforms have a real CI job that runs `cargo test -p openscreen-compositor --lib --tests`:

- **macOS** — `rust-macos-compositor-check`, `macos-14`, a real Metal device. Its
  `every_shader_entry_point_compiles` test compiles `shaders.metal` at runtime, which is what
  catches invalid MSL that type-checks perfectly. That job is why the Metal shader half could be
  landed from a Windows machine at all.
- **Linux** — `rust-linux-compositor-check`, `ubuntu-latest`, with `mesa-vulkan-drivers`
  (lavapipe) so wgpu has a real adapter, `OPENSCREEN_REQUIRE_CPU_BACKEND=1`, ffmpeg vendored by
  `npm run fetch:ffmpeg:sdk`, and `LD_LIBRARY_PATH` pointed at it.

There is **no bench off Windows**: `poc-d3d` is `cfg(windows)`-gated in its own `Cargo.toml`, so
the `--cfg C8 --scene …` route used to prove the Windows path does not exist for you. Add a test
instead, and say in the PR what you actually saw on screen — a mask that composites is not the
same claim as a mask that is correct.

What the macOS port left behind, as the model for the Linux one — `compositor_macos::tests`, all
rendering real pixels on the system device and all readable without ONNX Runtime, because the
mask is posted by hand with `set_webcam_mask` and inference is not what these are testing:

| test | what it would catch |
|---|---|
| `the_webcam_capture_comes_back_as_interleaved_rgb_at_model_resolution` | a readback that is RGBA, mirrored, or reallocating every frame |
| `the_mask_actually_cuts_the_camera_out` | an unbound texture at index 3, or a mask that reaches the shader as noise |
| `the_custom_background_colour_replaces_the_masked_out_pixels` | `color` not carried onto the webcam `LayerCB` |
| `a_mode_without_a_mask_composites_exactly_like_no_effect_at_all` | `effect_code` leaving 0 too early — the invisible-webcam trap, asserted byte for byte |
| `compose_frame_cuts_the_camera_out_once_a_mask_exists` | `fx` not carried, by counting camera pixels rather than pinning PiP geometry |
| `the_pip_shadow_is_suppressed_in_cutout_mode` | the shadow of an invisible box — with a control render, so the assertion cannot pass vacuously |
| `the_whole_loop_produces_a_mask_from_compose_frame_alone` | capture → inference → upload, driven by `compose_frame` alone. The only one that needs ONNX Runtime, and it skips cleanly without it |

Plus `seg_visual_renders_the_four_modes_from_a_real_photo`, opt-in behind
`OPENSCREEN_SEG_VISUAL` + `OPENSCREEN_SEG_CAM` (same shape of gate as
`tests/compose_linux.rs`): it renders the four modes from a photograph and writes PNGs. The
assertions above can only say the mask *composites*; a mask that is *correct* on real hair
against a real background is a judgement, and this is what you look at to make it.

`compositor_linux::tests` is the same set, one test wider. It adds
`a_capture_whose_rows_need_padding_is_depadded_correctly`, because the padding trap below is the
one thing the shipped resolution can never exercise: 256 px of RGBA is 1024 bytes, already
aligned, so at the size that actually runs the depad branch is dead code. The test captures at
100 px — 400 bytes of payload in a 512-byte stride — and samples several rows, since a wrong
depad does not produce noise but a shear of 28 px per row.

Two more things differ from macOS, both forced by the host:

- **`Gpu::create_auto`, not `Gpu::create`.** `create` is hardware-strict and the Linux CI runner
  has no GPU, so the strict constructor would make every one of these tests skip silently on the
  only machine that runs them automatically. `create_auto` falls back to lavapipe, which is what
  the job installs `mesa-vulkan-drivers` for.
- **The frames are built by hand.** There is no `CVPixelBuffer` equivalent to lean on: the tests
  allocate the NV12-split pair themselves and pack a `linux_frames::VkFrameTex` carrier into
  `AVFrame::data[0]`, exactly as `CpuFrames::attach_carrier` does. They therefore still go through
  the real `nv12_srvs`, so no shortcut is taken on the frame seam.

## macOS specifics

- **Device and queue.** `d3d_macos.rs:66-72` — `Gpu { device: metal::Device, context:
  metal::CommandQueue }`, one of each, and `compositor_macos.rs:526-531` shows the compositor
  *clones* (retains) them. There is no persistent equivalent of `ID3D11DeviceContext`: state
  lives on a per-pass encoder, and `begin_pass` (`:1230-1253`) is the factory.
- **Webcam textures.** `nv12_srvs` (`:651-666`) returns owned `metal::Texture` (`R8Unorm` +
  `RG8Unorm`), created in `compose_frame` at **`:1382`**. `tex_dims` (`:638-646`) returns
  `(0, 0)` for a null webcam, so guard with `.max(1)` — the Windows path divides unguarded
  because it always has both frames.
- **Insertion point.** After `:1393`, before `let scene_ref = self.scene.borrow();` at `:1395` —
  the last point where `wtw/wth/wcw/wch` are in scope with no borrow of `self.scene` held.
- **Readback is already solved and prescribed by the module header** (`:15-25`): render targets
  are `StorageMode::Private`, and each pass ends with a blit to a `Shared` mirror on which
  `get_bytes` is legal. Copy the shape of `render_nv12` (`:1773-1825`), `mirror_rt`
  (`:1687-1705`) and `readback_direct` (`:1830-1857`). **Do not introduce a `Managed` path** —
  nothing here uses one, and `synchronizeResource` is only needed for `Managed`.
- **Trap: do not use `submit()`/`sync()` for the capture pass.** `sync()` (`:1212-1223`) waits on
  `last_cmd`, and `read_nv12_scaled` depends on `last_cmd` being the `render_nv12` buffer.
  Commit and `wait_until_completed()` on the capture's own command buffer, leaving `last_cmd`
  alone.
- **Mask upload** is `replace_region` (the pattern is at `:774-782`).
- **`synchronizeResource` was not needed, and this was checked rather than assumed.** The
  `Private` → blit → `Shared` → `get_bytes` shape reads back correctly as-is; `Shared` is not
  `Managed`, so there is nothing to synchronise. It is also the same shape `rt_read` and
  `nv12_read_y` have used in production all along, so it carries no support risk the existing
  readbacks do not already carry.
- **No double buffer on the mask.** `set_webcam_mask` rewrites a `Shared` texture the GPU could
  in principle still be sampling — except that it cannot: all three macOS frame paths drain the
  queue before returning (`readback_direct` and `rgb_to_nv12` do `submit` + `sync`,
  `read_nv12_scaled` does `sync`), so nothing is in flight when `compose_frame` next calls
  `pump_segmentation`. If that invariant ever changes, this is the code that breaks.

## Linux specifics

What the port settled, beyond the notes below:

- **`make_bind` resolves the mask itself**, rather than every call site passing it. It already
  builds one bind group per draw and the layout requires binding 4, so the mask is bound on every
  draw and `dummy_view()` is the fallback in the one place that decides. Nothing else changed at
  the ~15 call sites.
- **The capture readback is its own thing, not a fourth entry on `ReadbackRing`.** The ring exists
  to *avoid* waiting; the capture must wait, because the frame it reads is the worker's input for
  this tick. What it borrows from the ring is the lesson, not the code:
  `WaitForSubmissionIndex`, never `Maintain::Wait`.
- **`pump_segmentation` is called behind a scene check in `compose_frame`, not only inside
  itself.** It re-checks anyway — the body is the Windows one verbatim — but on this back-end
  `nv12_srvs` *allocates* two `TextureView`s per call, so reaching the function at all would cost
  two allocations a frame on every project that has no effect. The feature has to cost zero when
  it is off, and here that is a call-site property.
- **`Queue::write_texture` for the mask, and it is not subject to the 256-byte rule.** That rule
  is `copy_texture_to_buffer`'s. `linux_frames::upload` already writes NV12 planes with swscale's
  SIMD strides through the same call.

- **Webcam textures.** `nv12_srvs` (`compositor_linux.rs:779-791`) delegates to
  `linux_frames::nv12_planes`, which builds **fresh `TextureView`s on every call** — there is no
  cache (`clear_srv_cache` is a documented no-op at `:765-767`). The planes are **CPU-uploaded**
  via `Queue::write_texture`, not zero-copy: wgpu has no portable NV12 format
  (`linux_frames.rs:16-22`).
- **Insertion point.** The `compose_frame` prologue, `:1013-1038`, right after the `nv12_srvs` /
  `tex_dims` calls at `:1023-1026`.
- **Readback machinery already exists and is tuned.** `ReadbackRing` (`:95-102`), `PendingCopy`
  (`:58-65`), `make_staging` (`:639-646`), submit+arm (`:2115-2152`), harvest (`:2170-2200`).
  Reuse its shape rather than inventing a second one.
- **Trap: never write `Maintain::Wait`.** The `ReadbackRing` header (`:67-94`) is a record of that
  exact regression — `Maintain::Wait` does not absorb the copy, it absorbs the whole GPU queue,
  measured at **3.8 ms (simple scene) to 6.2 ms (loaded scene) per frame at 1080p**. Always
  `Maintain::WaitForSubmissionIndex(idx)`.
- **`copy_texture_to_buffer` wants `bytes_per_row` aligned to 256.** A 256-wide R8 mask happens to
  satisfy it; an RGBA capture at 256 wide is 1024 bytes and also does. Do not assume it for any
  other width you pick.
- **Bind the mask on every draw, not only the camera layer.** `make_bind` (`:922-965`) builds one
  bind group per draw and the layout requires binding 4 (`tex_entry(4)` at `:241-246`); the shader
  branch is gated on `fx.z` anyway, so binding it everywhere costs nothing. `dummy_view()`
  (`:2036-2052`) stays the fallback.
- **Note the existing cost profile before you judge yours:** live preview already runs readback at
  depth 1, fully synchronous on the render thread (`:436-440`); export runs depth 2
  (`pipeline_linux.rs:464`) precisely to avoid blocking. Your capture adds a second synchronous
  readback to the preview path, and that is the one number this port can regress. Measure it.

## Traps this already hit

- **`ort` panics when its library is missing.** It does not return an error:
  `load_dynamic::init(&path).expect(…)`. `Segmenter::load` guards with `runtime_available()` plus
  a `catch_unwind`. Do not remove either, and do not assume an absent runtime degrades on its own —
  it did not, and CI is what found that out.
- **You need ONNX Runtime locally to exercise inference.** Nothing stages it yet (see
  webcam-segmentation.md). Point `ORT_DYLIB_PATH` at a library you install yourself; the tests skip
  cleanly without one, which is exactly what CI does.
- **wgpu validates bind groups against the layout.** `@binding(4)` is already declared and a dummy
  view already bound, so every draw works today. When you bind the real mask, keep a view bound in
  the absent case or every draw fails, not only the ones using it.
- **`copy_texture_to_buffer` needs 256-byte row alignment** on wgpu. The Windows readback handles a
  driver row pitch; Linux's is stricter and padding it is on you.
- **Metal tolerates an unbound texture at index 3** only because the branch is gated on `fx.z`.
  Once you raise `fx.z`, index 3 must be bound on every layer draw that can take the branch.
