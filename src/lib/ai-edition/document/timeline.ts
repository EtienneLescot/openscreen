// Ported from axcut/apps/server/src/lib/timeline.ts — pure interval math
// for the clip/trim model. No DOM, no IPC, no side effects. The caller
// (store, exporter, agent) feeds an AxcutDocument and gets back intervals
// or a new document with updated clips.

import type { AxcutClip, AxcutDocument, AxcutTranscript, AxcutTrimRange } from "../schema";
import {
	anchoredToRawSpanSec,
	anchorRegionsWithDerivedMs,
	dropPillById,
	hasCompleteClipAnchor,
} from "../timeline/timelineMap";
import { dropTrimPillsByIds, trimAppliesToClip } from "../timeline/trim-mapping";
import { createId } from "./ids";

/** The region families a delete can target by id. Shared with the store so "which kinds
 *  exist" has exactly one definition. `trim` is a source-time cut; the rest are pill-merged
 *  effects (zoom / speed / annotation / camera-fullscreen). Clips are removed via
 *  {@link removeClip}, not here — deleting a clip reflows the whole timeline. */
export type RegionKind = "zoom" | "trim" | "annotation" | "speed" | "cameraFullscreen";

/** Length a clip is given before its media has been probed. Lives here, in the pure
 *  document layer, because that layer decides which clips are still waiting for a real
 *  duration (`applyProbedDuration`); the store re-exports it for its own callers. */
export const PLACEHOLDER_DURATION_SEC = 60;

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

/**
 * Derived, ephemeral clip list for playback/native/export — never written back to
 * `document.timeline.clips`. Each clip's own `[sourceStartSec, sourceEndSec]` (its media
 * in/out, edited via the clip's own modal) is untouched as a concept; this only narrows the
 * WINDOW of it handed to playback for the trimmed stretch(es), via `subtractInterval`
 * (existing, tested — no new interval math). Trims are stored in source time, anchored to
 * a clip (`AxcutTrimRange`), and may already be ventilated into multiple entries by
 * `ventilateTimelineSpanToTrims` when the user drags one across a clip boundary — subtracting
 * per matching clip naturally narrows however many clips that produces, no special-casing.
 * Matching goes through `trimAppliesToClip`, so a cut authored on the second of two clips
 * over the same media narrows only that clip; matching on `assetId` alone removed the span
 * from BOTH, which is the same wrong-clip class the ruler and the transcript pane had.
 * Everything else about the clip (id, assetId, webcam pairing/offset via the asset,
 * origin/reason) carries through unchanged, which is what makes this apply to the webcam for
 * free: webcam sync is derived from the clip's own asset, not recomputed here.
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
			if (!trimAppliesToClip(trim, clip)) continue;
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
	// The envelope is `z.object({}).passthrough()`, so zod validates NOTHING inside it: a
	// project file whose `speedRegions` is a string loads clean and only detonates here, on
	// the first clip edit (`regions.filter is not a function` — #356). Guard exactly as
	// `upgradeV4DocumentToV5` already does, and for the same reason: a non-array is not a
	// collection we can walk. Treating it as absent leaves it in place via the `...legacy`
	// spread below, so the rest of the document still edits normally and nothing the user
	// had is thrown away on our way past it.
	const speedRegions = Array.isArray(legacy?.speedRegions)
		? (legacy?.speedRegions as StoredRegion[])
		: undefined;
	const cameraFullscreenRegions = Array.isArray(legacy?.cameraFullscreenRegions)
		? (legacy?.cameraFullscreenRegions as StoredRegion[])
		: undefined;

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

/** A clamped fragment this short has no surviving content — treat it as fully
 *  trimmed away and drop it (also absorbs boundary rounding). Matches the coalescer's
 *  touch epsilon (`coalesceByIdentity`). */
const REGION_WINDOW_EPSILON_SEC = 0.001;

