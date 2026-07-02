# 04 — Timeline pan / zoom / scrub

**Surface:** `TimelinePane` (`src/components/ai-edition/TimelinePane.tsx`) + the ruler + the navigator strip + the `pxPerSec` viewport state.
**Prerequisites:** `02-editor-foundation.md` (timeline pane exists), `03-transport-and-preview.md` (preview is wired so seeks are observable).

**Goal of this block:** prove the timeline viewport is navigable at any zoom level. After this block, every region operation in 06–09 has a known viewport state.

**Reference:**
- design `openscreen-editor.html` — `.timeline-body`, `.ruler`, `.tracks-scroll`, `.zoombar`.
- inventory `openscreen-inventory.md §4` — timeline architecture.
- roadmap `P0 timeline viewport` granular table (T01–T25), commits `690c80e`, `8be3dda`, `8c36398`, `2cd6ad3`.
- constants: `MAX_PX_PER_SEC = 280`, `CLIP_REORDER_THRESHOLD_PX = 6`, zoom step `1.18×`.
- `TimelinePane.tsx:1012` (`data-testid="timeline-pane"`), `:1033` (`data-testid="timeline-viewport"`), `:1566` (`aria-label="Timeline zoom and pan navigator"`).

---

## Scenario 04.1 — Timeline viewport reads `data-px-per-sec` and `data-zoom-multiplier`

**Setup**
1. From the end of block 03.

**Steps**
1. Read the timeline pane's `data-zoom-multiplier` (default `1`).
2. Read the timeline viewport's `data-px-per-sec` (the actual pixel-per-second ratio).
3. The clip blocks in the timeline render at widths = `durationSec * pxPerSec`.

**Expected**
- `data-zoom-multiplier` is a number ≥ `1.0`.
- `data-px-per-sec` is a positive number.
- The clip blocks' bounding boxes match `durationSec * pxPerSec` within ±2 px.

---

## Scenario 04.2 — Ctrl+wheel up zooms in

**Setup**
1. Hover the timeline viewport (`data-testid="timeline-viewport"`).
2. Read the initial `data-px-per-sec` as `initial`.

**Steps**
1. Hold `Ctrl` (or `Cmd` on macOS).
2. Wheel up 3 notches (deltaY = -120 each).
3. Release `Ctrl`.
4. Read `data-px-per-sec` as `zoomed`.

**Expected**
- `zoomed > initial` (the timeline is showing more pixels per second).
- `data-zoom-multiplier` increased.
- The clip blocks are visibly wider.
- The ruler ticks are finer.
- The zoom happens around the cursor X position (verify the click-X stays under the cursor after zoom).

---

## Scenario 04.3 — Ctrl+wheel down zooms out

**Setup**
1. From scenario 04.2 state (zoomed in).

**Steps**
1. Hold `Ctrl`. Wheel down 3 notches.
2. Read `data-px-per-sec`.

**Expected**
- `data-px-per-sec` decreased.
- `data-zoom-multiplier` decreased.
- At minimum, the zoom stops at `data-zoom-multiplier="1.0"` (fit-to-width).

---

## Scenario 04.4 — Zoom is bounded by MAX_PX_PER_SEC (280)

