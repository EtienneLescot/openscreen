import { describe, expect, it } from "vitest";
import {
	parseMacDisplayIdFromSourceId,
	parseMacWindowIdFromSourceId,
	shouldRequestMacCursorAccess,
} from "./nativeMacRecording";

describe("nativeMacRecording source parsing", () => {
	it("requests cursor Accessibility only when native macOS capture can run", () => {
		expect(
			shouldRequestMacCursorAccess("darwin", "editable-overlay", {
				success: true,
				available: true,
			}),
		).toBe(true);
		expect(
			shouldRequestMacCursorAccess("darwin", "editable-overlay", {
				success: true,
				available: false,
				reason: "unsupported-os",
			}),
		).toBe(false);
		expect(
			shouldRequestMacCursorAccess("darwin", "system", {
				success: true,
				available: true,
			}),
		).toBe(false);
		expect(
			shouldRequestMacCursorAccess("win32", "editable-overlay", {
				success: true,
				available: true,
			}),
		).toBe(false);
	});

	it("parses Electron window source ids into ScreenCaptureKit window ids", () => {
		expect(parseMacWindowIdFromSourceId("window:12345:0")).toBe(12345);
		expect(parseMacWindowIdFromSourceId("window:987")).toBe(987);
	});

	it("rejects non-window source ids for window parsing", () => {
		expect(parseMacWindowIdFromSourceId("screen:1:0")).toBeNull();
		expect(parseMacWindowIdFromSourceId("window:not-a-number:0")).toBeNull();
		expect(parseMacWindowIdFromSourceId(null)).toBeNull();
	});

	it("parses Electron display source ids into ScreenCaptureKit display ids", () => {
		expect(parseMacDisplayIdFromSourceId("screen:1:0")).toBe(1);
		expect(parseMacDisplayIdFromSourceId("screen:69733248")).toBe(69733248);
	});

	it("rejects non-display source ids for display parsing", () => {
		expect(parseMacDisplayIdFromSourceId("window:123:0")).toBeNull();
		expect(parseMacDisplayIdFromSourceId("screen:not-a-number:0")).toBeNull();
		expect(parseMacDisplayIdFromSourceId(undefined)).toBeNull();
	});
});
