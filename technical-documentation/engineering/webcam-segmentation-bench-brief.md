# Brief — webcam segmentation feasibility measurement

Self-contained brief for an agent running on a test machine. Everything needed is here; read
[webcam-segmentation.md](webcam-segmentation.md) for the surrounding decision.

---

## Mission

Answer one question with admissible numbers:

> **Can the target GPU run a 256×144 segmentation model once per frame while the compositor
> still holds its frame budget?**

A "yes" unlocks moving AI segmentation into the native compositor. A "no" kills that design and
we keep segmenting in the renderer. **You are not implementing the feature. You are measuring
whether it is affordable.**

## Hard constraints

- **Do not modify any production code.** No changes under `src/`, `electron/`, or
  `crates/compositor/`. Measurement scaffolding lives in a scratch directory or a throwaway
  crate you do not commit.
- **Do not add dependencies to the app.** Nothing enters `package.json`, `Cargo.toml`, or the
  packaging config. Install what you need on the machine, outside the repo.
- **Do not push, do not open a PR.** Report back; a human decides.
- **Do not download model weights without naming the source and getting it approved.** Prefer
  converting the model already vendored in the repo — see Task 1.

## Environment

Repo: `getopenscreen/openscreen`, branch `feat/webcam-effects`.

Build wrapper: `crates\x.bat` (`x.bat run --release -- …`) — it sets up vcvars, puts ffmpeg on
PATH, and calls cargo. Two things break on a fresh machine:

- its hardcoded Visual Studio path (`…\Visual Studio\18\Insiders\…`) may not exist — the file's
  own comment says to adjust it;
- if you are in a **git worktree**, `crates/thirdparty/` is absent (gitignored). Copy it from a
  full checkout or nothing builds. Bindgen also needs `LIBCLANG_PATH` pointing at an LLVM `bin`.

The bench needs a fixture directory containing `screen.mp4`, `webcam.mp4` and
`screen.cursor.json`. `crates/fixture/fixture.json` is the frozen manifest; regenerate with
`-c copy` so the bitstream is untouched.

**Report the hardware.** GPU model, driver version, whether it is integrated or discrete, and
whether the machine is on battery. This matters more than any number you produce: the design
targets an **integrated** GPU. If this machine has a discrete GPU, say so prominently — the
result does not transfer, and you should state that rather than let it read as a green light.

## Measurement discipline — non-negotiable

Governed by `technical-documentation/engineering/rendering-performance.md` §C.2. That document
records several runs that were **VOID** and explains why. Follow it or your numbers are worthless:

- discard one full warm-up sweep before anything you report;
- `--repeat 3`, and interleave A/B/A/B — never all-A-then-all-B;
- **spread gate: any arm above 15 % spread declares the run VOID.** Report it as VOID; do not
  quote it;
- quiet machine. The documented VOID example had ~40 browser and Electron processes live. Close
  them;
- thermal and battery drift have *inverted conclusions* on this hardware before. Re-run if in doubt;
- **only within-run ratios transfer between machines, never absolute times.** Your deliverable is
  a ratio.

---

## Task 1 — isolated inference latency

**Goal:** ms per inference, warm, p50 and p95, batch 1.

**Model.** MediaPipe SelfieSegmentation, *landscape* variant. The repo already vendors the
weights at `public/mediapipe/selfie_segmentation/selfie_segmentation_landscape.tflite`
(249,792 bytes). This is the runtime configuration in use today
(`webcamSegmentation.ts`: `modelSelection: 1`).

Preferred route — **convert what we already ship**, so no new supply chain:

1. Install `tensorflow` + `tf2onnx` on the test machine (this is fine here; it is not fine on a
   dev machine and must never enter the repo's dependencies).
2. Convert the vendored `.tflite` to ONNX.
3. **Derive the input/output tensor shapes and dtypes from the converted model — do not assume
   them.** Report what you find.
4. Sanity-check correctness on one real webcam frame: run it and confirm the mask actually
   segments a person. A latency number for a broken graph is worthless.

If conversion proves impractical, stop and report that, naming what failed. Do not substitute a
pre-converted model from the internet without the source being approved first.

**Measure.** ONNX Runtime with the **DirectML** execution provider. Report:

- p50 / p95 ms per inference, warm, over ≥ 200 iterations after ≥ 20 discarded;
- the same on the **CPU** execution provider, as a floor to compare against;
- ONNX Runtime version, DirectML version, and the ops that fell back to CPU if any.

## Task 2 — contention

**Goal:** does inference running alongside compositing cost the compositor its budget?

This needs **no integration work**. Two arms:

- **Arm A:** the C8 bench alone.
  ```
  crates\x.bat run --release -- --cfg C8 --fixture fixture --repeat 3 --out out\
  ```
- **Arm B:** the same, while a separate process runs the Task 1 inference in a loop at **60 Hz**
  (one inference every 16.7 ms) on the same GPU.

Interleave A/B/A/B. Report fps for each arm, the spread per arm, and the **ratio B/A**.

If you have budget, add a third probe: arm B′ with inference running *as fast as possible*
rather than at 60 Hz. That is an upper bound, not the realistic load, and should be labelled as
such.

## What to report back

A short written report, in this shape:

| | value |
|---|---|
| GPU / driver / integrated or discrete | |
| Machine representative of the target? | |
| Inference p50 / p95 (DirectML) | |
| Inference p50 / p95 (CPU EP) | |
| Model input / output shapes as measured | |
| C8 fps — arm A (spread) | |
| C8 fps — arm B (spread) | |
| **Ratio B/A** | |
| Run admissible under §C.2? | |

Then, in prose:

- **the gate**: does the compositor still hold its budget with inference in the loop? Answer
  yes/no and show the arithmetic;
- anything that surprised you, and anything you could not measure;
- every run you discarded and why. A VOID run reported as VOID is a useful result; a VOID run
  reported as a number is a harmful one.

## What would change the answer

Flag these if you hit them:

- ops falling back to the CPU EP — that changes the latency picture entirely;
- DirectML failing to initialise on this GPU/driver;
- the fixture not being representative (resolution, frame rate) of a real recording;
- the compositor bench not reaching its documented ~126 fps ballpark on arm A, which would mean
  the machine is not comparable to the reference and the ratio is all you can offer.
