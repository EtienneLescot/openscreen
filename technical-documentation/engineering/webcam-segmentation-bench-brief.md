# Brief — segmentation experiment ladder (round 2)

> **Superseded in part.** E0 was run and **falsified** the overhead-bound hypothesis this ladder
> was built on ([results](https://github.com/getopenscreen/openscreen/pull/493#issuecomment-5415093217)).
> E2 and E4 are dropped. The live levers are input resolution, fp16/int8, and the CPU EP — see
> [webcam-segmentation.md](webcam-segmentation.md).

Self-contained brief for an agent on a test machine. Read
[webcam-segmentation.md](webcam-segmentation.md) for the decision this feeds.

Round 1 answered "is realtime affordable?" — *qualified yes, 2.59 ms of headroom against a floor
estimate*. Its report is in
[PR #493](https://github.com/getopenscreen/openscreen/pull/493#issuecomment-5410489010).

Round 2 answers a different question: **where do the 3.8 ms actually go, and which lever gets
them back?** A flatbuffer parse of the vendored model says the GPU is idle 96 % of the time, so
the time is overhead, not arithmetic. Confirm that, then attack it.

---

## Hard constraints

Unchanged from round 1: **no production code touched** (nothing under `src/`, `electron/`,
`crates/compositor/`), **no dependency added to the app**, **nothing pushed**, and **no model
weights downloaded without the source being named and approved.** Everything here uses files
already in the repo.

Protocol per [rendering-performance.md](rendering-performance.md) §C.2 — warm-up sweep discarded,
`--repeat 3`, interleaved arms, **any arm above 15 % spread is VOID**, quiet machine, and **only
within-run ratios transfer**. Round 1 caught a fake result this way (a "60 Hz" load actually
running at 38 Hz, reporting a reassuring and wrong 0.945); assume the same traps are still there.

**Report the hardware again**, and if this is not the same box as round 1, say so — the round-1
absolutes do not transfer to it.

## E0 — prove the bound *(do this first; it decides the rest)*

Sweep the input resolution and see whether time tracks pixels.

- 256×144 (the shipped landscape variant), then 192×108, 128×72, 64×36.
- The square variant is **already vendored** at
  `public/mediapipe/selfie_segmentation/selfie_segmentation.tflite` — use it for a 256×256 point,
  at zero supply-chain cost.
- **Prediction to falsify:** 64×36 has 16× fewer pixels and will *not* be 16× faster — expect
  roughly 2.5–3.5 ms against 3.803. If time is flat across the sweep, the workload is
  overhead-bound and E1–E3 are where the milliseconds live. If it tracks pixels, the hypothesis
  is wrong, and fp16/int8 become live again.

Also worth one profiler pass: per-node timings. The claim to check is that the ten
Squeeze-and-Excitation blocks — `MEAN → CONV1×1 → RELU → CONV1×1 → LOGISTIC → MUL`, some doing
**128 MACs in a whole dispatch** — cost comparable wall time to convolutions doing 2.36 M MACs.
A ~500× arithmetic difference showing up as ~1× time difference is the signature.

## E1 — 30 Hz instead of 60

The largest single win available, and it is a scheduling change, not engineering. A silhouette
does not meaningfully change in 16 ms. Expected: **+1.5 ms of headroom** (2.59 → 4.09 ms).

Re-run the round-1 contention bench with the load generator at 30 Hz. Verify the achieved rate
inside every arm — round 1's void was caused by exactly this going unverified.

## E2 — ONNX Runtime session hygiene

DirectML (3.803 ms) and the CPU EP (3.575 ms) agreeing within 6.4 % across two unrelated engines
points at a shared constant of ~2–2.5 ms **outside both providers**, in ORT's per-`Run()` path.

- **Predicted finding, stated so it can be falsified:** whole-graph fusion was *off* in the
  round-1 run — a run with it on would not report 32 separate `DmlFusedConv` nodes. If that is
  right, this is a config change worth more than everything else combined.
- Get the authoritative config keys from `onnxruntime_session_options_config_keys.h` in the
  installed package. **Do not trust remembered spellings** — an unknown key throws, which is a
  cheap way to check.
- Expect the DML EP to want `enable_mem_pattern = False` and `ORT_SEQUENTIAL`; graph capture, if
  available, additionally wants static shapes (satisfied — this graph is fully static) and
  pre-bound, address-stable I/O via `IOBinding`.
- Measure with `IOBinding` to device-resident tensors versus the naive numpy round-trip. The gap
  is the per-`Run()` overhead.

## E3 — CPU EP under contention

The arm that could keep the **full 5.6 ms** of compositor headroom, because it never touches the
contended GPU queue — and it removes the D3D11↔D3D12 interop from the design entirely.

Re-run the contention bench with a **CPU-side** inference load instead of a GPU-side one. Keep
the no-op control arm from round 1: without it, a drop cannot be attributed.

Report how many cores the load occupies, and whether the compositor's own CPU work (decode, mux)
starts to suffer — on Linux especially, where the export path is already CPU-heavy.

## E4 — a hand-fused Squeeze-and-Excitation block

Only if E0 confirms overhead-bound. This decides whether hand-written compute is worth three
implementations.

Write one fused depthwise-separable + SE block as a compute shader (HLSL `cs_5_0` is fine for the
probe), time it against the same block as the runtime executes it, and extrapolate. The estimate
to check: fusing away ~19 SE dispatches ≈ **1.6–2.2 ms**, more than fp16 and int8 combined could
plausibly deliver.

## What to report

The round-1 table shape, plus per experiment: the number, the spread, whether it was admissible,
and **whether it confirmed or falsified the stated prediction**. A falsified prediction is the
most valuable thing you can bring back.

Then: which lever you would pull first, and what you would stop pursuing.

## Do not pursue

- ~~int8 in any form~~ — **E0 falsified the overhead-bound finding, so precision is live again**,
  and now for a positive reason: the workload is bandwidth-bound per pixel, so halving precision
  halves the dominant cost. Still read any int8 result against the 110 `DEQUANTIZE` nodes in the
  shipped `.tflite` — the weights are already fp16 at rest.
- **RobustVideoMatting** — GPL-3.0 against an MIT app. A licence landmine, before its recurrent
  state is even relevant.
- MODNet, BiSeNet, SelfieMulticlass, ROI-tracking-as-a-perf-lever. Only **PP-HumanSeg v2 Lite** is
  worth an hour, and only to count its operators against this model's 136.
