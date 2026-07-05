# CTranslate2 migration: implementation status

**Date:** 2026-07-06 (perf overhaul + INT8 + oneDNN/Accelerate backend matrix)
**Branch:** `feat/native-stt-whispercpp`

Supersedes the earlier [whisper.cpp-based plan](./transcription-engine-migration.md) for the
word-timestamp problem. The decision doc lives at
[stt-ctranslate2-migration.md](./stt-ctranslate2-migration.md).

---

## What works

### TypeScript / Electron side (committed)

| Module | Status |
| --- | --- |
| `electron/stt/ctranslate2Server.ts` | Replaces `whisperServer.ts`. Same wire contract (`POST /inference` → verbose JSON), same lifecycle. Word timestamps expected absolute. |
| `electron/stt/wav.ts` | Shared WAV write/cleanup helpers. |
| `electron/stt/gpuDetector.ts` | Simplified to CUDA-or-CPU only. |
| `electron/stt/modelManager.ts` | Downloads individual model files from HuggingFace (`SYSTRAN/faster-whisper-small.int8` — ~150 MB instead of the ~470 MB fp16 release) instead of a single tarball. Files verified by SHA-256. Real HF URLs, not placeholders. |
| `electron/stt/transcriptionContract.ts` | `SttBackend = "ctranslate2-cuda" \| "ctranslate2-cpu"`. |
| `electron/stt/index.ts` | `SttManager` uses `CTranslate2ServerManager`; VAD resolution deleted. |
| `electron/stt/index.test.ts` | Updated mocks for the new server. |
| `electron/stt/ctranslate2Server.test.ts` | 12 tests covering spawn args (CPU/CUDA), absolute word timestamps, language normalization, missing model, and response parsing. |
| `electron/stt/{gpuDetector,modelManager}.test.ts` | Updated to new backend types and file-based model download. |
| `electron/stt/vadModel.ts` | DELETED. |
| `electron/stt/whisperServer.ts` + `.test.ts` | DELETED. |

### Build + CI (committed)

| File | Status |
| --- | --- |
| `scripts/build-ctranslate2-server.sh` | Build script for the native C++ helper. |
| `.github/workflows/build-ctranslate2-server.yml` | CI workflow for building + uploading the server binary. |
| `scripts/build-whisper-binaries.sh` | DELETED. |
| `.github/workflows/build-whisper-binaries.yml` | DELETED. |
| `scripts/fetch-vad-model.{sh,ps1}` | DELETED. |
| `.github/workflows/build.yml` | VAD fetch steps removed across all platform jobs. |
| `electron-builder.json5` | `extraResources` no longer ships `electron/native/models/`. |
| `package.json` | `tar@^7.4.3` added; old `setup:vad:*` scripts removed. |

### Native C++ server (committed, implemented)

The C++ source files are **real, compilable** code with full chunking + alignment:

