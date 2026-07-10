import { describe, expect, it } from "vitest";
import type { AxcutClip, AxcutDocument } from "../schema";
import {
	buildTimelineFromIntervals,
	duplicateClip,
	invertIntervals,
	moveClip,
	normalizeIntervals,
	primaryAssetDuration,
	replaceTimeline,
	restoreFullTimeline,
	subtractInterval,
	timelineIntervals,
} from "./timeline";

function makeDoc(overrides: Partial<AxcutDocument> = {}): AxcutDocument {
	return {
		schemaVersion: 3,
		project: {
			id: "proj_1",
			title: "Test",
			createdAt: "2026-06-26T10:00:00Z",
			updatedAt: "2026-06-26T10:00:00Z",
			primaryAssetId: "asset_1",
		},
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "screen.mp4",
				originalPath: "/tmp/screen.mp4",
				durationSec: 60,
			},
		],
		transcript: null,
		transcripts: [],
		timeline: {
			clips: [],
			gaps: [],
			trimRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		annotations: [],
		zoomRanges: [],
		legacyEditor: null,
		agent: { pendingQuestions: [], suggestions: [], lastAppliedOperations: [] },
		preview: { strategy: "seek", revision: 0 },
		export: { preset: "final-balanced", lastJobId: null },
		history: { revisions: [] },
		...overrides,
	};
}

