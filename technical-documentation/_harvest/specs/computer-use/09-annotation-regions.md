# 09 — Annotation regions: text, image, figure, blur

**Surface:** `TimelinePane` (annotation lane), `Bottombar` (add-annotation button), `RightPanes` (annotation inspector), `annotationRenderer.ts`.
**Prerequisites:** `02-editor-foundation.md`, `04-timeline-pan-zoom-scrub.md`, `05-clip-operations.md`, `06-skip-regions.md`.

**Goal of this block:** prove all four annotation kinds work — text (with font family / animation), image (custom image), figure (rectangle / circle / arrow), and blur (rect / freehand with intensity). Each is rendered in the preview at the right time and position.

**Reference:**
- `types.ts:217-303` — `AnnotationType = "text"|"image"|"figure"|"blur"`, `ArrowDirection`, `FigureData`, `BlurShape`, `BlurType`, `BlurColor`, `BlurData`, `MIN_BLUR_INTENSITY/MAX_BLUR_INTENSITY`, `AnnotationRegion`.
- roadmap F2.2 (`58feb34`) — annotation font family + animation fields.
- roadmap F2.3 — figure/blur advanced fields (color, mosaic, radius, arrow direction).
- Design tokens `--annotation` (`#eab308` yellow / `#fbbf24` on dark) and `--annotation-soft`.

---

## Scenario 09.1 — Add text annotation

**Setup**
1. Project has 1 clip of ≥ 5 s. Playhead at some position.

**Steps**
1. Click the **Add Annotation** button in the bottombar.
2. An annotation region is added (default type is `text`).

**Expected**
- An annotation pill appears in the annotation lane in **yellow** (`--annotation` color).
- A text overlay is rendered on the preview at the region's range.
- Default text: `New annotation`.
- Default position: lower-third bar (per the design).
- `annotations.length` is now `1`.

---

## Scenario 09.2 — Edit text content

**Setup**
1. From scenario 09.1 state. Annotation selected.

**Steps**
1. The inspector shows a text input.
2. Click in the input. Clear it. Type `Hello world`.
3. Click outside to commit.

**Expected**
- The text overlay on the preview updates to `Hello world`.
- The pill label updates.

---

## Scenario 09.3 — Change font family

**Setup**
1. From scenario 09.2 state.

**Steps**
1. The inspector has a font-family selector: `Inter`, `Mono`, `Serif` (per roadmap F2.2).
2. Click `Mono`.

**Expected**
- The text overlay switches to the Mono font (Fira Code or similar).
- The font choice is saved to the annotation's `style.fontFamily`.

---

## Scenario 09.4 — Change animation

**Setup**
1. From scenario 09.3 state.

**Steps**
1. The inspector has an animation selector: `none`, `fade`, `pulse`.
2. Click `fade`.

**Expected**
- The text fades in at the start of the region and fades out at the end.
- The animation choice is saved to the annotation's `style.animation`.

---

## Scenario 09.5 — Move annotation position

**Setup**
1. Text annotation selected.

**Steps**
1. The inspector has X/Y fields (or the preview has a draggable handle on the text).
2. Drag the text to the upper-right corner of the preview.

**Expected**
- The text overlay moves to the new position.
- The region's `position` is updated.

---

## Scenario 09.6 — Resize annotation region (time)

**Setup**
1. Text annotation exists.

**Steps**
1. Drag the left handle right by 30 px.
2. Drag the right handle left by 50 px.

**Expected**
- The region's `startMs` / `endMs` change.
- The preview shows the text only during the new range.

---

## Scenario 09.7 — Add image annotation

**Setup**
1. From scenario 09.6 state. Reset or remove the text annotation.

**Steps**
1. In the inspector, change the annotation kind to `image` (or via a separate "Add image annotation" button).
2. Upload an image (PNG / JPG). Use a small sample image (e.g. `tests/fixtures/sample.png`).
3. Position and resize the image.

**Expected**
- The image is overlaid on the preview at the region's range.
- The region's `imageContent` field is populated with the uploaded image (data URL or path).

---

## Scenario 09.8 — Add figure annotation (rectangle)

**Setup**
1. From scenario 09.7 state.

