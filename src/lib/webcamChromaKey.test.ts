import { describe, expect, it } from "vitest";
import {
	DEFAULT_WEBCAM_CHROMA_KEY,
	normaliseChromaHex,
	normaliseChromaKeySettings,
} from "./webcamChromaKey";

describe("normaliseChromaHex", () => {
	it("canonicalises to lowercase #rrggbb", () => {
		expect(normaliseChromaHex("#00B140")).toBe("#00b140");
		expect(normaliseChromaHex("  #00b140  ")).toBe("#00b140");
		expect(normaliseChromaHex("00b140")).toBe("#00b140");
	});

	it("expands #rgb, so a round-trip can be compared", () => {
		// The compositor's `parse_hex` accepts both forms, so the app is the side
		// that has to settle on one — otherwise "#0f0" and "#00ff00" are the same
		// key stored two ways and never compare equal.
		expect(normaliseChromaHex("#0F0")).toBe("#00ff00");
		expect(normaliseChromaHex("#abc")).toBe("#aabbcc");
	});

	it("rejects anything that is not a hex colour", () => {
		expect(normaliseChromaHex("")).toBeNull();
		expect(normaliseChromaHex("green")).toBeNull();
		expect(normaliseChromaHex("#00b14")).toBeNull();
		expect(normaliseChromaHex("#gggggg")).toBeNull();
		expect(normaliseChromaHex("rgb(0,177,64)")).toBeNull();
	});
});

describe("normaliseChromaKeySettings", () => {
	it("fills every field from the defaults when the blob is empty or absent", () => {
		expect(normaliseChromaKeySettings(null)).toEqual(DEFAULT_WEBCAM_CHROMA_KEY);
		expect(normaliseChromaKeySettings(undefined)).toEqual(DEFAULT_WEBCAM_CHROMA_KEY);
		expect(normaliseChromaKeySettings({})).toEqual(DEFAULT_WEBCAM_CHROMA_KEY);
	});

	it("is off by default — the recorded camera must show through untouched", () => {
		expect(DEFAULT_WEBCAM_CHROMA_KEY.enabled).toBe(false);
	});

	it("clamps the thresholds into 0..1", () => {
		const s = normaliseChromaKeySettings({ similarity: 5, smoothness: -2, spill: 0.4 });
		expect(s.similarity).toBe(1);
		expect(s.smoothness).toBe(0);
		expect(s.spill).toBe(0.4);
	});

	it("falls back rather than propagating a non-finite threshold", () => {
		// `legacyEditor` is a passthrough envelope: a hand-edited project can hold
		// anything, and a NaN reaching the shader would blank the camera.
		const s = normaliseChromaKeySettings({
			similarity: Number.NaN,
			smoothness: Number.POSITIVE_INFINITY,
		});
		expect(s.similarity).toBe(DEFAULT_WEBCAM_CHROMA_KEY.similarity);
		expect(s.smoothness).toBe(DEFAULT_WEBCAM_CHROMA_KEY.smoothness);
	});

	it("falls back to the default colour when the stored one is unusable", () => {
		expect(normaliseChromaKeySettings({ color: "chartreuse" }).color).toBe(
			DEFAULT_WEBCAM_CHROMA_KEY.color,
		);
		expect(normaliseChromaKeySettings({ color: "#0F0" }).color).toBe("#00ff00");
	});
});
