import { describe, expect, it } from "vitest";
import { computeDeviceRect, rectsEqual } from "./nativeViewRect";

describe("computeDeviceRect", () => {
	it("returns identity with Math.round at dpr=1", () => {
		expect(computeDeviceRect({ left: 100, top: 50, width: 320, height: 240 }, 1)).toEqual({
			x: 100,
			y: 50,
			width: 320,
			height: 240,
		});
	});

	it("scales by dpr=2", () => {
		expect(computeDeviceRect({ left: 100, top: 50, width: 320, height: 240 }, 2)).toEqual({
			x: 200,
			y: 100,
			width: 640,
			height: 480,
		});
	});

	it("rounds fractional coordinates to the nearest integer (e.g. 100.4 -> 100)", () => {
		const rect = computeDeviceRect({ left: 50.4, top: 12.6, width: 200.49, height: 100.5 }, 1);
		expect(rect).toEqual({ x: 50, y: 13, width: 200, height: 101 });
	});

	it("rounds 0.5 values via Math.round (banker's-style half-to-even for .5)", () => {
		// Math.round(0.5) === 1, Math.round(1.5) === 2, Math.round(2.5) === 3
		// (toward +Infinity), so we exercise non-negative coordinates only.
		const rect = computeDeviceRect({ left: 10.5, top: 20.5, width: 30.5, height: 40.5 }, 1);
		expect(rect).toEqual({ x: 11, y: 21, width: 31, height: 41 });
	});

	it("handles a zero-size rect without producing NaN", () => {
		const rect = computeDeviceRect({ left: 0, top: 0, width: 0, height: 0 }, 2);
		expect(rect).toEqual({ x: 0, y: 0, width: 0, height: 0 });
	});

	it("falls back to dpr=1 when devicePixelRatio is 0, negative, or non-finite", () => {
		const domRect = { left: 12, top: 34, width: 56, height: 78 };

		expect(computeDeviceRect(domRect, 0)).toEqual({ x: 12, y: 34, width: 56, height: 78 });
		expect(computeDeviceRect(domRect, -1)).toEqual({ x: 12, y: 34, width: 56, height: 78 });
		expect(computeDeviceRect(domRect, Number.NaN)).toEqual({
			x: 12,
			y: 34,
			width: 56,
			height: 78,
		});
		expect(computeDeviceRect(domRect, Number.POSITIVE_INFINITY)).toEqual({
			x: 12,
			y: 34,
			width: 56,
			height: 78,
		});
	});

	it("returns integers for every field (the addon rejects fractional device coords)", () => {
		const rect = computeDeviceRect({ left: 7.7, top: 9.3, width: 11.7, height: 13.1 }, 1.5);
		for (const field of ["x", "y", "width", "height"] as const) {
			expect(Number.isInteger(rect[field])).toBe(true);
		}
	});
});

describe("rectsEqual", () => {
	it("returns true for two structurally identical rects", () => {
		expect(
			rectsEqual({ x: 1, y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 3, height: 4 }),
		).toBe(true);
	});

	it("returns false when any field differs", () => {
		expect(
			rectsEqual({ x: 0, y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 3, height: 4 }),
		).toBe(false);
		expect(
			rectsEqual({ x: 1, y: 0, width: 3, height: 4 }, { x: 1, y: 2, width: 3, height: 4 }),
		).toBe(false);
		expect(
			rectsEqual({ x: 1, y: 2, width: 0, height: 4 }, { x: 1, y: 2, width: 3, height: 4 }),
		).toBe(false);
		expect(
			rectsEqual({ x: 1, y: 2, width: 3, height: 0 }, { x: 1, y: 2, width: 3, height: 4 }),
		).toBe(false);
	});

	it("treats two zero rects as equal", () => {
		expect(
			rectsEqual({ x: 0, y: 0, width: 0, height: 0 }, { x: 0, y: 0, width: 0, height: 0 }),
		).toBe(true);
	});
});
