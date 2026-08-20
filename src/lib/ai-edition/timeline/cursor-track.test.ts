import { describe, expect, it } from "vitest";
import type { AxcutClip } from "../schema";
import { buildCursorTrack, type CursorTrackSample } from "./cursor-track";

const CLIPS: AxcutClip[] = [
	{
		id: "clip_1",
		assetId: "asset_1",
		sourceStartSec: 0,
		sourceEndSec: 60,
		timelineStartSec: 0,
		timelineEndSec: 60,
	} as AxcutClip,
];

/** A steady 20 Hz sweep, the shape of a real capture. */
function sweep(count: number, opts: { shape?: (i: number) => string } = {}): CursorTrackSample[] {
	return Array.from({ length: count }, (_, i) => ({
		timeMs: i * 50,
		cx: 0.2 + i * 0.001,
		cy: 0.5,
		assetId: opts.shape ? opts.shape(i) : "arrow",
		interactionType: "move",
	}));
}

const build = (samples: CursorTrackSample[], hz?: number) =>
	buildCursorTrack({ assetId: "asset_1", samples, durationSec: 60, clips: CLIPS, hz });

describe("buildCursorTrack", () => {
	it("downsamples without inventing a single point", () => {
		const samples = sweep(400);
		const track = build(samples, 5);

		expect(track.sampleCount).toBe(400);
		expect(track.pointCount).toBeLessThan(samples.length);
		for (const point of track.points) {
			const origin = samples.find((s) => Math.abs(s.timeMs / 1000 - point.atSec) < 0.01);
			expect(origin).toBeTruthy();
			expect(point.cx).toBeCloseTo(origin?.cx ?? -1, 3);
		}
	});

	it("spends points on movement, not on the clock", () => {
		// 400 samples @20Hz = 20s, drifting 0.001 per sample: 0.4 of the frame in all.
		// A 5 Hz GRID would bill 100 rows for that; the movement rule bills one per
		// `epsilon` crossed, so ~20 — and says the same thing.
		const track = build(sweep(400), 5);
		expect(track.pointCount).toBeLessThan(40);
		expect(track.hz).toBe(5);
		expect(track.truncated).toBe(false);
		// Still bounded below: no stretch longer than the max gap goes unreported.
		const gaps = track.points.slice(1).map((p, i) => p.atSec - track.points[i].atSec);
		expect(Math.max(...gaps)).toBeLessThanOrEqual(3.1);
	});

	it("never drops a pointer-shape change, even between ticks", () => {
		// One shape flip lasting a single 50 ms sample, far from any 5 Hz tick.
		const samples = sweep(200, { shape: (i) => (i === 37 ? "hand" : "arrow") });
		const track = build(samples, 5);

		expect(track.shapeCount).toBe(2);
		const flip = track.points.find((p) => Math.abs(p.atSec - 37 * 0.05) < 0.001);
		expect(flip).toBeTruthy();
		// Two distinct shapes reach the model as two distinct indices.
		expect(new Set(track.points.map((p) => p.shape)).size).toBe(2);
	});

	it("keeps every non-move sample whatever the rate", () => {
		const samples = sweep(200);
		samples[13] = { ...samples[13], interactionType: "click" };
		const track = build(samples, 2);

		const click = track.points.find((p) => p.kind === "click");
		expect(click).toBeTruthy();
		expect(click?.atSec).toBeCloseTo(13 * 0.05, 2);
	});

	it("drops to a coarser rate rather than blowing the ceiling, and says so", () => {
		// 40 minutes at 20 Hz: 5 Hz would be 12 000 points.
		const track = buildCursorTrack({
			assetId: "asset_1",
			samples: sweep(48_000),
			durationSec: 2400,
			clips: CLIPS,
			hz: 5,
			maxPoints: 400,
		});

		expect(track.truncated).toBe(true);
		expect(track.hz).toBeLessThan(5);
		expect(track.pointCount).toBeLessThanOrEqual(420);
	});

	it("reports virtualSec as null where no clip carries the moment", () => {
		const track = buildCursorTrack({
			assetId: "asset_1",
			samples: sweep(40),
			durationSec: 60,
			clips: [], // nothing placed on the timeline
		});
		expect(track.points.every((p) => p.virtualSec === null)).toBe(true);
	});

	it("marks the points a trim cuts out of playback", () => {
		const track = buildCursorTrack({
			assetId: "asset_1",
			samples: sweep(200),
			durationSec: 60,
			clips: CLIPS,
			trimRanges: [{ id: "t1", assetId: "asset_1", startSec: 2, endSec: 4 } as never],
			hz: 5,
		});

		const inside = track.points.filter((p) => p.atSec >= 2 && p.atSec <= 4);
		expect(inside.length).toBeGreaterThan(0);
		expect(inside.every((p) => p.trimmed === true)).toBe(true);
		expect(track.points.filter((p) => p.atSec < 2).every((p) => p.trimmed === undefined)).toBe(
			true,
		);
	});

	it("omits shape entirely when the recording used only one pointer", () => {
		const track = build(sweep(100), 5);
		expect(track.shapeCount).toBe(1);
		expect(track.points.every((p) => p.shape === undefined)).toBe(true);
	});
});

