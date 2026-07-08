# Implementation plan — whisper.cpp DTW word-timestamp POC

**Author handoff:** this document is written to be executed by a coding agent
end-to-end, with no access to the prior conversation. Everything needed is
inline. Follow the phases in order.

This POC lives **inside the OpenScreen repo**, under
`tools/stt-eval/whispercpp-dtw-poc/` — it is not a separate checkout. The
isolation that matters is **not** "outside the repo", it's "no Electron app
build/run required": this is a standalone native harness (its own CMake
project, its own fixtures) that never touches `electron/`, `src/`, or any
app build step. It reuses the already-built CTranslate2 server binary as a
comparison baseline (§2.2) but does not rebuild or modify it.

---

## 0. Why this exists (read first — it determines every technical choice)

OpenScreen's STT currently runs **CTranslate2** (the engine behind
`faster-whisper`). CTranslate2's only GPU backend is **CUDA (NVIDIA)** — it has
no Metal (Apple Silicon), no Vulkan (AMD/Intel), no ROCm. That leaves Apple
Silicon and every AMD machine stuck on CPU (~1.2× real-time), which is
unacceptable for hour-long videos.

**whisper.cpp** is the only engine that reaches *all* GPUs (CUDA, Metal, Vulkan,
ROCm, CoreML) from one C++ codebase with self-contained binaries — matching how
OpenScreen already ships natives. The blocker to adopting it has always been:
**"does whisper.cpp produce word-level timestamps as good as CTranslate2's
`.align()` DTW?"**

A previous evaluation concluded "no", but that evaluation was **not a fair
test**. It failed for identifiable, avoidable reasons:

1. It tested whisper.cpp's **heuristic** (non-DTW) timestamps — mediocre by
   design, not the DTW path.
2. It tested the `--dtw` flag through the **`whisper-server` HTTP wrapper** with
   a **community `ggml-small-q5_1.bin` model that has no alignment-head data**,
   and saw "identical output with/without the flag". Two independent causes are
   possible and **both are avoided by this POC**:
   - The model lacked alignment heads → **we fix this by passing the built-in
     `WHISPER_AHEADS_SMALL` preset**, which supplies OpenAI's published
     alignment heads without needing them baked into the file.
   - The HTTP wrapper may not surface the DTW timestamp field at all → **we fix
     this by linking `libwhisper` directly and reading `t_dtw` per token
     ourselves**, exactly as OpenScreen already did for CTranslate2's `.align()`.

**This POC does the fair test that was never run:** native `libwhisper` link,
DTW enabled with the correct alignment-head preset, reading `t_dtw` directly,
with a proper (non-degenerate-quant) model — then measures word-timestamp
quality **and** speed against the current CTranslate2 baseline on the same
machine, same fixtures, same model size.

### Goal / deliverable

A short **report** (`REPORT.md`) with two verdicts, backed by numbers:

- **Quality:** are whisper.cpp DTW word timestamps within ~50 ms of
  CTranslate2's on the same audio? (median word-boundary delta + gross-failure
  check).
- **Speed:** whisper.cpp RTF on **CPU** and on **GPU (Vulkan, and CUDA if an
  NVIDIA GPU is present)** vs the CTranslate2 INT8 CPU baseline.

### Non-goals (explicitly out of scope for this POC)

- No integration into the OpenScreen Electron app. No changes to any file
  outside `tools/stt-eval/whispercpp-dtw-poc/` except (a) the `.gitignore`
  entries already added for this path's generated artifacts (§1.1) and (b)
  reading — never modifying — the existing CT2 server binary/model for the
  baseline in §2.2.
- No Metal/Apple-Silicon run (the dev machine is Windows; Metal is validated
  later on a Mac — the harness must be written portably so it compiles there
  unchanged, but you are not expected to run it on Mac in this POC).
- No CoreML/ANE encoder path (optional stretch goal only, § 6).
- No language selector, no VAD, no production hardening.

---

## 1. Environment & working directory

**Working directory (inside the OpenScreen repo):**

```
tools/stt-eval/whispercpp-dtw-poc/
```

Everything below lives under this path (`whisper.cpp/` clone, `harness/`,
`fixtures/`, `results/`, `REPORT.md`). A placeholder `README.md` pointing back
at this plan already exists there — replace/extend it as the POC lands, don't
delete the pointer back to this doc.

