import { describe, expect, it } from "vitest";
import {
	getAspectRatioValue,
	getNativeAspectRatioValue,
	isAspectRatio,
	parseAspectRatio,
	toAspectRatioToken,
} from "./aspectRatioUtils";

const FALLBACK_RATIO = 16 / 9;

describe("parseAspectRatio", () => {
	it("splits a well-formed token", () => {
		expect(parseAspectRatio("16:9")).toEqual({ width: 16, height: 9 });
		expect(parseAspectRatio(" 64 : 27 ")).toEqual({ width: 64, height: 27 });
	});

	it('rejects the legacy "native" sentinel and malformed input', () => {
		expect(parseAspectRatio("native")).toBeNull();
		expect(parseAspectRatio("16/9")).toBeNull();
		expect(parseAspectRatio("16:")).toBeNull();
		expect(parseAspectRatio("0:9")).toBeNull();
		expect(parseAspectRatio("-16:9")).toBeNull();
		expect(parseAspectRatio("")).toBeNull();
	});
});

describe("isAspectRatio", () => {
	it("accepts presets, free-form shapes and the legacy sentinel", () => {
		expect(isAspectRatio("16:9")).toBe(true);
		expect(isAspectRatio("64:27")).toBe(true);
		expect(isAspectRatio("native")).toBe(true);
	});

	it("rejects anything a project file could hold that isn't a ratio", () => {
		expect(isAspectRatio("widescreen")).toBe(false);
		expect(isAspectRatio(16 / 9)).toBe(false);
		expect(isAspectRatio(null)).toBe(false);
		expect(isAspectRatio(undefined)).toBe(false);
	});
});

describe("toAspectRatioToken", () => {
	it("reduces pixel dims to the shape they share", () => {
		expect(toAspectRatioToken(1920, 1080)).toBe("16:9");
		expect(toAspectRatioToken(3840, 2160)).toBe("16:9");
		expect(toAspectRatioToken(2160, 3840)).toBe("9:16");
		expect(toAspectRatioToken(2560, 1080)).toBe("64:27");
		expect(toAspectRatioToken(1080, 1080)).toBe("1:1");
	});

	it("returns null for unusable dimensions", () => {
		expect(toAspectRatioToken(0, 1080)).toBeNull();
		expect(toAspectRatioToken(1920, -1)).toBeNull();
		expect(toAspectRatioToken(Number.NaN, 1080)).toBeNull();
	});
});

describe("getAspectRatioValue", () => {
	it("evaluates presets and free-form shapes alike", () => {
		expect(getAspectRatioValue("16:9")).toBeCloseTo(16 / 9, 6);
		expect(getAspectRatioValue("9:16")).toBeCloseTo(9 / 16, 6);
		expect(getAspectRatioValue("64:27")).toBeCloseTo(64 / 27, 6);
	});

	it("falls back to 16/9 for the legacy sentinel, which has no document context here", () => {
		expect(getAspectRatioValue("native")).toBeCloseTo(FALLBACK_RATIO, 6);
	});
});

describe("getNativeAspectRatioValue", () => {
	it("returns the video ratio when no crop region is provided", () => {
		expect(getNativeAspectRatioValue(1920, 1080)).toBe(16 / 9);
	});

	it("applies crop width and height to the video ratio", () => {
		expect(getNativeAspectRatioValue(1920, 1080, { x: 0, y: 0, width: 0.5, height: 1 })).toBe(
			8 / 9,
		);
	});

	it("falls back when video metadata is zero or non-finite", () => {
		expect(getNativeAspectRatioValue(0, 1080)).toBe(FALLBACK_RATIO);
		expect(getNativeAspectRatioValue(1920, 0)).toBe(FALLBACK_RATIO);
		expect(getNativeAspectRatioValue(Number.NaN, 1080)).toBe(FALLBACK_RATIO);
		expect(getNativeAspectRatioValue(1920, Number.POSITIVE_INFINITY)).toBe(FALLBACK_RATIO);
	});

	it("falls back when crop dimensions are non-positive or non-finite", () => {
		expect(getNativeAspectRatioValue(1920, 1080, { x: 0, y: 0, width: 0, height: 1 })).toBe(
			FALLBACK_RATIO,
		);
		expect(getNativeAspectRatioValue(1920, 1080, { x: 0, y: 0, width: 1, height: -1 })).toBe(
			FALLBACK_RATIO,
		);
		expect(
			getNativeAspectRatioValue(1920, 1080, {
				x: 0,
				y: 0,
				width: Number.POSITIVE_INFINITY,
				height: 1,
			}),
		).toBe(FALLBACK_RATIO);
	});
});
