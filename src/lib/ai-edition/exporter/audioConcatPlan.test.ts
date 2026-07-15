import { describe, expect, it } from "vitest";
import { type AudioConcatSegmentInput, buildAudioConcatPlan } from "./audioConcatPlan";

// --- Factory helpers (lean: only fields the builder reads) --------------------

function seg(clipId: string, outputFrameCount: number, hasAudio: boolean): AudioConcatSegmentInput {
	return { clipId, outputFrameCount, hasAudio };
}

// --- Defaults + layout -------------------------------------------------------

describe("buildAudioConcatPlan — layout", () => {
	it("single segment with audio: sampleCount = round(300/30*48000)=480000, silence false, totalSamples 480000", () => {
		const plan = buildAudioConcatPlan([seg("c1", 300, true)], { frameRate: 30 });
		expect(plan.sampleRate).toBe(48_000);
		expect(plan.channels).toBe(2);
		expect(plan.totalSamples).toBe(480_000);
		expect(plan.segments).toEqual([
			{ clipId: "c1", startSample: 0, sampleCount: 480_000, silence: false },
		]);
	});

	it("defaults sampleRate=48000 and channels=2 when options omit them", () => {
		const plan = buildAudioConcatPlan([seg("c1", 0, true)], { frameRate: 30 });
		expect(plan.sampleRate).toBe(48_000);
		expect(plan.channels).toBe(2);
	});

	it("honors custom sampleRate=44100 and channels=1 in both the plan header and sample math", () => {
		// round(480/24 * 44100) = round(882000) = 882000 (exact integer — the
		// sample-math assertion still confirms the custom rate is plugged in).
		const plan = buildAudioConcatPlan([seg("c1", 480, true)], {
			frameRate: 24,
			sampleRate: 44_100,
			channels: 1,
		});
		expect(plan.sampleRate).toBe(44_100);
		expect(plan.channels).toBe(1);
		expect(plan.segments[0].sampleCount).toBe(882_000);
		expect(plan.totalSamples).toBe(882_000);
	});
});

// --- Offsets + integer accumulation (R5) -------------------------------------

describe("buildAudioConcatPlan — offsets", () => {
	it("three audio segments: startSample[i] = sum(prior sampleCounts); totalSamples = sum(all)", () => {
		// frameRate 60, sampleRate 48000 → sampleCount = outputFrameCount * 800.
		const plans = buildAudioConcatPlan(
			[seg("a", 60, true), seg("b", 30, true), seg("c", 90, true)],
			{ frameRate: 60 },
		);
		expect(plans.segments.map((s) => s.startSample)).toEqual([0, 48_000, 72_000]);
		expect(plans.segments.map((s) => s.sampleCount)).toEqual([48_000, 24_000, 72_000]);
		expect(plans.totalSamples).toBe(48_000 + 24_000 + 72_000);
		// cumulative-shapes equivalence for exact-integer math.
		expect(plans.totalSamples).toBe(0 + 48_000 + 24_000 + 72_000);
	});

	it("silence padding: a hasAudio=false segment occupies its full sampleCount and shifts the next startSample", () => {
		// frameRate 30, sampleRate 48000 → sampleCount = outputFrameCount * 1600.
		const plans = buildAudioConcatPlan(
			[seg("a", 30, true), seg("b", 15, false), seg("c", 30, true)],
			{ frameRate: 30 },
		);
		expect(plans.segments).toEqual([
			{ clipId: "a", startSample: 0, sampleCount: 48_000, silence: false },
			{ clipId: "b", startSample: 48_000, sampleCount: 24_000, silence: true },
			{ clipId: "c", startSample: 72_000, sampleCount: 48_000, silence: false },
		]);
		expect(plans.totalSamples).toBe(48_000 + 24_000 + 48_000);
	});

	it("mixed [audio, no-audio, audio]: offsets correct, only the middle flagged silence", () => {
		const plans = buildAudioConcatPlan(
			[seg("a", 30, true), seg("b", 15, false), seg("c", 30, true)],
			{ frameRate: 30 },
		);
		expect(plans.segments.map((s) => s.silence)).toEqual([false, true, false]);
		// startSample[2] is exactly startSample[1] + sampleCount[1] (no rounding
		// shortcut) — A/V stays locked through the silence gap.
		expect(plans.segments[2].startSample).toBe(
			plans.segments[1].startSample + plans.segments[1].sampleCount,
		);
	});

	it("integer accumulation / no drift (R5): startSample[i] === sum(prior sampleCounts), NOT round(cumulativeSeconds * sampleRate)", () => {
		// frameRate 24, sampleRate 44100, frameCount 1 → round(1837.5) = 1838
		// per segment. The fractional intermediate is the whole point — summing
		// the rounded integers must NOT equal round(cumulativeSeconds * sr).
		const plans = buildAudioConcatPlan(
			[seg("s1", 1, true), seg("s2", 1, true), seg("s3", 1, true)],
			{ frameRate: 24, sampleRate: 44_100 },
		);

		// Every output field is an integer (no half-sample leakage anywhere).
		for (const s of plans.segments) {
			expect(Number.isInteger(s.startSample)).toBe(true);
			expect(Number.isInteger(s.sampleCount)).toBe(true);
		}
		expect(Number.isInteger(plans.totalSamples)).toBe(true);

		// Each segment = 1838 samples (= round(1/24 * 44100)).
		expect(plans.segments.map((s) => s.sampleCount)).toEqual([1838, 1838, 1838]);

		// Integer accumulation: startSample[i] is the SUM of prior sampleCounts.
		expect(plans.segments.map((s) => s.startSample)).toEqual([0, 1838, 3676]);
		expect(plans.totalSamples).toBe(5514);

		// …which DIFFERS from `round(cumulativeSeconds * sampleRate)` (the
		// drift-prone shortcut). Document the gap explicitly so a future refactor
		// can't accidentally swap integer accumulation for cumulative rounding.
		const sampleRate = plans.sampleRate;
		const frameRate = 24;
		const cumRoundedAt = (n: number) => Math.round(((n * 1) / frameRate) * sampleRate);
		expect(cumRoundedAt(1)).toBe(1838); // matches — boundary case
		expect(cumRoundedAt(2)).toBe(3675); // ≠ 3676 (drift by 1)
		expect(cumRoundedAt(3)).toBe(5513); // ≠ 5514 (drift by 1)
	});
});

