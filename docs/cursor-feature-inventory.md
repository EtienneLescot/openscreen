# Cursor feature — exhaustive inventory

Port of the legacy (`main`) cursor pipeline into the AI-edition editor shell
(`port/cursor-from-main`). Reference: `docs/architecture/openscreen-inventory.md`
§ Cursor; rendered pipeline at `src/components/ai-edition/CursorPreviewLayer.tsx`.

## 1. Capture (native side)

| Surface | Platform | What it does |
| --- | --- | --- |
| `electron/native/screencapturekit/Sources/OpenScreenMacOSCursorHelper/main.swift` | macOS | ScreenCaptureKit cursor helper — streams cursor bitmaps + interaction events alongside the screen capture. |
| `electron/native/wgc-capture/src/cursor-sampler.cpp` | Windows | WGC cursor sampler — captures the system cursor bitmap, hotspot, and type from a desktop duplication session. |
| `electron/native-bridge/cursor/recording/macNativeCursorRecordingSession.ts` | macOS | Wraps the SCK helper for the main process. |
| `electron/native-bridge/cursor/recording/windowsNativeRecordingSession.ts` + `.types.ts` | Windows | Wraps the WGC sampler; types describe cursor samples + assets. |
| `electron/native-bridge/cursor/recording/telemetryRecordingSession.ts` | All | Fallback: cursor samples come from the recorder's telemetry stream (no bitmap). |
| `electron/native-bridge/cursor/recording/session.ts` | All | Common session interface (start / stop / on-sample). |
| `electron/native-bridge/cursor/recording/factory.ts` | All | Picks the right session for the OS / source. |
| `electron/native-bridge/cursor/adapter.ts` | All | Adapter from native session to the `CursorRecordingData` shape used by the renderer. |
| `electron/native-bridge/cursor/telemetryCursorAdapter.ts` | All | Telemetry-only adapter. |
| `electron/native-bridge/services/cursorService.ts` | All | IPC entry point; exposes `cursor.getRecordingData` and `cursor.getTelemetry` to the renderer. |

Contracts (`src/native/contracts.ts`): `CursorRecordingData`, `CursorRecordingSample`, `NativeCursorAsset`, `NativeCursorType`.

Supported native cursor types: `arrow`, `text`, `pointer`, `crosshair`, `open-hand`, `closed-hand`, `resize-ew`, `resize-ns`, `resize-nesw`, `resize-nwse`, `move`, `not-allowed`, `wait`, `app-starting`, `help`, `up-arrow`. The renderer also has a "telemetry-only" provider (`"none"`) for legacy recordings.

## 2. Renderer hooks

| File | Role |
| --- | --- |
| `src/native/hooks/useCursorRecordingData.ts` | Loads `CursorRecordingData` for a given video path via the native bridge. Returns `{ data, loading, error }`. |
| `src/native/hooks/useCursorTelemetry.ts` | Loads the `CursorTelemetryPoint[]` stream. |
| `src/lib/cursorTelemetryBuffer.ts` | Buffers telemetry during playback (rate-decoupled from rAF). |
| `scripts/inspect-native-cursor-click-bounce.mjs` | Diagnostic for the click-bounce animation (loads a recording and prints frame state). |
| `scripts/test-windows-native-cursor.mjs` | Smoke test for the WGC cursor sampler on a real Windows machine. |
| `docs/testing/macos-native-cursor.md` / `windows-native-cursor.md` | Manual test recipes. |

## 3. Cursor core library (`src/lib/cursor/`)