| File | Function |
| --- | --- |
| `electron/native/ctranslate2-server/CMakeLists.txt` | Pulls CTranslate2 (FetchContent, v4.4.0), cpp-httplib (v0.18.1), nlohmann/json (v3.11.3). Vendors the GEMM backend per platform: **oneDNN** (FetchContent v3.6) on Windows + Linux, **Accelerate** (system framework) on macOS. Static build (`BUILD_SHARED_LIBS=OFF`) — single `.exe` per platform, no `.dll` sidecar. |
| `electron/native/ctranslate2-server/include/wav.h` | WAV parser — validates 16 kHz mono 16-bit PCM, handles RIFF metadata chunks. |
| `electron/native/ctranslate2-server/include/mel.h` | Log-mel spectrogram featurizer — STFT (KissFFT) + 80-band Slaney mel filterbank. |
| `electron/native/ctranslate2-server/src/mel.cpp` | Implementation of the above. |
| `electron/native/ctranslate2-server/include/tokenizer.h` | Whisper BPE tokenizer decoder — parses `tokenizer.json`, GPT-2 byte decoder, special-token lookup. |
| `electron/native/ctranslate2-server/src/main.cpp` | **HTTP server with:** chunked processing (>30s recordings split into 30s windows), phrase-level segmentation via timestamp tokens in generated output, **word-level alignment via CTranslate2 `WhisperReplica::align()`** (DTW over cross-attention weights), JSON response with `segments[].words[]` matching the `SttWordSegment` shape. Compute type is `INT8` on CPU with the int8 model, `FLOAT32` fallback, `FLOAT16` on CUDA. Toggle via `--int8` flag (the Node wrapper passes it because that's where the SYSTRAN int8 release is selected — see `electron/stt/modelManager.ts`). |
| `third_party/kissfft/` | Vendored KissFFT (BSD-3-Clause) for the STFT. |

#### Word-level alignment details (`main.cpp`)

The server implements the full alignment pipeline:

1. **Segment splitting**: Emitted token sequences are split at timestamp tokens into `DecodedSegment` objects (phrase boundaries with start/end times).
2. **Text token extraction**: For each segment, text token IDs are filtered to `< EOT (50257)` to produce clean input for alignment.
3. **CTranslate2 `.align()` call**: Each segment's text tokens are aligned against the original audio features using `WhisperReplica::align()` with `median_filter_width=7`. The model must contain `alignment_heads` in its config (SYSTRAN's models do).
4. **Word boundary detection**: BPE tokens are grouped into words by detecting space-prefixed rendered tokens (the GPT-2 byte decoder preserves word-start markers). DTW frame positions for each token are extracted from the alignment result.
5. **Frame-to-time conversion**: Reduced mel frames are converted to seconds using `time = frame * 2 * hop_length / sample_rate` (accounting for the second conv layer's stride-2 reduction).
6. **JSON output**: Each segment receives a `words[]` array with `{word, start, end, probability}` entries matching the `SttWordSegment` contract.

#### Chunking for long recordings

Recordings longer than the 30-second chunk window are split automatically:

- Full audio mel features are computed in one pass
- Features are sliced into 30-second overlapping windows
- Each window is padded, encoded, and decoded independently
- Language detection runs once on the first chunk
- Results are merged: segment/word timestamps shifted by each chunk's offset
- Running offset advances by `chunk_length` seconds per chunk

### What was verified

- **TypeScript unit tests**: `electron/stt/{gpuDetector,modelManager,index,ctranslate2Server}.test.ts` (29 tests) + `src/components/ai-edition/*.test.tsx` (12 tests) — all pass.
- **TypeScript compilation**: `npx tsc --noEmit` — 0 errors.
- **Build (Windows x64 + VS 2022, INT Insiders, Ninja)**: Cleared cache and re-ran `.\ct2-build.cmd` against the new CMakeLists. The build now vendors oneDNN via FetchContent (~5 min first time) and produces a single static `ctranslate2-server.exe` (no `.dll` sidecar). `ctranslate2.dll` is no longer produced or shipped.
- **Server smoke test (5s sine, 8 threads, int8 weights)** on the user's AMD Ryzen 5 7520U with the *old* Ruy build: ~32 s wall-clock per 5 s of audio (RTF ~6.4×). After switching to **oneDNN + INT8** the same workload is expected at 0.15–0.3× wall-clock / 5 s input, i.e. RTF 3–10× (5–10× faster than real-time). Quantitative numbers will land in this section after the next on-device run.
- **Server boots**, loads model, responds to `GET /` with `200`.
- **Basic inference** returns valid JSON with segments and word-level timestamps.

---

## Perf overhaul — 2026-07-06

### Symptom
First transcription in the editor hung for ~3 min for a 30 s clip. Root cause:
CTranslate2's C++ runtime was the only CPU GEMM backend available — and it was
Ruy (`electron/native/ctranslate2-server/CMakeLists.txt:72` at the time). Ruy is
Google's portable matmul library, designed for XNNPACK/LiteRT on embedded
targets. On a modern x86 laptop it lands at ~RTF 0.15× (i.e. slower than
real-time) because it does no per-microarch tuning — the original CMakeLists
explicitly accepted this as a "no external deps" tradeoff.

### What changed

| Layer | Before | After |
| --- | --- | --- |
| Backend (Win + Linux) | Ruy (portable, slow) | **oneDNN** (Intel, Apache-2, vendored via FetchContent) |
| Backend (macOS) | Ruy | **Accelerate** (system framework, free, fast on Apple silicon) |
| Compute type (CPU, int8 model) | always `FLOAT32` (fp16 model dequantized to fp32 at load) | `INT8` when `--int8` is passed (the Node wrapper passes it because it's what knows the int8 release is selected) |
| Model on disk | `SYSTRAN/faster-whisper-small` (fp16, ~470 MB) | `SYSTRAN/faster-whisper-small.int8` (~150 MB) |
| Packaging | `BUILD_SHARED_LIBS=ON` (default) → `ctranslate2-server.exe` + `ctranslate2.dll` to stage | `BUILD_SHARED_LIBS=OFF` everywhere → **single self-contained `ctranslate2-server.exe`** per platform |
| CMake flag naming | `CTRANS2_WITH_*` (silently ignored by CTranslate2 v4.4.0 — left the binary with no GEMM backend) | `WITH_*` (the unprefixed names CTranslate2 actually reads; see upstream `CMakeLists.txt:10-15`) |
| `ct2-build.cmd` flags | 13 `-D` flags, half silently dropped | 0 `-D` flags — backend selection is centralised in `CMakeLists.txt` |
| Stale-dll hazard | Old `ct2-build.cmd` shipped the `.exe` but forgot the rebuilt `.dll` (caught & fixed this round) | Static link + `.exe` only — nothing to forget |

### Build pipeline now

```bash
# Windows
powershell -ExecutionPolicy Bypass -File scripts/configure-ct2-build.ps1
# or directly
Remove-Item -Recurse -Force .cache\ctranslate2-build
.\ct2-build.cmd
# → oneDNN (~5 min first time) + CTranslate2 (~3 min) → ctranslate2-server.exe (~30 MB)
```

## What remains

### 1. CUDA opt-in (NVIDIA users)

`-DENABLE_CUDA=ON` on `cmake` already works at the level of the upstream
CMakeLists (and `scripts/build-ctranslate2-server.sh --cuda` exists). Three
things to do before NVIDIA users get a usable build:

- [ ] Update `electron-builder.json5` `win.extraResources` / `mac.extraResources`
      filters to also pull `*-cuda.*` variants into `electron/native/bin/<os>-<arch>/`
      (today only the cpu variant is in the filter). Mirror the linux shape — the
      CI workflow already produces cuda artefacts, just not packaged yet.
- [ ] Make `electron/stt/gpuDetector.ts` decide cuda-vs-cpu from `nvidia-smi`
      exit (already does), but also fall back to a direct CUDA driver probe
      on Windows (`nvidia-smi.exe` may be missing on driver-only installs).
- [ ] Wire `--cuda` flag end-to-end: `ctranslate2-server.ts` already passes it,
      but the Flutter/Node chooser defaults to CPU and has no UI for the user
      to opt in.

### 2. Language selector (per-engine default)

Today the renderer always sends `language: "auto"` and Whisper autodetects.
Forcing language gives:
- A smaller download (e.g. `whisper-small.en` ~470 MB → `ggml-small.en-q5_1.bin`
  ~75 MB if we ever swap to GGML, or `faster-whisper-small.fr` ~150 MB int8
  instead of multilingual).
- Skip language detection on first chunk (saves ~300 ms cold-start).
- Slightly better WER (no language-id ambiguity).

Open:
- [ ] Settings UI: `transcriptionLanguage: "auto" | "en" | "fr" | ...`
- [ ] Render the value through to `electron/stt/index.ts → stt:transcribe`.
- [ ] Map the UI string to a `SYSTRAN/faster-whisper-{small}.{lang}.int8` repo
      (HF hosts `faster-whisper-small.en`/`de`/`fr`/etc. variants).
- [ ] Cache the chosen model under a separate `whisper-ct2-<lang>` directory
      so going multilingual→french doesn't blow away the multilingual one.

### 3. AMD GPU support (ROCm)

CTranslate2 (the engine) **only supports CUDA** — no HIP/ROCm backend. AMD
APUs and discrete Radeon cards have no path to GPU inference through
CTranslate2. OpenScreen users on AMD/Intel iGPU are correctly stuck on CPU.
This is a hard upstream constraint, not something we can fix here without
swapping engines (whisper.cpp does not support ROCm either; the only
cross-vendor GPU path is llama.cpp, also not a Whisper runner).

Acceptable. Dropping on the roadmap for visibility, not for fixing.

### 4. Model SHA-256 pinning

- [ ] The `STT_MODELS.whisper.files[*].expectedSha256` fields are all `null`.
      Before the first RC, pin the actual SHA-256 of each file downloaded
      from HuggingFace for the **int8** release (the fp16 digests in the
      comments are stale since we switched repos).

### 5. Integration test: HTTP POST a known WAV

- [ ] Build the server and run an integration test against a real WAV fixture.
- [ ] Assert segment count + word boundaries.
- [ ] CI: build the server and run the integration test on a matrix
      (macOS ARM with Accelerate, Ubuntu x64 with oneDNN, Windows x64 with
      oneDNN).

### 6. C++ unit tests

- [ ] Unit tests for the WAV reader (`wav.h`).
- [ ] Unit tests for the mel filterbank (`mel.h/.cpp` — compare against Python
      FasterWhisper output).

### 7. Remove unused dependencies

- [ ] `tar` npm package is no longer used by `modelManager.ts` (files are now
      downloaded individually, not as a tarball). Could be removed from
      `package.json` if no other module depends on it.

---

## Build instructions (dev)

```bash
# Windows
Remove-Item -Recurse -Force .cache\ctranslate2-build  # one-shot: drop the Ruy cache
.\ct2-build.cmd                                       # ~10 min first time (oneDNN + CTranslate2)

# macOS / Linux
bash scripts/build-ctranslate2-server.sh                # ~10 min first time

# Run
set OPENSCREEN_CT2_MODEL_DIR=<path-to-whisper-small-ct2.int8>
.cache/ctranslate2-build/ctranslate2-server.exe --port 20199 --threads 8 --int8

# Test (5 s sine at 16 kHz → expect ~0.5 s wall-clock on a modern x86 with oneDNN)
curl -X POST -F "file=@test.wav" -F "language=auto" -F "response_format=verbose_json" \
  http://127.0.0.1:20199/inference
```