### 1.1 `.gitignore` (already added — do not re-add)

The repo's root `.gitignore` already excludes this path's generated,
multi-gigabyte artifacts so they never get committed:

```
/tools/stt-eval/whispercpp-dtw-poc/whisper.cpp/
/tools/stt-eval/whispercpp-dtw-poc/build-cpu/
/tools/stt-eval/whispercpp-dtw-poc/build-vulkan/
/tools/stt-eval/whispercpp-dtw-poc/build-cuda/
/tools/stt-eval/whispercpp-dtw-poc/fixtures/*.wav
/tools/stt-eval/whispercpp-dtw-poc/results/
```

What **does** get committed: `harness/` source (the bench program, the
`.mjs` scoring scripts, any `CMakeLists.txt`), `fixtures/refs/*.txt` (the
small ground-truth text files), and the final `REPORT.md` — that's the
actual deliverable and the reproducible harness, without the heavyweight
engine clone/models/build output.

**Toolchain (Windows dev machine):**

- CMake ≥ 3.20, a C++20 compiler (MSVC 2022, already used to build the CT2
  server), Git, Git Bash (for `.sh` scripts), Node.js (for the `.mjs` scoring
  scripts).
- **Vulkan SDK** (LunarG) — required to build the Vulkan backend. If it cannot
  be installed, record that and run CPU-only for whisper.cpp GPU numbers, but
  Vulkan is the strategically important target (non-CUDA GPU) so make a real
  effort to install it.
- **CUDA Toolkit** — only if `nvidia-smi` succeeds (i.e. an NVIDIA GPU is
  present). If not, skip the CUDA build; it is not the point of this POC.

---

## 2. Fixtures & baseline (Phase 0)

### 2.1 Test audio + ground truth

All fixtures are **16 kHz mono PCM16 WAV** with **exact** ground-truth
transcripts. Copy them into `fixtures/`. Primary source locations on this
machine (from prior work):

| File | Source path | Ground-truth transcript |
| --- | --- | --- |
| `jfk.wav` (~11 s) | `C:\Users\camil\AppData\Local\Temp\opencode\jfk.wav` | well-known JFK quote (see below) |
| `librispeech_demo_0..4.wav` (~4–10 s each) | `C:\Users\camil\AppData\Local\Temp\opencode\human\librispeech_demo_{0..4}.wav` | `refs/librispeech_demo_{0..4}.txt` in the prior scratchpad |
| `two-min-clip.wav` (130.32 s) | prior scratchpad `...\4f6f4ad1-...\scratchpad\two-min-clip.wav` | `two-min-ref.txt` alongside it |

