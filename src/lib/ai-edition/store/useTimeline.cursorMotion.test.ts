// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import type { CursorMotionTelemetrySample } from "@/lib/cursor/cursorMotion";
import type { AxcutCursorMotionRegion, AxcutDocument } from "../schema";
import { axcutSchemaVersion } from "../schema";
import { useProjectStore } from "./projectStore";
import { useTimeline } from "./useTimeline";

const renderTimeline = () => renderHook(() => useTimeline(), { wrapper: I18nProvider });

vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

const bridgeMocks = vi.hoisted(() => ({
	get: vi.fn(),
	create: vi.fn(),
	save: vi.fn(),
	addAsset: vi.fn(),
	removeAsset: vi.fn(),
	listProjects: vi.fn(),
}));

vi.mock("@/native/client", () => ({
	nativeBridgeClient: { aiEdition: bridgeMocks },
}));

const baseDoc: AxcutDocument = {
	schemaVersion: axcutSchemaVersion,
	project: {
		id: "proj_cm",
		title: "Cursor motion",
		createdAt: "2026-08-31T10:00:00.000Z",
		updatedAt: "2026-08-31T10:00:00.000Z",
		primaryAssetId: "asset_1",
	},
	assets: [
		{
			id: "asset_1",
			kind: "video",
			label: "screen.webm",
			originalPath: "/tmp/screen.webm",
			durationSec: 10,
			video: { codec: "unknown", width: 1920, height: 1080, fps: 0 },
			cameraTrack: null,
		},
	],
	transcript: null,
	transcripts: [],
	timeline: {
		clips: [
			{
				id: "clip_a",
				assetId: "asset_1",
				sourceStartSec: 0,
				sourceEndSec: 10,
				timelineStartSec: 0,
				timelineEndSec: 10,
				wordRefs: [],
				origin: "user",
				reason: "",
			},
		],
		gaps: [],
		trimRanges: [],
		muteRanges: [],
		speedRanges: [],
		captionRanges: [],
	},
	annotations: [],
	zoomRanges: [],
	cursorMotionRegions: [],
	legacyEditor: null,
};

/**
 * A capture that moves, holds still for 450 ms, moves again, then clicks. The
 * hold is what the rest detector is meant to find: 450 ms is over its 300 ms
 * floor and the points never leave a 0.009-wide circle. Samples are 50 ms apart,
 * well inside the detector's 150 ms maximum gap, so nothing here reads as
 * telemetry dropping out.
 */
function tracedCapture(): CursorMotionTelemetrySample[] {
	const samples: CursorMotionTelemetrySample[] = [];
	for (let t = 1000; t <= 1100; t += 50) {
		samples.push({ timeMs: t, cx: 0.1 + (t - 1000) / 3000, cy: 0.5, interactionType: "move" });
	}
	for (let t = 1150; t <= 1600; t += 50) {
		samples.push({ timeMs: t, cx: 0.14, cy: 0.5, interactionType: "move" });
	}
	for (let t = 1650; t <= 2450; t += 50) {
		samples.push({ timeMs: t, cx: 0.14 + (t - 1650) / 1600, cy: 0.5, interactionType: "move" });
	}
	samples.push({ timeMs: 2500, cx: 0.9, cy: 0.5, interactionType: "click" });
	return samples;
}

const seed = (regions: AxcutCursorMotionRegion[] = [], currentTimeSec = 1) => {
	useProjectStore.setState({
		projectId: "proj_cm",
		document: { ...baseDoc, cursorMotionRegions: regions },
		revision: 1,
		status: "ready",
		error: null,
		currentTimeSec,
	});
};

const storedRegions = () => useProjectStore.getState().document?.cursorMotionRegions ?? [];

const moveRegion = (patch: Partial<AxcutCursorMotionRegion> = {}): AxcutCursorMotionRegion => ({
	id: "cm_move",
	startMs: 1000,
	endMs: 3000,
	clipId: "clip_a",
	assetId: "asset_1",
	sourceStartSec: 1,
	sourceEndSec: 3,
	startPoint: { cx: 0.1, cy: 0.5 },
	endPoint: { cx: 0.9, cy: 0.5 },
	controlPoint: { cx: 0.5, cy: 0.1 },
	startAnchor: "manual",
	endAnchor: "click",
	segmentKind: "move",
	preset: "arc",
	speed: 3,
	cycles: 4,
	easing: "ease-in",
	...patch,
});

