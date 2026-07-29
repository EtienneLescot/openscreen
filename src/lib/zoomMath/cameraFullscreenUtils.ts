import type { CameraFullscreenRegion } from "@/components/video-editor/types";
import { TRANSITION_WINDOW_MS } from "./constants";
import { easeOutScreenStudio } from "./mathUtils";

// The return to the normal layout should feel gentler than the expansion, so the
// lead-out window is stretched relative to the lead-in one.
const LEAD_OUT_WINDOW_MS = TRANSITION_WINDOW_MS * 1.5;

/**
 * Ease-in/hold/ease-out envelope for a single region. Unlike zoom's
 * `computeRegionStrength` (which anticipates the transition before `startMs`),
 * Full Camera must stay fully contained within [startMs, endMs]: progress is
 * exactly 0 at startMs, eases up to 1 within a lead-in window that starts at
 * startMs, holds at 1, then eases back down to exactly 0 at endMs (over a longer
 * window than the lead-in). Outside [startMs, endMs] progress is always 0. The
 * transition windows are clamped to at most half the region's duration so short
 * regions still ease in/out fully within their own bounds instead of overlapping.
 */
function computeCameraFullscreenRegionStrength(
	region: CameraFullscreenRegion,
	timeMs: number,
): number {
	if (timeMs <= region.startMs || timeMs >= region.endMs) {
		return 0;
	}

	const duration = region.endMs - region.startMs;
	const halfDuration = duration / 2;
	const leadInWindow = Math.min(TRANSITION_WINDOW_MS, halfDuration);
	const leadOutWindow = Math.min(LEAD_OUT_WINDOW_MS, halfDuration);
	const leadInEnd = region.startMs + leadInWindow;
	const leadOutStart = region.endMs - leadOutWindow;

	if (timeMs < leadInEnd) {
		const progress = leadInWindow > 0 ? (timeMs - region.startMs) / leadInWindow : 1;
		return easeOutScreenStudio(progress);
	}

	if (timeMs <= leadOutStart) {
		return 1;
	}

	const progress = leadOutWindow > 0 ? (region.endMs - timeMs) / leadOutWindow : 0;
	return easeOutScreenStudio(progress);
}

/**
 * Returns the Full Camera progress (0..1) at a given time: 0 = webcam at its normal
 * layout, 1 = webcam fully covering the canvas. Ramps in/out at the edges of the
 * dominant region using the same easing as zoom. When multiple regions overlap
 * (shouldn't normally happen given timeline overlap guards, but is handled
 * defensively) the strongest one wins.
 */
export function computeCameraFullscreenProgress(
	regions: CameraFullscreenRegion[],
	timeMs: number,
): number {
	let strongest = 0;
	for (const region of regions) {
		const strength = computeCameraFullscreenRegionStrength(region, timeMs);
		if (strength > strongest) {
			strongest = strength;
		}
	}
	return strongest;
}
