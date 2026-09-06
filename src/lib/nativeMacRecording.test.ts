import { describe, expect, it } from "vitest";
import {
	collectMacCaptureExcludedWindowIds,
	parseMacDisplayIdFromSourceId,
	parseMacWindowIdFromSourceId,
} from "./nativeMacRecording";

describe("nativeMacRecording source parsing", () => {
	it("collects unique native window ids for ScreenCaptureKit exclusion", () => {
		expect(
			collectMacCaptureExcludedWindowIds([
				"window:42:0",
				"screen:1:0",
				"window:7:0",
				"window:42:0",
				"window:not-a-number:0",
				null,
			]),
		).toEqual([42, 7]);
		expect(collectMacCaptureExcludedWindowIds([])).toEqual([]);
	});

	it("rejects window ids outside the ScreenCaptureKit UInt32 range", () => {
		expect(
			collectMacCaptureExcludedWindowIds([
				"window:0:0",
				"window:4294967295:0",
				"window:4294967296:0",
			]),
		).toEqual([4294967295]);
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
