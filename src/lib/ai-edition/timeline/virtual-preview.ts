// Ported from axcut/apps/web/src/lib/virtual-preview.ts — pure time-mapping
// functions shared by the VirtualPreview component and the timeline math.

import type { AxcutClip } from "../schema";

export type VirtualPosition = {
	clip: AxcutClip;
	clipIndex: number;
	virtualTimeSec: number;
	sourceTimeSec: number;
};

export function totalVirtualDuration(clips: AxcutClip[]): number {
	return clips.at(-1)?.timelineEndSec ?? 0;
}

export function clampVirtualTime(clips: AxcutClip[], value: number): number {
	if (clips.length === 0) return 0;
	return Math.max(0, Math.min(totalVirtualDuration(clips), value));
}

export function locateVirtualPosition(
	clips: AxcutClip[],
	virtualTimeSec: number,
): VirtualPosition | null {
	if (clips.length === 0) return null;
	const clamped = clampVirtualTime(clips, virtualTimeSec);
	const clipIndex = clips.findIndex((clip, index) => {
		const isLast = index === clips.length - 1;
		return clamped >= clip.timelineStartSec && (clamped < clip.timelineEndSec || isLast);
	});
	const resolvedIndex = clipIndex >= 0 ? clipIndex : clips.length - 1;
	const clip = clips[resolvedIndex];
	const clipDuration = (clip.sourceEndSec ?? 0) - clip.sourceStartSec;
	const clipOffset = Math.max(0, Math.min(clipDuration, clamped - clip.timelineStartSec));
	return {
		clip,
		clipIndex: resolvedIndex,
		virtualTimeSec: clamped,
		sourceTimeSec: clip.sourceStartSec + clipOffset,
	};
}

/**
 * Maps a kept segment (`AxcutClip` from `resolvePlaybackSegments`) back to the RAW
 * clip it was cut from — the ONE place that knows the segment-id convention
 * `resolvePlaybackSegments` produces (`clip.id` when a clip survives whole,
 * `${clip.id}_segN` when trims split it into several kept pieces). Anything that
 * needs "which document clip is this segment part of?" — raw positioning, matching a
 * clip-anchored region's `clipId` — must go through here rather than re-deriving the
 * convention, so producer and consumers can never drift apart.
 *
 * Falls back to an asset+source-window match for segments whose id doesn't follow the
 * convention (hand-built segments, older data). `undefined` when nothing matches.
 */
export function findRawClipForSegment(
	segment: AxcutClip,
	rawClips: AxcutClip[],
): AxcutClip | undefined {
	return (
		rawClips.find((c) => c.id === segment.id || segment.id.startsWith(`${c.id}_seg`)) ??
		rawClips.find(
			(c) =>
				c.assetId === segment.assetId &&
				segment.sourceStartSec >= c.sourceStartSec - 0.001 &&
				(c.sourceEndSec == null || segment.sourceStartSec <= c.sourceEndSec + 0.001),
		)
	);
}

/**
 * Maps a kept segment (`AxcutClip` from `resolvePlaybackSegments`) back to its
 * exact start position on the raw (untrimmed) document timeline.
 */
export function getRawVirtualStartTime(segment: AxcutClip, rawClips: AxcutClip[]): number {
	const rawClip = findRawClipForSegment(segment, rawClips);
	if (!rawClip) return segment.timelineStartSec;
	return rawClip.timelineStartSec + (segment.sourceStartSec - rawClip.sourceStartSec);
}

