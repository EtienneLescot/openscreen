# Implementation plan — migrate OpenScreen STT to whisper.cpp (platform- & GPU-adaptive), remove CTranslate2

**Author handoff:** this document is written to be executed by a coding agent
end-to-end. It assumes the whisper.cpp DTW POC has already landed and passed
(see [`tools/stt-eval/whispercpp-dtw-poc/REPORT.md`](../../tools/stt-eval/whispercpp-dtw-poc/REPORT.md)).
Follow the phases in order; each ends with a concrete "done when" gate.

**Branch:** `feat/native-stt-whispercpp` (continue on it).
**Supersedes on completion:** everything in
[`stt-spec.md`](./stt-spec.md) that describes CTranslate2 as the shipping
engine — rewrite that doc in Phase 7, do not leave both live.

---

## 0. Goal, and what the POC already settled

**Goal:** OpenScreen transcribes on **whisper.cpp** on every platform, using
whatever GPU the host actually has (Apple Metal, AMD/Intel/NVIDIA via Vulkan,
NVIDIA via CUDA optionally), and **falls back to CPU automatically** when there
is no usable GPU — from a single binary per platform. All CTranslate2 code,
build scripts, CI, and packaging are removed.

**The POC already proved the risky parts** (numbers in `REPORT.md`, same repo):

- whisper.cpp native DTW word timestamps agree with CT2's `.align()` to
  **~20 ms median** on the word-end concept (§4/§6.1 of the report). The
  §4.1 "DTW-active" guardrail (assert `t_dtw ≠ t0`, monotonic) passed 28/28.
- whisper.cpp CPU (q8_0) is **1.5–2.9× faster** than CT2 int8 on every fixture.
- **Vulkan on an AMD Radenon** hit **2.0–5.3× real-time** — a GPU path CT2
  cannot reach at all. This is the entire reason for the migration.
- q8_0 matches fp16 on both WER and timestamp quality, at ~264 MB vs ~465 MB
  and higher speed → **q8_0 is the default shipping model.**
- The `flash_attn=1` trap (silently disables DTW in v1.9.1) is real and is
  caught by the guardrail — the new helper must keep `flash_attn = false`.

Pin the **same whisper.cpp the POC used**: tag **`v1.9.1`**, commit
`f049fff95a089aa9969deb009cdd4892b3e74916`, repo
`https://github.com/ggml-org/whisper.cpp.git`.

### Non-goals (this migration)
- CoreML/ANE encoder (optional later; Metal already covers Apple GPU).
- ROCm/HIP (Vulkan is the portable AMD path; do not add HIP).
- A settings UI for language / model size (keep the current `auto` behaviour).
- Rewriting the renderer (`src/lib/captioning/transcribe.ts`) beyond a comment
  refresh — the IPC wire shape is preserved on purpose.

---

## 1. Architecture decisions (locked — do not re-litigate mid-build)

### 1.1 One helper, HTTP-shaped, model resident

Keep the **long-lived HTTP helper** shape the CT2 server already uses (spawn →
poll `/` for 200 → `POST /inference` with a multipart WAV → JSON back). This
preserves the entire `electron/stt` lifecycle and keeps the model resident
across the many transcriptions in one editing session (reloading a 264 MB
model per request is unacceptable).

The helper is **our own** C++ program that links `libwhisper` directly and
reads `t_dtw` itself — **not** upstream `whisper-server`, which the POC found
does not reliably surface the DTW field. Reuse the already-written, already-
validated POC harness `tools/stt-eval/whispercpp-dtw-poc/harness/wcpp_dtw_bench.cpp`
as the transcription core; wrap it in an httplib `/inference` loop lifted from
the old `ctranslate2-server/src/main.cpp`.

**New helper location:** `electron/native/whisper-stt/`
**New binary name:** `whisper-stt-server` (staged as
`electron/native/bin/<os>-<arch>/whisper-stt-server[.exe]`).