/**
 * Reconcile every clip-anchored modifier with the given clip layout: clamp each
 * fragment to its clip's CURRENT kept source window, drop the ones with nothing left,
 * and refresh the transition `startMs`/`endMs` cache from the (possibly clamped) anchor.
 *
 * Structural ops that PRESERVE a clip's source window (move / duplicate / reorder) leave
 * the anchors inside their window, so the clamp is a no-op and only the derived cache
 * moves — that is what let the old `reprojectDocumentRegions` / `reprojectRegionsForReorder`
 * machinery go away. A source-range EDIT (the clip's Edit modal / the agent's
 * `update_clip_range`) narrows the window: a fragment now beyond it has lost its content,
 * so it is shortened to the surviving overlap or dropped when it falls entirely outside —
 * the same intersection the export/native path (`projectRegionsToSource`) already applies,
 * now folded in here so the STORED document and the timeline pills match it and no façade
 * can forget it. A fragment whose anchor clip no longer exists is dropped (content gone).
 * A not-yet-probed clip (no real source window) is left un-clamped so a transient
 * zero-width window can't nuke its fragments. Not-yet-anchored regions pass through
 * untouched; the empty-clip case is guarded so a transient wipe can't delete everything.
 */
export function rederiveRegionMs(document: AxcutDocument, clips: AxcutClip[]): AxcutDocument {
	if (clips.length === 0) return document;
	const clipById = new Map(clips.map((c) => [c.id, c]));
	return mapAllRegionCollections(document, (regions) =>
		regions.flatMap((region) => {
			if (!hasCompleteClipAnchor(region)) {
				return [region];
			}
			const clip = clipById.get(region.clipId);
			if (!clip) return [];
			return rederiveAnchoredRegion(region, clip, clips);
		}),
	);
}

/** One region's share of {@link rederiveRegionMs}: clamp it to its clip's current
 *  source window, drop it when nothing survives, refresh its derived ms. Extracted
 *  so `replaceTimeline` can apply it to the regions whose clip SURVIVED while
 *  re-anchoring only the orphans — a rebuild used to re-anchor everything, which
 *  moved anchored regions onto whatever content had slid under their ruler
 *  position. Same body as before, one region at a time. */
function rederiveAnchoredRegion<
	T extends StoredRegion & { clipId: string; sourceStartSec: number; sourceEndSec: number },
>(region: T, clip: AxcutClip, clips: AxcutClip[]): T[] {
	let { sourceStartSec, sourceEndSec } = region;
	// Only clamp against a real, probed window — an unprobed clip has
	// `sourceEndSec` at/below `sourceStartSec` and must not shave its fragments.
	if (clip.sourceEndSec !== undefined && clip.sourceEndSec > clip.sourceStartSec) {
		sourceStartSec = Math.max(sourceStartSec, clip.sourceStartSec);
		sourceEndSec = Math.min(sourceEndSec, clip.sourceEndSec);
		if (sourceEndSec - sourceStartSec <= REGION_WINDOW_EPSILON_SEC) return [];
	}
	const span = anchoredToRawSpanSec({ clipId: region.clipId, sourceStartSec, sourceEndSec }, clips);
	if (!span) return [];
	return [
		{
			...region,
			sourceStartSec,
			sourceEndSec,
			startMs: Math.round(span.startSec * 1000),
			endMs: Math.round(span.endSec * 1000),
		},
	];
}

// ponytail: `reanchorRegions` used to live here — re-ventilate EVERY modifier
// from its RAW ruler ms after a rebuild, on the premise that `replaceTimeline`
// minted brand-new clip identities so no anchor could survive. It no longer
// does, and the premise was the bug: a region's ruler position is where it is
// DRAWN, its anchor is what it is ABOUT, and re-deriving the second from the
// first moves it onto whatever footage slid underneath (measured: a zoom on
// source 40–45 came back on 45–50). What is left of it is the orphan branch of
// `reconcileRegionsAfterReplace`, which is the only case where the ruler really
// is the last thing we know. Deleted rather than left exported: a dead helper
// that does the wrong thing is an invitation.

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
			hasCompleteClipAnchor(region)
				? [region]
				: (anchorRegionsWithDerivedMs([region], nextClips, () =>
						createId(prefix),
					) as StoredRegion[]),
		),
	);
}

/** One interval of a rebuilt timeline, plus the identity it inherits. `keepClipId`
 *  is set when the CALLER'S raw interval is (to the epsilon) an existing clip's own
 *  source window: the same stretch of media, so the same clip. */
export interface TimelineReplacementSlot {
	interval: Interval;
	keepClipId: string | null;
}