/**
 * Resolves the next kept segment on the virtual timeline at or after the given position.
 * `playbackClips` (from `resolvePlaybackSegments`) is the SSOT for kept timeline content.
 *
 * Two ways to be "next", and the second one has to name a clip. The RAW ruler answers the
 * general case: the first segment starting after where we are. The source clock answers
 * the case the ruler cannot, when the video has run into a cut and the raw position has
 * not caught up — but "later in source time" is only meaningful WITHIN one clip. Asked of
 * a whole asset it compares source positions belonging to different stretches of ruler,
 * and returns whichever clip happens to start deeper into the recording: with a slice from
 * late in the recording laid down BEFORE a trimmed slice from early in it, playing into
 * that trim answered "clip_1" — raw start 0 — so playback jumped back to the top of the
 * timeline, replayed into the same cut, and looped there. Scoped to the clip being played,
 * it means "the next kept stretch of THIS clip", which is the only thing the source clock
 * can honestly say. With no clip named there is nothing to scope it to, and the ruler test
 * above is already the general answer, so the fallback simply does not apply.
 */
export function findNextKeptSegment(
	playbackClips: AxcutClip[],
	rawClips: AxcutClip[],
	currentRawTime: number,
	activeSourceId?: string,
	currentSourceTime?: number,
	activeClipId?: string,
): AxcutClip | undefined {
	for (const seg of playbackClips) {
		const segRawStart = getRawVirtualStartTime(seg, rawClips);
		if (segRawStart > currentRawTime + 0.001) {
			return seg;
		}
		if (
			activeSourceId &&
			activeClipId &&
			currentSourceTime !== undefined &&
			seg.assetId === activeSourceId &&
			findRawClipForSegment(seg, rawClips)?.id === activeClipId &&
			seg.sourceStartSec > currentSourceTime + 0.001
		) {
			return seg;
		}
	}
	return undefined;
}

function toPositionAt(
	clips: AxcutClip[],
	clipIndex: number,
	sourceTimeSec: number,
): VirtualPosition {
	const clip = clips[clipIndex];
	const sourceOffset = Math.max(
		0,
		Math.min((clip.sourceEndSec ?? 0) - clip.sourceStartSec, sourceTimeSec - clip.sourceStartSec),
	);
	return {
		clip,
		clipIndex,
		virtualTimeSec: clip.timelineStartSec + sourceOffset,
		sourceTimeSec,
	};
}

/** How a clip's CLOSING edge is treated when asking "is this source time on it?".
 *
 *  `exclusive` leaves the closing edge to whichever clip starts there — that is the
 *  whole job of the epsilon: at a shared boundary (clip A ends where clip B begins)
 *  the time belongs to B, not to the clip that just finished. `inclusive` accepts it,
 *  which is what lets a clip's own last frames still resolve to that clip. */
type ClosingEdge = "exclusive" | "inclusive";

function isWithinClipBounds(
	clip: AxcutClip,
	sourceTimeSec: number,
	epsilon: number,
	closingEdge: ClosingEdge,
): boolean {
	// An un-probed clip has no end yet, and `resolvePlaybackSegments` reads that as a
	// zero-width window at the in-point — the same default is used here because
	// `locateKeptSegment` now feeds this function that very output, so the two sit in
	// series and must not read one missing field two ways. (`?? 0` put the window
	// BELOW `sourceStartSec` for a clip starting anywhere but 0, which no source time
	// could ever satisfy. Unreachable in practice — a clip only awaits probing with
	// `sourceStartSec === 0`, where the two defaults coincide — so this changes no
	// behaviour; it removes a divergence, not a bug.)
	const sourceEnd = clip.sourceEndSec ?? clip.sourceStartSec;
	const upperBound = closingEdge === "inclusive" ? sourceEnd + epsilon : sourceEnd - epsilon;
	return sourceTimeSec >= clip.sourceStartSec - epsilon && sourceTimeSec <= upperBound;
}

