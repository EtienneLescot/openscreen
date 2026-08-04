import { describe, expect, it } from "vitest";
import type { SpeedRegion, TrimRegion } from "@/components/video-editor/types";
import {
	buildSpeedSegments,
	computeKeepSegments,
	maxTimelineSpeed,
	splitBySpeed,
} from "./timelineSegments";

function trim(startMs: number, endMs: number): TrimRegion {
	return { id: `t-${startMs}-${endMs}`, startMs, endMs };
}

function speed(startMs: number, endMs: number, value: number): SpeedRegion {
	return { id: `s-${startMs}-${endMs}`, startMs, endMs, speed: value };
}

describe("computeKeepSegments", () => {
	it("returns one full-duration segment when there are no trims", () => {
		expect(computeKeepSegments(10)).toEqual([{ startSec: 0, endSec: 10 }]);
		expect(computeKeepSegments(10, [])).toEqual([{ startSec: 0, endSec: 10 }]);
	});

	it("removes a middle trim, keeping the surrounding spans", () => {
		expect(computeKeepSegments(10, [trim(2000, 4000)])).toEqual([
			{ startSec: 0, endSec: 2 },
			{ startSec: 4, endSec: 10 },
		]);
	});

	it("drops a leading trim", () => {
		expect(computeKeepSegments(10, [trim(0, 3000)])).toEqual([{ startSec: 3, endSec: 10 }]);
	});

	it("drops a trailing trim that reaches the end", () => {
		expect(computeKeepSegments(10, [trim(8000, 10000)])).toEqual([{ startSec: 0, endSec: 8 }]);
	});

	it("sorts unordered trims before collapsing", () => {
		expect(computeKeepSegments(10, [trim(6000, 7000), trim(1000, 2000)])).toEqual([
			{ startSec: 0, endSec: 1 },
			{ startSec: 2, endSec: 6 },
			{ startSec: 7, endSec: 10 },
		]);
	});

	it("does not re-emit source for a nested trim (cursor stays monotonic)", () => {
		// [4s,5s] is fully inside [2s,8s]; the inner trim must not drag the cursor back
		// to 5 and resurrect the already-trimmed [5s,8s] span.
		expect(computeKeepSegments(10, [trim(2000, 8000), trim(4000, 5000)])).toEqual([
			{ startSec: 0, endSec: 2 },
			{ startSec: 8, endSec: 10 },
		]);
	});

	it("collapses overlapping trims into their union", () => {
		expect(computeKeepSegments(10, [trim(2000, 5000), trim(4000, 7000)])).toEqual([
			{ startSec: 0, endSec: 2 },
			{ startSec: 7, endSec: 10 },
		]);
	});
});

describe("splitBySpeed", () => {
	const full: { startSec: number; endSec: number }[] = [{ startSec: 0, endSec: 10 }];

	it("annotates every segment with speed 1 when no speed regions apply", () => {
		expect(splitBySpeed(full)).toEqual([{ startSec: 0, endSec: 10, speed: 1 }]);
		expect(splitBySpeed(full, [])).toEqual([{ startSec: 0, endSec: 10, speed: 1 }]);
	});

	it("carves a mid-segment speed region, leaving 1x gaps on both sides", () => {
		expect(splitBySpeed(full, [speed(3000, 6000, 4)])).toEqual([
			{ startSec: 0, endSec: 3, speed: 1 },
			{ startSec: 3, endSec: 6, speed: 4 },
			{ startSec: 6, endSec: 10, speed: 1 },
		]);
	});

	it("clips a speed region to the keep-segment bounds", () => {
		expect(splitBySpeed([{ startSec: 2, endSec: 8 }], [speed(0, 5000, 2)])).toEqual([
			{ startSec: 2, endSec: 5, speed: 2 },
			{ startSec: 5, endSec: 8, speed: 1 },
		]);
	});

	it("passes an extreme 100x speed through unclamped", () => {
		expect(splitBySpeed(full, [speed(0, 10000, 100)])).toEqual([
			{ startSec: 0, endSec: 10, speed: 100 },
		]);
	});

	it("orders multiple regions and fills the gap between them at 1x", () => {
		expect(splitBySpeed(full, [speed(6000, 8000, 3), speed(1000, 2000, 20)])).toEqual([
			{ startSec: 0, endSec: 1, speed: 1 },
			{ startSec: 1, endSec: 2, speed: 20 },
			{ startSec: 2, endSec: 6, speed: 1 },
			{ startSec: 6, endSec: 8, speed: 3 },
			{ startSec: 8, endSec: 10, speed: 1 },
		]);
	});

	it("keeps output disjoint when speed regions overlap", () => {
		expect(splitBySpeed(full, [speed(1000, 5000, 2), speed(4000, 7000, 3)])).toEqual([
			{ startSec: 0, endSec: 1, speed: 1 },
			{ startSec: 1, endSec: 5, speed: 2 },
			{ startSec: 5, endSec: 7, speed: 3 },
			{ startSec: 7, endSec: 10, speed: 1 },
		]);
	});

	// Not a variant of the test above: there the two regions merely overlap, here the
	// second is fully swallowed by the first. main emitted
	// `[0-1 x1, 1-8 x2, 3-5 x3, 5-10 x1]` — the third entry starts BEFORE the second
	// ends, so the list stops being ascending and 5-8 ships twice. `decodeAll` walks
	// these with a forward-only frame cursor, so that is a backwards seek, not just a
	// duplicated stretch. Keep both cases.
	it("ignores a later speed region fully covered by the earliest region", () => {
		expect(splitBySpeed(full, [speed(1000, 8000, 2), speed(3000, 5000, 3)])).toEqual([
			{ startSec: 0, endSec: 1, speed: 1 },
			{ startSec: 1, endSec: 8, speed: 2 },
			{ startSec: 8, endSec: 10, speed: 1 },
		]);
	});

	it("drops sub-segments narrower than the minimum width", () => {
		// A speed region ending a sliver before the segment end must not emit a 1x crumb.
		const result = splitBySpeed(full, [speed(0, 9_999.95, 2)]);
		expect(result).toEqual([{ startSec: 0, endSec: 9.99995, speed: 2 }]);
	});
});

describe("buildSpeedSegments", () => {
	it("composes trim removal and speed splitting", () => {
		expect(buildSpeedSegments(10, [trim(2000, 4000)], [speed(5000, 7000, 50)])).toEqual([
			{ startSec: 0, endSec: 2, speed: 1 },
			{ startSec: 4, endSec: 5, speed: 1 },
			{ startSec: 5, endSec: 7, speed: 50 },
			{ startSec: 7, endSec: 10, speed: 1 },
		]);
	});
});

describe("maxTimelineSpeed", () => {
	it("returns 1 when nothing is sped up", () => {
		expect(maxTimelineSpeed(buildSpeedSegments(10))).toBe(1);
	});

	it("reports the fastest segment", () => {
		expect(maxTimelineSpeed(buildSpeedSegments(10, undefined, [speed(0, 5000, 32)]))).toBe(32);
	});
});
