# whisper.cpp DTW word-timestamp POC

Standalone evaluation harness, decoupled from the Electron app build — it
never touches `electron/`, `src/`, or any app build step. Its only dependency
on the rest of the repo is reading the already-built CTranslate2 server
binary + model as a comparison baseline (never rebuilding or modifying it).

**Full plan / instructions:**
[docs/engineering/stt-whispercpp-dtw-poc-plan.md](../../../docs/engineering/stt-whispercpp-dtw-poc-plan.md)

**Verdict:** see [`REPORT.md`](./REPORT.md) — §4.1 guardrail PASS on all 28 runs;
word-end timestamps agree with CT2 within 20 ms median; wcpp-CPU-q8_0 is
1.5–2.9× faster than CT2-int8 at matched precision; wcpp-Vulkan-q8_0 hits
5.27× real-time on the 130 s clip (1.82× GPU-vs-CPU speedup at matched
precision, 2.65× vs the CT2 baseline that cannot reach this AMD GPU at all).
**Recommendation: full migration to whisper.cpp.**

Generated artifacts (`whisper.cpp/` clone, `build-*/`, downloaded models,
`fixtures/*.wav`, `results/`) are excluded via the repo root `.gitignore` —
only the harness source, ground-truth text fixtures, and the final
`REPORT.md` are meant to be committed.
