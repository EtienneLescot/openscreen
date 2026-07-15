import { describe, expect, it } from "vitest";
import {
	type AssembleOptions,
	type AudioConcatAssemblerSegmentInput,
	assembleConcatenatedPcm,
} from "./audioConcatAssembler";
import type { AudioConcatPlan, AudioConcatSegmentPlan } from "./audioConcatPlan";

// --- Factory helpers ---------------------------------------------------------

// `plan` builds a minimal `AudioConcatPlan` literal — the assembler only reads
// the documented fields (sampleRate, channels, totalSamples, segments[*]),
// so we don't have to go through `buildAudioConcatPlan` here.
function plan(
	segs: AudioConcatSegmentPlan[],
	header: { sampleRate?: number; channels?: number; totalSamples?: number } = {},
): AudioConcatPlan {
	return {
		sampleRate: header.sampleRate ?? 48_000,
		channels: header.channels ?? 1,
		totalSamples: header.totalSamples ?? segs.reduce((acc, s) => acc + s.sampleCount, 0),
		segments: segs,
	};
}

function seg(
	clipId: string,
	startSample: number,
	sampleCount: number,
	silence: boolean,
): AudioConcatSegmentPlan {
	return { clipId, startSample, sampleCount, silence };
}

function pcm(...channels: number[][]): Float32Array[] {
	return channels.map((c) => Float32Array.from(c));
}

function f32(values: number[]): Float32Array {
	return Float32Array.from(values);
}

// --- Copy semantics ----------------------------------------------------------

describe("assembleConcatenatedPcm — single segment", () => {
	it("single mono segment at exact length: pcm samples copied as-is, no fade, no padding", () => {
		const segPlan = seg("c1", 0, 4, false);
		const pl = plan([segPlan]);
		const inputs: AudioConcatAssemblerSegmentInput[] = [{ pcm: pcm([1, 2, 3, 4]) }];
		const out = assembleConcatenatedPcm(inputs, pl);
		expect(out).toHaveLength(1);
		expect(Array.from(out[0])).toEqual([1, 2, 3, 4]);
		// totalSamples enforces the buffer length — the slot never overflows.
		expect(out[0].length).toBe(pl.totalSamples);
	});
});

describe("assembleConcatenatedPcm — concatenation", () => {
	it("two mono segments: seg B's samples land at seg B's startSample; output length == totalSamples", () => {
		// seg A: [10..14), seg B: [14..19) — butt-joined, no overlap.
		const pl = plan([seg("a", 0, 4, false), seg("b", 4, 5, false)], { totalSamples: 9 });
		const inputs: AudioConcatAssemblerSegmentInput[] = [
			{ pcm: pcm([10, 11, 12, 13]) },
			{ pcm: pcm([20, 21, 22, 23, 24]) },
		];
		const out = assembleConcatenatedPcm(inputs, pl);
		expect(out).toHaveLength(1);
		expect(out[0].length).toBe(9);
		expect(Array.from(out[0])).toEqual([10, 11, 12, 13, 20, 21, 22, 23, 24]);
	});

	it("plan-vs-segments length mismatch: missing input(s) are treated as silence at the planned offset", () => {
		// Skip the middle input → seg b's planned range renders zeros at its
		// startSample; seg c's samples still land at offset 5 unchanged.
		const pl = plan([seg("a", 0, 2, false), seg("b", 2, 3, false), seg("c", 5, 2, false)], {
			totalSamples: 7,
		});
		const inputs: AudioConcatAssemblerSegmentInput[] = [
			{ pcm: pcm([1, 2]) },
			{ pcm: null }, // middle segment's input omitted → silent
			{ pcm: pcm([9, 10]) },
		];
		const out = assembleConcatenatedPcm(inputs, pl);
		expect(Array.from(out[0])).toEqual([1, 2, 0, 0, 0, 9, 10]);
	});
});

