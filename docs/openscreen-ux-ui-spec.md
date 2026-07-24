# OpenScreen — Complete Front-End UX/UI Specification

This spec covers everything a user can do, see, and trigger from the **renderer (front web app)** of OpenScreen, across all four windows the app loads.

## 1. Application surface

OpenScreen is an Electron + React renderer. The URL `?windowType=...` parameter picks which component the renderer shows. The renderer never boots a multi-page SPA — it is one HTML entrypoint with four top-level React components, lazy-loaded where it matters.

| `?windowType=` | Component | Window type | Purpose |
|---|---|---|---|
| _(unset)_ | Static fallback | Main editor | Renders only an `<h1>OpenScreen</h1>` — boot is treated as broken in this branch |
| `hud-overlay` | `<LaunchWindow>` | Transparent, frameless, mouse-passthrough overlay | Floating recording HUD that lives on top of the user's desktop |
| `source-selector` | `<SourceSelector>` | Glassy modal-style picker | Pick a screen or window to record |
| `countdown-overlay` | `<CountdownOverlay>` | Transparent, frameless | Shows `3 · 2 · 1` over the whole desktop before recording starts |
| `editor` | `<VideoEditor>` + `<ShortcutsConfigDialog>` | Standard BrowserWindow with titlebar | The "Studio": preview, timeline, settings, export |

`<VideoEditor>` itself wraps the lazy `<ShortcutsConfigDialog>` so the shortcuts dialog is code-split behind it. The dialog is mounted globally so it can be opened from the inspector panel via `useShortcuts().openConfig()`.

There is also a tray icon and a global app menu (File / Edit / View / Window) defined in `electron/main.ts`. The renderer reacts to:

- Application menu File submenu → New Project (⌘N), Load Project (⌘O), Save Project (⌘S), Save Project As (⌘⇧S).
- Edit menu: standard Undo / Redo / Cut / Copy / Paste / Select All (handled by Electron's native roles).
- View menu: Reload, Force Reload, DevTools, Actual Size, Zoom In/Out, Toggle Fullscreen.
- Tray context menu: shows **Open** while idle; switches to **Stop Recording** while recording.

A single-instance lock guarantees that double-launching focuses the existing window.

---

## 2. `<LaunchWindow>` — Recording HUD overlay

A draggable, mouse-passthrough glassmorphic pill that lives on top of the desktop. Layout and content are designed for a one-click "hit record" workflow.

### 2.1 Top-level layout

The HUD mounts inside a div with `min-w-0 max-w-full overflow-hidden` and a `body { background: transparent }` override. The bar itself is `fixed bottom-5 left-1/2 -translate-x-1/2`, drag handle to the left, controls in the centre, window controls to the right. The window is mouse-ignored by default (`setHudOverlayIgnoreMouseEvents(true)`); it only becomes interactive when the user hovers a button or opens a popup.

The window auto-resizes to fit content via a `ResizeObserver` and `window.electronAPI.setHudOverlaySize(w, h)`. Padding ensures the shadow isn't clipped and a system-language prompt can pop up above the bar without overlap.

### 2.2 Controls (left → right, horizontal mode is default)

Every control is also vertically stackable — the layout toggle is the first button in the bar (Columns3 / Rows3 icons). The choice is persisted in `localStorage` as `userPreferences.trayLayout`.

1. **Drag handle** — six-dot grip, pointer-captured. Drag moves the HUD overlay (`moveHudOverlayBy`); releases re-ignore mouse events.
2. **Layout toggle** — swaps between horizontal (`Columns3` icon, default) and vertical (`Rows3` icon, `aria-pressed=true` when vertical). Tooltip "Use vertical tray" / "Use horizontal tray".
3. **Source picker button** — screen icon + truncated source name (e.g. "Entire Screen"). Disabled during recording. Opens `<SourceSelector>` window. Selection is mirrored in the bar every 500ms and whenever the source changes (so the label updates without polling the user).
4. **Audio group** — three buttons in a single rounded container:
   - System audio (`MdVolumeUp` / `MdVolumeOff`). Disabled during recording.
   - Microphone (`MdMic` / `MdMicOff`). When enabled and not recording, an **Audio Level Meter** + mic picker pop-up appears above the bar: shows the current mic name (truncated), a `<select>` of all `getUserMedia` microphones, and a 5-bar level meter driven by `useAudioLevelMeter` (FFT analyser, smoothing 0.8). Pop-up collapses on mouse leave / blur.
   - Webcam (`MdVideocam` / `MdVideocamOff`). When enabled and not recording, a webcam pop-up shows the camera label + `<select>` and gracefully handles `Searching…`, `Camera unavailable`, `No camera found` states.
5. **Cursor mode** (only on macOS / Windows, hidden on Linux) — toggles between `editable-overlay` (default, OpenScreen draws a stylised cursor you can theme/edit) and `system` (record OS cursor as-is).
6. **Record/Stop button**:
   - When idle and a source is selected: pill with the red **record** icon, plus the source name on hover.
   - When idle and no source: same pill but greyed, clicking it opens the Source Selector first and then auto-starts recording once a source is picked (`recordAfterSourceSelectionRef`).
   - When recording: red/amber pill with the **stop** icon plus a `mm:ss` elapsed timer (`formatTimePadded`) that ticks up live. Background turns red while running, amber when paused.
7. **Recording-state auxiliary buttons** (only while recording):
   - **Pause/Resume** (`BsPauseCircle` ↔ `BsPlayCircle`) — only shown if `canPauseRecording`.
   - **Restart** (`MdRestartAlt`) — throws away current take and starts fresh.
   - **Cancel** (`MdCancel`) — discards the current take without saving.
8. **Open Studio** (`Clapperboard` icon, hidden during recording) — switches to the editor window via `window.electronAPI.switchToEditor()`.
9. **Language button** (right sidebar) — pill labelled with the current locale short name (e.g. "EN"), opens a portal-rendered language menu above the bar. Each item shows the localized language name with a check next to the current one. Click-outside and `Esc` close it. Width is constrained so it doesn't overflow the desktop. The list of locales is pulled from `getAvailableLocales()`.
10. **Window controls** (far right) — `−` (hide HUD, keeps app running) and `×` (close app).

### 2.3 Hover behaviour

- Hover/pointer-enter on the bar enables mouse events on the overlay (`setHudOverlayIgnoreMouseEvents(false)`).
- Pointer-leave disables them again, except while a popup is open.
- The selected source name refreshes every 500 ms plus on `onSelectedSourceChanged`, so the bar stays in sync if a non-OpenScreen app pops a system picker.

### 2.4 System-language prompt

If the OS locale differs from the current UI locale and hasn't been resolved, a glassy card slides in at `top-8 center`:

- Title: "Use your system language?"
- Body: "We detected X as your system language. Do you want to switch OpenScreen to X?"
- Two buttons: **Keep current language** / **Switch to X**. Both resolve the prompt so it never reappears.

### 2.5 Loading and error states

The HUD itself doesn't have an explicit "loading" state — `useScreenRecorder` handles all of that internally. Errors surface via Sonner toasts triggered from the recorder hook:

- "Camera access is blocked. Enable it in system settings to use the webcam."
- "Microphone access denied. Recording will continue without audio."
- "Camera access denied. Recording will continue without webcam."
- "Webcam disconnected." / "Camera not found."
- "System audio not available. Recording without system audio."
- "Recording permission denied. Please allow screen recording."
- "Allow Accessibility access for OpenScreen, then press record again to start the countdown." (macOS)

### 2.6 Countdown integration

When the user hits Record, the recorder calls `window.electronAPI.showCountdownOverlay(value, runId)` to spawn the `<CountdownOverlay>` window. The HUD doesn't itself render numbers — it just waits for the recorder to flip into the recording state.

---

## 3. `<SourceSelector>` — Pick a screen/window

A separate window (no chrome, glass container) that lists available capture sources. The whole window scrolls.

### 3.1 Layout

- Full-viewport glass container with `min-h-screen`, centred content.
- Top: two **tabs** (grid of cards beneath):
  - **Screens (N)** — `id` starts with `screen:`
  - **Windows (N)** — `id` starts with `window:`
- Each tab shows a 2-column, vertically-scrolling grid of thumbnail cards, fixed height `282px`, `overflow-y-auto`.
- Bottom: a sticky footer with `Cancel` and `Share` buttons (`Share` is disabled until a source is picked).

### 3.2 Source card

Each card is a small `<button>` (renders as a div with role) showing:

- 16:9 thumbnail (320×180 requested from `getSources`).
- Source name + small app icon (only when `appIcon` is non-null).
- When selected: bright green border + check badge in the top-right corner.

Selection is single — clicking another card swaps the selection. Clicking the same card again keeps it selected.

### 3.3 Loading state

While `getSources` resolves, the entire body becomes a centred spinner with the label "Loading sources…".

### 3.4 Empty / failure state

If `getSources` returns zero sources (or rejects), the body becomes a centred card:

- Heading "No screens or windows found".
- Body text either "If you just granted screen recording permission, reload this picker. On macOS you may need to reopen OpenScreen." or the load-failed variant.
- **Reload** button — re-invokes `getSources`.

### 3.5 Window lifetime

The selector is opened via `window.electronAPI.openSourceSelector()`. When it closes, the editor / HUD is notified via `onSourceSelectorClosed` so any "record after pick" intent is cancelled.

---

## 4. `<CountdownOverlay>` — 3·2·1

A separate transparent, frameless, `pointer-events: none` window that overlays the desktop.

- Subscribes to `window.electronAPI.onCountdownOverlayValue((value) => …)`. Renders nothing until the first value arrives.
- The countdown number is rendered at `80px` font weight, centred in a `160×160` dark translucent circle with a heavy text shadow.
- The overlay disappears when the recorder hides it (`hideCountdownOverlay`).

---

## 5. `<VideoEditor>` — Studio

This is the largest UI surface. It opens as a standard Electron BrowserWindow with the macOS-style traffic-light buttons (mac) or the platform default (Windows/Linux) and is laid out as a `flex flex-col h-screen` shell.

### 5.1 Top-level structure

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Top bar (h-11, draggable) — language, new recording, load, save         │  (WebkitAppRegion: drag)
├──────────────────────────────────────────────────────────────────────────┤
│  EditorEmptyState  (only when no video is loaded)                        │
│        OR                                                              │
│  Resizable panel group (vertical, react-resizable-panels)                │
│   ┌─────────────────────────────────────────────────────────────┐       │
│   │ Panel (default 67%, 46–76%)                                  │       │
│   │  ┌─────────────────────────────┬──────────────────────────┐  │       │
│   │  │ editor-preview-zone          │ editor-settings-rail      │  │       │
│   │  │  • Video preview (Pixi)     │  • Mode rail + accordion │  │       │
│   │  │  • Playback controls bar    │    panels                 │  │       │
│   │  └─────────────────────────────┴──────────────────────────┘  │       │
│   └─────────────────────────────────────────────────────────────┘       │
│   ═══════════════ resize handle (h-1 hover-glow pill) ═══════════════   │
│   ┌─────────────────────────────────────────────────────────────┐       │
│   │ Panel (default 33%, 24–54%) — TimelineEditor                  │       │
│   └─────────────────────────────────────────────────────────────┘       │
├──────────────────────────────────────────────────────────────────────────┤
│  Overlays (z-50 / 60): ExportDialog, UnsavedChangesDialog, etc.          │
└──────────────────────────────────────────────────────────────────────────┘
```

There is also a global `<Toaster>` (dark Sonner) mounted at the app root for transient notifications.

### 5.2 Top bar (always visible)

Eleven-pixel-tall bar with `WebkitAppRegion: drag` so the user can move the window; child buttons set `WebkitAppRegion: no-drag`. From left to right:

- **Language picker** (`Languages` icon + `<select>` showing 13 locales: en, ar, es, fr, it, ja-JP, ko-KR, pt-BR, ru, tr, vi, zh-CN, zh-TW). Each option uses its localized native name.
- **New Recording** (`Video` icon + label) — opens a confirmation dialog.
- **Load Project** (`FolderOpen` icon + "Load Project") — file picker via `nativeBridgeClient.project.loadProjectFile`.
- **Save Project** (`Save` icon + "Save Project") — saves in place; if not yet saved, prompts for a path.

The macOS-only traffic-light buttons appear in the top-left (handled by Electron, the language selector leaves `ml-14` on macOS to clear them).

### 5.3 Loading and error screens

While `useEditorHistory` and project IPC are still resolving, the editor shows a centred "Loading video…" label on the `#09090b` background. On a hard load error, the editor shows a destructive-tinted error message + a "Load Project" button.

### 5.4 `<EditorEmptyState>` — Studio dashboard

Renders only when no video is loaded. A drop zone occupies the entire region.

- Logo (64×64, opacity 90).
- Heading "No project open" and description.
- Two stacked buttons:
  - **Import Video File…** — opens `window.electronAPI.openVideoFilePicker` and, on success, calls `setCurrentVideoPath`.
  - **Load Project…** — opens `.openscreen` file picker; on success, restores the project.
- Below: list of supported video formats (MP4, MOV, WebM, MKV, AVI, M4V, WMV) and a small "or drag & drop a .openscreen project file here" hint.

**Drag and drop**: dragging a file over the empty state shows a dashed green overlay with an upload icon and the message "Drop project file to open". The drop handler:

- Accepts only `.openscreen` project files (any other file → "Unsupported Format" dialog).
- Resolves the path via `webUtils.getPathForFile` (Electron 32+).
- Calls `loadProjectFileFromPath` and applies the project on success.
- Any other failure (missing path, IPC error, invalid project) → "Could Not Open File" dialog.

Both dialogs are a small rounded modal with an icon, title, body, and a single Close button. The dialog stays on the last error type even during the close animation so the title doesn't flicker.

### 5.5 Studio workspace (video loaded)

The workspace is a `react-resizable-panels` group. The user drags the handle to rebalance preview vs timeline.

#### 5.5.1 Preview zone (left)

A flexible column with two stacked sub-sections:

1. **Preview canvas** — a Pixi.js canvas wrapped by `<VideoPlayback>`. The canvas aspect ratio follows the chosen `aspectRatio` (`16:9`, `9:16`, `1:1`, `4:3`, `4:5`, `16:10`, `10:16`, or `native`). When `isFullscreen` is true, the preview switches to a `fixed inset-0 z-[99999]` overlay; `Esc` exits fullscreen.

   The preview composite layers (back to front):

   - **Background** (`wallpaper`): image / solid colour / CSS gradient chosen in the settings panel.
   - **Screen video** with crop, border radius, padding, shadow, motion blur, blur (background blur).
   - **Webcam composite** — `picture-in-picture` (draggable bubble), `vertical-stack`, `dual-frame`, or `no-webcam`. PiP can be circular, square, rectangle, or pill-shaped, mirrored, sized 10–50% via slider, and optionally "shrinks on zoom" (reactive scaling).
   - **Animated zoom regions** with spring easing, focus-point tweens, and optional 3D rotation (iso / left / right).
   - **Trim cuts** — played back skipping the trimmed segments.
   - **Speed regions** — clips play at the per-region speed (0.25×–16×).
   - **Cursor** — drawn with theme art, smoothing, motion blur, click bounce; clips to canvas bounds when the toggle is on.
   - **Annotations** — text/image/arrow overlays; mosaics as blur shapes.

   Selecting a region in the timeline selects it on the preview and reveals its resize handles. The selected zoom region can be moved and re-anchored by dragging its focus marker in the preview.

2. **Playback controls** — a centred, full-width `max-w-[760px]` floating pill below the preview:
   - Play/Pause button (round, white when paused, glassy when playing).
   - Current time / total duration labels (`m:ss`).
   - Custom range slider (a transparent `<input type=range>` sits over a green progress bar inside a grey track; round white thumb appears on hover).
   - Fullscreen toggle on the right (changes icon Maximize ↔ Minimize).

#### 5.5.2 Settings rail (right)

Two-column shell: a narrow icon rail on the left, an accordion panel on the right. The rail icon toggles which panel is shown. Icons (top → bottom):

- **Background** (palette) — always visible.
- **Effects** (sliders) — always visible.
- **Layout** (panel-top icon) — only enabled when a webcam video is loaded.
- **Timeline** (brackets icon) — always visible; switches the right column to a small panel for the trim waveform toggle.
- **Cursor** (mouse-pointer-click icon) — appears only when the recording has editable cursor data (editable-overlay + native cursor assets).
- **Crop** (crop icon, outside the panel group) — opens the Crop modal.
- **Export** (download icon, anchored to bottom) — opens the export panel.

When a timeline region is selected, the rail is replaced entirely with the region-specific inspector:

- **Selected zoom**: zoom-level editor.
- **Selected trim**: a single Delete button.
- **Selected speed**: speed editor.
- **Selected annotation**: full annotation editor.
- **Selected blur**: blur editor.

The panel scrolls (`overflow-y-auto custom-scrollbar`). At the bottom sits a footer with three support buttons: **Report Bug**, **Save Diagnostics**, **Star on GitHub** (the bug link opens the GitHub issues page in the OS browser).

##### Panel: Background

Three tabs (Image / Colour / Gradient).

- **Image**: a hidden file input + **Upload Custom** button. Only JPG/JPEG/PNG are accepted (`isSupportedBackgroundImageType`). On success, the image becomes a custom thumbnail in the grid (hover shows a red ✕ to remove). Default wallpapers come from `WALLPAPER_PATHS` and render as 32×32 thumbnails; the active one has a green border + ring.
- **Colour**: opens the `<ColorPicker>` component (Block / Palette / Hue wheel). Updates the `wallpaper` state in real time. A 16-swatch palette is also rendered.
- **Gradient**: a 6-column grid of 24 preset CSS gradients. Click applies.

##### Panel: Effects (Video Effects)

Two columns of rounded "control surfaces":

- **Blur BG** — toggle switch (0/1). Toggles Pixi `BlurFilter`.
- **Motion Blur** — slider 0–1, step 0.01. Live numeric display.
- **Shadow** — slider 0–1, step 0.01. `Math.round(value*100)%` numeric.
- **Roundness** — slider 0–64 px, step 0.5. Numeric in px.
- **Padding** — slider 0–100 %, step 1. Applies to every webcam layout; in `dual-frame` / `vertical-stack` it insets the welded screen+camera block as one piece.

All sliders commit their value when the user releases the thumb (`onValueCommit`). Some update live (`onValueChange`) — e.g. padding uses `updateState` for the live preview and `commitState` on commit.

##### Panel: Layout (Webcam)

Only visible if a webcam video is present.

- **Preset** dropdown — `picture-in-picture` / `vertical-stack` / `dual-frame` / `no-webcam`. Some entries are filtered based on canvas aspect (e.g. vertical-stack only in portrait, dual-frame only in landscape). Switching presets also clears the saved PiP position unless the new preset is PiP.
- **Mirror Webcam** toggle — visible when preset ≠ no-webcam.
- **Shrink on Zoom (Reactive Webcam)** toggle + info-tooltip — only when preset = PiP. `dual-frame` / `vertical-stack` force it off and hide the control: their camera box is sized off the screen capture, so shrinking it mid-zoom would tear a hole in the block (`supportsWebcamReactiveZoom`).
- **Camera Shape** — four small icon-buttons (rectangle / circle / square / rounded), each rendered as an SVG glyph.
- **Webcam Size** slider — 10–50 %.

`dual-frame` ("Side by side") and `vertical-stack` ("Top / bottom") weld the screen and the camera into a single block, governed by three constraints (`computeCompositeLayout`, `block` branch):

1. **Screen keeps its ratio** — the screen box is always the capture's own aspect ratio, untouched.
2. **The block is contained in the scene** — screen + gap + camera contain-fit the (padded) scene whatever its ratio, so at padding 0 the block sits flush against the two edges its own ratio makes it reach.
3. **The camera tends toward square** — the camera shares the screen's cross-edge (same height beside it, same width under it, so they read as one solid block); its one free dimension is chosen to make the *block* match the scene's aspect ratio (perfect fill, no bars), then held within **[0.8, 1.25]** of square (`BLOCK_CAMERA_ASPECT_TOLERANCE`). So the camera fills when it can and only goes *slightly* rectangular — never a thin slice — when the scene ratio pulls it there.

There is no fixed split anymore: it falls out of those three constraints and adapts to both the capture ratio and the scene ratio. When the geometry allows a near-square camera that also fills the scene, both happen at once (e.g. a 4:3 capture top/bottom in a 9:16 scene → square camera, 100 % fill). Camera Shape and Webcam Size do not apply to either preset. The single tunable is the square tolerance.

Both halves are framed identically: the camera is always a **rectangle** with the *same* corner radius as the screen, whatever shape the user last picked under PiP. The mask picker is hidden here, but the setting survives — so the layout resolves the shape (`webcamRect.maskShape`) and the radius (`webcamRadiusFrac`) itself and every renderer, native compositor included, consumes those rather than the raw setting. Shipping the raw one is what used to let a circle chosen in PiP follow the user into Side by side and round the camera off into a disc, with the rounding changing depending on which shape happened to be stored.

**Every length crossing the native scene contract is a fraction, never a pixel count.** The compositor rasterises the preview into a small contain-fitted frame and the export at full output size, so "a pixel" means two different things on the two sides of that boundary — an absolute value crossing it silently becomes *render-target* pixels. Each quantity names its own reference: a corner radius is a fraction of **its own box's short side** (`screenRadiusFrac`, `webcamRadiusFrac`), so the rounding stays put when the box is resized; the Roundness slider, the drop shadows and the cursor are fractions of the **frame's short side**. The sliders stay in pixels for the user — the division happens once, in `buildSceneDescription`. This is not hygiene: absolute pixels crossing the contract are what drew the PiP circle as a shrunken blob in the preview while the export was correct, and what gave a 4K export a proportionally weaker shadow and a smaller cursor than a 1080p one.

The webcam bubble can also be dragged around the canvas (mouse-drag) — the position persists as `webcamPosition`.

##### Panel: Cursor

Only rendered when the recording includes editable cursor assets. Toggles:

- **Show Cursor** — master switch.
- **Clip to Canvas** switch + tooltip.
- **Cursor Style** — a strip of icon buttons, one per bundled theme (Default, Hello Kitty & Watermelon, Among Us Sus Knife & Red Animated, etc.). The first is always the default arrow.
- Four sliders: **Size** (0.5–10), **Smoothing** (0–1), **Motion Blur** (0–1), **Click Bounce** (0–5).

##### Panel: Timeline

A single switch — "Show Audio Waveform on Trim Track". Toggling enables/disables the audio peaks waveform background on the trim row (computed in a worker via `useAudioPeaks`).

##### Panel: Crop (modal)

Launched by the Crop icon. It's a centered modal with `max-w-5xl`, backdrop blur, dark background. Shows the current frame painted to a canvas with a draggable crop rectangle. Controls below the canvas:

- Numeric X/Y/W/H inputs (in pixels).
- **Ratio** dropdown: Free / 16:9 / 9:16 / 4:3 / 3:4 / 1:1 / 21:9. Selecting a preset re-runs the crop with the chosen aspect ratio and toggles the lock state.
- Lock/Unlock aspect toggle button (`Lock` / `Unlock` icons).
- "Done" button.

##### Panel: Export

Visible only in Export mode (the bottom-anchored icon in the rail). Layout:

- **Format toggle** — `MP4` / `GIF` segmented buttons.
- **Quality** (MP4 only) — three segmented buttons: 720p / 1080p / Source. Each button can show an "Upscale" sub-label when the source resolution is below the target. The Source button shows the source short side (e.g. `1080p`) as a sub-label.
- **GIF settings** (GIF only) — two segmented selectors side by side: Frame Rate (15/20/25/30 FPS) and Size (Med/Large/Orig). Below: live dimension readout, plus a **Loop GIF** toggle.
- **Save unsaved export** button — visible only when a previous export failed to write to disk; lets the user pick a location for the cached buffer.
- **Export Video** / **Export GIF** primary button (large, green, full width).

#### 5.5.3 Region-specific inspectors (replacing the right panel when something is selected)

##### Inspector: Selected zoom

- Header chip with the current effective scale (`1.25× / 1.5× / 1.8× / 2.2× / 3.5× / 5×`, or a custom decimal).
- Six depth buttons (same scales as above). Clicking sets depth and snaps the custom slider.
- Custom scale slider (1.0×–5.0×, step 0.01). Releasing commits.
- Focus mode (visible only when cursor telemetry exists) — Manual / Auto segmented toggle. Auto makes the camera follow the cursor. Disabled when the global "Auto-Focus all" toggle is on (locked).
- "Hold to preview zoom effect" button — press-and-hold to render the zoom in the preview at the current time; release reverts.
- Focus Position (visible when focus mode ≠ auto) — two numeric inputs X (%) and Y (%). 0 = leftmost/topmost, 100 = rightmost/bottommost.
- 3D Rotation — three buttons: Iso / Left / Right. Click toggles; click again to clear.
- **Delete Zoom** (red destructive button, full width).

##### Inspector: Selected trim

A single red destructive button "Delete Trim Region".

##### Inspector: Selected speed

- Header chip with the current speed (e.g. `1.5×`).
- Five-column grid of speed presets: 0.25×, 0.5×, 0.75×, 1.25×, 1.5×, 1.75×, 2×, 3×, 4×, 5×.
- Custom speed input — decimal text field; Enter or blur commits. Out-of-range (>16×) shows a toast "Speed can't go higher than 16×".
- **Delete Speed Region** button.

##### Inspector: Selected Full Camera

- Explanatory paragraph + **Delete region** button. The timing is edited by dragging the region's edges on the timeline; there is nothing else to tune.
- Full Camera is **not** a zoom of the webcam bubble: it hands the camera the whole frame. At full strength the camera rect is exactly the output frame — no margin, no padding, no corner radius, no mask shape, no drop shadow, and nothing of the composition (wallpaper, screen capture, cursor) left showing behind it (`computeCameraFullscreenRect`).
- Getting there is one lerp from the layout rect to `[0, 0, W, H]`, eased in at the region's start and out (over a longer window) at its end. The box changes aspect ratio along the way; every renderer cover-crops the camera into whatever box it is handed, so the image is never stretched by the animation.
- The mask dissolves through its own radius rather than popping: a circle mask already *is* a rounded rect at radius = half its (square) box, so flattening the shape to a rectangle on frame one and easing the radius to 0 carries every shape out continuously, with no per-shape branch. The PiP drop shadow fades out on the same curve.
- Reactive "shrink on zoom" is ignored for any frame where Full Camera is active — "shrink for the zoom" and "grow to full" in the same frame means nothing.

##### Inspector: Selected annotation (`<AnnotationSettingsPanel>`)

Top-level tabs: **Text** / **Image** / **Arrow**.

- **Text** tab: a textarea (5 rows) for the text content, then a 2-column block for:
  - Font Family (selectable from 24 built-in families grouped by category: Classic, Editor, Strong, Typewriter, Deco, Simple, Modern, Clean, plus named families like Inter, Plus Jakarta Sans, Space Grotesk, DM Sans, Sora, Manrope, IBM Plex Sans/Serif/Mono, Playfair Display, Merriweather, Lora, Bebas Neue, Oswald, Caveat, Permanent Marker, Fira Code, plus any user-added custom fonts).
  - Font Size (selectable from `[12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 80, 96, 128]`).
  - "Add Custom Font" button → opens `<AddCustomFontDialog>`: paste a Google Fonts `@import` URL and a display name; on success the font appears in the picker and is auto-applied.
  - Text Animation (selectable from: None, Fade, Rise, Pop, Slide Left, Typewriter, Pulse).
  - Formatting toggle group (Bold / Italic / Underline) — single button per state.
  - Alignment toggle group (Left / Centre / Right).
  - Text Color (Block + palette popover).
  - Background Color (Block + palette + clear-to-transparent).
- **Image** tab: a hidden file input + a tall **Upload Image** button. On success, the image is shown as a preview. Supported: JPG, PNG, GIF, WebP. The text content is replaced with the data URL.
- **Arrow** tab (figure annotations): an 8-button grid of arrow directions (Up, Down, Left, Right, Up-Right, Up-Left, Down-Right, Down-Left). Below: Stroke Width slider 1–6, and an arrow Colour block-picker.

Footer of the annotation inspector: **Duplicate** (copies the region with a slight offset) and **Delete Annotation** (red destructive).

##### Inspector: Selected blur (`<BlurSettingsPanel>`)

Only enabled when the `BLUR_REGIONS_ENABLED` flag is on.

- Shape selector (Rectangle / Oval) — two big icon-buttons.
- Colour selector (White / Black).
- **Mosaic Block Size** slider 4–48 px (display: "X px").
- **Delete Annotation** button.

#### 5.5.4 Timeline

A full-width, full-height panel with a fixed toolbar at the top and a `dnd-timeline`-powered canvas underneath.

##### Toolbar

A single rounded "pill" group containing:

- **+ Zoom** (`ZoomIn` icon, green hint) — adds a zoom region at the playhead.
- **Wand (Auto Zoom)** (`WandSparkles` icon) — toggle. When ON, fresh recordings auto-get suggested zoom regions based on cursor dwell moments. Click again to remove auto-generated zooms.
- **ScanEye (Auto-Focus All)** — toggle. When ON, every zoom follows the cursor; per-zoom focus-mode selectors lock.
- **Scissors (Trim)** — adds a trim region at the playhead. Tooltip "Press T to add trim".
- **Speech bubble (Annotation)** — adds a text annotation at the playhead. Tooltip "Press A to add annotation".
- **Blur icon** (when blur is enabled) — adds a blur region at the playhead. Tooltip "Press B to add blur region".
- **Gauge (Speed)** — adds a speed region at the playhead. Tooltip "Press S to add speed".
- **Captions (waveform-with-text icon)** — opens the Auto Captions dialog. Disabled while a transcription is in flight or when no video URL is available.

Right of the toolbar:

- **Aspect Ratio dropdown** (`ChevronDown` icon + current label) — opens a dropdown menu listing `16:9 / 9:16 / 1:1 / 4:3 / 4:5 / 16:10 / 10:16 / Original (native)`. The check shows the active one. Selecting a portrait/landscape-incompatible webcam preset swaps it back to PiP.
- **Scroll / Ctrl+Scroll hints** — small kbd-style hints for panning/zooming the timeline.

##### Timeline body

A scrollable region containing:

- **Time axis** at the top: major markers (with `m:ss` or `h:mm:ss` labels, fractional digits adapt to zoom) plus minor ticks (5 per major). The current time marker is highlighted in green.
- **Playback cursor**: a vertical purple line (`#6C55FF`) with a diamond handle at the top. Drag it to scrub; it auto-pans the timeline when dragged past either edge and snaps to keyframes within 150 ms. A floating tooltip shows the live time while dragging.
- **Five lanes (top to bottom)**:
  - **Zoom** (`Press Z to add zoom` hint when empty) — glassy green blocks. Hover/select reveals the scale (`1.8×`) and a "cursor-follow" indicator when `focusMode === auto`.
  - **Trim** (`Press T to add trim`) — glassy red blocks. When "Show Audio Waveform on Trim Track" is on, the row's background is a canvas-drawn waveform (computed by an audio-peaks worker).
  - **Annotation** (`Press A to add annotation`) — glassy yellow blocks, labelled with the text preview (truncated to 20 chars + ellipsis), "Image" for image type, or "Annotation" fallback.
  - **Blur** (`Press B to add blur region`, only if BLUR_REGIONS_ENABLED) — same yellow glass with the prefix "Blur".
  - **Speed** (`Press S to add speed`) — glassy amber blocks, labelled `1.5×` etc.

Each block has invisible left/right resize caps (8 px wide, cursor `col-resize`) and a floating tooltip that shows `startMs – endMs` during drag/resize. A 2px amber snap guide appears when an edge is within the snap threshold of another region, playhead, or keyframe.

On drag/resize:

- The drag/resize preview is computed without committing until pointer-up.
- Snap targets are other zoom/trim/speed edges (hard push), annotation/blur edges (soft pull only), playhead, keyframes, 0, total duration.
- Overlap with same-kind regions is clamped to neighbours and rejected if still overlapping.
- Snap threshold scales with zoom (~1% of visible range, minimum 50 ms).

**Keyframes** can be added via the configured shortcut. They render as small yellow diamonds at the top of the timeline (rotated 45°). Click selects, drag moves (clamped to `[0, totalMs]`), `Delete`/`Backspace` removes.

**Zoom controls**:

- **Mouse wheel** — pans horizontally. Auto-pan stops when the timeline is already fully visible.
- **Ctrl/Cmd + Scroll** — zooms in/out (resize the visible range while keeping the cursor anchored).

**Click on empty timeline area** — clears any region selection and seeks to the click X.

**Tab** (when the playhead overlaps multiple annotations) — cycles through overlapping annotations, ordered by `zIndex`. **Shift+Tab** cycles backwards.

### 5.6 Auto Captions dialog

Triggered from the timeline's Captions button. Modal dialog (`max-w-md`):

- Title "Auto captions".
- Description: "Choose roughly how many words each caption shows at once. Timing is spread across the words in that phrase."
- Two labelled selects:
  - **Minimum words per caption** — 1–12.
  - **Maximum words per caption** — 1–12 (kept ≥ min).
- **Cancel** / **Generate** buttons.

While generating, a single Sonner toast keeps updating with phases: "Generating captions from audio…" → "Loading speech model (first use downloads ~75 MB)…" → "Transcribing speech…". On success: "Added N captions." If truncation occurred: "Only the first 240 minutes were transcribed." If nothing was heard: "No speech was detected." If the video has no audio: "This video has no usable audio to transcribe."

Captions are inserted as text annotations with `annotationSource: "auto-caption"`. Edits to one auto-caption's style/position are mirrored onto all its siblings.

### 5.7 Export flow

1. User picks **MP4** or **GIF** in the export panel and hits **Export Video** / **Export GIF**.
2. The editor calls `pickExportSavePath(fileName, getExportFolder())` to open a native save dialog. If the user cancels, the flow stops.
3. The export modal opens (`<ExportDialog>`):
   - Centred rounded modal with the project icon, title (`Exporting Video`/`Exporting GIF`), subtitle "This may take a moment…".
   - A progress block:
     - Header row: "Rendering Frames" (or "Compiling" once frames are done) on the left, percentage on the right.
     - A horizontal progress bar — green with a glow; during the indeterminate compile phase it slides left-to-right.
     - Two info cards: "Format" / "Status" and "currentFrame / totalFrames".
     - **Cancel Export** red destructive button.
   - On success, the modal transitions to "Export Complete", showing the file basename and a **Show in Folder** button. A 2-second timer auto-closes the dialog.
   - On error, the title becomes "Export Failed", a red error block appears with the diagnostic message (Reason / Source / Output dims / fps / Codec / Bitrate / `VideoEncoder` availability), and the **Show in Folder** button is gone.
4. A separate Sonner toast also fires: "Video exported successfully" / "GIF exported successfully", with the file path as description and a **Show in Folder** action. The last-used folder is persisted to `userPreferences.exportFolder`.
5. If the write-to-disk step fails but the encode succeeded, the encoded buffer is cached (`unsavedExport`) and a big purple **Choose Save Location** button appears in the export panel until the user saves or starts another export.

### 5.8 Save / Save As / Load / New

- **Save Project** writes the project (`.openscreen` JSON) via the native save dialog. If the project already has a path, it saves in place. On success, the unsaved-changes flag clears and a toast appears: "Project saved to <path>". On cancel: "Project save canceled". On error: "Failed to save project".
- **Save Project As** always prompts for a new path.
- **Load Project** opens a native file picker, then re-applies the project in the editor.
- **New Project** clears the current video path, resets all undoable and non-undoable editor state, and returns to `<EditorEmptyState>`.
- Any of New / Load initiated with unsaved changes opens `<UnsavedChangesDialog>` with three buttons: **Save & New/Load Project**, **Discard & New/Load Project**, **Cancel**.

### 5.9 Closing the window

Closing the editor window while unsaved-changes is true triggers `<UnsavedChangesDialog>` (`close` variant) with **Save & Close** / **Discard & Close** / **Cancel**. Choices route back to the main process via `sendCloseConfirmResponse("save" | "discard" | "cancel")`.

### 5.10 Keyboard shortcuts (global)

Configurable from the `?` icon next to each panel header (opens `<ShortcutsConfigDialog>`):

| Action | Default | Configurable? |
|---|---|---|
| Open App (global) | `Ctrl/Cmd + Shift + O` | ✅ |
| Add Zoom | `Z` | ✅ |
| Add Trim | `T` | ✅ |
| Add Speed | `S` | ✅ |
| Add Annotation | `A` | ✅ |
| Add Blur (when enabled) | `B` | ✅ |
| Add Keyframe | `K` | ✅ |
| Delete Selected | `Del`/`⌫` | ✅ |
| Play / Pause | `Space` | ✅ |
| Copy Selected Region attributes | configurable | ✅ |
| Paste Region attributes | configurable | ✅ |
| Undo | `Ctrl/Cmd + Z` | fixed |
| Redo | `Ctrl/Cmd + Shift + Z` / `Ctrl/Cmd + Y` | fixed |
| Cycle Annotations Forward | `Tab` | fixed |
| Cycle Annotations Backward | `Shift + Tab` | fixed |
| Delete Selected (alt) | `Del` / `⌫` | fixed |
| Frame Back / Forward | `←` / `→` (60 FPS step, ~16.67 ms) | fixed |
| Pan Timeline | `Shift + Ctrl + Scroll` | fixed |
| Zoom Timeline | `Ctrl + Scroll` | fixed |

The Customise Shortcuts dialog lets the user click a row, press a new binding; conflicts show a swap / cancel action. Reserved (fixed) shortcuts show an error toast: "This shortcut is reserved for 'X' and cannot be reassigned." A "Reset to defaults" button restores everything.

A `?` HelpCircle icon in every settings panel header reveals the shortcut cheat sheet (groups: Configurable, Fixed) on hover, with a link to the customize dialog.

---

## 6. Toasts (Sonner)

Mounted once at the app root. Two main styles:

- **Success/info**: dark green icon, brief text.
- **Error**: red icon, title + optional description.

Frequently used messages:

- Recording error notifications (see §2.5).
- Auto-caption lifecycle (see §5.6).
- Project save/load outcomes.
- Export outcomes.
- Copy/Paste of region attributes ("Zoom attributes copied" / "Zoom attributes pasted").
- "No speech was detected." / "Could not generate captions."
- Speed range error "Speed can't go higher than 16×".
- Region placement errors when the cursor sits inside another region (toast with description).

Each toast supports an `action` button (e.g. "Show in Folder" on export success).

---

## 7. Settings / Preferences persisted

Stored in `localStorage["openscreen_user_preferences"]`:

- `padding` (number 0–100)
- `aspectRatio` (one of the 8 valid aspect ratios)
- `exportQuality` (`medium` / `good` / `source`)
- `exportFormat` (`mp4` / `gif`)
- `exportFolder` (string path)
- `projectFolder` (string path)
- `trayLayout` (`horizontal` / `vertical`)

The renderer also calls into the main process for:

- `saveShortcuts` / `updateGlobalShortcut` (Open App key).
- `revealInFolder(path)` — used after export and on the unsaved-export button.
- `pickExportSavePath`, `writeExportToPath` (file system writes).
- `loadProjectFile` / `loadProjectFileFromPath` / `saveProjectFile` / `loadCurrentProjectFile` / `setCurrentVideoPath` / `clearCurrentVideoPath` — project persistence.
- `getSources` / `selectSource` / `getSelectedSource` / `onSelectedSourceChanged` / `onSourceSelectorClosed` — source picker.
- `showCountdownOverlay` / `hideCountdownOverlay` / `onCountdownOverlayValue` — countdown window.
- `startNativeWindowsRecording` / `pauseNativeWindowsRecording` / `resumeNativeWindowsRecording` / `stopNativeWindowsRecording` / `startNativeMacRecording` / `pauseNativeMacRecording` / `resumeNativeMacRecording` / `stopNativeMacRecording` / `isNativeWindowsCaptureAvailable` / `isNativeMacCaptureAvailable` / `requestNativeMacCursorAccess` / `attachNativeMacWebcamRecording` — native recorder pipeline.
- `getCurrentRecordingSession` / `setCurrentRecordingSession` / `setHasUnsavedChanges` / `onRequestSaveBeforeClose` / `onRequestCloseConfirm` — session handoff between recorder and editor.
- `setHudOverlaySize` / `moveHudOverlayBy` / `setHudOverlayIgnoreMouseEvents` — HUD geometry.
- `requestScreenAccess`, `requestCameraAccess`, `openExternalUrl`, `openVideoFilePicker`, `readBinaryFile`, `saveDiagnostic` — utilities.

---

## 8. i18n

- 13 locale JSON files under `src/i18n/locales/<locale>/` (en, ar, es, fr, it, ja-JP, ko-KR, pt-BR, ru, tr, vi, zh-CN, zh-TW) plus a top-level `common.json` shared across them.
- Each translation namespace: `common`, `launch`, `editor`, `settings`, `timeline`, `dialogs`, `shortcuts`.
- `<I18nProvider>` runs on app boot, detects a system-language suggestion (e.g. `zh-CN` on a Chinese machine) and prompts the user to switch via the system-language prompt. After resolution, the prompt never reappears for the same locale pair.
- All UI strings go through `useScopedT("namespace")`; the locale is read by both the renderer and the Electron main process (`electron/i18n.ts`), so menu items stay in sync.

---

## 9. Status summary

If you want a one-paragraph mental model: OpenScreen's front-end is two cooperating surfaces — a **HUD overlay** that captures content (sources, audio, mic, webcam, cursor mode, record/stop/pause/restart/cancel, language, tray layout, minimised window) and a **Studio editor** built around a resizable preview + inspector + timeline that lets the user cut, zoom, speed-change, annotate, blur, theme the cursor, set background/wallpaper/padding/shadow/border-radius/motion-blur, aspect-ratio, crop, layout the webcam (PiP/double/side-by-side/no-webcam), draw auto-captions from audio, save/load `.openscreen` projects, and export to MP4 (720p/1080p/Source) or GIF (15–30 fps, three sizes, optional loop) — all keyboard-driven, fully undoable, with a per-region Copy/Paste clipboard, customisable shortcuts, and 13 locales.