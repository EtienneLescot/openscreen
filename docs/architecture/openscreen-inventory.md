# OpenScreen Inventory — Merge with Axcut

> Catalog of the OpenScreen codebase at `G:\repos\openscreen\.worktrees\wt-9ce78f24\` as it stands for the AI-edition merge. Path notation is `path:line` relative to the repo root. All file paths are absolute under that worktree.

---

## 1. Recorder pipeline (full lifecycle)

### Window graph
There is **one renderer entry point** (`src/App.tsx:11`) that lazy-loads the window component by `?windowType=…` query param. Four window types are produced:

- `hud-overlay` → `LaunchWindow.tsx:92` (frameless transparent HUD with the record/stop buttons). Created by `electron/windows.ts:87` `createHudOverlayWindow`.
- `source-selector` → `SourceSelector.tsx:16`. Created by `electron/windows.ts:231` `createSourceSelectorWindow`.
- `countdown-overlay` → `CountdownOverlay.tsx`. Created by `electron/windows.ts:275` `createCountdownOverlayWindow`.
- `editor` → `VideoEditor.tsx` (lazy). Created by `electron/windows.ts:168` `createEditorWindow`.

`electron/main.ts:50` sets `RECORDINGS_DIR = path.join(app.getPath("userData"), "recordings")` — this is the canonical on-disk home for media.

### LaunchWindow → SourceSelector flow
- The HUD always opens first (`electron/main.ts:588` `createWindow()` → `createHudOverlayWindow()`).
- When the user clicks the "screen / window" pick, `LaunchWindow.tsx` calls `openSourceSelectorWithPermissionRetry(...)` (defined in `src/components/launch/openSourceSelectorFlow.ts:32`), which calls `window.electronAPI.openSourceSelector()` and, on macOS, retries up to 8× while a `not-determined` Screen Recording permission resolves.
- The main process opens `createSourceSelectorWindow()` (`electron/ipc/handlers.ts:1423`) and the renderer renders `SourceSelector.tsx`. `getSources` (`electron/ipc/handlers.ts:1307`) drives the picker via `desktopCapturer.getSources(...)`. Picking calls `selectSource` IPC (`electron/ipc/handlers.ts:1319`) which closes the selector.

### Source selected → record
- `useScreenRecorder.ts:1527` `toggleRecording()` calls `startRecordCountdown()` (`useScreenRecorder.ts:1040`) which opens the `CountdownOverlay` (`useScreenRecorder.ts:1090`) for a 3-2-1, then routes to one of three branches:
  - Windows + native helper available → `startNativeWindowsRecordingIfAvailable` (`useScreenRecorder.ts:781`).
  - macOS + native helper available → `startNativeMacRecording` (`useScreenRecorder.ts:912`, payload at `:963` with `schemaVersion: 1`).
  - Otherwise → browser `getDisplayMedia` + `MediaRecorder` for screen and webcam (`useScreenRecorder.ts:1163+`).
- The recorder uses a wrapper around `MediaRecorder` defined at `src/hooks/recorderHandle.ts:31` `createRecorderHandle`. With `fileName`, MediaRecorder chunks are streamed to disk via IPC (see §5) so a long recording never buffers the whole video in the renderer.
- Pause/resume restart splits (`useScreenRecorder.ts:1541` `restartRecording`) maintain `accumulatedDurationMs` and `segmentStartedAt` refs (`useScreenRecorder.ts` lines ~22-31) so total duration survives pause gaps.

### Stop → save → switch to editor
- `useScreenRecorder.ts:621` `stopRecording` (held in a ref) branches by transport:
  - **Browser / streaming finalize** — `finalizeRecording` (`:337`): calls `fixWebmDuration` (`@fix-webm-duration/fix`), then `window.electronAPI.storeRecordedSession(...)` (`:369`) with `{ screen: { videoData, fileName }, webcam?: ..., createdAt: recordingId, cursorCaptureMode, durationMs }`. On success calls `setCurrentRecordingSession` (`:391`) then `switchToEditor()` (`:396`).
  - **Native Windows** — `finalizeNativeWindowsRecording` (`:422`): calls `stopNativeWindowsRecording(discard)` and may then call `storeRecordedSession` to merge the webcam blob, then `setCurrentRecordingSession` and `switchToEditor()` (`:503`).
  - **Native macOS** — `finalizeNativeMacRecording` (`:522`): calls `stopNativeMacRecording(discard)` then `attachNativeMacWebcamRecording` (`:582`) to bind the webcam into the session, then `setCurrentRecordingSession` and `switchToEditor()` (`:603`).
- The IPC handler `store-recorded-session` lives at `electron/ipc/handlers.ts:2207` → `storeRecordedSessionFiles` (`:2220`):
  - Resolves final paths via `resolveRecordingOutputPath` (`:270`) → `path.join(RECORDINGS_DIR, parsedPath.base)`.
  - For each track it calls `finalizeRecordingFile` which either finalizes the open stream or writes the buffer (see §5).
  - Patches the WebM `Duration` header on disk when `durationMs` is finite (`:2251-2257`, `electron/recording/webm-duration.ts`).
  - Builds `RecordingSession` (`{ screenVideoPath, webcamVideoPath?, createdAt, cursorCaptureMode? }`) and stores it via `setCurrentRecordingSessionState` (`:1183`).
  - Writes a JSON manifest `<screenFileName>.session.json` next to the WebM (`:2273-2277`).
  - Calls `writePendingCursorTelemetry` (`:2271`) to persist any pending cursor telemetry.
- `setCurrentRecordingSession` and `setCurrentVideoPath` are also exposed individually (`electron/ipc/handlers.ts:2784`, `:2780`).

### What does the editor do with this state?
- On open, `VideoEditor.tsx:540` `loadInitialData` first tries `nativeBridgeClient.project.loadCurrentProjectFile()` (loads the `.openscreen` project file from its last-known path), then falls back to `window.electronAPI.getCurrentRecordingSession()` (`:554`), then `nativeBridgeClient.project.getCurrentVideoPath()` (`:582`). The three are ordered: explicit saved project → just-recorded session → just-recorded single video.
- The recorded files live at `RECORDINGS_DIR/recording-<timestamp>[ -webcam].{webm,mp4}` depending on platform (`electron/ipc/handlers.ts:49` `RECORDING_FILE_PREFIX`, `:1572` for native Windows output naming).

### Where the recording file path lives
- After stop, the canonical paths are:
  - **Last successful recording's screen path** → `app.getPath('userData')/recordings/recording-<id>.webm` (or `.mp4` for native captures).
  - **Main-process session state** → `currentRecordingSession: RecordingSession | null` (`electron/ipc/handlers.ts:358`) and `currentVideoPath: string | null` (`:364`) and `currentProjectPath: string | null` (`:357`).
  - **Renderer "current" view** → mirror via `nativeBridgeClient.project.getCurrentContext()` (`src/native/client.ts:71`) plus the same value fetched through `window.electronAPI.getCurrentRecordingSession()` / `getCurrentVideoPath()`.

### Multiple sequential recordings — what happens today
- **They overwrite the renderer's "current" pointer**, but not the files on disk. Each `stopRecording` calls `setCurrentRecordingSession` / `setCurrentVideoPath` which replaces `currentRecordingSession` / `currentVideoPath` in main (`electron/ipc/handlers.ts:1183`, `:2780`). The editor's `loadInitialData` always reads *the last* one.
- Files keep accumulating in `RECORDINGS_DIR` because file names include a unique `recordingId` (timestamp). There is **no in-app UI to list, append, or manage multiple takes** — `electron/ipc/handlers.ts:2303` `getRecordedVideoPath` does scan the dir to find the latest, but that is only used when no session pointer exists.
- There is **no prompt** before the editor opens, and **no notion of "stay in recorder after Stop"**. Stop → save → `switchToEditor()` is the wired path (all three transports call it). `LaunchWindow.tsx:1008-1018` exposes a single "Open studio" Clapperboard button that also calls `switchToEditor()` manually.
- **Restart** (`useScreenRecorder.ts:1541`) discards the in-progress recording and starts a new one with a fresh `recordingId` — same overwrite-on-stop semantics apply.

### `recordingSession.ts` (`src/lib/recordingSession.ts`, 85 lines)
Pure type module — no runtime behavior. Defines:

- `ProjectMedia { screenVideoPath, webcamVideoPath?, cursorCaptureMode? }` (`recordingSession.ts:1`).
- `CursorCaptureMode = "editable-overlay" | "system"` (`:7`).
- `RecordingSession extends ProjectMedia { createdAt: number }` (`:9`).
- `RecordedVideoAssetInput { fileName: string, videoData: ArrayBuffer }` (`:13`).
- `StoreRecordedSessionInput` — payload from renderer for `store-recorded-session`, includes `durationMs?: number` (`:18`).
- `normalizeProjectMedia`, `normalizeCursorCaptureMode`, `normalizeRecordingSession` — tolerant guards used on every load to drop malformed fields.

### `media-stream.ts`
**There is no `media-stream.ts` file.** The closest is `src/hooks/useScreenRecorder.ts` (1686 lines) which manages screen + webcam MediaStreams; `src/hooks/recorderHandle.ts` wraps `MediaRecorder`. `src/lib/compositeLayout.ts` describes webcam layout math.

---

## 2. Exporter pipeline (full chain)

The exporter pipeline is purely in-browser / in-renderer. The main process only owns the source `MediaRecorder` / native capture and writes the resulting files to disk; once the file is on disk, the renderer reads it (`window.electronAPI.readBinaryFile` via `electron/ipc/handlers.ts:2523`) and feeds it into the exporter.

### Entry points
- `src/lib/exporter/videoExporter.ts` `VideoExporter` class (`:170`) — MP4 / H.264.
- `src/lib/exporter/gifExporter.ts` `GifExporter` class (`:117`) — GIF via `gif.js` worker.
- `src/lib/exporter/index.ts` — barrel re-exporting both.
- Called from `VideoEditor.tsx:1927` (gifExporter) and `VideoEditor.tsx:1979` (VideoExporter).

### Chain (MP4)
1. `VideoExporter.export()` → `exportWithEncoderPreference(prefer-hardware)` (`videoExporter.ts:228`):
   - Loads source metadata via `StreamingVideoDecoder.loadMetadata(videoUrl)` (`:248`).
   - Tries a **source-copy fast path** (`:684` `trySourceCopyFastPath`) — if the source is an MP4 and no trim/zoom/annotation/etc. edits are active, returns the source blob verbatim. Disabled when crop, padding, border radius, shadow, blur, motion blur, webcam overlay, or any time regions are present (`getSourceCopyFastPathBlockers`, `:126-155`).
   - Optionally loads webcam metadata (`:255`).
2. `FrameRenderer` (`frameRenderer.ts:135`) is built with `wallpaper, zoomRegions, showShadow, shadowIntensity, showBlur, motionBlurAmount, borderRadius, padding, cropRegion, cursorRecordingData, cursorScale, …, webcamSize, webcamLayoutPreset, …, annotationRegions, speedRegions, …, cursorTelemetry, cursorClickTimestamps, platform` (`:261-296`). `await renderer.initialize()` creates the Pixi.js `Application`, two canvases (`composite`, `foreground`) plus a `raster` canvas for the Linux read-back path (`:182-279`).
3. `VideoEncoder` (WebCodecs) is configured (`:521` `initializeEncoder`):
   - Codec default `avc1.640033` (`:589`), `latencyMode: "quality"`, `bitrateMode: "variable"`.
   - On Windows it tries `["prefer-software", "prefer-hardware"]`; everywhere else `["prefer-hardware", "prefer-software"]` (`:677-682`).
   - `maxEncodeQueue = 120` (or `32` for software) (`:181`, `:324-327`).
4. `VideoMuxer` (`muxer.ts:13`) wraps `mediabunny`:
   - `Mp4OutputFormat({ fastStart: "in-memory" })` (`:32`).
   - `EncodedVideoPacketSource("avc")` (`:39`).
   - Optional `EncodedAudioPacketSource("aac" | "opus")` chosen at runtime via `AudioProcessor.selectSupportedExportCodecForSource` (`:304`).
5. `streamingDecoder.decodeAll(...)` (`:365`) iterates source frames at the requested `frameRate` honoring `trimRegions` and `speedRegions`. Per frame:
   - Render to Pixi via `renderer.renderFrame(videoFrame, sourceTimestampUs, webcamFrame)` (`:389`).
   - For Linux, force a `getImageData` CPU readback (`:397-412`); otherwise `new VideoFrame(canvas, …)` (`:414`).
   - Throttle via `waitForEncoderQueueSpace` (`:30`) with a 15s stall timer.
   - `encoder.encode(exportFrame, { keyFrame: frameIndex % 150 === 0 })` (`:431`).
   - Webcam frames flow through `TimestampedVideoFrameQueue` (`timestampedVideoFrameQueue.ts`, 75 lines) — webcam decoder runs in parallel (`:330-363`).
6. Encoder output callback (`:528-586`) pushes each chunk into the muxer (`muxer.addVideoChunk`, `:52`) with the first chunk carrying `decoderConfig.description` / `colorSpace`.
7. After decode finishes, encoder is flushed with a 20s timeout (`:469`), then audio is processed via `AudioProcessor.process(...)` (`:497`).
8. `muxer.finalize()` → `Blob({ type: "video/mp4" })` (`:509`, `muxer.ts:72`).

### Compositor layer order (inside `FrameRenderer.renderFrame` at `frameRenderer.ts:374`)
1. Background wallpaper (`compositeCanvas`) — color / linear gradient / image, loaded in `setupBackground` (`:281-372`); blurred with `filter: blur(6px)` when `showBlur` is on (`:978-984`).
2. Pixi.js video stage with zoom camera (`cameraContainer` → `videoContainer`) — sprites the decoded `VideoFrame`, applies zoom (with spring smoothing, see `videoPlayback/zoomSpring.ts`), motion blur, blur filter, mask `roundRect` matching `compositeLayout.screenRect` (`:672-767`). When `Rotation3D` is non-identity, `threeDPass` (`threeDPass.ts`) projects the foreground canvas.
3. Webcam composite (`compositeWithShadows`, `:950`) — drawn into `foregroundCanvas` with mask shape (`rectangle`/`circle`/`square`/`rounded`), shadow from preset, mirroring, reactive scale anchored to a docked corner.
4. Native cursor overlay (`drawNativeCursor`, `:546`) — placed using `getSmoothedCursorPath` (`lib/cursor/cursorPathSmoothing.ts`) for the position and the native cursor sprite from `CursorRecordingData`; motion blur / click bounce / clip-to-bounds applied.
5. Editable cursor from cursor telemetry — same pipeline, reads `config.cursorRecordingData`.
6. Annotations — `renderAnnotations(foregroundCtx, …)` (`annotationRenderer.ts`) draws text / image / figure / blur regions (`frameRenderer.ts:462`).
7. Drop shadow — baked on the flat path (`compositeWithShadows`), re-applied after rotation on the 3D path (`:492-522`).
8. Final readback from `compositeCanvas` (`getCanvas`, `:1100`).

### Output format pipeline
- **MP4** — `mediabunny` (vendor `mediabunny: ^1.40.1`). Fast-start in-memory.
- **GIF** — `gif.js: ^0.2.0` via web worker `gif.js/dist/gif.worker.js` (`gifExporter.ts:25`). `GifExporter` (`:117`) loops `StreamingVideoDecoder.decodeAll` → `FrameRenderer.renderFrame` → `gif.addFrame(canvas, { delay, copy: true })`. GIF is the only non-medibunny exporter.

### Encoder settings
- Default codec `avc1.640033` (High Profile Level 5.1) — `videoExporter.ts:589`.
- Bitrate/width/height computed in `mp4ExportSettings.ts` `calculateMp4ExportSettings`:
  - Quality `medium` → short side 720 px → 10 Mbps (`:106`).
  - Quality `good` → short side 1080 px → 20 Mbps (`:107`).
  - Quality `source` → match source dims → 30/50/80 Mbps depending on pixel count (`:101-104`).
  - Width/height always even (`:17-23`).
- Frame rate passed in via `ExportConfig.frameRate` (set by `VideoEditor.tsx:1979` from `calculateMp4ExportSettings`).
- Aspect ratio is preserved via `calculateSourceDimensions` / `calculateDimensionsForShortSide` (`mp4ExportSettings.ts:39-95`).
- Audio: `AudioProcessor.selectSupportedExportCodecForSource(demuxer)` returns AAC by default, Opus as fallback (`audioEncoder.ts`).

### Exporter tests
- `videoExporter.test.ts` (vitest, jsdom) — unit tests around `isSourceCopyFastPathEligible` / `getSourceCopyFastPathBlockers`.
- `videoExporter.browser.test.ts` — Playwright headless; runs real `VideoExporter` on a fixture WebM.
- `frameRenderer.test.ts` — Pixi-free render logic tests.
- `mp4ExportSettings.test.ts` — bitrate / dimension math.
- `gradientParser.test.ts` — CSS gradient parser used by the wallpaper path.
- `audioEncoder.test.ts` — audio processor units.
- `streamingDecoder.test.ts` — duration validation (`validateDuration`, `shouldFailDecodeEndedEarly`).
- `timestampedVideoFrameQueue.test.ts` — webcam frame queue.
- `gifExporter.test.ts` / `gifExporter.browser.test.ts` — same split for GIF.
- E2E: `tests/e2e/gif-export.spec.ts` (158 lines) launches Electron, loads `tests/fixtures/sample.webm`, exports, and asserts file size > 0.

---

## 3. Project state (current SSOT)

### `src/components/video-editor/types.ts` (433 lines) — every type the editor reads/writes
- `WebcamLayoutPreset` re-exported from `lib/compositeLayout` (`types.ts:1-5`).
- `ZoomDepth = 1|2|3|4|5|6`, `ZoomFocusMode = "manual"|"auto"` (`:3-4`).
- `WebcamSizePreset = number` (10–50, percent of canvas ref dim).
- `WebcamMaskShape = "rectangle"|"circle"|"square"|"rounded"` (`:13`).
- `WebcamPosition { cx, cy }` normalized 0-1 (`:22`).
- `ZoomRegion { id, startMs, endMs, depth, focus: ZoomFocus, focusMode?, rotationPreset?, customScale?, source?: "auto"|"manual" }` (`:71`).
- `Rotation3D { rotationX, rotationY, rotationZ }` + presets `iso/left/right` + `computeRotation3DContainScale` math (`:34-176`).
- `CursorTelemetryPoint { timeMs, cx, cy, interactionType?, cursorType? }` (`:178`).
- `CursorVisualSettings { size, smoothing, motionBlur, clickBounce, clipToBounds }` + defaults (`:195-208`).
- `TrimRegion { id, startMs, endMs }` (`:211`).
- `AnnotationType = "text"|"image"|"figure"|"blur"` + `ArrowDirection`, `FigureData` (`:217-233`).
- `BlurShape`, `BlurType`, `BlurColor`, `BlurData`, `MIN_BLUR_INTENSITY/MAX_BLUR_INTENSITY`, etc. (`:235-254`).
- `AnnotationPosition`, `AnnotationSize`, `AnnotationTextStyle`, `AnnotationTextAnimation`, `AnnotationRegion { id, startMs, endMs, type, content, textContent?, imageContent?, position, size, style, zIndex, annotationSource?: "auto-caption", figureData?, blurData? }` (`:256-303`).
- `DEFAULT_ANNOTATION_POSITION`, `DEFAULT_ANNOTATION_SIZE`, `DEFAULT_ANNOTATION_STYLE`, `DEFAULT_FIGURE_DATA`, `DEFAULT_BLUR_FREEHAND_POINTS`, `DEFAULT_BLUR_DATA` (`:305-352`).
- `CropRegion { x, y, width, height }` normalized 0-1 (`DEFAULT_CROP_REGION = {0,0,1,1}` at `:354-366`).
- `PlaybackSpeed = number` (MIN 0.1, MAX 16), `SpeedRegion { id, startMs, endMs, speed }`, `SPEED_OPTIONS` (`:368-396`).
- `ZOOM_DEPTH_SCALES: Record<ZoomDepth, number>` (1.25x → 5.0x at `:400-407`), `MIN_ZOOM_SCALE/MAX_ZOOM_SCALE` (`:409-410`), `getZoomScale(region)` (`:415-421`).

### `src/components/video-editor/editorDefaults.ts` (99 lines)
- `DEFAULT_SOURCE_DIMENSIONS = { width: 1920, height: 1080 }` (`:23`).
- `DEFAULT_GIF_OUTPUT_DIMENSIONS = { width: 1280, height: 720 }` (`:28`).
- `DEFAULT_EDITOR_APPEARANCE_SETTINGS { shadowIntensity: 0, showBlur: false, motionBlurAmount: 0, borderRadius: 0, showTrimWaveform: true }` (`:33`).
- `DEFAULT_EDITOR_LAYOUT_SETTINGS { padding: 50, aspectRatio: "16:9", cropRegion: {0,0,1,1}, wallpaper: DEFAULT_WALLPAPER }` (`:47`).
- `DEFAULT_WEBCAM_SETTINGS { layoutPreset: "picture-in-picture", maskShape: "rectangle", sizePreset: 25, position: null }` (`:59`).
- `DEFAULT_CURSOR_SETTINGS { show: true, size: 3.0, smoothing: 0.67, motionBlur: 0.35, clickBounce: 2.5, clipToBounds: false, theme: DEFAULT_CURSOR_THEME_ID }` (`:71`).
- `DEFAULT_EXPORT_SETTINGS { quality: "good", format: "mp4" }` (`:81`).
- `DEFAULT_GIF_SETTINGS { frameRate: 15, loop: true, sizePreset: "medium", outputDimensions: 1280x720 }` (`:89`).

### `src/components/video-editor/projectPersistence.ts` (561 lines)
- Defines `ProjectEditorState` (`:67`) with 27 fields including `wallpaper`, `shadowIntensity`, `showBlur`, `motionBlurAmount`, `borderRadius`, `padding`, `cropRegion`, `zoomRegions[]`, `autoZoomEnabled`, `autoFocusAll`, `trimRegions[]`, `speedRegions[]`, `annotationRegions[]`, `aspectRatio`, `webcamLayoutPreset`, `webcamMaskShape`, `webcamMirrored`, `webcamReactiveZoom`, `webcamSizePreset`, `webcamPosition`, `exportQuality`, `exportFormat`, `gifFrameRate`, `gifLoop`, `gifSizePreset`, `cursorTheme`.
- `EditorProjectData { version: number, media?: ProjectMedia, editor: ProjectEditorState, videoPath?: string }` (`:97`).
- `PROJECT_VERSION = 2` (`:65`).
- `createProjectData(media, editor)` (`:536`) → the v2 envelope written to disk.
- `normalizeProjectEditor(editor)` (`:220`) — clamps every field, normalizes wallpaper file URLs (`LEGACY_FILE_WALLPAPER_RE` at `:54`), infers `motionBlurAmount` from legacy `motionBlurEnabled`, etc.
- `toFileUrl(filePath)` / `fromFileUrl(fileUrl)` (`:148` / `:162`) — platform-correct `file://` URL conversion (Windows drive handling).
- `deriveNextId(prefix, ids)` (`:186`) — pure numeric id suffix generator.
- `validateProjectData(candidate)` (`:196`) — required for load.
- `resolveProjectMedia(candidate)` (`:205`) — accepts both the modern `media` envelope and the legacy `videoPath` string.
- `createProjectSnapshot`, `hasProjectUnsavedChanges` (`:547`, `:554`) — JSON-string comparison.

