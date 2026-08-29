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

The camera is segmented **inside the native compositor**, on the same device that composites
it, and the mask reaches the pixel shader as a texture. Preview and export run the same code,
so they are identical by construction rather than by two implementations kept in step.

| stage | where |
|---|---|
| capture | `Compositor::capture_webcam_rgb` renders the webcam NV12 into a 256x144 RGBA target and reads it back |
| inference | `segmentation.rs`, ONNX Runtime CPU EP, own thread, 30 Hz, `intra_op_num_threads = 2` |
| upload | `Compositor::set_webcam_mask`, from the render thread, into a DYNAMIC R8 texture (Windows) / a `Shared` R8 texture written by `replace_region` (Metal) |
| composite | `ps_main`, `t3` / `texture(3)` / `@binding(4)`, branch on `fx.z` |

Windows and macOS run all four stages; Linux carries the composite stage only (see *Not done*).

**How the runtime gets there.** The crate links `ort` with `load-dynamic`, so nothing is needed to
*build*; at runtime `ensureOnnxRuntimeOnPath` looks for the library next to the addon in
`electron/native/bin/<tag>/`, the convention `whisper-stt` already uses.
`scripts/stage-onnxruntime.mjs` puts it there, pinned by tag **and** sha256 — the discipline
`fetch-ffmpeg.mjs` applies to its own vendored binaries, and this file ships inside every
installer. The digests come from the release metadata GitHub records at upload, so `--pin`
re-generates the table after a version bump without pulling 124 MB. `stage-onnxruntime.test.mjs`
guards the table the way `fetch-ffmpeg.test.mjs` guards ffmpeg's, including the failure specific to
this one: asset names interpolate `VERSION`, so a bump silently re-points all three downloads while
leaving the digests below them stale.

It runs from `build:win`, `build:mac` and `build:linux` — and, separately, as its own step in the
macOS CI job, which spells its steps out instead of calling `build:mac` and has already lost the
compositor addon that way once. `onnxruntime-node` was considered and rejected: 296 MB unpacked,
which would roughly triple the installer for three platforms' worth of providers we do not use.

The model is `public/mediapipe/selfie_segmentation/selfie_segmentation_landscape.onnx`, derived
from the vendored `.tflite` by `scripts/convert-selfie-segmentation-to-onnx.py`. Its path is
resolved by the **main process** in `resolveSceneAssetPaths`, the same place the wallpaper and
the cursor sprites are resolved: the renderer asks for an effect and knows nothing about the
disk.

Everything is inert until both a mode and a mask exist. No effect requested means no capture, no
inference and no upload — the feature costs exactly zero when off. A model that fails to load
turns the effect off with one log line rather than failing the frame.

**`ort` panics rather than erroring when its library is missing** — `load_dynamic::init(&path)
.expect("Failed to load ONNX Runtime dylib")` in `ort/src/lib.rs`. Without a guard, a build whose
ONNX Runtime was never staged would take down the render thread on the first frame with an effect
instead of degrading. `Segmenter::load` therefore checks `runtime_available()` before touching the
API at all, and wraps the session build in `catch_unwind` for the case where the file is present
but will not load. CI found this: the macOS and Linux Rust jobs have no library, and the first
version of these tests failed there rather than skipping.

### What this replaced

MediaPipe used to run in the renderer, and the layer had **two compositors**: a DOM `<canvas>`
in preview, and a composite baked into a video track for export. That is gone — the JS solution,
its two ~5.6 MB WASM builds, the `@mediapipe/selfie_segmentation` dependency, the export
pre-render and the `write-derived-media` IPC it needed. The `.tflite` files stay because the
`.onnx` is derived from them.

It also removes the limitation that made transparent export impossible: the mask is a texture,
not an alpha channel, so nothing has to survive a codec that cannot carry one.

### Not done

- **Linux has the shader half only.** All three back-ends carry the same branch, but Linux does
  not yet capture or upload a mask, so `fx.z` never leaves 0 there and the effect is inert. That
  split was deliberate: the shader is the part that must not drift, and it is also the part that
  cannot be verified from a Windows machine, so it was the half worth landing blind.

  macOS now has the other half too — `capture_webcam_rgb` renders the camera into a 256x144
  `Private` target and blits to a `Shared` mirror for `get_bytes` (the readback shape the module
  header already prescribed, on the capture's **own** command buffer so `last_cmd` stays the
  `render_nv12` one), and `set_webcam_mask` uploads R8 through `replace_region`.

  **The control is therefore hidden on Linux only** (`supportsWebcamSegmentation` in
  `RightPanes.tsx`). A visible setting that changes nothing is worse than an absent one; it
  comes back for a platform the moment that platform's capture lands. What Linux still needs is
  `capture_webcam_rgb` and `set_webcam_mask` against the `ReadbackRing` it already has.
- **Intel Macs get no runtime.** Upstream publishes no `osx-x64` asset for ONNX Runtime 1.29.0
  (arm64 only), so `runtime_available()` is false there and the mask never arrives. The control is
  still shown, because `supportsWebcamSegmentation` gates on platform and the renderer cannot see
  the arch — which makes this the one case that violates the rule the gate exists to enforce: a
  setting that changes nothing. Fixing it properly means exposing the capability rather than
  guessing it — `runtime_available()` through the addon on the `probeBackend` pattern — which also
  covers the dev checkout and `--dir` builds where nothing was staged.

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

