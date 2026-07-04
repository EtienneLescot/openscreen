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
			skipRanges: [],
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
		it("rebuilds clips and derives skipRanges from the inverse", () => {
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
			expect(updated.timeline.skipRanges).toHaveLength(1);
			expect(updated.timeline.skipRanges[0]).toMatchObject({
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
					skipRanges: [
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
			expect(restored.timeline.skipRanges).toHaveLength(0);
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
					skipRanges: [],
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
});
