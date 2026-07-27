// Pulls whisper.cpp's DTW word boundaries back onto the audio they describe.
//
// whisper.cpp reports one time per token and derives word spans from it, so a
// word's `start` is the point where the decoder *emitted* the token, not where
// the speaker started saying it. Measured on real recordings, that lands
// consistently 80–150 ms late, and because consecutive words share a boundary
// (`word[i].end === word[i+1].start`) the whole transcript is dragged right by
// roughly a syllable.
//
// That is invisible in captions but not in the transcript editor: deleting
// words there turns the selection into a trim of exactly
// `[firstWord.startSec, lastWord.endSec]`, so a late boundary leaves the attack
// of the first removed word audible and bites into the following kept word.
//
// The correction is to look at the audio instead of guessing an offset: each
// boundary moves back to the quietest 10 ms frame within the preceding
// `LOOKBACK_SEC`. It is self-limiting — on a decaying tail (a word that ends a
// phrase, where whisper is already right) the quietest frame IS the reported
// one, so the boundary doesn't move at all.

import type { SttWordSegment } from "./transcriptionContract";

/** Matches `writeSamplesAsWav` — the samples handed to whisper are mono 16 kHz. */
const SAMPLE_RATE = 16_000;

/** RMS envelope resolution; finer than any boundary error worth correcting. */
const FRAME_SEC = 0.01;

/**
 * How far back a boundary may travel — the calibration knob for this
 * correction. Sized to the measured DTW lag (~80–150 ms). Widen it and
 * boundaries inside continuous speech start snapping onto the *previous*
 * syllable's trough; narrow it and the lag survives.
 */
const LOOKBACK_SEC = 0.15;

/** Keep degenerate words (whisper sometimes reports end <= start) non-empty. */
const MIN_WORD_SEC = 0.02;

/** Per-frame RMS of the mono signal — the cheapest usable "is this speech" proxy. */
function rmsEnvelope(samples: Float32Array): Float32Array {
	const frameLength = Math.round(SAMPLE_RATE * FRAME_SEC);
	const frameCount = Math.floor(samples.length / frameLength);
	const envelope = new Float32Array(frameCount);
	for (let f = 0; f < frameCount; f++) {
		const start = f * frameLength;
		let sum = 0;
		for (let i = start; i < start + frameLength; i++) {
			const v = samples[i] ?? 0;
			sum += v * v;
		}
		envelope[f] = Math.sqrt(sum / frameLength);
	}
	return envelope;
}

/**
 * Move every word boundary back to the quietest frame in the `LOOKBACK_SEC`
 * preceding it. Boundaries shared by two words snap identically (same input
 * time), so the transcript stays gap-free where whisper made it gap-free.
 * Returns the words unchanged when there is no audio to measure against.
 */
export function snapWordBoundariesToAudio(
	words: SttWordSegment[],
	samples: Float32Array,
): SttWordSegment[] {
	const envelope = rmsEnvelope(samples);
	if (envelope.length === 0) return words;

	const lookbackFrames = Math.round(LOOKBACK_SEC / FRAME_SEC);
	const snap = (timeSec: number): number => {
		const hi = Math.round(timeSec / FRAME_SEC);
		// A boundary outside the audio we can measure (whisper occasionally reports
		// times past the end of the samples) has nothing to snap to — clamping it
		// into range would drag it to the end of the buffer instead.
		if (hi <= 0 || hi >= envelope.length) return timeSec;
		const lo = Math.max(0, hi - lookbackFrames);
		let bestFrame = hi;
		let bestRms = envelope[hi];
		// Strict `<` while walking backwards keeps the frame CLOSEST to the
		// reported boundary when a whole stretch is equally quiet, so digital
		// silence can't drag a boundary the full window.
		for (let f = hi - 1; f >= lo; f--) {
			if (envelope[f] < bestRms) {
				bestRms = envelope[f];
				bestFrame = f;
			}
		}
		return bestFrame * FRAME_SEC;
	};

	return words.map((w) => {
		const startSec = snap(w.startSec);
		return {
			...w,
			startSec,
			endSec: Math.max(snap(w.endSec), startSec + MIN_WORD_SEC),
		};
	});
}
