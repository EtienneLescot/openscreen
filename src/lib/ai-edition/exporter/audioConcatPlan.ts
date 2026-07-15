// AudioConcatPlan: pure-logic timing for the v2 multi-asset export audio track.
//
// ponytail: the v1 `documentExporter` runs a single continuous source stream
// (the primary asset), so audio "follows" video implicitly and the exporter
// just trims/speed-stretches one buffer end-to-end. The v2 renderer walks an
// ordered list of per-clip render segments (each drawing from its own source
// asset), so we have to concatenate N per-segment audio buffers into one
// output track — and the silence gaps for segments whose asset has no audio
// must be sized so A/V never drifts. This module computes the INTEGER sample
// accounting only; it does NOT decode, encode, resample, or touch WebCodecs
// / AudioContext. A downstream audio encoder/mixer reads the plan and emits
// the actual PCM.
//
// Integer accumulation matters (spec risk R5): each segment's audio length
// is rounded independently from its `outputFrameCount`, then offsets are the
// integer sum of prior rounded lengths. Never `round(cumulativeSeconds *
// sampleRate)` — that compounds per-segment rounding error across a long
// multi-segment timeline into audible A/V drift.

const DEFAULT_SAMPLE_RATE = 48_000;
const DEFAULT_CHANNELS = 2;

// One entry per RenderPlan segment (same order). The v2 segment loop supplies
// the output video frame count so audio can be locked 1:1 to the retimed
// video — same SSOT the video path uses (see audioEncoder's
// `round(frameCount / frameRate * sampleRate)` accounting).
export interface AudioConcatSegmentInput {
	clipId: string;
	// OUTPUT (virtual-timeline) video frames this segment renders. Audio is
	// sized from this so A/V never drifts — same SSOT the video path uses.
	outputFrameCount: number;
	// Whether this segment's asset has a usable audio track. When false, the
	// segment contributes SILENCE for its whole output duration (keeps A/V
	// aligned).
	hasAudio: boolean;
}

export interface AudioConcatSegmentPlan {
	clipId: string;
	startSample: number; // inclusive, output samples at `sampleRate`
	sampleCount: number; // samples this segment occupies in the concatenated output
	silence: boolean; // true → fill with silence (asset had no audio)
}

export interface AudioConcatPlan {
	sampleRate: number;
	channels: number;
	totalSamples: number; // sum of all segment sampleCounts
	segments: AudioConcatSegmentPlan[];
}

export interface BuildAudioConcatPlanOptions {
	frameRate: number;
	// Common output layout, chosen up-front by the caller (spec §6.3: from the
	// first segment with audio, or the 48 kHz stereo default). Defaulted here.
	sampleRate?: number; // default 48000
	channels?: number; // default 2
}

export function buildAudioConcatPlan(
	segments: AudioConcatSegmentInput[],
	options: BuildAudioConcatPlanOptions,
): AudioConcatPlan {
	const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
	const channels = options.channels ?? DEFAULT_CHANNELS;

	// Degenerate frameRate (0 or negative) → no segment can be sized without
	// divide-by-zero / NaN. Return a plan with all-zero sample counts rather
	// than throwing; the downstream encoder will still see a well-formed
	// (if empty) buffer layout and the timeline is otherwise deterministic.
	const frameRateValid = options.frameRate > 0;

	const plans: AudioConcatSegmentPlan[] = [];
	let cursor = 0;
	for (const seg of segments) {
		const sampleCount = frameRateValid
			? Math.max(0, Math.round((seg.outputFrameCount / options.frameRate) * sampleRate))
			: 0;
		plans.push({
			clipId: seg.clipId,
			startSample: cursor,
			sampleCount,
			silence: !seg.hasAudio,
		});
		cursor += sampleCount;
	}

	return {
		sampleRate,
		channels,
		totalSamples: cursor,
		segments: plans,
	};
}