describe("buildCursorTrack — compression", () => {
	it("collapses a parked cursor to the max-gap rate, not the sample rate", () => {
		// 10s of 20 Hz samples that never move: 200 rows saying the same thing.
		const parked: CursorTrackSample[] = Array.from({ length: 200 }, (_, i) => ({
			timeMs: i * 50,
			cx: 0.5,
			cy: 0.5,
			assetId: "arrow",
			interactionType: "move",
		}));
		const track = buildCursorTrack({
			assetId: "asset_1",
			samples: parked,
			durationSec: 60,
			clips: CLIPS,
			hz: 5,
		});
		// One point per max-gap (200ms), not one per sample — ~50, not 200.
		expect(track.pointCount).toBeLessThan(10);
		expect(track.pointCount).toBeGreaterThan(2);
	});

	it("collapses a straight traverse to its ends — interpolation puts the rest back", () => {
		// Same 200 samples, but sweeping 0.2 → 0.8 across the frame.
		const sweeping: CursorTrackSample[] = Array.from({ length: 200 }, (_, i) => ({
			timeMs: i * 50,
			cx: 0.2 + i * 0.003,
			cy: 0.5,
			assetId: "arrow",
			interactionType: "move",
		}));
		const track = buildCursorTrack({
			assetId: "asset_1",
			samples: sweeping,
			durationSec: 60,
			clips: CLIPS,
			hz: 5,
		});
		// A straight line needs two keyframes, not two hundred samples.
		expect(track.pointCount).toBeLessThan(12);
		// The traverse still reads as a traverse in what reaches the model.
		const xs = track.points.map((p) => p.cx);
		expect(xs[xs.length - 1]).toBeGreaterThan(xs[0] + 0.4);
		// And it is LOSSLESS within the tolerance: linearly interpolating between the
		// kept points reproduces every dropped sample to better than epsilon. That is
		// the whole claim of a keyframe reduction, so it is the thing to assert.
		let worst = 0;
		for (const sample of sweeping) {
			const t = sample.timeMs / 1000;
			const after = track.points.findIndex((p) => p.atSec >= t);
			if (after <= 0) continue;
			const a = track.points[after - 1];
			const b = track.points[after];
			const k = (t - a.atSec) / (b.atSec - a.atSec || 1);
			worst = Math.max(worst, Math.abs(a.cx + k * (b.cx - a.cx) - sample.cx));
		}
		expect(worst).toBeLessThanOrEqual(0.02);
	});

	it("keeps the apex of an out-and-back — the case path-space simplification loses", () => {
		// The regression test for the choice `simplifyAxis` makes: Douglas–Peucker per
		// axis AGAINST TIME, not over the (x,y) path. Both give the same answer on a
		// monotonic sweep — the traverse above cannot tell them apart — so this is the
		// trajectory that separates them. The pointer runs out to 0.9 and comes back
		// along the same line, which in path space deviates from its chord by nothing:
		// the whole excursion collapses and interpolation then swears it never happened.
		const outAndBack: CursorTrackSample[] = Array.from({ length: 200 }, (_, i) => ({
			timeMs: i * 50,
			cx: i <= 100 ? 0.1 + i * 0.008 : 0.9 - (i - 100) * 0.008,
			cy: 0.5, // constant, so the path IS its own chord
			assetId: "arrow",
			interactionType: "move" as const,
		}));
		const track = build(outAndBack, 5);

		// The turning point survives. Path-space simplification drops it and the best
		// remaining point sits near 0.74, so this alone fails on the wrong implementation.
		expect(Math.max(...track.points.map((p) => p.cx))).toBeGreaterThan(0.85);

		// And the same bound the straight traverse claims still holds here.
		let worst = 0;
		for (const sample of outAndBack) {
			const t = sample.timeMs / 1000;
			const after = track.points.findIndex((p) => p.atSec >= t);
			if (after <= 0) continue;
			const a = track.points[after - 1];
			const b = track.points[after];
			const k = (t - a.atSec) / (b.atSec - a.atSec || 1);
			worst = Math.max(worst, Math.abs(a.cx + k * (b.cx - a.cx) - sample.cx));
		}
		expect(worst).toBeLessThanOrEqual(0.02);
	});

	it("says so when the mandatory points push it over maxPoints", () => {
		// The ceiling is soft: `maxPoints` budgets the rate and the gap floor, and the
		// mandatory points are exempt. `sweep` samples every 50 ms and the shape here
		// alternates on every index, so every sample is mandatory and the budget cannot
		// hold — and the track has to say so rather than let the model read the rows as
		// "within budget".
		const flipping = sweep(200, { shape: (i) => (i % 2 === 0 ? "arrow" : "text") });
		const track = buildCursorTrack({
			assetId: "asset_1",
			samples: flipping,
			durationSec: 60,
			clips: CLIPS,
			hz: 5,
			maxPoints: 20,
		});

		expect(track.pointCount).toBeGreaterThan(20);
		expect(track.overBudget).toMatch(/ceiling of 20/);
		// `truncated` is the other direction — the rate WAS cut — and stays its own signal.
		expect(track.truncated).toBe(true);
	});

	it("leaves overBudget off when the ceiling holds", () => {
		expect(build(sweep(400), 5).overBudget).toBeUndefined();
	});

	it("restores per-point virtualSec once the two axes diverge", () => {
		const shiftedClips: AxcutClip[] = [
			{
				id: "clip_1",
				assetId: "asset_1",
				sourceStartSec: 0,
				sourceEndSec: 60,
				timelineStartSec: 12, // the clip no longer starts at the ruler's origin
				timelineEndSec: 72,
			} as AxcutClip,
		];
		const track = buildCursorTrack({
			assetId: "asset_1",
			samples: sweep(100),
			durationSec: 60,
			clips: shiftedClips,
			hz: 5,
		});
		expect(track.virtualEqualsSource).toBe(false);
		expect(track.points.every((p) => typeof p.virtualSec === "number")).toBe(true);
		const first = track.points[0];
		expect(first.virtualSec).toBeCloseTo((first.atSec ?? 0) + 12, 1);
	});
});
