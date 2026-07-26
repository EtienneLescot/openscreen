# OpenScreen Architecture Notes

Quick map of how the app fits together, for the Mavis reins. For deeper details, see `../technical-documentation/architecture/native-bridge.md` and `../technical-documentation/engineering/`.

## Process layout

OpenScreen is a three-process Electron app:

1. **Main process** (`electron/main.ts` + siblings) — owns window lifecycle, IPC handlers, the recording orchestrator, and child-process management for the native helpers.
2. **Renderer** (`src/`) — React 18 + Vite app. The UI, the editor, the timeline, the Pixi.js composition surface, and the i18n layer. Runs with `contextIsolation: true`.
3. **Native capture helpers** — small, privileged child processes that own the platform-specific screen/audio/webcam capture APIs:
   - macOS: Swift binary using ScreenCaptureKit (`electron/macos-helper/`)
   - Windows: C++/Win32 binary using Windows Graphics Capture (`electron/windows-helper/`)
   - Linux: falls back to a browser MediaStream pipeline (no native helper)

## Data flow during a recording

```
[User clicks record]
        |
        v
Renderer (React)  --IPC-->  Main process  --spawn-->  Native helper
        ^                                                  |
        |                                                  v
        +--<-- frame chunks / audio chunks / metadata --<--+
```

The native helper writes raw chunks; the main process multiplexes them with the timeline metadata; the renderer pulls the composed stream onto the Pixi.js canvas for live preview and final export.

## Why the split

- Native helpers are tiny, single-purpose, and have a narrow IPC surface. That keeps the privileged code reviewable.
- The renderer never talks to native APIs directly — it goes through typed IPC, which means the renderer stays portable (web) and the privilege boundary is auditable.
- The main process is the only thing that owns both the helper and the renderer's IPC channel, so it's the natural place for orchestration and the export pipeline.

## What this means for changes

- Touching recording behavior = main process + native helper + (usually) renderer UI. Three places to keep in sync.
- Touching the editor = renderer only. Cheap to iterate with `npm run build-vite`.
- Touching export = main process + renderer (preview matches export). Run a full recording → export loop to verify.
- Native code cannot be unit-tested in CI. Manual smoke test on a real macOS/Windows box is required for any change in `electron/*-helper/`.