### On-disk format
- File extension `.openscreen` (`PROJECT_FILE_EXTENSION = "openscreen"`, `electron/ipc/handlers.ts:46`).
- JSON: `{ version: 2, media: { screenVideoPath, webcamVideoPath?, cursorCaptureMode? }, editor: ProjectEditorState }`.
- Saved via main-process dialog → `RECORDINGS_DIR` default, but the user can pick anywhere (the path is then remembered as `currentProjectPath`).
- Path validation: `isTrustedProjectPath` (`electron/ipc/handlers.ts:391`) — the renderer can rewrite into the same file path without the save dialog; otherwise dialog appears.
- `loadProjectFileFromPath` (`electron/ipc/handlers.ts:2712`) supports deep-loading a specific `.openscreen` path. A `.session.json` sidecar holds the matching `RecordingSession` (`:1190-1235`).

### IPC contract for save / load
- `native-bridge:invoke` (single channel, typed envelope) hosts the project's save/load RPCs (`src/native/contracts.ts:130-200`):
  - `project.saveProjectFile(payload: { projectData, suggestedName?, existingProjectPath? })` → `ProjectFileResult`.
  - `project.loadProjectFile(payload?: { projectFolder? })` → `ProjectFileResult`.
  - `project.loadCurrentProjectFile()` → re-reads `currentProjectPath`.
  - `project.loadProjectFileFromPath(payload: { path })` → `ProjectFileResult`.
  - `project.setCurrentVideoPath / getCurrentVideoPath / clearCurrentVideoPath`.
  - `project.getCurrentContext` returns `{ currentProjectPath, currentVideoPath }`.
