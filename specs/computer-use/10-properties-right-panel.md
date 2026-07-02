# 10 — Properties right panel: background, layout, camera, cursor, effects

**Surface:** `RightPanes`, `RightPanelStack`, `RightRail`, `CropModal`.
**Prerequisites:** `02-editor-foundation.md`.

**Goal of this block:** prove every pane in the right rail works — Background (image / gradient / color / custom), Layout (aspect / padding / radius / shadow / blur / motion-blur), Camera (shape / size / position / mirrored / reactive), Cursor (theme / size / smoothing / motion-blur / click-bounce / clip), Effects, plus the per-pane Help popover (roadmap P3.3).

**Reference:**
- design `openscreen-editor.html` — `.bg-grid`, `.gradient-grid`, `.color-grid`, `.upload-btn`, `.shape-grid`, `.slider-grid`, `.cursor-grid`, `.crop-stage`.
- `RightPanes.tsx:53` — `aria-label={helpLabel ?? "Help"}`.
- `RightPanes.tsx:63` — popover `role="note"`.
- `RightPanes.tsx:223` — `aria-label="Custom wallpaper"`.
- `RightPanes.tsx:236` — `aria-label={`Background ${i + 1}`}`.
- `RightPanes.tsx:259` — `aria-label={`Gradient ${i + 1}`}`.
- `RightPanes.tsx:315` — `aria-label={`Color ${c}`}`.
- roadmap P3.3 (`76d78db`) — Help button wired to contextual popover.

---

## Scenario 10.1 — Open the right panel (Background pane)

**Setup**
1. Project is open. The right rail is visible; the right panel is collapsed by default.

**Steps**
1. Click the **Background** button on the right rail (the leftmost button — folder / image icon).
2. The right panel opens, showing the Background pane.

**Expected**
- The right panel slides in (or appears instantly).
- The Background pane contains:
  - A grid of image backgrounds (4 columns).
  - A grid of gradient backgrounds (4 columns).
  - A grid of color backgrounds.
  - An `Upload` button to import a custom image.
- The active background (current selection) has a mint border (`.is-active` state).

---

## Scenario 10.2 — Pick an image background

**Setup**
1. From scenario 10.1 state.

**Steps**
1. Click any image background in the grid.

**Expected**
- The preview's background wallpaper updates immediately.
- The selected background has the mint border (`.is-active`).
- The project's `wallpaper` field is updated.

---

## Scenario 10.3 — Pick a gradient background

**Setup**
1. From scenario 10.2 state.

**Steps**
1. Click any gradient background.

**Expected**
- The preview's background swaps to a CSS gradient.
- The selection state updates.

---

## Scenario 10.4 — Pick a color background

**Setup**
1. From scenario 10.3 state.

**Steps**
1. Click any color background in the color grid.

**Expected**
- The preview's background is the chosen solid color.
- The selection updates.

---

## Scenario 10.5 — Upload custom wallpaper

**Setup**
1. From scenario 10.4 state.

**Steps**
1. Click the **Upload** button.
2. Pick an image file from the system file picker (e.g. `tests/fixtures/sample.png`).

**Expected**
- The uploaded image appears in the preview as the background.
- The wallpaper is saved to the project (path stored in `legacyEditor.wallpaper`).
- The wallpaper persists across app restarts.

---

## Scenario 10.6 — Open the Layout pane

**Setup**
1. From scenario 10.5 state.

**Steps**
1. Click the **Layout** button on the right rail.

**Expected**
- The right panel swaps to the Layout pane.
- It contains:
  - Aspect ratio selector (`16:9`, `9:16`, `1:1`, `4:3`, `4:5`, `16:10`, `10:16`, `Original`).
  - Padding slider.
  - Border radius slider.
  - Shadow intensity slider.
  - Blur toggle + amount.
  - Motion blur toggle + amount.

---

## Scenario 10.7 — Change aspect ratio

**Setup**
1. From scenario 10.6 state.

**Steps**
1. Click the aspect ratio dropdown.
2. Click `1:1`. The preview re-aspects.
3. Click `9:16`. The preview is portrait.
4. Click `Original`. The preview is the source's native aspect.

