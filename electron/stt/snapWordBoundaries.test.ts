import { describe, expect, it } from "vitest";
import { snapWordBoundariesToAudio } from "./snapWordBoundaries";
import type { SttWordSegment } from "./transcriptionContract";

const SAMPLE_RATE = 16_000;

/** Mono 16 kHz buffer that is loud everywhere except the given silent spans. */
function audioWithSilences(durationSec: number, silences: Array<[number, number]>): Float32Array {
	const samples = new Float32Array(Math.round(durationSec * SAMPLE_RATE));
	for (let i = 0; i < samples.length; i++) {
		const t = i / SAMPLE_RATE;
		const silent = silences.some(([from, to]) => t >= from && t < to);
		// Alternating ±0.5 gives a flat, non-zero RMS without needing a real tone.
		samples[i] = silent ? 0 : i % 2 === 0 ? 0.5 : -0.5;
	}
	return samples;
}

const word = (w: Partial<SttWordSegment> = {}): SttWordSegment => ({
	word: "w",
	startSec: 0,
	endSec: 0.1,
	...w,
});

describe("snapWordBoundariesToAudio", () => {
	it("pulls a late boundary back into the silence that precedes it", () => {
		// Speech stops at 1.0 and resumes at 1.2; whisper reports the next word
		// starting at 1.3 — 100 ms after the audio actually resumed.
		const samples = audioWithSilences(3, [[1.0, 1.2]]);
		const [snapped] = snapWordBoundariesToAudio([word({ startSec: 1.3, endSec: 1.8 })], samples);
		expect(snapped.startSec).toBeGreaterThanOrEqual(1.0);
		expect(snapped.startSec).toBeLessThan(1.2);
	});

	it("leaves a boundary alone when nothing quieter precedes it", () => {
		// A word ending a phrase: whisper is already right, the frames before the
		// boundary are all speech, so the quietest frame in the window is the
		// boundary itself and it must not drift.
		const samples = audioWithSilences(3, [[1.5, 2.0]]);
		const [snapped] = snapWordBoundariesToAudio([word({ startSec: 1.0, endSec: 1.5 })], samples);
		expect(snapped.endSec).toBeCloseTo(1.5, 2);
	});

	it("never moves a boundary more than the lookback window", () => {
		const samples = audioWithSilences(3, [[0.0, 1.0]]);
		const [snapped] = snapWordBoundariesToAudio([word({ startSec: 2.0, endSec: 2.5 })], samples);
		expect(snapped.startSec).toBeGreaterThanOrEqual(2.0 - 0.15);
	});

	it("keeps a boundary shared by two words shared", () => {
		const samples = audioWithSilences(3, [[1.0, 1.2]]);
		const [first, second] = snapWordBoundariesToAudio(
			[word({ startSec: 0.5, endSec: 1.3 }), word({ startSec: 1.3, endSec: 1.8 })],
			samples,
		);
		expect(first.endSec).toBeCloseTo(second.startSec, 6);
	});

	it("leaves boundaries that fall outside the decoded audio alone", () => {
		// Clamping these into range would collapse every boundary onto the end of
		// the buffer instead of leaving the unmeasurable ones untouched.
		const samples = audioWithSilences(0.1, []);
		const words = [word({ startSec: 5.51, endSec: 6.85 })];
		expect(snapWordBoundariesToAudio(words, samples)).toEqual(words);
	});

	it("keeps degenerate words non-empty and passes words through without audio", () => {
		const samples = audioWithSilences(3, [[1.0, 1.2]]);
		const [degenerate] = snapWordBoundariesToAudio([word({ startSec: 1.3, endSec: 1.3 })], samples);
		expect(degenerate.endSec).toBeGreaterThan(degenerate.startSec);

		const untouched = [word({ startSec: 1.3, endSec: 1.8 })];
		expect(snapWordBoundariesToAudio(untouched, new Float32Array(0))).toEqual(untouched);
	});
});
