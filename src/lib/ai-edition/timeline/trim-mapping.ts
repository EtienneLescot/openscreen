// Timeline↔source mapping for trim ranges.
//
// Trims are stored in the DSL in *source-time per asset*
// (AxcutTrimRange = { assetId, startSec, endSec }) — that's the single source
// of truth the agent's `add_trim_range` op and the exporter read. But in the
// editor UI the user manipulates them on the timeline ruler, in *timeline
// (virtual) time*, exactly like zoom/speed/annotation regions. These pure
// helpers bridge the two so the DSL stays source-time while the UI treats
// trims as first-class timeline regions that can be dragged/resized freely
// across the ruler and re-attach to whichever clip they land on.

import type { AxcutClip, AxcutTrimRange } from "../schema";
import { type CoalescedSpan, ventilateSpanAcrossClips } from "./region-ventilation";
import { coalesceByIdentity, regionIdentityKey } from "./timelineMap";

/** A clip's on-timeline extent in source-seconds (how much of the source it plays). */
function clipSourceLen(clip: AxcutClip): number {
	return (clip.sourceEndSec ?? clip.sourceStartSec) - clip.sourceStartSec;
}

/**
 * Map a source-time trim to its span on the timeline, through the clip that
 * carries it (matches the source range of the trim's asset). Returns null when
 * no clip currently carries the trim's source region (e.g. the clip was trimmed
 * away) — such a trim is simply not shown on the ruler.
 */
export function trimToTimelineSpan(
	trim: Pick<AxcutTrimRange, "assetId" | "startSec" | "endSec">,
	clips: AxcutClip[],
): { start: number; end: number } | null {
	for (const c of clips) {
		if (c.assetId !== trim.assetId) continue;
		const srcEnd = c.sourceEndSec ?? c.sourceStartSec;
		// Anchor on the trim's start falling inside this clip's source range.
		if (trim.startSec >= c.sourceStartSec && trim.startSec <= srcEnd) {
			const map = (s: number) =>
				c.timelineStartSec + (Math.min(Math.max(s, c.sourceStartSec), srcEnd) - c.sourceStartSec);
			return { start: map(trim.startSec), end: map(trim.endSec) };
		}
	}
	return null;
}

/** A source range for one clip, the shape a DSL trim entry needs. */
export interface TrimSourceRange {
	assetId: string;
	sourceStartSec: number;
	sourceEndSec: number;
}

/**
 * Ventilate a **timeline** span into one source range per clip it covers — the
 * cross-clip analogue of `resolveTimelineSpanToTrim`. A trim grown across a clip
 * boundary can't be a single source range (source-time is per asset and the
 * clips may draw from different source positions or assets), so it materialises
 * as one entry per covered clip, exactly like a zoom straddling two clips splits
 * on reorder. Uses the shared ventilation primitive so trims and effects share
 * one manipulation path. Returns [] when the span touches no clip (the caller
 * falls back to the nearest-clip single range).
 */
export function ventilateTimelineSpanToTrims(
	startSec: number,
	endSec: number,
	clips: AxcutClip[],
): TrimSourceRange[] {
	const byId = new Map(clips.map((c) => [c.id, c]));
	return ventilateSpanAcrossClips(startSec, endSec, clips).flatMap((f) => {
		const c = byId.get(f.clipId);
		if (!c) return [];
		return [
			{
				assetId: c.assetId,
				sourceStartSec: c.sourceStartSec + f.localStartSec,
				sourceEndSec: c.sourceStartSec + f.localEndSec,
			},
		];
	});
}

/**
 * Group trims whose timeline spans touch into one visual unit.
 *
 * This used to be trim-specific logic sitting beside a separate mechanism for the
 * other region kinds — the duplication is gone: trims now go through the SAME merge
 * primitive as zoom / speed / annotation (`coalesceByIdentity`). A trim simply has no
 * user-visible properties, so all trims share one identity and any two that touch
 * merge; the familiar "trims always merge" behaviour is now a *consequence* of the
 * general rule rather than a rule of its own. That is what lets a trim ventilated
 * across a clip boundary (necessarily 2+ DSL rows, see `ventilateTimelineSpanToTrims`)
 * render and act as ONE pill. Trims with no mapped timeline span (their carrying clip
 * is gone) are dropped, same as `trimToTimelineSpan` callers already expect.
 */
export function coalescedTrimGroups(
	trimRanges: AxcutTrimRange[],
	clips: AxcutClip[],
	epsilonSec?: number,
): CoalescedSpan[] {
	const spans = trimRanges
		.map((t) => {
			const mapped = trimToTimelineSpan(t, clips);
			return mapped
				? {
						id: t.id,
						start: mapped.start,
						end: mapped.end,
						// A trim has no user-visible properties, so every trim shares one identity
						// and any two that touch merge. That is not a trim-specific rule any more:
						// it is the SAME merge primitive every modifier uses, reached through an
						// empty property set. (`regionIdentityKey` excludes position + provenance,
						// which is all a trim carries.)
						identity: regionIdentityKey(t as unknown as Record<string, unknown>),
					}
				: null;
		})
		.filter((x): x is { id: string; start: number; end: number; identity: string } => x !== null);
	// Drop the identity key: it is an internal grouping detail, and every trim shares it.
	return coalesceByIdentity(spans, epsilonSec).map(({ ids, start, end }) => ({ ids, start, end }));
}

/**
 * Inverse mapping: given a desired **timeline** span, find the clip whose
 * timeline extent contains the span's start, clamp the span to that clip's
 * extent, and map both edges back to the clip's **source-time** — yielding the
 * `assetId` + source range a DSL trim needs. This is what lets a trim be
 * dragged anywhere on the ruler and re-attach to whichever clip it lands on,
 * always producing a valid single-asset source range.
 *
 * Returns null when there are no clips at all.
 */
export function resolveTimelineSpanToTrim(
	startSec: number,
	endSec: number,
	clips: AxcutClip[],
): { assetId: string; sourceStartSec: number; sourceEndSec: number } | null {
	if (clips.length === 0) return null;
	const lo = Math.min(startSec, endSec);
	const hi = Math.max(startSec, endSec);

	// Clip whose timeline extent contains `lo`; fall back to the nearest clip so
	// a span dropped into a gap or past the end still resolves cleanly.
	const carrier =
		clips.find((c) => lo >= c.timelineStartSec && lo <= c.timelineEndSec) ??
		clips.reduce((best, c) =>
			Math.abs(c.timelineStartSec - lo) < Math.abs(best.timelineStartSec - lo) ? c : best,
		);

	const srcLen = clipSourceLen(carrier);
	// Clamp the timeline span to the carrier's timeline extent so it maps to a
	// single, in-bounds source range (trims never straddle two clips in the DSL).
	const tStart = Math.max(
		carrier.timelineStartSec,
		Math.min(lo, carrier.timelineStartSec + srcLen),
	);
	const tEnd = Math.max(tStart, Math.min(hi, carrier.timelineStartSec + srcLen));
	const toSrc = (t: number) => carrier.sourceStartSec + (t - carrier.timelineStartSec);
	return {
		assetId: carrier.assetId,
		sourceStartSec: toSrc(tStart),
		sourceEndSec: toSrc(tEnd),
	};
}
