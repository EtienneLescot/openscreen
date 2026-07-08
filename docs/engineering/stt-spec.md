# STT engine specification: Whisper via whisper.cpp

**Single source of truth for OpenScreen's native speech-to-text pipeline.**
This document replaces the prior CTranslate2-based spec. The engine is now
**whisper.cpp** v1.9.1 with native DTW token timestamps, shipping one adaptive
binary per desktop platform (Metal on Apple Silicon, Vulkan on Windows/Linux,
CPU fallback everywhere).

**Update this file in place** as the STT engine evolves; do not create a new
dated doc per change or per test round.

**Branch:** `feat/native-stt-whispercpp`
**Last updated:** 2026-07-08

The decision record and validation data that led here live in the POC report:
[`tools/stt-eval/whispercpp-dtw-poc/REPORT.md`](../../tools/stt-eval/whispercpp-dtw-poc/REPORT.md).

---

## 1. Current architecture

```
Electron (renderer)
      │  IPC: Float32Array samples + language hint
      ▼
Electron (main process) — electron/stt/
      │  spawn / reuse long-lived process
      ▼
whisper-stt-server (native C++, links whisper.cpp directly)
      │
      ├─ read uploaded 16 kHz mono PCM16 WAV
      ├─ whisper_full() with token_timestamps + DTW (SMALL aheads)
      │    (whisper.cpp handles mel, tokenization, decoding, and
      │     long-form chunking internally — no manual windowing)
      ├─ per token: read t_dtw (native DTW word-end timestamp)
      ├─ group tokens into words; word.start = first token t_dtw,
      │    word.end = next word's first token t_dtw (or segment end)
      ▼
JSON: { segments, wordSegments, detectedLanguage, backend }
      ▼
electron/stt/index.ts (SttManager) — IPC handler, renderer contract
```

### TypeScript / Electron modules

| Module | Role |
| --- | --- |
| `electron/stt/whisperServer.ts` | Server lifecycle, `POST /inference` client, parses verbose_json. |
| `electron/stt/wav.ts` | Shared WAV write/cleanup helpers. |
| `electron/stt/gpuDetector.ts` | Platform binary resolver (no GPU probing; whisper.cpp picks the backend at runtime). |
| `electron/stt/modelManager.ts` | Downloads the single GGML model file from HuggingFace, verifies SHA-256, atomic write. |
| `electron/stt/transcriptionContract.ts` | Shared IPC types (`SttBackend`, `SttWordSegment`, `SttPhraseSegment`). |
| `electron/stt/index.ts` | `SttManager` — IPC entry point, wires the pieces together. |

### Model

**`ggml-small-q8_0.bin`** from `ggerganov/whisper.cpp` (Whisper `small`,
multilingual, q8_0 quantized, ~264 MB). Precision is baked into the GGML file;
there is no runtime `--int8` flag. The file is downloaded once into the user
app-data cache and SHA-256 verified.

> Repo note: this is `ggerganov/whisper.cpp`, **not** `ggml-org/whisper.cpp`.
> The GitHub *engine* repo moved to the `ggml-org` org, but the HuggingFace
> *model-file* repo never moved — `ggml-org/whisper.cpp` on HuggingFace is a
> different, access-gated repo that 401s on every file (confirmed via curl,
> 2026-07-08). whisper.cpp's own `models/download-ggml-model.sh` pulls from
> `ggerganov/whisper.cpp` — that's the one to match.

### Native C++ server (`electron/native/whisper-stt/`)

| File | Function |
| --- | --- |
| `CMakeLists.txt` | Pulls whisper.cpp v1.9.1 (FetchContent), cpp-httplib v0.18.1, nlohmann/json v3.11.3. Enables Metal (macOS arm64), Vulkan (Windows/Linux x64), CPU fallback always. Static backend linking into `whisper.dll`/`ggml.dll` — one helper executable plus ggml shared libraries per platform. |
| `src/main.cpp` | HTTP server: `GET /` readiness probe, `POST /inference` (multipart WAV → verbose_json). Runs `whisper_full()` with `dtw_token_timestamps=true`, `dtw_aheads_preset=WHISPER_AHEADS_SMALL`, `flash_attn=false`. Implements the §4.1 DTW-active guardrail and reports the actual runtime backend via `ggml_backend_dev_name()`. |

### Word-level alignment pipeline

