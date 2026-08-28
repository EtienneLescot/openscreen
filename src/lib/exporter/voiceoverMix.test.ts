import { describe, expect, it } from "vitest";
import { planLayerGain, planLayerIterations } from "./voiceoverMix";

describe("planLayerIterations", () => {
	const layer = (
		overrides: Partial<{
			startSec: number;
			endSec: number;
			offsetSec: number;
			loop: boolean;
		}> = {},
	) => ({
		startSec: 10,
		endSec: 16,
		offsetSec: 0,
		loop: false,
		...overrides,
	});

	it("plays once from the layer start, trimmed to the span", () => {
		expect(planLayerIterations(layer({ endSec: 12 }), 30)).toEqual([
			{ startSec: 10, offsetSec: 0, playSec: 2 },
		]);
	});

	it("skips into the source by the offset", () => {
		expect(planLayerIterations(layer({ offsetSec: 5, endSec: 13 }), 30)).toEqual([
			{ startSec: 10, offsetSec: 5, playSec: 3 },
		]);
	});

	it("returns nothing for a zero/negative span", () => {
		expect(planLayerIterations(layer({ endSec: 10 }), 30)).toEqual([]);
		expect(planLayerIterations(layer({ endSec: 8 }), 30)).toEqual([]);
	});

	it("loops the source for the whole span", () => {
		// 4s of source, 7s span → 2 full loops + a 3s tail... 10..17: loops at
		// 10 (4s), 14 (3s remainder).
		expect(planLayerIterations(layer({ endSec: 17, loop: true }), 4)).toEqual([
			{ startSec: 10, offsetSec: 0, playSec: 4 },
			{ startSec: 14, offsetSec: 0, playSec: 3 },
		]);
	});

	it("stops looping when the source is exhausted by the offset", () => {
		expect(planLayerIterations(layer({ offsetSec: 30, loop: true }), 30)).toEqual([]);
	});
});

describe("planLayerGain", () => {
	it("holds unity with no fades", () => {
		expect(
			planLayerGain({
				startSec: 0,
				endSec: 10,
				fadeInMs: 0,
				fadeOutMs: 0,
				muted: false,
				gainDb: 0,
			}),
		).toEqual([{ atSec: 0, value: 1 }]);
	});

	it("ramps in from silence over the fade-in", () => {
		expect(
			planLayerGain({
				startSec: 2,
				endSec: 10,
				fadeInMs: 1000,
				fadeOutMs: 0,
				muted: false,
				gainDb: 0,
			}),
		).toEqual([
			{ atSec: 2, value: 0 },
			{ atSec: 3, value: 1, ramp: true },
		]);
	});

	it("ramps out to silence at the end of the span", () => {
		expect(
			planLayerGain({
				startSec: 2,
				endSec: 10,
				fadeInMs: 0,
				fadeOutMs: 2000,
				muted: false,
				gainDb: 0,
			}),
		).toEqual([
			{ atSec: 2, value: 1 },
			{ atSec: 8, value: 1, ramp: true },
			{ atSec: 10, value: 0 },
		]);
	});

	it("scales by gainDb and collapses to silence when muted", () => {
		const loud = planLayerGain({
			startSec: 0,
			endSec: 5,
			fadeInMs: 0,
			fadeOutMs: 0,
			muted: false,
			gainDb: 6,
		});
		expect(loud[0]?.value).toBeCloseTo(10 ** (6 / 20));
		const muted = planLayerGain({
			startSec: 0,
			endSec: 5,
			fadeInMs: 0,
			fadeOutMs: 0,
			muted: true,
			gainDb: 0,
		});
		expect(muted[0]?.value).toBe(0);
	});
});