/**
 * What a {@link replaceTimeline} would cost, computed before anything is applied.
 *
 * ponytail: this exists because `replaceTimeline` is the one tool an agent
 * reaches for when it cannot find a better one, and until now it answered
 * `ok: true` to requests it had silently mangled. Three mechanisms, all of them
 * invisible from the outside:
 *   • `normalizeIntervals` SORTS, so a reorder request ([30-60], [0-30]) comes
 *     back in ascending order and the swap simply does not happen;
 *   • it also MERGES adjacent intervals, so handing back the timeline's own
 *     intervals collapsed two clips into one — the identity call was destructive;
 *   • the complement replaced `trimRanges` wholesale, so a cut the user made
 *     inside a kept interval disappeared with no mention anywhere.
 * The plan names each of those so the caller can refuse with something the model
 * can act on. It is computed on the RAW intervals, because that is the last point
 * at which the caller's INTENT (the order they asked for) is still legible.
 */
export interface TimelineReplacementPlan {
	assetId: string;
	/** The intervals the rebuild would produce, in timeline order. */
	slots: TimelineReplacementSlot[];
	/** The raw intervals were not in ascending order: the caller meant to
	 *  REORDER. This operation cannot — see {@link moveClip}. */
	reorderRequested: boolean;
	/** Clips that would cease to exist: merged with a neighbour, shortened,
	 *  dropped, or belonging to another asset (a rebuild only lays out the
	 *  primary one). */
	lostClipIds: string[];
	/** Trims whose id would disappear because the span they cut now falls
	 *  entirely outside the kept intervals. The CUT survives — that stretch is
	 *  excluded anyway — only the id and its reason are lost. */
	absorbedTrimIds: string[];
	/** Trims that would be narrowed to their surviving overlap. */
	clippedTrimIds: string[];
	/** Modifiers anchored to a clip in `lostClipIds`. They are re-ventilated from
	 *  their RULER position, which is not the same as their content: they land on
	 *  whatever footage moved under them. */
	slidRegionIds: string[];
}

function intervalsIntersect(a: Interval, b: Interval): Interval | null {
	const startSec = Math.max(a.startSec, b.startSec);
	const endSec = Math.min(a.endSec, b.endSec);
	return endSec - startSec > REGION_WINDOW_EPSILON_SEC ? { startSec, endSec } : null;
}

function sameInterval(a: Interval, b: Interval): boolean {
	return (
		Math.abs(a.startSec - b.startSec) <= REGION_WINDOW_EPSILON_SEC &&
		Math.abs(a.endSec - b.endSec) <= REGION_WINDOW_EPSILON_SEC
	);
}

/** Every anchored modifier of the document, all four families, as `{id, clipId}`. */
function anchoredRegionsOf(document: AxcutDocument): Array<{ id: string; clipId: string }> {
	const legacy = document.legacyEditor as Record<string, unknown> | null;
	const collections: StoredRegion[][] = [
		document.zoomRanges as unknown as StoredRegion[],
		document.annotations as unknown as StoredRegion[],
		(legacy?.speedRegions as StoredRegion[] | undefined) ?? [],
		(legacy?.cameraFullscreenRegions as StoredRegion[] | undefined) ?? [],
	];
	return collections
		.flat()
		.filter(hasCompleteClipAnchor)
		.map((region) => ({ id: region.id, clipId: region.clipId }));
}