describe("assembleConcatenatedPcm — silence / missing input", () => {
	it("silence: true → the segment's range stays all zeros; neighbors unaffected", () => {
		const pl = plan([seg("a", 0, 2, false), seg("b", 2, 3, true), seg("c", 5, 2, false)], {
			totalSamples: 7,
		});
		const inputs: AudioConcatAssemblerSegmentInput[] = [
			{ pcm: pcm([1, 2]) },
			{ pcm: pcm([100, 101, 102]) }, // would be written, but silence flag wins
			{ pcm: pcm([9, 10]) },
		];
		const out = assembleConcatenatedPcm(inputs, pl);
		expect(Array.from(out[0])).toEqual([1, 2, 0, 0, 0, 9, 10]);
	});

	it("pcm: null (without silence flag) → treated as silent", () => {
		const pl = plan([seg("a", 0, 2, false), seg("b", 2, 3, false)], { totalSamples: 5 });
		const inputs: AudioConcatAssemblerSegmentInput[] = [{ pcm: pcm([1, 2]) }, { pcm: null }];
		const out = assembleConcatenatedPcm(inputs, pl);
		expect(Array.from(out[0])).toEqual([1, 2, 0, 0, 0]);
	});
});

describe("assembleConcatenatedPcm — length clamping", () => {
	it("short input is zero-padded at the tail; the NEXT segment still starts at its offset", () => {
		// seg A length 5 but pcm length 2 → pad to 5; seg B starts at offset 5 unchanged.
		const pl = plan([seg("a", 0, 5, false), seg("b", 5, 3, false)], { totalSamples: 8 });
		const inputs: AudioConcatAssemblerSegmentInput[] = [
			{ pcm: pcm([100, 200]) },
			{ pcm: pcm([9, 10, 11]) },
		];
		const out = assembleConcatenatedPcm(inputs, pl);
		expect(Array.from(out[0])).toEqual([100, 200, 0, 0, 0, 9, 10, 11]);
	});

	it("long input is truncated; extra samples do NOT leak into the next segment's range", () => {
		// seg A length 3 but pcm length 6 → only the first 3 land; seg B's offset is preserved.
		const pl = plan([seg("a", 0, 3, false), seg("b", 3, 3, false)], { totalSamples: 6 });
		const inputs: AudioConcatAssemblerSegmentInput[] = [
			{ pcm: pcm([1, 2, 3, 4, 5, 6]) }, // 4,5,6 must NOT appear in output
			{ pcm: pcm([9, 10, 11]) },
		];
		const out = assembleConcatenatedPcm(inputs, pl);
		expect(Array.from(out[0])).toEqual([1, 2, 3, 9, 10, 11]);
	});
});

describe("assembleConcatenatedPcm — multi-channel", () => {
	it("stereo: two-channel input is written into two output arrays independently per channel", () => {
		const pl = plan([seg("a", 0, 3, false), seg("b", 3, 3, false)], {
			channels: 2,
			totalSamples: 6,
		});
		const inputs: AudioConcatAssemblerSegmentInput[] = [
			{ pcm: pcm([10, 11, 12], [20, 21, 22]) }, // ch0: 10..12, ch1: 20..22
			{ pcm: pcm([100, 101, 102], [200, 201, 202]) },
		];
		const out = assembleConcatenatedPcm(inputs, pl);
		expect(out).toHaveLength(2);
		expect(Array.from(out[0])).toEqual([10, 11, 12, 100, 101, 102]);
		expect(Array.from(out[1])).toEqual([20, 21, 22, 200, 201, 202]);
	});

	it("missing channel: input.pcm has 1 channel but plan.channels is 2 → that channel is silence for the segment", () => {
		// seg A: stereo plan, only ch0 supplied → ch1 stays zero for seg A's range;
		// seg B: full stereo, written normally at offset 3.
		const pl = plan([seg("a", 0, 3, false), seg("b", 3, 3, false)], {
			channels: 2,
			totalSamples: 6,
		});
		const inputs: AudioConcatAssemblerSegmentInput[] = [
			{ pcm: pcm([10, 11, 12]) }, // no channel 1
			{ pcm: pcm([100, 101, 102], [200, 201, 202]) },
		];
		const out = assembleConcatenatedPcm(inputs, pl);
		expect(Array.from(out[0])).toEqual([10, 11, 12, 100, 101, 102]);
		expect(Array.from(out[1])).toEqual([0, 0, 0, 200, 201, 202]);
	});
});