export function locateSourcePosition(
	clips: AxcutClip[],
	sourceTimeSec: number,
	assetId?: string,
	epsilon = 0.05,
	// When two clips share the same source asset (and possibly overlapping
	// source ranges — a duplicated clip, or simply not trimmed yet), scanning
	// by (assetId, sourceTime) alone is ambiguous and always resolves to the
	// earliest matching clip in array order — even while a *later* clip of
	// that same asset is the one actually playing. Callers that already know
	// which clip they're tracking (VirtualPreview, mid-playback) should pass
	// its id here so it's preferred whenever the source time still falls
	// inside it, before falling back to the ambiguous asset-wide scan.
	preferredClipId?: string,
): VirtualPosition | null {
	if (preferredClipId) {
		const preferredIndex = clips.findIndex((clip) => clip.id === preferredClipId);
		// IDENTITY BEATS PROXIMITY. A caller that names the clip it is tracking is not
		// asking us to guess, so its closing edge is INCLUSIVE: the exclusive bound only
		// exists to break ties in the ambiguous scan below, and a named clip has no tie to
		// break. Sharing that bound is what made the last ~50 ms of a clip resolve to a
		// DIFFERENT clip over the same media — the preferred clip disowned its own final
		// frames and the scan handed them to whichever twin would take them, reporting the
		// playhead near the end of that twin. An asset mismatch means the id is stale (an
		// asset swap in flight), so it falls through to the scan rather than mapping the
		// time through a clip whose media is not the one playing.
		if (
			preferredIndex >= 0 &&
			(!assetId || clips[preferredIndex].assetId === assetId) &&
			isWithinClipBounds(clips[preferredIndex], sourceTimeSec, epsilon, "inclusive")
		) {
			return toPositionAt(clips, preferredIndex, sourceTimeSec);
		}
	}
	const scan = (closingEdge: ClosingEdge) =>
		clips.findIndex(
			(clip) =>
				(!assetId || clip.assetId === assetId) &&
				isWithinClipBounds(clip, sourceTimeSec, epsilon, closingEdge),
		);
	// Two passes, because "may this clip claim its closing edge?" is a question about the
	// OTHER clips — is anyone else about to start here? — and never about where the clip
	// sits in an array. This used to be approximated by `index === clips.length - 1`, which
	// made the answer depend on CLIP ORDER: with two clips over one recording, the last
	// array element accepted a closing edge its twin had just refused, so the same playback
	// moment resolved to a different clip depending on whether that twin happened to be laid
	// down last. Preferring a strict containment and only then falling back to the closing
	// edge gives the same result for a plain single-asset timeline (where the last clip is
	// the only one nobody follows) without consulting the order at all.
	const strict = scan("exclusive");
	const clipIndex = strict >= 0 ? strict : scan("inclusive");
	if (clipIndex < 0) return null;
	return toPositionAt(clips, clipIndex, sourceTimeSec);
}

/**
 * "Where am I in the KEPT content of the clip that is playing?" — the trim-aware
 * counterpart of {@link locateSourcePosition}, resolved against the playback segments
 * (`resolvePlaybackSegments`) instead of the raw clips.
 *
 * The segments of the ACTIVE clip are the whole answer once we know which clip is
 * playing: a source time none of them covers is inside THAT clip's trim, however many
 * other clips of the same media keep the stretch. Scanning every segment by
 * (assetId, sourceTime) — which is all this could do before trims carried a `clipId` —
 * let a twin clip's kept segment answer for the one actually playing, so a cut authored
 * on one clip was silently not skipped during playback while its twin kept that stretch.
 * That is the same wrong-clip class `trimAppliesToClip` closed on the storage side, one
 * layer up. Falls back to the asset-wide scan when the clip is unknown (no active clip
 * yet) or has no segments at all.
 */
export function locateKeptSegment(
	playbackClips: AxcutClip[],
	rawClips: AxcutClip[],
	sourceTimeSec: number,
	assetId?: string,
	activeClipId?: string,
): VirtualPosition | null {
	const ownSegments = activeClipId
		? playbackClips.filter((seg) => findRawClipForSegment(seg, rawClips)?.id === activeClipId)
		: [];
	if (ownSegments.length > 0) return locateSourcePosition(ownSegments, sourceTimeSec, assetId);
	return locateSourcePosition(playbackClips, sourceTimeSec, assetId);
}

export function keptWordIdSet(clips: AxcutClip[]): Set<string> {
	return new Set(clips.flatMap((clip) => clip.wordRefs));
}
