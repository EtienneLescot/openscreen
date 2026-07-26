# T19 — Zooming in the timeline updates the preview

**Seed:** `tests/e2e/seed.spec.ts`
**Roadmap status:** ✅ done (`761496e`)

## Application Overview

The timeline has a zoom level (data-zoom-multiplier on the timeline section) that the user changes by Ctrl+wheel, by middle-click drag, or via the navigator strip. When the user zooms in, the timeline shows **more pixels per second** of source time, so clip blocks get wider and the ruler ticks get finer.

The user-reported bug: **zooming in does not change what the preview shows**. The playhead stays at the same `currentTimeSec`; the preview keeps playing the same source time. From the user's perspective, zooming in feels broken because the visible result is "the preview doesn't care".

There are actually two distinct sub-features here:

- **Timeline viewport zoom** — visible ruler/clip scale changes. Confirmed to work via the `data-px-per-sec` attribute on the viewport.
- **Preview follows zoom** — when the user zooms in, the preview zooms too (axcut's "camera zoom" behavior). **This is the one that's broken.**

This spec covers BOTH: timeline viewport zoom AND preview-driven zoom, and asserts they happen.

## Test Scenarios

### 1. Ctrl+wheel on the timeline viewport changes `data-px-per-sec`

**Setup**

1. Open the editor at `http://localhost:5173/?windowType=editor`.
2. Apply a project with at least one clip of length > 5 seconds.

**Steps**

1. Hover the timeline viewport (`data-testid="timeline-viewport"`).
2. Press and hold `Control`.
3. Wheel the mouse **up** (negative deltaY) three notches.
4. Release `Control`.
5. Read the `data-px-per-sec` attribute on the viewport.
6. Read the `data-zoom-multiplier` attribute on the timeline pane.

**Expected results**

- `data-px-per-sec` increased compared to step 1 (more pixels per second = zoomed in).
- `data-zoom-multiplier` is greater than 1.0.

### 2. After zooming in, the preview's `data-current-time-sec` reflects the new state (preview follow)

**Setup**

1. Same as scenario 1.
2. The asset is loaded into the preview; the playhead is at some position (e.g. 1.5s into the clip).

**Steps**

1. Read the preview's `data-current-time-sec` BEFORE zoom.
2. Hover the timeline ruler.
3. Hold `Control` and wheel up 3 notches (zoom in).
4. Read the preview's `data-current-time-sec` AFTER zoom.

**Expected results**

Either:

- (A) The preview's `currentTimeSec` did **not** change (zoom is viewport-only and the preview stays at the playhead). This is the conservative interpretation.
- (B) The preview's `currentTimeSec` shifted to match the new zoomed position (axcut behavior: zoom is a camera-zoom on the preview).

Today, neither is reliably implemented. The most useful test is: **the preview's source time remains coherent with the timeline — it doesn't desync, freeze, or show a different clip than the one under the playhead.**

### 3. Ctrl+wheel-down zooms out

**Setup**

1. Same as scenario 1, after step 1 of scenario 1 (`data-px-per-sec` is now larger than the initial).

**Steps**

1. Hold `Control` and wheel **down** 3 notches.
2. Read `data-px-per-sec` and `data-zoom-multiplier`.

**Expected results**

- `data-px-per-sec` decreased (back toward the initial value or lower).
- `data-zoom-multiplier` is less than the value from scenario 1.
- The minimum `data-px-per-sec` is the **initial fit value** (zoom cannot go below 1.0 → "fit to width").

### 4. Zoom is bounded by MAX_PX_PER_SEC

**Setup**

1. Same as scenario 1.

**Steps**

1. Hold `Control` and wheel up **30** notches (extreme zoom-in).

**Expected results**

- `data-px-per-sec` does not exceed 280 (the `MAX_PX_PER_SEC` constant from the roadmap).
- No error in the console.