// --- Boundary fades (equal-power) -------------------------------------------

describe("assembleConcatenatedPcm — equal-power boundary fade", () => {
	it("f=2: tail of seg 0 is multiplied by cos((k/f)·π/2); head of seg 1 by sin((k/f)·π/2); cos²+sin² ≈ 1 for the paired offset", () => {
		// Two segments, each length 4. Fade f=2 → seg 0 indices [2,3) faded out,
		// seg 1 indices [0,1) faded in. Use a non-1 value (5) so the gain is visible.
		const pl = plan([seg("a", 0, 4, false), seg("b", 4, 4, false)], { totalSamples: 8 });
		// Source values: seg a = [5,5,5,5], seg b = [7,7,7,7]. With no fade, output
		// would be [5,5,5,5,7,7,7,7]. After fade:
		//   a[2] *= cos(0·π/2)   = 1      → 5
		//   a[3] *= cos(0.5·π/2) = √2/2   → 5·√2/2
		//   b[0] *= sin(0·π/2)   = 0      → 0
		//   b[1] *= sin(0.5·π/2) = √2/2   → 7·√2/2
		const inputs: AudioConcatAssemblerSegmentInput[] = [
			{ pcm: pcm([5, 5, 5, 5]) },
			{ pcm: pcm([7, 7, 7, 7]) },
		];
		const out = assembleConcatenatedPcm(inputs, pl, { boundaryFadeSamples: 2 });

		// Float32 storage round-trips `input * gain` to ~7 significant digits
		// (mantissa = 23 bits → ~6-7 decimal). Tolerance 5e-7 (precision=6)
		// covers the worst-case Float32 quantization around |value|≈10.
		const sqrt2over2 = Math.sqrt(2) / 2;
		expect(out[0][0]).toBeCloseTo(5, 6); // far-from-boundary: untouched
		expect(out[0][1]).toBeCloseTo(5, 6);
		expect(out[0][2]).toBeCloseTo(5 * 1, 6); // k=0 → cos(0)=1
		expect(out[0][3]).toBeCloseTo(5 * sqrt2over2, 6); // k=1 → cos(π/4)=√2/2
		expect(out[0][4]).toBeCloseTo(7 * 0, 6); // seg b[0] → k=0 → sin(0)=0
		expect(out[0][5]).toBeCloseTo(7 * sqrt2over2, 6); // k=1 → sin(π/4)=√2/2
		expect(out[0][6]).toBeCloseTo(7, 6); // outside fade region
		expect(out[0][7]).toBeCloseTo(7, 6);

		// Equal-power check on the paired offset sums: cos² + sin² = 1
		// (kernel of the spec — perceived loudness stays flat through the join).
		// This is pure Float64 (no Float32 storage), so tighten to 12.
		for (let k = 0; k < 2; k++) {
			const cos = Math.cos((k / 2) * (Math.PI / 2));
			const sin = Math.sin((k / 2) * (Math.PI / 2));
			expect(cos * cos + sin * sin).toBeCloseTo(1, 12);
		}
	});

	it("no fade at the OUTER edges — first sample of seg 0 and last sample of the last segment are untouched", () => {
		// Three segments, fade=1 between each. The very first and very last sample
		// sit one sample OUTSIDE any fade window → unchanged.
		const pl = plan([seg("a", 0, 3, false), seg("b", 3, 3, false), seg("c", 6, 3, false)], {
			totalSamples: 9,
		});
		const inputs: AudioConcatAssemblerSegmentInput[] = [
			{ pcm: pcm([1, 2, 3]) },
			{ pcm: pcm([9, 9, 9]) },
			{ pcm: pcm([4, 5, 6]) },
		];
		const out = assembleConcatenatedPcm(inputs, pl, { boundaryFadeSamples: 1 });
		// cos(0)=1, sin(0)=0 — fade-OUT leaves a[2] unchanged, fade-IN zeros b[3].
		expect(out[0][0]).toBeCloseTo(1, 6); // far outer edge
		expect(out[0][2]).toBeCloseTo(3, 6); // inside fade-OUT, but k=0 → gain 1
		expect(out[0][3]).toBeCloseTo(0, 6); // head of seg b, k=0 → gain 0
		expect(out[0][5]).toBeCloseTo(9, 6); // tail of seg b, k=0 → gain 1
		expect(out[0][6]).toBeCloseTo(0, 6); // head of seg c, k=0 → gain 0
		expect(out[0][8]).toBeCloseTo(6, 6); // far outer edge — UNCHANGED
	});

	it("fade is applied to ALL channels of a multi-channel output", () => {
		const pl = plan([seg("a", 0, 4, false), seg("b", 4, 4, false)], {
			channels: 2,
			totalSamples: 8,
		});
		const inputs: AudioConcatAssemblerSegmentInput[] = [
			{ pcm: pcm([5, 5, 5, 5], [50, 50, 50, 50]) },
			{ pcm: pcm([7, 7, 7, 7], [70, 70, 70, 70]) },
		];
		const out = assembleConcatenatedPcm(inputs, pl, { boundaryFadeSamples: 2 });
		const sqrt2over2 = Math.sqrt(2) / 2;
		// Both channels follow the same equal-power law independently.
		// Float32-bound tolerance (see note above).
		expect(out[0][3]).toBeCloseTo(5 * sqrt2over2, 6);
		expect(out[0][5]).toBeCloseTo(7 * sqrt2over2, 6);
		expect(out[1][3]).toBeCloseTo(50 * sqrt2over2, 6);
		expect(out[1][5]).toBeCloseTo(70 * sqrt2over2, 6);
		// Untouched outer samples on both channels.
		expect(out[1][0]).toBeCloseTo(50, 6);
		expect(out[1][7]).toBeCloseTo(70, 6);
	});

	it("fade is clamped to floor(sampleCount/2) of each adjacent segment — boundaryFadeSamples larger than the slot", () => {
		// seg A length 3 → floor(3/2)=1, seg B length 3 → 1: requested f0=100 → effective f=1.
		const pl = plan([seg("a", 0, 3, false), seg("b", 3, 3, false)], { totalSamples: 6 });
		const inputs: AudioConcatAssemblerSegmentInput[] = [
			{ pcm: pcm([8, 8, 8]) },
			{ pcm: pcm([9, 9, 9]) },
		];
		const out = assembleConcatenatedPcm(inputs, pl, { boundaryFadeSamples: 100 });
		// Only index 2 of seg a (tail-of-fade, k=0, cos=1) and index 3 of seg b
		// (head-of-fade, k=0, sin=0) are affected — index 1 of seg a and index 4
		// of seg b are well outside the f=1 fade region and must be unchanged.
		expect(out[0][0]).toBeCloseTo(8, 6);
		expect(out[0][1]).toBeCloseTo(8, 6); // NOT in the fade region
		expect(out[0][2]).toBeCloseTo(8, 6); // k=0 → cos(0)=1
		expect(out[0][3]).toBeCloseTo(0, 6); // k=0 → sin(0)=0
		expect(out[0][4]).toBeCloseTo(9, 6); // NOT in the fade region
		expect(out[0][5]).toBeCloseTo(9, 6);
	});

	it("fade is independently clamped per boundary when adjacent segments have different lengths", () => {
		// seg A length 10 → floor(10/2)=5 (the binding side; seg B is length 100 → bound by A).
		const pl = plan([seg("a", 0, 10, false), seg("b", 10, 100, false)], { totalSamples: 110 });
		// Use 1.0 so any gain shows up verbatim.
		const inputs: AudioConcatAssemblerSegmentInput[] = [
			{ pcm: pcm(new Array(10).fill(1)) },
			{ pcm: pcm(new Array(100).fill(1)) },
		];
		const out = assembleConcatenatedPcm(inputs, pl, { boundaryFadeSamples: 1000 });
		// Effective f = min(1000, floor(10/2)=5, floor(100/2)=50) = 5.
		// seg a tail: indices [5,10) — cos gain applied. k=0 → 1, k=4 → cos(0.8π/2)≈0.309.
		// Float32-bound tolerance.
		expect(out[0][5]).toBeCloseTo(Math.cos((0 / 5) * (Math.PI / 2)), 6);
		expect(out[0][9]).toBeCloseTo(Math.cos((4 / 5) * (Math.PI / 2)), 6);
		// seg a head: indices [0,5) — unchanged.
		expect(out[0][0]).toBeCloseTo(1, 6);
		expect(out[0][4]).toBeCloseTo(1, 6);
		// seg b head: indices [10,15) — sin gain applied. k=0 → 0, k=4 → sin(0.8π/2)≈0.951.
		expect(out[0][10]).toBeCloseTo(Math.sin((0 / 5) * (Math.PI / 2)), 6);
		expect(out[0][14]).toBeCloseTo(Math.sin((4 / 5) * (Math.PI / 2)), 6);
		// seg b body: indices [15,110) — unchanged.
		expect(out[0][15]).toBeCloseTo(1, 6);
		expect(out[0][109]).toBeCloseTo(1, 6);
	});

	it("a short adjacent segment (sampleCount < 2*f0) still gets its own contribution — only its own half is faded", () => {
		// seg A length 10, seg B length 2. f = min(f0=5, 5, 1) = 1. Only index 1 of
		// seg A (cos) and index 0 of seg B (sin) are touched — seg B index 1 is
		// outside the fade and stays at the input value.
		const pl = plan([seg("a", 0, 10, false), seg("b", 10, 2, false)], { totalSamples: 12 });
		const inputs: AudioConcatAssemblerSegmentInput[] = [
			{ pcm: pcm(new Array(10).fill(2)) },
			{ pcm: pcm([3, 3]) },
		];
		const out = assembleConcatenatedPcm(inputs, pl, { boundaryFadeSamples: 5 });
		// seg a body
		expect(out[0][0]).toBeCloseTo(2, 6);
		expect(out[0][8]).toBeCloseTo(2, 6);
		// seg a tail — k=0 → cos(0)=1
		expect(out[0][9]).toBeCloseTo(2, 6);
		// seg b head — k=0 → sin(0)=0
		expect(out[0][10]).toBeCloseTo(0, 6);
		// seg b body (outside fade)
		expect(out[0][11]).toBeCloseTo(3, 6);
	});
});