export function planTimelineReplacement(
	document: AxcutDocument,
	intervals: Interval[],
): TimelineReplacementPlan {
	const assetId = document.project.primaryAssetId ?? document.assets[0]?.id ?? "";
	const duration = primaryAssetDuration(document);
	const bounded = intervals
		.map((item) => ({
			startSec: Math.max(0, Math.min(duration, item.startSec)),
			endSec: Math.max(0, Math.min(duration, item.endSec)),
		}))
		.filter((item) => item.endSec > item.startSec);

	// Read the intent BEFORE sorting: after `byStart` there is nothing left to see.
	const reorderRequested = bounded.some(
		(item, index) => index > 0 && item.startSec < bounded[index - 1].startSec,
	);

	const clips = document.timeline.clips;
	const claimed = new Set<string>();
	const matchClip = (interval: Interval): string | null => {
		const hit = clips.find(
			(clip) =>
				!claimed.has(clip.id) &&
				clip.assetId === assetId &&
				clip.sourceEndSec !== undefined &&
				sameInterval({ startSec: clip.sourceStartSec, endSec: clip.sourceEndSec }, interval),
		);
		if (!hit) return null;
		claimed.add(hit.id);
		return hit.id;
	};

	const slots: TimelineReplacementSlot[] = [];
	for (const interval of [...bounded].sort(byStart)) {
		const keepClipId = matchClip(interval);
		const last = slots.at(-1);
		const overlaps = last
			? interval.startSec < last.interval.endSec - REGION_WINDOW_EPSILON_SEC
			: false;
		const touches = last
			? Math.abs(interval.startSec - last.interval.endSec) <= REGION_WINDOW_EPSILON_SEC
			: false;
		// Overlapping intervals MUST merge — clips may not overlap. Merely ADJACENT
		// ones merge only when neither side is a clip we could keep, which is the
		// one place this differs from `normalizeIntervals`: merging [0,30] and
		// [30,60] when both name an existing clip is precisely how the identity
		// rebuild destroyed a two-clip timeline.
		if (last && (overlaps || (touches && !last.keepClipId && !keepClipId))) {
			last.interval = {
				startSec: last.interval.startSec,
				endSec: Math.max(last.interval.endSec, interval.endSec),
			};
			if (overlaps) last.keepClipId = null;
			continue;
		}
		slots.push({ interval: { ...interval }, keepClipId });
	}

	const kept = new Set(slots.map((slot) => slot.keepClipId).filter((id): id is string => !!id));
	const lostClipIds = clips.filter((clip) => !kept.has(clip.id)).map((clip) => clip.id);
	const slidRegionIds = anchoredRegionsOf(document)
		.filter((region) => !kept.has(region.clipId))
		.map((region) => region.id);

	const keptIntervals = slots.map((slot) => slot.interval);
	const absorbedTrimIds: string[] = [];
	const clippedTrimIds: string[] = [];
	for (const trim of document.timeline.trimRanges) {
		if (trim.assetId !== assetId) continue;
		const pieces = keptIntervals
			.map((slot) => intervalsIntersect(slot, { startSec: trim.startSec, endSec: trim.endSec }))
			.filter((piece): piece is Interval => piece !== null);
		if (pieces.length === 0) absorbedTrimIds.push(trim.id);
		else if (pieces.length > 1 || !sameInterval(pieces[0], trim)) clippedTrimIds.push(trim.id);
	}

	return {
		assetId,
		slots,
		reorderRequested,
		lostClipIds,
		absorbedTrimIds,
		clippedTrimIds,
		slidRegionIds,
	};
}

export interface ReplaceTimelineOptions {
	/** Reuse the id / origin / reason / wordRefs of a clip whose source window a
	 *  kept interval reproduces exactly. Default true — a rebuild that happens to
	 *  keep a stretch of media keeps the clip that WAS that stretch of media. */
	preserveIds?: boolean;
	/** Carry the primary asset's existing cuts through the rebuild (narrowed to
	 *  the kept intervals). Default true. `restoreFullTimeline` is the one caller
	 *  whose whole point is to drop them. */
	preserveTrims?: boolean;
}

