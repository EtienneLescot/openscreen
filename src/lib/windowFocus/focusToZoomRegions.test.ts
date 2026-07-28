import { describe, expect, it } from "vitest";
import type { FocusRecordingData, FocusSample } from "./contracts";
import { focusTelemetryToZoomRegions, MIN_FOCUS_DWELL_MS } from "./focusToZoomRegions";

const DISPLAY = {
	id: 1,
	bounds: { x: 0, y: 0, width: 1600, height: 1000 },
	scaleFactor: 2,
	isPrimary: true,
};

function sample(overrides: Partial<FocusSample>): FocusSample {
	return {
		timeMs: 0,
		appName: "App",
		windowTitle: "Window",
		x: 400,
		y: 250,
		width: 800,
		height: 500,
		displayId: 1,
		...overrides,
	};
}

function data(samples: FocusSample[]): FocusRecordingData {
	return { version: 1, recordedDisplayId: 1, displays: [DISPLAY], samples };
}

describe("focusTelemetryToZoomRegions", () => {
	it("frames a focused window with a centered zoom region", () => {
		const regions = focusTelemetryToZoomRegions(data([sample({ timeMs: 0 })]), {
			totalMs: 10_000,
			existingRegions: [],
		});
		expect(regions).toHaveLength(1);
		expect(regions[0].startMs).toBe(0);
		expect(regions[0].endMs).toBe(10_000);
		expect(regions[0].focus.cx).toBeCloseTo(0.5, 2);
		expect(regions[0].focus.cy).toBeCloseTo(0.5, 2);
		// 800/1600 wide with margin → scale ≈ 1/0.56 ≈ 1.79
		expect(regions[0].customScale).toBeGreaterThan(1.5);
		expect(regions[0].customScale).toBeLessThan(2.1);
	});

	it("splits regions when focus moves to another window", () => {
		const regions = focusTelemetryToZoomRegions(
			data([
				sample({ timeMs: 0, appName: "Terminal", x: 100, y: 100, width: 700, height: 450 }),
				sample({ timeMs: 4000, appName: "Browser", x: 700, y: 300, width: 800, height: 600 }),
			]),
			{ totalMs: 10_000, existingRegions: [] },
		);
		expect(regions).toHaveLength(2);
		expect(regions[0].endMs).toBe(4000);
		expect(regions[1].startMs).toBe(4000);
		expect(regions[0].focus.cx).toBeLessThan(regions[1].focus.cx);
	});

	it("drops short dwells and merges brief interruptions", () => {
		const regions = focusTelemetryToZoomRegions(
			data([
				sample({ timeMs: 0, appName: "Main" }),
				// 400 ms detour — below MIN_FOCUS_DWELL_MS, then back to Main
				sample({ timeMs: 5000, appName: "Popup", x: 0, y: 0, width: 300, height: 200 }),
				sample({ timeMs: 5400, appName: "Main" }),
			]),
			{ totalMs: 12_000, existingRegions: [] },
		);
		expect(regions).toHaveLength(1);
		expect(regions[0].startMs).toBe(0);
		expect(regions[0].endMs).toBe(12_000);
	});

	it("skips near-fullscreen windows entirely", () => {
		const regions = focusTelemetryToZoomRegions(
			data([sample({ timeMs: 0, x: 0, y: 0, width: 1580, height: 990 })]),
			{ totalMs: 8000, existingRegions: [] },
		);
		expect(regions).toHaveLength(0);
	});

	it("caps the zoom scale for tiny windows", () => {
		const regions = focusTelemetryToZoomRegions(
			data([sample({ timeMs: 0, width: 200, height: 120 })]),
			{ totalMs: 8000, existingRegions: [] },
		);
		expect(regions).toHaveLength(1);
		expect(regions[0].customScale).toBeLessThanOrEqual(5);
	});

	it("never overlaps manually placed regions", () => {
		const regions = focusTelemetryToZoomRegions(data([sample({ timeMs: 0 })]), {
			totalMs: 10_000,
			existingRegions: [{ startMs: 2000, endMs: 3000 }],
		});
		expect(regions).toHaveLength(0);
	});

	it("ignores samples from other displays and short totals", () => {
		const regions = focusTelemetryToZoomRegions(data([sample({ timeMs: 0, displayId: 99 })]), {
			totalMs: 10_000,
			existingRegions: [],
		});
		expect(regions).toHaveLength(0);

		const shortRegions = focusTelemetryToZoomRegions(data([sample({ timeMs: 0 })]), {
			totalMs: MIN_FOCUS_DWELL_MS - 100,
			existingRegions: [],
		});
		expect(shortRegions).toHaveLength(0);
	});
});