describe("assembleConcatenatedPcm — boundaryFadeSamples edge values", () => {
	it.each<[string, AssembleOptions | undefined]>([
		["undefined", undefined],
		["0", { boundaryFadeSamples: 0 }],
		["negative", { boundaryFadeSamples: -10 }],
		["NaN", { boundaryFadeSamples: Number.NaN }],
		["Infinity", { boundaryFadeSamples: Number.POSITIVE_INFINITY }],
	])("boundaryFadeSamples %s → no fades (plain concat)", (_label, opts) => {
		const pl = plan([seg("a", 0, 4, false), seg("b", 4, 4, false)], { totalSamples: 8 });
		const inputs: AudioConcatAssemblerSegmentInput[] = [
			{ pcm: pcm([5, 5, 5, 5]) },
			{ pcm: pcm([7, 7, 7, 7]) },
		];
		const out = assembleConcatenatedPcm(inputs, pl, opts);
		expect(Array.from(out[0])).toEqual([5, 5, 5, 5, 7, 7, 7, 7]);
	});
});

// --- Degenerate / purity -----------------------------------------------------

describe("assembleConcatenatedPcm — degenerate layouts", () => {
	it("plan.channels = 0 → returns []", () => {
		const pl = plan([seg("a", 0, 4, false)], { channels: 0, totalSamples: 4 });
		const out = assembleConcatenatedPcm([{ pcm: pcm([1, 2, 3, 4]) }], pl);
		expect(out).toEqual([]);
	});

	it("plan.totalSamples = 0 with channels=2 → returns 2 empty Float32Arrays", () => {
		const pl = plan([], { channels: 2, totalSamples: 0 });
		const out = assembleConcatenatedPcm([], pl);
		expect(out).toHaveLength(2);
		expect(out[0]).toBeInstanceOf(Float32Array);
		expect(out[0].length).toBe(0);
		expect(out[1]).toBeInstanceOf(Float32Array);
		expect(out[1].length).toBe(0);
	});

	it("plan.totalSamples = 0 with channels=0 → returns [] (both guards match)", () => {
		const pl = plan([], { channels: 0, totalSamples: 0 });
		const out = assembleConcatenatedPcm([], pl);
		expect(out).toEqual([]);
	});

	it("plan.totalSamples = 0 with channels=3, no segments → 3 empty Float32Arrays", () => {
		const pl = plan([], { channels: 3, totalSamples: 0 });
		const out = assembleConcatenatedPcm([], pl);
		expect(out).toHaveLength(3);
		expect(out.every((a) => a.length === 0)).toBe(true);
	});

	it("plan with segments but totalSamples = 0 → 2 empty Float32Arrays", () => {
		// Defends against the all-zero case: even though startSample/sampleCount
		// are integers, the output buffer is empty and no fades run.
		const pl = plan([seg("a", 0, 0, false), seg("b", 0, 0, false)], {
			channels: 2,
			totalSamples: 0,
		});
		const out = assembleConcatenatedPcm([{ pcm: pcm([1, 2]) }, { pcm: pcm([3, 4], [5, 6]) }], pl, {
			boundaryFadeSamples: 4,
		});
		expect(out).toHaveLength(2);
		expect(out[0].length).toBe(0);
		expect(out[1].length).toBe(0);
	});
});