export function replaceTimeline(
	document: AxcutDocument,
	intervals: Interval[],
	reason: string,
	origin: "system" | "agent" | "user" = "user",
	options: ReplaceTimelineOptions = {},
): AxcutDocument {
	const assetId = document.project.primaryAssetId ?? document.assets[0]?.id;
	if (!assetId) {
		throw new Error("Cannot update timeline without a primary asset.");
	}
	const preserveIds = options.preserveIds !== false;
	const preserveTrims = options.preserveTrims !== false;
	const duration = primaryAssetDuration(document);
	const plan = planTimelineReplacement(document, intervals);
	const clipById = new Map(document.timeline.clips.map((clip) => [clip.id, clip]));

	let cursor = 0;
	const clips: AxcutClip[] = plan.slots.map((slot, index) => {
		const length = slot.interval.endSec - slot.interval.startSec;
		const timelineStartSec = cursor;
		cursor += length;
		const existing = preserveIds && slot.keepClipId ? clipById.get(slot.keepClipId) : undefined;
		return {
			// ponytail: a slot with no ancestor gets a MINTED id, not `clip_${i+1}`.
			// Positional ids are what let `trim_1` survive a rebuild while meaning a
			// different cut, and mixing them with preserved ids would collide outright
			// (a preserved `clip_1` sitting at index 1). The legacy positional naming
			// survives only on the `preserveIds: false` path, which rebuilds from nothing.
			id: existing?.id ?? (preserveIds ? createId("clip") : `clip_${index + 1}`),
			assetId,
			sourceStartSec: slot.interval.startSec,
			sourceEndSec: slot.interval.endSec,
			timelineStartSec,
			timelineEndSec: timelineStartSec + length,
			wordRefs:
				existing?.wordRefs ??
				collectWordRefs(document.transcript, slot.interval.startSec, slot.interval.endSec),
			origin: existing?.origin ?? origin,
			reason: existing?.reason ?? reason,
		};
	});

	const keptIntervals = plan.slots.map((slot) => slot.interval);
	const complement = invertIntervals(keptIntervals, duration).map((cut, index) => ({
		id: preserveIds ? createId("trim") : `trim_${index + 1}`,
		assetId,
		startSec: cut.startSec,
		endSec: cut.endSec,
		origin,
		reason,
	}));
	// Other assets' cuts are NEVER this operation's business — the rebuild only
	// lays out the primary asset. Replacing `trimRanges` wholesale wiped them, the
	// same bug `operations.ts` had already had to fix for `add_trim_range`.
	const foreignTrims = document.timeline.trimRanges.filter((trim) => trim.assetId !== assetId);
	const survivingTrims = preserveTrims
		? document.timeline.trimRanges.flatMap((trim) => {
				if (trim.assetId !== assetId) return [];
				return keptIntervals
					.map((slot) => intervalsIntersect(slot, { startSec: trim.startSec, endSec: trim.endSec }))
					.filter((piece): piece is Interval => piece !== null)
					.map((piece, index) => ({
						...trim,
						id: index === 0 ? trim.id : createId("trim"),
						startSec: piece.startSec,
						endSec: piece.endSec,
					}));
			})
		: [];

	const next: AxcutDocument = {
		...document,
		timeline: {
			...document.timeline,
			clips,
			trimRanges: [...foreignTrims, ...survivingTrims, ...complement].sort(byStart),
			gaps: [],
		},
	};
	return reconcileRegionsAfterReplace(next, clips, new Set(clips.map((clip) => clip.id)));
}

/**
 * Regions after a rebuild, by provenance — the fix for the quietest half of
 * D-DESTRUCT.
 *
 * The old code ran `reanchorRegions` over everything, which re-ventilates each
 * region from its RAW ruler ms. That is right for a region whose clip is gone
 * (its ruler position is all that is left of it) and wrong for one whose clip
 * survived: with the intervals [35-60], [0-25], a zoom anchored to clip_2 at
 * source 40-45 came back anchored at source 50-55. Ten seconds into different
 * footage, schema-valid, unreported. Anything whose anchor still resolves is
 * therefore rederived — the anchor IS the content — and only the orphans are
 * re-ventilated.
 *
 * The orphan branch also has to decide what "re-ventilation found nothing"
 * means, and the answer depends on where the region came from.
 * `anchorRegionsWithDerivedMs` passes such a region through UNCHANGED, which is
 * right for a never-anchored one (a v2 migration keeps a region it cannot place
 * rather than losing user data) and wrong for one whose clip was just deleted:
 * that leaves it pointing at an id nothing resolves, invisible to the timeline
 * and revivable by any future clip that happens to take the name. Its content
 * is gone, so it goes with it — the same call `removeClip` and
 * `setClipSourceRange` already make through `rederiveRegionMs`.
 */
function reconcileRegionsAfterReplace(
	document: AxcutDocument,
	clips: AxcutClip[],
	surviving: Set<string>,
): AxcutDocument {
	if (clips.length === 0) return document;
	const clipById = new Map(clips.map((clip) => [clip.id, clip]));
	return mapAllRegionCollections(document, (regions, prefix) =>
		regions.flatMap((region) => {
			if (hasCompleteClipAnchor(region) && surviving.has(region.clipId)) {
				const clip = clipById.get(region.clipId);
				if (clip) return rederiveAnchoredRegion(region, clip, clips);
			}
			const reventilated = anchorRegionsWithDerivedMs([region], clips, () =>
				createId(prefix),
			) as StoredRegion[];
			const placed = reventilated.some(
				(next) => hasCompleteClipAnchor(next) && surviving.has(next.clipId),
			);
			if (placed) return reventilated;
			return hasCompleteClipAnchor(region) ? [] : reventilated;
		}),
	);
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
	};
	return rederiveRegionMs(next, newClips);
}

