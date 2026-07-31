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

	it("holds the requested resolution", () => {
		const track = build(sweep(400), 5); // 400 samples @20Hz = 20s
		// ~5 points per second, give or take the boundary point.
		expect(track.pointCount).toBeGreaterThanOrEqual(Math.floor(20 * 5) - 2);
		expect(track.pointCount).toBeLessThanOrEqual(Math.ceil(20 * 5) + 2);
		expect(track.hz).toBe(5);
		expect(track.truncated).toBe(false);
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
