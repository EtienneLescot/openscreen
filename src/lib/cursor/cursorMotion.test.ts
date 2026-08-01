import { describe, expect, it } from "vitest";
import {
	applyCursorMotionSpeed,
	buildCursorMotionRegionDrafts,
	type CursorMotionPath,
	type CursorMotionPreset,
	type CursorMotionRegion,
	clampCursorMotionCycles,
	clampCursorMotionSpeed,
	findCursorMotionRegionAtSourceTime,
	projectCursorMotionPointToCrop,
	sampleCursorMotion,
	sampleCursorMotionRegion,
	unprojectCursorMotionPointFromCrop,
} from "./cursorMotion";

const owner = { clipId: "clip-1", assetId: "asset-1" };
const start = { cx: 0.1, cy: 0.5 };
const end = { cx: 0.8, cy: 0.5 };

function region(overrides: Partial<CursorMotionRegion> = {}): CursorMotionRegion {
	return {
		id: "motion-1",
		...owner,
		startMs: 2000,
		endMs: 3000,
		sourceStartMs: 100,
		sourceEndMs: 1100,
		startPoint: start,
		endPoint: end,
		controlPoints: [{ cx: 0.45, cy: 0.2 }],
		startAnchor: "manual",
		endAnchor: "click",
		segmentKind: "move",
		preset: "arc",
		speed: 1,
		cycles: 2,
		easing: "linear",
		...overrides,
	};
}

function linearPath(): CursorMotionPath {
	return {
		sampleAtSourceTime(sourceTimeMs) {
			const progress = Math.max(0, Math.min(1, (sourceTimeMs - 100) / 1000));
			return {
				cx: start.cx + (end.cx - start.cx) * progress,
				cy: start.cy,
			};
		},
	};
}