## Settled: ONNX Runtime CPU EP, 256x144, 30 Hz, two threads

[Round 3](https://github.com/getopenscreen/openscreen/pull/493#issuecomment-5416849856) measured
all four arms under contention. The result is not the margin, it is the shape:

| arm | ratio vs compositor alone | added ms/frame |
|---|---:|---:|
| control (pacing only, no inference) | 0.999 | — |
| DirectML, 256x144 | 0.897 | +1.03 |
| DirectML, 128x80 | 0.932 | +0.51 |
| **CPU EP, 256x144** | **0.943** | **+0.47** |
| CPU EP, 128x80 | 0.941 | +0.47 |

**DirectML's cost scales with pixels; the CPU EP's does not.** The CPU EP sits at +0.47 ms at
both resolutions, so **the CPU EP at full resolution is cheaper than DirectML ever gets even at
reduced resolution**. Against a 9.03 ms compositor frame, that is ~5 %.

**Thread count must be pinned.** On this 4-core box a default ORT session takes every core and
produces a p95 of **24.9 ms** — a dropped frame every time it fires. `intra_op_num_threads = 2`
is within 8 % of the best p10 with less than half the tail, and leaves two cores to the
compositor. Never ship the default.

**Resolution stays at 256x144.** IoU 0.949 flattered 128x80: as a PiP it is indistinguishable,
but with the camera fullscreen the mask is upscaled ~15x and soft-edge pixels go 3.1 % -> 8.1 %,
hair collapses into a ramp and the silhouette picks up a halo. 192x112 would be the safe reduced
option — but since the CPU EP is flat across resolution, there is no reason to reduce at all.

### Why this is the real prize

Choosing the CPU EP is not a latency decision, it is an architectural one:

- no DirectML means **no D3D12 device, no shared-handle interop, no adapter-LUID matching, no
  cross-queue fence** — the entire hardest piece of the Windows design disappears;
- nothing new in packaging;
- the mask comes back as a 36 KB CPU buffer and goes into `t3` as an ordinary texture **upload**,
  never a readback, so it never touches the blocking `Map(D3D11_MAP_READ)` that dominates preview
  cost;
- **the platform multiplier collapses to one code path.** "ORT has no Vulkan EP" stops mattering
  when no GPU EP is needed, so **Linux stops being the weak leg**.

### Still open

- **Linux**, where the export path is already CPU-heavy — giving two cores to inference may bite
  differently. This is the one place the recommendation could still fail, and it is unmeasured.
- `allow_spinning = false` on the CPU thread pool, the obvious next contention knob.
- fp16/int8, reopened by round 2 and interacting with the provider choice now settled.

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

**macOS — Metal, and the port is in.** Capture, upload and composite all run on the one
`MTLDevice` the compositor already shares with the encoder; there is no interop layer, because
the CPU EP made one unnecessary everywhere.

Indicative cost, M1 (8 GPU cores, macOS 26.5), 1280x720 preview including the synchronous
`readback_direct` the preview already pays, A/B/A/B interleaved, 300 frames per arm. **Not a
§C.2 run** — no fixture, no `--repeat 3`, its own harness — so it is a shape, not a quotable
number:

| arm | p50 | vs off |
|---|---:|---:|
| effect off | 3.04 ms | — |
| cutout | 2.57 ms | **−0.47 ms** |
| blur | 3.47 ms | +0.43 ms |

**Cutout is cheaper than no effect at all.** It drops the PiP drop shadow — one fewer full-quad
SDF draw — and that more than pays for everything the feature adds.

What these arms do **not** isolate is the capture itself. Cutout and blur do exactly the same
capture, inference and upload work (same 30 Hz limiter, same 256x144 readback); they differ only
by the shader branch and the shadow. So the 0.90 ms between them is shader work, and the capture
cost sits inside both arms unmeasured. Separating it needs a fourth arm — effect requested,
capture running, `fx.z` held at 0 — which is not a state the compositor can be asked for today.

The honest claim is therefore the net one: **on this machine the whole feature costs between
−0.47 and +0.43 ms per frame at 720p.** And it is a *this machine* claim — M1 unified memory
makes the `Private`→`Shared` blit nearly free, whereas on an Intel Mac with a discrete GPU it is
a real bus transfer. That has not been measured.

**The engine question, kept for the record.** `d3d_macos.rs:109-119` creates one `MTLDevice` and
one `MTLCommandQueue`, and `compositor_macos.rs:525-531` shows the compositor *clones* (retains)
them rather than making its own — preview and export already share the same objects. MPSGraph and
CoreML can take that same device: **no interop layer at all**, and CoreML may route to the ANE,
which would remove GPU contention entirely. Neither was needed once the CPU EP was settled. The
11.07 ms compositor baseline quoted above is a Radeon number and does not transfer — the M1
figure for the same shape of frame is the 3.04 ms in the table.

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
