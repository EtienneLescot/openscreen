import { describe, expect, it } from "vitest";
import { resolveAudioPreviewTime } from "./VirtualPreview";

describe("resolveAudioPreviewTime", () => {
	it("delays audio for a positive offset", () => {
		expect(resolveAudioPreviewTime(0.1, 160, 10)).toEqual({ targetTimeSec: 0, shouldPlay: false });
		expect(resolveAudioPreviewTime(1, 160, 10)).toEqual({ targetTimeSec: 0.84, shouldPlay: true });
	});

	it("advances audio for a negative offset", () => {
		expect(resolveAudioPreviewTime(1, -160, 10)).toEqual({ targetTimeSec: 1.16, shouldPlay: true });
	});

	it("stops instead of seeking past the track", () => {
		expect(resolveAudioPreviewTime(9.9, -160, 10)).toEqual({
			targetTimeSec: 10,
			shouldPlay: false,
		});
	});

	it("plays while the duration is still unknown", () => {
		expect(resolveAudioPreviewTime(1, 0, Number.NaN)).toEqual({
			targetTimeSec: 1,
			shouldPlay: true,
		});
	});
});