**Expected**
- The preview's frame reflows to the new aspect.
- The project's `aspectRatio` field updates.
- The export uses the same aspect.

---

## Scenario 10.8 — Padding slider

**Setup**
1. From scenario 10.7 state. Aspect = `16:9`.

**Steps**
1. Drag the **Padding** slider from 0 to 100.

**Expected**
- The preview shows the video frame shrinking as padding increases (the gap between the frame and the panel edges grows).
- The project's `padding` field updates.

---

## Scenario 10.9 — Border radius slider

**Setup**
1. From scenario 10.8 state.

**Steps**
1. Drag the **Border Radius** slider from 0 to 100.

**Expected**
- The preview's frame corners become increasingly rounded.
- The project's `borderRadius` updates.

---

## Scenario 10.10 — Shadow intensity slider

**Setup**
1. From scenario 10.9 state.

**Steps**
1. Drag the **Shadow Intensity** slider from 0 to 100.

**Expected**
- A drop shadow appears under the video frame, increasing in intensity.
- The project's `shadowIntensity` updates.

---

## Scenario 10.11 — Blur background toggle + amount

**Setup**
1. From scenario 10.10 state.

**Steps**
1. Toggle the **Blur Background** switch on.
2. Drag the **Blur Amount** slider.

**Expected**
- The background wallpaper (image / gradient / color) becomes blurred.
- The amount controls the blur radius (filter: blur(6px) by default).

---

## Scenario 10.12 — Motion blur toggle + amount

**Setup**
1. From scenario 10.11 state.

**Steps**
1. Toggle **Motion Blur** on.
2. Drag the amount slider.

**Expected**
- The preview shows motion-blurred frames during zoom / pan transitions.
- The amount controls the blur kernel size.

---

## Scenario 10.13 — Open the Camera pane

**Setup**
1. Click the **Camera** button on the right rail.

**Steps**
1. The Camera pane shows:
   - Shape selector (rectangle, circle, square, rounded) — `.shape-grid` with `.shape-cell` buttons.
   - Size slider (10–50% of canvas ref).
   - Position (drag the PIP on the preview, or X/Y inputs).
   - Mirror toggle.
   - Reactive zoom toggle.

**Expected**
- All four shape options are clickable.
- The active shape has the mint background.

---

## Scenario 10.14 — Change webcam shape

**Setup**
1. From scenario 10.13 state. Webcam file is loaded.

**Steps**
1. Click `circle`. The PIP is now a circle.
2. Click `square`. The PIP is a square.
3. Click `rounded`. The PIP is a rounded rectangle.
4. Click `rectangle`. The PIP is a rectangle.

**Expected**
- The PIP shape updates immediately.
- The project's `webcamMaskShape` updates.

---

## Scenario 10.15 — Adjust webcam size

**Setup**
1. From scenario 10.14 state.

**Steps**
1. Drag the size slider from 25 (default) to 50.

**Expected**
- The PIP grows to 50% of the canvas.
- The project's `webcamSizePreset` updates.

---

## Scenario 10.16 — Reposition webcam

**Setup**
1. From scenario 10.15 state.

**Steps**
1. Drag the webcam PIP on the preview from bottom-right to top-left.

**Expected**
- The PIP moves to the new position.
- The project's `webcamPosition` updates.

---

## Scenario 10.17 — Mirror webcam

**Setup**
1. From scenario 10.16 state.

**Steps**
1. Toggle the **Mirror** switch on.

**Expected**
- The webcam feed is horizontally flipped.
- The project's `webcamMirrored` updates.

---

## Scenario 10.18 — Reactive webcam zoom

**Setup**
1. From scenario 10.17 state.

**Steps**
1. Toggle the **Reactive Zoom** switch on.
2. Play the timeline.

**Expected**
- The webcam PIP scales up slightly during loud audio (or when the speaker is active).
- The reactive zoom is anchored to a docked corner.

---

## Scenario 10.19 — Open the Cursor pane

**Setup**
1. Click the **Cursor** button on the right rail.

