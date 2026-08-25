# Webcam background segmentation

Where the AI cutout/blur/custom-background feature stands, the constraint that shapes it, and
the measurement that has to choose the next step.

Companion to [rendering-performance.md](rendering-performance.md), whose protocol §C.2 governs
every number quoted here.

## The principle at stake

Two decisions already in force bound this feature:

> **Compositing and encoding run in one native D3D11 engine**, shared by live preview and export.
> — [decisions.md](../architecture/decisions.md)

> A single `ID3D11Device`, zero CPU readback between stages.
> — [crates/README.md](../../crates/README.md)

The shader is the pixel SSOT. Preview and export are identical because they run *the same code*,
not because two implementations are kept in step by hand.

## What ships today

The camera is segmented by **MediaPipe SelfieSegmentation running in the renderer**
(`src/lib/ai-edition/webcamSegmentation.ts`), on Chromium's ANGLE device or the WASM CPU
fallback. What happens next differs by path:

| Path | Who composites the camera | How the mask travels |
|---|---|---|
| Preview | a DOM `<canvas>` over the native canvas | never leaves the renderer |
| Export | the shader, via `draw_video` | baked into a video, then decoded back |

So the layer has **two compositors**, and the export half round-trips the composite through a
codec. `NativeCompositorOverlay` withholds `webcamPath` from the native view while an effect is
active, so exactly one of them owns the layer at a time — but they remain two implementations.

### The known limitation

Transparent (cutout) **export** cannot work. The pre-rendered track is VP9-with-alpha in WebM,
and the native decode path is ffmpeg → NV12: `draw_video(&wy, &wuv)` binds a Y plane and a UV
plane, and there is no third plane. Alpha is dropped at decode, so the subject lands on an
opaque black rectangle. Blur and custom background are unaffected — their tracks are opaque, so
NV12 loses nothing.

This is structural, not a bug to patch: it is what "bake the composite" costs.

## The constraint that shapes any fix

The mask must reach the shader as a texture. That part is cheap and identical under every
option: `t0`/`t1` are the webcam NV12 and `t2` is the wallpaper/sprite slot, so **`t3` is free**,
and `fx.y`/`fx.z` are unused in mode 0 and can carry mode + intensity.

```hlsl
Texture2D<float> texMask : register(t3);

// ps_main, mode < 0.5, after the motion-blur accumulation:
float m = texMask.Sample(samp, uv_now);        // 256x144, upscaled by the sampler
if      (effect > 2.5) rgb   = lerp(color.rgb, rgb, m);        // custom background
else if (effect > 1.5) rgb   = lerp(blur_bg(uv_now), rgb, m);  // blur
else if (effect > 0.5) alpha = alpha * m;                      // cutout
```

What is *not* cheap is producing that mask on the device that consumes it.

- The compositor renders on its own `ID3D11Device` in the **main** process — feature level 11_1
  only (`d3d_windows.rs:75` bails on anything else), default adapter (`pAdapter = None`), and
  `SetMultithreadProtected(true)`.
- MediaPipe runs in the **renderer** process. No JS API exposes a shared DXGI handle from ANGLE,
  so zero-copy between the two is unreachable from that side.
- **DirectML binds to a D3D12 device, not D3D11.** "Run ONNX Runtime on the compositor's device"
  is therefore not a thing; it needs D3D11↔D3D12 shared-handle interop on a matching adapter LUID.

## Options

| | A — transport the mask | B — inference in the compositor | C — hand-written compute |
|---|---|---|---|
| Preview and export ISO | no, still two compositors | yes, same code | yes, same code |
| New native runtime | none | one | none |
| GPU interop | n/a | D3D11↔D3D12 (Windows) | none, same device |
| Main risk | mask lags the frame it masks | queue contention; packaging ×5 | porting a CNN to 3 shading languages |

**A** is cheap and fixes the alpha loss, but regresses something that works today: the preview
mask is currently perfectly aligned, because MediaPipe segments the very frame the canvas draws.
Sourcing it from a second decoder means pairing by PTS and accepting a lag, which shows on
moving edges.

**C** matches the repo's habit of writing GPU maths from scratch, but means porting a
MobileNet-class graph to HLSL *and* Metal *and* GLSL, with the numerical validation that implies.

**B** is the recommended direction — with the interop cost stated honestly above.

### The platform multiplier

This is the part that dominates B's cost, and it is not Windows-shaped:

| | Compositor | GPU inference | Interop needed |
|---|---|---|---|
| Windows | D3D11 | DirectML (D3D12) | D3D11↔D3D12 |
| macOS | Metal | MPSGraph / CoreML | none — same `MTLDevice` |
| Linux | Vulkan | ORT has no Vulkan EP | depends on the EP |

Linux is the weak leg. Note that **ggml with a Vulkan backend already ships in this app** —
whisper.cpp builds it for Windows and Linux, Metal for macOS arm64, with the Vulkan-SDK CI leg
already debugged (`.github/workflows/build-whisper-stt.yml`). An engine covering all three
platforms is therefore already packaged; what it lacks is a graph for this model, which would be
written once rather than three times. That trade deserves to be re-examined if ORT's Linux story
proves as thin as it looks.

## The measurement that decides

Do not build the interop before this is answered. The ledger already records the directly
analogous outcome:

> **Encoder pipelining** — *Implemented and measured: a loss on the target integrated GPU,
> because encode and composite contend for the same queue.*

Per-frame inference is the same shape of work. The decisive question is whether the target
integrated GPU has the headroom, not whether the copies can be elided — the mask is 256×144 R8,
36 KB, and copying it was never the cost.

### What to measure

1. **Isolated inference latency.** ms per inference of MediaPipe SelfieSegmentation *landscape*
   (256×144) on the target GPU, p50 and p95, warm.
2. **Contention.** The C8 bench with and without a concurrent 60 Hz inference load on the same
   GPU. This needs no integration: a second process hammering the GPU answers "is there
   headroom" without a line of compositor code.

### Protocol

Governed by [rendering-performance.md](rendering-performance.md) §C.2, which is not optional:

- one full warm-up sweep discarded before any reported run;
- `--repeat 3`, interleaved A/B/A/B arms;
- **spread gate: a run above 15 % declares itself VOID** and is not quotable;
- a quiet machine — the documented VOID example had ~40 browser and Electron processes live;
- **only within-run ratios transfer between machines, never absolute times.** The deliverable is
  a ratio, not a frame time.

```
crates\x.bat run --release -- --cfg C0..C8 --fixture fixture --repeat 3 --out out\
```

`x.bat` wraps vcvars + ffmpeg-on-PATH + cargo. Its hardcoded Visual Studio path may need
adjusting per machine — the file says so itself. A worktree also has no `crates/thirdparty/`
(gitignored); it must be copied from a full checkout before anything builds.

### The gate

If inference costs ~6 ms on a frame budget of ~8, the design is dead on the target hardware and
the interop question never arises — the answer is then A, or staying with a pre-render. Decide on
the ratio, then build.

## Appendix — brief for the measurement

A self-contained brief for whoever (or whatever) runs this on the test machine lives in
[webcam-segmentation-bench-brief.md](webcam-segmentation-bench-brief.md).
