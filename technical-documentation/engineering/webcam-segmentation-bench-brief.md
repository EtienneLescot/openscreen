# Brief — segmentation experiment ladder (round 3: settle the execution provider)

> **This round has been run and closed.** It is kept as the record of what was asked and under
> which constraints, not as work to do. The answer it produced — CPU execution provider, 256x144,
> 30 Hz, two intra-op threads — and the reasoning that followed are in
> [webcam-segmentation.md](webcam-segmentation.md); the compositor has since been built on it.
> Read the requirements below as the brief that was issued, and do not tighten them for a run that
> is over: a later round needs its own brief.

Self-contained brief for an agent on a test machine. Read
[webcam-segmentation.md](webcam-segmentation.md) for the decision this feeds.

Previous rounds, both in PR #493:
[round 1](https://github.com/getopenscreen/openscreen/pull/493#issuecomment-5410489010) —
realtime is affordable but thin (+3.01 ms/frame, 2.59 ms headroom).
[round 2](https://github.com/getopenscreen/openscreen/pull/493#issuecomment-5415093217) —
the workload is **memory-bandwidth-bound per pixel**; input resolution is the lever
(192×112 = 1.53× at IoU 0.976, 128×80 = 2.64× at IoU 0.949).

---

## The question

**Does the CPU execution provider beat DirectML once both are running next to the compositor?**

It is the only unknown left that changes the architecture. The CPU EP already measures **21 %
faster than DirectML** in isolation here (2.476 vs 3.119 ms p10) and it never touches the
contended GPU queue. If that holds under load, it removes the D3D11↔D3D12 shared-handle interop,
the adapter-LUID matching, the cross-queue fence and the DirectML packaging cost.

That last clause was written as "on all three platforms at once", and it overreached: the
measurement behind it is **one Windows box**. What it actually settles is that the Windows build
needs no GPU execution path. macOS and Linux inherit the *architecture* — no interop, no second
device — because they were then built that way, not because either was measured. Neither has been.

The risk that could kill it: this box is a **4-core / 8-thread** Ryzen 5 7520U. An ONNX Runtime
CPU session that grabs every core will fight the compositor's own CPU work. **Thread count is the
tuning knob and must be swept, not left at default.**

## Hard constraints

Unchanged: **no production code touched** (nothing under `src/`, `electron/`,
`crates/compositor/`), **no dependency added to the app**, **nothing pushed**, **no model weights
downloaded** without the source being named and approved.

Protocol per [rendering-performance.md](rendering-performance.md) §C.2 — warm-up discarded,
interleaved arms, **any arm above 15 % spread is VOID**, quiet machine, **only within-run ratios
transfer**. Round 2 only became admissible after moving to **iteration-level interleaving with a
p10 statistic**; start there rather than rediscovering it. Round 2 also needed a 300 s cooldown
between sweeps — budget for it.

Report the hardware and the battery state. Round 1's absolutes were depressed by a charging
battery; round 2's were not. Say which you have.

## The arms

Four, interleaved at iteration level. **Keep the no-op control** — without it a drop cannot be
attributed to the GPU rather than to the load generator stealing CPU.

| arm | load |
|---|---|
| **A** | compositor alone |
| **N** | pacing loop only, no inference — control |
| **B-dml** | + DirectML inference at 30 Hz |
| **B-cpu** | + CPU EP inference at 30 Hz |

Run the whole set at **two input resolutions: 256×144 and 128×80**, so the EP choice and the
resolution lever can be read separately rather than confounded.

**Verify the achieved load rate inside every arm.** Round 1's void came from a "60 Hz" load
silently running at 38 Hz and reporting a reassuring, wrong result.

## What to sweep on the CPU arm

`intra_op_num_threads` at **1, 2, 4, and default**. For each, report both the inference latency
*and* the compositor's ratio against arm A. The interesting answer is almost certainly not the
fastest inference — it is the thread count where inference is fast enough and the compositor is
untouched.

Also report `inter_op_num_threads` if you change it, and which `ExecutionMode` you used.

## What else to watch

- **Does the compositor's own CPU work suffer?** Decode and mux are CPU-side. Report whether arm
  B-cpu costs the compositor more in *CPU* time even where it costs nothing in GPU time.
- The encoder mattered enormously in round 1 (−21.4 % with it, −6.5 % without). Say whether your
  bench arm has the encoder in the loop, because the CPU EP contends differently from DirectML.
- **Total system headroom**, not just the compositor's: if the CPU EP saturates the box, the app
  is unusable even with a happy compositor.

## Correctness check, not just timing

IoU 0.949 at 128×80 is a number, not a verdict. Render the mask at the two sizes it will actually
be seen at and look:

- as a **picture-in-picture** at roughly 25 % of frame width — the common case;
- **camera fullscreen**, where a 128×80 mask is upscaled ~15× and edges will be at their worst.

Say plainly whether 128×80 is shippable, whether 192×112 is the safer pick, and what the edge
artefacts actually look like. A visual call here is worth more than another decimal place.

## What to report

Per arm and per resolution: the number, the spread, admissible or VOID, and the ratio against A.
Then, in prose:

- **which EP you would ship, and at which resolution and thread count**;
- whether the CPU EP removes the need for the D3D11↔D3D12 interop — the actual decision this
  round exists to make;
- every run discarded and why. A prediction falsified is the most valuable thing you can return —
  round 2's falsification of the overhead hypothesis saved building two levers that did not exist.

## Do not pursue

- ORT session hygiene and hand-fused SE compute shaders — round 2 measured the total fixed cost at
  0.43 ms. That is **14 % of DirectML's 3.119 ms p10**, the provider it was measured against; it is
  17 % of the CPU EP's 2.476 ms. The cap is a share of whichever provider you are standing on, not
  a universal 14 %.
- Inputs below 128×80: at 64×48 the model emits an all-background mask. It breaks, it does not
  degrade. Both dimensions must also be **divisible by 16** or the skip-connection `Add`s fail.
- **RobustVideoMatting** — GPL-3.0 against an MIT app.
- MODNet, BiSeNet, SelfieMulticlass, ROI-tracking as a perf lever.

fp16/int8 is live again after round 2, but it is **round 4** — settle the provider first, since
precision interacts with which one you pick.