whisper.cpp's `whisper_full` handles mel featurization, tokenization, **and
long-form (>30 s) chunking internally**, so the old server's vendored
`mel.cpp`, `tokenizer.h`, `wav.h` parser, `kissfft/`, and the manual
seek-advance chunking are all **deleted, not ported**. The POC's 130 s clip
got full coverage at WER 0.076 through plain `whisper_full`, so the item-4/item-7
chunking bug surface disappears entirely.

### 1.2 GPU adaptivity: one binary per platform, runtime backend selection

whisper.cpp/ggml can build each compute backend as a **dynamically loaded
module** (`-DGGML_BACKEND_DL=ON -DGGML_CPU_ALL_VARIANTS=ON`) and pick the best
available at runtime via `ggml_backend_load_all()`, cleanly falling back to CPU
when a GPU/driver/loader is absent. That is the mechanism that makes "fully
adaptive from one binary" real.

| Platform | Build flags | GPUs covered | CPU fallback |
| --- | --- | --- | --- |
| **macOS arm64** | `-DGGML_METAL=ON` (default), Metal shaders embedded | Apple Silicon GPU | automatic (ggml) |
| **macOS x64** | CPU only (`-DGGML_METAL=OFF`) | — (Intel Macs, no useful Metal target) | n/a |
| **Windows x64** | `-DGGML_VULKAN=ON -DGGML_BACKEND_DL=ON -DGGML_CPU_ALL_VARIANTS=ON` | AMD + Intel + NVIDIA via Vulkan | automatic when no Vulkan device/loader |
| **Linux x64** | same as Windows | AMD + Intel + NVIDIA via Vulkan | automatic |
| **Windows/Linux + NVIDIA (optional, later)** | add `-DGGML_CUDA=ON` variant | NVIDIA (max perf) | — |

