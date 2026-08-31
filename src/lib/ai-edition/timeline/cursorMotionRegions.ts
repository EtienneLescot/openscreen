// The one conversion between the DOCUMENT's cursor motion region and the pure
// sampler's. They differ on purpose — see the comment above
// `cursorMotionRegionSchema` — and three callers need the bridge: the store (to
// split a region at the playhead), the preview overlay (to draw the path), and
// `sceneDescription` (to hand resolved geometry to the compositor). Writing it
// three times is how the two shapes drift apart.

import type {
	CursorMotionPoint,
	CursorMotionRegion,
	CursorMotionTelemetrySample,
} from "@/lib/cursor/cursorMotion";
import { sampleCursorMotionRegion } from "@/lib/cursor/cursorMotion";
import type { AxcutCursorMotionRegion } from "../schema";

export function toModelCursorMotionRegion(region: AxcutCursorMotionRegion): CursorMotionRegion {
	const sourceStartSec = region.sourceStartSec ?? 0;
	const sourceEndSec = region.sourceEndSec ?? sourceStartSec;
	return {
		id: region.id,
		// A stored region always carries its anchor — `addCursorMotion` runs the
		// drafts through `anchorRegionsWithDerivedMs` before saving. The fallbacks
		// exist because the SCHEMA leaves the anchor optional (it is shared with
		// every other region kind, and v2 imports arrive without one); the sampler
		// never reads either field, so an empty string here changes no geometry.
		clipId: region.clipId ?? "",
		assetId: region.assetId ?? "",
		startMs: region.startMs,
		endMs: region.endMs,
		sourceStartMs: Math.round(sourceStartSec * 1000),
		sourceEndMs: Math.round(sourceEndSec * 1000),
		startPoint: region.startPoint,
		endPoint: region.endPoint,
		controlPoints: [region.controlPoint],
		startAnchor: region.startAnchor,
		endAnchor: region.endAnchor,
		segmentKind: region.segmentKind,
		preset: region.preset,
		speed: region.speed,
		cycles: region.cycles,
		easing: region.easing,
	};
}

/** Where the cursor sits at `sourceTimeMs` inside `region`, per the region's own
 *  preset, speed and easing. Used to place a manual split's shared anchor: both
 *  halves must start and end exactly where the path already passed, or the split
 *  visibly moves the cursor. */
export function sampleStoredCursorMotionRegion(
	region: AxcutCursorMotionRegion,
	sourceTimeMs: number,
): CursorMotionPoint {
	return sampleCursorMotionRegion(toModelCursorMotionRegion(region), sourceTimeMs);
}

/** Native cursor samples carry `interactionType` and `visible` already, and the
 *  sampler asks for nothing else. This is a widening, not a conversion — it exists
 *  so callers don't have to assert the structural match at every call site. */
export function toCursorMotionSamples(
	samples: readonly {
		timeMs: number;
		cx: number;
		cy: number;
		visible?: boolean;
		interactionType?: string | null;
	}[],
): CursorMotionTelemetrySample[] {
	return samples as CursorMotionTelemetrySample[];
}
