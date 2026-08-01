import { describe, expect, it } from "vitest";
import type { CursorTelemetryPoint } from "@/components/video-editor/types";
import type { AxcutClip } from "../schema";
import {
	buildAutoZoomSuggestions,
	buildAutoZoomSuggestionsForClips,
	detectZoomDwellCandidates,
} from "./zoom-suggestions";

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

describe("buildAutoZoomSuggestionsForClips", () => {
	const clip = (
		id: string,
		assetId: string,
		sourceStartSec: number,
		sourceEndSec: number,
		timelineStartSec: number,
	): AxcutClip => ({
		id,
		assetId,
		sourceStartSec,
		sourceEndSec,
		timelineStartSec,
		timelineEndSec: timelineStartSec + (sourceEndSec - sourceStartSec),
		wordRefs: [],
		origin: "user",
		reason: "",
	});

	// The bug this covers: telemetry is in the recording's SOURCE time, zoom regions are
	// authored in RAW TIMELINE ms, and the two only coincide for a single clip starting at
	// 0. Every other layout put all the zooms on the first clip's stretch of ruler.
	it("gives a dwell to EVERY clip that replays it, not just the first", () => {
		// One recording, laid down twice: source 0-10 at ruler 0-10, then again at 10-20.
		const clips = [clip("clip_1", "a1", 0, 10, 0), clip("clip_2", "a1", 0, 10, 10)];
		const suggestions = buildAutoZoomSuggestionsForClips({
			cursorTelemetry: dwell(4000, 0.3, 0.7),
			assetId: "a1",
			clips,
			existingRegions: [],
			defaultDurationMs: 2000,
		});
		expect(suggestions.map((s) => s.span)).toEqual([
			{ start: 3000, end: 5000 }, // clip_1: source 4s sits at ruler 4s
			{ start: 13000, end: 15000 }, // clip_2: the SAME source 4s sits at ruler 14s
		]);
		for (const suggestion of suggestions) {
			expect(suggestion.focus.cx).toBeCloseTo(0.3, 5);
			expect(suggestion.focus.cy).toBeCloseTo(0.7, 5);
		}
	});

	it("shifts a dwell by the clip's own source in-point", () => {
		// A clip that starts 30s into the recording: source 34s is ruler 4s.
		const clips = [clip("clip_1", "a1", 30, 40, 0)];
		const suggestions = buildAutoZoomSuggestionsForClips({
			cursorTelemetry: dwell(34000, 0.5, 0.5),
			assetId: "a1",
			clips,
			existingRegions: [],
			defaultDurationMs: 2000,
		});
		expect(suggestions.map((s) => s.span)).toEqual([{ start: 3000, end: 5000 }]);
	});

	it("ignores a dwell that falls outside every clip's source window", () => {
		// The recording is long; the timeline keeps only its first 10s.
		const clips = [clip("clip_1", "a1", 0, 10, 0)];
		expect(
			buildAutoZoomSuggestionsForClips({
				cursorTelemetry: dwell(45000, 0.5, 0.5),
				assetId: "a1",
				clips,
				existingRegions: [],
				defaultDurationMs: 2000,
			}),
		).toEqual([]);
	});

	it("reserves an existing zoom on the clip it actually sits on, and only there", () => {
		// A zoom already covers the dwell on clip_1's ruler span. clip_1 yields; clip_2
		// replays the same source moment on a free stretch of ruler, so it still gets one.
		// Compared in source ms — the frame the caller used to hand down — that one region
		// suppressed the whole recording's worth of suggestions.
		const clips = [clip("clip_1", "a1", 0, 10, 0), clip("clip_2", "a1", 0, 10, 10)];
		const suggestions = buildAutoZoomSuggestionsForClips({
			cursorTelemetry: dwell(4000, 0.5, 0.5),
			assetId: "a1",
			clips,
			existingRegions: [{ startMs: 3500, endMs: 4500 }],
			defaultDurationMs: 2000,
		});
		expect(suggestions.map((s) => s.span)).toEqual([{ start: 13000, end: 15000 }]);
	});

	it("only reads the clips of the asset the telemetry belongs to", () => {
		const clips = [clip("clip_1", "a1", 0, 10, 0), clip("clip_2", "a2", 0, 10, 10)];
		const suggestions = buildAutoZoomSuggestionsForClips({
			cursorTelemetry: dwell(4000, 0.5, 0.5),
			assetId: "a2",
			clips,
			existingRegions: [],
			defaultDurationMs: 2000,
		});
		expect(suggestions.map((s) => s.span)).toEqual([{ start: 13000, end: 15000 }]);
	});

	it("skips a clip whose duration has not been probed yet", () => {
		const clips = [clip("clip_1", "a1", 0, 0, 0)];
		expect(
			buildAutoZoomSuggestionsForClips({
				cursorTelemetry: dwell(4000, 0.5, 0.5),
				assetId: "a1",
				clips,
				existingRegions: [],
				defaultDurationMs: 2000,
			}),
		).toEqual([]);
	});
});
