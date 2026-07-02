# 05 — Clip operations: select, reorder, edit, duplicate, remove

**Surface:** `TimelinePane` (clip blocks + clip controls), `Bottombar` (`Edit clip` button), `Modals.tsx` (`EditClipModal`), `useTimeline` store.
**Prerequisites:** `02-editor-foundation.md`, `04-timeline-pan-zoom-scrub.md`.

**Goal of this block:** prove that clips (the timeline's atomic units) are fully manageable — drag in, select, reorder, duplicate, edit source range, and remove.

**Reference:**
- `Bottombar.tsx:337` — `aria-label="Edit clip"`.
- `TimelinePane.tsx:1318` — `aria-label="Edit clip"`.
- `TimelinePane.tsx:1340` — `aria-label="Remove clip"`.
- `TimelinePane.tsx:1270, :1280, :1301` — `aria-label="Adjust skip start…"`, `aria-label="Remove skip…"`, `aria-label="Adjust skip end…"`.
- `Modals.tsx:49` — `role="dialog"`.
- `Modals.tsx:65` — `aria-label="Close"`.
- `Modals.tsx:770` — `aria-label="Adjust clip start"`.
- `Modals.tsx:798` — `aria-label="Adjust clip end"`.
- `Bottombar.tsx` exposes `onDuplicateClip` via the keyboard shortcut (`Ctrl+C` / `Ctrl+V`) wired in `NewEditorShell.tsx`.

---

## Scenario 05.1 — Drag asset from Files list into timeline

**Setup**
1. Project is open with at least 1 asset in the Files list (from a previous recording or a previously-opened project).

**Steps**
1. Pointer-down on the asset row in the LeftPanel's Files section.
2. Drag into the timeline area. A drop indicator appears (a vertical line at the drop position).
3. Release the pointer over the empty area of the timeline (or over the existing clip block).

**Expected**
- A new clip appears at the drop position.
- If dropped on an existing clip: opens the `InsertSourceModal` (Add before / Add after / Split here and insert). Choose one.
- If dropped on empty timeline: creates a new clip starting at time 0 (or at the drop position if the timeline was non-empty).
- The preview loads the new clip.
- `data-clip-count` increases by 1.

---

## Scenario 05.2 — Click a clip to select

**Setup**
1. From scenario 05.1 state. Two clips exist.

**Steps**
1. Click on the first clip block. The clip border becomes mint.
2. Click on the second clip block. The first deselects; the second is highlighted.

**Expected**
- The selected clip has a visible mint border and a soft glow.
- Only one clip is selected at a time.
- Clicking on empty timeline area deselects all clips.

---

## Scenario 05.3 — Edit Clip dialog opens with embedded preview

**Setup**
1. From scenario 05.2 state. The second clip is selected.

**Steps**
1. Click the **Edit clip** pencil button on the clip block (`aria-label="Edit clip"`). The `EditClipModal` opens.
2. The modal shows:
   - Title: `Edit clip`.
   - Subtitle: the asset label.
   - Left: a small preview of the source range.
   - Right: start/end/duration readouts + a source-range track with draggable handles.

**Expected**
- The modal is centered with a backdrop.
- The preview plays the source range of the selected clip (not the full asset).
- The start/end readouts show the current `sourceStartSec` and `sourceEndSec`.
- The modal can be closed with `Esc`, the X button (`aria-label="Close"`), or backdrop click.

---

## Scenario 05.4 — Edit clip: drag the start handle

**Setup**
1. From scenario 05.3 state. The Edit Clip modal is open.

**Steps**
1. Locate the **start handle** (the left edge of the source-range track — `aria-label="Adjust clip start"`).
2. Pointer-down. Drag right by 60 px (~1 s).
3. Release.
4. The start readout updates.
5. Click `Apply` (or the equivalent confirm button).

**Expected**
- The preview's source start shifts right.
- The start readout in the modal reflects the new time.
- Clicking `Apply` closes the modal and updates the clip's `sourceStartSec` in the project.
- The clip block on the timeline does NOT change width (the source range shrunk but the timeline duration stayed the same).

---

## Scenario 05.5 — Edit clip: drag the end handle

**Setup**
1. Open the Edit Clip modal again for the same clip.

**Steps**
1. Locate the **end handle** (`aria-label="Adjust clip end"`). Drag left by 60 px.
2. Release. Click `Apply`.

**Expected**
- The clip's `sourceEndSec` decreases.
- The clip block's width does NOT change (timeline duration is preserved; source range shrunk).

---

## Scenario 05.6 — Edit clip: reset

**Setup**
1. From scenario 05.5 state. Open the modal again.

**Steps**
1. Drag the start handle right by 100 px.
2. Click `Reset` (if available).

**Expected**
- The clip's source range reverts to the full asset range.
- The start/end readouts reset.

---

## Scenario 05.7 — Drag-reorder clips

**Setup**
1. Project has 2 clips.

**Steps**
1. Pointer-down on the first clip block.
2. Drag right by 200 px. A vertical reorder marker appears at the drop position.
3. Release over the second clip's position.

**Expected**
- The clips swap order.
- The `timeline.clips` array reflects the new order.
- The timeline's `data-clip-count` is still `2`.
- The preview follows the new ordering.
- The drag threshold is 6 px (`CLIP_REORDER_THRESHOLD_PX = 6`) — moving less than 6 px is treated as a click.

---

## Scenario 05.8 — Duplicate clip via Ctrl+C / Ctrl+V

**Setup**
1. From scenario 05.7 state. One clip is selected.

**Steps**
1. Press `Ctrl+C` (or `Cmd+C` on macOS).
2. Press `Ctrl+V` (or `Cmd+V`).
3. Take a screenshot.

**Expected**
- A duplicate clip is inserted at the end of the timeline (or at the playhead position).
- The duplicate has a new `id` but the same `sourceStartSec` / `sourceEndSec` / `assetId` / `wordRefs`.
- `data-clip-count` increases by 1.

---

## Scenario 05.9 — Remove clip

**Setup**
1. From scenario 05.8 state. Three clips exist. Select one.

**Steps**
1. Click the **Remove clip** button on the clip block (`aria-label="Remove clip"`).
2. The clip is removed.

**Expected**
- `data-clip-count` decreases by 1.
- The preview does not crash.
- The timeline re-flows: any subsequent clips shift left to fill the gap.

---

## Scenario 05.10 — Multiple clips project flow

**Setup**
1. Drag 3 different assets into the timeline (or duplicate one twice).

**Steps**
1. Verify each clip block is rendered with a distinct color / label.
2. Click each clip in turn. Only one is highlighted at a time.
3. Reorder. The timeline visually swaps the clip blocks.
4. Duplicate the middle clip. There are now 4 clips.
5. Remove the first clip. There are now 3.

**Expected**
- Each clip block has its source range and asset label visible.
- Selection / reorder / duplicate / remove all work without crashing.
- The playhead survives all operations.
- The navigator strip updates its marker positions.

---

## Scenario 05.11 — Properties panel for selected clip

**Setup**
1. One clip is selected.

**Steps**
1. Open the right rail → **Properties** (or whichever pane shows selected-clip details).
2. The properties panel shows:
   - Asset label.
   - Source path.
   - Source start / end.
   - Timeline start / end.
   - Duration.

**Expected**
- The values match the clip's actual data.
- Editing a value (e.g. via an input field) updates the clip.
- Clicking **Deselect** (`aria-label="Deselect"`) clears the selection.

---

## Scenario 05.12 — Click on empty timeline deselects

**Setup**
1. A clip is selected.

**Steps**
1. Click on the empty area of the timeline (below the clip block).

**Expected**
- The selection is cleared.
- The properties panel shows the empty state.

---

## Scenario 05.13 — Keyboard shortcut: Delete selected region / clip

**Setup**
1. A clip is selected.

**Steps**
1. Press `Delete` or `Backspace`.

**Expected**
- The selected clip is removed.
- (Alternative: this shortcut may apply to selected regions only; if so, no clip is removed. Verify both behaviours.)

---

## Scenario 05.14 — Drop on a position outside any clip → create new clip at end

**Setup**
1. Project has 1 clip spanning the first 5 s.

**Steps**
1. Drag a new asset from the Files list and drop at the timeline's far right (past the existing clip).

**Expected**
- A new clip is appended at the end of the timeline (timeline start = previous clip's timeline end).

---

## Scenario 05.15 — Drop on a clip with a playhead inside it → InsertSourceModal

**Setup**
1. Project has 1 clip. The playhead is at the middle of the clip.

**Steps**
1. Drag a new asset from the Files list and drop over the existing clip's body.

**Expected**
- The `InsertSourceModal` appears with three options:
  - `Add before`
  - `Add after`
  - `Split here and insert`
- The preview shows the source asset's first frame.
- Press `Esc` to cancel; no clip is added.

---

## Scenario 05.16 — Insert source: split at playhead

**Setup**
1. From scenario 05.15 state. The playhead is at 3 s. The clip is 5 s long.

**Steps**
1. In the InsertSourceModal, click `Split here and insert`.
2. The modal closes.

**Expected**
- The original clip is split at 3 s:
  - Clip A: source 0 s → 3 s, timeline 0 s → 3 s.
  - New clip (inserted): source 0 s → full asset duration, timeline 3 s → 3 + duration.
  - Clip B (the tail): source 3 s → 5 s, timeline 3 + duration → 3 + duration + 2.
- Total clip count = 3.

---

## Scenario 05.17 — Cursor changes per region mode

**Setup**
1. Hover the timeline viewport.

**Steps**
1. Hover an empty area → cursor is `default` or `pointer`.
2. Hover a clip block → cursor is `pointer` (selectable).
3. Hover a skip handle → cursor is `ew-resize`.
4. Hover a region pill (zoom/speed/annotation) → cursor is `grab`.

**Expected**
- The cursor reflects the interaction mode.
- The body has the appropriate class (`timeline-scrubbing` etc.).

---

## Scenario 05.18 — Active-clip indicator in the timeline header

**Setup**
1. Multiple clips exist. The playhead is inside clip 2.

**Steps**
1. Read the timeline header.

**Expected**
- The header shows `Clip 2/3` (or similar).

---

## Scenario 05.19 — Clip total duration readout

**Setup**
1. Project has 3 clips of 5 s, 3 s, 7 s.

**Steps**
1. Read the timeline header.

**Expected**
- The total duration readout shows `0:15` (or `0:15.0` depending on format).

---

## Cross-cutting checks for this block

- Every clip operation updates `data-clip-count` correctly.
- The selection state survives `data-*` attribute changes.
- The properties panel is empty when no clip is selected.

**Next:** proceed to [`06-skip-regions.md`](06-skip-regions.md).