**Steps**
1. The Cursor pane shows:
   - Cursor theme selector (`.cursor-grid` with `.cursor-cell` buttons — 5 themes).
   - Size slider.
   - Smoothing slider.
   - Motion blur slider.
   - Click bounce slider.
   - Clip to bounds toggle.

**Expected**
- The 5 cursor themes are visible.
- The active theme has the mint border.

---

## Scenario 10.20 — Change cursor theme

**Setup**
1. From scenario 10.19 state.

**Steps**
1. Click each of the 5 cursor themes in turn.

**Expected**
- The cursor in the preview updates to the selected theme.
- The project's `cursorTheme` updates.

---

## Scenario 10.21 — Cursor size / smoothing / motion blur

**Setup**
1. From scenario 10.20 state.

**Steps**
1. Drag the **Size** slider (default 3.0). Range: 1.0 – 6.0.
2. Drag the **Smoothing** slider (default 0.67).
3. Drag the **Motion Blur** slider (default 0.35).

**Expected**
- Each slider updates the corresponding cursor visual effect.
- The cursor's motion smoothness changes with smoothing.
- The motion blur trails follow the cursor.

---

## Scenario 10.22 — Click bounce

**Setup**
1. From scenario 10.21 state.

**Steps**
1. Drag the **Click Bounce** slider (default 2.5).
2. Play the timeline (recorded with mouse clicks).

**Expected**
- On each recorded click, the cursor animates a bounce.
- The intensity is proportional to the slider value.

---

## Scenario 10.23 — Clip cursor to bounds

**Setup**
1. From scenario 10.22 state.

**Steps**
1. Toggle **Clip to Bounds** on.
2. Play the timeline.

**Expected**
- The cursor disappears when it would render outside the recording area.
- It reappears when back in bounds.

---

## Scenario 10.24 — Crop video (right-rail button + modal)

**Setup**
1. Click the **Crop** button on the right rail (`aria-label="Crop video"`).
2. The `CropModal` opens.

**Steps**
1. The modal shows:
   - A 16:9 crop stage with a draggable crop rectangle.
   - 4 input fields: X, Y, Width, Height (or aspect / format selector).
   - A lock-aspect toggle.
   - A `Done` button.

**Expected**
- The modal is centered with a backdrop.
- The crop rectangle can be dragged to define a custom crop.
- The X/Y/W/H values update as the rectangle is dragged.

---

## Scenario 10.25 — Apply crop

**Setup**
1. From scenario 10.24 state.

**Steps**
1. Drag the crop rectangle from default to a tighter crop (top-left crop).
2. Click `Done`.

**Expected**
- The preview re-renders with the cropped frame.
- The project's `cropRegion` is updated.
- The export uses the cropped region.

---

## Scenario 10.26 — Effects pane

**Setup**
1. Click the **Effects** button on the right rail (if present).

**Steps**
1. The Effects pane shows toggles for:
   - Vignette
   - Film grain
   - Color grading presets
   - Or other visual effects.

**Expected**
- Each effect toggle updates the preview live.
- The effect state persists in the project.

---

## Scenario 10.27 — Help popover per pane (P3.3)

**Setup**
1. Right panel is open on any pane (e.g. Background).

**Steps**
1. Click the **Help** button (`aria-label="Help"` or `aria-label="Background help"` etc.) in the pane's header.
2. A popover appears with a `[role="note"]` element containing contextual help text.

**Expected**
- The popover shows help text specific to the active pane (NOT the generic `Settings for X` fallback).
- The popover can be dismissed by clicking outside, pressing `Esc`, or clicking the Help button again.

---

## Scenario 10.28 — Help popover on each pane

**Setup**
1. Repeat for each pane: Background, Layout, Camera, Cursor, Effects.

**Steps**
1. Open each pane, click Help, verify the help text is pane-specific.

**Expected**
- Each pane has a unique help string.
- No two panes share the same help text.

---

## Cross-cutting checks for this block

- The right rail buttons have `aria-label` for accessibility (and for the MCP).
- The right panel preserves the active pane across app restarts (in `localStorage`).
- All sliders / toggles / selectors update the project's `legacyEditor` envelope.

**Next:** proceed to [`11-transcript-editor.md`](11-transcript-editor.md).