1. **Decode** — `whisper_full()` emits phrase segments and per-token data.
2. **DTW timestamp** — each non-special token has `t_dtw` in centiseconds from
   whisper.cpp's native DTW (using the SMALL aheads preset). `t_dtw == -1` or a
   zero `Σ|t_dtw − t0|` triggers a hard 500 error (the §4.1 guardrail).
3. **Word grouping** — BPE tokens are grouped into words: a new word starts when
   the detokenized text begins with a space or at the segment's first token.
4. **Word range** — `word.start = t_dtw of the word's first token` (seconds);
   `word.end = t_dtw of the next word's first token`, or the segment's `t1` for
   the last word in the segment. This yields monotonic, gap-free ranges.

### Long-form recordings

whisper.cpp's `whisper_full()` handles recordings longer than 30 s internally.
OpenScreen does not implement its own chunking; the POC validated a 130 s clip
at WER 0.076 with full coverage.

---

## 2. Decision rationale: why whisper.cpp (now)

The previous CTranslate2-based stack worked but had a hard ceiling: CTranslate2
has no Metal or Vulkan backend, so Apple Silicon and AMD GPUs ran CPU-only. A
self-contained whisper.cpp DTW POC was run to see whether a *fair* whisper.cpp
configuration could match CTranslate2's timestamp quality and CPU speed while
also unlocking GPU acceleration on those platforms.

**POC results** (full numbers in `tools/stt-eval/whispercpp-dtw-poc/REPORT.md`):

- whisper.cpp native DTW word timestamps agree with CT2's `.align()` to
  **~20 ms median** on the word-end concept.
- The §4.1 "DTW-active" guardrail passed 28/28 fixtures; the failure modes that
  killed earlier whisper.cpp attempts were identified as `flash_attn=1` silently
  disabling DTW and using a model without alignment-head data.
- whisper.cpp CPU (q8_0) is **1.5–2.9× faster** than CT2 int8 on every fixture.
- **Vulkan on an AMD Radeon** hit **2.0–5.3× real-time** — a GPU path CT2 cannot
  reach at all.
- q8_0 matches fp16 on WER and timestamp quality, at ~264 MB vs ~465 MB.

**Decision:** move the STT engine to **whisper.cpp** v1.9.1 with native DTW,
on all three platforms, from a single binary per platform that adapts to
Metal/Vulkan/CPU at runtime. CTranslate2 code, build scripts, CI, and packaging
have been removed.

### Constraints checklist

| Constraint | How this stack meets it |
| --- | --- |
| Electron desktop, Windows + macOS + Linux | Native C++ server per platform (`electron/native/bin/<os>-<arch>/`), no Python |
| Local/offline | No network calls at inference time |
| Heterogeneous hardware, GPU or not | Metal (Apple Silicon), Vulkan (AMD/Intel/NVIDIA on Windows/Linux), CPU fallback automatically |
| Long recordings (hours) | whisper.cpp's internal long-form handling (validated to 130 s) |
| Multilingual | Same Whisper `small` multilingual weights; ~99 languages |
| Fast | q8_0 CPU already beats CT2 int8; Vulkan/Metal deliver large GPU speedups |
| Decent accuracy | Model property — q8_0 matches fp16 on WER |
| Word-level timestamps, correct anywhere in the recording | Native DTW via whisper.cpp `t_dtw`, validated against CT2 `.align()` |
| Reasonable download size | ~264 MB q8_0 file, smaller than the prior ~483 MB fp16 CT2 model directory |

### Non-goals (this migration)

- CoreML/ANE encoder (optional later; Metal already covers Apple GPU).
- ROCm/HIP (Vulkan is the portable AMD path).
- A settings UI for language / model size (`auto` detection is retained).

---

## 3. History

### 3.1 Pre-CTranslate2 (whisper.cpp + forced alignment)

OpenScreen ran `whisper.cpp`'s `whisper-server` plus `onnxruntime-node` forced
alignment. The alignment layer was removed after hitting model/SHA and fragile
CTC matching issues. whisper.cpp's own word timestamps and Silero VAD were also
tried and found unreliable in the configurations tested at the time.

### 3.2 CTranslate2 era