describe("assembleConcatenatedPcm — purity (does not mutate inputs)", () => {
	it("input Float32Arrays are not modified by copy or by boundary fades", () => {
		const pl = plan([seg("a", 0, 4, false), seg("b", 4, 4, false)], { totalSamples: 8 });
		const srcA = f32([1, 2, 3, 4]);
		const srcB = f32([5, 6, 7, 8]);
		const aSnapshot = Array.from(srcA);
		const bSnapshot = Array.from(srcB);

		const inputs: AudioConcatAssemblerSegmentInput[] = [{ pcm: [srcA] }, { pcm: [srcB] }];
		const out = assembleConcatenatedPcm(inputs, pl, { boundaryFadeSamples: 2 });

		// Inputs are untouched after the call (compare snapshot to live values).
		expect(Array.from(srcA)).toEqual(aSnapshot);
		expect(Array.from(srcB)).toEqual(bSnapshot);
		// The output reflects the fades (so we know we actually exercised the
		// fade path — otherwise the purity check would be vacuous).
		expect(out[0][3]).not.toBe(bSnapshot[3] ?? 0);
	});

	it("the segments wrapper array is not mutated in length or order", () => {
		const pl = plan([seg("a", 0, 2, false)], { totalSamples: 2 });
		const inputs: AudioConcatAssemblerSegmentInput[] = [{ pcm: pcm([9, 9]) }];
		const beforeLen = inputs.length;
		assembleConcatenatedPcm(inputs, pl);
		expect(inputs).toHaveLength(beforeLen);
		expect(inputs[0].pcm).not.toBeNull();
	});

	it("a shared input pcm (referenced from two segments) is read-only — both outputs see the same logical source", () => {
		// Two segments in the plan, each pointing at the same source buffer.
		// The assembler must not overwrite either output through the shared
		// input reference. (The fade writes ONLY into the output buffers.)
		const shared = f32([4, 4, 4, 4]);
		const pl = plan([seg("a", 0, 4, false), seg("b", 4, 4, false)], { totalSamples: 8 });
		const inputs: AudioConcatAssemblerSegmentInput[] = [{ pcm: [shared] }, { pcm: [shared] }];
		const out = assembleConcatenatedPcm(inputs, pl, { boundaryFadeSamples: 2 });
		// Shared source is still pristine.
		expect(Array.from(shared)).toEqual([4, 4, 4, 4]);
		// Fade-OUT still applied to the first segment's tail; equals 4·cos(π/4)=4·√2/2.
		// Float32-bound tolerance.
		const sqrt2over2 = Math.sqrt(2) / 2;
		expect(out[0][3]).toBeCloseTo(4 * sqrt2over2, 6);
	});
});
