import { describe, expect, it } from "vitest";
import { formatMs, formatSec, formatSeconds, splitRoundedTime } from "./format";

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
		// Asserted exactly, not as `not.toMatch(/Infinity|NaN/)`: that weaker form
		// passes against the pre-carry implementation too, so it pinned nothing.
		expect(formatSec(Number.MAX_VALUE)).toBe("2.9961552247705265e+306:08.0");
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
		// Exact, for the same reason as the formatSec case above.
		expect(formatSeconds(Number.MAX_VALUE)).toBe("4.993592041284211e+304:56:08.0");
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

// Both formatters above depend on this carry, so it is pinned directly: a
// regression reads as one failing case here rather than as two failing format
// assertions that don't say why.
describe("splitRoundedTime", () => {
	it("carries a second that rounds up to 60 into the minute field", () => {
		expect(splitRoundedTime(59.96)).toEqual({ totalMinutes: 1, seconds: 0 });
	});

	it("does not carry when the second stays under 60", () => {
		expect(splitRoundedTime(59.94)).toEqual({ totalMinutes: 0, seconds: 59.9 });
	});

	it("carries across the hour boundary as plain minutes", () => {
		expect(splitRoundedTime(3599.96)).toEqual({ totalMinutes: 60, seconds: 0 });
	});

	it("floors junk to zero", () => {
		expect(splitRoundedTime(Number.NaN)).toEqual({ totalMinutes: 0, seconds: 0 });
		expect(splitRoundedTime(-1)).toEqual({ totalMinutes: 0, seconds: 0 });
	});
});
