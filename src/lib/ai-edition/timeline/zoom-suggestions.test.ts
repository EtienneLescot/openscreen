import { describe, expect, it } from "vitest";
import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import { buildAutoZoomSuggestions, detectZoomDwellCandidates } from "./zoom-suggestions";

// A dwell = many samples clustered in time at (nearly) the same position.
function dwell(
	centerMs: number,
	cx: number,
	cy: number,
	count = 6,
	spanMs = 900,
): CursorTelemetryPoint[] {
	const step = spanMs / (count - 1);
	return Array.from({ length: count }, (_, i) => ({
		timeMs: centerMs - spanMs / 2 + i * step,
		cx,
		cy,
	}));
}

describe("detectZoomDwellCandidates", () => {
	it("finds a dwell where the cursor sits still", () => {
		const candidates = detectZoomDwellCandidates(dwell(1000, 0.4, 0.6));
		expect(candidates).toHaveLength(1);
		expect(candidates[0].focus.cx).toBeCloseTo(0.4, 5);
		expect(candidates[0].focus.cy).toBeCloseTo(0.6, 5);
	});

	it("ignores a fast sweep across the screen (no dwell)", () => {
		const samples: CursorTelemetryPoint[] = Array.from({ length: 10 }, (_, i) => ({
			timeMs: i * 100,
			cx: i / 10,
			cy: i / 10,
		}));
		expect(detectZoomDwellCandidates(samples)).toHaveLength(0);
	});
});

describe("buildAutoZoomSuggestions", () => {
	it("returns a centered span around each accepted dwell", () => {
		const telemetry = dwell(2000, 0.5, 0.5);
		const suggestions = buildAutoZoomSuggestions({
			cursorTelemetry: telemetry,
			totalMs: 5000,
			existingRegions: [],
			defaultDurationMs: 2000,
		});
		expect(suggestions).toHaveLength(1);
		// centred on ~2000ms with a 2000ms default → ~1000..3000
		expect(suggestions[0].span.start).toBe(1000);
		expect(suggestions[0].span.end).toBe(3000);
	});

	it("drops candidates overlapping an existing zoom region", () => {
		const telemetry = dwell(2000, 0.5, 0.5);
		const suggestions = buildAutoZoomSuggestions({
			cursorTelemetry: telemetry,
			totalMs: 5000,
			existingRegions: [{ startMs: 1500, endMs: 2500 }],
			defaultDurationMs: 2000,
		});
		expect(suggestions).toHaveLength(0);
	});

	it("spaces two dwells and returns both when far apart", () => {
		const telemetry = [...dwell(1500, 0.2, 0.2), ...dwell(6000, 0.8, 0.8)];
		const suggestions = buildAutoZoomSuggestions({
			cursorTelemetry: telemetry,
			totalMs: 9000,
			existingRegions: [],
			defaultDurationMs: 1500,
		});
		expect(suggestions.length).toBe(2);
	});

	it("returns nothing without telemetry", () => {
		expect(
			buildAutoZoomSuggestions({
				cursorTelemetry: [],
				totalMs: 5000,
				existingRegions: [],
				defaultDurationMs: 2000,
			}),
		).toEqual([]);
	});
});
