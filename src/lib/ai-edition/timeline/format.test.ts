import { describe, expect, it } from "vitest";
import { formatMs, formatSec, formatSeconds } from "./format";

// These three replaced six private copies; the cases that differed between
// those copies (negatives, NaN, the hour boundary) are what this pins down.

describe("formatSec", () => {
	it("never shows an hour field", () => {
		expect(formatSec(0)).toBe("0:00.0");
		expect(formatSec(65.4)).toBe("1:05.4");
		expect(formatSec(3661.5)).toBe("61:01.5");
	});

	it("floors junk input to zero", () => {
		expect(formatSec(-5)).toBe("0:00.0");
		expect(formatSec(Number.NaN)).toBe("0:00.0");
		expect(formatSec(Number.POSITIVE_INFINITY)).toBe("0:00.0");
	});

	it("carries rounded seconds into the next minute", () => {
		expect(formatSec(59.96)).toBe("1:00.0");
	});

	it("keeps finite durations finite while rounding", () => {
		expect(formatSec(Number.MAX_VALUE)).not.toMatch(/Infinity|NaN/);
	});
});

describe("formatSeconds", () => {
	it("adds the hour field only past an hour", () => {
		expect(formatSeconds(65.4)).toBe("1:05.4");
		expect(formatSeconds(3599.9)).toBe("59:59.9");
		expect(formatSeconds(3661.5)).toBe("1:01:01.5");
	});

	it("floors junk input to zero", () => {
		expect(formatSeconds(-1)).toBe("0:00.0");
		expect(formatSeconds(Number.NaN)).toBe("0:00.0");
	});

	it("carries rounded seconds into the next hour", () => {
		expect(formatSeconds(3599.96)).toBe("1:00:00.0");
	});

	it("keeps finite durations finite while rounding", () => {
		expect(formatSeconds(Number.MAX_VALUE)).not.toMatch(/Infinity|NaN/);
	});
});

describe("formatMs", () => {
	it("is formatSec over milliseconds", () => {
		expect(formatMs(65_400)).toBe("1:05.4");
		expect(formatMs(-1)).toBe("0:00.0");
		expect(formatMs(Number.NaN)).toBe("0:00.0");
	});

	it("inherits minute carry from formatSec", () => {
		expect(formatMs(59_960)).toBe("1:00.0");
	});
});