- Legacy aliases still exist on `window.electronAPI` (`electron/preload.ts:182-202`): `saveProjectFile`, `loadProjectFile`, `loadProjectFileFromPath`, `loadCurrentProjectFile`, `setCurrentVideoPath`, `getCurrentVideoPath`, `clearCurrentVideoPath`, `setCurrentRecordingSession`, `getCurrentRecordingSession`. New code is expected to use the bridge (`docs/architecture/native-bridge.md:38`).

### Multiple windows / shared project state
- **Single window at a time carries the editor.** Either the HUD-overlay is open (recording) or the editor window is open (`createEditorWindowWrapper` at `electron/main.ts:385` swaps HUD → editor on first open; `createEditorWindow` runs `win.maximize()`, sets `title: "OpenScreen"`).
- State sharing is via **main-process singletons + bridge calls**:
  - `currentProjectPath`, `currentVideoPath`, `currentRecordingSession` live in `electron/ipc/handlers.ts:357-358`, `:364`. Mutated by IPC, read by `getCurrentContext`.
  - `NativeBridgeStateStore` (`electron/native-bridge/store.ts:24`) holds `{ system, project, cursor }` snapshots for the renderer.
  - The renderer always re-reads on mount (`VideoEditor.tsx:540` `loadInitialData`) — there is **no live pub/sub across windows**. Each window independently fetches its state via `loadCurrentProjectFile` / `getCurrentRecordingSession` / `getCurrentVideoPath`.

---

## 4. Timeline

Files: `src/components/video-editor/timeline/` plus `useAudioPeaks`/`BackgroundWaveform`/`KeyframeMarkers` helpers. Backed by the `dnd-timeline` npm library (`package.json:75`).

### Data model
- All times are **milliseconds** as integers (no floating point rounding). `Span = { start: number, end: number }`, `Range = { start: number, end: number }` (`TimelineEditor.tsx:1` imports).
- The timeline owns **5 stacked rows** (`TimelineEditor.tsx:40-44`):
  - `ZOOM_ROW_ID = "row-zoom"`
  - `TRIM_ROW_ID = "row-trim"`
  - `ANNOTATION_ROW_ID = "row-annotation"`
  - `BLUR_ROW_ID = "row-blur"` (gated by `BLUR_REGIONS_ENABLED` flag, currently `false` in `featureFlags.ts:1`)
  - `SPEED_ROW_ID = "row-speed"`
- Regions on each row are typed `TimelineRenderItem` (`TimelineEditor.tsx:106`) with a per-row `variant`.
- There is also a **keyframe track** (`TimelineEditor.tsx:945`) — opaque time markers stored as `{ id, time }[]`, snap targets during drag/resize. Rendered by `KeyframeMarkers.tsx`.

### Zoom / pan
- `TimelineEditor.tsx:118-153` `calculateAxisScale(visibleRangeMs)` picks an interval (`SCALE_CANDIDATES`) that yields ~12 major markers; ticks subdivide by 5.
- **Pan** is via wheel events without modifier (`TimelineEditor.tsx:707-745` `handleTimelineWheel`); **zoom** is Ctrl/Meta + scroll (`TimelineWrapper.tsx:496-519` `handleRangeChange`).
- Drag-the-playhead past the visible window also pans (`TimelineEditor.tsx:289-372` `PlaybackCursor` `handleMouseMove`).
- `TimelineEditor.tsx:179-184` `createInitialRange(totalMs)` starts at `[0, totalMs]`.
- `TimelineWrapper.tsx:107-131` `clampSpanToBounds` and `:133-161` `clampRange` clamp items + visible range to `[0, totalMs]`.
- `TimelineWrapper.tsx:164-194` `clampToNeighbours` prevents zoom/trim/speed from overlapping.
- `TimelineWrapper.tsx:201-293` `snapSpanToTargets` snaps to region edges, playhead, keyframes, and timeline bounds. Threshold scales with zoom (~1% of visible range, min 50 ms). `:299-311` `inferResizeMode` guesses left vs right resize from pre/post deltas.
- `TimelineWrapper.tsx:39-87` `SnapGuide` paints an amber guide on snap during drag/resize.
- The renderer's spring smoothing (`zoomSpring.ts`) and the preview's transform math (`zoomTransform.ts`) are reused by the exporter so the timeline's camera motion matches what is rendered.

