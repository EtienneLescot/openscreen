# 07 — Zoom regions

**Surface:** `TimelinePane` (zoom lane), `Bottombar` (`ZoomIn` button), `RightPanes` (zoom region inspector), `RightPanelStack`, `useTimeline` store, `zoomSuggestions.ts` (Magic Wand).
**Prerequisites:** `02-editor-foundation.md`, `04-timeline-pan-zoom-scrub.md`, `05-clip-operations.md`, `06-skip-regions.md` (so the timeline has regions visible).

**Goal of this block:** prove the zoom-region model — depth (1×–6×), focus point, rotation presets, and the Magic Wand auto-suggestion.

**Reference:**
- `types.ts:71` — `ZoomRegion { id, startMs, endMs, depth, focus: ZoomFocus, focusMode?, rotationPreset?, customScale?, source?: "auto"|"manual" }`.
- `types.ts:34-58` — `Rotation3D { rotationX, rotationY, rotationZ }` + presets `iso/left/right`.
- `types.ts:400-407` — `ZOOM_DEPTH_SCALES: Record<ZoomDepth, number>` (`1.25x → 5.0x`).
- `Bottombar.tsx` exposes `onAddZoom` via the ZoomIn button.
- roadmap F2.1 (`58feb34`) — Magic Wand suggestions wired to the disabled "Magic" button.
- roadmap F2.2 — Region inspector font family / animation (annotation, not zoom — but the inspector surface is shared).

---

## Scenario 07.1 — Add zoom region via ZoomIn button

**Setup**
1. Project has 1 clip of ≥ 5 s. The playhead is at some position (e.g. 1 s).

**Steps**
1. Click the **ZoomIn** button in the bottombar's view-tools cluster.
2. Wait 200 ms.

**Expected**
- A zoom region is added at the playhead position with a default length (matches the place-skip default).
- Default depth is `2` (2.0×).
- Default focus is the centre of the frame (`{ cx: 0.5, cy: 0.5 }`).
- Default rotation is identity.
- `zoomRanges.length` is now `1`.
- The zoom pill is rendered in the zoom lane (below the clip track) in mint color.
- The preview at the zoom range shows the zoomed-in frame.

---

## Scenario 07.2 — Cycle zoom depth

**Setup**
1. From scenario 07.1 state. A zoom region is selected.

**Steps**
1. Click the zoom region. The inspector panel opens.
2. The depth selector shows a row of buttons or a slider: `1×`, `2×`, `3×`, `4×`, `5×`, `6×`.
3. Click `4×`. The zoom factor changes.
4. Click `1×`. Reverts.

**Expected**
- The preview updates immediately to show the new zoom level.
- The depth value is saved to the region's `depth` field.
- The zoom lane pill may change visual appearance (e.g. taller pill, brighter border) as depth increases.

---

## Scenario 07.3 — Drag the focus point

**Setup**
1. From scenario 07.2 state. A zoom region with depth 3× is selected.

**Steps**
1. The inspector shows a mini-preview of the frame with a focus-point dot.
2. Drag the focus dot from centre to upper-left.
3. Release.

**Expected**
- The region's `focus` is updated: `{ cx: ~0.25, cy: ~0.25 }`.
- The preview at the zoom range pans to follow the new focus point.

---

## Scenario 07.4 — Apply rotation preset (iso)

**Setup**
1. From scenario 07.3 state.

**Steps**
1. The inspector shows a rotation preset selector: `none`, `iso`, `left`, `right`.
2. Click `iso`.

**Expected**
- The preview rotates to the iso angle (3D rotation around X + Y axes).
- The region's `rotationPreset` is set to `iso`.
- The 3D rotation's drop shadow re-applies after rotation.

---

## Scenario 07.5 — Apply rotation preset (left, right)

**Setup**
1. From scenario 07.4 state.

**Steps**
1. Click `left`. The frame tilts left.
2. Click `right`. The frame tilts right.
3. Click `none`. The rotation reverts.

**Expected**
- Each preset transitions smoothly.
- The visual matches `Rotation3D` values for the preset.

---

## Scenario 07.6 — Magic Wand suggests zoom regions

**Setup**
1. Project has 1 clip with a transcript (auto-transcribed — see 11.x).
2. No zoom regions exist.

**Steps**
1. Click the **Magic** (WandSparkles) button in the bottombar's view-tools.
2. Wait for the suggestions to be applied (async).

