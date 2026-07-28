import { describe, expect, it } from "vitest";
import type { MultiWindowManifest } from "./contracts";
import { buildWindowSwitchTimeline, switchStateAt } from "./switchTimeline";

function manifest(samples: { timeMs: number; windowNumber: number }[]): MultiWindowManifest {
	return {
		version: 1,
		windows: [
			{
				windowId: 101,
				appName: "Terminal",
				title: "Terminal",
				videoPath: "/r/w0.mp4",
				bounds: { x: 100, y: 100, width: 800, height: 600 },
			},
			{
				windowId: 202,
				appName: "Browser",
				title: "Browser",
				videoPath: "/r/w1.mp4",
				bounds: { x: 900, y: 100, width: 700, height: 600 },
			},
		],
		focus: {
			version: 1,
			recordedDisplayId: 1,
			displays: [],
			samples: samples.map((sample) => ({
				timeMs: sample.timeMs,
				windowNumber: sample.windowNumber,
				appName: "",
				windowTitle: "",
				x: 0,
				y: 0,
				width: 100,
				height: 100,
				displayId: 1,
			})),
		},
		durationMs: 20_000,
	};
}

describe("buildWindowSwitchTimeline", () => {
	it("switches at focus changes with geometry-based slide direction", () => {
		const timeline = buildWindowSwitchTimeline(
			manifest([
				{ timeMs: 0, windowNumber: 101 },
				{ timeMs: 8000, windowNumber: 202 },
			]),
			20_000,
		);
		expect(timeline.segments).toEqual([
			{ windowIndex: 0, startMs: 0, endMs: 8000 },
			{ windowIndex: 1, startMs: 8000, endMs: 20_000 },
		]);
		expect(timeline.transitions).toHaveLength(1);
		// Browser sits to the right of Terminal → slides in from the right.
		expect(timeline.transitions[0].direction).toBe("from-right");
	});

	it("keeps the previous window when focus moves to an unrecorded window", () => {
		const timeline = buildWindowSwitchTimeline(
			manifest([
				{ timeMs: 0, windowNumber: 101 },
				{ timeMs: 5000, windowNumber: 999 },
				{ timeMs: 9000, windowNumber: 202 },
			]),
			20_000,
		);
		expect(timeline.segments.map((segment) => segment.windowIndex)).toEqual([0, 1]);
		expect(timeline.segments[1].startMs).toBe(9000);
	});

	it("ignores sub-dwell focus flickers", () => {
		const timeline = buildWindowSwitchTimeline(
			manifest([
				{ timeMs: 0, windowNumber: 101 },
				{ timeMs: 6000, windowNumber: 202 },
				{ timeMs: 6400, windowNumber: 101 },
			]),
			20_000,
		);
		expect(timeline.segments).toHaveLength(1);
		expect(timeline.segments[0].windowIndex).toBe(0);
	});

	it("defaults to the primary window without focus data", () => {
		const timeline = buildWindowSwitchTimeline(manifest([]), 10_000);
		expect(timeline.segments).toEqual([{ windowIndex: 0, startMs: 0, endMs: 10_000 }]);
		expect(timeline.transitions).toHaveLength(0);
	});
});

describe("switchStateAt", () => {
	const timeline = buildWindowSwitchTimeline(
		manifest([
			{ timeMs: 0, windowNumber: 101 },
			{ timeMs: 8000, windowNumber: 202 },
		]),
		20_000,
		400,
	);

	it("reports plain segments outside transitions", () => {
		expect(switchStateAt(timeline, 1000)).toEqual({ activeIndex: 0 });
		expect(switchStateAt(timeline, 15_000)).toEqual({ activeIndex: 1 });
	});

	it("reports eased progress inside the transition window", () => {
		const mid = switchStateAt(timeline, 8000);
		expect(mid.transition).toBeDefined();
		expect(mid.transition?.outgoingIndex).toBe(0);
		expect(mid.transition?.incomingIndex).toBe(1);
		expect(mid.transition?.progress).toBeCloseTo(0.5, 1);
		const early = switchStateAt(timeline, 7800);
		expect(early.transition?.progress ?? 1).toBeLessThan(0.5);
	});
});