### Trim UX
- Trim is one row in the same DnD lane. The `Item.tsx` template (`:43-184`) renders **left + right end-caps** (`:110-130`, `cursor: "col-resize"`) that act as resize handles. dnd-timeline drives resize from those.
- Two trim regions on the same row **cannot overlap** (`TimelineEditor.tsx:1069-1104` `hasOverlap` enforces it; `clampToNeighbours` re-clamps instead of rejecting when possible).
- Add-trim is via the `Scissors` button (`TimelineEditor.tsx:1515-1523`) or the `addTrim` shortcut (`shortcuts.ts:111` `t`). Default length is `Math.max(1000, totalMs * 0.05)` (`TimelineEditor.tsx:1107`).
- Trim is *also* where the **audio waveform** appears (`BackgroundWaveform.tsx`, peaks from `useAudioPeaks.ts` which spins up `audioPeaksWorker.ts`).

### Zoom / spring / cursor / wallpaper features
- **Spring-smoothed zoom camera**: `zoomSpring.ts` (`createZoomSpringState`, `stepZoomSpring`, `resetZoomSpring`) is consumed by both the preview and the exporter (`frameRenderer.ts:881-898`) so motion is identical in export and preview.
- **Auto-zoom (magic wand)** — `autoZoomEnabled` is editor state (`useEditorHistory.ts:31`). The `WandSparkles` button toggles it (`TimelineEditor.tsx:1489-1501`). When on, `zoomRegionUtils.ts:findDominantRegion` chooses a cursor-follow zoom at run time.
- **Auto-Focus** — `autoFocusAll` (`useEditorHistory.ts:33`), `ScanEye` toggle (`TimelineEditor.tsx:1502-1514`). `cursorFollowUtils.ts:advanceFollowFocus` smooths the focus point.
- **3D rotation** — `zoomRegion.rotationPreset` (`types.ts:46-58`) with three presets (`iso`, `left`, `right`); applied in the exporter's `threeDPass.ts` and as CSS transforms in the preview.
- **Cursor smoothing** — `cursorPathSmoothing.ts` `getSmoothedCursorPath(...)` (used at `frameRenderer.ts:566` and `:569`).
- **Wallpaper** — `wallpaper.ts` `classifyWallpaper` (color / gradient / image) feeds `FrameRenderer.setupBackground` (`frameRenderer.ts:281-372`).
- **Keyframes** — `KeyframeMarkers.tsx`; `addKeyframe` shortcut (`f`, `TimelineEditor.tsx:1245`); add/delete/move wired via `TimelineEditor.tsx:960-982`.

### Multi-video awareness
- **Single video source only.** The timeline holds **time regions** on top of one recording. `useEditorHistory.ts:28-52` shows the `EditorState` has no `assets[]`; there is one `media.screenVideoPath` in `RecordingSession`. `VideoPlayback.tsx` consumes one video at a time. The only thing multiple is the **two tracks of one capture** — the screen and a separate webcam WebM are stacked by the renderer/exporter (see §2 compositor order).
- There is **no notion of multiple clips** in the timeline. Trim regions cut the single source, not a sequence.

### Per-file notes
- `TimelineWrapper.tsx:533-544` returns `TimelineContext` with `autoScroll: { enabled: false }` (horizontal scroll is dnd-timeline-driven).
- `Row.tsx` (34 lines) — single-row lane; `Row` accepts a `background` slot for the waveform overlay and an `isEmpty` hint.
- `Subrow.tsx` (17 lines) — a generic pill-shaped row used by inspector sub-UI; not currently used by the main timeline.
- `Item.module.css` is empty (0 bytes); the timeline Item uses Tailwind + the glass styles in `ItemGlass.module.css` (`zoomEndCap`, `selected`, `glassGreen`, `glassRed`, `glassAmber`, `glassYellow`).
- `TimelineEditor.tsx:1240-1307` — global keydown listener handles all shortcut-bound region adds, Tab cycles overlapping annotations, Delete/Backspace/Ctrl+D removes selected region.
- `BackgroundWaveform.tsx` — audio peaks drawn into the trim row.

---

## 5. Native bridge

### IPC architecture
Two layers:

1. **Ad-hoc `ipcMain.handle / ipcRenderer.invoke`** channels exposed via `window.electronAPI.*` in `electron/preload.ts`. There are ~50 channels (full list in §5 below).
2. **Versioned `native-bridge:invoke` channel** (`src/native/contracts.ts:1`) with `{ domain, action, payload, requestId }` envelopes handled in `electron/ipc/nativeBridge.ts` for system, project, and cursor domains. Renderer SDK at `src/native/client.ts` (`nativeBridgeClient`).

The renderer client (Zustand-free) is `nativeBridgeClient.system|project|cursor` (`src/native/client.ts:52`). Documented at `docs/architecture/native-bridge.md`.

### `electron/main.ts` (589 lines)
- `app.commandLine.appendSwitch` for macOS screen-audio + Linux Wayland (`main.ts:35-48`).
- Single instance lock (`main.ts:116-127`) using both `app.requestSingleInstanceLock()` and `acquireStableInstanceLock()` (`electron/singleInstanceLock.ts`).
- Tray + dynamic menu (`main.ts:304-360`). Tray shows "Stop recording" during a recording; "Open" / "Quit" otherwise.
- Application menu items: `New Project (Cmd/Ctrl+N)`, `Load Project… (Cmd/Ctrl+O)`, `Save Project… (Cmd/Ctrl+S)`, `Save Project As… (Cmd/Ctrl+Shift+S)`, plus Edit/View/Window. `sendEditorMenuAction(channel)` (`:133`) targets the focused editor window or creates one.
- `close` handler with unsaved-changes confirmation flow (`main.ts:395-426`):
  - Editor sets `editorHasUnsavedChanges = true` via `set-has-unsaved-changes` IPC (`main.ts:366`).
  - On close, main asks renderer via `request-close-confirm`; renderer answers with `close-confirm-response = "save" | "discard" | "cancel"`.
  - "save" → main sends `request-save-before-close`; renderer writes then sends `save-before-close-done`.
  - "discard" → main closes via `setImmediate` + `isForceClosing` flag.

### `electron/preload.ts` (293 lines)
- Reads `--asset-base-url=` from `process.argv` (`:11-13`) and exposes it via `contextBridge.exposeInMainWorld("electronAPI", { assetBaseUrl, ... })` (`:15-16`).
- Exposes `invokeNativeBridge<TData>(request)` (`:17-19`) — the single channel the versioned bridge uses.
- Surface area is enumerated below; every other helper is a thin `ipcRenderer.invoke` wrapper.

### `electron/ipc/nativeBridge.ts` (239 lines)
- Versioned (`NATIVE_BRIDGE_VERSION = 1`) request router for `system`, `project`, `cursor` domains.
- Domain services constructed with closures to main-process state:
  - `ProjectService` (`electron/native-bridge/services/projectService.ts:25`).
  - `CursorService` (`electron/native-bridge/services/cursorService.ts:14`).
  - `SystemService` (`electron/native-bridge/services/systemService.ts`).
- Returns `{ ok: true, data, meta } | { ok: false, error: { code, message, retryable }, meta }` envelopes (`contracts.ts:124-126`).
- Error codes: `INVALID_REQUEST | UNSUPPORTED_ACTION | NOT_FOUND | UNAVAILABLE | INTERNAL_ERROR` (`contracts.ts:93-98`).

### Full IPC channel list (from `electron/ipc/handlers.ts` grep + `electron/preload.ts`)
- **HUD / window controls** (`windows.ts`, `main.ts`):
  - `hud-overlay-hide`, `hud-overlay-close`, `hud-overlay-ignore-mouse-events`, `hud-overlay-move-by`, `hud-overlay-set-size` (one-way `ipcMain.on`).
  - `menu-new-project`, `menu-load-project`, `menu-save-project`, `menu-save-project-as`, `menu-import-video` (`preload.ts:202-225`, renderer listeners via `onMenu*`).
  - `hud:setMicrophoneExpanded` (one-way).
  - `set-has-unsaved-changes` (one-way).
  - `request-save-before-close`, `request-close-confirm` (renderer listeners); `save-before-close-done`, `close-confirm-response` (one-way back).
- **Window orchestration** (`handlers.ts:1423-1488`):
  - `get-sources(opts)` → `desktopCapturer.getSources`.
  - `select-source(source)`, `get-selected-source`.
  - `request-camera-access`, `request-screen-access`, `request-native-mac-cursor-access`.
  - `open-source-selector`, `switch-to-editor`, `switch-to-hud`, `start-new-recording`.
  - `countdown-overlay-show`, `countdown-overlay-set-value`, `countdown-overlay-hide`, `countdown-overlay-value` (event).
- **Native capture** (`handlers.ts:1520-2192`):
  - `is-native-windows-capture-available`, `is-native-mac-capture-available`.
  - `start-native-windows-recording(request)`, `pause-native-windows-recording`, `resume-native-windows-recording`, `stop-native-windows-recording(discard?)`.
  - `start-native-mac-recording(request)`, `pause-native-mac-recording`, `resume-native-mac-recording`, `stop-native-mac-recording(discard?)`.
  - `attach-native-mac-webcam-recording(payload)` (`:2141`).
- **Recording storage** (`handlers.ts:2207-2360`):
  - `store-recorded-session(payload)`, `store-recorded-video(data, fileName)`.
  - `open-recording-stream(fileName)`, `append-recording-chunk(fileName, chunk)`, `close-recording-stream(fileName)` (via `recordingStream.ts:95` `registerRecordingStreamHandlers`).
  - `get-recorded-video-path` (scans `RECORDINGS_DIR` for the latest webm).
  - `get-cursor-telemetry(videoPath?)`, `discard-cursor-telemetry(recordingId)`.
  - `set-recording-state(recording, recordingId?, cursorCaptureMode?)`.
  - `get-asset-base-path`.
