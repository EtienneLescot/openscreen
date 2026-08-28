// Raw-ruler → export-timeline mapping for audio layers.
//
// A layer's `startMs`/`endMs` are RAW ruler coordinates (the same space the
// pills and the playhead use). The exported MP4 is the ASSEMBLED timeline:
// trims removed, so its clock is shorter wherever a cut exists. Before a layer
// can be mixed into the exported file its span must be projected onto that
// assembled clock — the same projection `resolvePlaybackSegments` performs for
// the video itself.
//
// Speed regions are deliberately ignored here: a layer plays at 1× in the
// preview and in the mix, so under a speed region it will drift relative to
// the sped-up picture. Documented v1 limitation.

import { subtractInterval } from "@/lib/ai-edition/document/timeline";
import type { AxcutClip, AxcutTrimRange } from "@/lib/ai-edition/schema";
import { trimAppliesToClip } from "@/lib/ai-edition/timeline/trim-mapping";

export interface ExportMappingSegment {
	/** Span on the RAW ruler. */
	rawStart: number;
	rawEnd: number;
	/** Where that span lands on the assembled (exported) timeline. */
	exportStart: number;
}

/**
 * The kept spans of each clip, in timeline order, with both their raw-ruler
 * position and their position on the assembled timeline.
 */
export function buildExportTimelineMapping(
	clips: AxcutClip[],
	trimRanges: AxcutTrimRange[],
): ExportMappingSegment[] {
	const ordered = [...clips].sort((a, b) => a.timelineStartSec - b.timelineStartSec);
	const result: ExportMappingSegment[] = [];
	let exportCursor = 0;
	for (const clip of ordered) {
		const sourceEnd = clip.sourceEndSec ?? clip.sourceStartSec;
		// Unprobed clip: no real source window yet — pass its whole width through.
		if (sourceEnd <= clip.sourceStartSec) {
			result.push({
				rawStart: clip.timelineStartSec,
				rawEnd: clip.timelineEndSec,
				exportStart: exportCursor,
			});
			exportCursor += clip.timelineEndSec - clip.timelineStartSec;
			continue;
		}
		let kept = [{ startSec: clip.sourceStartSec, endSec: sourceEnd }];
		for (const trim of trimRanges) {
			if (!trimAppliesToClip(trim, clip)) continue;
			kept = subtractInterval(kept, { startSec: trim.startSec, endSec: trim.endSec });
		}
		for (const iv of kept) {
			const dur = iv.endSec - iv.startSec;
			if (dur <= 0) continue;
			result.push({
				rawStart: clip.timelineStartSec + (iv.startSec - clip.sourceStartSec),
				rawEnd: clip.timelineStartSec + (iv.endSec - clip.sourceStartSec),
				exportStart: exportCursor,
			});
			exportCursor += dur;
		}
	}
	return result;
}

/**
 * Project one RAW-ruler instant onto the assembled timeline. A point inside a
 * trim (no segment covers it) clamps to the boundary the video itself jumps
 * to: the start of the next kept segment, or the end of the previous one.
 */
export function rawToExportTime(rawSec: number, mapping: ExportMappingSegment[]): number {
	for (const seg of mapping) {
		if (rawSec >= seg.rawStart && rawSec < seg.rawEnd) {
			return seg.exportStart + (rawSec - seg.rawStart);
		}
	}
	// In a gap: find where the surrounding kept material sits.
	let after: ExportMappingSegment | null = null;
	let before: ExportMappingSegment | null = null;
	for (const seg of mapping) {
		if (seg.rawStart >= rawSec) {
			after = seg;
			break;
		}
		before = seg;
	}
	if (after) return after.exportStart;
	if (before) return before.exportStart + (before.rawEnd - before.rawStart);
	return rawSec;
}
