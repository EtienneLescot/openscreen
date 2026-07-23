// The single place that maps between the timeline's three coordinate systems.
// See docs/architecture/timeline-coordinate-refactor.md.
//
//   RAW virtual   — the ruler the user manipulates; trims still occupy their
//                   space. `currentTimeSec`, the playhead, region authoring, and
//                   `document.timeline.clips[].timelineStartSec` all live here.
//   source        — a clip's own media time (assetId + sourceSec); what the
//                   decoders, the native compositor, and trims are expressed in.
//   compressed     — the trim-narrowed playback sequence (`resolvePlaybackSegments`),
//                   laid out back-to-back from 0; what the native free-run stream
//                   and the export frame count advance through.
//
// A raw clip is identity between source-time and raw-virtual-time (its timeline
// length equals its source length — no speed baked into the geometry), so raw↔
// source within one clip is a plain shift by the clip's own start offset. The
// bug this module fixes was projecting regions authored in RAW coordinates
// against the COMPRESSED segment layout, which slips every region after a trim
// forward by the trimmed duration.

import type { AxcutClip } from "../schema";
import { ventilateSpanAcrossClips } from "./region-ventilation";
import { getRawVirtualStartTime } from "./virtual-preview";

/** A modifier fragment anchored to one clip in that clip's own source time — the
 *  Stage B storage shape (see docs/architecture/timeline-coordinate-refactor.md).
 *  Trims narrow the clip's kept source ranges, so an anchored fragment is clipped/
 *  hidden by the same interval math with no reprojection; a reorder carries it with
 *  its clip by `clipId`.
 *
 *  A region the user authored across a clip boundary is stored as one fragment per
 *  covered clip. Nothing records that they belong together: by the universal merge rule
 *  they share the same properties, so they render as one pill whenever they are adjacent —
 *  and stop doing so if one of them is edited. `T` is the payload minus the RAW-ms span. */
export type ClipAnchored<T> = Omit<T, "startMs" | "endMs"> & {
	clipId: string;
	sourceStartSec: number;
	sourceEndSec: number;
};

/**
 * Migrate RAW-virtual-ms regions (the v4 document-level storage) to clip-anchored
 * source-time fragments (the v5 storage). Each region is ventilated across the RAW
 * clip layout it was authored against: wholly inside one clip → one fragment;
 * straddling a boundary → one fragment per covered clip (they re-merge on display by the
 * merge rule, since they share properties — no bookkeeping). Each fragment
 * gets its own unique `id` (first keeps the original region id; extras from
 * `makeId`). A zero-length / off-timeline region covers no clip and is dropped (it
 * could never play). Pure; reused by the v4→v5 schema migration and by re-anchoring
 * after a raw edit.
 */
export function anchorRawRegionsToClips<T extends { id: string; startMs: number; endMs: number }>(
	regions: T[],
	rawClips: AxcutClip[],
	makeId: () => string,
): ClipAnchored<T>[] {
	const byId = new Map(rawClips.map((c) => [c.id, c]));
	const out: ClipAnchored<T>[] = [];
	for (const region of regions) {
		const frags = ventilateSpanAcrossClips(region.startMs / 1000, region.endMs / 1000, rawClips);
		frags.forEach((f, i) => {
			const clip = byId.get(f.clipId);
			if (!clip) return;
			// `groupId` is dropped, not carried: it is a dead marker from the removed group
			// model, and re-anchoring is the natural place to stop it propagating into new
			// fragments. (Identity ignores it anyway — see NON_IDENTITY_FIELDS.)
			const {
				startMs: _s,
				endMs: _e,
				groupId: _g,
				...payload
			} = region as T & { groupId?: string };
			out.push({
				...(payload as Omit<T, "startMs" | "endMs">),
				id: i === 0 ? region.id : makeId(),
				clipId: f.clipId,
				sourceStartSec: clip.sourceStartSec + f.localStartSec,
				sourceEndSec: clip.sourceStartSec + f.localEndSec,
			});
		});
	}
	return out;
}

/**
 * The RAW ruler span a clip-anchored fragment currently occupies, derived from its
 * clip's live position — the single forward map source↔raw for one fragment (a raw
 * clip is identity between source and raw-virtual time). Returns null when the
 * fragment's `clipId` is gone (clip deleted → the fragment is not shown). Used to
 * place pills (`V4Timeline`), derive the transition `startMs/endMs`, and by
 * `coalesceAnchoredFragments`.
 */
