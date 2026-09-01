// How many frames the native exporter will actually emit for a timeline.
//
// The progress bar needs a total, and the native side does not send one — it reports a raw
// running count of composed frames and nothing else (see `throttled_progress` in
// `crates/compositor-view-napi/src/lib.rs`). Both callers used to compute that total as
// `sum(sourceEndSec - sourceStartSec) * fps`, which ignores speed regions entirely.
//
// That is the "frozen at ~80%" in OpenScreen#371, quite literally. A clip covered by a 1.25x
// speed region emits `duration * fps / 1.25` frames — exactly 80% of what that formula
// predicts — so the bar climbed to 80%, stopped, and the export finished there. The audio
// phase stalling on the render thread made it read as a hang, but even with instant audio
// the bar would never have reached 100%. A 0.5x region overshoots the other way and the bar
// pins at 100% for the second half of the export.
//
// This mirrors `speed_segments_for_window` + `push_speed_segment`
// (`crates/compositor/src/regions.rs`), which is what `walk_composited_timeline` iterates to
// decide how many frames a clip produces. The two must agree; `outputFrameCount.test.ts` and
// the Rust `speed_segments_match_the_exporter_frame_totals` test share one fixture table so
// a change on either side shows up as a failure rather than as a drifting progress bar.
//
// One difference is unavoidable: the walk clamps each clip's end to the source's real
// duration, which only a decoder can know. A source shorter than its declared window makes
// this count slightly high — the same limitation the old formula had, and the same one that
// already makes `build_audio_concat_plan` work off produced frames rather than declared ones.

/** `SPEED_FRAME_EPSILON_SEC` in `crates/compositor/src/regions.rs`. Absorbs the float error
 *  of a span boundary so a segment does not gain a frame it never renders. */
const SPEED_FRAME_EPSILON_SEC = 0.001;

/** `MIN_SPEED_SEGMENT_SEC` in the same file: a span thinner than this emits nothing. */
const MIN_SPEED_SEGMENT_SEC = 0.0001;

/** The trimmed source window of one clip, as `buildNativeClipList` produces it. */
export interface OutputFrameClip {
	sourceStartSec: number;
	sourceEndSec: number;
}

/** A speed region already projected onto source time — `SceneDescription.speedRegions`. */
export interface OutputFrameSpeedRegion {
	startSec: number;
	endSec: number;
	speed: number;
	/** Absent means "every clip", matching `Scene::for_clip_window`. */
	clipIndex?: number;
}

/** Frames one contiguous span renders. Port of `push_speed_segment`. */
function segmentFrames(startSec: number, endSec: number, speed: number, fps: number): number {
	const duration = endSec - startSec;
	if (duration <= MIN_SPEED_SEGMENT_SEC) {
		return 0;
	}
	return Math.max(0, Math.ceil(((duration - SPEED_FRAME_EPSILON_SEC) / speed) * fps));
}

/** Frames one clip renders across its speed spans. Port of `speed_segments_for_window`,
 *  including its overlap rule: regions are walked in start order and a later one never
 *  reclaims source time an earlier one already covered. */
export function clipOutputFrameCount(
	clip: OutputFrameClip,
	regions: OutputFrameSpeedRegion[],
	fps: number,
): number {
	const { sourceStartSec, sourceEndSec } = clip;
	if (!(sourceEndSec > sourceStartSec) || !Number.isFinite(fps) || fps <= 0) {
		return 0;
	}
	const overlapping = regions
		.filter((region) => region.startSec < sourceEndSec && region.endSec > sourceStartSec)
		.sort((a, b) => a.startSec - b.startSec);

	let frames = 0;
	let cursor = sourceStartSec;
	for (const region of overlapping) {
		const start = Math.max(region.startSec, sourceStartSec, cursor);
		const end = Math.min(region.endSec, sourceEndSec);
		if (start > cursor) {
			frames += segmentFrames(cursor, start, 1, fps);
		}
		if (end > start) {
			const speed = Number.isFinite(region.speed) && region.speed > 0 ? region.speed : 1;
			frames += segmentFrames(start, end, speed, fps);
			cursor = end;
		}
	}
	if (cursor < sourceEndSec) {
		frames += segmentFrames(cursor, sourceEndSec, 1, fps);
	}
	return frames;
}

/** Frames the whole export will emit, for turning the native running count into a
 *  percentage. Never returns 0, so the callers' division stays safe, and tolerates a missing
 *  region list — this is progress-bar arithmetic and must not be able to abort an export. */
export function outputFrameCount(
	clips: OutputFrameClip[],
	speedRegions: OutputFrameSpeedRegion[] | undefined,
	fps: number,
): number {
	const regions = speedRegions ?? [];
	const total = clips.reduce(
		(sum, clip, clipIndex) =>
			sum +
			clipOutputFrameCount(
				clip,
				regions.filter(
					(region) => region.clipIndex === undefined || region.clipIndex === clipIndex,
				),
				fps,
			),
		0,
	);
	return Math.max(1, total);
}
