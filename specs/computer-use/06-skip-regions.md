# 06 — Skip regions

**Surface:** `TimelinePane` (skip lane), `Bottombar` (scissors button + `T` shortcut), `RegionTimeline`, `useTimeline` store, `useEditorHistory`.
**Prerequisites:** `02-editor-foundation.md`, `04-timeline-pan-zoom-scrub.md`, `05-clip-operations.md`.

**Goal of this block:** prove skip regions (the most-used edit operation) work end-to-end: add, resize, remove, place-via-mode, with snap guides and floating tooltips.

**Reference:**
- roadmap P0 row T15 (`8c80a5c`) — Place skip + marker.
- roadmap P0 row T24/T25 (`07d868c`) — snap-guide + drag tooltip.
- roadmap P2 row F2.6 / F2.7 (`01d6b46`) — snap-guide + tooltip + multi-select.
- `TimelinePane.tsx:1270, :1280, :1301` — `aria-label="Adjust skip start…"`, `"Remove skip…"`, `"Adjust skip end…"`.
- `Bottombar.tsx:9` — `Scissors` icon import.
- `TimelinePane.tsx:1489-1501` — Magic Wand toggle (different from place-skip).
- `TimelinePane.tsx:1515-1523` — Scissors button.

---

## Scenario 06.1 — Add skip via the Scissors button (bottombar)

**Setup**
1. Project has 1 clip of ≥ 5 s. No skips exist.

**Steps**
1. The playhead is at some position (e.g. `2 s`). The bottombar's Scissors button is visible.
2. Click the **Scissors** button.
3. Wait 200 ms. The playhead is now surrounded by a skip range.

**Expected**
- A skip region is added at the playhead position with a default length of `Math.max(1000, totalMs * 0.05)` (≥ 1 s, ~5% of total).
- `data-skip-count` is now `1`.
- The skip is rendered as a red segment in the timeline's clip block (with hatch pattern).
- The skip lane (above the timeline header) shows the skip as a red pill.

---

## Scenario 06.2 — Place skip mode (T key)

**Setup**
1. From scenario 06.1 state. Reset by deleting the skip (see 06.6).

**Steps**
1. Press `T` on the keyboard.
2. The body class is `timeline-placing-cut`. The cursor is `crosshair`.
3. A red vertical marker appears at the playhead position.
4. Move the mouse over the ruler. The marker follows the cursor.
5. Click on the ruler at a position different from the playhead (e.g. 50% of the clip).
6. A new skip is created at the click position.
7. Press `Esc` while in place-skip mode. The mode disarms; no skip is created.

**Expected**
- `T` arms the mode.
- The marker is visible at the playhead before any click.
- Click on the ruler creates a 1 s skip at the click position.
- `Esc` disarms.
- `data-skip-count` increments by 1 after the click.

---

## Scenario 06.3 — Resize skip: drag the left handle

**Setup**
1. Project has 1 skip range (from 06.1 or 06.2).

**Steps**
1. Hover the skip region in the timeline. The skip-hover-controls appear above the skip (`‹`, trash, `›`).
2. Click the **left** handle (`aria-label="Adjust skip start at …"`). Drag right by 60 px.
3. During the drag:
   - A vertical snap-guide line appears at the new edge.
   - A floating tooltip shows the new `startSec → endSec` in `M:SS.s` format.
4. Release.

**Expected**
- The skip's `startSec` increases.
- The tooltip disappears on release.
- The snap-guide disappears on release.
- The skip region updates in the project state.
- The preview's playback skips the new range correctly.

---

## Scenario 06.4 — Resize skip: drag the right handle

**Setup**
1. From scenario 06.3 state. A skip exists.

**Steps**
1. Click the **right** handle (`aria-label="Adjust skip end at …"`). Drag left by 80 px.
2. During the drag, the snap-guide and tooltip appear (mirrored at the right edge).
3. Release.

**Expected**
- The skip's `endSec` decreases.
- The tooltip shows the new range.
- The preview plays the new shorter skip.

---

## Scenario 06.5 — Edge clamp preserves a minimum width

**Setup**
1. From scenario 06.4 state.

**Steps**
1. Drag the right handle **past** the left handle (attempt to flip the skip or shrink to zero).

**Expected**
- The skip's effective width is clamped to ~50 ms.
- The preview does not crash.
- No negative `endSec` is written.

---

## Scenario 06.6 — Remove skip via the trash button

**Setup**
1. Project has 1 skip range.

**Steps**
1. Hover the skip region. The hover controls appear.
2. Click the trash button (`aria-label="Remove skip …"`).

**Expected**
- The skip is removed.
- `data-skip-count` returns to `0`.
- The preview plays the full clip without skipping.

---

## Scenario 06.7 — Skip range survives zoom changes

**Setup**
1. Project has 1 skip range. Zoomed to fit.

**Steps**
1. Ctrl+wheel up 5 notches. The timeline zooms in.
2. Read `data-skip-count`. The skip is still rendered at the correct source time.