describe("cursor motion sampling", () => {
	it("preserves identity crop coordinates by reference", () => {
		const point = { cx: 0.25, cy: 0.75 };
		expect(projectCursorMotionPointToCrop(point, { x: 0, y: 0, width: 1, height: 1 })).toBe(point);
	});

	it("projects crop coordinates and keeps inclusive edges stable", () => {
		const crop = { x: 0.2, y: 0.25, width: 0.5, height: 0.5 };
		expect(projectCursorMotionPointToCrop({ cx: 0.45, cy: 0.5 }, crop)).toEqual({
			cx: 0.5,
			cy: 0.5,
		});
		expect(projectCursorMotionPointToCrop({ cx: 0.2, cy: 0.25 }, crop)).toEqual({
			cx: 0,
			cy: 0,
		});
		expect(projectCursorMotionPointToCrop({ cx: 0.7, cy: 0.75 }, crop)).toEqual({
			cx: 1,
			cy: 1,
		});
	});

	it("hides points outside the crop and rejects invalid crop spans", () => {
		const crop = { x: 0.2, y: 0.25, width: 0.5, height: 0.5 };
		expect(projectCursorMotionPointToCrop({ cx: 0.199, cy: 0.5 }, crop)).toBeNull();
		expect(projectCursorMotionPointToCrop({ cx: 0.45, cy: 0.751 }, crop)).toBeNull();
		expect(projectCursorMotionPointToCrop({ cx: 0.45, cy: 0.5 }, { ...crop, width: 0 })).toBeNull();
	});

	it("maps dragged crop-space controls back to source normalized coordinates", () => {
		const crop = { x: 0.2, y: 0.25, width: 0.5, height: 0.5 };
		expect(unprojectCursorMotionPointFromCrop({ cx: 0.5, cy: 0.5 }, crop)).toEqual({
			cx: 0.45,
			cy: 0.5,
		});
		expect(unprojectCursorMotionPointFromCrop({ cx: -1, cy: 2 }, crop)).toEqual({
			cx: 0.2,
			cy: 0.75,
		});
	});

	it("keeps every preset's normalized endpoints exact", () => {
		const presets: CursorMotionPreset[] = [
			"recorded",
			"straight",
			"arc",
			"wave",
			"loop",
			"overshoot",
		];
		for (const preset of presets) {
			const motion = region({ preset, speed: 4, cycles: 6, easing: "ease-in-out" });
			expect(sampleCursorMotionRegion(motion, motion.sourceStartMs)).toBe(start);
			expect(sampleCursorMotionRegion(motion, motion.sourceEndMs)).toBe(end);
		}
	});

	it("preserves the recorded sample by reference until a creative preset is selected", () => {
		const recorded = { cx: 0.37, cy: 0.61 };
		const path: CursorMotionPath = { sampleAtSourceTime: () => recorded };
		const result = sampleCursorMotion({
			path,
			regions: [region({ preset: "recorded", speed: 4 })],
			owner,
			sourceTimeMs: 400,
		});
		expect(result).toBe(recorded);
	});

	it("clamps and rounds speed, and accelerates without a frozen prefix", () => {
		expect(clampCursorMotionSpeed(Number.NaN)).toBe(1);
		expect(clampCursorMotionSpeed(Number.POSITIVE_INFINITY)).toBe(1);
		expect(clampCursorMotionSpeed(0.2)).toBe(1);
		expect(clampCursorMotionSpeed(2.26)).toBe(2.3);
		expect(clampCursorMotionSpeed(99)).toBe(4);
		expect(applyCursorMotionSpeed(0.25, 2)).toBeCloseTo(0.4375);
		expect(applyCursorMotionSpeed(0, 4)).toBe(0);
		expect(applyCursorMotionSpeed(1, 4)).toBe(1);
	});

	it("clamps wave and loop cycles to whole values from one through six", () => {
		expect(clampCursorMotionCycles(Number.NaN)).toBe(1);
		expect(clampCursorMotionCycles(0)).toBe(1);
		expect(clampCursorMotionCycles(3.6)).toBe(4);
		expect(clampCursorMotionCycles(20)).toBe(6);
	});

	it("uses a source-time half-open interval at adjacent boundaries", () => {
		const first = region({ id: "first", sourceStartMs: 100, sourceEndMs: 500 });
		const second = region({
			id: "second",
			sourceStartMs: 500,
			sourceEndMs: 900,
			startPoint: { cx: 0.45, cy: 0.5 },
			preset: "straight",
		});
		expect(findCursorMotionRegionAtSourceTime([first, second], owner, 499.999)?.id).toBe("first");
		expect(findCursorMotionRegionAtSourceTime([first, second], owner, 500)?.id).toBe("second");
		expect(findCursorMotionRegionAtSourceTime([first, second], owner, 900)).toBeNull();
	});

	it("does not apply a region owned by another clip or asset", () => {
		const recorded = { cx: 0.42, cy: 0.42 };
		const path: CursorMotionPath = { sampleAtSourceTime: () => recorded };
		const motion = region({ preset: "wave" });
		expect(
			sampleCursorMotion({
				path,
				regions: [motion],
				owner: { clipId: "clip-2", assetId: "asset-1" },
				sourceTimeMs: 500,
			}),
		).toBe(recorded);
		expect(
			sampleCursorMotion({
				path,
				regions: [motion],
				owner: { clipId: "clip-1", assetId: "asset-2" },
				sourceTimeMs: 500,
			}),
		).toBe(recorded);
	});

	it("produces distinct arc, wave, loop, and overshoot shapes", () => {
		const arc = sampleCursorMotionRegion(region({ preset: "arc" }), 600);
		const wave = sampleCursorMotionRegion(region({ preset: "wave" }), 300);
		const loop = sampleCursorMotionRegion(region({ preset: "loop" }), 475);
		const overshoot = Array.from({ length: 80 }, (_, index) =>
			sampleCursorMotionRegion(
				region({ preset: "overshoot", controlPoints: [{ cx: 0.45, cy: 0.5 }] }),
				100 + (1000 * index) / 79,
			),
		);
		expect(arc.cy).toBeLessThan(0.5);
		expect(wave.cy).not.toBeCloseTo(0.5);
		expect(loop.cy).not.toBeCloseTo(0.5);
		expect(overshoot.some((point) => point.cx > end.cx)).toBe(true);
	});
});