**Rationale:** Vulkan is a single build that accelerates *all three* desktop
GPU vendors and its loader (`vulkan-1.dll` / `libvulkan.so.1`) ships with
modern drivers; when it's missing, ggml's DL registry falls back to a CPU
variant. So on Windows/Linux we ship **one** `whisper-stt-server` plus its
ggml backend modules and get GPU-or-CPU with no Node-side probing. CUDA stays
**opt-in and deferred** (Vulkan already accelerates NVIDIA; a dedicated CUDA
variant is a later perf refinement, mirroring today's still-open CUDA item).

**Consequence for `gpuDetector.ts`:** it stops probing `nvidia-smi` and stops
choosing between cuda/cpu binaries. It becomes a pure **path resolver** for the
single per-platform binary. The *actual* backend that ran (metal / vulkan /
cpu) is reported **by the helper** in its `/inference` JSON `backend` field
(read from `ggml_backend_name()` of the device whisper selected), which is more
honest than an OS-side guess.

### 1.3 Precision = model file, not a runtime flag

whisper.cpp bakes precision into the GGML file. There is no `--int8`. Ship
**`ggml-small-q8_0.bin`** (multilingual small, ~264 MB) as the single default
model. Drop the `useInt8` plumbing entirely. (Keep fp16 as an optional
higher-quality download behind a constant, but default to q8_0 — the POC shows
q8_0 matches fp16 on WER and DTW while being smaller and faster.)

### 1.4 Word [start, end] construction (validated in POC §4)

`t_dtw` is a per-token **word-end/commit** timestamp (centiseconds; `-1` =
not computed → hard error). Build each word's range exactly as the POC's
`score_all.mjs` validated:

- `word.start = t_dtw of the word's first token`
- `word.end   = t_dtw of the next word's first token` (or the segment's `t1`
  for the last word in a segment).

This yields monotonic, gap-free per-word ranges. Keep `flash_attn = false`,
`dtw_token_timestamps = true`, `dtw_aheads_preset = WHISPER_AHEADS_SMALL`,
`token_timestamps = true`. A caption-sync sanity check is in Phase 6.

---

## 2. Phase 1 — the native helper (`electron/native/whisper-stt/`)

Create the directory and these files.

### 2.1 `CMakeLists.txt`

Model it on the existing `ctranslate2-server/CMakeLists.txt` (MSVC static-CRT
handling, `NOMINMAX`/`WIN32_LEAN_AND_MEAN`, httplib + nlohmann/json via
FetchContent) but swap the engine:

```cmake
cmake_minimum_required(VERSION 3.20)
project(openscreen-whisper-stt LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Pin whisper.cpp exactly as the POC (REPORT.md provenance).
set(WHISPER_REPO "https://github.com/ggml-org/whisper.cpp.git" CACHE STRING "")
set(WHISPER_REF  "v1.9.1" CACHE STRING "")

# Adaptive backend knobs — overridden per-platform by the build script.
option(OSC_ENABLE_VULKAN "Build ggml Vulkan backend" OFF)
option(OSC_ENABLE_METAL  "Build ggml Metal backend"  OFF)
option(OSC_ENABLE_CUDA   "Build ggml CUDA backend"   OFF)

include(FetchContent)
# whisper.cpp: enable DL backend registry so CPU fallback is guaranteed
set(GGML_BACKEND_DL ON  CACHE BOOL "" FORCE)
set(GGML_CPU_ALL_VARIANTS ON CACHE BOOL "" FORCE)
set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_TESTS   OFF CACHE BOOL "" FORCE)
if(OSC_ENABLE_VULKAN)
  set(GGML_VULKAN ON CACHE BOOL "" FORCE)
endif()
if(OSC_ENABLE_METAL)
  set(GGML_METAL ON CACHE BOOL "" FORCE)
  set(GGML_METAL_EMBED_LIBRARY ON CACHE BOOL "" FORCE)
endif()
if(OSC_ENABLE_CUDA)
  set(GGML_CUDA ON CACHE BOOL "" FORCE)
endif()

FetchContent_Declare(whisper GIT_REPOSITORY ${WHISPER_REPO} GIT_TAG ${WHISPER_REF} GIT_SHALLOW TRUE)
FetchContent_Declare(httplib GIT_REPOSITORY https://github.com/yhirose/cpp-httplib.git GIT_TAG v0.18.1 GIT_SHALLOW TRUE)
FetchContent_Declare(json    GIT_REPOSITORY https://github.com/nlohmann/json.git       GIT_TAG v3.11.3 GIT_SHALLOW TRUE)
FetchContent_MakeAvailable(whisper httplib json)

add_executable(whisper-stt-server src/main.cpp)
target_link_libraries(whisper-stt-server PRIVATE whisper httplib::httplib nlohmann_json::nlohmann_json)
if(WIN32)
  target_compile_definitions(whisper-stt-server PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN _WIN32_WINNT=0x0A00)
  set_target_properties(whisper-stt-server PROPERTIES WIN32_EXECUTABLE OFF)
endif()
```

> Note: with `GGML_BACKEND_DL=ON`, ggml produces sidecar backend libraries
> (`ggml-cpu-*.{dll,so}`, `ggml-vulkan.*`, etc.) that must be **staged next to
> the binary** (Phase 4). Confirm the exact output filenames from the build
> tree and thread them through the staging step — do not hardcode a guess.

### 2.2 `src/main.cpp`

Merge the POC harness's transcription core with an httplib server loop:

- **Startup:** parse `--model <path> --port <n> --host 127.0.0.1
  --threads <n>`. Load the context once with
  `whisper_context_default_params()` mutated to
  `dtw_token_timestamps = true`, `dtw_aheads_preset = WHISPER_AHEADS_SMALL`,
  `flash_attn = false`, `use_gpu = true`. Log the chosen backend via
  `ggml_backend_dev_name(...)` / the device whisper reports, and keep it for
  the response `backend` field.
- **`GET /`** → 200 (readiness probe the TS manager polls).
- **`POST /inference`** (multipart, field `file` = WAV, field `language`,
  field `response_format=verbose_json` — same contract the CT2 client sends):
  1. Parse the uploaded WAV to 16 kHz mono float PCM (use whisper.cpp's bundled
     `dr_wav.h`, as the POC harness does — assert 16 kHz / mono / PCM16, the
     renderer already guarantees this via `writeSamplesAsWav`).
  2. `whisper_full_default_params(WHISPER_SAMPLING_GREEDY)` with
     `token_timestamps = true`, `language = <lang or "auto">`,
     `n_threads = <arg>`, `print_progress = false`. Run `whisper_full`.
  3. **Guardrail (keep from POC §4.1):** if any non-special token has
     `t_dtw == -1`, or `Σ|t_dtw−t0| == 0`, return HTTP 500 with a clear
     "DTW inactive" body. This is the exact 2024 failure mode; never let it
     ship silently.
  4. Walk segments → tokens, group into words (new word when detokenized text
     starts with a space or is the segment's first non-special token), build
     `word.start/end` per §1.4, `probability = mean token p`.
  5. Emit `verbose_json`: `{ segments:[{text,start,end,words:[{word,start,end,probability}]}],
     detected_language, backend, timing:{elapsed_s,audio_s,rtf} }` — the exact
     shape `ctranslate2Server.ts` already parses (`Ct2JsonSegment` /
     `Ct2JsonWord`), so the TS parser barely moves.
- **Concurrency:** whisper contexts are not thread-safe; serialize `/inference`
  behind a mutex (single-flight, matching the TS-side `inFlight` queue).
- **Units:** `t_dtw` is centiseconds → seconds = `t_dtw / 100.0`.

**Done when:** built locally on Windows (Vulkan) via Phase 3's script,
`POST /inference` with `jfk.wav` returns segments+words, the guardrail passes,
and RTF roughly matches the POC's `wcpp Vulkan q8_0` numbers.

---

## 3. Phase 2 — build script & CI

### 3.1 `scripts/build-whisper-stt.sh` (replaces `build-ctranslate2-server.sh`)

Same structure as the CT2 script (host detection → `os_arch_tag` →
`build_variant` → copy into `electron/native/bin/<os>-<arch>/`), but:

- Pass the platform flags from §1.2:
  - macOS arm64 → `-DOSC_ENABLE_METAL=ON`
  - macOS x64 → none (CPU)
  - Windows/Linux → `-DOSC_ENABLE_VULKAN=ON`
  - optional `ENABLE_CUDA=ON` env → add a second `*-cuda` variant with
    `-DOSC_ENABLE_CUDA=ON` (deferred; wire the flag but the default matrix does
    not build it).
- After `cmake --build`, **stage the binary AND its ggml backend sidecar
  libraries** into `electron/native/bin/<os>-<arch>/`. Enumerate them from the
  build tree (`ggml-*.{dll,so,dylib}`, `whisper.{dll,so,dylib}` if shared) —
  do not assume a fixed list.
- Rename the npm script: `package.json` →
  `"build:whisper-binaries": "bash scripts/build-whisper-stt.sh"` (remove
  `build:ctranslate2-binaries`).

### 3.2 CI: `.github/workflows/build-whisper-stt.yml` (replaces `build-ctranslate2-server.yml`)

Matrix:

| Runner | arch | Backend build deps to install |
| --- | --- | --- |
| `macos-latest` | arm64 | none (Metal ships with Xcode) |
| `macos-13` | x64 | none (CPU) |
| `ubuntu-latest` | x64 | Vulkan SDK (LunarG apt repo) + `glslc` (`shaderc`) |
| `windows-latest` | x64 | Vulkan SDK (`humbletim/setup-vulkan-sdk` or LunarG silent installer) |

- Install the Vulkan SDK on the Linux/Windows legs (needed to *compile* shaders;
  the runtime loader is not bundled).
- Run `bash scripts/build-whisper-stt.sh`, then tar+upload
  `electron/native/bin/<os>-<arch>/` (binary + ggml sidecars) as an artifact
  named `whisper-stt-<os>-<arch>`.
- Keep the `push: paths:` trigger, repointed at
  `scripts/build-whisper-stt.sh`, `electron/native/whisper-stt/**`, and the
  new workflow file.
- Update `build.yml`'s STT comment block (lines ~47–50) from "CTranslate2
  server provides word timestamps via `.align()`" to the whisper.cpp DTW story,
  and make sure `build.yml` downloads/consumes the renamed artifacts if it
  bundles them (today it downloads installer artifacts, not the server tarballs
  directly — verify and adjust if the binaries are fetched anywhere).

**Done when:** the new workflow builds green on all four legs and each artifact
contains a runnable `whisper-stt-server` plus its backend sidecars.

---

## 4. Phase 3 — Electron/TypeScript integration (`electron/stt/`)

Preserve the IPC contract shape; swap the internals.

### 4.1 `transcriptionContract.ts`
- `SttBackend` → `"whispercpp-metal" | "whispercpp-vulkan" | "whispercpp-cuda" | "whispercpp-cpu"`.
  The renderer only imports the segment shapes, not the union (per the file's
  own note), so this is safe.
- Refresh the `.align()` DTW comments to whisper.cpp DTW (`t_dtw` /
  `WHISPER_AHEADS_SMALL`).

### 4.2 `ctranslate2Server.ts` → rename to `whisperServer.ts`
- Rename the class `CTranslate2ServerManager` → `WhisperServerManager`.
- Drop the `useInt8` option (precision is the model file now).
- Change the resolved-binary default backend from `"ctranslate2-cpu"` to
  `"whispercpp-cpu"`, and set the reported backend from the JSON `backend`
  field the helper returns (fall back to `whispercpp-cpu`).
- Everything else (port pick, `pollUntilReady`, stderr ring buffer, WAV temp
  file, multipart POST, `verbose_json` parse, single-flight queue) stays —
  the wire shape is identical.
- Rename the env override `OPENSCREEN_CT2_SERVER_EXE` → `OPENSCREEN_WHISPER_SERVER_EXE`.

### 4.3 `gpuDetector.ts`
- Delete `probeNvidia` / `detectGpuBackend`'s CUDA branch. New `detectGpuBackend`
  just returns the platform's single binary backend tag (Mac→`whispercpp-metal`
  on arm64 else `whispercpp-cpu`; Win/Linux→`whispercpp-vulkan`). The *real*
  backend is corrected from the helper's response at runtime, so this is only
  the binary-name selector.
- `binaryNameForBackend` → `whisper-stt-server[.exe]` (single name; the backend
  suffix scheme goes away, since there's one binary per platform — keep the
  `candidateBinaryPaths` search locations and the `.exe`/bare dual-name trick).
- Update `resolveBinaryPath` accordingly.

### 4.4 `modelManager.ts`
- Replace the CT2 4-file descriptor with a **single GGML file**:
  `ggml-small-q8_0.bin` from `https://huggingface.co/ggml-org/whisper.cpp/resolve/main/ggml-small-q8_0.bin`
  (cacheDir e.g. `whisper-ggml`). Keep SHA-256 verify, atomic `.partial`
  rename, retry/backoff, progress — all reusable as-is.
- `modelPaths()` returns the **file path** (not a directory); update
  `areModelsPresent` to check the single file's presence/size.
- Update the `start()` call in `index.ts` to pass the model **file** path and
  drop `useInt8: true`.
- **Pin the SHA-256** of `ggml-small-q8_0.bin` from the POC's recorded digest
  (`49C8FB02...` in `REPORT.md` §1) instead of leaving it `null`.

### 4.5 `index.ts`
- `CTranslate2ServerManager` → `WhisperServerManager`; drop `useInt8`; refresh
  the class doc comment (DTW via whisper.cpp, not `.align()`).

### 4.6 Tests (`electron/stt/*.test.ts`)
- Rename `ctranslate2Server.test.ts` → `whisperServer.test.ts`; update spawned-
  binary name, dropped `useInt8`, new backend tags.
- `gpuDetector.test.ts`: rewrite the backend-selection cases for the new matrix.
- `modelManager.test.ts`: single-file download/verify instead of the 4-file dir.
- `index.test.ts`: backend tag + no `useInt8`.

**Done when:** `npm test` passes and a dev run (Phase 6) transcribes end-to-end.

---

## 5. Phase 4 — packaging (`electron-builder.json5`)

- **macOS** and **Windows** already glob `electron/native/bin/<platform>-*/*`,
  so the renamed binary + ggml sidecars flow in automatically — just refresh
  the CT2 comment block (lines ~34–42) to whisper.cpp.
- **Linux is currently missing** an `extraResources` entry for
  `electron/native/bin` — add one filtered to `linux-*/*` so the helper +
  sidecars actually ship in the AppImage/deb/pacman (pre-existing gap; the CT2
  server never shipped on Linux).
- Confirm whether any ggml sidecar is a `.node`/dlopen'd `.so` that must be in
  `asarUnpack` — the binaries live under `extraResources` (outside asar) so
  they're already unpacked, but double-check the helper resolves its sidecars
  from its own directory at runtime (ggml `ggml_backend_load_all()` searches
  the executable dir).
- Do **not** bundle the Vulkan loader (`vulkan-1.dll`/`libvulkan.so.1`) — it is
  a driver/system component; bundling risks version conflicts. ggml falls back
  to CPU if it's absent.

**Done when:** `electron-builder --dir` on each OS produces an unpacked app
whose `resources/electron/native/bin/<os>-<arch>/` has the helper + sidecars,
and the app transcribes from that unpacked build.

---

## 6. Phase 5 — remove all CTranslate2 code (exact list)

Delete (after Phases 1–5 are green so nothing references them):

**Native / build:**
- `electron/native/ctranslate2-server/` (entire dir: `CMakeLists.txt`,
  `src/main.cpp`, `src/mel.cpp`, `include/{wav.h,mel.h,tokenizer.h}`,
  `third_party/kissfft/*`, `README.md`).
- Built CT2 artifacts in `electron/native/bin/win32-x64/`:
  `ctranslate2-server-cpu.exe`, `ctranslate2-server-ctranslate2-cpu.exe`,
  `ctranslate2.lib`, `ctranslate2.dll`, `dnnl.dll`.
- `scripts/build-ctranslate2-server.sh`, `ct2-build.cmd`,
  `scripts/configure-ct2-build.ps1`, `scripts/start-ct2-server.cmd`,
  `scripts/stt-wrapper.bat`.
- `scripts/stt-dev-server.mjs` and `scripts/e2e-stt-smoke.mjs` — port to the
  new helper if still useful, else delete (check contents first; if they only
  spawn the CT2 server, replace with whisper-stt equivalents or drop).
- `.github/workflows/build-ctranslate2-server.yml` (replaced by
  `build-whisper-stt.yml`).

**TS:**
- `electron/stt/ctranslate2Server.ts` + `.test.ts` (replaced by
  `whisperServer.ts` + test).

**Config:**
- `package.json`: remove `build:ctranslate2-binaries`; remove the `tar`
  dependency (already an open item — `modelManager` downloads a single file).
  Run `npm install` to update `package-lock.json`.
- `.gitignore`: change the `/.cache/ctranslate2-build` entry to the whisper
  build-cache path used by the new script.
- Grep-sweep remaining string references: `OPENSCREEN_CT2_MODEL_DIR`,
  `ctranslate2`, `ct2`, `CTranslate2` across `scripts/`, `electron/`, `docs/`,
  workflows, and `design/*.html` — repoint or remove each. (The POC dir under
  `tools/stt-eval/whispercpp-dtw-poc/` legitimately references CT2 as the
  *baseline it compared against* — leave it; it is the evidence base.)

**Done when:** `rg -i "ctranslate2|\bct2\b"` returns only the POC evidence dir
and this migration doc's history, `npm run build-vite` and `npm test` pass.

---

## 7. Phase 6 — verification (must pass before merge)

1. **Guardrail:** every `/inference` on a speech clip passes the DTW-active
   check (no `t_dtw == -1`, `Σ|t_dtw−t0| > 0`).
2. **Adaptivity, per platform:**
   - Windows/Linux with a GPU: helper logs a Vulkan device, RTF ≈ POC Vulkan
     numbers. Then force CPU (e.g. hide the loader / no GPU VM) and confirm it
     **still transcribes** on CPU, backend field = `whispercpp-cpu`.
   - macOS arm64: helper logs Metal, transcribes; RTF materially better than CPU.
3. **Quality regression:** run the 7 POC fixtures through the *integrated* app
   path (renderer → IPC → helper) and confirm WER matches `REPORT.md` §3
   (whisper.cpp column), and no hallucinated trailing "Thank you" coda (the CT2
   artifact the migration also fixes).
4. **Caption sync (§1.4 validation):** open a real recording in the editor,
   confirm word highlights track audio acceptably. If DTW word-*start* feels
   consistently ~200–300 ms late (because `t_dtw` is word-end), apply the
   documented fallback: shift `word.start` to the previous word's `t_dtw`
   (i.e. use the DTW points as boundaries between words) or use whisper.cpp's
   `token.t0` as the start bound. Record the choice in `stt-spec.md`.
5. **Long-form:** the 130 s fixture returns full coverage in one `whisper_full`
   call (no manual chunking), WER ≈ report.
6. Use the `/verify` skill on the integrated change before committing.

---

## 8. Phase 7 — docs

- **Rewrite [`stt-spec.md`](./stt-spec.md)**: retitle to "STT engine
  specification: Whisper via whisper.cpp", replace §1 architecture (new module
  table, whisper.cpp helper, GGML model, no manual chunking), rewrite §2 to
  state the decision is now *settled toward whisper.cpp* with the POC as
  evidence (link `REPORT.md`), move the CT2 design into §3 History, refresh the
  build/run section (§4) and open items (§6: drop the ones the migration
  closes — Ruy/oneDNN, CT2 CUDA packaging, tar dep, chunk-boundary dedup that
  whisper.cpp handles; keep model-SHA-pin now *done*, add CUDA-variant and
  CoreML as new opt-in items).