**Expected**
- The skip's screen position scales with `pxPerSec`.
- The skip's source time is unchanged.
- Hover controls still work at the new zoom level.

---

## Scenario 06.8 — Skip range survives pan

**Setup**
1. From scenario 06.7 state. Zoomed in, the skip is visible.

**Steps**
1. Pan the viewport left by 200 px.
2. The skip's screen position moves with the pan.

**Expected**
- The skip is at the correct source time even when scrolled out of view.
- Scrolling back reveals the skip unchanged.

---

## Scenario 06.9 — Two skips on the same clip cannot overlap

**Setup**
1. Project has 1 clip of ≥ 10 s. No skips.

**Steps**
1. Add a skip at 2 s–4 s (via Scissors or T).
2. Try to add a second skip at 3 s–5 s.
3. The second skip is **clamped** to not overlap the first.

**Expected**
- The second skip's effective range is `4 s → ?` (starts where the first ends).
- If you drag the second skip's left edge into the first skip, it is clamped to the first skip's `endSec`.
- The drag tooltip shows the clamped range.

---

## Scenario 06.10 — Skip across clip boundaries (skip spanning two clips)

**Setup**
1. Project has 2 clips back-to-back.

**Steps**
1. Drag a skip region from inside clip 1 across the boundary into clip 2.

**Expected**
- The skip spans both clips in the timeline visualisation.
- During playback, the preview skips the range across the boundary.
- The skip's `startSec` and `endSec` are in **timeline time** (not source time), per the data model.

---

## Scenario 06.11 — Skip shows in the navigator strip

**Setup**
1. Project has 1 skip range.

**Steps**
1. Look at the navigator strip (`aria-label="Timeline zoom and pan navigator"`).

**Expected**
- A red dash mark at the skip's source time position.

---

## Scenario 06.12 — Snap-guide appears during region drag (P2 F2.6)

**Setup**
1. Project has 1 skip range.

**Steps**
1. Drag the right handle of the skip.
2. Observe the timeline ruler.

**Expected**
- Two vertical lines (snap-guide) appear at the start and end of the moving skip.
- They are 2 px wide, red (`--danger` color), positioned at the edge of the skip in the ruler.

---

## Scenario 06.13 — Floating drag tooltip during region drag (P2 F2.6)

**Setup**
1. From scenario 06.12 state.

**Steps**
1. While dragging, observe the floating tooltip.

**Expected**
- A small pill appears next to the moving edge.
- It shows the time range in `M:SS.s → M:SS.s` format (e.g. `0:02.1 → 0:04.5`).
- The tooltip disappears on release.

---

## Scenario 06.14 — Multi-select skip regions (P2 F2.7)

**Setup**
1. Project has 2 non-overlapping skips.

**Steps**
1. Click on the first skip. It is selected (highlighted).
2. Shift-click on the second skip. Both are now selected.
3. Press `Delete`.

**Expected**
- Both skips are removed.
- `data-skip-count` returns to `0`.

---

## Scenario 06.15 — Skip clip + delete via keyboard

**Setup**
1. Project has 1 skip range. The skip is selected (clicked).

**Steps**
1. Press `Delete` or `Backspace`.
2. The skip is removed.

**Expected**
- The skip is removed without needing to hover for the trash button.

---

## Scenario 06.16 — Skip respects `useEditorHistory` undo/redo

**Setup**
1. Project has 1 skip range.

**Steps**
1. Press `Ctrl+Z` (or `Cmd+Z`).
2. The skip is removed.
3. Press `Ctrl+Shift+Z` (or `Cmd+Shift+Z`).
4. The skip returns.

**Expected**
- Undo restores the previous state.
- Redo re-applies the removal.

---

## Scenario 06.17 — Skip waveform background (audio peaks)

**Setup**
1. Project has a clip with audio.

**Steps**
1. Zoom into the timeline so the skip row is visible.
2. The skip row shows an audio waveform (the `BackgroundWaveform` component).

**Expected**
- The waveform is rendered behind the skip pills.
- The waveform scales with the zoom level.
- The waveform is drawn from `useAudioPeaks.ts` (a worker).

---

## Scenario 06.18 — Skip range that covers the entire clip

**Setup**
1. Project has 1 clip of 5 s. No skips.

**Steps**
1. Resize the skip's left handle to the very left edge of the clip.
2. Resize the right handle to the very right edge.

**Expected**
- The skip covers the entire clip.
- During playback, the preview shows no frames (skip dominates).
- The exporter output is empty for this clip.

---

## Cross-cutting checks for this block

- Every skip operation triggers a `data-skip-count` change.
- The skip pill's screen position is always `startSec * pxPerSec` from the timeline's left edge.
- Hover controls are only visible on hover (no always-on state).
- The skip's color is `--danger` red.

**Next:** proceed to [`07-zoom-regions.md`](07-zoom-regions.md).