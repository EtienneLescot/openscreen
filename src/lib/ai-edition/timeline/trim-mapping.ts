// Timeline↔source mapping for trim ranges.
//
// Trims are stored in the DSL in *source time, anchored to one clip*
// (AxcutTrimRange = { assetId, clipId?, startSec, endSec }) — that's the single
// source of truth the agent's `add_trim_range` op and the exporter read. But in
// the editor UI the user manipulates them on the timeline ruler, in *timeline
// (virtual) time*, exactly like zoom/speed/annotation regions. These pure
// helpers bridge the two so the DSL stays source-time while the UI treats
// trims as first-class timeline regions that can be dragged/resized freely
// across the ruler and re-attach to whichever clip they land on.
//
// `clipId` is the v7 addition and it is what makes the mapping single-valued.
// Source time alone is per ASSET, so two clips over the same media (a duplicated
// clip) share a coordinate space: without the anchor, "which clip is this cut on?"
// had no answer and each caller invented its own. See `trimAppliesToClip`.

import type { AxcutClip, AxcutTrimRange } from "../schema";
import { type CoalescedSpan, ventilateSpanAcrossClips } from "./region-ventilation";
import { coalesceByIdentity, regionIdentityKey } from "./timelineMap";

/** A clip's on-timeline extent in source-seconds (how much of the source it plays). */
function clipSourceLen(clip: AxcutClip): number {
	return (clip.sourceEndSec ?? clip.sourceStartSec) - clip.sourceStartSec;
}

/** The identifying part of a trim: everything "which clip is this cut on?" may consult. */
export type TrimAnchor = Pick<AxcutTrimRange, "assetId" | "startSec" | "endSec"> & {
	clipId?: string;
};

/**
 * THE rule for "does this cut belong to this clip?" — one definition, because the bug this
 * replaces was three call sites each answering it differently.
 *
 * A v7 trim carries `clipId` and belongs to exactly that clip. That matters as soon as two
 * clips draw from the SAME asset (a duplicated clip, or the same recording placed twice):
 * `assetId` + source overlap then matches both, and every reader that used it either showed
 * the cut twice (transcript pane), drew it on the wrong clip (ruler), or removed the span
 * from both (playback / export).
 *
 * A trim with no `clipId` is pre-v7 or genuinely un-anchorable (`upgradeV6DocumentToV7`
 * keeps those rather than dropping them). It keeps the historical asset-wide meaning, so
 * old documents render exactly as they did.
 */
export function trimAppliesToClip(trim: TrimAnchor, clip: AxcutClip): boolean {
	if (trim.clipId !== undefined) return trim.clipId === clip.id;
	return trim.assetId === clip.assetId;
}

/**
 * Map a source-time trim to its span on the timeline, through the clip that carries it.
 * An anchored trim resolves through its OWN clip (`trimAppliesToClip`); an un-anchored one
 * falls back to the first clip of its asset whose source range contains the trim's start.
 * Returns null when no clip currently carries the trim's source region (e.g. the anchor
 * clip was deleted, or the range was trimmed away) — such a trim is not shown on the ruler.
 *
 * The two branches test the clip differently, on purpose. An UN-ANCHORED trim uses
 * containment of its start, because that test is doing the disambiguation: it is what
 * picks one clip out of the asset's several. An ANCHORED trim already names its clip, so
 * containment would only be a second, stricter question — and a harmful one: a clip re-cut
 * to start after the trim begins would drop the pill while `resolvePlaybackSegments` went
 * on cutting the overlap, leaving content removed with nothing on the ruler to click.
 * Overlap keeps the two in agreement; the mapping below clamps the edges either way.
 */
export function trimToTimelineSpan(
	trim: TrimAnchor,
	clips: AxcutClip[],
): { start: number; end: number } | null {
	for (const c of clips) {
		if (!trimAppliesToClip(trim, c)) continue;
		const srcEnd = c.sourceEndSec ?? c.sourceStartSec;
		const carries =
			trim.clipId !== undefined
				? trim.endSec > c.sourceStartSec && trim.startSec < srcEnd
				: trim.startSec >= c.sourceStartSec && trim.startSec <= srcEnd;
		if (carries) {
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
	/** The clip the cut sits on — the v7 anchor (see `trimAppliesToClip`). */
	clipId: string;
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
				clipId: c.id,
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
 * The trim rows that render as the SAME pill as `id` — the trim analogue of
 * `resolvePillIds` (timelineMap), which trims cannot reuse because it keys off
 * `startMs`/`endMs` and a trim stores `startSec`/`endSec` plus a `clipId` anchor.
 *
 * Needed because a pill is not a row: growing a trim across a clip boundary stores one row
 * per covered clip (`ventilateTimelineSpanToTrims`) and `coalescedTrimGroups` merges them
 * back into the single pill the user sees. Anything acting on "the trim the user clicked"
 * has to act on the group, or it leaves the other half behind — a stripe still cutting
 * content with no obvious way to reach it.
 *
 * Falls back to `[id]` when the id belongs to no group, same as `resolvePillIds`: an orphan
 * row (its anchor clip deleted, so `trimToTimelineSpan` maps it nowhere) is dropped from the
 * groups but must still be deletable.
 */
export function resolveTrimPillIds(
	trimRanges: AxcutTrimRange[],
	clips: AxcutClip[],
	id: string,
	epsilonSec?: number,
): string[] {
	return (
		coalescedTrimGroups(trimRanges, clips, epsilonSec).find((g) => g.ids.includes(id))?.ids ?? [id]
	);
}

/**
 * Delete the whole pill each of `ids` belongs to. The single definition of "delete a trim",
 * shared by the document mutator (`removeRegion`), the store's batch delete and — through
 * them — the Delete key, the inspector button and the LLM's `removeTrim`. Every other
 * region kind already routes its delete through `dropPillById` / `dropPillsByIds`; this is
 * the missing counterpart, not a new rule.
 */
export function dropTrimPillsByIds(
	trimRanges: AxcutTrimRange[],
	clips: AxcutClip[],
	ids: Iterable<string>,
	epsilonSec?: number,
): AxcutTrimRange[] {
	const under = new Set<string>();
	for (const id of ids) {
		for (const member of resolveTrimPillIds(trimRanges, clips, id, epsilonSec)) under.add(member);
	}
	if (under.size === 0) return trimRanges;
	return trimRanges.filter((t) => !under.has(t.id));
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
): TrimSourceRange | null {
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
		clipId: carrier.id,
		sourceStartSec: toSrc(tStart),
		sourceEndSec: toSrc(tEnd),
	};
}
