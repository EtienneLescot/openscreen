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
	for (const c of clips) {
		const s = Math.max(lo, c.timelineStartSec);
		const e = Math.min(hi, c.timelineEndSec);
		if (e > s) {
			out.push({
				clipId: c.id,
				localStartSec: s - c.timelineStartSec,
				localEndSec: e - c.timelineStartSec,
			});
		}
	}
	return out;
}

export interface Span {
	startMs: number;
	endMs: number;
}

/**
 * Re-project a virtual-ms span through a clip reorder: decompose over the OLD
 * clip layout, re-place over the NEW layout, then merge fragments that stay
 * contiguous. Returns ≥1 spans — more than one only when the covered clips
 * actually separated. A span not sitting on any clip is returned unchanged.
 */
export function reprojectSpanForReorder(
	startMs: number,
	endMs: number,
	oldClips: AxcutClip[],
	newClips: AxcutClip[],
): Span[] {
	const frags = ventilateSpanAcrossClips(startMs / 1000, endMs / 1000, oldClips);
	if (frags.length === 0) return [{ startMs, endMs }];
	const newById = new Map(newClips.map((c) => [c.id, c]));
	const spans = frags
		.map((f): Span | null => {
			const nc = newById.get(f.clipId);
			if (!nc) return null;
			return {
				startMs: Math.round((nc.timelineStartSec + f.localStartSec) * 1000),
				endMs: Math.round((nc.timelineStartSec + f.localEndSec) * 1000),
			};
		})
		.filter((x): x is Span => x !== null)
		.sort((a, b) => a.startMs - b.startMs);
	if (spans.length === 0) return [{ startMs, endMs }];
	const merged: Span[] = [];
	for (const s of spans) {
		const last = merged.at(-1);
		// ≤1ms rounding gap counts as contiguous.
		if (last && s.startMs - last.endMs <= 1) last.endMs = Math.max(last.endMs, s.endMs);
		else merged.push({ ...s });
	}
	return merged;
}

/**
 * Re-project a list of virtual-ms regions through a clip reorder. A region that
 * ends up split across separated clips becomes several regions (extra copies
 * get a fresh id from `makeId`, keeping every other field). The first fragment
 * keeps the original id so single-piece regions are untouched identity-wise.
 */
export function reprojectRegionsForReorder<
	T extends { id: string; startMs: number; endMs: number },
>(regions: T[], oldClips: AxcutClip[], newClips: AxcutClip[], makeId: () => string): T[] {
	const out: T[] = [];
	for (const region of regions) {
		const spans = reprojectSpanForReorder(region.startMs, region.endMs, oldClips, newClips);
		spans.forEach((span, i) => {
			out.push({
				...region,
				id: i === 0 ? region.id : makeId(),
				startMs: span.startMs,
				endMs: span.endMs,
			});
		});
	}
	return out;
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
export function virtualSpanToSourceSpans(
	startMs: number,
	endMs: number,
	clips: AxcutClip[],
): Span[] {
	const byId = new Map(clips.map((c) => [c.id, c]));
	return ventilateSpanAcrossClips(startMs / 1000, endMs / 1000, clips).flatMap((f) => {
		const c = byId.get(f.clipId);
		if (!c) return [];
		return [
			{
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
 * original id). A region over no clip is passed through unchanged (best effort).
 */
export function projectRegionsToSourceTime<
	T extends { id: string; startMs: number; endMs: number },
>(regions: T[], clips: AxcutClip[], makeId: () => string): T[] {
	const out: T[] = [];
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
