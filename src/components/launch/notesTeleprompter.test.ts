import { describe, expect, it, vi } from "vitest";
import {
	clampNotesFontSize,
	clampTeleprompterSpeed,
	DEFAULT_NOTES_TELEPROMPTER_SETTINGS,
	getMaxScrollTop,
	getNextTeleprompterScrollTop,
	getTeleprompterFrame,
	isAtTeleprompterEnd,
	loadInitialNotesContent,
	loadNotesTeleprompterSettings,
	MAX_NOTES_FONT_SIZE,
	MAX_TELEPROMPTER_FRAME_MS,
	MAX_TELEPROMPTER_SPEED,
	MIN_NOTES_FONT_SIZE,
	MIN_TELEPROMPTER_SPEED,
	NOTES_TELEPROMPTER_STORAGE_KEY,
	resolveTeleprompterPosition,
	saveNotesContent,
	saveNotesTeleprompterSettings,
	TELEPROMPTER_SCROLL_TOLERANCE_PX,
} from "./notesTeleprompter";

describe("Notes teleprompter settings", () => {
	it("uses defaults when storage is empty, corrupt, or throws", () => {
		expect(loadNotesTeleprompterSettings({ getItem: () => null })).toEqual(
			DEFAULT_NOTES_TELEPROMPTER_SETTINGS,
		);
		expect(loadNotesTeleprompterSettings({ getItem: () => "not json" })).toEqual(
			DEFAULT_NOTES_TELEPROMPTER_SETTINGS,
		);
		expect(
			loadNotesTeleprompterSettings({
				getItem: () => {
					throw new Error("denied");
				},
			}),
		).toEqual(DEFAULT_NOTES_TELEPROMPTER_SETTINGS);
	});

	it("clamps persisted values and ignores non-setting fields", () => {
		const stored = JSON.stringify({
			speed: 1_000,
			fontSize: 1,
			mirrored: true,
			isPlaying: true,
		});
		expect(loadNotesTeleprompterSettings({ getItem: () => stored })).toEqual({
			speed: MAX_TELEPROMPTER_SPEED,
			fontSize: MIN_NOTES_FONT_SIZE,
			mirrored: true,
		});
	});

	it("round-trips only speed, font size, and mirror", () => {
		const setItem = vi.fn();
		expect(
			saveNotesTeleprompterSettings({ speed: 70, fontSize: 24, mirrored: true }, { setItem }),
		).toBe(true);
		expect(setItem).toHaveBeenCalledWith(
			NOTES_TELEPROMPTER_STORAGE_KEY,
			JSON.stringify({ speed: 70, fontSize: 24, mirrored: true }),
		);
	});

	it("tolerates storage write failures", () => {
		expect(
			saveNotesTeleprompterSettings(DEFAULT_NOTES_TELEPROMPTER_SETTINGS, {
				setItem: () => {
					throw new Error("denied");
				},
			}),
		).toBe(false);
	});

	it("enforces speed and font-size bounds", () => {
		expect(clampTeleprompterSpeed(0)).toBe(MIN_TELEPROMPTER_SPEED);
		expect(clampTeleprompterSpeed(1_000)).toBe(MAX_TELEPROMPTER_SPEED);
		expect(clampNotesFontSize(0)).toBe(MIN_NOTES_FONT_SIZE);
		expect(clampNotesFontSize(1_000)).toBe(MAX_NOTES_FONT_SIZE);
	});
});

describe("Notes content compatibility", () => {
	it("preserves HTML and converts escaped legacy plain text", () => {
		expect(loadInitialNotesContent({ getItem: () => "<p>Saved</p>" })).toBe("<p>Saved</p>");
		expect(loadInitialNotesContent({ getItem: () => "One & <two>\nThree" })).toBe(
			"<p>One &amp; &lt;two&gt;</p><p>Three</p>",
		);
	});

	it("falls back safely when content storage throws", () => {
		expect(
			loadInitialNotesContent({
				getItem: () => {
					throw new Error("denied");
				},
			}),
		).toBe("");
		expect(
			saveNotesContent("<p>Saved</p>", {
				setItem: () => {
					throw new Error("denied");
				},
			}),
		).toBe(false);
	});
});

describe("Notes teleprompter frame math", () => {
	it("initializes and resets without moving for invalid or backward timestamps", () => {
		expect(getTeleprompterFrame(null, 100)).toEqual({
			elapsedMs: 0,
			nextTimestamp: 100,
		});
		expect(getTeleprompterFrame(100, Number.NaN)).toEqual({
			elapsedMs: 0,
			nextTimestamp: null,
		});
		expect(getTeleprompterFrame(100, 90)).toEqual({
			elapsedMs: 0,
			nextTimestamp: 90,
		});
	});

	it("clamps long frame gaps", () => {
		expect(getTeleprompterFrame(100, 1_000)).toEqual({
			elapsedMs: MAX_TELEPROMPTER_FRAME_MS,
			nextTimestamp: 1_000,
		});
	});

	it("advances in pixels per second without crossing the bottom", () => {
		expect(getNextTeleprompterScrollTop(10, 40, 100, 100)).toBe(14);
		expect(getNextTeleprompterScrollTop(98, 40, 100, 100)).toBe(100);
		expect(getNextTeleprompterScrollTop(Number.NaN, 40, -1, 100)).toBe(0);
	});
});

describe("Notes teleprompter scroll position tracking", () => {
	it("keeps the tracked sub-pixel position when the DOM only rounds it", () => {
		const tracked = 12.4;
		expect(resolveTeleprompterPosition(tracked, Math.floor(tracked))).toBe(tracked);
		expect(resolveTeleprompterPosition(tracked, tracked + TELEPROMPTER_SCROLL_TOLERANCE_PX)).toBe(
			tracked,
		);
	});

	it("hands control back to the DOM once the reader scrolls by hand", () => {
		expect(resolveTeleprompterPosition(12.4, 300)).toBe(300);
		expect(resolveTeleprompterPosition(300, 12.4)).toBe(12.4);
	});

	it("falls back safely for unusable inputs", () => {
		expect(resolveTeleprompterPosition(12.4, Number.NaN)).toBe(12.4);
		expect(resolveTeleprompterPosition(Number.NaN, 12.4)).toBe(12.4);
		expect(resolveTeleprompterPosition(Number.NaN, Number.NaN)).toBe(0);
		expect(resolveTeleprompterPosition(-5, -5)).toBe(0);
	});

	it("reports the end only when there is something to scroll", () => {
		expect(isAtTeleprompterEnd(100, 100)).toBe(true);
		expect(isAtTeleprompterEnd(100 - TELEPROMPTER_SCROLL_TOLERANCE_PX, 100)).toBe(true);
		expect(isAtTeleprompterEnd(50, 100)).toBe(false);

		// A note that fits the window has nowhere to go — playback stays armed instead of
		// snapping straight back to paused.
		expect(isAtTeleprompterEnd(0, 0)).toBe(false);
		expect(isAtTeleprompterEnd(0, Number.NaN)).toBe(false);
	});

	it("derives the scrollable distance without going negative", () => {
		expect(getMaxScrollTop({ scrollHeight: 200, clientHeight: 100 })).toBe(100);
		expect(getMaxScrollTop({ scrollHeight: 100, clientHeight: 100 })).toBe(0);
		expect(getMaxScrollTop({ scrollHeight: 50, clientHeight: 100 })).toBe(0);
	});
});