**Expected**
- One or more zoom regions are added to the project.
- The regions correspond to low-amplitude / sustained-speech segments (`zoomSuggestions.ts` heuristic).
- `zoomRanges.length` increases.
- The total duration covered by the new regions is < the total clip duration (the heuristic only adds zooms over selected segments).

---

## Scenario 07.7 — Auto-Focus toggle

**Setup**
1. From scenario 07.6 state. Magic Wand has added zoom regions.

**Steps**
1. Click the **Auto-Focus** toggle (`ScanEye` icon) in the bottombar.
2. The toggle's pressed state shows.
3. Play the timeline.

**Expected**
- The focus point of the zoom regions is now driven by `cursorFollowUtils.advanceFollowFocus` (smooth follow of the recorded cursor).
- The cursor follows the recorded cursor position within the zoomed-in region.
- Toggle off → focus returns to the static `focus` field of each region.

---

## Scenario 07.8 — Resize a zoom region

**Setup**
1. Project has 1 zoom region.

**Steps**
1. Drag the left handle of the zoom pill right by 40 px.
2. Drag the right handle left by 40 px.

**Expected**
- The region's `startMs` / `endMs` change.
- The preview at the new range shows the zoom.
- The snap-guide and tooltip appear during the drag (same as skip regions, P2 F2.6).

---

## Scenario 07.9 — Remove a zoom region

**Setup**
1. Project has 1 zoom region, selected.

**Steps**
1. Click the trash button on the zoom pill OR press `Delete`.

**Expected**
- The zoom region is removed.
- `zoomRanges.length` decreases.

---

## Scenario 07.10 — Multiple zoom regions on the same clip

**Setup**
1. Add 3 zoom regions at different positions.

**Steps**
1. Verify all 3 are rendered in the zoom lane.
2. Select each in turn. The inspector shows the correct depth / focus / rotation.

**Expected**
- Zoom pills do not overlap (the timeline prevents overlapping zoom regions).
- Each region has independent settings.

---

## Scenario 07.11 — Zoom region spanning clip boundaries

**Setup**
1. Project has 2 clips back-to-back.

**Steps**
1. Drag a zoom region from inside clip 1 to span into clip 2.

**Expected**
- The zoom pill spans the boundary.
- During playback, the preview shows the zoom across both clips' content.

---

## Scenario 07.12 — Zoom region snap-to-clip-boundary

**Setup**
1. Project has 2 clips. A zoom region's right edge is being dragged.

**Steps**
1. Drag the right edge close to the boundary between clip 1 and clip 2.

**Expected**
- A snap-guide line appears at the boundary.
- On release, if the edge is within the snap threshold, it snaps to the boundary.

---

## Scenario 07.13 — Zoom region survives skip region add

**Setup**
1. Project has 1 zoom region. No skips.

**Steps**
1. Add a skip range overlapping the zoom region.

**Expected**
- The skip and zoom coexist (they are independent dimensions).
- During playback, the skip cuts out the range; the zoom does not apply during the cut.

---

## Scenario 07.14 — Zoom region undo / redo

**Setup**
1. Project has 1 zoom region.

**Steps**
1. Press `Ctrl+Z`. The zoom region is removed.
2. Press `Ctrl+Shift+Z`. It returns.

**Expected**
- Undo / redo work for zoom regions.

---

## Scenario 07.15 — Zoom region depth displayed in the pill label

**Setup**
1. Project has 1 zoom region with depth `3×`.

**Steps**
1. Look at the zoom pill's text content.

**Expected**
- The pill shows `3.0×` or `3×` (the zoom factor).

---

## Scenario 07.16 — Zoom in preview does not affect timeline ruler

**Setup**
1. Project has 1 zoom region. The preview shows the zoomed-in frame.

**Steps**
1. Take a screenshot of the timeline ruler.

**Expected**
- The timeline ruler still shows the source times (unaffected by the preview zoom).
- The clip block widths are unchanged.

---

## Scenario 07.17 — Camera zoom follows cursor (when Auto-Focus is on)

**Setup**
1. Auto-Focus is on (scenario 07.7).
2. Project was recorded with the cursor moving.
3. Play from a position with cursor motion inside a zoom region.

**Steps**
1. Watch the preview.

**Expected**
- The zoomed-in frame tracks the cursor smoothly.
- The motion is identical between preview and export (spring smoothing shared).

---

## Cross-cutting checks for this block

- `zoomRanges.length` is always reflected in the zoom lane.
- The inspector shows the selected region's settings accurately.
- Zoom regions are mint-colored (per design token `--accent`).

**Next:** proceed to [`08-speed-regions.md`](08-speed-regions.md).