beforeEach(() => {
	useProjectStore.getState().clear();
	for (const mock of Object.values(bridgeMocks)) mock.mockReset();
	bridgeMocks.save.mockImplementation(async (doc: AxcutDocument) => ({
		success: true,
		document: doc,
	}));
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("addCursorMotion", () => {
	it("splits the stretch at the rest and the click, and writes it in one save", async () => {
		seed();
		const { result } = renderTimeline();

		await act(async () => {
			expect(await result.current.addCursorMotion(tracedCapture())).toBeGreaterThan(1);
		});

		const regions = storedRegions();
		// move → hold → move, i.e. the rest is carved out of the path instead of
		// being curved through. Its own kind, not a shorter move.
		expect(regions.map((r) => r.segmentKind)).toContain("hold");
		expect(regions.map((r) => r.segmentKind)).toContain("move");
		// One document write for the whole auto-split: the user pressed one button,
		// so Ctrl+Z takes back one thing.
		expect(bridgeMocks.save).toHaveBeenCalledTimes(1);
		// Sections tile the span without gaps or overlap — a hole would leave a
		// stretch of path nothing owns.
		const ordered = [...regions].sort((a, b) => a.startMs - b.startMs);
		for (let i = 1; i < ordered.length; i += 1) {
			expect(ordered[i].startMs).toBe(ordered[i - 1].endMs);
		}
	});

	it("creates every section inert, so nothing on screen changes", async () => {
		// The non-destructive default. If a fresh section arrived as anything but
		// `recorded` at 1x, pressing the button would silently restyle footage.
		seed();
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.addCursorMotion(tracedCapture());
		});
		for (const region of storedRegions()) {
			expect(region.preset).toBe("recorded");
			expect(region.speed).toBe(1);
		}
	});

	it("anchors every section to the clip under the playhead", async () => {
		seed();
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.addCursorMotion(tracedCapture());
		});
		for (const region of storedRegions()) {
			expect(region.clipId).toBe("clip_a");
			expect(region.assetId).toBe("asset_1");
		}
	});

	it("writes nothing when no recorded click follows the playhead", async () => {
		// The section has to end SOMEWHERE the recording chose. With no later click
		// there is no destination, and inventing one would put the cursor somewhere
		// the user never clicked.
		seed();
		const { result } = renderTimeline();
		const clickless = tracedCapture().filter((s) => s.interactionType !== "click");

		await act(async () => {
			expect(await result.current.addCursorMotion(clickless)).toBe(0);
		});

		expect(storedRegions()).toHaveLength(0);
		expect(bridgeMocks.save).not.toHaveBeenCalled();
	});

	it("writes nothing when the recording carries no cursor samples at all", async () => {
		seed();
		const { result } = renderTimeline();
		await act(async () => {
			expect(await result.current.addCursorMotion([])).toBe(0);
		});
		expect(bridgeMocks.save).not.toHaveBeenCalled();
	});
});

