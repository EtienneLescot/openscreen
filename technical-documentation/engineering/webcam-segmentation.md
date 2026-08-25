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
- The Linux backend is **wgpu 24 + WGSL**, not raw Vulkan — `layer.wgsl`/`blur.wgsl` are compiled
  at runtime by naga. There is no SPIR-V toolchain to reuse and no raw `VkDevice` exposed.

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

The choice between **B** and **C** turns on a single question — is the cost compute or overhead? —
which the next section answers. Read it before weighing the table above: it moves **C** from
"purist but too expensive" to the only option that addresses the measured bottleneck, because
fusion is exactly what an off-the-shelf runtime will not do for you.

## What the measurement found

Run of 2026-08-25 on a Radeon 610M (2 CU RDNA2, integrated — the pessimistic end of the target
class). Full report in [PR #493](https://github.com/getopenscreen/openscreen/pull/493#issuecomment-5410489010).

| | |
|---|---|
| Inference p50, DirectML | 3.803 ms |
| Inference p50, CPU EP | **3.575 ms — the CPU is faster** |
| Compositor alone | 11.07 ms/frame |
| With a 60 Hz inference load | 14.08 ms/frame (**+3.01 ms, −21.4 % throughput**) |
| Headroom at 60 fps | 5.60 ms → **2.59 ms** |

It passes the gate, but thinly, and +3.01 ms is a *floor*: it excludes the D3D11↔D3D12 interop,
the NV12→RGB preprocessing and the mask upload that the design actually adds.

### The workload is overhead-bound, not compute-bound

Parsing the vendored `selfie_segmentation_landscape.tflite` as a flatbuffer settles it without
further measurement:

- 246 nodes, of which **110 are `DEQUANTIZE`** — the weights are **already fp16 at rest**;
- 136 real ops: `CONV_2D` 43, `RELU` 22, `ADD` 14, `HARD_SWISH` 11, `DEPTHWISE_CONV_2D` 11,
  `LOGISTIC` 11, `MEAN` 10, `MUL` 10, `RESIZE_BILINEAR` 3, and one MediaPipe custom
  `Convolution2DTransposeBias`. The `MEAN → CONV1×1 → RELU → CONV1×1 → LOGISTIC → MUL` pattern
  repeats ten times: Squeeze-and-Excitation blocks;
- **33.325 M MACs = 66.65 MFLOP** per inference;
- **48 of the 136 ops have a 1×1 spatial output.** Op 15 is `CONV_2D [1,1,1,16] → [1,1,1,8]`:
  **128 MACs in an entire dispatch.**

Against ~486 GFLOP/s the ALU floor is **0.137 ms**, and the unfused-bandwidth floor 0.37–0.93 ms.
Measured: 3.803 ms. **3.6 % of peak — 38 % of the dispatches perform 0.1 % of the arithmetic.**

Two consequences, both load-bearing:

1. **Quantisation should not be pursued.** It halves 416 KiB of weights that already sit in L2,
   on a GPU idle 96 % of the time, and removes no dispatch. The model is already fp16 anyway —
   an apparent int8 "win" would mostly be undoing a conversion artifact.
2. **DirectML and the CPU EP agreeing within 6.4 % across two unrelated engines** points at a
   shared additive constant of ~2–2.5 ms *outside both providers*, in ONNX Runtime's per-`Run()`
   path. If so, the fix is binding/session hygiene, not a model or a kernel.

## The levers, in order of expected payoff

| # | Lever | Expected | Cost |
|---|---|---|---|
| 1 | **Inference at 30 Hz, not 60** | **+1.5 ms headroom** (2.59 → 4.09) | a scheduling change; export already runs at 30 Hz |
| 2 | **ORT graph capture / session hygiene** | up to ~2 ms | config, if whole-graph fusion was simply off |
| 3 | **Fuse away the ~19 SE dispatches** | **1.6–2.2 ms** | needs hand-written kernels — no off-the-shelf runtime fuses an SE branch into its preceding conv |
| 4 | fp16 the ONNX graph | 0.3–1.0 ms | free, zero accuracy cost |
| 5 | **CPU EP** | keeps the *full* 5.6 ms of GPU headroom | it never touches the contended queue |
| — | int8 / model swap | ~nothing | do not pursue |

Lever 5 deserves attention: the CPU EP is already the faster of the two measured, and it removes
the D3D11↔D3D12 interop, the cross-queue serialisation and the packaging cost in one move.

## Per platform

The three backends are not the same problem.

**Windows — D3D11, feature level 11_1.** DirectML binds to a **D3D12** device, so it needs adapter
LUID matching (`IDXGIFactory4::EnumAdapterByLuid`), a shared NT handle for the mask texture
(`CreateSharedHandle` → `ID3D11Device1::OpenSharedResource1`) and a shared fence
(`ID3D11Device5::OpenSharedFence` + `ID3D11DeviceContext4::Wait`). All present in the pinned
`windows` 0.58 crate, but `Win32_Graphics_Direct3D12` is not yet in the workspace feature list.
**A queue cannot be shared between a D3D11 and a D3D12 device — no API exists**, and with 2 CUs
there is no idle silicon for async compute to fill. That is a floor, not a tuning knob.
`onnxruntime-node` in `electron-builder.json5` is a stale comment, not a dependency.

**macOS — Metal. The cleanest of the three.** `d3d_macos.rs:109-119` creates one `MTLDevice` and
one `MTLCommandQueue`, and `compositor_macos.rs:525-531` shows the compositor *clones* (retains)
them rather than making its own — preview and export already share the same objects. MPSGraph and
CoreML can take that same device: **no interop layer at all**, and CoreML may route to the ANE,
which would remove GPU contention entirely. The macOS composite baseline has never been measured;
the 11.07 ms figure is a Radeon number and does not transfer.

**Linux — wgpu 24 + WGSL, not raw Vulkan.** `layer.wgsl` and `blur.wgsl` are compiled at runtime
by naga; there is no SPIR-V toolchain to reuse and no raw `VkDevice` exposed. ONNX Runtime with a
GPU EP is vendor-locked and unshippable to unknown hardware, and `libonnxruntime.so` risks symbol
collision with Chromium's protobuf/abseil. The realistic options are WGSL compute on the existing
wgpu device, or the CPU EP.

Only `texture(3)` / `t3` / `@binding(4)` is common to all three — the mask binding is mechanical
everywhere, and can be built before the engine question is settled.

## The experiment ladder

Run these before building anything; each can falsify the one after it.

- **E0 — prove the bound.** Sweep input resolution (256×144, 192×108, 128×72, 64×36) using the
  square variant already vendored at `selfie_segmentation.tflite`. If 16× fewer pixels is not
  ~16× faster — prediction: it lands at 2.5–3.5 ms against 3.803 — the workload is overhead-bound
  and levers 1–3 are where the time is.
- **E1 — 30 Hz.** The largest single win, and it is free.
- **E2 — ORT session hygiene.** Check whether whole-graph fusion was simply off: a run with it on
  would not report 32 separate `DmlFusedConv` nodes. Config keys must be confirmed against
  `onnxruntime_session_options_config_keys.h` for the pinned version — do not trust remembered
  spellings.
- **E3 — CPU EP under contention.** Re-run the bench with a CPU-side load instead of a GPU-side
  one. This is the arm that could keep the full 5.6 ms.
- **E4 — a fused SE block**, hand-written, timed against the runtime's version. This decides
  whether lever 3 is worth three implementations.

**Licence landmine:** RobustVideoMatting is GPL-3.0 against an MIT app. Do not vendor it.

## Why it was measured first

The interop was deliberately not built before this was answered. The ledger already records the directly
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