- **Project / export** (`handlers.ts:2368-2862`):
  - `open-external-url`.
  - `pick-export-save-path(fileName, exportFolder?)`, `write-export-to-path(data, filePath)`.
  - `open-video-file-picker`.
  - `reveal-in-folder`.
  - `read-binary-file(filePath)`, `prepare-preview-audio-track(filePath)`.
  - `set-current-video-path`, `set-current-recording-session`, `get-current-video-path`, `get-current-recording-session`, `clear-current-video-path`.
  - `save-project-file`, `load-project-file`, `load-project-file-from-path`, `load-current-project-file`.
  - `get-platform`, `get-shortcuts`, `save-shortcuts`, `save-diagnostic`.
- **Stop-from-tray** (`handlers.ts:339-341`, `preload.ts:145-148`): main → renderer `stop-recording-from-tray` event.
- **Versioned bridge** (`nativeBridge.ts:124`): single channel `native-bridge:invoke` for system/project/cursor domains above.

### `assetBaseUrl` and file:// access
- `windows.ts:14-17` builds `ASSET_BASE_DIR` (process.resourcesPath in packaged, `public/` in dev) and passes `--asset-base-url=file:///…/` via `webPreferences.additionalArguments`.
- Preload reads it from `process.argv` (`preload.ts:11-13`) and exposes it on `electronAPI.assetBaseUrl`.
- Renderer uses `window.electronAPI.assetBaseUrl` directly:
  - `src/lib/wallpaper.ts` `resolveImageWallpaperUrl(path)` (`:73` and `:204-230` tests).
  - `src/lib/captioning/transcribe.ts:93-94` and `src/lib/captioning/transcribe.worker.ts:48-65` — sets `env.localModelPath = "<assetBaseUrl>/caption-assets/models/"` and `env.backends.onnx.wasm.wasmPaths = "<assetBaseUrl>/caption-assets/ort/"` so transformers.js doesn't try to fetch from the HuggingFace CDN under `file://`.
- **Security boundary:** the renderer can only read paths the main process has explicitly approved. `electron/ipc/handlers.ts:66` `approvedPaths` set; `readBinaryFile` (`handlers.ts:2523`) checks `isPathAllowed` against `RECORDINGS_DIR` and the approved set; `get-asset-base-path` (`handlers.ts:2368`) exposes the packaged resources dir (read-only).

### Screen / audio / webcam capture
- **Screen**: macOS uses `ScreenCaptureKit` via the `OpenScreenScreenCaptureKitHelper` Swift CLI (`electron/native/screencapturekit/Sources/OpenScreenScreenCaptureKitHelper/main.swift`), Windows uses the WGC CLI (`electron/native/wgc-capture/src/main.cpp`), Linux falls back to browser `getDisplayMedia`. The main process spawns the native CLI as a child process and parses NDJSON output (`:1067-1140` for WGC; `:1727-1869` for SCK). The renderer selects the path via `useScreenRecorder.ts:781` / `:912`.
- **System audio** (macOS): requested via `app.commandLine.appendSwitch("disable-features", "MacCatapLoopbackAudioForScreenShare")` (`main.ts:36`) — uses ScreenCaptureKit audio instead of CoreAudio tap (avoids `NSAudioCaptureUsageDescription`).
- **Microphone audio**: captured by the browser `MediaRecorder` via `getUserMedia({ audio: { deviceId } })` and appended to the screen WebM in `useScreenRecorder.ts:242`.
- **Webcam**: browser `getUserMedia({ video: { deviceId } })` for browser-capture path; native helper uses DirectShow (`dshow_webcam_capture.cpp`). On macOS, webcam is a separate `.mp4` file attached to the session via `attach-native-mac-webcam-recording` (`handlers.ts:2141`). On Windows it can be muxed in directly by the native CLI.
- **Cursor capture**: `useScreenRecorder.ts` offers `cursorCaptureMode = "editable-overlay" | "system"` (`recordingSession.ts:7`). `system` hides the OS cursor and overlays the recorded telemetry; `editable-overlay` keeps the OS cursor visible during recording and overlays the recorded cursor in the editor. `CursorService` (`:14`) reads back from the cursor telemetry file (v2 format, JSON) that the native CLIs write next to the WebM.

### `recordingStream.ts` (`electron/ipc/recordingStream.ts`, 139 lines)
- `RecordingStreamRegistry` (`:11`) — owns open `WriteStream`s keyed by output file name. Methods:
  - `open(fileName, filePath)` (`:19`) — `createWriteStream({ flags: "w" })`, awaits `open` event for fail-fast.
  - `append(fileName, chunk)` (`:45`) — serializes writes so chunks land in arrival order and `close` waits for in-flight writes.
  - `finalize(fileName)` (`:59`) — `ws.end(...)` and remove; returns `true` if the stream was open (so the caller knows the file is already on disk).
  - `discard(fileName, filePath)` (`:75`) — close + `unlink` partial file.
- IPC handlers at `:95` translate the throw-on-failure contract to `{ success, error? }` so renderer callers can fallback to in-memory buffering.

### `globalShortcut.ts` (77 lines)
- Maps `ShortcutBinding` (`src/lib/shortcuts.ts:15`) to Electron `globalShortcut.register(accelerator, callback)` (`:41` `registerOpenAppShortcut`).
- Default binding `Ctrl/Cmd+Shift+O` (`globalShortcut.ts:6`).
- Reads user prefs from `SHORTCUTS_FILE = userData/shortcuts.json` (`globalShortcut.ts:66`) via `loadAndRegisterGlobalShortcut`.
- Only the `openApp` binding is exposed as a global shortcut. All other editor shortcuts are renderer-side via `ShortcutsContext`.

### `windows.ts` (322 lines) — full window list
- `createHudOverlayWindow()` (`:87`) — frameless transparent 600×160 always-on-top, bottom-centred. Reads `--asset-base-url=` from main.
- `createEditorWindow()` (`:168`) — maximized, `hiddenInset` traffic lights on macOS, `webSecurity: false` (relaxed for `file://` access).
- `createSourceSelectorWindow()` (`:231`) — frameless transparent 620×420, always-on-top.
- `createCountdownOverlayWindow()` (`:275`) — fixed 420×260, focusable: false, transparent.
- Coordination: only one `mainWindow` reference exists at a time (`main.ts:83`). On launch the HUD opens; clicking "Open studio" or stopping a recording swaps the HUD for the editor window (`createEditorWindowWrapper` at `main.ts:385`).
- All four windows share the same renderer build and preload (`preload.mjs`) but pick a top-level component by `?windowType=` (see §1).

---

## 6. Captioning pipeline

All under `src/lib/captioning/`. The renderer can transcribe a video's audio in-browser using Whisper via transformers.js, then convert the word/phrase timings into `AnnotationRegion`s.

### Files
- `transcribe.ts` (106 lines) — public entry point.
- `transcribe.worker.ts` (93 lines) — Web Worker that loads transformers.js.
- `transcribeCore.ts` (268 lines) — pure algorithm, no DOM / Workers / Transformers imports.
- `extractMono16k.ts` (159 lines) — `extractMono16kFromVideoUrl`.
- `extractMono16kWebDemuxer.ts` (162 lines) — fallback that uses `web-demuxer` + `AudioDecoder`.
- `leadingSilence.ts` (78 lines) — drops leading silence before Whisper runs.
- `annotationsFromCaptions.ts` (604 lines) — turns `CaptionSegment[]` into `AnnotationRegion[]`.
- `captionConstants.ts` — `MAX_CAPTION_AUDIO_SEC`.
- `index.ts` — barrel.
- `annotationsFromCaptions.test.ts` — unit tests.