describe("cursor motion draft builder", () => {
	it("builds only through the next click and keeps virtual and source time separate", () => {
		const drafts = buildCursorMotionRegionDrafts({
			owner,
			currentSourceTimeMs: 500,
			currentVirtualTimeMs: 4500,
			clipSourceEndMs: 2000,
			path: linearPath(),
			samples: [
				{ timeMs: 500, cx: 0.38, cy: 0.5 },
				{ timeMs: 900, cx: 0.66, cy: 0.5, interactionType: "click" },
				{ timeMs: 1500, cx: 0.8, cy: 0.5, interactionType: "click" },
			],
		});

		expect(drafts).toHaveLength(1);
		expect(drafts[0]).toMatchObject({
			...owner,
			startMs: 4500,
			endMs: 4900,
			sourceStartMs: 500,
			sourceEndMs: 900,
			startAnchor: "manual",
			endAnchor: "click",
			segmentKind: "move",
			preset: "recorded",
			speed: 1,
			easing: "ease-in-out",
		});
	});

	it("splits a recorded stop into move, hold, and move drafts", () => {
		const drafts = buildCursorMotionRegionDrafts({
			owner,
			currentSourceTimeMs: 0,
			currentVirtualTimeMs: 2000,
			clipSourceEndMs: 1000,
			samples: [
				{ timeMs: 0, cx: 0.1, cy: 0.5 },
				{ timeMs: 100, cx: 0.25, cy: 0.5 },
				{ timeMs: 200, cx: 0.4, cy: 0.5 },
				{ timeMs: 350, cx: 0.4, cy: 0.5 },
				{ timeMs: 500, cx: 0.401, cy: 0.5 },
				{ timeMs: 650, cx: 0.4, cy: 0.5 },
				{ timeMs: 800, cx: 0.7, cy: 0.5 },
				{ timeMs: 1000, cx: 0.9, cy: 0.5, interactionType: "click" },
			],
		});

		expect(
			drafts.map((draft) => [
				draft.sourceStartMs,
				draft.sourceEndMs,
				draft.segmentKind,
				draft.startAnchor,
				draft.endAnchor,
			]),
		).toEqual([
			[0, 200, "move", "manual", "rest"],
			[200, 650, "hold", "rest", "rest"],
			[650, 1000, "move", "rest", "click"],
		]);
		expect(drafts.every((draft) => draft.preset === "recorded" && draft.speed === 1)).toBe(true);
	});

	it("does not treat a telemetry gap longer than 150ms as a stop", () => {
		const drafts = buildCursorMotionRegionDrafts({
			owner,
			currentSourceTimeMs: 0,
			currentVirtualTimeMs: 0,
			clipSourceEndMs: 1000,
			samples: [
				{ timeMs: 0, cx: 0.1, cy: 0.5 },
				{ timeMs: 100, cx: 0.4, cy: 0.5 },
				{ timeMs: 700, cx: 0.4, cy: 0.5 },
				{ timeMs: 1000, cx: 0.8, cy: 0.5, interactionType: "click" },
			],
		});

		expect(drafts).toHaveLength(1);
		expect(drafts[0].segmentKind).toBe("move");
	});

	it("does not confuse a native cursor atlas asset id with media ownership", () => {
		const activeSamples = [
			{ timeMs: 0, cx: 0.1, cy: 0.5, assetId: "cursor-arrow" },
			{
				timeMs: 800,
				cx: 0.7,
				cy: 0.5,
				interactionType: "click",
				assetId: "cursor-pointer",
			},
		];
		const drafts = buildCursorMotionRegionDrafts({
			owner,
			currentSourceTimeMs: 0,
			currentVirtualTimeMs: 0,
			clipSourceEndMs: 1000,
			samples: activeSamples,
		});

		expect(drafts).toHaveLength(1);
		expect(drafts[0].sourceEndMs).toBe(800);
	});

	it("returns no draft when the active clip has no following click", () => {
		expect(
			buildCursorMotionRegionDrafts({
				owner,
				currentSourceTimeMs: 500,
				currentVirtualTimeMs: 2500,
				clipSourceEndMs: 1000,
				samples: [
					{ timeMs: 500, cx: 0.4, cy: 0.5, interactionType: "click" },
					{ timeMs: 800, cx: 0.7, cy: 0.5 },
				],
			}),
		).toEqual([]);
	});

	it("does not create a microscopic segment for anchors within one millisecond", () => {
		expect(
			buildCursorMotionRegionDrafts({
				owner,
				currentSourceTimeMs: 0,
				currentVirtualTimeMs: 0,
				clipSourceEndMs: 100,
				samples: [
					{ timeMs: 0, cx: 0.4, cy: 0.5 },
					{ timeMs: 0.5, cx: 0.4, cy: 0.5, interactionType: "click" },
				],
			}),
		).toEqual([]);
	});
});
