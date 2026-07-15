// AudioConcatAssembler: pure-logic PCM assembly for the v2 multi-asset export
// audio track.
//
// ponytail: `audioConcatPlan.ts` decides WHERE each segment's audio lands in
// the concatenated output (integer sample offsets / counts / silence flags at
// a common sampleRate + channels). This module does the actual sample copy:
// for every plan segment, it takes the segment's already-decoded,
// already-resampled PLANAR PCM (one Float32Array per channel) and writes it
// into the right offset of a single output buffer, clamping each channel to
// the planned sampleCount (longer input → truncate; shorter input → zero-pad)
// so a small decode over/under-run never shifts the timeline. A short
// equal-power fade is applied at every INTERNAL segment boundary to suppress
// clicks where two different recordings meet butt-joined — without changing
// timing, so audio stays locked to the video (which is retimed independently).
//
// The plan places segments BUTT-JOINED (segment i+1 starts exactly where i
// ends, no overlap) because `plan.totalSamples` must equal the video frame
// count for A/V lock, so a true overlapping crossfade is not an option (it
// would shorten the track and drift A/V). Instead we use equal-power gains:
// fade-out gain at offset k∈[0,f) = cos((k/f)·π/2) and fade-in at the matching
// offset = sin((k/f)·π/2). `cos² + sin² = 1` keeps perceived power even.
//
// Pure: no DOM, no IPC, no WebCodecs, no AudioContext — only Float32Array
// math. Inputs are never mutated.

import type { AudioConcatPlan } from "./audioConcatPlan";

// One entry per plan segment (SAME order/length as `plan.segments`). `pcm` is
// the segment's decoded audio, PLANAR (one Float32Array per channel), already
// at `plan.sampleRate` / `plan.channels`. `null` → silent segment (renders
// zeros — equivalent to `seg.silence === true`). The assembler clamps each
// channel to the plan's `sampleCount`: a longer buffer is truncated, a
// shorter one is zero-padded, so a small decode over/under-run never shifts
// the timeline.
export interface AudioConcatAssemblerSegmentInput {
	pcm: Float32Array[] | null;
}

export interface AssembleOptions {
	// Equal-power fade length (in samples) applied at each INTERNAL segment
	// boundary to avoid clicks. Clamped per-boundary to at most
	// `floor(sampleCount/2)` of each adjacent segment. Default 0 (no fade).
	// Non-finite / negative values are treated as 0.
	boundaryFadeSamples?: number;
}

// Returns `plan.channels` planar Float32Arrays, each of length `plan.totalSamples`.
// Pure: never mutates `segments` or their `pcm` arrays.
export function assembleConcatenatedPcm(
	segments: AudioConcatAssemblerSegmentInput[],
	plan: AudioConcatPlan,
	options?: AssembleOptions,
): Float32Array[] {
	// Degenerate layouts — no channels to fill.
	if (plan.channels <= 0) return [];
	if (plan.totalSamples === 0) {
		const empty: Float32Array[] = [];
		for (let i = 0; i < plan.channels; i++) empty.push(new Float32Array(0));
		return empty;
	}

	// 1) Allocate `plan.channels` output Float32Arrays (zero-filled = silence).
	const output: Float32Array[] = [];
	for (let c = 0; c < plan.channels; c++) {
		output.push(new Float32Array(plan.totalSamples));
	}

	// 2) Copy each segment's PCM into its planned slot. A silent segment
	// (per plan) or a missing/short input leaves zeros in the slot — the
	// timeline (startSample + sampleCount) is preserved either way.
	const segCount = plan.segments.length;
	for (let i = 0; i < segCount; i++) {
		const seg = plan.segments[i];
		const start = seg.startSample;
		const count = seg.sampleCount;
		if (count <= 0) continue;
		const input = segments[i];
		if (seg.silence) continue;
		if (!input || input.pcm == null) continue;

		const src = input.pcm;
		for (let c = 0; c < plan.channels; c++) {
			const dst = output[c];
			const srcCh = src[c];
			if (!srcCh) continue; // missing channel → silence for this segment
			const copy = count < srcCh.length ? count : srcCh.length;
			// Bounds already enforced (start..start+count ⊂ [0, totalSamples),
			// srcCh.length ≥ copy) — no overrun possible, no clamp needed.
			for (let k = 0; k < copy; k++) {
				dst[start + k] = srcCh[k];
			}
			// Any tail beyond `copy` (count > srcCh.length) is left at zero
			// (the Float32Array was zero-filled at allocation).
		}
	}

	// 3) Boundary fades (after all copies). At each INTERNAL boundary the tail
	// of segment i is multiplied by a fade-out gain (`cos`) and the head of
	// segment i+1 by a fade-in gain (`sin`) with matching offsets so the sum of
	// squares is 1 — equal-power, no perceived dip. Applied to every channel
	// (multiplication by 0 on a silent side is a harmless no-op).
	const f0 = options?.boundaryFadeSamples ?? 0;
	if (Number.isFinite(f0) && f0 > 0 && segCount >= 2) {
		for (let i = 0; i < segCount - 1; i++) {
			const cur = plan.segments[i];
			const next = plan.segments[i + 1];
			const f = Math.min(f0, Math.floor(cur.sampleCount / 2), Math.floor(next.sampleCount / 2));
			if (f <= 0) continue;
			const halfPi = Math.PI / 2;
			for (let c = 0; c < plan.channels; c++) {
				const dst = output[c];
				// Fade-OUT tail of cur: k=0 → gain 1, k=f-1 → ~0.
				const tailStart = cur.startSample + cur.sampleCount - f;
				for (let k = 0; k < f; k++) {
					const gain = Math.cos((k / f) * halfPi);
					dst[tailStart + k] *= gain;
				}
				// Fade-IN head of next: k=0 → gain 0, k=f-1 → ~1.
				const headStart = next.startSample;
				for (let k = 0; k < f; k++) {
					const gain = Math.sin((k / f) * halfPi);
					dst[headStart + k] *= gain;
				}
			}
		}
	}

	return output;
}
