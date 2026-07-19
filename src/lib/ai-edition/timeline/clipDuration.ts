// Single canonical helper for resolving a clip's effective `sourceEndSec`. The
// four consumers (preview composer, scene serializer, render-plan builder, and
// export trim/schedule builder) used to re-derive this each with a slightly
// different formula; this file pins the precedence and keeps them in lock-step.

import type { AxcutAsset, AxcutClip } from "../schema";

/**
 * Resolve the effective `sourceEndSec` for a clip, in seconds.
 *
 * Precedence (highest to lowest):
 *   1. `clip.sourceEndSec` when probed/known — the most specific, per-clip
 *      authoritative value the renderer can trust.
 *   2. `asset.durationSec` when the asset's own probed duration is known —
 *      more accurate than a timeline-duration guess, since speed edits can
 *      stretch or compress the timeline without changing the source length.
 *   3. The timeline-duration formula
 *      `sourceStartSec + (timelineEndSec - timelineStartSec)` as a last resort
 *      (legacy/migrated documents before probing).
 *
 * `asset` may be `undefined` for orphan clips; the helper then degrades cleanly
 * to the timeline-duration formula at step 3.
 */
export function resolveClipSourceEndSec(clip: AxcutClip, asset: AxcutAsset | undefined): number {
	if (clip.sourceEndSec !== undefined) return clip.sourceEndSec;
	if (asset?.durationSec !== undefined) return asset.durationSec;
	return clip.sourceStartSec + (clip.timelineEndSec - clip.timelineStartSec);
}
