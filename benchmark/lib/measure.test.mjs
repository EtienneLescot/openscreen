import { describe, expect, it } from "vitest";
import { mad, median, ProcessTreeSampler } from "./measure.mjs";

describe("ProcessTreeSampler.parseCpuTime", () => {
	// `ps` prints cumulative CPU as [[dd-]hh:]mm:ss[.ff]. Every one of these forms turns up in
	// practice, and a missed one silently reports 0 CPU seconds for a busy process.
	it.each([
		["0:00.00", 0],
		["12:34.56", 754.56],
		["1:02:03", 3723],
		["1-02:03:04.55", 93784.55],
	])("parses %s", (input, expected) => {
		expect(ProcessTreeSampler.parseCpuTime(input)).toBeCloseTo(expected, 2);
	});

	it("returns 0 rather than NaN for anything unparseable", () => {
		expect(ProcessTreeSampler.parseCpuTime("-")).toBe(0);
		expect(ProcessTreeSampler.parseCpuTime("")).toBe(0);
	});
});

describe("median and mad", () => {
	it("takes the middle of an odd sample and the mean of the middle two of an even one", () => {
		expect(median([3, 1, 2])).toBe(2);
		expect(median([4, 1, 3, 2])).toBe(2.5);
	});

	it("is null for no samples, so a failed app cannot masquerade as a fast one", () => {
		expect(median([])).toBeNull();
		expect(mad([])).toBeNull();
	});

	it("reports spread as the median absolute deviation", () => {
		expect(mad([10, 10, 10])).toBe(0);
		expect(mad([8, 10, 12])).toBe(2);
	});

	it("is not dragged by a single outlier the way a mean would be", () => {
		expect(median([10, 10, 10, 10, 1000])).toBe(10);
	});
});