describe("timeline pure functions", () => {
	describe("normalizeIntervals", () => {
		it("sorts and merges overlapping intervals", () => {
			const result = normalizeIntervals(100, [
				{ startSec: 10, endSec: 20 },
				{ startSec: 5, endSec: 15 },
				{ startSec: 30, endSec: 40 },
			]);
			expect(result).toEqual([
				{ startSec: 5, endSec: 20 },
				{ startSec: 30, endSec: 40 },
			]);
		});

		it("clamps to duration", () => {
			const result = normalizeIntervals(50, [{ startSec: -10, endSec: 200 }]);
			expect(result).toEqual([{ startSec: 0, endSec: 50 }]);
		});

		it("drops zero-length intervals", () => {
			const result = normalizeIntervals(100, [
				{ startSec: 10, endSec: 10 },
				{ startSec: 5, endSec: 8 },
			]);
			expect(result).toEqual([{ startSec: 5, endSec: 8 }]);
		});
	});

	describe("subtractInterval", () => {
		it("splits an interval in two when the cut is in the middle", () => {
			const result = subtractInterval([{ startSec: 0, endSec: 60 }], { startSec: 20, endSec: 30 });
			expect(result).toEqual([
				{ startSec: 0, endSec: 20 },
				{ startSec: 30, endSec: 60 },
			]);
		});

		it("trims the start when the cut overlaps the beginning", () => {
			const result = subtractInterval([{ startSec: 10, endSec: 60 }], { startSec: 0, endSec: 20 });
			expect(result).toEqual([{ startSec: 20, endSec: 60 }]);
		});

		it("returns the original when there is no overlap", () => {
			const result = subtractInterval([{ startSec: 0, endSec: 10 }], { startSec: 20, endSec: 30 });
			expect(result).toEqual([{ startSec: 0, endSec: 10 }]);
		});
	});

	describe("invertIntervals", () => {
		it("produces the complementary cuts", () => {
			const cuts = invertIntervals(
				[
					{ startSec: 0, endSec: 20 },
					{ startSec: 30, endSec: 60 },
				],
				60,
			);
			expect(cuts).toEqual([{ startSec: 20, endSec: 30 }]);
		});

		it("produces a full cut when intervals are empty", () => {
			expect(invertIntervals([], 60)).toEqual([{ startSec: 0, endSec: 60 }]);
		});
	});

	describe("buildTimelineFromIntervals", () => {
		it("assigns sequential timelineStart/End and clip ids", () => {
			const clips = buildTimelineFromIntervals(
				"asset_1",
				[
					{ startSec: 0, endSec: 10 },
					{ startSec: 20, endSec: 30 },
				],
				{ origin: "user", reason: "test", transcript: null },
			);
			expect(clips).toHaveLength(2);
			expect(clips[0]).toMatchObject({
				id: "clip_1",
				sourceStartSec: 0,
				sourceEndSec: 10,
				timelineStartSec: 0,
				timelineEndSec: 10,
			});
			expect(clips[1]).toMatchObject({
				id: "clip_2",
				sourceStartSec: 20,
				sourceEndSec: 30,
				timelineStartSec: 10,
				timelineEndSec: 20,
			});
		});
	});

	describe("replaceTimeline", () => {
		it("rebuilds clips and derives trimRanges from the inverse", () => {
			const doc = makeDoc();
			const updated = replaceTimeline(
				doc,
				[
					{ startSec: 0, endSec: 20 },
					{ startSec: 30, endSec: 60 },
				],
				"test cut",
			);
			expect(updated.timeline.clips).toHaveLength(2);
			expect(updated.timeline.trimRanges).toHaveLength(1);
			expect(updated.timeline.trimRanges[0]).toMatchObject({
				startSec: 20,
				endSec: 30,
			});
			expect(updated.preview.revision).toBe(1);
		});

		it("throws when there is no primary asset", () => {
			const doc = makeDoc({
				assets: [],
				project: { id: "p", title: "t", createdAt: "", updatedAt: "", primaryAssetId: undefined },
			});
			expect(() => replaceTimeline(doc, [], "x")).toThrow();
		});
	});

	describe("restoreFullTimeline", () => {
		it("sets a single interval spanning the full duration", () => {
			const doc = makeDoc({
				timeline: {
					clips: [],
					gaps: [],
					trimRanges: [
						{ id: "s1", assetId: "asset_1", startSec: 10, endSec: 20, origin: "user", reason: "" },
					],
					muteRanges: [],
					speedRanges: [],
					captionRanges: [],
				},
			});
			const restored = restoreFullTimeline(doc);
			expect(restored.timeline.clips).toHaveLength(1);
			expect(restored.timeline.clips[0]).toMatchObject({
				sourceStartSec: 0,
				sourceEndSec: 60,
			});
			expect(restored.timeline.trimRanges).toHaveLength(0);
		});
	});

	describe("primaryAssetDuration + timelineIntervals", () => {
		it("reads durationSec from the primary asset", () => {
			expect(primaryAssetDuration(makeDoc())).toBe(60);
		});
		it("extracts intervals from existing clips", () => {
			const doc = makeDoc({
				timeline: {
					clips: [
						{
							id: "c1",
							assetId: "asset_1",
							sourceStartSec: 5,
							sourceEndSec: 15,
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
			});
			expect(timelineIntervals(doc)).toEqual([{ startSec: 5, endSec: 15 }]);
		});
	});
});

function makeClip(overrides: Partial<AxcutClip> = {}): AxcutClip {
	return {
		id: "clip_a",
		assetId: "asset_1",
		sourceStartSec: 0,
		sourceEndSec: 5,
		timelineStartSec: 0,
		timelineEndSec: 5,
		wordRefs: [],
		origin: "user",
		reason: "",
		...overrides,
	};
}

describe("duplicateClip / moveClip", () => {
	it("duplicateClip gives the copy a fresh, collision-free id even when called repeatedly", () => {
		// Regression test: this used to id the copy as `clip_${clips.length + 1}_copy`,
		// a counter that collides across repeated duplicates of a shrinking/growing
		// array (e.g. duplicate then delete then duplicate again).
		let doc = makeDoc({ timeline: { ...makeDoc().timeline, clips: [makeClip()] } });
		doc = duplicateClip(doc, "clip_a");
		doc = duplicateClip(doc, "clip_a");
		const ids = doc.timeline.clips.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("duplicateClip inserts the copy immediately after the original and bumps preview.revision", () => {
		const doc = makeDoc({
			timeline: {
				...makeDoc().timeline,
				clips: [
					makeClip({ id: "clip_a" }),
					makeClip({ id: "clip_b", timelineStartSec: 5, timelineEndSec: 10 }),
				],
			},
		});
		const next = duplicateClip(doc, "clip_a");
		expect(next.timeline.clips.map((c) => c.id)[1]).not.toBe("clip_b");
		expect(next.timeline.clips[0].id).toBe("clip_a");
		expect(next.timeline.clips[2].id).toBe("clip_b");
		expect(next.preview.revision).toBe(doc.preview.revision + 1);
	});

	it("moveClip reorders clips and bumps preview.revision", () => {
		const doc = makeDoc({
			timeline: {
				...makeDoc().timeline,
				clips: [
					makeClip({ id: "clip_a" }),
					makeClip({ id: "clip_b", timelineStartSec: 5, timelineEndSec: 10 }),
				],
			},
		});
		const next = moveClip(doc, "clip_a", 1);
		expect(next.timeline.clips.map((c) => c.id)).toEqual(["clip_b", "clip_a"]);
		expect(next.preview.revision).toBe(doc.preview.revision + 1);
	});

	it("throws for an unknown clip id", () => {
		const doc = makeDoc({ timeline: { ...makeDoc().timeline, clips: [makeClip()] } });
		expect(() => duplicateClip(doc, "missing")).toThrow();
		expect(() => moveClip(doc, "missing", 0)).toThrow();
	});

	it("carries zoom/annotation/speed regions along with the clip they sit on", () => {
		// clip_a tl 0-10, clip_b tl 10-20. A zoom (tl 12-14), an annotation
		// (tl 15-16) and a speed region (tl 11-13) all sit over clip_b.
		const doc = makeDoc({
			timeline: {
				...makeDoc().timeline,
				clips: [
					makeClip({ id: "clip_a", timelineStartSec: 0, timelineEndSec: 10 }),
					makeClip({
						id: "clip_b",
						sourceStartSec: 20,
						sourceEndSec: 30,
						timelineStartSec: 10,
						timelineEndSec: 20,
					}),
				],
			},
			zoomRanges: [
				{ id: "z1", startMs: 12000, endMs: 14000, depth: 3, focus: { cx: 0.5, cy: 0.5 } },
			],
			annotations: [
				{
					id: "a1",
					startMs: 15000,
					endMs: 16000,
					type: "text",
					content: "hi",
					position: { x: 50, y: 50 },
					size: { width: 30, height: 20 },
					style: {
						color: "#fff",
						backgroundColor: "transparent",
						fontSize: 32,
						fontFamily: "Inter",
						fontWeight: "bold",
						fontStyle: "normal",
						textDecoration: "none",
						textAlign: "center",
						textAnimation: "none",
					},
					zIndex: 1,
				},
			] as unknown as AxcutDocument["annotations"],
			legacyEditor: { speedRegions: [{ id: "s1", startMs: 11000, endMs: 13000, speed: 1.5 }] },
		});
		// Move clip_b to the front → clip_b now tl 0-10 (delta -10s). Regions
		// over clip_b shift by -10s; the zoom now sits at tl 2-4, etc.
		const next = moveClip(doc, "clip_b", 0);
		expect(next.timeline.clips.map((c) => c.id)).toEqual(["clip_b", "clip_a"]);
		expect(next.zoomRanges[0]).toMatchObject({ startMs: 2000, endMs: 4000 });
		expect(next.annotations[0]).toMatchObject({ startMs: 5000, endMs: 6000 });
		const speed = (next.legacyEditor as { speedRegions: Array<{ startMs: number; endMs: number }> })
			.speedRegions[0];
		expect(speed).toMatchObject({ startMs: 1000, endMs: 3000 });
	});

	it("leaves regions over a clip that did not move untouched", () => {
		const doc = makeDoc({
			timeline: {
				...makeDoc().timeline,
				clips: [
					makeClip({ id: "clip_a", timelineStartSec: 0, timelineEndSec: 10 }),
					makeClip({ id: "clip_b", timelineStartSec: 10, timelineEndSec: 20 }),
					makeClip({ id: "clip_c", timelineStartSec: 20, timelineEndSec: 30 }),
				],
			},
			zoomRanges: [{ id: "z1", startMs: 3000, endMs: 5000, depth: 3, focus: { cx: 0.5, cy: 0.5 } }],
		});
		// Swapping clip_b and clip_c leaves clip_a (tl 0-10) put, so a zoom over
		// clip_a stays exactly where it was.
		const next = moveClip(doc, "clip_c", 1);
		expect(next.timeline.clips.map((c) => c.id)).toEqual(["clip_a", "clip_c", "clip_b"]);
		expect(next.zoomRanges[0]).toMatchObject({ startMs: 3000, endMs: 5000 });
	});
});