describe("applyCursorMotionToAllMoves", () => {
	it("copies the styling to every move and leaves the holds alone", async () => {
		const hold = moveRegion({
			id: "cm_hold",
			segmentKind: "hold",
			preset: "recorded",
			speed: 1,
			cycles: 1,
			easing: "ease-in-out",
		});
		const other = moveRegion({ id: "cm_other", preset: "straight", speed: 1, cycles: 1 });
		seed([moveRegion(), hold, other]);
		const { result } = renderTimeline();

		await act(async () => {
			expect(await result.current.applyCursorMotionToAllMoves("cm_move")).toBe(2);
		});

		const byId = Object.fromEntries(storedRegions().map((r) => [r.id, r]));
		expect(byId.cm_other).toMatchObject({
			preset: "arc",
			speed: 3,
			cycles: 4,
			easing: "ease-in",
		});
		// A hold has no path to shape; restyling it would be writing a preset onto a
		// section that renders nothing.
		expect(byId.cm_hold).toMatchObject({ preset: "recorded", speed: 1 });
	});

	it("does not copy the control point", async () => {
		// The control point is an ABSOLUTE position on the frame, not a shape
		// parameter. Copying it would drag every other path towards this one's
		// midpoint — which is exactly why the button says "apply the settings", and
		// why #113 excluded it too.
		const other = moveRegion({ id: "cm_other", controlPoint: { cx: 0.8, cy: 0.9 } });
		seed([moveRegion(), other]);
		const { result } = renderTimeline();

		await act(async () => {
			await result.current.applyCursorMotionToAllMoves("cm_move");
		});

		const target = storedRegions().find((r) => r.id === "cm_other");
		expect(target?.controlPoint).toEqual({ cx: 0.8, cy: 0.9 });
	});
});

describe("splitCursorMotionAtPlayhead", () => {
	it("cuts at the playhead and makes the halves meet on the path", async () => {
		seed([moveRegion()], 2);
		const { result } = renderTimeline();

		await act(async () => {
			expect(await result.current.splitCursorMotionAtPlayhead("cm_move")).toBe(true);
		});

		const halves = [...storedRegions()].sort((a, b) => a.startMs - b.startMs);
		expect(halves).toHaveLength(2);
		// The shared point is sampled off the ORIGINAL curve, not interpolated between
		// the endpoints: the two halves have to meet where the cursor already passed,
		// or splitting an arc visibly teleports it.
		expect(halves[0].endPoint).toEqual(halves[1].startPoint);
		expect(halves[0].endPoint.cy).toBeLessThan(0.5);
		// The cut is the editor's, so it is `manual` on both sides — it did not come
		// from a rest or a click in the recording.
		expect(halves[0].endAnchor).toBe("manual");
		expect(halves[1].startAnchor).toBe("manual");
		// The outer boundaries are untouched.
		expect(halves[0].startPoint).toEqual(moveRegion().startPoint);
		expect(halves[1].endPoint).toEqual(moveRegion().endPoint);
		expect(halves[1].endAnchor).toBe("click");
	});

	it("keeps the styling on both halves", async () => {
		seed([moveRegion()], 2);
		const { result } = renderTimeline();
		await act(async () => {
			await result.current.splitCursorMotionAtPlayhead("cm_move");
		});
		for (const half of storedRegions()) {
			expect(half).toMatchObject({ preset: "arc", speed: 3, cycles: 4, easing: "ease-in" });
		}
	});

	it("refuses when the playhead is outside the section", async () => {
		// Refusing is what lets the inspector say "move the playhead inside this
		// section" instead of silently producing a zero-length half.
		seed([moveRegion()], 8);
		const { result } = renderTimeline();

		await act(async () => {
			expect(await result.current.splitCursorMotionAtPlayhead("cm_move")).toBe(false);
		});

		expect(storedRegions()).toHaveLength(1);
		expect(bridgeMocks.save).not.toHaveBeenCalled();
	});
});

describe("updateCursorMotionSettings", () => {
	it("clamps speed and turns to what the model and the compositor agree on", async () => {
		// The two sides carry the same bounds (1..4 and 1..6). A document written
		// outside them would render one way in the preview and another in the export.
		seed([moveRegion()]);
		const { result } = renderTimeline();

		await act(async () => {
			await result.current.updateCursorMotionSettings("cm_move", { speed: 99, cycles: 99 });
		});

		expect(storedRegions()[0]).toMatchObject({ speed: 4, cycles: 6 });
	});

	it("changes only the named section", async () => {
		seed([moveRegion(), moveRegion({ id: "cm_other", preset: "wave" })]);
		const { result } = renderTimeline();

		await act(async () => {
			await result.current.updateCursorMotionSettings("cm_move", { preset: "loop" });
		});

		const byId = Object.fromEntries(storedRegions().map((r) => [r.id, r]));
		expect(byId.cm_move.preset).toBe("loop");
		expect(byId.cm_other.preset).toBe("wave");
	});
});
