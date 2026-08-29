# Porting webcam segmentation to a compositor back-end

What a macOS or Linux port has to add, what it must not change, and how it is verified.

Context and the measurements behind the design: [webcam-segmentation.md](webcam-segmentation.md).

## Where it stands

The feature is complete on Windows and inert elsewhere. The split is deliberate:

| piece | Windows | macOS | Linux |
|---|---|---|---|
| shader branch on `fx.z` | done | **done** | **done** |
| mask texture binding | `t3` | `texture(3)` | `@binding(4)` |
| `capture_webcam_rgb` | done | **missing** | **missing** |
| `set_webcam_mask` | done | **missing** | **missing** |
| `pump_segmentation` call | done | **missing** | **missing** |
| `fx` on the webcam layer | done | **missing** | **missing** |
| inference (`segmentation.rs`) | shared | shared | shared |

The shader half landed on all three at once on purpose: it is the part that must not drift
between back-ends, it is mechanical, and the Metal and WGSL versions are checked by CI (see
Verification). Everything below is the per-back-end half.

`RightPanes.tsx`'s `supportsWebcamSegmentation()` hides the control off Windows. **Delete that
gate for your platform in the same PR that lands the port** — it exists so users are not offered a
setting that does nothing, and it becomes a lie the moment the port works.

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

## Linux specifics

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