export function anchoredToRawSpanSec(
	fragment: { clipId: string; sourceStartSec: number; sourceEndSec: number },
	clips: AxcutClip[],
): { startSec: number; endSec: number } | null {
	const clip = clips.find((c) => c.id === fragment.clipId);
	if (!clip) return null;
	return {
		startSec: clip.timelineStartSec + (fragment.sourceStartSec - clip.sourceStartSec),
		endSec: clip.timelineStartSec + (fragment.sourceEndSec - clip.sourceStartSec),
	};
}

// ─── The two universal region rules ────────────────────────────────────────
// Every kind of ruler region (trim, zoom, speed, annotation, full-camera) obeys the
// same two rules, expressed once here rather than re-derived per kind:
//
//   1. MERGE   — two regions of the same kind with the SAME identity that touch are
//                indistinguishable to the user, so they are one pill. However they
//                came to be adjacent (authored side by side, split by a reorder then
//                rejoined, …) is irrelevant: identity is what a region IS, never where
//                it came from or how it got there.
//   2. REPEL   — two regions of the same kind with DIFFERENT identities may not
//                overlap. An edit clamps to the neighbour's edge; the neighbour never
//                moves (no cascade).
//
// A kind with no properties (trim, full-camera) collapses to a constant identity, so
// its regions always merge — the long-standing trim behaviour, now *derived* from the
// general rule instead of hand-coded beside it.

/** Fields that say WHERE a region sits or WHERE IT CAME FROM — never what it is. */
const NON_IDENTITY_FIELDS = new Set([
	// position
	"id",
	"clipId",
	"assetId",
	"sourceStartSec",
	"sourceEndSec",
	"startMs",
	"endMs",
	"startSec",
	"endSec",
	// provenance / metadata
	"reason",
	"origin",
	"source",
	"annotationSource",
	// Legacy provenance marker from the removed group model. It no longer exists in
	// code, but it SURVIVES in documents already migrated to v5 (which never re-run the
	// migration), and two independently authored regions carry different ones. Left in,
	// it would silently make otherwise identical regions refuse to merge — which is
	// exactly the bug this list must prevent: provenance never decides identity.
	"groupId",
]);

/** Canonical serialisation — key order must not affect identity. */
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj)
		.filter((k) => obj[k] !== undefined)
		.sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/**
 * What a region IS: every property that affects how it renders/behaves, canonically
 * serialised; position and provenance excluded. Two regions of one kind sharing this
 * key are the same pill when adjacent. A propertyless kind yields a constant key, so
 * all its regions merge.
 */
export function regionIdentityKey(region: Record<string, unknown>): string {
	const payload: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(region)) {
		if (!NON_IDENTITY_FIELDS.has(key) && value !== undefined) payload[key] = value;
	}
	return stableStringify(payload);
}

export interface IdentifiedSpan {
	id: string;
	/** RAW timeline seconds. */
	start: number;
	end: number;
	identity: string;
}

export interface MergedSpan {
	start: number;
	end: number;
	/** Underlying region ids under this span, left-to-right. */
	ids: string[];
	identity: string;
}

/**
 * Rule 1 — merge touching spans that share an identity, and only those. Spans of
 * different identities never merge even when they touch. This is the single coalescing
 * primitive for every region kind: trims pass a constant identity (→ always merge),
 * modifiers pass {@link regionIdentityKey}.
 */
export function coalesceByIdentity(spans: IdentifiedSpan[], epsilonSec = 0.001): MergedSpan[] {
	const byIdentity = new Map<string, IdentifiedSpan[]>();
	for (const span of spans) {
		const list = byIdentity.get(span.identity) ?? [];
		list.push(span);
		byIdentity.set(span.identity, list);
	}
	const out: MergedSpan[] = [];
	for (const [identity, list] of byIdentity) {
		let cur: MergedSpan | null = null;
		for (const span of [...list].sort((a, b) => a.start - b.start)) {
			if (cur && span.start - cur.end <= epsilonSec) {
				cur.end = Math.max(cur.end, span.end);
				cur.ids.push(span.id);
			} else {
				cur = { start: span.start, end: span.end, ids: [span.id], identity };
				out.push(cur);
			}
		}
	}
	return out.sort((a, b) => a.start - b.start);
}

