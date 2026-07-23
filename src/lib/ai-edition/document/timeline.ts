// Ported from axcut/apps/server/src/lib/timeline.ts — pure interval math
// for the clip/trim model. No DOM, no IPC, no side effects. The caller
// (store, exporter, agent) feeds an AxcutDocument and gets back intervals
// or a new document with updated clips.

import type { AxcutClip, AxcutDocument, AxcutTranscript, AxcutTrimRange } from "../schema";
import { anchoredToRawSpanSec, anchorRegionsWithDerivedMs } from "../timeline/timelineMap";
import { createId } from "./ids";

/** Length a clip is given before its media has been probed. Lives here, in the pure
 *  document layer, because that layer decides which clips are still waiting for a real
 *  duration (`applyProbedDuration`); the store re-exports it for its own callers. */
export const PLACEHOLDER_DURATION_SEC = 60;

export function byStart(a: { startSec: number }, b: { startSec: number }): number {
	return a.startSec - b.startSec;
}

/** A region is anchored once it states WHERE IN THE SOURCE it lives. Anything missing
 *  a part of `{clipId, sourceStartSec, sourceEndSec}` still relies on its RAW ms.
 *  One definition, so "is this anchored?" can never be asked two different ways. */
function isAnchored<T extends { clipId?: string; sourceStartSec?: number; sourceEndSec?: number }>(
	region: T,
): region is T & { clipId: string; sourceStartSec: number; sourceEndSec: number } {
	return (
		!!region.clipId && region.sourceStartSec !== undefined && region.sourceEndSec !== undefined
	);
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

/**
 * Derived, ephemeral clip list for playback/native/export — never written back to
 * `document.timeline.clips`. Each clip's own `[sourceStartSec, sourceEndSec]` (its media
 * in/out, edited via the clip's own modal) is untouched as a concept; this only narrows the
 * WINDOW of it handed to playback for the trimmed stretch(es), via `subtractInterval`
 * (existing, tested — no new interval math). Trims are stored per-asset in source time
 * (`AxcutTrimRange`) and may already be ventilated into multiple entries by
 * `ventilateTimelineSpanToTrims` when the user drags one across a clip boundary — subtracting
 * by matching `assetId` against every clip naturally narrows however many clips that produces,
 * no special-casing. Everything else about the clip (id, assetId, webcam pairing/offset via
 * the asset, origin/reason) carries through unchanged, which is what makes this apply to the
 * webcam for free: webcam sync is derived from the clip's own asset, not recomputed here.
 */
export function resolvePlaybackSegments(
	clips: AxcutClip[],
	trimRanges: AxcutTrimRange[],
): AxcutClip[] {
	const ordered = [...clips].sort((a, b) => a.timelineStartSec - b.timelineStartSec);
	const result: AxcutClip[] = [];
	let timelineCursor = 0;
	for (const clip of ordered) {
		const sourceEnd = clip.sourceEndSec ?? clip.sourceStartSec;
		if (sourceEnd <= clip.sourceStartSec) {
			// Duration not probed yet — pass through as a single segment, unchanged.
			const dur = clip.timelineEndSec - clip.timelineStartSec;
			result.push({
				...clip,
				timelineStartSec: timelineCursor,
				timelineEndSec: timelineCursor + dur,
			});
			timelineCursor += dur;
			continue;
		}
		let kept: Interval[] = [{ startSec: clip.sourceStartSec, endSec: sourceEnd }];
		for (const trim of trimRanges) {
			if (trim.assetId !== clip.assetId) continue;
			kept = subtractInterval(kept, { startSec: trim.startSec, endSec: trim.endSec });
		}
		kept.forEach((iv, i) => {
			const dur = iv.endSec - iv.startSec;
			if (dur <= 0) return;
			result.push({
				...clip,
				id: kept.length === 1 ? clip.id : `${clip.id}_seg${i + 1}`,
				sourceStartSec: iv.startSec,
				sourceEndSec: iv.endSec,
				timelineStartSec: timelineCursor,
				timelineEndSec: timelineCursor + dur,
			});
			timelineCursor += dur;
		});
	}
	return result;
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

/** Shape every stored modifier shares during the v5 transition: the clip anchor is
 *  the source of truth, `startMs`/`endMs` a derived cache. Anchor fields are optional
 *  because a not-yet-migrated region (see `anchorRegionsWithDerivedMs`) has none. */
type StoredRegion = {
	id: string;
	startMs: number;
	endMs: number;
	clipId?: string;
	sourceStartSec?: number;
	sourceEndSec?: number;
};

/** Apply `fn` to all four modifier collections (document-level + legacyEditor envelopes). */
function mapAllRegionCollections(
	document: AxcutDocument,
	fn: (regions: StoredRegion[], prefix: string) => StoredRegion[],
): AxcutDocument {
	const legacy = document.legacyEditor as Record<string, unknown> | null;
	const speedRegions = legacy?.speedRegions as StoredRegion[] | undefined;
	const cameraFullscreenRegions = legacy?.cameraFullscreenRegions as StoredRegion[] | undefined;

	return {
		...document,
		zoomRanges: fn(
			document.zoomRanges as unknown as StoredRegion[],
			"zoom",
		) as unknown as AxcutDocument["zoomRanges"],
		annotations: fn(
			document.annotations as unknown as StoredRegion[],
			"ann",
		) as unknown as AxcutDocument["annotations"],
		legacyEditor:
			legacy && (speedRegions || cameraFullscreenRegions)
				? {
						...legacy,
						...(speedRegions ? { speedRegions: fn(speedRegions, "speed") } : {}),
						...(cameraFullscreenRegions
							? { cameraFullscreenRegions: fn(cameraFullscreenRegions, "camfull") }
							: {}),
					}
				: document.legacyEditor,
	};
}

/**
 * Re-derive the transition `startMs`/`endMs` cache of every clip-anchored modifier
 * from its anchor + the given clip layout.
 *
 * Structural ops that PRESERVE clip identity (move / duplicate / trim) leave the
 * anchors valid — a fragment travels with its clip by `clipId` — so nothing is
 * reprojected; only the derived cache moves. That is what let the old
 * `reprojectDocumentRegions` / `reprojectRegionsForReorder` machinery go away.
 * A fragment whose anchor clip no longer exists is dropped (its content is gone, and
 * the display coalescer drops it too). Not-yet-anchored regions pass through
 * untouched. Guards the empty-clip case so a transient wipe can't delete everything.
 */
export function rederiveRegionMs(document: AxcutDocument, clips: AxcutClip[]): AxcutDocument {
	if (clips.length === 0) return document;
	return mapAllRegionCollections(document, (regions) =>
		regions.flatMap((region) => {
			if (!isAnchored(region)) {
				return [region];
			}
			const span = anchoredToRawSpanSec(
				{
					clipId: region.clipId,
					sourceStartSec: region.sourceStartSec,
					sourceEndSec: region.sourceEndSec,
				},
				clips,
			);
			if (!span) return [];
			return [
				{
					...region,
					startMs: Math.round(span.startSec * 1000),
					endMs: Math.round(span.endSec * 1000),
				},
			];
		}),
	);
}

/**
 * Re-anchor every modifier against a REBUILT clip layout. `replaceTimeline` mints
 * brand-new clip identities, so existing anchors point at clips that no longer exist;
 * we re-ventilate each region from its current RAW ms (which still describe where it
 * sits on the ruler) and rebuild the anchor. Fragments of one region need no shared
 * marker to keep reading as a single pill: equal properties + adjacency suffice.
 */
export function reanchorRegions(document: AxcutDocument, clips: AxcutClip[]): AxcutDocument {
	if (clips.length === 0) return document;
	return mapAllRegionCollections(
		document,
		(regions, prefix) =>
			anchorRegionsWithDerivedMs(regions, clips, () => createId(prefix)) as StoredRegion[],
	);
}

/** A clip that does not yet describe a real stretch of media: either it carries no
 *  source extent at all (what `migrateProjectDataToAxcutDocument` produces — the
 *  migration is pure, so it cannot probe the file for a duration), or it still sits at
 *  the pre-probe placeholder length. Both mean "waiting for the real duration". */
function clipAwaitsProbedDuration(clip: AxcutClip, assetId: string): boolean {
	if (clip.assetId !== assetId || clip.sourceStartSec !== 0) return false;
	const end = clip.sourceEndSec ?? 0;
	if (end <= clip.sourceStartSec) return true; // no extent at all (v2 migration)
	return Math.abs(end - PLACEHOLDER_DURATION_SEC) < 0.01; // still the placeholder
}

/**
 * Apply a freshly probed media duration to the clips still waiting for it, and bring
 * the modifiers along.
 *
 * This is the moment a project imported from the legacy (v1.7 / `PROJECT_VERSION` 2)
 * format becomes fully described. That format has no clip list at all — one recording
 * plus regions — so migration mints a single clip with NO source extent and leaves
 * every region UNANCHORED (anchoring needs a clip with real extent; dropping the
 * regions instead would lose user data). The duration only shows up later, when the
 * renderer loads the media. Without this step the clip keeps a zero extent forever and
 * the regions never get anchored.
 *
 * Regions are handled by provenance, never wholesale: already-anchored ones only get
 * their derived ms refreshed against the new layout (`rederiveRegionMs`), while
 * unanchored ones are anchored from the RAW ms they still carry. Re-anchoring
 * everything would mint fresh fragment ids for regions whose anchors are already
 * correct.
 *
 * Returns the document unchanged when no clip is waiting, so callers can invoke it on
 * every `loadedmetadata` without guarding.
 */
export function applyProbedDuration(
	document: AxcutDocument,
	assetId: string,
	durationSec: number,
): AxcutDocument {
	if (!Number.isFinite(durationSec) || durationSec <= 0) return document;
	const clips = document.timeline.clips;
	if (!clips.some((clip) => clipAwaitsProbedDuration(clip, assetId))) return document;

	// Widening a clip pushes everything after it down the ruler by the same delta.
	let shiftSec = 0;
	const nextClips = clips.map((clip) => {
		const shifted = {
			...clip,
			timelineStartSec: clip.timelineStartSec + shiftSec,
			timelineEndSec: clip.timelineEndSec + shiftSec,
		};
		if (!clipAwaitsProbedDuration(clip, assetId)) return shifted;
		const previousLength = clip.timelineEndSec - clip.timelineStartSec;
		shiftSec += durationSec - previousLength;
		return {
			...shifted,
			sourceEndSec: clip.sourceStartSec + durationSec,
			timelineEndSec: shifted.timelineStartSec + durationSec,
		};
	});

	const withClips: AxcutDocument = {
		...document,
		assets: document.assets.map((asset) =>
			asset.id === assetId && asset.durationSec == null
				? { ...asset, durationSec: durationSec }
				: asset,
		),
		timeline: { ...document.timeline, clips: nextClips },
	};

	// Anchored regions: refresh the derived cache against the new layout.
	const refreshed = rederiveRegionMs(withClips, nextClips);
	// Unanchored regions: NOW anchorable — the clip finally has a real extent. Anchored
	// one at a time so a region that ventilates into several fragments lands in place,
	// and so an already-correct anchor is never re-minted.
	return mapAllRegionCollections(refreshed, (regions, prefix) =>
		regions.flatMap((region) =>
			isAnchored(region)
				? [region]
				: (anchorRegionsWithDerivedMs([region], nextClips, () =>
						createId(prefix),
					) as StoredRegion[]),
		),
	);
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
	const next: AxcutDocument = {
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
	return reanchorRegions(next, clips);
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
	const newClips = resequenceClips(reordered);
	const next: AxcutDocument = {
		...document,
		timeline: {
			...document.timeline,
			clips: newClips,
		},
		preview: {
			...document.preview,
			revision: document.preview.revision + 1,
		},
	};
	return rederiveRegionMs(next, newClips);
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
	const oldClips = document.timeline.clips;
	const next = [...oldClips.slice(0, index + 1), copy, ...oldClips.slice(index + 1)];
	const newClips = resequenceClips(next);
	const updatedDoc: AxcutDocument = {
		...document,
		timeline: {
			...document.timeline,
			clips: newClips,
		},
		preview: {
			...document.preview,
			revision: document.preview.revision + 1,
		},
	};
	return rederiveRegionMs(updatedDoc, newClips);
}

export function restoreFullTimeline(document: AxcutDocument): AxcutDocument {
	const duration = primaryAssetDuration(document);
	if (duration <= 0) return document;
	return replaceTimeline(document, [{ startSec: 0, endSec: duration }], "Restore full timeline");
}