- Update the pointer in `README`/`electron/native/README.md` and any
  `CLAUDE.md` STT note.
- The POC docs (`stt-whispercpp-dtw-poc-plan.md`, `REPORT.md`) stay as the
  historical justification — link them from the rewritten spec.

---

## 9. Suggested commit sequence

1. `feat(stt): add whisper-stt native helper (whisper.cpp + DTW HTTP server)` — Phase 1
2. `build(stt): whisper-stt build script + CI, GPU-adaptive matrix` — Phase 2
3. `feat(stt): swap Electron STT glue to whisper.cpp (contract preserved)` — Phase 3
4. `build(stt): package whisper-stt binaries incl. Linux + ggml sidecars` — Phase 4
5. `refactor(stt): remove CTranslate2 engine, scripts, CI, deps` — Phase 5
6. `test(stt): integrated whisper.cpp verification` — Phase 6
7. `docs(stt): rewrite spec around whisper.cpp; retire CT2 sections` — Phase 7

Keep 5 (the big deletion) after 1–4 so the tree always builds. Never delete the
CT2 binaries until the whisper helper resolves and runs on the same machine.

---

## 10. Definition of done

- [x] `whisper-stt-server` builds on macOS (Metal), Windows (Vulkan), Linux
      (Vulkan), each with automatic CPU fallback verified.
- [x] `electron/stt/` runs entirely on the helper; IPC contract unchanged;
      `npm test` green.
- [x] GGML q8_0 model downloaded + SHA-pinned by `modelManager`.
- [x] Installers on all three OSes bundle the helper + ggml sidecars (Linux
      gap closed).
- [x] Zero `ctranslate2`/`ct2` references outside the POC evidence dir.
- [x] `stt-spec.md` rewritten; POC report linked as the decision record.