/**
 * Rule 2 — clamp an edited span so it cannot overlap a same-kind span of a DIFFERENT
 * identity. Blocking neighbours act as walls: the edited span stops at the nearest
 * blocking edge on each side and the neighbour is never modified or displaced, so an
 * edit can never cascade into regions the user did not touch. Same-identity spans are
 * not obstacles — overlapping them is harmless, they simply merge (rule 1).
 */
export function clampSpanAgainstNeighbours(
	desired: { start: number; end: number },
	identity: string,
	others: IdentifiedSpan[],
): { start: number; end: number } {
	let start = Math.min(desired.start, desired.end);
	let end = Math.max(desired.start, desired.end);
	for (const other of [...others].sort((a, b) => a.start - b.start)) {
		if (other.identity === identity) continue;
		if (other.end <= start || other.start >= end) continue; // no overlap
		if (other.start <= start) start = Math.max(start, other.end);
		else end = Math.min(end, other.start);
	}
	return { start, end: Math.max(start, end) };
}

/** A pill as the ruler draws it: a run of same-identity regions that touch. */
export interface RegionPill<T> extends MergedSpan {
	/** First region under the pill — carries the payload the label needs. */
	member: T;
}

/**
 * Group stored regions into the pills the ruler draws, via the universal merge rule.
 * Works off the DERIVED `startMs`/`endMs`: they are always present (even before a region
 * is anchored) and kept in sync with the anchor, so a region can never become invisible
 * merely because it has no anchor yet.
 */
export function coalesceRegionsForRuler<T extends { id: string; startMs: number; endMs: number }>(
	regions: T[],
	epsilonSec = 0.001,
): RegionPill<T>[] {
	const byId = new Map(regions.map((r) => [r.id, r]));
	const spans = regions.map((r) => ({
		id: r.id,
		start: r.startMs / 1000,
		end: r.endMs / 1000,
		identity: regionIdentityKey(r as unknown as Record<string, unknown>),
	}));
	return coalesceByIdentity(spans, epsilonSec).map((merged) => ({
		...merged,
		member: byId.get(merged.ids[0]) as T,
	}));
}

/**
 * The regions that render as the SAME pill as `id`. Recomputed from the merge rule
 * rather than stored: nothing records which regions belong together, because equal
 * properties + adjacency already say so, and that stays correct however they came to be
 * adjacent. Every mutation routes through this so it acts on exactly what the user sees
 * as one pill.
 */
export function resolvePillIds<T extends { id: string; startMs: number; endMs: number }>(
	regions: T[],
	id: string,
	epsilonSec = 0.001,
): string[] {
	return coalesceRegionsForRuler(regions, epsilonSec).find((p) => p.ids.includes(id))?.ids ?? [id];
}

/**
 * Move/resize the pill containing `id`, obeying both rules: the requested span is first
 * CLAMPED against pills of a different identity (rule 2 — they act as walls and never
 * move), then the pill's regions are replaced by fragments re-anchored to the clamped
 * span, carrying the pill's payload. Crossing a clip boundary re-splits into one fragment
 * per clip; coming back inside one clip collapses again; and neighbours of the same
 * identity simply merge on display (rule 1). No provenance is consulted anywhere.
 */
export function replacePillSpan<T extends { id: string; startMs: number; endMs: number }>(
	regions: T[],
	id: string,
	startMs: number,
	endMs: number,
	clips: AxcutClip[],
	makeId: () => string,
	epsilonSec = 0.001,
): T[] {
	const pills = coalesceRegionsForRuler(regions, epsilonSec);
	const pill = pills.find((p) => p.ids.includes(id));
	if (!pill) return regions;

	const clamped = clampSpanAgainstNeighbours(
		{ start: Math.min(startMs, endMs) / 1000, end: Math.max(startMs, endMs) / 1000 },
		pill.identity,
		pills
			.filter((p) => p !== pill)
			.map((p) => ({ id: p.ids[0], start: p.start, end: p.end, identity: p.identity })),
	);

	const under = new Set(pill.ids);
	const { startMs: _s, endMs: _e, ...payload } = pill.member;
	const rebuilt = anchorRegionsWithDerivedMs(
		[
			{
				...payload,
				id: pill.ids[0],
				startMs: Math.round(clamped.start * 1000),
				endMs: Math.round(clamped.end * 1000),
			} as unknown as T,
		],
		clips,
		makeId,
	) as unknown as T[];
	return [...regions.filter((r) => !under.has(r.id)), ...rebuilt];
}

