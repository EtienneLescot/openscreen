import type { AxcutClip } from "@/lib/ai-edition/schema";

export interface NativePlaybackPosition {
	clip: AxcutClip;
	/** Index in timeline order, matching SceneDescription.clips when the caller passes visible clips. */
	clipIndex: number;
	/** Screen-source seconds expected by the native decoder for this clip. */
	sourceTimeSec: number;
}

/**
 * Resolve an app timeline playhead to the active clip's screen-source clock.
 *
 * Native `presentTime` and `setActiveClip` do not consume absolute timeline
 * seconds: both decoders seek in the active asset, with webcam time derived as
 * `screenSourceTime - webcamOffset`. Keeping this conversion pure and shared
 * prevents paused scrubs and clip-boundary switches from using different clocks.
 */
export function resolveNativePlaybackPosition(
	clips: readonly AxcutClip[],
	timelineTimeSec: number,
): NativePlaybackPosition | null {
	if (!Number.isFinite(timelineTimeSec) || clips.length === 0) return null;

	const ordered = [...clips].sort((a, b) => a.timelineStartSec - b.timelineStartSec);
	const clipIndex = ordered.findIndex((clip, index) => {
		const isLast = index === ordered.length - 1;
		return (
			timelineTimeSec >= clip.timelineStartSec &&
			(timelineTimeSec < clip.timelineEndSec || (isLast && timelineTimeSec <= clip.timelineEndSec))
		);
	});
	if (clipIndex < 0) return null;

	const clip = ordered[clipIndex];
	const unclampedSourceTime = clip.sourceStartSec + (timelineTimeSec - clip.timelineStartSec);
	const maxAllowedSourceTime =
		clip.sourceEndSec !== undefined
			? Math.max(clip.sourceStartSec, clip.sourceEndSec - 0.033)
			: unclampedSourceTime;
	return {
		clip,
		clipIndex,
		sourceTimeSec: Math.max(
			clip.sourceStartSec,
			Math.min(maxAllowedSourceTime, unclampedSourceTime),
		),
	};
}
