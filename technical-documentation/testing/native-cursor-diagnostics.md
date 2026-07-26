# Native cursor diagnostics

These diagnostics inspect native cursor capture without requiring a complete record, edit, and export cycle. They produce cursor sidecars, JSON reports, and preview artifacts for checking samples, assets, hotspots, interaction events, and platform fallback behavior. The [cursor pipeline](../architecture/cursor.md) describes how the recorded data is rendered; this document focuses on the tools.

## Windows sampler diagnostic

Build the Windows native helper when needed:

```powershell
npm run build:native:win
```

Run the cursor sampler diagnostic on a Windows machine:

```powershell
npm run test:cursor-native:win
```

The script starts a `GetCursorInfo` sampler, moves the pointer with `SetCursorPos`, captures cursor handles, hotspots, assets, and standard `IDC_*` types, then writes normalized recording data and preview videos. It prints the output directory, which contains:

- `report.json`: sample and asset counts, cursor handles, and generated artifact paths
- `cursor-recording-data.json`: sidecar-compatible cursor data
- `preview.webm`: abstract path, asset, and hotspot preview
- `real-capture-preview.webm`: desktop screenshot background with the reconstructed cursor
- `assets/*.png`: raw Windows cursor bitmaps

Optional settings include:

```powershell
$env:CURSOR_TEST_DURATION_MS = "3000"
$env:CURSOR_TEST_SAMPLE_INTERVAL_MS = "16"
$env:CURSOR_TEST_SCREEN_FRAME_INTERVAL_MS = "80"
$env:CURSOR_TEST_OUTPUT_DIR = "C:\temp\openscreen-cursor-test"
npm run test:cursor-native:win
```

To inspect the real editor preview using the generated sidecar, run:

```powershell
npm run capture:openscreen-preview
```

Set `CURSOR_RECORDING_DATA_PATH` to select a particular sidecar. `capture-openscreen-preview.mjs` also accepts `OPENSCREEN_PREVIEW_SKIP_BUILD`, `OPENSCREEN_PREVIEW_FRAME_COUNT`, `OPENSCREEN_PREVIEW_FPS`, and `OPENSCREEN_PREVIEW_OUTPUT_DIR`.

## macOS cursor helper

Build the ScreenCaptureKit and cursor helpers:

```bash
npm run build:native:mac
```

The build copies development binaries to `electron/native/screencapturekit/build/` and packaged binaries to `electron/native/bin/darwin-arm64/` or `electron/native/bin/darwin-x64/`. It requires Xcode.

Run the cursor helper directly after building it:

```bash
BIN=electron/native/screencapturekit/build/openscreen-macos-cursor-helper
("$BIN" '{"sampleIntervalMs":100}' & PID=$!; sleep 2; kill $PID) | head -20
```

The first JSON line should have `type: "ready"`, together with `mouseTapReady` and `accessibilityTrusted`. Subsequent `type: "sample"` lines contain an `assetId`, position and interaction fields; the first occurrence of an asset also contains its PNG data, dimensions, scale factor, and hotspot. `accessibilityTrusted: false` is a valid development fallback: bitmap capture continues, but text and pointer affordance detection is unavailable.

To run the app with a specific helper binary:

```bash
export OPENSCREEN_MAC_CURSOR_HELPER_EXE=/path/to/openscreen-macos-cursor-helper
npm run dev
```

macOS recording requires Screen Recording permission. Accessibility permission is optional and enables text and pointer affordance detection. After changing either permission, fully quit and relaunch the development app so the process observes the new state.

## Reading the JSON report

The generated cursor sidecar is stored beside the video as `<videoPath>.cursor.json`. A healthy native sidecar has `version: 2`, `provider: "native"`, a non-empty `assets` array, and `samples` with increasing `timeMs` values and normalized `cx`/`cy` positions. Native samples may reference an asset by `assetId`; the full bitmap is emitted once per unique asset. Click samples carry the interaction marker used by click-bounce rendering.

A position-only recording can legitimately report `provider: "none"` with an empty `assets` array. That means the native helper is unavailable or did not reach its ready state; telemetry still supplies cursor position.

## What a healthy recording looks like

A report should show non-zero sample and asset counts, and its artifact paths should point to files that exist in the printed output directory. In the preview videos, the cursor should remain attached to its hotspot while moving, switch assets when the system cursor changes, and remain within the captured surface when clipping is enabled. On macOS Retina displays, the reported scale factor should be reflected in the dimensions and hotspot used by the renderer.

For a full-path check, record a short clip, open it in the editor, and export it. Compare the preview and export around rapid cursor movement and clicks: both should use the same telemetry timing and cursor position, with click interaction visible when native click samples are present.

## Known limitations

- macOS single-window capture can report a cursor offset relative to the captured surface; this is a known alignment issue.
- macOS Accessibility permission may be reported unreliably by unsigned development builds. Treat the helper's `accessibilityTrusted` field in its `ready` message as authoritative.
- Some app-defined CoreGraphics/CGS cursors are not exposed through `NSCursor.currentSystem`.
- The Windows native cursor click-bounce path is not reliably visible in packaged-app manual testing; synthetic diagnostic metadata alone does not validate the complete record-to-export path.
- Intel Macs may need a local `npm run build:native:mac` build when a packaged helper is not available for `darwin-x64`.