// ponytail: duplicate a clip (preserves the original). Used for "split this
// clip into two" or "make a copy". Mirrors axcut's
// apps/server/src/lib/timeline.ts#duplicateClip.
//
// The copy takes its own COPY of the original's trims, re-anchored to the new clip id.
// Before trims carried a `clipId` this happened by accident — a trim matched on `assetId`,
// so the duplicate (same asset) was born already cut the same way — and that accident is
// the behaviour a user expects from "duplicate": an identical clip. Now that a trim names
// its clip, the copy has to be made on purpose, and the two sets are independent
// afterwards, which is the point: editing the copy's cut no longer edits the original's.
// Only ANCHORED trims are copied — an un-anchored one already reaches the copy through
// the asset-wide fallback, so copying it would cut the same span twice.
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
	const copiedTrims = document.timeline.trimRanges
		.filter((t) => t.clipId === original.id)
		.map((t) => ({ ...t, id: createId("trim"), clipId: copy.id }));
	const updatedDoc: AxcutDocument = {
		...document,
		timeline: {
			...document.timeline,
			clips: newClips,
			trimRanges: [...document.timeline.trimRanges, ...copiedTrims],
		},
	};
	return rederiveRegionMs(updatedDoc, newClips);
}

/**
 * The single mutator for "narrow/extend a clip's own source in/out" — the edit the
 * clip's Edit modal, the renderer op dispatcher, and the LLM's `setClipRange` tool all
 * perform. Extracted here (like `moveClip` / `duplicateClip`) so the recipe lives in one
 * place instead of being re-derived per façade, which is what let the three drift apart
 * (stale width, un-clamped pills). Pure — a plain document→document transform.
 *
 * Recipe: clamp + order the range, zero the clip's timeline extent so `resequenceClips`
 * recomputes its RAW length from the new source window (a raw clip's timeline length equals
 * its source length), lay everything back-to-back, then `rederiveRegionMs` clamps every
 * anchored pill to the clip's kept window (dropping what the trim removed) and refreshes the
 * derived ms of the clips that reflowed. An unknown `clipId` is a no-op.
 */
export function setClipSourceRange(
	document: AxcutDocument,
	clipId: string,
	sourceStartSec: number,
	sourceEndSec: number,
): AxcutDocument {
	const clamp = (n: number) => (Number.isFinite(n) ? Math.max(0, n) : 0);
	const lo = Math.min(clamp(sourceStartSec), clamp(sourceEndSec));
	const hi = Math.max(clamp(sourceStartSec), clamp(sourceEndSec));
	const arr = document.timeline.clips.map((c) =>
		c.id === clipId
			? { ...c, sourceStartSec: lo, sourceEndSec: hi, timelineStartSec: 0, timelineEndSec: 0 }
			: c,
	);
	const newClips = resequenceClips(arr);
	const next: AxcutDocument = {
		...document,
		timeline: { ...document.timeline, clips: newClips },
	};
	return rederiveRegionMs(next, newClips);
}

/**
 * The single mutator for "delete a region by id" — the edit the UI's delete key and the
 * LLM's `removeTrim` / `removeModifier` tools all perform. Extracted here (like
 * `setClipSourceRange`) so the recipe lives in one place: EVERY kind deletes the whole
 * pill, i.e. every row that renders as one stripe with `id` under the merge rule. Modifiers
 * go through `dropPillById`; trims need `dropTrimPillsByIds` instead, because `dropPillById`
 * keys off `startMs`/`endMs` and a trim stores `startSec`/`endSec` plus a `clipId` anchor —
 * different storage, same rule. Trims used to be the exception here (a bare id filter), so a
 * cut grown across a clip boundary — necessarily 2+ rows — lost only the row that was
 * clicked and kept cutting on the other side. Speed / camera-fullscreen live under
 * `legacyEditor`. An id that matches nothing is a no-op. Pure.
 */
export function removeRegion(document: AxcutDocument, kind: RegionKind, id: string): AxcutDocument {
	switch (kind) {
		case "zoom":
			return {
				...document,
				zoomRanges: dropPillById(document.zoomRanges, id) as AxcutDocument["zoomRanges"],
			};
		case "annotation":
			return { ...document, annotations: dropPillById(document.annotations, id) };
		case "trim":
			return {
				...document,
				timeline: {
					...document.timeline,
					trimRanges: dropTrimPillsByIds(document.timeline.trimRanges, document.timeline.clips, [
						id,
					]),
				},
			};
		case "speed": {
			const legacy = (document.legacyEditor as Record<string, unknown>) ?? {};
			const prev = dropPillById(
				(legacy.speedRegions as Array<{ id: string; startMs: number; endMs: number }>) ?? [],
				id,
			);
			return { ...document, legacyEditor: { ...legacy, speedRegions: prev } };
		}
		case "cameraFullscreen": {
			const legacy = (document.legacyEditor as Record<string, unknown>) ?? {};
			const prev = dropPillById(
				(legacy.cameraFullscreenRegions as Array<{ id: string; startMs: number; endMs: number }>) ??
					[],
				id,
			);
			return { ...document, legacyEditor: { ...legacy, cameraFullscreenRegions: prev } };
		}
		default: {
			// ponytail: exhaustive — TS errors here if a new RegionKind is added.
			const exhaustive: never = kind;
			void exhaustive;
			return document;
		}
	}
}

