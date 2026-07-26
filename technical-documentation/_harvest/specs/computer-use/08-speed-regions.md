# 08 — Speed regions

**Surface:** `TimelinePane` (speed lane), `Bottombar` (add-speed button), `RightPanes` (speed region inspector), `useTimeline` store.
**Prerequisites:** `02-editor-foundation.md`, `04-timeline-pan-zoom-scrub.md`, `05-clip-operations.md`, `06-skip-regions.md`.

**Goal of this block:** prove speed regions can be added, configured (0.1×–16×), and removed, and that they actually change playback speed during preview.

**Reference:**
- `types.ts:368-396` — `PlaybackSpeed = number` (MIN 0.1, MAX 16), `SpeedRegion { id, startMs, endMs, speed }`, `SPEED_OPTIONS`.
- `SPEED_OPTIONS` includes values like `0.25, 0.5, 1, 1.5, 2, 4`.
- Design token `--speed` (`#f97316` orange) and `--speed-soft`.

---

## Scenario 08.1 — Add speed region

**Setup**
1. Project has 1 clip of ≥ 5 s. The playhead is at some position.

**Steps**
1. Click the **Add Speed** button in the bottombar (icon next to ZoomIn and Add Annotation — implementation-specific; the exact button is in `Bottombar.tsx`).
2. Wait 200 ms.

**Expected**
- A speed region is added at the playhead position with the default length.
- Default speed is `2` (2×) — verify via the inspector.
- The pill is rendered in the speed lane in **orange** (`--speed` color).
- `speedRanges.length` is now `1`.

---

## Scenario 08.2 — Change speed via slider

**Setup**
1. From scenario 08.1 state. Speed region is selected.

**Steps**
1. The inspector shows a speed slider (range `0.1` to `16`, step `0.1`).
2. Drag the slider to `4`.
3. The pill label updates to `4.0×`.

**Expected**
- The region's `speed` is `4`.
- The preview at the speed range plays 4× faster.
- The pill label updates.

---

## Scenario 08.3 — Change speed via preset selector

**Setup**
1. From scenario 08.2 state.

**Steps**
1. The inspector also has a preset dropdown with `0.25×, 0.5×, 1×, 1.5×, 2×, 4×`.
2. Click `0.5×`.

**Expected**
- The slider moves to `0.5`.
- The pill label updates to `0.5×`.
- The preview at the range plays at half speed.

---

## Scenario 08.4 — Playback at very slow speed (0.1×)

**Setup**
1. From scenario 08.3 state. Speed set to `0.1`.

**Steps**
1. Play the timeline.

**Expected**
- The preview plays 10× slower than real time.
- Audio is slowed (chipmunk if it's a vocal recording; or pitch-shifted — verify the audio is recognisable).
- No playback glitches.

---

## Scenario 08.5 — Playback at fast speed (8×)

**Setup**
1. Set the speed to `8` via the slider.

**Steps**
1. Play the timeline.

**Expected**
- The preview plays 8× faster than real time.
- Audio is sped up (or muted, implementation choice).

---

## Scenario 08.6 — Resize speed region

**Setup**
1. Speed region exists.

**Steps**
1. Drag the left handle right by 30 px.
2. Drag the right handle left by 50 px.

**Expected**
- The region's `startMs` / `endMs` change.
- The snap-guide and tooltip appear during the drag.
- The preview's playback duration at the new range is `originalDuration / speed`.

---

## Scenario 08.7 — Remove speed region

**Setup**
1. Speed region is selected.

**Steps**
1. Click the trash button or press `Delete`.

**Expected**
- The region is removed.
- `speedRanges.length` decreases.

---

## Scenario 08.8 — Multiple speed regions

**Setup**
1. Add 3 speed regions with speeds `0.5, 2, 4`.

**Steps**
1. Each pill shows the correct speed.
2. Play the timeline.

**Expected**
- The preview plays at `0.5×`, then `2×`, then `4×` as the playhead crosses each region.
- The transitions are smooth (or abrupt, depending on implementation — verify there's no audio glitch).

---

## Scenario 08.9 — Speed + skip coexist

**Setup**
1. Project has a speed region and a skip region overlapping.

**Steps**
1. Play the timeline.

**Expected**
- During the overlap, the skip applies first (cuts out the range), then the speed is irrelevant.
- Outside the overlap, the speed applies normally.

---

## Scenario 08.10 — Speed + zoom coexist

**Setup**
1. Speed region and zoom region overlap.

**Steps**
1. Play the timeline.

**Expected**
- The zoom applies throughout the speed region's range.
- The frame motion is at the speed factor.

---

## Scenario 08.11 — Speed region survives zoom in timeline

**Setup**
1. Speed region exists. Zoom out to fit.

**Steps**
1. Ctrl+wheel up to zoom in 5×.

**Expected**
- The speed pill scales with `pxPerSec`.
- Its source-time position is unchanged.

---

## Scenario 08.12 — Speed region undo/redo

**Setup**
1. Speed region exists.

**Steps**
1. Press `Ctrl+Z`. Region removed.
2. Press `Ctrl+Shift+Z`. Region returns.

**Expected**
- Undo / redo work.

---

## Scenario 08.13 — Speed pill label format

**Setup**
1. Speed region with speed `1.5`.

**Steps**
1. Read the pill text.

**Expected**
- The pill shows `1.5×` (the format depends on the implementation; it may be `1.5x` or `1.5×`).

---

## Cross-cutting checks for this block

- `speedRanges.length` reflects all visible speed pills.
- The pill color is consistent (orange / `--speed`).
- The speed value is always within `[0.1, 16]`.

**Next:** proceed to [`09-annotation-regions.md`](09-annotation-regions.md).