/** A region after v5 migration: either an anchored fragment (with its derived ms
 *  cache) or — when nothing could be anchored — the original region, untouched. */
export type MigratedRegion<T extends { id: string; startMs: number; endMs: number }> =
	| T
	| (ClipAnchored<T> & { startMs: number; endMs: number });

/**
 * The v5 STORED shape of a migrated region: a clip-anchored fragment plus a
 * DERIVED `startMs`/`endMs` cache (its current RAW ruler span). During the Stage B
 * transition the anchor is the SSOT while un-migrated consumers keep reading
 * `startMs`/`endMs`; a structural op (or migration) re-derives them from the anchor.
 * Shared by the disk-load path (`documentSchema`'s v4→v5 preprocess) and the v2
 * migration so both emit identical v5 regions.
 *
 * **Never loses a region.** Unlike the low-level `anchorRawRegionsToClips` (which
 * yields no fragments when a region covers no clip — correct for a ventilation
 * primitive), a region that cannot be anchored is passed through UNANCHORED, keeping
 * its original `startMs`/`endMs`. That case is real and must not drop user data: a v2
 * project imported before its asset duration is probed has a zero-extent clip, so
 * nothing overlaps yet. Such regions stay valid (the anchor is optional) and get
 * anchored later once the clip has a real duration.
 */
export function anchorRegionsWithDerivedMs<
	T extends { id: string; startMs: number; endMs: number },
>(regions: T[], clips: AxcutClip[], makeId: () => string): MigratedRegion<T>[] {
	return regions.flatMap<MigratedRegion<T>>((region) => {
		const frags = anchorRawRegionsToClips([region], clips, makeId);
		if (frags.length === 0) return [region];
		return frags.map((frag) => {
			const span = anchoredToRawSpanSec(frag, clips);
			return {
				...frag,
				startMs: span ? Math.round(span.startSec * 1000) : region.startMs,
				endMs: span ? Math.round(span.endSec * 1000) : region.endMs,
			};
		});
	});
}

/**
 * RAW-virtual extent of a (possibly trim-narrowed) playback segment: where it
 * sits on the ruler, derived from its parent raw clip via `getRawVirtualStartTime`.
 * Note the raw span of two segments split by a trim has a GAP between them — the
 * removed stretch keeps its place on the raw ruler — which is exactly what makes
 * a region land on the source moment it was authored on rather than sliding into
 * the gap.
 */
export function segmentRawSpanSec(
	segment: AxcutClip,
	rawClips: AxcutClip[],
): { startSec: number; endSec: number } {
	const startSec = getRawVirtualStartTime(segment, rawClips);
	const lenSec = (segment.sourceEndSec ?? segment.sourceStartSec) - segment.sourceStartSec;
	return { startSec, endSec: startSec + lenSec };
}

/**
 * Project RAW-virtual-ms regions (zoom / speed / camera-fullscreen, as authored
 * on the ruler) onto the SOURCE-ms ranges the native compositor matches against.
 * The raw→source map goes through each visible segment's OWN raw extent, and the
 * trim-compressed order supplies `clipIndex`. A region whose source range a trim
 * splits across two kept segments yields one entry per segment (fresh id for the
 * extra copies, original id on the first — matching the previous contract). A
 * region overlapping no visible segment passes through unchanged with no
 * `clipIndex` (native falls back to time-overlap), same as before.
 *
 * `visibleSegments` MUST be the same array (same order) serialized to
 * `Scene.clips` so the emitted `clipIndex` lines up with the native stream;
 * `rawClips` is `document.timeline.clips` (the un-compressed layout the regions
 * were authored against).
 */
