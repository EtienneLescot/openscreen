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

export function locateSourcePosition(
	clips: AxcutClip[],
	sourceTimeSec: number,
	assetId?: string,
	epsilon = 0.05,
): VirtualPosition | null {
	const clipIndex = clips.findIndex((clip, index) => {
		if (assetId && clip.assetId !== assetId) return false;
		const lowerBound = clip.sourceStartSec - epsilon;
		const upperBound =
			index === clips.length - 1
				? (clip.sourceEndSec ?? 0) + epsilon
				: (clip.sourceEndSec ?? 0) - epsilon;
		return sourceTimeSec >= lowerBound && sourceTimeSec <= upperBound;
	});
	if (clipIndex < 0) return null;
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
