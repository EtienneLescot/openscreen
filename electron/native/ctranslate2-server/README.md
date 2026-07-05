# CTranslate2 server

Long-lived STT server for OpenScreen's native transcription pipeline. Replaces
`whisper-server` (the old ggml-based binary) with a thin HTTP wrapper around
[CTranslate2](https://github.com/OpenNMT/CTranslate2).

See `docs/engineering/stt-ctranslate2-migration.md` for the full decision and
migration plan.

## Status

The HTTP + configuration plumbing is in place; the actual Whisper decode +
`.align()`-driven word-timestamp path is **TODO** (see `src/main.cpp` comments
and the spec § Next steps, item 1). Build the scaffold via
`scripts/build-ctranslate2-server.sh`; the produced binary currently exits with
a TODO marker and is therefore not yet drop-in usable. Until that lands the
Node wrapper under `electron/stt/ctranslate2Server.ts` will fail loudly at
start time.

## Layout

- `src/main.cpp` — boot, CLI / env parsing, ready to wire the model + HTTP loop.
- `CMakeLists.txt` — pulls CTranslate2 via FetchContent and links statically.
- `../../scripts/build-ctranslate2-server.sh` — multi-platform build script.

## Wire contract (HTTP)

```
GET  /            → 200 OK                          (readiness probe)
POST /inference   → 200 application/json            (transcribe + align)
```

Request: `multipart/form-data` with `file` (16-bit-LE mono 16 kHz WAV) and
`language` (ISO 639-1 or `"auto"`). Response JSON shape is documented at the
top of `src/main.cpp` and matches `electron/stt/transcriptionContract.ts`.

## Hardware

| Backend | Enabled when |
| --- | --- |
| CUDA    | `-DENABLE_CUDA=ON` and a CUDA toolkit is on PATH |
| CPU     | default; uses oneDNN/MKL on x86, Apple Accelerate on macOS |
