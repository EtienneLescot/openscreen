// One answer to "is this raw ruler moment in the film" (issue #560).
//
// Everything that reads the timeline used to answer that question its own way, and the
// answers disagreed. The transcript pane asked it by IDENTITY — does a trim name this
// clip — which is a question a voiceover placement can never answer yes to, since it
// carries an audio fragment id and an audio asset while every trim carries a video clip.
// So the voiceover lane read every word as kept, including words whose moment had been
// cut out of the film, and a cut authored from that lane removed nothing at all.
//
// The fix is not a better identity test. It is to stop asking about identity: a trim is a
// removed span of the RAW RULER, and both lanes lie on that one ruler. A word — from the
// recording or from a voiceover — is removed if and only if the raw moment it occupies is.
//
// `keptRawSpans` is therefore lifted verbatim out of `projectRawTimelineSecToPlayback`,
// which now calls it, rather than reimplemented beside it. Agreement with playback is by
// construction; `programme-time.test.ts` holds the two to it on randomised fixtures.
//
// Storage does not change: a trim stays source-time anchored to a clip. This is the
// derived READING of those rows, computed on demand and never written back.

import type { AxcutClip, AxcutInsertRange, AxcutTrimRange } from "../schema";
import { sourceToTimelineSec } from "./inserted-time";
import { type Interval, subtractInterval } from "./intervals";
import { trimAppliesToClip } from "./trim-mapping";

/** A stretch of the raw ruler, in seconds. */
export interface RawSpan {
	startSec: number;
	endSec: number;
}

/** A stretch the film does not contain, and the trims that took it away. */
export interface RemovedRawSpan extends RawSpan {
	/**
	 * The trims covering this stretch — several when they overlap, and EMPTY for a gap
	 * between two clips, which is missing from the film without anything having removed
	 * it. Callers offering a restore affordance must key it on this being non-empty:
	 * there is no pill to click for a gap.
	 */
	trimIds: string[];
}

/**
 * The clip's own extent on the raw ruler.
 *
 * Source second `s` sits at `timelineStartSec + (s − sourceStartSec)`, so the extent runs
 * to the source length past the head. An UNPROBED clip (no real `sourceEndSec` yet) has no
 * source length to measure, and falls back to the ruler geometry it was given — matching
 * the pass-through branch `resolvePlaybackSegments` takes for the same clips.
 */
function clipRawExtent(clip: AxcutClip): RawSpan {
	const sourceEnd = clip.sourceEndSec ?? clip.sourceStartSec;
	if (sourceEnd <= clip.sourceStartSec) {
		return { startSec: clip.timelineStartSec, endSec: clip.timelineEndSec };
	}
	return {
		startSec: clip.timelineStartSec,
		endSec: clip.timelineStartSec + (sourceEnd - clip.sourceStartSec),
	};
}

/** Source interval → timeline, through the clip that carries it.
 *
 *  `"closes"` on the end is what makes an insertion INSIDE a kept stretch part of it: the
 *  film plays those seconds, so they belong to the span. An insertion at the stretch's own
 *  start belongs to whatever came before — and if a trim took that, it is gone with it,
 *  which is right: the moment it follows is not in the film any more. */
function sourceToRaw(
	clip: AxcutClip,
	interval: Interval,
	insertRanges: readonly AxcutInsertRange[],
): RawSpan {
	return {
		startSec: sourceToTimelineSec(clip, interval.startSec, insertRanges, "opens"),
		endSec: sourceToTimelineSec(clip, interval.endSec, insertRanges, "closes"),
	};
}

/** What survives the trims inside one clip, in source order. */
function keptSourceIntervals(clip: AxcutClip, trimRanges: AxcutTrimRange[]): Interval[] {
	const sourceEnd = clip.sourceEndSec ?? clip.sourceStartSec;
	if (sourceEnd <= clip.sourceStartSec) return [];
	let ivs: Interval[] = [{ startSec: clip.sourceStartSec, endSec: sourceEnd }];
	for (const trim of trimRanges) {
		if (!trimAppliesToClip(trim, clip)) continue;
		ivs = subtractInterval(ivs, { startSec: trim.startSec, endSec: trim.endSec });
	}
	return ivs;
}

/**
 * Every stretch of raw ruler the film actually contains, in PLAYBACK ORDER — clips by
 * `timelineStartSec`, and within a clip by source time.
 *
 * Not globally sorted, on purpose: `projectRawTimelineSecToPlayback` walks these with a
 * single output cursor, so the order has to be the order they play. Two clips that overlap
 * on the ruler (which the model does not produce, but nothing forbids) therefore come back
 * interleaved rather than merged, exactly as the projection has always treated them.
 *
 * Zero-length spans are dropped, so a caller can trust `endSec > startSec`.
 */