| File | Role |
| --- | --- |
| `cursorPathSmoothing.ts` + test | Offline spring-damper smoothing. Resamples the raw cursor path to a 240Hz grid, runs a spring over each visible run, and serves positions by lookup. Deterministic, so preview and export match. Memoized per (recordingData, strength) via a `WeakMap`. |
| `nativeCursor.ts` + test | Pretty-cursor mapping, native bitmaps, click-bounce progress, motion-blur px. Owns the `PRETTY_NATIVE_CURSOR_ASSETS` table that maps `NativeCursorType` → SVG / hotspot, the themed override resolver (`resolveNativeCursorRenderAsset`), and the `classifyCapturedCursorType` heuristic (macOS doesn't tag samples with a cursor type — we infer arrow / pointer from the hotspot). |
| `cursorThemes.ts` | Theme registry: 17 Sweezy-cursors packs (arrow + pointer PNGs) + the built-in "default" sentinel id. Helpers: `DEFAULT_CURSOR_THEME_ID`, `CURSOR_THEME_IDS`, `getCursorTheme`, `normalizeCursorThemeId`. |
| `uploadedCursorAssets.ts` | Bitmaps for the seven supported cursor types. Trim rects are pulled from the 1024px sample sheet. |
| `pixiCursorRenderer.ts` (renamed from `video-editor/videoPlayback/cursorRenderer.ts`) | The `PixiCursorOverlay` class: builds the Pixi stage for telemetry-driven cursor rendering, applies the SVG drop shadow, runs a 240Hz spring on the cursor position, animates a click ring, and adds a directional motion-blur filter. Owns `DEFAULT_CURSOR_CONFIG` (dotRadius 28, smoothing 0.18, motionBlur 0, clickBounce 1). |

## 4. Preview layer (`src/components/ai-edition/`)

| File | Role |
| --- | --- |
| `CursorPreviewLayer.tsx` + test | Shared overlay rendered above the `<video>` in the editor. Two render paths: Pixi (telemetry) and a DOM `<img>` (native bitmap). Reads `useCursorRecordingData` + `useCursorTelemetry`, and applies the editor settings (size, smoothing, motion blur, click bounce, theme, clip-to-bounds, show). |
| `CursorPreviewLayer.module.css` | Layer + native-cursor DOM styles. |
| `VirtualPreview.tsx` (line 292) | Mounts `<CursorPreviewLayer>` inside the live preview. |

## 5. Right-panel pane (UI)

`src/components/ai-edition/RightPanes.tsx` → `CursorPane`, mounted from `RightPanelStack.tsx:115`.

| Control | Setting key | Range / type | Default |
| --- | --- | --- | --- |
| Show cursor | `cursorShow` (top-level) | toggle | `true` |
| Clip to canvas | `cursor.clipToBounds` | toggle | `false` |
| Cursor style (grid) | `cursorTheme` | pick from 18 options (Default + 17 Sweezy packs) | `default` |
| Size | `cursor.size` | 0.5 – 10.0 (×10 on the slider) | `3.0` |
| Smoothing | `cursor.smoothing` | 0 – 100% | `0.67` |
| Motion blur | `cursor.motionBlur` | 0 – 100% | `0.35` |
| Click bounce | `cursor.clickBounce` | 0 – 5.0 (×10 on the slider) | `2.5` |

Defaults live in `src/components/video-editor/types.ts` (`DEFAULT_CURSOR_SIZE`, `DEFAULT_CURSOR_SMOOTHING`, `DEFAULT_CURSOR_MOTION_BLUR`, `DEFAULT_CURSOR_CLICK_BOUNCE`, `DEFAULT_CURSOR_CLIP_TO_BOUNDS`) and are surfaced through `useEditorSettings` (`src/lib/ai-edition/store/editorSettings.ts`).

## 6. Settings persistence

- v3 document has a passthrough `legacyEditor` blob; the cursor settings round-trip through it as `cursorShow`, `cursorSize`, `cursorSmoothing`, `cursorMotionBlur`, `cursorClickBounce`, `cursorClipToBounds`, `cursorTheme`.
- Reader: `getEditorSettings(doc)` in `src/lib/ai-edition/store/editorSettings.ts`. Exposes `settings.cursor` and `settings.cursorTheme`.
- Writer: `patchEditorSettings(doc, patch)` (and `useEditorSettings().set / setLive / commit`).
- Hook: `useEditorSettings` in `src/lib/ai-edition/store/useEditorSettings.ts`. `set` persists to disk; `setLive` updates the in-memory document for live preview; `commit` flushes the in-memory doc to disk (used on slider release).

## 7. Auto-follow (zoom / camera)

`src/components/video-editor/videoPlayback/cursorFollowUtils.ts` (kept in the legacy `video-editor` folder because it's shared by the zoom-region focus logic and the export frame renderer).

- `interpolateCursorAt(telemetry, timeMs)` — binary-search the sorted telemetry and lerp to the playback time.
- `smoothCursorFocus(raw, prev, factor)` — exponential smoothing.
- `advanceFollowFocus(prev, raw, dtMs, params)` — distance-adaptive factor re-framed in content time so preview (variable fps) and export (fixed fps) converge at the same speed.
- `timeCorrectedFollowFactor(baseFactor, dtMs, referenceMs)` — frame-rate-independent smoothing.
- `adaptiveSmoothFactor(raw, prev, min, max, rampDistance)` — natural deceleration as the camera nears the cursor.

Consumers: `src/components/video-editor/videoPlayback/zoomRegionUtils.ts` (camera target for auto-focus zooms) and `src/lib/exporter/frameRenderer.ts` (export).

## 8. Exporter

`src/lib/ai-edition/exporter/documentExporter.ts` reads cursor data from options and passes it down the render pipeline. Forwarded fields: `cursorRecordingData`, `cursorTelemetry`, `cursorClickTimestamps`, `cursorScale`, `cursorSmoothing`, `cursorMotionBlur`, `cursorClickBounce`, `cursorClipToBounds`, `cursorTheme`. The legacy v2 export chain (frame renderer + muxer) consumes the same fields, so the v3 document round-trips through v2 export without losing the cursor pipeline.

## 9. Bundled assets

- 17 Sweezy-cursors theme packs under `public/cursors/<id>/{arrow,pointer}.png`. Each pack has a 32-logical-pixel reference with normalized hotspots (divide 128px-pack hotspots by 4). Add a pack by dropping two PNGs + an entry in `src/lib/cursor/cursorThemes.ts`.
- 16 native cursor SVGs under `src/assets/cursors/Cursor=*.svg` (default, app-starting, beachball, cross, hand-*, help, menu, move, not-allowed, resize-*, text-cursor, up-arrow, wait, zoom-*).

## 10. i18n

- `src/i18n/locales/en/settings.json` → `cursor` block: `theme`, `themeDefault`, `show`, `size`, `smoothing`, `motionBlur`, `clickBounce`, `clipToBounds`, `clipToBoundsDescription`. The AI-edition shell currently renders the pane in English; the legacy `SettingsPanel` consumed these keys directly.

## 11. What's NOT ported / known gaps

- The right-rail cursor tab is always shown. The legacy `SettingsPanel` hid the tab when `hasCursorData` was false. The new shell treats it as a preference (visible even before recording), which is intentional.
- The ai-edition shell does not use `useScopedT` for these labels yet — i18n keys exist but are not wired up. This is a separate P2/P3 concern.
- No tests cover the new `CursorPane` directly (only the shared `CursorPreviewLayer`).

## 12. File map (port branch vs legacy main)

| Concern | Legacy (`main`) | Port branch (`port/cursor-from-main`) |
| --- | --- | --- |
| Editor | `src/components/video-editor/SettingsPanel.tsx`, `VideoEditor.tsx`, `videoPlayback/VideoPlayback.tsx` | `src/components/ai-edition/RightPanes.tsx` (`CursorPane`), `RightPanelStack.tsx`, `NewEditorShell.tsx`, `VirtualPreview.tsx` |
| Pixi overlay | `src/components/video-editor/videoPlayback/cursorRenderer.ts` | `src/lib/cursor/pixiCursorRenderer.ts` (renamed) |
| Uploaded-cursor bitmaps | `src/components/video-editor/videoPlayback/uploadedCursorAssets.ts` | `src/lib/cursor/uploadedCursorAssets.ts` (renamed) |
| Auto-follow | `src/components/video-editor/videoPlayback/cursorFollowUtils.ts` | unchanged |
| Spring config | `src/components/video-editor/videoPlayback/motionSmoothing.ts` | unchanged |
| Themes | `src/lib/cursor/cursorThemes.ts` | unchanged |
| Path smoothing | `src/lib/cursor/cursorPathSmoothing.ts` | unchanged |
| Pretty / native cursor | `src/lib/cursor/nativeCursor.ts` | unchanged |
| Telemetry buffer | `src/lib/cursorTelemetryBuffer.ts` | unchanged |
| Hooks | `src/native/hooks/useCursor*.ts` | unchanged |
| Native capture | `electron/native/{screencapturekit,wgc-capture}/...` + `electron/native-bridge/cursor/*` | unchanged |
| Export pipeline | `src/lib/exporter/frameRenderer.ts`, `muxer.ts` | adds `src/lib/ai-edition/exporter/documentExporter.ts` (v3 envelope) → forwards to v2 renderer |