/**
 * The single mutator for "delete a clip". Removing a clip closes the gap: the survivors are
 * re-laid back-to-back (`resequenceClips`) and every anchored pill's derived ms is refreshed
 * against the new layout (`rederiveRegionMs`) — pills anchored to the removed clip drop out,
 * exactly like `setClipSourceRange`. Trims anchored to it go the same way: their content is
 * gone, so keeping them would leave rows nothing can reach (they render on no clip and cut
 * no clip) that a later duplicate of the same asset must not resurrect. Shared by the
 * store's delete-clip action and the LLM's `removeClip` tool. An unknown `clipId` is a
 * no-op. Pure.
 */
export function removeClip(document: AxcutDocument, clipId: string): AxcutDocument {
	const oldClips = document.timeline.clips;
	const arr = oldClips.filter((c) => c.id !== clipId);
	if (arr.length === oldClips.length) return document;
	const newClips = resequenceClips(arr);
	const next: AxcutDocument = {
		...document,
		timeline: {
			...document.timeline,
			clips: newClips,
			trimRanges: document.timeline.trimRanges.filter((t) => t.clipId !== clipId),
		},
	};
	// The asymmetry with the trim filter three lines up is deliberate, and the obvious
	// "cleanup" that makes the two match reintroduces #249.
	//
	// A trim's complete anchor IS a bare `clipId` -- it carries its own `startSec`/
	// `endSec` in source time (`trimAppliesToClip`), so the clip going away takes the
	// trim with it. A region carrying only a `clipId` and no source range is NOT
	// anchored (`hasCompleteClipAnchor`): it is still placed by its RAW ms, so the clip
	// does not own it and deleting the clip must not delete it.
	//
	// The cost of keeping it, stated so it is a decision and not an accident: that
	// region is now unreachable but immortal. With clips [0-10s] and [10-20s] and a bare
	// `clipId` zoom at raw 12000-14000ms, deleting the second clip leaves the zoom off
	// the end of a 10s ruler -- no pill to click, dropped by `projectRegionsToSource`,
	// and re-emitted by every rederive. Hitting "Restore full timeline" then re-anchors
	// it from those stale raw ms onto whatever footage now sits at 12-14s. That is the
	// same treatment fully-unanchored legacy regions already get, and losing the user's
	// region outright is the worse of the two.
	//
	// Only the last-clip case needs the filter spelled out. With survivors,
	// `rederiveRegionMs` already drops every anchored region whose `clipId` is absent
	// from the new clips -- a strict superset of "anchored to the one just removed" --
	// so running both walked all four region collections twice and spread the document
	// twice per delete. `rederiveRegionMs` bails on an empty clip list (a guard against
	// a transient wipe deleting everything), which is why the empty case is handled
	// here rather than left to it.
	if (newClips.length === 0) {
		return mapAllRegionCollections(next, (regions) =>
			regions.filter((region) => !(hasCompleteClipAnchor(region) && region.clipId === clipId)),
		);
	}
	return rederiveRegionMs(next, newClips);
}

export function restoreFullTimeline(document: AxcutDocument): AxcutDocument {
	const duration = primaryAssetDuration(document);
	if (duration <= 0) return document;
	// ponytail: the ONE caller whose semantics are "put it all back": a single
	// clip covering the whole asset and not a single cut left. `replaceTimeline`
	// preserves ids and trims by default now, which would quietly turn "restore"
	// into "keep everything you already had" — the opposite of the button.
	return replaceTimeline(
		document,
		[{ startSec: 0, endSec: duration }],
		"Restore full timeline",
		"user",
		{
			preserveIds: false,
			preserveTrims: false,
		},
	);
}
