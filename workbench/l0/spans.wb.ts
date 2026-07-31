// L0 — the interval arithmetic every editorial oracle stands on.
//
// These are the least interesting tests in the workbench and the ones whose
// absence would be most expensive: a `subtractSpans` that drops the tail of a
// range makes `speechDamage` report 0 s of destroyed speech, which is exactly
// the answer we are hoping for and therefore the one nobody double-checks.

import { describe, expect, it } from "vitest";
import {
	containsSec,
	formatSpans,
	intersectSpans,
	invertSpans,
	mergeSpans,
	overlapSec,
	type Span,
	subtractSpans,
	totalSec,
} from "../lib/spans";

const span = (startSec: number, endSec: number): Span => ({ startSec, endSec });

describe("mergeSpans", () => {
	it("sorts, joins touching neighbours and drops empties", () => {
		expect(mergeSpans([span(5, 8), span(0, 2), span(2, 3), span(9, 9)])).toEqual([
			span(0, 3),
			span(5, 8),
		]);
	});

	it("keeps a gap that is a real gap", () => {
		expect(mergeSpans([span(0, 2), span(2.5, 3)])).toEqual([span(0, 2), span(2.5, 3)]);
	});

	it("absorbs a span swallowed by its neighbour", () => {
		expect(mergeSpans([span(0, 10), span(3, 4)])).toEqual([span(0, 10)]);
	});
});

describe("subtractSpans", () => {
	it("punches a hole in the middle", () => {
		expect(subtractSpans([span(0, 10)], [span(4, 6)])).toEqual([span(0, 4), span(6, 10)]);
	});

	it("trims both edges", () => {
		expect(subtractSpans([span(0, 10)], [span(0, 2), span(9, 12)])).toEqual([span(2, 9)]);
	});

	it("removes a span entirely covered", () => {
		expect(subtractSpans([span(3, 4)], [span(0, 10)])).toEqual([]);
	});

	it("leaves a merely touching neighbour alone", () => {
		// 10→12 does not remove anything from 0→10: the ranges are half-open, and
		// treating a touch as an overlap would fabricate damage on every cut that
		// starts exactly where speech ends — the well-placed cut.
		expect(subtractSpans([span(0, 10)], [span(10, 12)])).toEqual([span(0, 10)]);
	});

	it("survives the float error of a hand-written fixture", () => {
		const kept = subtractSpans([span(0, 62)], [span(10, 12.5), span(31, 36.2)]);
		expect(totalSec(kept)).toBeCloseTo(62 - 2.5 - 5.2, 9);
	});
});

describe("intersectSpans", () => {
	it("keeps only the shared parts", () => {
		expect(intersectSpans([span(0, 10), span(20, 30)], [span(5, 25)])).toEqual([
			span(5, 10),
			span(20, 25),
		]);
	});

	it("is empty when the two only touch", () => {
		expect(intersectSpans([span(0, 5)], [span(5, 9)])).toEqual([]);
	});
});

describe("overlapSec / containsSec / invertSpans", () => {
	it("measures a partial overlap", () => {
		expect(overlapSec(span(0, 10), span(8, 20))).toBeCloseTo(2, 9);
		expect(overlapSec(span(0, 10), span(10, 20))).toBe(0);
	});

	it("accepts a point just outside, within tolerance", () => {
		expect(containsSec(span(5, 8), 8.4)).toBe(false);
		expect(containsSec(span(5, 8), 8.4, 0.5)).toBe(true);
	});

	it("inverts inside a window", () => {
		expect(invertSpans([span(2, 4)], span(0, 10))).toEqual([span(0, 2), span(4, 10)]);
	});
});

describe("formatSpans", () => {
	it("caps the list rather than printing forty ranges", () => {
		const many = Array.from({ length: 9 }, (_v, i) => span(i, i + 0.5));
		expect(formatSpans(many, 2)).toBe("0.00–0.50, 1.00–1.50, +7");
	});
});
