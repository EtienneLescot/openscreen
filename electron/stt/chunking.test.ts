import { describe, expect, it } from "vitest";
import { planChunks } from "./chunking";

const RATE = 16_000;

/** Loud tone with silent gaps punched in at the given [startSec, endSec) ranges. */
function toneWithSilences(durationSec: number, silences: [number, number][]): Float32Array {
	const samples = new Float32Array(Math.round(durationSec * RATE));
	for (let i = 0; i < samples.length; i++) {
		samples[i] = Math.sin((i / RATE) * 2 * Math.PI * 440);
	}
	for (const [from, to] of silences) {
		samples.fill(0, Math.round(from * RATE), Math.round(to * RATE));
	}
	return samples;
}

describe("planChunks", () => {
	it("covers the whole buffer with contiguous chunks", () => {
		const samples = toneWithSilences(25, []);
		const chunks = planChunks(samples, RATE, { targetSec: 10, searchSec: 1 });
		expect(chunks[0].startSample).toBe(0);
		expect(chunks[chunks.length - 1].endSample).toBe(samples.length);
		for (let i = 1; i < chunks.length; i++) {
			expect(chunks[i].startSample).toBe(chunks[i - 1].endSample);
		}
	});

	it("cuts inside a pause rather than on the fixed grid", () => {
		// Pause at 9.5-9.9s: the ideal 10s boundary should be pulled back into it.
		const samples = toneWithSilences(25, [
			[9.5, 9.9],
			[19.4, 19.8],
		]);
		const chunks = planChunks(samples, RATE, { targetSec: 10, searchSec: 1 });
		const cutSec = chunks[0].endSample / RATE;
		expect(cutSec).toBeGreaterThanOrEqual(9.5);
		expect(cutSec).toBeLessThan(9.9);
	});

	it("returns a single chunk when the recording is shorter than the target", () => {
		const samples = toneWithSilences(5, []);
		expect(planChunks(samples, RATE, { targetSec: 120 })).toEqual([
			{ startSample: 0, endSample: samples.length },
		]);
	});

	it("always makes progress, even on a fully silent buffer", () => {
		// Every frame ties on energy, so the cut is whatever the scan settles on —
		// what matters is that it never returns a zero-length chunk (infinite loop).
		const samples = new Float32Array(60 * RATE);
		const chunks = planChunks(samples, RATE, { targetSec: 10, searchSec: 5 });
		for (const chunk of chunks) {
			expect(chunk.endSample).toBeGreaterThan(chunk.startSample);
		}
		expect(chunks[chunks.length - 1].endSample).toBe(samples.length);
	});

	it("handles an empty buffer", () => {
		expect(planChunks(new Float32Array(0), RATE)).toEqual([]);
	});
});
