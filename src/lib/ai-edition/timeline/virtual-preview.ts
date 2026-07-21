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
 * Maps a kept segment (`AxcutClip` from `resolvePlaybackSegments`) back to its
 * exact start position on the raw (untrimmed) document timeline.
 */
export function getRawVirtualStartTime(segment: AxcutClip, rawClips: AxcutClip[]): number {
	const rawClip =
		rawClips.find((c) => c.id === segment.id || segment.id.startsWith(`${c.id}_seg`)) ??
		rawClips.find(
			(c) =>
				c.assetId === segment.assetId &&
				segment.sourceStartSec >= c.sourceStartSec - 0.001 &&
				(c.sourceEndSec == null || segment.sourceStartSec <= c.sourceEndSec + 0.001),
		);

	if (!rawClip) return segment.timelineStartSec;
	return rawClip.timelineStartSec + (segment.sourceStartSec - rawClip.sourceStartSec);
}

/**
 * Resolves the next kept segment on the virtual timeline at or after the given position.
 * `playbackClips` (from `resolvePlaybackSegments`) is the SSOT for kept timeline content.
 */
export function findNextKeptSegment(
	playbackClips: AxcutClip[],
	rawClips: AxcutClip[],
	currentRawTime: number,
	activeSourceId?: string,
	currentSourceTime?: number,
): AxcutClip | undefined {
	for (const seg of playbackClips) {
		const segRawStart = getRawVirtualStartTime(seg, rawClips);
		if (segRawStart > currentRawTime + 0.001) {
			return seg;
		}
		if (
			activeSourceId &&
			currentSourceTime !== undefined &&
			seg.assetId === activeSourceId &&
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

function isWithinClipBounds(
	clip: AxcutClip,
	index: number,
	total: number,
	sourceTimeSec: number,
	epsilon: number,
): boolean {
	const lowerBound = clip.sourceStartSec - epsilon;
	const upperBound =
		index === total - 1 ? (clip.sourceEndSec ?? 0) + epsilon : (clip.sourceEndSec ?? 0) - epsilon;
	return sourceTimeSec >= lowerBound && sourceTimeSec <= upperBound;
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
		if (
			preferredIndex >= 0 &&
			isWithinClipBounds(
				clips[preferredIndex],
				preferredIndex,
				clips.length,
				sourceTimeSec,
				epsilon,
			)
		) {
			return toPositionAt(clips, preferredIndex, sourceTimeSec);
		}
	}
	const clipIndex = clips.findIndex((clip, index) => {
		if (assetId && clip.assetId !== assetId) return false;
		return isWithinClipBounds(clip, index, clips.length, sourceTimeSec, epsilon);
	});
	if (clipIndex < 0) return null;
	return toPositionAt(clips, clipIndex, sourceTimeSec);
}

export function keptWordIdSet(clips: AxcutClip[]): Set<string> {
	return new Set(clips.flatMap((clip) => clip.wordRefs));
}

export function formatSeconds(value: number): string {
	const safe = Math.max(0, value);
	const hours = Math.floor(safe / 3600);
	const minutes = Math.floor((safe % 3600) / 60);
	const seconds = safe % 60;
	if (hours > 0) {
		return `${hours}:${String(minutes).padStart(2, "0")}:${seconds.toFixed(1).padStart(4, "0")}`;
	}
	return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}
