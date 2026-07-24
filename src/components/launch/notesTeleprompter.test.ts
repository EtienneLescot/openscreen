import { describe, expect, it, vi } from "vitest";
import {
	clampNotesFontSize,
	clampTeleprompterSpeed,
	DEFAULT_NOTES_TELEPROMPTER_SETTINGS,
	getNextTeleprompterScrollTop,
	getTeleprompterFrame,
	loadInitialNotesContent,
	loadNotesTeleprompterSettings,
	MAX_NOTES_FONT_SIZE,
	MAX_TELEPROMPTER_FRAME_MS,
	MAX_TELEPROMPTER_SPEED,
	MIN_NOTES_FONT_SIZE,
	MIN_TELEPROMPTER_SPEED,
	NOTES_TELEPROMPTER_STORAGE_KEY,
	saveNotesContent,
	saveNotesTeleprompterSettings,
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