export function keptRawSpans(
	clips: AxcutClip[],
	trimRanges: AxcutTrimRange[],
	insertRanges: readonly AxcutInsertRange[] = [],
): RawSpan[] {
	const ordered = [...clips].sort((a, b) => a.timelineStartSec - b.timelineStartSec);
	const spans: RawSpan[] = [];
	for (const clip of ordered) {
		const sourceEnd = clip.sourceEndSec ?? clip.sourceStartSec;
		if (sourceEnd <= clip.sourceStartSec) {
			// Duration not probed yet — the whole raw clip passes through unnarrowed.
			const extent = clipRawExtent(clip);
			if (extent.endSec > extent.startSec) spans.push(extent);
			continue;
		}
		for (const iv of keptSourceIntervals(clip, trimRanges)) {
			const span = sourceToRaw(clip, iv, insertRanges);
			if (span.endSec > span.startSec) spans.push(span);
		}
	}
	return spans;
}

/**
 * The complement of {@link keptRawSpans} over `[0, lastClipRawEnd]`, sorted, each stretch
 * carrying the ids of the trims that took it.
 *
 * Two boundaries decide what this does and do not follow from the definition:
 *
 * It stops at the last CLIP's raw end, not the last KEPT span's. A trimmed tail of the
 * last clip is inside the programme's extent and so is genuinely removed; raw time PAST
 * every clip is not removed but simply unfilmed, because `projectRawTimelineSecToPlayback`
 * is the identity there. That is what lets a voiceover hang off the end of the programme
 * and keep playing, its words still reading kept, instead of being silently swallowed.
 *
 * Gaps count as removed, with no trim ids. Nothing plays there, so a word over a gap is
 * not in the film — but there is no trim to restore, and the pane must not offer one.
 */
export function removedRawSpans(
	clips: AxcutClip[],
	trimRanges: AxcutTrimRange[],
	insertRanges: readonly AxcutInsertRange[] = [],
): RemovedRawSpan[] {
	const ordered = [...clips].sort((a, b) => a.timelineStartSec - b.timelineStartSec);
	if (ordered.length === 0) return [];

	const removed: RemovedRawSpan[] = [];
	let cursor = 0; // raw end of the programme walked so far

	for (const clip of ordered) {
		const extent = clipRawExtent(clip);
		// The unfilmed stretch before this clip. `max` rather than a bare subtraction so
		// two clips overlapping on the ruler contribute no negative gap.
		if (extent.startSec > cursor) {
			removed.push({ startSec: cursor, endSec: extent.startSec, trimIds: [] });
		}
		cursor = Math.max(cursor, extent.endSec);

		if (extent.endSec <= extent.startSec) continue;
		const kept = keptSourceIntervals(clip, trimRanges);
		// An unprobed clip has no source interval to cut, and passes through whole.
		if (kept.length === 0 && (clip.sourceEndSec ?? clip.sourceStartSec) <= clip.sourceStartSec) {
			continue;
		}

		// The trims that reach this clip, in raw, so a removed piece can name them.
		const applicable = trimRanges
			.filter((trim) => trimAppliesToClip(trim, clip))
			.map((trim) => ({
				id: trim.id,
				...sourceToRaw(clip, { startSec: trim.startSec, endSec: trim.endSec }, insertRanges),
			}));

		let holeStart = extent.startSec;
		for (const iv of kept) {
			const span = sourceToRaw(clip, iv, insertRanges);
			if (span.startSec > holeStart) {
				removed.push(taggedHole(holeStart, span.startSec, applicable));
			}
			holeStart = Math.max(holeStart, span.endSec);
		}
		if (extent.endSec > holeStart) {
			removed.push(taggedHole(holeStart, extent.endSec, applicable));
		}
	}

	return removed.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
}

function taggedHole(
	startSec: number,
	endSec: number,
	applicable: Array<{ id: string; startSec: number; endSec: number }>,
): RemovedRawSpan {
	return {
		startSec,
		endSec,
		trimIds: applicable
			.filter((trim) => trim.endSec > startSec && trim.startSec < endSec)
			.map((trim) => trim.id),
	};
}

/**
 * The stretch removing `rawSec`, or null when the moment is in the film.
 *
 * Half-open: a moment exactly on a removed span's end belongs to what follows, so a word
 * whose centre lands on the far edge of a cut reads as kept.
 */
export function removalAt(removed: RemovedRawSpan[], rawSec: number): RemovedRawSpan | null {
	for (const span of removed) {
		if (rawSec < span.startSec) break; // sorted, so nothing later can contain it
		if (rawSec < span.endSec) return span;
	}
	return null;
}

/**
 * `[startSec, endSec]` with every removed stretch taken out — the pieces of a span that
 * survive into the film, in order.
 *
 * This is what turns one audio track into the several mix entries a cut underneath it
 * demands: a voiceover crossing a trim plays as two pieces, not as one take shortened at
 * the tail.
 */
export function subtractRemoved(
	startSec: number,
	endSec: number,
	removed: RemovedRawSpan[],
): RawSpan[] {
	if (endSec <= startSec) return [];
	let pieces: Interval[] = [{ startSec, endSec }];
	for (const span of removed) {
		if (span.startSec >= endSec) break; // sorted; nothing later overlaps
		if (span.endSec <= startSec) continue;
		pieces = subtractInterval(pieces, { startSec: span.startSec, endSec: span.endSec });
	}
	return pieces.filter((piece) => piece.endSec > piece.startSec);
}