// --- Degenerate inputs --------------------------------------------------------

describe("buildAudioConcatPlan — degenerate inputs", () => {
	it("zero segments → empty segments, totalSamples 0, layout still set", () => {
		const plan = buildAudioConcatPlan([], { frameRate: 30 });
		expect(plan.segments).toEqual([]);
		expect(plan.totalSamples).toBe(0);
		expect(plan.sampleRate).toBe(48_000);
		expect(plan.channels).toBe(2);
	});

	it("zero-length segment: outputFrameCount 0 → sampleCount 0, next startSample unchanged", () => {
		const plan = buildAudioConcatPlan([seg("a", 30, true), seg("b", 0, true), seg("c", 30, true)], {
			frameRate: 30,
		});
		expect(plan.segments).toEqual([
			{ clipId: "a", startSample: 0, sampleCount: 48_000, silence: false },
			{ clipId: "b", startSample: 48_000, sampleCount: 0, silence: false },
			{ clipId: "c", startSample: 48_000, sampleCount: 48_000, silence: false },
		]);
		expect(plan.totalSamples).toBe(96_000);
	});

	it("frameRate = 0 guard: all sampleCounts 0, totalSamples 0, no NaN (no throw)", () => {
		const plan = buildAudioConcatPlan(
			[seg("a", 100, true), seg("b", 200, false), seg("c", 300, true)],
			{ frameRate: 0 },
		);
		expect(plan.segments).toEqual([
			{ clipId: "a", startSample: 0, sampleCount: 0, silence: false },
			{ clipId: "b", startSample: 0, sampleCount: 0, silence: true },
			{ clipId: "c", startSample: 0, sampleCount: 0, silence: false },
		]);
		expect(plan.totalSamples).toBe(0);
		// Explicit NaN sweep — divide-by-zero / Infinity must NOT leak through.
		for (const s of plan.segments) {
			expect(Number.isNaN(s.startSample)).toBe(false);
			expect(Number.isNaN(s.sampleCount)).toBe(false);
		}
		expect(Number.isNaN(plan.totalSamples)).toBe(false);
	});

	it("frameRate < 0 guard: negative frameRate treated the same as zero (degenerate, no NaN)", () => {
		const plan = buildAudioConcatPlan([seg("a", 100, true)], { frameRate: -30 });
		expect(plan.segments).toEqual([
			{ clipId: "a", startSample: 0, sampleCount: 0, silence: false },
		]);
		expect(plan.totalSamples).toBe(0);
		expect(Number.isNaN(plan.totalSamples)).toBe(false);
	});
});