export function projectRawRegionsToSource<T extends { id: string; startMs: number; endMs: number }>(
	regions: T[],
	visibleSegments: AxcutClip[],
	rawClips: AxcutClip[],
	makeId: () => string,
): (T & { clipIndex?: number })[] {
	const spans = visibleSegments.map((seg) => segmentRawSpanSec(seg, rawClips));
	const out: (T & { clipIndex?: number })[] = [];
	for (const region of regions) {
		const lo = Math.min(region.startMs, region.endMs) / 1000;
		const hi = Math.max(region.startMs, region.endMs) / 1000;
		let emitted = 0;
		visibleSegments.forEach((seg, clipIndex) => {
			const { startSec: segRawStart, endSec: segRawEnd } = spans[clipIndex];
			const s = Math.max(lo, segRawStart);
			const e = Math.min(hi, segRawEnd);
			if (e <= s) return;
			const srcStart = seg.sourceStartSec + (s - segRawStart);
			const srcEnd = seg.sourceStartSec + (e - segRawStart);
			out.push({
				...region,
				id: emitted === 0 ? region.id : makeId(),
				startMs: Math.round(srcStart * 1000),
				endMs: Math.round(srcEnd * 1000),
				clipIndex,
			});
			emitted += 1;
		});
		if (emitted === 0) out.push(region);
	}
	return out;
}

export interface NativePosition {
	/** The trim-narrowed playback segment (from `visibleSegments`) that is active. */
	clip: AxcutClip;
	/** Its index in `visibleSegments`, matching `SceneDescription.clips` / native `clip_index`. */
	clipIndex: number;
	/** Screen-source seconds the native decoder should present for this segment. */
	sourceTimeSec: number;
}

// A hair before a segment's source end, so a scrub/seek never asks the decoder
// for a frame past EOF (returns a null D3D frame → crash). Mirrors the margin the
// old `resolveNativePlaybackPosition` carried; ~1 frame @ 30fps.
const NATIVE_EOF_MARGIN_SEC = 0.033;

/**
 * Resolve a RAW timeline playhead to the active native clip's screen-source clock.
 *
 * The playhead (`currentTimeSec`) lives on the RAW ruler (trims still occupy their
 * space); the native compositor plays the trim-COMPRESSED `visibleSegments`. This
 * maps raw→source through each segment's OWN raw extent (via `rawClips`, the
 * un-compressed layout) so the source time is correct after a trim, and returns
 * the segment's `clipIndex` in the compressed stream so `setActiveClip`/`presentTime`
 * address the right decoder + the right paired camera. When the raw playhead sits
 * over a trimmed-out stretch, it snaps to the next kept segment (where content
 * resumes) rather than the removed frames. Returns null only when there are no
 * segments at all. Replaces `nativePlaybackPosition.resolveNativePlaybackPosition`,
 * which conflated the raw and compressed layouts (correct only without trims).
 */
export function resolveNativePosition(
	rawSec: number,
	visibleSegments: AxcutClip[],
	rawClips: AxcutClip[],
): NativePosition | null {
	if (!Number.isFinite(rawSec) || visibleSegments.length === 0) return null;
	const spans = visibleSegments.map((seg) => segmentRawSpanSec(seg, rawClips));

	// Segment whose RAW extent contains the playhead (last segment's end inclusive).
	let index = spans.findIndex((s, i) => {
		const isLast = i === spans.length - 1;
		return rawSec >= s.startSec && (rawSec < s.endSec || (isLast && rawSec <= s.endSec));
	});
	// Over a trimmed-out gap (or before the first kept frame): snap to the next kept
	// segment; if the playhead is past all kept content, clamp into the last one.
	let clampToSegmentStart = false;
	if (index < 0) {
		index = spans.findIndex((s) => s.startSec >= rawSec);
		if (index < 0) index = visibleSegments.length - 1;
		else clampToSegmentStart = true;
	}

	const seg = visibleSegments[index];
	const segSourceEnd = seg.sourceEndSec ?? seg.sourceStartSec;
	const unclamped = clampToSegmentStart
		? seg.sourceStartSec
		: seg.sourceStartSec + (rawSec - spans[index].startSec);
	const maxSource = Math.max(seg.sourceStartSec, segSourceEnd - NATIVE_EOF_MARGIN_SEC);
	return {
		clip: seg,
		clipIndex: index,
		sourceTimeSec: Math.max(seg.sourceStartSec, Math.min(maxSource, unclamped)),
	};
}