The engine moved to **CTranslate2** (the C++ core behind `faster-whisper`) with
a custom native server. Word timestamps came from CTranslate2's `.align()`
(DTW over cross-attention weights). This stack produced correct timestamps but
was CPU-only on Apple Silicon and AMD GPUs, and required a ~483 MB fp16 model
directory plus manual mel featurization, tokenizer, and long-form chunking in
our own C++ code. Several chunk-boundary and mel-featurizer bugs were fixed
in this period (documented in the pre-migration version of this file, now
superseded).

### 3.3 whisper.cpp return (this migration)

The DTW POC proved that a correctly configured whisper.cpp link produces
competitive timestamps and better speed/GPU coverage. The CTranslate2 server,
build scripts, CI workflow, and model download logic were replaced with the
whisper.cpp-based helper and single GGML file described in §1.

---

## 4. Build & run (dev)

```bash
# All platforms — build the helper (installs platform SDK deps first if needed)
bash scripts/build-whisper-stt.sh

# Windows (local MSVC + Vulkan SDK already installed)
# The script uses a short build path (C:/wstbuild by default) to avoid MAX_PATH
# issues inside whisper.cpp's vulkan-shaders-gen sub-project.

# Run the helper directly for manual testing
set OPENSCREEN_WHISPER_MODEL=%APPDATA%\Electron\stt-models\whisper-ggml\ggml-small-q8_0.bin
electron\native\bin\win32-x64\whisper-stt-server.exe --port 20199 --threads 8

# Test
curl -X POST -F "file=@test.wav" -F "language=auto" -F "response_format=verbose_json" \
  http://127.0.0.1:20199/inference
```

The helper's stderr logs the actual backend it bound (e.g.
`whispercpp-vulkan`, `whispercpp-metal`, `whispercpp-cpu`).

---

## 5. Implementation changelog

### whisper.cpp migration — 2026-07-08

Replaced the CTranslate2 engine with whisper.cpp v1.9.1:

- Added `electron/native/whisper-stt/` with CMake build + httplib server.
- Added `scripts/build-whisper-stt.sh` and `.github/workflows/build-whisper-stt.yml`
  (Metal/Vulkan/CPU matrix).
- Replaced `electron/stt/ctranslate2Server.ts` with `whisperServer.ts`,
  `gpuDetector.ts` with a platform-binary resolver, and `modelManager.ts` with
  a single GGML file download.
- Updated `electron-builder.json5` to package the helper + ggml sidecars on
  macOS, Windows, and Linux.
- Removed all CTranslate2 native code, scripts, CI, and dependencies.

Validated: JFK fixture transcribes correctly with backend `whispercpp-vulkan`,
DTW guardrail passes, `npm run test` 598/598 pass, `npm run build-vite` green.

---

## 6. Open items

- [ ] **CUDA variant (NVIDIA max perf).** Vulkan already accelerates NVIDIA, but
      a dedicated CUDA build can be added later via `OSC_ENABLE_CUDA=ON`. The
      build script and CMake support the flag; the default matrix does not
      build it yet.
- [ ] **Language selector (per-engine default).** Today the renderer always
      sends `language: "auto"`. Forcing a language would skip detection on the
      first window and slightly improve WER. Needs: settings UI, a render path
      to `stt:transcribe`, and mapping the UI string to a whisper.cpp language
      token.
- [ ] **CoreML/ANE encoder (optional).** Metal already covers Apple GPU; CoreML
      is a future perf refinement.
- [ ] **Integration test: HTTP POST a known WAV.** Build the server, assert
      segment count + word boundaries against a fixture, on a CI matrix
      (macOS ARM/Metal, Ubuntu x64/Vulkan, Windows x64/Vulkan).
- [ ] **C++ unit tests** for the WAV reader and the §4.1 DTW guardrail.
- [ ] **Caption sync fine-tuning.** If DTW word-start feels consistently late
      in the editor (because `t_dtw` is word-end/commit), adjust by using the
      previous word's `t_dtw` as the start bound or mixing with `token.t0`.
      Record the final choice here once verified with real recordings.

---

## 7. Related documents

- [`tools/stt-eval/whispercpp-dtw-poc/REPORT.md`](../../tools/stt-eval/whispercpp-dtw-poc/REPORT.md) —
  validation data: timestamp accuracy, WER, RTF, adaptivity per backend.
- [`docs/engineering/stt-whispercpp-migration-plan.md`](./stt-whispercpp-migration-plan.md) —
  step-by-step migration plan (now executed).