**Setup**
1. From scenario 04.3 state. Reset zoom to fit (Ctrl+0 if there's a shortcut, or wheel down until fit).

**Steps**
1. Hold `Ctrl`. Wheel up 30 notches (extreme zoom-in).
2. Read `data-px-per-sec`.

**Expected**
- `data-px-per-sec ≤ 280` (the MAX_PX_PER_SEC constant).
- No console errors.

---

## Scenario 04.5 — Ruler hover-scrub shows a guide line

**Setup**
1. Reset zoom to fit (default).

**Steps**
1. Move the mouse over the ruler (top of the timeline).
2. A vertical hover-guide line appears at the cursor's X position.

**Expected**
- The hover-guide is a 1 px line spanning the ruler.
- The ruler ticks do not change.
- Move the mouse off the ruler → guide disappears.
- The guide's X corresponds to a source time based on the current `pxPerSec`.

---

## Scenario 04.6 — Ruler click-to-seek

**Setup**
1. From scenario 04.5 state.

**Steps**
1. Click at ~75% of the ruler's width.
2. Read `data-current-time-sec` on both the preview and the timeline.

**Expected**
- The playhead jumps to ~75% of the timeline duration.
- The preview's source time updates.
- The playhead's X position equals the click position (visually).

---

## Scenario 04.7 — Alt+drag pans the viewport

**Setup**
1. Zoom in to ~3× (Ctrl+wheel up several times).
2. The clip blocks are now wider than the viewport — the viewport must pan to see the rest.

**Steps**
1. Hold `Alt`. Pointer-down inside the timeline viewport (not on a clip block or region pill).
2. Drag right by 200 px.
3. Release `Alt` (drag releases automatically when mouse is released).
4. The viewport's `visibleStartSec` advanced.

**Expected**
- The timeline's content translates to the left (showing later time).
- The ruler ticks reflect the new window.
- The playhead may scroll out of view if past the window's right edge.
- The clip blocks remain at their absolute source positions.

---

## Scenario 04.8 — Middle-click drag pans the viewport

**Setup**
1. From scenario 04.7 state.

**Steps**
1. Press the middle mouse button. Drag right by 150 px.
2. Release.

**Expected**
- Same pan behaviour as Alt+drag.
- The middle button does NOT trigger any other action (no seek, no region select).

---

## Scenario 04.9 — Navigator strip shows the visible window

**Setup**
1. Zoomed in from previous scenarios.

**Steps**
1. Locate the navigator strip below the timeline viewport (`aria-label="Timeline zoom and pan navigator"`).
2. Take a screenshot. The strip shows:
   - The full timeline as a thin bar.
   - Skip marks (red dashes) at every skip range.
   - A draggable window overlay showing the currently visible range.

**Expected**
- The navigator strip is visible and shorter than the viewport (~80 px tall).
- The window overlay's left/right edges can be dragged.
- The window overlay's interior can be dragged to pan.

---

## Scenario 04.10 — Navigator drag-pan

**Setup**
1. From scenario 04.9 state.

**Steps**
1. Pointer-down on the navigator's window-overlay **body** (not the edges). Drag right by 80 px.
2. Release.

**Expected**
- The viewport's `visibleStartSec` and `visibleEndSec` both shift right by the equivalent source time.
- The clip blocks translate to the left visually.

---

## Scenario 04.11 — Navigator drag-resize (left edge)

**Setup**
1. From scenario 04.10 state.

**Steps**
1. Pointer-down on the navigator's window-overlay **left handle**. Drag right by 20 px.
2. Release.

**Expected**
- The viewport's `visibleStartSec` increases.
- The zoom factor (`pxPerSec`) increases correspondingly (the visible window is now narrower, so each second takes more pixels).

---

## Scenario 04.12 — Navigator drag-resize (right edge)

**Setup**
1. From scenario 04.11 state.

**Steps**
1. Pointer-down on the navigator's window-overlay **right handle**. Drag left by 40 px.
2. Release.

**Expected**
- The viewport's `visibleEndSec` decreases.
- The zoom factor increases.

---

## Scenario 04.13 — Timeline header shows clip count, skip count, total duration

**Setup**
1. From scenario 04.12 state.

**Steps**
1. Read the timeline header's text.

**Expected**
- The text format is `N clips · M skips · M:SS total`.
- The numbers match the project's `timeline.clips.length`, `timeline.skipRanges.length`, and the sum of clip durations.
- The current time and "Clip i/N" indicator are also visible.

---

## Scenario 04.14 — Scrub via click-and-drag on the timeline

**Setup**
1. From scenario 04.13 state.

**Steps**
1. Pointer-down on the empty area of the timeline (between clip blocks, or on the ruler).
2. Drag right by 100 px without releasing.
3. The preview scrubs to the corresponding source time on every move.
4. Release at ~50% of the timeline width.

**Expected**
- The preview's `data-current-time-sec` follows the cursor in real time during the drag.
- The playhead follows the cursor.
- On release, the playhead stays at the released position.

---

## Scenario 04.15 — Fit-to-width reset (zoom 1.0)

**Setup**
1. From a zoomed state.

**Steps**
1. Press the keyboard shortcut for fit-to-width (typically `Ctrl+0` or `0`).
2. Or wheel down until the multiplier reads `1`.

**Expected**
- `data-zoom-multiplier = 1`.
- The clip blocks fill the viewport width exactly (no horizontal scroll, the navigator window covers the full timeline).

---

## Scenario 04.16 — Body class for panning/scrubbing/placing-cut modes

**Setup**
1. Reset zoom to fit.

**Steps**
1. Alt+drag (start panning) → the `body` element has class `timeline-panning`. Cursor is `grabbing`.
2. Drag on the timeline (scrubbing) → class `timeline-scrubbing`. Cursor is `col-resize` or similar.
3. Press the `T` key (place-skip mode — see 06.x) → class `timeline-placing-cut`. Cursor is `crosshair`.

**Expected**
- The body classes are observable via `document.body.classList`.
- Cursor changes per mode.

---

## Scenario 04.17 — Hover-scrub on the ruler while in scrub mode

**Setup**
1. From a clean state.

**Steps**
1. Move the mouse over the ruler (without clicking).
2. The hover-guide shows at the cursor's X.
3. The data-current-time attribute on the ruler updates as the mouse moves.

**Expected**
- The hover guide is visible.
- The ruler updates to reflect the scrub position (this is the P3.7 commit `76d78db`).

---

## Scenario 04.18 — Skip marks in the navigator strip

**Setup**
1. Project has at least 1 skip range (see 06.x to add one).

**Steps**
1. Take a screenshot of the navigator strip.

**Expected**
- Skip ranges are marked as red dashes (or similar accent) on the navigator's full-timeline bar.
- The skip marks are at the correct source time positions.
- Adding / removing a skip updates the navigator mark live.

---

## Scenario 04.19 — Place-skip mode shows a preview marker on the ruler

**Setup**
1. Reset to a single-clip project, zoomed to fit.

**Steps**
1. Press the `T` key. The place-skip mode is armed.
2. The ruler shows a red vertical marker at the current playhead position.
3. The body class is `timeline-placing-cut`.
4. Move the cursor over the ruler. The marker follows the cursor.
5. Press `Esc`. The marker disappears. The mode is disarmed.

**Expected**
- The marker is visible while armed.
- The cursor becomes `crosshair`.
- `Esc` disarms without creating a skip.
- Clicking while armed creates a 1 s skip at the click position (covered in 06.x).

---

## Cross-cutting checks for this block

- The viewport's `data-px-per-sec` and `data-zoom-multiplier` are always in sync.
- Pan + zoom state persists across opening the right panel and closing it.
- The ruler never shrinks below 4 ticks per viewport (adaptive ruler).

**Next:** proceed to [`05-clip-operations.md`](05-clip-operations.md).