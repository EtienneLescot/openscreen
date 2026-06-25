// Ported from axcut/apps/server/src/lib/timeline.ts — pure interval math for
// the clip/skip model. No DOM, no IPC, no side effects. The caller (store,
// exporter, agent) feeds an AxcutDocument and gets back intervals or a new
// document with updated clips.
//
// ponytail: only the ops Phase 1 needs (replaceTimeline, dropRange, restore).
// The full 11-op dispatcher lands in Phase 6 with the agent runtime.

import type { AxcutClip, AxcutDocument, AxcutTranscript } from "../schema";

function byStart(a: { startSec: number }, b: { startSec: number }): number {
	return a.startSec - b.startSec;
}

export interface Interval {
	startSec: number;
	endSec: number;
}

export function normalizeIntervals(durationSec: number, intervals: Interval[]): Interval[] {
	const bounded = intervals
		.map((item) => ({
			startSec: Math.max(0, Math.min(durationSec, item.startSec)),
			endSec: Math.max(0, Math.min(durationSec, item.endSec)),
		}))
		.filter((item) => item.endSec > item.startSec)
		.sort(byStart);

	const merged: Interval[] = [];
	for (const item of bounded) {
		const last = merged.at(-1);
		if (!last || item.startSec > last.endSec) {
			merged.push({ ...item });
			continue;
		}
		last.endSec = Math.max(last.endSec, item.endSec);
	}
	return merged;
}

export function primaryAssetDuration(document: AxcutDocument): number {
	const asset =
		document.assets.find((item) => item.id === document.project.primaryAssetId) ??
		document.assets[0];
	return asset?.durationSec ?? 0;
}

export function timelineIntervals(document: AxcutDocument): Interval[] {
	return normalizeIntervals(
		primaryAssetDuration(document),
		document.timeline.clips.map((clip) => ({
			startSec: clip.sourceStartSec,
			endSec: clip.sourceEndSec ?? primaryAssetDuration(document),
		})),
	);
}

export function buildTimelineFromIntervals(
	assetId: string,
	intervals: Interval[],
	options: {
		origin: "system" | "agent" | "user";
		reason: string;
		transcript: AxcutTranscript | null;
	},
): AxcutClip[] {
	let cursor = 0;
	return intervals.map((interval, index) => {
		const duration = interval.endSec - interval.startSec;
		const timelineStartSec = cursor;
		const timelineEndSec = cursor + duration;
		cursor = timelineEndSec;
		return {
			id: `clip_${index + 1}`,
			assetId,
			sourceStartSec: interval.startSec,
			sourceEndSec: interval.endSec,
			timelineStartSec,
			timelineEndSec,
			wordRefs: collectWordRefs(options.transcript, interval.startSec, interval.endSec),
			origin: options.origin,
			reason: options.reason,
		};
	});
}

function collectWordRefs(
	transcript: AxcutTranscript | null,
	startSec: number,
	endSec: number,
): string[] {
	if (!transcript) return [];
	return transcript.words
		.filter((word) => word.endSec > startSec && word.startSec < endSec)
		.map((word) => word.id);
}

export function subtractInterval(intervals: Interval[], cut: Interval): Interval[] {
	const output: Interval[] = [];
	for (const interval of intervals) {
		if (cut.endSec <= interval.startSec || cut.startSec >= interval.endSec) {
			output.push(interval);
			continue;
		}
		if (cut.startSec > interval.startSec) {
			output.push({ startSec: interval.startSec, endSec: cut.startSec });
		}
		if (cut.endSec < interval.endSec) {
			output.push({ startSec: cut.endSec, endSec: interval.endSec });
		}
	}
	return output;
}

export function invertIntervals(intervals: Interval[], durationSec: number): Interval[] {
	const cuts: Interval[] = [];
	let cursor = 0;
	for (const interval of normalizeIntervals(durationSec, intervals)) {
		if (interval.startSec > cursor) {
			cuts.push({ startSec: cursor, endSec: interval.startSec });
		}
		cursor = Math.max(cursor, interval.endSec);
	}
	if (cursor < durationSec) {
		cuts.push({ startSec: cursor, endSec: durationSec });
	}
	return cuts;
}

export function replaceTimeline(
	document: AxcutDocument,
	intervals: Interval[],
	reason: string,
	origin: "system" | "agent" | "user" = "user",
): AxcutDocument {
	const assetId = document.project.primaryAssetId ?? document.assets[0]?.id;
	if (!assetId) {
		throw new Error("Cannot update timeline without a primary asset.");
	}
	const duration = primaryAssetDuration(document);
	const normalized = normalizeIntervals(duration, intervals);
	const clips = buildTimelineFromIntervals(assetId, normalized, {
		origin,
		reason,
		transcript: document.transcript,
	});
	const skipRanges = invertIntervals(normalized, duration).map((cut, i) => ({
		id: `skip_${i + 1}`,
		assetId,
		startSec: cut.startSec,
		endSec: cut.endSec,
		origin,
		reason,
	}));
	return {
		...document,
		timeline: {
			...document.timeline,
			clips,
			skipRanges,
			gaps: [],
		},
		preview: {
			...document.preview,
			revision: document.preview.revision + 1,
		},
	};
}

export function restoreFullTimeline(document: AxcutDocument): AxcutDocument {
	const duration = primaryAssetDuration(document);
	if (duration <= 0) return document;
	return replaceTimeline(document, [{ startSec: 0, endSec: duration }], "Restore full timeline");
}