**Steps**
1. In the inspector, change the kind to `figure`.
2. Select shape: `rectangle`.
3. Choose a fill color (color picker, default `#ff5f57` or similar).

**Expected**
- A rectangle is drawn on the preview at the region's range.
- The rectangle is filled with the chosen color.

---

## Scenario 09.9 — Add figure annotation (arrow)

**Setup**
1. From scenario 09.8 state.

**Steps**
1. Select shape: `arrow`.
2. Select direction: `up`, `down`, `left`, `right`, or any of the 8 directions (`ArrowDirection`).
3. Choose color.

**Expected**
- An arrow is drawn pointing in the chosen direction.
- The arrow's color matches the picker.

---

## Scenario 09.10 — Add blur annotation (rectangle)

**Setup**
1. From scenario 09.9 state.

**Steps**
1. Change kind to `blur`.
2. Select shape: `rectangle`.
3. Adjust intensity (slider, range `MIN_BLUR_INTENSITY` to `MAX_BLUR_INTENSITY`).

**Expected**
- A blurred rectangle is overlaid on the preview at the region's range.
- The blur intensity affects the pixelation level.

---

## Scenario 09.11 — Add blur annotation (freehand)

**Setup**
1. From scenario 09.10 state.

**Steps**
1. Select shape: `freehand`.
2. Draw a freehand path on the preview (pointer-down, drag, release).
3. The freehand path is captured (`DEFAULT_BLUR_FREEHAND_POINTS`).

**Expected**
- The freehand path is blurred on the preview.
- The path's control points are saved to the region's `figureData` (or `blurData`).

---

## Scenario 09.12 — Adjust blur radius / mosaic size

**Setup**
1. From scenario 09.10 state. Blur annotation selected.

**Steps**
1. The inspector has a **blur radius** slider.
2. Drag the slider to its maximum.
3. Drag to its minimum.

**Expected**
- The blur on the preview becomes more / less intense.
- The mosaic size slider (if present) controls the pixelation step.

---

## Scenario 09.13 — Change annotation color

**Setup**
1. A figure annotation is selected.

**Steps**
1. Click the color picker. Pick a new color (e.g. mint `#10b981`).
2. Confirm.

**Expected**
- The figure's fill color updates.
- The region's `figureData.color` is updated.

---

## Scenario 09.14 — Multiple annotation kinds coexist

**Setup**
1. Add one of each: text, image, figure, blur.

**Steps**
1. Play the timeline.

**Expected**
- Each annotation renders at its own range / position.
- They do not conflict (each has its own z-index; the latest-added is on top, or z-index is configurable).

---

## Scenario 09.15 — Annotation survives clip operations

**Setup**
1. Add an annotation. Then reorder / remove a clip.

**Steps**
1. Reorder the clip.
2. Remove a different clip.

**Expected**
- The annotation's `startMs` / `endMs` shift with the timeline duration (if a preceding clip is removed).
- The annotation does NOT disappear unless explicitly removed.

---

## Scenario 09.16 — Annotation undo/redo

**Setup**
1. Annotation exists.

**Steps**
1. Press `Ctrl+Z`. Removed.
2. Press `Ctrl+Shift+Z`. Returns.

**Expected**
- Undo / redo work.

---

## Scenario 09.17 — Annotation z-order

**Setup**
1. Two annotations exist with overlapping time ranges.

**Steps**
1. The later-added (or higher `zIndex`) annotation is rendered on top.

**Expected**
- The visual stacking matches the `zIndex` field.

---

## Scenario 09.18 — Auto-caption annotations

**Setup**
1. Project has a transcript (auto-generated via 11.x).
2. Auto-caption annotations have been generated.

**Steps**
1. Verify the annotations are present in the annotation lane.
2. Their kind is `text`, source is `auto-caption`.

**Expected**
- The auto-captions are styled as a lower-third bar (per `annotationsFromCaptions.ts:9-13`).
- They do not conflict with manual annotations.

---

## Cross-cutting checks for this block

- `annotations.length` reflects all visible pills.
- The pill color is consistently yellow (`--annotation`).
- Each annotation kind renders correctly in the preview.
- The inspector adapts to the selected annotation's kind.

**Next:** proceed to [`10-properties-right-panel.md`](10-properties-right-panel.md).