Ground-truth `.txt` files and the scoring scripts are in the prior scratchpad:
`C:\Users\camil\AppData\Local\Temp\claude\C--Users-camil-Documents-repos-openscreen-new\4f6f4ad1-0477-45cb-84ba-43d94b6eb302\scratchpad\`
(`refs/*.txt`, `wer.mjs`, `analyze.mjs`, `extract_text.mjs`, `extract_2min.py`).

**If any temp fixture is missing** (temp dirs are volatile), regenerate:

- `jfk.wav` — download from whisper.cpp: `whisper.cpp/samples/jfk.wav` exists in
  the clone (Phase 3). Ground-truth text:
  `And so my fellow Americans, ask not what your country can do for you, ask what you can do for your country.`
- LibriSpeech clips + `two-min-clip.wav` — regenerate with the prior
  `extract_2min.py` (it pulls the HF `hf-internal-testing/librispeech_asr_demo`
  parquet, concatenates 12 consecutive rows with 0.3 s silence gaps into
  `two-min-clip.wav` + writes `two-min-ref.txt`). Needs a Python venv with
  `pyarrow` + `soundfile` (the prior venv at
  `C:\Users\camil\AppData\Local\Temp\opencode\venv\` may still exist; else
  `pip install pyarrow soundfile datasets`).

Copy `wer.mjs`, `analyze.mjs`, `extract_text.mjs` into `harness/` — you will
reuse them unchanged (they read a JSON response and compute normalized
word-level WER / timestamp sanity).

### 2.2 CTranslate2 baseline — re-measure on THIS machine

Do **not** cite the numbers in
[stt-spec.md](./stt-spec.md) §5 (items 5–7) as the comparison baseline — they
may be from a different run. Instead,
re-run the existing CT2 server on this machine, same fixtures, to get a fresh,
same-hardware baseline and fresh CT2 JSON for the timestamp head-to-head.

1. The CT2 server binary is already built in this same repo, one level up
   from this POC's directory
   (`electron/native/bin/win32-x64/ctranslate2-server-ctranslate2-cpu.exe`,
   built via `ct2-build.cmd` at the repo root — do not rebuild it for this
   POC, only read the binary and model). The model is at OpenScreen's
   `whisper-ct2` cache dir (or download `Systran/faster-whisper-small`:
   `model.bin`, `config.json`, `tokenizer.json`, `vocabulary.txt`).
2. Run it in **both** precision modes (see § 3.2 for why both are needed):
   - **int8** (production): `ctranslate2-server-...exe --port 20199 --int8`
     → save JSON as `results/ct2_int8_<name>.json`.
   - **fp16** (matched-precision quality baseline): same binary **without**
     `--int8` → save JSON as `results/ct2_fp16_<name>.json`.
3. For each fixture × each mode, POST to `/inference`, save the JSON, and
   capture wall-clock via `curl -w "%{time_total}"`.
4. Record per-fixture per-mode: WER (`node harness/wer.mjs <ref> <extracted-hyp>`),
   RTF (`time_total / audio_seconds`), and keep the JSON for § 5 timestamp
   comparison. The **fp16** JSON is the one the § 5.1 timestamp head-to-head
   compares against whisper.cpp fp16; the **int8** JSON is the production speed
   baseline.

Read the model size from OpenScreen's `electron/stt/modelManager.ts`: it is
**`Systran/faster-whisper-small`** (Whisper **small, multilingual**, fp16
weights, INT8 at load). **whisper.cpp must use the same size** → `ggml-small.bin`
+ `WHISPER_AHEADS_SMALL`. This is the apples-to-apples constraint.

---

## 3. Build whisper.cpp with DTW + GPU backends (Phase 1)

```bash
cd tools/stt-eval/whispercpp-dtw-poc
git clone https://github.com/ggml-org/whisper.cpp.git
cd whisper.cpp
git checkout <latest release tag>      # e.g. the newest v1.7.x tag; RECORD the exact tag + commit SHA in REPORT.md
```

(This clone lands inside `whisper.cpp/`, which the root `.gitignore` already
excludes — it will not show up in `git status` for the OpenScreen repo.)

#### 3.1 Exact models to download — precision matching (do NOT skew the test)

There is **no fp8** in either ecosystem for Whisper small. The real precision
knobs are: CT2 = fp16 weights on disk + INT8 chosen at load; whisper.cpp = GGML
fp16 **or** block-quant (`q8_0`/`q5_1`/`q4_0`), where **`q8_0` is its int8
analog**. Both `ggml-small.bin` and `Systran/faster-whisper-small` derive from
the **same** OpenAI `whisper-small` (multilingual) fp16 checkpoint — that shared
origin is what makes the comparison valid.

**whisper.cpp — download exactly these two (multilingual `small`, never
`small.en`):**

```bash
# from whisper.cpp/  — the download script pulls from HF ggml-org/whisper.cpp
bash ./models/download-ggml-model.sh small        # → models/ggml-small.bin      (fp16, ~488 MB) — QUALITY runs
bash ./models/download-ggml-model.sh small-q8_0   # → models/ggml-small-q8_0.bin (8-bit,  ~264 MB) — SPEED-vs-int8 runs
```

**Do NOT download / do NOT use** for any measurement:
- `ggml-small-q5_1.bin`, `-q5_0`, `-q4_0` — heavy quant blurs cross-attention;
  this **is the exact model class that poisoned the 2024 test**. Not even as a
  "secondary" run — it only muddies the verdict.
- `ggml-small.en.bin` (or any `.en`) — English-only weights **and** it needs a
  different DTW preset (`WHISPER_AHEADS_SMALL_EN`), so it double-skews the
  multilingual comparison. The preset in § 4 is `WHISPER_AHEADS_SMALL`
  (multilingual) and must stay that way.

**CTranslate2 — one download, two runtime modes (no separate int8 file; the
legacy `*.int8` HF repos were taken private):**

```
Systran/faster-whisper-small   (fp16 weights: model.bin + config.json + tokenizer.json + vocabulary.txt)
  → run A: server WITHOUT --int8  → CT2 fp16   (matched-precision QUALITY baseline)
  → run B: server WITH    --int8  → CT2 int8    (production baseline + matched-precision SPEED)
```

#### 3.2 Which precision pairs with which verdict

| Verdict | whisper.cpp model | CTranslate2 mode | Why this pairing is fair |
| --- | --- | --- | --- |
| **Timestamp QUALITY** (the decisive one) | `ggml-small.bin` (fp16) | `Systran` **fp16** (no `--int8`) | both fp16 → isolates the DTW **algorithm**; zero quant noise on cross-attention |
| **Quant robustness** (does 8-bit hurt timestamps?) | `ggml-small-q8_0.bin` | `Systran` **`--int8`** | confirms each engine's production precision doesn't wreck its own alignment |
| **SPEED — production** | `ggml-small-q8_0.bin` | `Systran` **`--int8`** | matched ~8-bit precision → the only fair speed number |
| **SPEED — fp16 reference** | `ggml-small.bin` (fp16) | `Systran` **fp16** | matched fp16 → sanity cross-check on speed |

Rule of thumb the agent must not violate: **never** compare whisper.cpp **fp16**
speed against CT2 **int8** speed (int8 is faster — it would unfairly slow-label
whisper.cpp), and **never** judge timestamp quality on a `q5_1`/`q4_0` model.
WER (transcript quality) is a model property and should be near-identical across
precisions; the precision-sensitive metric is the **word-boundary timestamp
delta**, so that one gets the clean fp16-vs-fp16 pairing.

Build three variants into separate dirs (skip CUDA if no NVIDIA GPU):

```bash
# CPU (always)
cmake -B build-cpu -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_EXAMPLES=ON
cmake --build build-cpu --config Release -j

# Vulkan (priority GPU target — the whole point of the strategic question)
cmake -B build-vulkan -DCMAKE_BUILD_TYPE=Release -DGGML_VULKAN=1 -DWHISPER_BUILD_EXAMPLES=ON
cmake --build build-vulkan --config Release -j

# CUDA (only if nvidia-smi present)
cmake -B build-cuda -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=1 -DWHISPER_BUILD_EXAMPLES=ON
cmake --build build-cuda --config Release -j
```

Sanity check each build with the bundled sample before writing the harness:

```bash
./build-cpu/bin/whisper-cli -m models/ggml-small.bin -f samples/jfk.wav
```

---

## 4. The DTW harness (Phase 2 — the crux)

Write a standalone C++ program that links `libwhisper` directly. **Do not use
`whisper-server` or the CLI's JSON output** — the whole reason the earlier test
failed is that a wrapper may not surface the DTW field. Read `t_dtw` yourself.

Create `harness/wcpp_dtw_bench.cpp`:

```cpp
// wcpp_dtw_bench.cpp
// Usage: wcpp_dtw_bench <model.bin> <audio-16k-mono.wav> [--lang en]
// Emits ONE JSON object on stdout matching OpenScreen's transcriptionContract
// shape, so harness/{wer,analyze,extract_text}.mjs work unchanged.
//
// KEY POINTS (do not deviate):
//  - dtw_token_timestamps = true, dtw_aheads_preset = WHISPER_AHEADS_SMALL
//    (must match the model size; SMALL multilingual here).
//  - token_timestamps = true (required for per-token timing).
//  - Read whisper_token_data.t_dtw (NOT t0/t1). Units are centiseconds
//    (1 unit = 10 ms) → seconds = t_dtw / 100.0. t_dtw == -1 means "not
//    computed" → that is a FAILURE, see the assertion in § 4.1.

#include "whisper.h"
#define DR_WAV_IMPLEMENTATION
#include "dr_wav.h"          // reuse the copy in whisper.cpp/examples/
#include <cstdio>
#include <string>
#include <vector>
#include <cmath>
#include <chrono>

static std::string json_escape(const std::string& s) { /* escape " \\ and control chars */ }

