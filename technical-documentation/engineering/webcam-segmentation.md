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

### It is memory-bandwidth-bound per pixel — the overhead hypothesis was falsified

An earlier draft of this document argued the workload was overhead-bound: 66.65 MFLOP against a
~486 GFLOP/s device is 3.6 % of peak, and 48 of the 136 real ops have a 1x1 spatial output (one
convolution does 128 MACs in an entire dispatch). The prediction that followed — that shrinking
the input would *not* speed it up proportionally — was measured and **falsified**
([round 2](https://github.com/getopenscreen/openscreen/pull/493#issuecomment-5415093217)).

| resolution | pixels vs base | DML p10 | speedup | % of proportional | mask IoU |
|---|---:|---:|---:|---:|---:|
| 256x144 (shipped) | 1.00x | 3.092 ms | 1.00x | 100 % | 1.000 |
| 192x112 | 1.71x fewer | 2.014 ms | 1.53x | 90 % | **0.976** |
| 128x80 | 3.60x fewer | 1.172 ms | 2.64x | 73 % | 0.949 |
| 64x48 | 12.0x fewer | 0.639 ms | 4.84x | 40 % | 0.514 — model breaks |
| 256x256 (square) | 1.78x more | 5.065 ms | 0.61x | **109 %** | — |

The clinching point is the row going **up**: 1.78x the pixels for 1.63x the time. Time tracks
pixels in both directions. A least-squares fit gives a fixed overhead of **0.43 ms on DirectML**
— 14 % of the shipped-resolution cost, not the ~2-2.5 ms that had been predicted.

The Squeeze-and-Excitation plumbing *is* visible at node level (56 nodes, 14.7 % of node time,
near-zero arithmetic; 31,104x the MACs for 8.8x the time between the heaviest and lightest
convolution). But most of that plumbing — Transpose, Mul, Resize, Relu, Add — runs on
**full-resolution feature maps**, so its cost is per-pixel bandwidth, not per-dispatch overhead.
That is exactly why it vanishes when the input shrinks.

**The ALUs idle because the workload is bandwidth-limited, not because it waits on dispatch.**
"96 % idle" was a real number, read wrongly.

## The levers, in order of measured payoff

| # | Lever | Measured | Cost |
|---|---|---|---|
| 1 | **Input at 192x112** | **1.53x**, IoU 0.976 — visually indistinguishable | an input-shape change; the model is fully convolutional, no retrain |
| 2 | **Input at 128x80** | **2.64x**, IoU 0.949 | visibly softer edges — a judgement call |
| 3 | **Inference at 30 Hz** | halves how often the cost is paid | scheduling; stacks multiplicatively with 1-2 |
| 4 | **fp16 / int8** | reopened — for a bandwidth-bound workload, halving precision halves the dominant cost | must be read against the 110 `DEQUANTIZE` nodes (weights are already fp16 at rest) |
| 5 | **CPU EP** | **21 % faster than DirectML here** (2.476 vs 3.119 ms p10), and never touches the contended queue | removes the D3D11-D3D12 interop entirely |

Extrapolating round 1's +3.01 ms contention (it nearly serialises, so it scales with GPU time)
gives roughly **+1.14 ms/frame at 128x80**. That is an extrapolation, not a measurement.

**Dropped:** ORT session hygiene and a hand-fused SE compute shader. Both were premised on a
large fixed cost; the real fixed cost is 0.43 ms, so together they cap at ~14 %. Three shading
languages for a couple of tenths of a millisecond is not a trade worth making.

**Hard constraint found:** both input dimensions must be divisible by 16, or the skip-connection
`Add`s fail on mismatched extents. And at 64x48 the model stops working rather than degrading —
it emits an all-background mask.

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
