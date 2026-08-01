// Vendored for the CLI: @/lib/captioning/leadingSilence was deleted in the 1.8 line. The CLI's captions command still trims leading silence before transcription, so the module lives on here verbatim.

/** Caption path is always mono 16 kHz after `extractMono16kFromVideoUrl`. */
import type { TrimRegion } from "@/components/video-editor/types";

const SAMPLE_RATE = 16_000;

/** Window length for peak detection (~50 ms). */
const WINDOW_SAMPLES = 800;

/** Coarse hop so long intros scan quickly (~50 ms steps). */
const HOP_SAMPLES = 800;

/** Max |sample| in a window below this counts as silence (float PCM ~[-1, 1]). */
const PEAK_THRESHOLD = 0.012;

/** Keep a little audio before the first peak so word onsets are not clipped. */
const PRE_ROLL_SEC = 0.12;

/** Do not scan more than this much audio for leading silence (performance + pathological files). */
const MAX_LEADING_SCAN_SEC = 15 * 60;

/**
 * Drops quiet audio at the beginning so Whisper is not fed a long silent prefix (which can skew
 * the first phrase and wastes work). Returned `trimSec` must be added back to every segment time.
 */
export function trimLeadingSilenceMono16k(samples: Float32Array): {
	samples: Float32Array;
	trimSec: number;
} {
	if (samples.length < WINDOW_SAMPLES) {
		return { samples, trimSec: 0 };
	}

	const maxIndex = Math.min(
		samples.length - WINDOW_SAMPLES,
		Math.floor(MAX_LEADING_SCAN_SEC * SAMPLE_RATE),
	);

	let firstSpeechSample = -1;
	for (let i = 0; i <= maxIndex; i += HOP_SAMPLES) {
		let peak = 0;
		for (let j = 0; j < WINDOW_SAMPLES; j++) {
			peak = Math.max(peak, Math.abs(samples[i + j]!));
		}
		if (peak > PEAK_THRESHOLD) {
			firstSpeechSample = i;
			break;
		}
	}

	if (firstSpeechSample <= 0) {
		return { samples, trimSec: 0 };
	}

	const preRollSamples = Math.round(PRE_ROLL_SEC * SAMPLE_RATE);
	const start = Math.max(0, firstSpeechSample - preRollSamples);
	return {
		samples: samples.subarray(start),
		trimSec: start / SAMPLE_RATE,
	};
}

/**
 * When audio is trimmed from the front, Whisper times are relative to the shortened buffer.
 * Shift trim regions by the same offset so `segmentOverlapsTrim` still uses consistent coordinates.
 */
export function shiftTrimRegionsMsForCaptionBuffer(
	regions: TrimRegion[],
	trimMs: number,
): TrimRegion[] {
	if (trimMs <= 0) return regions;
	return regions
		.map((r) => ({
			...r,
			startMs: Math.max(0, r.startMs - trimMs),
			endMs: Math.max(0, r.endMs - trimMs),
		}))
		.filter((r) => r.endMs > r.startMs);
}