int main(int argc, char** argv) {
  const char* model_path = argv[1];
  const char* wav_path   = argv[2];
  std::string lang = "en";                 // force en for a deterministic test
  // (parse optional --lang)

  // --- load 16 kHz mono float PCM via dr_wav (fixtures are guaranteed 16k mono PCM16)
  std::vector<float> pcm;                   // fill from dr_wav; assert sampleRate==16000, channels==1

  // --- init context WITH DTW alignment heads
  whisper_context_params cparams = whisper_context_default_params();
  cparams.dtw_token_timestamps = true;
  cparams.dtw_aheads_preset    = WHISPER_AHEADS_SMALL;   // <-- the fix vs the earlier test
  // cparams.use_gpu is true by default; the GPU actually used depends on which
  // build (build-cpu / build-vulkan / build-cuda) this is linked against.
  whisper_context* ctx = whisper_init_from_file_with_params(model_path, cparams);

  whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
  wparams.token_timestamps = true;
  wparams.language         = lang.c_str();
  wparams.print_progress   = false;
  wparams.n_threads        = /* std::thread::hardware_concurrency() */;

  auto t0 = std::chrono::steady_clock::now();
  whisper_full(ctx, wparams, pcm.data(), (int) pcm.size());
  auto t1 = std::chrono::steady_clock::now();
  double elapsed_s = std::chrono::duration<double>(t1 - t0).count();
  double audio_s   = pcm.size() / 16000.0;

  // --- walk segments/tokens, group tokens into words, read t_dtw
  // Word grouping rule (Whisper BPE convention):
  //   * skip special tokens: id >= whisper_token_eot(ctx)
  //   * a NEW word starts when the detokenized token text begins with a space
  //     (leading ' '), OR it is the first non-special token of the segment.
  //   * a word's start = t_dtw of its first token; end = t_dtw of its last token
  //     (or the next word's start if last-token t_dtw is unstable — prefer the
  //     next token's t_dtw as the end bound, matching whisper/faster-whisper).
  //   * word.probability = mean token .p over the word's tokens.
  //
  // Emit JSON:
  // { "text": "...",
  //   "segments": [ { "start": S, "end": E, "text": "...",
  //                   "words": [ {"word":"...","start":s,"end":e,"probability":p}, ... ] } ],
  //   "detected_language": "en",
  //   "backend": "whispercpp-<cpu|vulkan|cuda>",
  //   "timing": { "elapsed_s": <>, "audio_s": <>, "rtf": <elapsed/audio> } }

  whisper_free(ctx);
  return 0;
}
```

Build it with a tiny `harness/CMakeLists.txt` that links against the whisper
target from each build dir (or just `-I whisper.cpp/include -I
whisper.cpp/examples` and link the built `whisper` lib). Produce three binaries
(or one binary run under three PATH/lib configs): `wcpp_dtw_bench_cpu`,
`_vulkan`, `_cuda`.

### 4.1 Mandatory guardrail (this is what would have caught the 2024 failure)

Before trusting any numbers, assert that **DTW actually ran**:

- For `jfk.wav`, compute `Σ |t_dtw − t0|` over all non-special tokens.
- If `t_dtw == -1` for any token, or the sum is `0` (DTW timestamps identical to
  heuristic ones), **STOP**: DTW is not active. Re-check
  `dtw_token_timestamps`, the `WHISPER_AHEADS_SMALL` preset, and that
  `token_timestamps = true`. Do not proceed to measurement until `t_dtw`
  demonstrably differs from `t0` and is monotonic non-decreasing.

Print this check to stderr and record the outcome in `REPORT.md`.

---

## 5. Run the matrix & score (Phase 3)

For every fixture × every available whisper.cpp backend (cpu, vulkan, [cuda]):

1. Run `wcpp_dtw_bench_<backend> models/ggml-small.bin fixtures/<clip>.wav`,
   save stdout to `results/wcpp_<backend>_<clip>.json`.
2. **WER:** `node harness/extract_text.mjs results/wcpp_<backend>_<clip>.json`
   → hypothesis text; `node harness/wer.mjs fixtures/refs/<clip>.txt <hyp>`.
3. **Timestamp sanity:** `node harness/analyze.mjs
   results/wcpp_<backend>_<clip>.json` (monotonicity, last-word-end ≤ duration,
   zero-start count, segments-without-words).
4. **Speed:** read `timing.rtf` from the JSON.

Do the same CT2 INT8 run from § 2.2 if not already captured.

### 5.1 Word-timestamp head-to-head (the quality verdict)

This is the decisive measurement, and it must be **fp16-vs-fp16** to isolate the
DTW algorithm from quantization noise: compare **`wcpp-cpu` on `ggml-small.bin`
(fp16)** against **`ct2_fp16_*` (server without `--int8`)**. For a fixed set of
**~12 anchor words** present in both outputs (use `jfk.wav` — its words are
unambiguous, plus a few from `librispeech_demo_3` which has the 30 s-boundary
"discover"):

- Align whisper.cpp words to CT2 words by matching normalized word text in
  sequence.
- For each matched word, compute `|start_wcpp − start_ct2|` and
  `|end_wcpp − end_ct2|` in ms.
- Report **median** and **p90** of these deltas, plus any word where the delta
  > 200 ms (gross disagreement) as an explicit list.

Optionally add the `faster-whisper` Python reference (`pip install
faster-whisper`, same `Systran/faster-whisper-small` model) as a third column —
it is the source-of-truth DTW both engines approximate.

---

## 6. Report & decision gate (Phase 4)

Write `REPORT.md` with:

1. **Provenance:** whisper.cpp tag + commit SHA, model file + SHA, machine
   (CPU model, GPU model, OS), Vulkan/CUDA SDK versions, thread count.
2. **DTW-active guardrail result** (§ 4.1) — must be PASS.
3. **Quality table:** per fixture, WER for `ct2-fp16`, `ct2-int8`, `wcpp-cpu`
   (fp16), `wcpp-q8_0`, `wcpp-vulkan`, [`wcpp-cuda`]. WER should be
   near-identical across engines **and** precisions — it is a model property;
   divergence signals a decode bug, not a precision effect.
4. **Timestamp head-to-head table** (§ 5.1): median / p90 word-boundary delta
   **fp16-vs-fp16** (`wcpp-cpu` fp16 vs `ct2-fp16`) in ms, plus the
   gross-disagreement list. Add one row **q8_0 vs int8** to show whether 8-bit
   moves the timestamps at all.
5. **Speed table:** RTF per clip, matched precision only —
   **`wcpp-q8_0` vs `ct2-int8`** (production), and **`wcpp` fp16 vs `ct2-fp16`**
   (reference), for CPU and each GPU backend. Report "×real-time" = 1/RTF.
   Headline number from `two-min-clip.wav`, `wcpp-q8_0` vs `ct2-int8`.

### Decision criteria (state PASS/FAIL explicitly for each)

- **Timestamp quality — PASS if:** median word-boundary delta vs CT2 < ~50 ms
  **and** no gross-disagreement words on the anchor set **and** analyze.mjs
  reports no monotonicity breaks / no word-end-past-duration. This is the claim
  the earlier evaluation said was impossible; prove or disprove it with the
  numbers.
- **CPU speed — PASS if:** `wcpp-cpu` RTF is within ~1.3× of `ct2-int8` RTF (i.e.
  no meaningful CPU regression from switching engines).
- **GPU speed — INFORMATIONAL:** report `wcpp-vulkan` (and `wcpp-cuda`) ×
  real-time. Any GPU number materially better than the CPU ~1.2× is the win that
  justifies the whole effort.

These three verdicts feed the next decision (made back in the main session, out
of scope here): **full whisper.cpp** (retire CT2) if quality + CPU speed pass,
vs **hybrid** (CT2 for CPU/CUDA, whisper.cpp for Metal/Vulkan) if CPU regresses.

---

## 7. Checklist for the agent (definition of done)

- [ ] Work done under `tools/stt-eval/whispercpp-dtw-poc/`; no changes to
      `electron/`, `src/`, or any Electron app build/config file.
- [ ] whisper.cpp cloned at a pinned, recorded tag/SHA; **both**
      `ggml-small.bin` (fp16) **and** `ggml-small-q8_0.bin` downloaded; no
      `q5_1`/`q4_0`/`.en` model used anywhere.
- [ ] CT2 baseline captured in **both** fp16 (no `--int8`) and int8 modes.
- [ ] CPU + Vulkan builds succeed (CUDA build too iff NVIDIA present).
- [ ] `wcpp_dtw_bench` links `libwhisper` directly, enables
      `dtw_token_timestamps` + `WHISPER_AHEADS_SMALL`, reads `t_dtw`, emits the
      contract-shaped JSON.
- [ ] Guardrail § 4.1 PASSES (t_dtw ≠ t0, monotonic) — recorded.
- [ ] All fixtures scored for CT2-int8 and every whisper.cpp backend.
- [ ] `REPORT.md` complete with the three explicit PASS/FAIL verdicts and the
      headline ×real-time numbers.
