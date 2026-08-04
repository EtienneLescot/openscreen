import type { SpeedRegion, TrimRegion } from "@/components/video-editor/types";

export interface TimelineSegment {
	startSec: number;
	endSec: number;
}

export interface SpeedTimelineSegment extends TimelineSegment {
	/** Playback speed multiplier for this span (1 = unchanged). */
	speed: number;
}

// Sub-segments shorter than this (in seconds) are dropped after speed splitting so
// zero-width slivers at region boundaries never reach the decoder/encoder.
const MIN_SEGMENT_SEC = 0.0001;

/**
 * Converts trim regions into the source-time spans that should be kept, in order.
 * Returns a single full-duration segment when no trim regions are present.
 *
 * Shared by the video decoder and the offline audio renderer so both derive the
 * exact same output timeline (any divergence would desync audio from video).
 */
export function computeKeepSegments(
	totalDuration: number,
	trimRegions?: TrimRegion[],
): TimelineSegment[] {
	if (!trimRegions || trimRegions.length === 0) {
		return [{ startSec: 0, endSec: totalDuration }];
	}

	const sorted = [...trimRegions].sort((a, b) => a.startMs - b.startMs);
	const segments: TimelineSegment[] = [];
	let cursor = 0;

	for (const trim of sorted) {
		const trimStart = trim.startMs / 1000;
		const trimEnd = trim.endMs / 1000;
		if (cursor < trimStart) {
			segments.push({ startSec: cursor, endSec: trimStart });
		}
		// Keep the cursor monotonic: a nested/overlapping trim (sorted only by start)
		// whose end is before the cursor must not move it backward and re-emit source
		// that an earlier trim already removed.
		cursor = Math.max(cursor, trimEnd);
	}

	if (cursor < totalDuration) {
		segments.push({ startSec: cursor, endSec: totalDuration });
	}

	return segments;
}

/**
 * Splits keep-segments by overlapping speed regions, annotating each sub-segment
 * with its playback speed multiplier (defaults to 1×).
 *
 * Overlapping regions are handled rather than assumed away: the earliest-starting
 * one keeps the stretch it already covers, and a later region contributes only the
 * part past the cursor (nothing at all when it is fully covered). Output is always
 * disjoint and ascending — `decodeAll` walks it with a forward-only frame cursor,
 * so an overlap would otherwise duplicate source and seek backwards. Same rule as
 * the native path's `speed_segments_for_window` in `crates/compositor/src/regions.rs`.
 */
export function splitBySpeed(
	segments: TimelineSegment[],
	speedRegions?: SpeedRegion[],
): SpeedTimelineSegment[] {
	if (!speedRegions || speedRegions.length === 0) {
		return segments.map((s) => ({ ...s, speed: 1 }));
	}

	const result: SpeedTimelineSegment[] = [];
	for (const segment of segments) {
		const overlapping = speedRegions
			.filter((sr) => sr.startMs / 1000 < segment.endSec && sr.endMs / 1000 > segment.startSec)
			.sort((a, b) => a.startMs - b.startMs);

		if (overlapping.length === 0) {
			result.push({ ...segment, speed: 1 });
			continue;
		}

		let cursor = segment.startSec;
		for (const sr of overlapping) {
			const srStart = Math.max(sr.startMs / 1000, segment.startSec);
			const srEnd = Math.min(sr.endMs / 1000, segment.endSec);
			if (srEnd <= cursor) continue;
			const effectiveStart = Math.max(srStart, cursor);
			if (cursor < effectiveStart)
				result.push({ startSec: cursor, endSec: effectiveStart, speed: 1 });
			result.push({ startSec: effectiveStart, endSec: srEnd, speed: sr.speed });
			cursor = srEnd;
		}
		if (cursor < segment.endSec)
			result.push({ startSec: cursor, endSec: segment.endSec, speed: 1 });
	}
	return result.filter((s) => s.endSec - s.startSec > MIN_SEGMENT_SEC);
}

/** Convenience: trim then speed-split in one call. */
export function buildSpeedSegments(
	totalDuration: number,
	trimRegions?: TrimRegion[],
	speedRegions?: SpeedRegion[],
): SpeedTimelineSegment[] {
	return splitBySpeed(computeKeepSegments(totalDuration, trimRegions), speedRegions);
}

/** Largest speed multiplier across the timeline's speed regions (1 when none apply). */
export function maxTimelineSpeed(segments: SpeedTimelineSegment[]): number {
	return segments.reduce((max, seg) => Math.max(max, seg.speed), 1);
}
