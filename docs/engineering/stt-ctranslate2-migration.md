# STT engine: migrating from whisper.cpp to CTranslate2

**Status:** decided 2026-07-05, not yet implemented. This document supersedes the
"native whisper.cpp + forced alignment" plan in
[transcription-engine-migration.md](./transcription-engine-migration.md) for the
word-timestamp problem specifically — the recognizer model (Whisper) is unchanged,
only the runtime that executes it.

## Why whisper.cpp is being replaced

Three independent attempts to get correct word-level timestamps out of whisper.cpp
have now failed, each verified against the real bundled binary, not assumed from
docs:

1. **whisper.cpp's default (non-DTW) word timestamps.** Tested by prepending 5s of
   real silence to a known-good clip: the first ~5 words compressed into
   `[0.00, ~7.6s]` instead of starting near `t=5s`; words after that recovered
   correctly. Reproducible, not a fluke.
2. **whisper.cpp + built-in Silero VAD** (shipped in commit `c95acfb`, spawns
   `whisper-server --vad --vad-model ...`). The VAD-relative word timestamps are
   composed back to absolute via `word.start + parentSegment.start`
   ([whisperServer.ts:391-420](../../electron/stt/whisperServer.ts#L391-L420)).
   Re-verified against the same 5s-silence clip on 2026-07-05: the *segment*-level
   start itself is wrong (`10.98s` where `~5.0s` is correct), and composing on top
   of it produces `"Thank you"` at `21.07s` in a **17.18s file** — a timestamp
   past the end of the audio. This is not a precision issue, it's an unambiguous
   bug in whisper.cpp's VAD + word-timestamp interaction (this build, v1.9.1).
3. **whisper.cpp's `--dtw <model>` flag.** Has zero effect on our community-downloaded
   `ggml-small-q5_1.bin` (identical output with/without the flag) — DTW needs
   alignment-head data baked into the model at conversion time, which these files
   don't have. Independently, other whisper.cpp users report the same feature
   producing "bogus or odd time stamp values" even when configured per the
   project's own docs (see `ggml-org/whisper.cpp` discussion #2307) — this isn't
   a config mistake on our side, it's a reported weak spot of the feature itself.

We also built and removed a fourth approach — `facebook/wav2vec2-base-960h` CTC
forced alignment via `onnxruntime-node` (commits `90d3db7`..`ee2457d`). That one
had real, fixable bugs (a wrong pinned SHA-256, a missing ONNX `Tensor`
construction) but even once fixed, its greedy character-matching algorithm
misplaced words when whisper.cpp's own CTC decode dropped expected characters —
plus it added a second model, a second inference pass over the *entire* unchunked
recording (expensive on long videos), and a build-time onnxruntime-node bundling
problem that broke Electron's main-process build outright (see the CJS/ESM
`vite.config.ts` saga earlier in this branch's history).

**Conclusion:** whisper.cpp does not have a reliable word-timestamp mode today.
This isn't specific to our setup — it's a structural gap in the project.

## Decision

Move the STT engine from whisper.cpp to **CTranslate2** (the inference engine
behind `faster-whisper`), on **all three platforms** — no per-platform engine
split.

Word-level timestamps come from CTranslate2's built-in `.align()` — real DTW
computed directly over the Whisper model's own cross-attention weights at
inference time. This is architecturally different from WhisperX's approach
(rejected — see Alternatives): CTranslate2 needs no second model and works on
any standard Whisper checkpoint it has converted, across all ~99 languages
Whisper supports. `faster-whisper`'s own Python implementation
(`transcribe.py:1567-1697` in the `faster-whisper` package) already ships the
exact defensive heuristics for silence-adjacent words (median-word-duration
clamping) on top of that DTW baseline — we get both the clean alignment and the
edge-case handling from one, actively maintained, upstream source.

To avoid bundling a Python runtime in the Electron installer: CTranslate2's
Python bindings are optional and separate from its C++ core (`cmake` + `make
install` builds the library standalone; the Python wheel is a second, skippable
step). We build our own small native server — analogous to whisper.cpp's
`whisper-server` — that links against CTranslate2's C++ library directly. This
is a real, non-trivial build (nobody ships this as a prebuilt binary the way
`ggml-org` ships `whisper-server`), but it keeps the "single native executable
per platform, no interpreter" packaging model we already have.

## Constraints checklist

| Constraint | How this stack meets it |
| --- | --- |
| Electron desktop, Windows + macOS + Linux | Native C++ server per platform (`electron/native/bin/<os>-<arch>/`, same layout as today's whisper-server binaries), no Python |
| Local/offline | No network calls at inference time |
| Heterogeneous hardware, GPU or not | CUDA on NVIDIA (Windows/Linux); CPU fallback everywhere via CTranslate2's oneDNN/MKL (x86) and Apple Accelerate (Apple Silicon) backends |
| Long recordings (hours) | Explicit chunk → parallel-decode → merge pipeline, not reliant on any one call handling the whole file (see below) |
| Multilingual | Unchanged — same Whisper model weights, only the runtime differs |
| Fast | CTranslate2 is measured at 4-8x faster than plain PyTorch Whisper; int8 quantization keeps memory low |
| Decent accuracy | Same model weights as today — accuracy is a model property, not a runtime property |
| Word-level timestamps, correct anywhere in the recording | Native DTW via `.align()`, proven in AxCut's production pipeline (`py/axcut-core/src/axcut_core/transcribe.py`); no confirmed systemic bug (unlike all three whisper.cpp modes above) |
| Reasonable download size | Whisper weights convert to CTranslate2 format at comparable int8-quantized sizes to today's ggml files |

### Mac GPU tradeoff, addressed explicitly

CTranslate2 has no Metal/MPS backend — Apple Silicon runs CPU-only (via
Accelerate). Measured externally for the `small` model on an M2: real-time
factor ≈ 0.35 CPU-only (a 30s clip transcribes in ~10.5s, i.e. ~2.9x faster than
real time) vs. 22-34x faster than real time with Metal. That's a real relative
regression (~10x), but in absolute terms it's in the same ballpark as our
already-shipped whisper.cpp CPU path elsewhere (small model + max threads
measured at RTF ≈ 0.33 on an 8-core desktop earlier in this investigation) — not
a cliff, and this is a post-hoc "generate transcript" feature, not live
captioning. A 1-hour recording is ~21 minutes of processing, which is acceptable.

## Architecture

```
Electron (renderer)
      │  IPC: Float32Array samples + language hint
      ▼
Electron (main process) — electron/stt/ (existing IPC contract, unchanged)
      │  spawn / reuse long-lived process, same lifecycle as today's WhisperServerManager
      ▼
New native transcription server (C++, CTranslate2 core) — replaces whisper-server
      │
      ├─ chunk audio (already 16kHz mono PCM from the renderer) into
      │  windows for anything past a duration threshold (e.g. > ~5 min)
      ├─ per chunk: CTranslate2 Whisper decode (int8/fp16, CUDA or CPU)
      ├─ per chunk: .align() → DTW word timestamps, relative to the chunk
      ├─ merge: re-offset every chunk's segment/word times by that chunk's
      │  absolute start position in the original recording
      ▼
JSON: { segments, wordSegments, detectedLanguage, backend }
      │  — same shape as transcriptionContract.ts today
      ▼
electron/stt/index.ts (SttManager) — same IPC handler, same renderer contract
```

### What gets removed

- `electron/stt/whisperServer.ts` — whisper.cpp process management; replaced by
  the new CTranslate2 server wrapper.
- `electron/stt/vadModel.ts`, `scripts/fetch-vad-model.{sh,ps1}`, the VAD steps
  in `.github/workflows/build.yml` — whisper.cpp's VAD is being dropped along
  with the engine that hosts it (superseded, not patched further).
- `electron/native/bin/*/whisper-server-*` binaries — replaced per platform by
  the new server.
- `electron/stt/gpuDetector.ts` simplifies to CUDA-or-CPU (no Metal/Vulkan
  branches — CTranslate2 doesn't use either).

### What stays the same

- `electron/stt/transcriptionContract.ts` — the IPC shape
  (`SttPhraseSegment`, `SttWordSegment`, request/response types) doesn't change.
- `src/lib/captioning/transcribe.ts` — same thin IPC adapter, no renderer changes.
- `electron/stt/modelManager.ts`'s SHA-256-pinned download/verify pattern —
  same shape, new model file format (CTranslate2's on-disk format differs from
  a single `.bin`; see Open Questions).

## Long-recording handling

Never hand a multi-hour file to one decode call. Explicit pipeline:

```
ffmpeg → 16 kHz mono PCM → fixed-size chunks (e.g. 5 min, small overlap)
  → parallel decode + align per chunk (bounded worker pool, not unbounded)
  → merge: shift each chunk's segment/word timestamps by the chunk's
    absolute start offset in the original recording
```

This bounds memory per chunk regardless of total recording length and lets
long recordings use available parallelism (multiple CPU threads or, on CUDA
hosts, batched GPU decode) instead of one long serial pass.

## Model size / hardware-adaptive selection (phase 2, non-blocking)

| Machine tier | Model |
| --- | --- |
| Low-power / no GPU | `small` (current default) |
| Mid-range CPU | `medium` |
| GPU available (CUDA) | `large-v3-turbo` |

Not required for the initial CTranslate2 migration — the current `small`
quantized default stays until this is prioritized separately.

## Alternatives considered and rejected

- **WhisperX-style forced alignment** (wav2vec2 phoneme model on top of any
  Whisper backend). Rejected: this is the exact `onnxruntime-node` + wav2vec2
  recipe we already built, hit real bugs in, and removed at the project's
  explicit request to drop heuristic/bolted-on alignment layers. It's also
  **per-language** — WhisperX needs a different wav2vec2 alignment model per
  language, with no model covering all ~99 languages Whisper does, which is a
  worse multilingual story than what we have today, not a better one.
- **NVIDIA Parakeet / `parakeet.cpp`.** Rejected: multilingual variant covers
  ~25 European languages against our ~99-language need, and CPU-only inference
  is reported ~96x slower than GPU on published benchmarks — fails the "some
  devices have no GPU" constraint outright.
- **sherpa-onnx.** Word-level timestamp support for Whisper models inside
  sherpa-onnx is itself unstable/requires a custom model re-export (per the
  project's own GitHub discussion #2942) — the same class of problem as
  whisper.cpp's DTW gap, with no clear advantage for us.
- **Split engine per platform** (whisper.cpp+Metal on Mac, CTranslate2+CUDA on
  Windows/Linux). Rejected: whisper.cpp's timestamp bug reproduces on Mac too
  (it's a whisper.cpp bug, not a Windows-specific one) — the split doesn't fix
  Mac, it just decides which platform keeps a known-broken engine.
- **whisper.cpp's own `--dtw` flag as a incremental fix.** Rejected for the
  reasons in "Why whisper.cpp is being replaced" above — not viable with
  standard community models, and independently reported unreliable even when
  configured correctly.

## Risks / open questions

- **No Vulkan equivalent in CTranslate2.** Linux users on AMD/Intel GPUs lose
  the GPU acceleration whisper.cpp's Vulkan backend gives them today (CPU
  fallback still works; ROCm support for AMD exists in CTranslate2 but is
  described as experimental). Smaller user segment than NVIDIA/CPU, but a real,
  known regression to track.
- **Writing the C++ server is genuine, unscoped engineering work.** No
  prebuilt binary exists for this (unlike whisper.cpp's community-maintained
  `whisper-server`) — budget for it accordingly before committing to a
  timeline.
- **Model format differs from ggml.** Need a conversion + hosting story for
  CTranslate2-format Whisper weights (self-host converted files vs. converting
  on first run) — not yet decided.
- **Everything above needs the same empirical verification treatment** this
  document's Context section describes for whisper.cpp — before wiring this
  into the app, reproduce the 5-second-leading-silence test (and ideally a
  mid-clip-pause test) against our own compiled server and confirm `.align()`
  actually produces correct absolute timestamps on our exact model/build,
  the same way we caught whisper.cpp's three failures instead of trusting its
  docs/comments.
- **Silero VAD's fate is undecided.** It may still be worth keeping as an
  optional pre-filter to reduce Whisper's tendency to hallucinate on music or
  long silence — explicitly *not* as a timestamp-correctness mechanism (that's
  `.align()`'s job now), which is a different, lower-stakes role than the one
  it was shipped for in commit `c95acfb`.

## Next steps

1. Prototype: a minimal CTranslate2 C++ CLI that transcribes + aligns one file,
   verified against the 5s-leading-silence test case before any further
   integration work.
2. If validated: build the HTTP/IPC server wrapper (same shape as
   `whisper-server` today) for Windows, Linux, and macOS.
3. Decide the model conversion/hosting story.
4. Replace `electron/stt/whisperServer.ts`, remove the VAD bundling
   (`vadModel.ts`, `fetch-vad-model.*`, the CI steps), simplify
   `gpuDetector.ts`.
5. Confirm `transcriptionContract.ts` needs no shape changes (expected: none).
6. Build the long-recording chunk/merge pipeline (engine-agnostic; can start
   in parallel with the above).
