// Live-preview zoom transform for the new editor's CSS-based preview stack.
//
// Reuses the legacy editor's region math (`findDominantRegion`,
// `computeZoomTransform`) so zoom-in/out easing, region priority, and focus
// resolution stay identical between the two editors — only the output
// differs: a CSS translate/scale pair instead of a Pixi container transform.
//
// `computeZoomTransform` is called with a unit stage ({width:1, height:1}),
// which makes its pixel-space output already a fraction of the preview
// box — exactly what CSS `translate(x%, y%)` expects (percentages resolve
// against the transformed element's own layout box).

import type {
	CursorTelemetryPoint,
	ZoomRegion as LegacyZoomRegion,
} from "@/components/video-editor/types";
import { getZoomScale } from "@/components/video-editor/types";
import { findDominantRegion } from "@/components/video-editor/videoPlayback/zoomRegionUtils";
import { computeZoomTransform } from "@/components/video-editor/videoPlayback/zoomTransform";
import type { AxcutZoomRegion } from "@/lib/ai-edition/schema";

export interface ZoomPreviewTransform {
	scale: number;
	translateXPercent: number;
	translateYPercent: number;
}

export const IDENTITY_ZOOM_TRANSFORM: ZoomPreviewTransform = {
	scale: 1,
	translateXPercent: 0,
	translateYPercent: 0,
};

const UNIT_STAGE = { width: 1, height: 1 };
const UNIT_MASK = { x: 0, y: 0, width: 1, height: 1 };

function toLegacyZoomRegion(region: AxcutZoomRegion): LegacyZoomRegion {
	return {
		id: region.id,
		startMs: region.startMs,
		endMs: region.endMs,
		depth: region.depth,
		focus: region.focus,
		focusMode: region.focusMode,
		rotationPreset: region.rotationPreset,
		customScale: region.customScale,
		source: region.source,
	};
}

/**
 * Resolves the zoom transform to apply to the preview at a given point on
 * the virtual (edited) timeline. `virtualTimeMs` must be in the same
 * coordinate space as `zoomRegion.startMs`/`endMs` (the timeline shown in
 * the ruler, not raw source-media time).
 *
 * `playbackRate` scales the zoom-in/out transition windows in source-time
 * so the transition keeps its authored wall-clock duration inside speed
 * regions. Defaults to 1 (no scaling).
 */
export function computeZoomPreviewTransform(
	zoomRegions: AxcutZoomRegion[],
	virtualTimeMs: number,
	cursorTelemetry?: CursorTelemetryPoint[],
	playbackRate = 1,
): ZoomPreviewTransform {
	if (zoomRegions.length === 0) return IDENTITY_ZOOM_TRANSFORM;

	const legacyRegions = zoomRegions.map(toLegacyZoomRegion);
	const dominant = findDominantRegion(legacyRegions, virtualTimeMs, {
		cursorTelemetry,
		playbackRate,
	});
	if (!dominant.region || dominant.strength <= 0) return IDENTITY_ZOOM_TRANSFORM;

	const zoomScale = dominant.blendedScale ?? getZoomScale(dominant.region);
	const transform = computeZoomTransform({
		stageSize: UNIT_STAGE,
		baseMask: UNIT_MASK,
		zoomScale,
		zoomProgress: dominant.strength,
		focusX: dominant.region.focus.cx,
		focusY: dominant.region.focus.cy,
	});

	return {
		scale: transform.scale,
		translateXPercent: transform.x * 100,
		translateYPercent: transform.y * 100,
	};
}