### How Whisper runs today
`transcribeMono16kToSegments(samples, options)` (`transcribe.ts:44`):
1. Spawns a module `Worker` from `transcribe.worker.ts` (`:57`).
2. Posts `{ samples, trimRegions, useLocalModels, assetBaseUrl }` (`TranscribeWorkerRequest`, `:18`).
3. Worker (`transcribe.worker.ts:76`):
   - Calls `loadTranscriber({ useLocalModels, assetBaseUrl })` (`:46`).
   - Uses `pipeline("automatic-speech-recognition", "Xenova/whisper-tiny")` from `@xenova/transformers`.
   - With `useLocalModels=true` (file:// packaged app): `env.allowLocalModels=true`, `env.allowRemoteModels=false`, `env.localModelPath = "<assetBaseUrl>/caption-assets/models/"`, `env.backends.onnx.wasm.wasmPaths = "<assetBaseUrl>/caption-assets/ort/"`, `numThreads: 1` (no SharedArrayBuffer under file://).
   - In dev (http://localhost): `env.allowLocalModels=false`, remote CDN fetch.
4. Posts `status` "model" → "transcribe" → `result` (`CaptionSegment[]`) or `error` (`:33`).
5. `withoutNodeVersion` (`transcribe.worker.ts:25`) strips `process.versions.node` before importing Transformers/ORT so Electron workers don't try `require("fs")`.

`runTranscription` in `transcribeCore.ts:184` orchestrates the actual run:
- Tries `word` timestamps first, falls back to `phrase` if empty.
- For each mode, tries `force_full_sequences: true` then `false`; for each pair, retries with `ignoreTrims: true` and post-filters overlapping segments.
- Long audio is split into 12-minute slices (`TRANSCRIBE_SLICE_SAMPLES = 12 * 60 * 16_000`, `:34`).
- Pads short tail slices to `MIN_TRANSCRIBE_SLICE_SAMPLES = 800` so Whisper doesn't return empty (`padTailSliceForTranscribe`, `:43`).
- Dedupes adjacent segments with identical normalized text (`segmentsFromTranscriberChunks`, `:57`).

### Model files
- **Model**: `Xenova/whisper-tiny` (transformers.js ASR pipeline).
- **Storage**: bundled under `caption-assets/` (the `electron-builder.json5:42-46` `extraResources` rule copies `caption-assets/` into the packaged resources dir).
- **Fetch step**: `scripts/fetch-caption-model.mjs` populates `caption-assets/` pre-build.
- **ORT WASM**: bundled in `caption-assets/ort/`.

### Output shape
- `CaptionSegment { startSec: number, endSec: number, text: string }` (`transcribe.ts:3`).
- `TranscribeMono16kResult { segments: CaptionSegment[], granularity: "word" | "phrase" }` (`transcribe.ts:12`).

### Renderer trigger
- `VideoEditor.tsx:2209-2232` `handleGenerateCaptions()`:
  1. `extractMono16kFromVideoUrl(videoPath, { signal })` (`extractMono16k.ts:110`) — tries `decodeAudioData`, falls back to `extractMonoPcmViaWebDemuxer`.
  2. `trimLeadingSilenceMono16k(samples)` (`leadingSilence.ts:25`).
  3. `shiftTrimRegionsMsForCaptionBuffer(trimRegions, trimSec)` (`leadingSilence.ts:66`).
  4. `transcribeMono16kToSegments(samples, { trimRegions, signal })`.
  5. `captionSegmentsToAnnotationRegions(segments, …)` (`annotationsFromCaptions.ts:544`).

### Linking to time ranges in the editor
- `annotationsFromCaptions.ts:544` `captionSegmentsToAnnotationRegions` produces `AnnotationRegion[]` with:
  - `startMs`/`endMs` computed from `seg.startSec` / `seg.endSec`.
  - Position / size / style hard-coded to a lower-third bar: `position: { x: 4, y: 86 }` (`:9-13`), `size: { width: 92, height: 12 }`, `style` = white 24px Inter, `annotationSource: "auto-caption"` (`annotationsFromCaptions.ts:300`, `:574-583`).
- `groupTimedCaptionWordsIntoLines` (`:325`) groups word segments into on-screen lines of `minWords=2, maxWords=7`.
- `groupPhraseCaptionSegmentsIntoLines` (`:436`) does the same for phrase granularity.
- `reconcileAutoCaptionTimelineGaps` (`:148`) enforces a min gap between consecutive auto-caption regions.
- `captionSegmentsToAnnotationRegions` is **idempotent and stateless** — the caller is responsible for `startNumericId` and `startZIndex` and merges the new regions with existing ones. `VideoEditor.tsx` uses `maxAnnotationNumericId` / `maxAnnotationZIndex` (`annotationsFromCaptions.ts:592-603`) to keep ids stable.
- **Trim awareness**: `segmentsFromTranscriberChunks` (`transcribeCore.ts:107`) drops any segment that overlaps a `TrimRegion`, so caption ranges never sit inside a cut.

---

## 7. UI primitives

### Radix-based components (`src/components/ui/*`)
All shadcn-style "new-york" presets (`components.json:3`); baseColor `stone`, `tailwind.config.cjs` exposes HSL CSS-variable tokens (`tailwind.config.cjs:41-81`).

| File | Radix package | Notes |
|---|---|---|
| `accordion.tsx` | `@radix-ui/react-accordion` | Forwarded Radix parts. |
| `audio-level-meter.tsx` | (none) | Pure canvas/visual. |
| `button.tsx` | `@radix-ui/react-slot` (for `asChild`) | `class-variance-authority` variants (`:11`). |
| `card.tsx` | (none) | Headless panels. |
| `color-picker.tsx` | `@uiw/react-color-*` | 3rd-party UIW. |
| `content-clamp.tsx` | (none) | Text overflow utility. |
| `dialog.tsx` | `@radix-ui/react-dialog` | Z-index `9999` / `10000`. |
| `dropdown-menu.tsx` | `@radix-ui/react-dropdown-menu` | |
| `input.tsx` | (none) | |
| `item-content.tsx` | (none) | Shared list-item slot. |
| `label.tsx` | (none) | |
| `popover.tsx` | `@radix-ui/react-popover` | |
| `select.tsx` | `@radix-ui/react-select` | Z-index `100000` to sit above dialog (`select.tsx:86`). |
| `slider.tsx` | `@radix-ui/react-slider` | |
| `sonner.tsx` | (none) | Toaster wrapper. |
| `switch.tsx` | `@radix-ui/react-switch` | |
| `tabs.tsx` | `@radix-ui/react-tabs` | |
| `toggle.tsx` | `@radix-ui/react-toggle` | |
| `toggle-group.tsx` | `@radix-ui/react-toggle-group` | |
| `tooltip.tsx` | `@radix-ui/react-tooltip` | |

### Design system
- **Tailwind** (`tailwind.config.cjs`) with CSS-variable theme (`src/index.css:7-61`): `--background`, `--foreground`, `--card`, `--popover`, `--primary`, `--secondary`, `--muted`, `--accent`, `--destructive`, `--border`, `--input`, `--ring`, `--chart-1..5`, `--radius: 0.5rem`. Dark variant at `:35-60`. Editor-specific utilities (`.editor-workspace`, `.editor-preview-panel`, `.editor-timeline-panel`, `.editor-resize-handle`, `.editor-panel-section`, `.editor-control-surface`, `.editor-inspector-shell`) in `src/index.css:77-217`.
- **Brand color**: `#34B27B` (used throughout LaunchWindow / TimelineEditor). Accent `#6C55FF` (playhead). Destructive `#ef4444` (trim).
- **Cursor color tokens**: `glassGreen/glassRed/glassAmber/glassYellow` in `ItemGlass.module.css`.
- **Type ramp**: Inter (default), plus Google Fonts imported via `@import` in `src/index.css:1` (Bebas Neue, Caveat, DM Sans, Fira Code, IBM Plex, Lora, Manrope, Merriweather, Oswald, Permanent Marker, Playfair, Plus Jakarta Sans, Space Grotesk, Sora).
- **No theme provider**; the editor is forced-dark via `index.html` root background `#09090b`.

### Icons
- Primary icon set: **`lucide-react: ^0.545.0`** (`package.json:80`). Used by every UI primitive + the timeline editor (`TimelineEditor.tsx:3-14`, `Item.tsx:3`).
- HUD icons: **`react-icons` (BsPlay, BsPause, BsRecordCircle, FaRegStopCircle, FaFolderOpen, FiMinus, FiX, MdCancel, MdMic, MdMicOff, MdMonitor, MdMouse, MdRestartAlt, MdVideocam, MdVideocamOff, MdVideoFile, MdVolumeOff, MdVolumeUp, RxDragHandleDots2, Languages, Columns3, Rows3, Clapperboard, Check, ChevronDown, ScanEye, WandSparkles, Scissors, MessageSquare, ZoomIn, Gauge, Captions, Captions, Plus, MousePointer2)** — see `LaunchWindow.tsx:1-21` and `TimelineEditor.tsx:3-14`.
- Arrow SVGs (caption arrows): `src/components/video-editor/ArrowSvgs.tsx` (5119 bytes, 8 directions).

### i18n setup
- `src/i18n/config.ts` (30 lines) — `DEFAULT_LOCALE = "en"`, `SUPPORTED_LOCALES = [en, ar, es, fr, it, ja-JP, ko-KR, ru, tr, vi, pt-BR, zh-CN, zh-TW]` (13), `I18N_NAMESPACES = [common, dialogs, editor, launch, settings, shortcuts, timeline]` (7).
- `src/i18n/loader.ts` (125 lines) — `import.meta.glob("./locales/**/*.json", { eager: true })` builds `messages[locale][namespace]`. `translate(locale, namespace, key, vars)` interpolates `{{name}}` placeholders. Missing namespaces are logged but excluded from `availableLocales`.
- `src/contexts/I18nContext.tsx` (192 lines) — provider with `useI18n()` + `useScopedT(namespace)`. Stored in `localStorage[openscreen-locale]`. On change it calls `window.electronAPI?.setLocale?.(newLocale)` which hits the main-process `set-locale` handler (`main.ts:542`) so the application menu re-renders with translated labels.
- Main process i18n (`electron/i18n.ts`, 113 lines — abbreviated `mainT`) covers the application menu and any main-process toasts / dialog labels.

### 13 locales (full list)
`en` (default), `ar`, `es`, `fr`, `it`, `ja-JP`, `ko-KR`, `ru`, `tr`, `vi`, `pt-BR`, `zh-CN`, `zh-TW`. Each locale has 7 namespace JSON files (`common`, `dialogs`, `editor`, `launch`, `settings`, `shortcuts`, `timeline`) under `src/i18n/locales/<locale>/`. Total: 91 locale files.

### Radix collision with axcut patterns
- OpenScreen uses shadcn `new-york` preset with `stone` base color and the standard CSS-variable HSL palette. Axcut uses **the same shadcn `new-york` preset** (per the merge plan references), so primitives like `button`, `dialog`, `popover`, `select`, `dropdown-menu`, `slider`, `tooltip`, `tabs`, `accordion`, `toggle`, `toggle-group`, `switch` should be **drop-in compatible**.
- OpenScreen already uses `@radix-ui/react-popover`, `@radix-ui/react-select`, `@radix-ui/react-dialog`, `@radix-ui/react-tooltip`, `@radix-ui/react-dropdown-menu`, `@radix-ui/react-tabs`, `@radix-ui/react-slider`, `@radix-ui/react-switch`, `@radix-ui/react-accordion`, `@radix-ui/react-toggle`, `@radix-ui/react-toggle-group` — covers the full axcut surface from the plan.
- Custom OpenScreen primitives to watch: `audio-level-meter.tsx` (real-time mic level meter), `color-picker.tsx` (UIW `@uiw/react-color-colorful`), `content-clamp.tsx` (line-clamp wrapper), `item-content.tsx`. None of these are mentioned in the plan, so they are likely unique to OpenScreen.

---

## 8. Settings + preferences

### `src/lib/userPreferences.ts` (145 lines)
Schema:

```ts
interface UserPreferences {
  padding: number;       // 0-100, default 50 (DEFAULT_EDITOR_LAYOUT_SETTINGS.padding)
  aspectRatio: AspectRatio;  // one of 16:9, 9:16, 1:1, 4:3, 4:5, 16:10, 10:16, native
  exportQuality: ExportQuality; // "medium" | "good" | "source", default "good"
  exportFormat: ExportFormat;   // "mp4" | "gif", default "mp4"
  exportFolder: string | null;  // remembered folder from save dialog
  projectFolder: string | null; // remembered folder from open-project dialog
  trayLayout: "horizontal" | "vertical"; // HUD layout, default "horizontal"
}
```

- Key `openscreen_user_preferences` in `localStorage`.
- `loadUserPreferences()` (`:59`) parses + clamps + falls back to `DEFAULT_PREFS`.
- `saveUserPreferences(partial)` (`:137`) merges into current and writes.
- `parentDirectoryOf(filePath)` (`:111`) + `getExportFolder()` / `getProjectFolder()` (`:127`, `:132`) helpers used to seed file dialog defaults.
- Auto-save effect in `VideoEditor.tsx:619-623` syncs `padding, aspectRatio, exportQuality, exportFormat` whenever they change.

### Other persisted prefs
- **`shortcuts.json`** (`electron/ipc/handlers.ts:46` `SHORTCUTS_FILE`) — at `userData/shortcuts.json`, the configurable shortcuts (`SHORTCUT_ACTIONS` in `shortcuts.ts:1-12`). Read on launch by `globalShortcut.ts:66` and `ShortcutsContext.tsx:43`; written via `saveShortcuts` IPC (`handlers.ts:2852`).
- **Locale** — `localStorage[openscreen-locale]` (`I18nContext.tsx:104`).
- **System language prompt seen flag** — `localStorage[openscreen-system-language-prompt-seen]` (`I18nContext.tsx:26`).
- **Custom fonts** — `src/lib/customFonts.ts` injects `<style>` into `document.head` (`:79`); no file persistence, but each font family is cached in `document.fonts`.
- **Editor per-project state** — `*.openscreen` files (see §3).
- **Last active project / recording paths** — main-process singletons (`electron/ipc/handlers.ts:357-358`, `:364`).

---

## 9. Shortcuts

`src/lib/shortcuts.ts` (176 lines). Two groups: configurable (`SHORTCUT_ACTIONS`) and fixed (`FIXED_SHORTCUTS`).

### Configurable shortcuts (`SHORTCUT_ACTIONS`, `shortcuts.ts:1-11`)
| Action | Default binding (`DEFAULT_SHORTCUTS`, `:108-118`) | Used by |
|---|---|---|
| `openApp` | `Ctrl/Cmd+Shift+O` | Global `electron.globalShortcut` (open main window). |
| `addZoom` | `Z` | Timeline (`TimelineEditor.tsx:1248`). |
| `addTrim` | `T` | Timeline (`:1251`). |
| `addSpeed` | `S` | Timeline (`:1260`). |
| `addAnnotation` | `A` | Timeline (`:1254`). |
| `addBlur` | `B` | Timeline (`:1257`, gated by `BLUR_REGIONS_ENABLED`). |
| `addKeyframe` | `F` | Timeline (`:1245`). |
| `deleteSelected` | `Ctrl/Cmd+D` | Timeline (`:1286`). |
| `playPause` | `Space` | Not currently bound to a handler in `TimelineEditor` — wired in `PlaybackControls`. |

### Fixed shortcuts (`FIXED_SHORTCUTS`, `shortcuts.ts:32-75`)
- `undo` — `Ctrl+Z`.
- `redo` — `Ctrl+Shift+Z` or `Ctrl+Y`.
- `cycleAnnotationsForward` — `Tab` (handled inline at `TimelineEditor.tsx:1265`).
- `cycleAnnotationsBackward` — `Shift+Tab`.
- `deleteSelectedAlt` — `Delete` / `Backspace`.
- `panTimeline` — `Shift+Ctrl+Scroll` (display only, not enforced).
- `zoomTimeline` — `Ctrl+Scroll` (display only).
- `frameBack` / `frameForward` — `←` / `→`.

### Collision check with axcut (Ctrl+C / Ctrl+V for clip duplicate)
- OpenScreen does **not** bind `Ctrl+C` / `Ctrl+V` to clip duplicate today. `Tab` cycles annotations; `Delete` / `Backspace` / `Ctrl+D` delete selected region.
- However, `Ctrl+C` and `Ctrl+V` are intercepted by Electron's application menu as `Edit > Copy` / `Edit > Paste` (`main.ts:231-233`). In the editor's text inputs these behave normally; in the canvas they would currently go to the system clipboard with no effect (the menu items are wired to native `role: "copy"` / `"paste"`).
- **The merge plan's Ctrl+C / Ctrl+V = duplicate clip will collide** with the existing Edit menu items. The fix is either:
  - Override `role: "copy"` / `role: "paste"` on the menu to send renderer-targeted IPC and have the editor handle them, or
  - Keep the global native copy/paste but bind `Ctrl+Shift+D` / `Ctrl+Shift+V` (or use `Cmd+D` which is already `deleteSelected`) for duplicate.
- `Ctrl+D` is **already bound** to `deleteSelected` (`shortcuts.ts:116`). `findConflict` (`:90`) will reject a duplicate-clip binding on `Ctrl+D` because both are `configurable`. The conflict-detection system at `:90-106` is already in place.

---

## 10. Performance + concurrency

### Web Workers
Three:

| File | Purpose | Spawned by |
|---|---|---|
| `src/lib/captioning/transcribe.worker.ts` | Whisper ASR. | `transcribe.ts:57` `new Worker(new URL("./transcribe.worker.ts", import.meta.url), { type: "module" })`. |
| `src/hooks/audioPeaksWorker.ts` (43 lines) | Computes audio peaks for waveform display. | `useAudioPeaks.ts:21` `new Worker(...)`. |
| `gif.js` worker (`gif.js/dist/gif.worker.js`, external library) | GIF encoding. | `gifExporter.ts:25` via `GIF_WORKER_URL`. |

The caption worker is terminated on completion/abort (`transcribe.ts:67`).

### Pixi.js contexts
- **Preview** — `src/components/video-editor/VideoPlayback.tsx:1027` (creates a `pixi.js` `Application` and mounts the canvas inside the editor preview).
- **Export** — `FrameRenderer.ts:196` creates a separate offscreen Pixi.js app per export (`new Application({ canvas, width, height, backgroundAlpha: 0, antialias: true, resolution: 1, autoDensity: true })`).
- Tests: `vitest.browser.config.ts` runs Playwright with Chromium to render Pixi in jsdom-incompatible code paths (`src/lib/exporter/videoExporter.browser.test.ts`, `src/lib/exporter/gifExporter.browser.test.ts`).

### Main-process concurrency
- **Streams only**: `RecordingStreamRegistry` (`electron/ipc/recordingStream.ts:11`) holds a `Map<fileName, WriteStream>` per open recording. No explicit locking — writes are serialized via the Node `WriteStream` internal queue + an `enqueueWrite` promise chain in the renderer (`recorderHandle.ts:50-67`).
- **Native capture subprocesses**: `electron/ipc/handlers.ts:404-425` holds separate state per platform (`nativeWindowsCaptureProcess`, `nativeMacCaptureProcess`). Single process per platform at a time (rejects parallel start). Spawned via `node:child_process.spawn`.
- **No mutex / lock / queue primitive** in main. Operations are guarded by re-entrancy checks (`activeNativeRecording.finalizing`, `cursorRecordingSession !== null`).

### IPC pub-sub / event bus
- **Native bridge has events** (`NativeBridgeEventName`, `src/native/contracts.ts:230-238`): `project.contextChanged`, `cursor.providerChanged`, `cursor.telemetryLoaded`. The events are *typed* and *advertised* but **no transport is wired** for them today (no `webContents.send` to deliver them; renderer code does not subscribe). They are scaffolding for future use.
- **Implicit pub-sub** via `webContents.send`:
  - `selected-source-changed`, `source-selector-closed`, `countdown-overlay-value`, `stop-recording-from-tray`, `request-close-confirm`, `request-save-before-close`, `main-process-message` (echoes date string back, mostly debug).
  - The renderer subscribes via `on*` callbacks exposed in `preload.ts`.
- **No main-process EventEmitter shared between services** aside from `nativeMacCaptureEvents` (`handlers.ts:51`, used internally for the macOS SCK child process).

---

## 11. Tests

### Inventory (32 test files)
Unit (vitest, jsdom) and browser (Playwright headless Chromium):
- `src/lib/exporter/{videoExporter,videoExporter.browser,frameRenderer,mp4ExportSettings,gradientParser,streamingDecoder,timestampedVideoFrameQueue,audioEncoder,gifExporter,gifExporter.browser}.test.{ts,tsx}` — exporter pipeline.
- `src/lib/{wallpaper,userPreferences,nativeMacRecording,compositeLayout,cursorTelemetryBuffer,blurEffects,annotationTextAnimation}.test.{ts,tsx}` — utility modules.
- `src/lib/captioning/annotationsFromCaptions.test.ts` — caption grouping & spacing.
- `src/lib/cursor/{nativeCursor,cursorPathSmoothing}.test.ts` — cursor telemetry / smoothing.
- `src/lib/__tests__/frameStepNavigation.test.ts` — frame step.
- `src/components/video-editor/{projectPersistence,editorDefaults,customPlaybackSpeed,backgroundImageUpload}.test.{ts,tsx}` — editor state.
- `src/components/launch/{LaunchWindow,SourceSelector}.test.tsx` and `openSourceSelectorFlow.test.ts` — HUD/launch flows.
- `src/hooks/{recorderHandle,useCameraDevices}.test.ts` — recorder + camera devices.
- `src/utils/aspectRatioUtils.test.ts`.
- `src/i18n/__tests__/tutorialHelpTranslations.test.ts`.
- `electron/{singleInstanceLock,ipc/recordingStream}.test.ts` — main process units.
- `src/components/video-editor/videoPlayback/zoomSpring.test.ts`.

### Vitest vs browser-vitest split
- **`vitest.config.ts`** (jsdom env) — 27 unit tests including all editor state, util, caption, cursor, recorder tests.
- **`vitest.browser.config.ts`** (Playwright headless shell, real DOM + Pixi) — only `videoExporter.browser.test.ts` and `gifExporter.browser.test.ts`.
- Split reason: jsdom can't construct `OffscreenCanvas`/`VideoFrame`/WebCodecs needed by the exporter.

### E2E (Playwright, `tests/e2e/`)
- `gif-export.spec.ts` (158 lines) — spawns Electron, loads `tests/fixtures/sample.webm` directly into the editor, exports both mp4 and gif, asserts file size > 0, optionally `ffprobe`s the MP4 if available (`tests/e2e/gif-export.spec.ts:14`).
- `windows-native-checklist.spec.ts` (322 lines) — Windows-specific checklist: launches Electron, exercises the native-bridge RPCs (`system.getCapabilities`, `cursor.getCapabilities`, etc.) to validate the helper availability and capabilities handshake (`tests/e2e/windows-native-checklist.spec.ts:8`).
- Fixtures: `tests/fixtures/sample.webm` (23 KB) and `tests/fixtures/sample-inflated-duration.webm` (1.2 KB) for duration-validation tests.

### Recorder handle tests (`src/hooks/recorderHandle.test.ts`, 264 lines)
Eight tests covering streaming to disk, fallback to in-memory when open fails, fallback when IPC rejects, no truncation when writes are in flight, error propagation from `appendRecordingChunk` (success=false and rejection), buffering without `fileName`, and `discard` semantics.

---

## 12. Build + distribution

### `electron-builder.json5`
- `appId: com.etiennelescot.openscreen`, `productName: Openscreen`, `asar: true`, `asarUnpack: ["**/*.node"]`.
- `extraResources`:
  - `public/wallpapers` → `wallpapers/`.
  - `public/cursors` → `cursors/`.
  - `caption-assets` → `caption-assets/`.
- **mac** — `hardenedRuntime: true`, entitlements `macos.entitlements`, target `dmg` for both `x64` and `arm64`, native helper from `electron/native/bin/darwin-*/*`.
- **linux** — targets `AppImage, deb, pacman`, no native helper.
- **win** — target `nsis` (oneClick: false, allowToChangeInstallationDirectory: true), native helper from `electron/native/bin/win32-*/*`.
- `beforePack: scripts/before-pack.cjs` — fetches the auto-caption model + ORT wasm into `caption-assets/` (idempotent).

### Native helper build scripts
- `scripts/build_macos.sh` (`build:mac` npm script wraps `build:native:mac + tsc + vite build + electron-builder --mac`).
- `scripts/build-macos-screencapturekit-helper.mjs` — invokes `swift build` for `electron/native/screencapturekit` (Swift Package Manager, `Package.swift`).
- `scripts/build-windows-wgc-helper.mjs` — invokes `cmake` for `electron/native/wgc-capture` (`CMakeLists.txt`).
- `scripts/test-windows-wgc-helper.mjs` — helper-level smoke test (5 mode variants).

### `scripts/i18n-check.mjs` (87 lines)
Validates every locale folder has the same key tree as `en/` for all 7 namespaces. Lists missing keys per locale; fails with non-zero exit if any locale is out of sync. Run via `npm run i18n:check` (`package.json:27`).

### Other scripts (`scripts/`)
- `before-pack.cjs` — caption-asset fetch step (above).
- `capture-openscreen-preview.mjs`, `inspect-native-cursor-click-bounce.mjs` — diagnostic / screenshot tools.
- `test-windows-native-cursor.mjs` — native cursor helper smoke test.
- `fetch-caption-model.mjs` — model pre-download.

### Build commands
- `npm run dev` — vite dev server (Electron window opens via `vite-plugin-electron`).
- `npm run build` — full `tsc && vite build && electron-builder`.
- `npm run build-vite` — Vite + tsc only (no packaging), used by Playwright e2e setup.
- `npm run lint` / `npm run format` — Biome 2.4 (`biome.json`, `package.json:24-25`).
- `npm run test` (vitest), `npm run test:browser` (Playwright), `npm run test:e2e` (Playwright e2e).
- `npm run prepare` — `husky` for pre-commit hooks (`lint-staged` runs Biome on staged `*.{ts,tsx,js,jsx,mts,cts,json}`).

---

## 13. Anything else relevant to the merge

### Code that touches "schema" or "document" (potential collisions)
- `useScreenRecorder.ts:963`, `src/lib/nativeMacRecording.ts:7`, `src/lib/nativeMacRecording.ts:53` — native capture **requests** carry `schemaVersion: 1` (`NativeMacRecordingRequest`, `NativeWindowsRecordingRequest`). These are IPC payload schemas, not the project document. If axcut's plan renames or extends these, both sides must move together.
- `ProjectFileResult` (`src/native/contracts.ts:84`) carries `project?: unknown` — the on-disk project JSON is currently passed as `unknown` through the bridge and parsed only in the renderer. The merge plan's `AxcutDocument` will become the **typed** shape; bridge contract stays `unknown`, but renderer + persistence switch.
- `PROJECT_VERSION = 2` (`projectPersistence.ts:65`) — current on-disk schema is v2; the merge plan bumps to v3 with `legacyEditor` preserved.
- `electron-builder.json5:46` already lists `caption-assets` as `extraResources`. The merge plan's "resources/` folder referenced for `apps/server`/`py/axcut-core` does not exist; nothing to deprecate here.

### Plugins / extension points
- **No plugin system in OpenScreen.** All "extension" code paths are hardwired (compositor layers in `FrameRenderer`, IPC channels in `handlers.ts`, Radix UI primitives). The closest thing to extensibility is:
  - `native-bridge:invoke` domain routing — a new domain (`chat`, `agent`) can be added without breaking other domains (`src/native/contracts.ts:130`).
  - `NativeBridgeEventName` (`contracts.ts:230`) declares events for `project.contextChanged`, `cursor.providerChanged`, `cursor.telemetryLoaded` — typed but **not yet wired** (no transport). Adding a transport (e.g. `EventEmitter` or `webContents.send`) is the cleanest place to add the merge plan's "per-project event bus" without inventing a new channel.
  - `getExportFolder` / `getProjectFolder` are the only places user prefs cross into the IPC layer; AI Edition prefs (default provider, default model, reasoning effort per the merge plan §Phase 9) can extend `UserPreferences` cleanly.

### Documentation files (`docs/`)
- `docs/architecture/ai-edition-roadmap.md` — the merge plan itself.
- `docs/architecture/native-bridge.md` (39 lines) — describes the versioned IPC pattern.
- `docs/tests/writing-tests.md`.
- `docs/testing/windows-native-cursor.md`, `docs/testing/macos-native-cursor.md` — native-helper smoke-test notes.
- `docs/engineering/windows-native-recorder-roadmap.md`, `docs/engineering/macos-native-recorder-roadmap.md`.
- Project root also has `README.md` (7976 bytes), `CONTRIBUTING.md`, `LICENSE`, `AGENTS.md` (the canonical agents guide referenced by merge plan). No other `.md` files in the repo (`grep -r '\.md$' --include=*` returns only those).

### Other notes
- `electron/electron-env.d.ts` (9690 bytes) — the full TypeScript surface of `window.electronAPI` exposed by the preload. This is the authoritative list of legacy ad-hoc IPC and should be cross-checked against the merge plan's new channels (`ai-edition:document:get`, `ai-edition:chat:run`, `ai-edition:sessions:list`, etc.) — none exist yet.
- `RecordingStreamRegistry` (`electron/ipc/recordingStream.ts:11`) is generic enough to host **appending bytes for any streamed IPC payload** — e.g. an axcut asset import that streams a file to disk.
- `assetBaseUrl` plumbing (`electron/preload.ts:11-13` + `src/lib/assetPath.ts` + `src/lib/wallpaper.ts`) is the canonical pattern for shipping bundled assets under `file://`. The merge plan explicitly calls out `transcribe.ts:93-94` as the template to copy when axcut's agent runtime needs to ship models or templates — `transcribe.worker.ts:55-61` shows the matching env-var shape.
- The recorder's `recordingId` is `Date.now()` (`useScreenRecorder.ts:808`, `:1020`), so it's millisecond timestamp + counter — collisions are theoretically possible if two recordings start in the same millisecond on different windows. Not relevant in practice; merge plan's `assets[].id` should generate via `crypto.randomUUID()` like the timeline (`TimelineEditor.tsx:17`).
- `useEditorHistory.ts` (164 lines) holds the undo/redo state machine (80-step ring buffer, `pushState`/`updateState`/`commitState`/`undo`/`redo`/`resetState`). The merge plan's `AxcutDocument.history.revisions[]` will replace this; `pushState` → record a revision, `undo` → restore.
- The `currentRecordingSession` singleton (`handlers.ts:358`) is the closest existing thing to the plan's `activeProject` — it's a single in-flight `RecordingSession`, replaced wholesale on every stop. The plan's per-project model will need an index of all open projects, not just the active one.
- `LICENSE` = MIT; `package.json:5` author/maintainers are listed; `electron-builder.json5:84` sets the linux `maintainer`.
