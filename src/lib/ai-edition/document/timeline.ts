// Ported from axcut/apps/server/src/lib/timeline.ts — pure interval math
// for the clip/trim model. No DOM, no IPC, no side effects. The caller
// (store, exporter, agent) feeds an AxcutDocument and gets back intervals
// or a new document with updated clips.

import type { AxcutClip, AxcutDocument, AxcutTranscript } from "../schema";
import { reprojectRegionsForReorder } from "../timeline/region-ventilation";
import { createId } from "./ids";

export function byStart(a: { startSec: number }, b: { startSec: number }): number {
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

// Lay clips back-to-back from t=0, preserving each clip's own length. Called
// after any structural change (insert / move / remove / trim) so the timeline
// never has gaps or overlaps between clips. Shared by useTimeline (UI) and
// the agent tool executor (main process) so both enforce the same invariant.
export function resequenceClips(clips: AxcutClip[]): AxcutClip[] {
	let cursor = 0;
	return clips.map((c) => {
		const timelineLen = c.timelineEndSec - c.timelineStartSec;
		const sourceLen = (c.sourceEndSec ?? 0) - c.sourceStartSec;
		const len = Math.max(0.001, timelineLen > 0 ? timelineLen : sourceLen);
		const next = { ...c, timelineStartSec: cursor, timelineEndSec: cursor + len };
		cursor += len;
		return next;
	});
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
	const trimRanges = invertIntervals(normalized, duration).map((cut, i) => ({
		id: `trim_${i + 1}`,
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
			trimRanges,
			gaps: [],
		},
		preview: {
			...document.preview,
			revision: document.preview.revision + 1,
		},
	};
}

// ponytail: reorder an existing clip by removing it from its current
// position and inserting at `insertIndex` (clamped to the array length).
// Used for "move this clip there" / "swap these clips" — preserves all
// user-placed clip ids, origins, and source ranges. Mirrors axcut's
// apps/server/src/lib/timeline.ts#moveClip.
export function moveClip(
	document: AxcutDocument,
	clipId: string,
	insertIndex: number,
	origin: "system" | "agent" | "user" = "user",
	reason: string = "",
): AxcutDocument {
	const index = document.timeline.clips.findIndex((c) => c.id === clipId);
	if (index < 0) {
		throw new Error(`Unknown clip ${clipId}.`);
	}
	const movingClip = {
		...document.timeline.clips[index],
		origin,
		reason: reason || document.timeline.clips[index].reason,
	};
	const remaining = document.timeline.clips.filter((c) => c.id !== clipId);
	const bounded = Math.max(0, Math.min(insertIndex, remaining.length));
	const reordered = [...remaining.slice(0, bounded), movingClip, ...remaining.slice(bounded)];
	const oldClips = document.timeline.clips;
	const newClips = resequenceClips(reordered);
	// Carry the user's timeline work (zoom/speed/annotation) along with the clip
	// it sits on, so reordering clips doesn't strand regions over unrelated
	// content. Regions are *ventilated*: a region straddling several clips is
	// split into one piece per clip (each following its clip), and pieces that
	// stay contiguous after the move are merged back. Trims need no shift — they
	// follow via their source anchor.
	const legacy = document.legacyEditor as Record<string, unknown> | null;
	const speedRegions = legacy?.speedRegions as
		| Array<{ id: string; startMs: number; endMs: number }>
		| undefined;
	return {
		...document,
		zoomRanges: reprojectRegionsForReorder(document.zoomRanges, oldClips, newClips, () =>
			createId("zoom"),
		) as AxcutDocument["zoomRanges"],
		annotations: reprojectRegionsForReorder(document.annotations, oldClips, newClips, () =>
			createId("ann"),
		) as AxcutDocument["annotations"],
		legacyEditor: speedRegions
			? {
					...legacy,
					speedRegions: reprojectRegionsForReorder(speedRegions, oldClips, newClips, () =>
						createId("speed"),
					),
				}
			: document.legacyEditor,
		timeline: {
			...document.timeline,
			clips: newClips,
		},
		preview: {
			...document.preview,
			revision: document.preview.revision + 1,
		},
	};
}

// ponytail: duplicate a clip (preserves the original). Used for "split this
// clip into two" or "make a copy". Mirrors axcut's
// apps/server/src/lib/timeline.ts#duplicateClip.
export function duplicateClip(
	document: AxcutDocument,
	clipId: string,
	origin: "system" | "agent" | "user" = "user",
	reason: string = "",
): AxcutDocument {
	const index = document.timeline.clips.findIndex((c) => c.id === clipId);
	if (index < 0) {
		throw new Error(`Unknown clip ${clipId}.`);
	}
	const original = document.timeline.clips[index];
	const copy = {
		...original,
		id: createId("clip"),
		origin,
		reason: reason || original.reason,
	};
	const next = [
		...document.timeline.clips.slice(0, index + 1),
		copy,
		...document.timeline.clips.slice(index + 1),
	];
	return {
		...document,
		timeline: {
			...document.timeline,
			clips: resequenceClips(next),
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
