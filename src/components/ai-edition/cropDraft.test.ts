import { describe, expect, it } from "vitest";
import {
	cropDraftFromRegion,
	displayPct,
	PREVIEW_MAX_HEIGHT_PX,
	previewBoxStyle,
	stepPct,
} from "./cropDraft";

describe("crop draft helpers", () => {
	it("steps one source pixel, not 1%, when the frame width is known", () => {
		expect(stepPct(1920)).toBe(100 / 1920);
		expect(stepPct(1920)).not.toBe(1);
	});

	it("falls back to a fine percent step when the frame size is unknown", () => {
		expect(stepPct(0)).toBe(0.1);
	});

	it("gives the preview box the video's own aspect ratio", () => {
		// The overlay and every drag are measured against the box while the
		// video letterboxes inside it — any box/video aspect mismatch shifts
		// the crop off the pixels it claims to select.
		for (const aspect of [16 / 9, 784 / 1082, 21 / 9]) {
			const style = previewBoxStyle(aspect);
			expect(style.aspectRatio).toBe(`${aspect}`);
			// Width is derived from the height cap so a clamped height can
			// never silently break the ratio (CSS keeps width and drops the
			// ratio when max-height wins).
			expect(style.width).toBe(`min(100%, calc(${PREVIEW_MAX_HEIGHT_PX}px * ${aspect}))`);
		}
	});

	it("falls back to 16:9 while the video metadata has not loaded", () => {
		for (const bogus of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(previewBoxStyle(bogus).aspectRatio).toBe(`${16 / 9}`);
		}
	});

	it("stores the draft as unrounded fractions", () => {
		const draft = cropDraftFromRegion({ x: 1 / 3, y: 0.1, width: 0.5, height: 0.8 });
		expect(draft.x).toBe(1 / 3);
		expect(draft.x).not.toBe(33);
	});

	it("formats field display to two decimals without touching the stored value", () => {
		expect(displayPct((1 / 3) * 100)).toBe(33.33);
		expect(displayPct(100)).toBe(100);
		expect(displayPct(0)).toBe(0);
		// One source pixel on a 1920-wide frame is ~0.052% — two display
		// decimals stay within a fifth of a pixel of the stored fraction.
		expect(Math.abs(displayPct(33.333333) - 33.333333)).toBeLessThan(stepPct(1920) / 5);
	});
});
