// Ventilation: distribute a virtual-timeline span across the clips it covers.
//
// Timeline-anchored regions (zoom / speed / annotation, stored in absolute
// virtual-timeline ms) sit "over" the clips beneath them. When clips are
// reordered, a region must follow the *content* it was over — which means a
// region that straddles several clips is split into one piece per clip, each
// following its clip. Pieces that land back-to-back after the move are merged
// so a region only actually splits when its clips separate. Pure, no DOM/IPC.

import type { AxcutClip } from "../schema";

export interface ClipFragment {
	clipId: string;
	/** Index of the covering clip within the `clips` array passed in — MUST be the same
	 *  array (same order) as the one serialized to `Scene.clips` (native side), so this
	 *  lines up with the native `clip_index` used to disambiguate clips that share a
	 *  source asset / overlapping source-time windows. */
	clipIndex: number;
	/** Offset (seconds) from the covering clip's timelineStartSec. */
	localStartSec: number;
	localEndSec: number;
}

/**
 * Decompose a virtual-timeline span into the portions that fall over each clip,
 * expressed as clip-local offsets. Clips the span doesn't touch are omitted.
 */
export function ventilateSpanAcrossClips(
	startSec: number,
	endSec: number,
	clips: AxcutClip[],
): ClipFragment[] {
	const lo = Math.min(startSec, endSec);
	const hi = Math.max(startSec, endSec);
	const out: ClipFragment[] = [];
	clips.forEach((c, clipIndex) => {
		const s = Math.max(lo, c.timelineStartSec);
		const e = Math.min(hi, c.timelineEndSec);
		if (e > s) {
			out.push({
				clipId: c.id,
				clipIndex,
				localStartSec: s - c.timelineStartSec,
				localEndSec: e - c.timelineStartSec,
			});
		}
	});
	return out;
}

export interface Span {
	startMs: number;
	endMs: number;
}

/**
 * Map a virtual-ms span down to **source-ms** spans, one per covered clip.
 * Effects (zoom / speed / annotation) are authored in virtual time, but the
 * export frame loop matches them against each decoded frame's *source* time —
 * so before export a virtual region is projected onto the source ranges of the
 * clips it covers (through clip in/out + order). A region straddling two clips
 * yields two source spans (which land at the right output frames on each side
 * of the clip boundary). Returns [] when the span sits on no clip.
 */
export interface SourceSpan extends Span {
	/** Index of the covering clip within the `clips` array passed in (see `ClipFragment`) —
	 *  travels through to `clipIndex` on the projected region so the native side can
	 *  disambiguate clips whose source-time windows numerically overlap (same or different
	 *  underlying asset) instead of matching by time-overlap alone. */
	clipIndex: number;
}

export function virtualSpanToSourceSpans(
	startMs: number,
	endMs: number,
	clips: AxcutClip[],
): SourceSpan[] {
	const byId = new Map(clips.map((c) => [c.id, c]));
	return ventilateSpanAcrossClips(startMs / 1000, endMs / 1000, clips).flatMap((f) => {
		const c = byId.get(f.clipId);
		if (!c) return [];
		return [
			{
				clipIndex: f.clipIndex,
				startMs: Math.round((c.sourceStartSec + f.localStartSec) * 1000),
				endMs: Math.round((c.sourceStartSec + f.localEndSec) * 1000),
			},
		];
	});
}

/**
 * Project a list of virtual-ms regions to source-ms for the export matcher
 * (see `virtualSpanToSourceSpans`). Regions straddling clips split into one per
 * covered clip (extra copies get a fresh id from `makeId`; the first keeps the
 * original id). A region over no clip is passed through unchanged (best effort,
 * `clipIndex` left unset — matches the native "belongs to any clip" fallback).
 *
 * `clips` MUST be the same array (same order) serialized to `Scene.clips` on the native
 * side, so the emitted `clipIndex` lines up — see `ClipFragment`.
 */
export function projectRegionsToSourceTime<
	T extends { id: string; startMs: number; endMs: number },
>(regions: T[], clips: AxcutClip[], makeId: () => string): (T & { clipIndex?: number })[] {
	const out: (T & { clipIndex?: number })[] = [];
	for (const region of regions) {
		const spans = virtualSpanToSourceSpans(region.startMs, region.endMs, clips);
		if (spans.length === 0) {
			out.push(region);
			continue;
		}
		spans.forEach((span, i) => {
			out.push({
				...region,
				id: i === 0 ? region.id : makeId(),
				startMs: span.startMs,
				endMs: span.endMs,
				clipIndex: span.clipIndex,
			});
		});
	}
	return out;
}

export interface CoalescedSpan {
	/** Member ids, left-to-right. */
	ids: string[];
	start: number;
	end: number;
}

/**
 * Group same-kind spans whose edges touch (within `epsilonSec`) into single
 * spans — the "two touching elements act as one" rule for display/selection.
 * Sorts by start first, so grouping is transitive (A touching B touching C
 * yields one group of 3) regardless of input order. Overlapping (not just
 * touching) spans also merge, so a nested span with a smaller end must not
 * shrink the group's end backward — hence `Math.max`, not overwrite.
 */
export function coalesceTouchingSpans(
	spans: Array<{ id: string; start: number; end: number }>,
	epsilonSec = 0.001,
): CoalescedSpan[] {
	if (spans.length === 0) return [];
	const sorted = [...spans].sort((a, b) => a.start - b.start);
	const out: CoalescedSpan[] = [];
	for (const s of sorted) {
		const last = out.at(-1);
		if (last && s.start - last.end <= epsilonSec) {
			last.ids.push(s.id);
			last.end = Math.max(last.end, s.end);
		} else {
			out.push({ ids: [s.id], start: s.start, end: s.end });
		}
	}
	return out;
}
