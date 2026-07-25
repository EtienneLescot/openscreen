import { describe, expect, it } from "vitest";
import type { AxcutClip, AxcutDocument, AxcutTrimRange } from "../schema";
import {
	buildTimelineFromIntervals,
	duplicateClip,
	invertIntervals,
	moveClip,
	normalizeIntervals,
	primaryAssetDuration,
	rederiveRegionMs,
	replaceTimeline,
	resequenceClips,
	resolvePlaybackSegments,
	restoreFullTimeline,
	setClipSourceRange,
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

function makeTrim(overrides: Partial<AxcutTrimRange> = {}): AxcutTrimRange {
	return {
		id: "trim_1",
		assetId: "asset_1",
		startSec: 0,
		endSec: 0,
		origin: "user",
		reason: "",
		...overrides,
	};
}

describe("resolvePlaybackSegments", () => {
	it("splits a clip around an interior trim into two contiguous segments", () => {
		const clip = makeClip({
			sourceStartSec: 0,
			sourceEndSec: 10,
			timelineStartSec: 0,
			timelineEndSec: 10,
		});
		const trim = makeTrim({ startSec: 4, endSec: 6 });
		const segments = resolvePlaybackSegments([clip], [trim]);
		expect(segments).toHaveLength(2);
		expect(segments[0]).toMatchObject({
			sourceStartSec: 0,
			sourceEndSec: 4,
			timelineStartSec: 0,
			timelineEndSec: 4,
		});
		expect(segments[1]).toMatchObject({
			sourceStartSec: 6,
			sourceEndSec: 10,
			timelineStartSec: 4,
			timelineEndSec: 8,
		});
	});

	it("leaves a clip untouched when the trim belongs to a different asset", () => {
		const clip = makeClip({ assetId: "asset_1", sourceStartSec: 0, sourceEndSec: 10 });
		const trim = makeTrim({ assetId: "asset_2", startSec: 2, endSec: 4 });
		const segments = resolvePlaybackSegments([clip], [trim]);
		expect(segments).toHaveLength(1);
		expect(segments[0]).toMatchObject({ sourceStartSec: 0, sourceEndSec: 10 });
	});

	it("drops a clip entirely when a trim fully covers it", () => {
		const clip = makeClip({ sourceStartSec: 0, sourceEndSec: 10 });
		const trim = makeTrim({ startSec: 0, endSec: 10 });
		expect(resolvePlaybackSegments([clip], [trim])).toHaveLength(0);
	});

	it("narrows both clips when a trim is ventilated across a clip boundary (two DSL rows)", () => {
		// Mirrors ventilateTimelineSpanToTrims's own output shape: one row per covered clip.
		const clipA = makeClip({
			id: "clip_a",
			assetId: "asset_1",
			sourceStartSec: 0,
			sourceEndSec: 10,
			timelineStartSec: 0,
			timelineEndSec: 10,
		});
		const clipB = makeClip({
			id: "clip_b",
			assetId: "asset_1",
			sourceStartSec: 10,
			sourceEndSec: 20,
			timelineStartSec: 10,
			timelineEndSec: 20,
		});
		const trims = [
			makeTrim({ id: "t1", startSec: 8, endSec: 10 }),
			makeTrim({ id: "t2", startSec: 10, endSec: 12 }),
		];
		const segments = resolvePlaybackSegments([clipA, clipB], trims);
		expect(segments).toHaveLength(2);
		expect(segments[0]).toMatchObject({
			sourceStartSec: 0,
			sourceEndSec: 8,
			timelineStartSec: 0,
			timelineEndSec: 8,
		});
		expect(segments[1]).toMatchObject({
			sourceStartSec: 12,
			sourceEndSec: 20,
			timelineStartSec: 8,
			timelineEndSec: 16,
		});
	});

	it("does not let a trim on one clip affect an unrelated same-asset clip elsewhere", () => {
		// Regression guard for the exact cross-clip bug just fixed in operations.ts:
		// two clips of the SAME asset, non-adjacent source windows; a trim scoped to
		// the first must not touch the second.
		const clipA = makeClip({
			id: "clip_a",
			sourceStartSec: 0,
			sourceEndSec: 5,
			timelineStartSec: 0,
			timelineEndSec: 5,
		});
		const clipB = makeClip({
			id: "clip_b",
			sourceStartSec: 50,
			sourceEndSec: 55,
			timelineStartSec: 5,
			timelineEndSec: 10,
		});
		const trim = makeTrim({ startSec: 1, endSec: 2 });
		const segments = resolvePlaybackSegments([clipA, clipB], [trim]);
		expect(segments.find((s) => s.id === "clip_b")).toMatchObject({
			sourceStartSec: 50,
			sourceEndSec: 55,
		});
	});
});

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
				{
					id: "z1",
					groupId: "z1",
					clipId: "clip_b",
					sourceStartSec: 22,
					sourceEndSec: 24,
					startMs: 12000,
					endMs: 14000,
					depth: 3,
					focus: { cx: 0.5, cy: 0.5 },
				},
			],
			annotations: [
				{
					id: "a1",
					groupId: "a1",
					clipId: "clip_b",
					sourceStartSec: 25,
					sourceEndSec: 26,
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
			legacyEditor: {
				speedRegions: [
					{
						id: "s1",
						groupId: "s1",
						clipId: "clip_b",
						sourceStartSec: 21,
						sourceEndSec: 23,
						startMs: 11000,
						endMs: 13000,
						speed: 1.5,
					},
				],
			},
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

function makeZoom(overrides: Partial<AxcutDocument["zoomRanges"][number]> = {}) {
	return {
		id: "z1",
		startMs: 0,
		endMs: 0,
		clipId: "clip_a",
		sourceStartSec: 0,
		sourceEndSec: 0,
		depth: 3 as const,
		focus: { cx: 0.5, cy: 0.5 },
		...overrides,
	};
}

describe("resequenceClips recomputes a clip's length from its source window when its extent is zeroed", () => {
	it("uses the source length (not the stale timeline length) once the timeline extent is 0", () => {
		// The clip's OLD width was 10s; its source window was just narrowed to 3s and its
		// timeline extent zeroed (the signal both the Edit modal and the agent use). The
		// resequenced clip must be 3s wide, not the stale 10s.
		const [clip] = resequenceClips([
			makeClip({ sourceStartSec: 2, sourceEndSec: 5, timelineStartSec: 0, timelineEndSec: 0 }),
		]);
		expect(clip.timelineStartSec).toBe(0);
		expect(clip.timelineEndSec).toBe(3);
	});
});

describe("rederiveRegionMs — clamps anchored regions to their clip's kept source window", () => {
	const twoClipDoc = () =>
		makeDoc({
			timeline: {
				...makeDoc().timeline,
				clips: [
					makeClip({ id: "clip_a", sourceStartSec: 0, sourceEndSec: 10, timelineEndSec: 10 }),
				],
			},
		});

	it("shortens a fragment that overhangs a tail-trimmed clip to the surviving overlap", () => {
		// Clip window narrowed to [0,7]; a zoom authored at source 6-8 keeps only 6-7.
		const doc = twoClipDoc();
		doc.timeline.clips[0].sourceEndSec = 7;
		doc.zoomRanges = [makeZoom({ sourceStartSec: 6, sourceEndSec: 8, startMs: 6000, endMs: 8000 })];
		const next = rederiveRegionMs(doc, doc.timeline.clips);
		expect(next.zoomRanges).toHaveLength(1);
		expect(next.zoomRanges[0]).toMatchObject({
			sourceStartSec: 6,
			sourceEndSec: 7,
			startMs: 6000,
			endMs: 7000,
		});
	});

	it("clamps a fragment's head into a clip trimmed at the front", () => {
		// Head trimmed: clip window is now [4,10]; a zoom at source 3-6 keeps only 4-6, and
		// its raw span starts at the clip's own start (timelineStart + (4-4) = 0).
		const doc = twoClipDoc();
		doc.timeline.clips[0].sourceStartSec = 4;
		doc.zoomRanges = [makeZoom({ sourceStartSec: 3, sourceEndSec: 6, startMs: 3000, endMs: 6000 })];
		const next = rederiveRegionMs(doc, doc.timeline.clips);
		expect(next.zoomRanges[0]).toMatchObject({
			sourceStartSec: 4,
			sourceEndSec: 6,
			startMs: 0,
			endMs: 2000,
		});
	});

	it("drops a fragment that falls entirely outside the narrowed window", () => {
		const doc = twoClipDoc();
		doc.timeline.clips[0].sourceEndSec = 5;
		doc.zoomRanges = [makeZoom({ sourceStartSec: 6, sourceEndSec: 8, startMs: 6000, endMs: 8000 })];
		const next = rederiveRegionMs(doc, doc.timeline.clips);
		expect(next.zoomRanges).toHaveLength(0);
	});

	it("leaves a fragment untouched when its clip is not probed yet (no real window)", () => {
		// An unprobed clip has no meaningful sourceEndSec; clamping it would nuke every
		// fragment, so the guard skips it and only refreshes the ms cache.
		const doc = twoClipDoc();
		doc.timeline.clips[0].sourceEndSec = undefined;
		doc.zoomRanges = [makeZoom({ sourceStartSec: 6, sourceEndSec: 8, startMs: 6000, endMs: 8000 })];
		const next = rederiveRegionMs(doc, doc.timeline.clips);
		expect(next.zoomRanges).toHaveLength(1);
		expect(next.zoomRanges[0]).toMatchObject({ sourceStartSec: 6, sourceEndSec: 8 });
	});

	it("is a no-op for a fragment already inside its clip's window", () => {
		const doc = twoClipDoc();
		doc.zoomRanges = [makeZoom({ sourceStartSec: 3, sourceEndSec: 4, startMs: 3000, endMs: 4000 })];
		const next = rederiveRegionMs(doc, doc.timeline.clips);
		expect(next.zoomRanges[0]).toMatchObject({
			sourceStartSec: 3,
			sourceEndSec: 4,
			startMs: 3000,
			endMs: 4000,
		});
	});
});

describe("setClipSourceRange — the one shared clip-trim mutator", () => {
	const doc = () =>
		makeDoc({
			timeline: {
				...makeDoc().timeline,
				clips: [
					makeClip({ id: "clip_a", sourceStartSec: 0, sourceEndSec: 10, timelineEndSec: 10 }),
					makeClip({
						id: "clip_b",
						sourceStartSec: 0,
						sourceEndSec: 10,
						timelineStartSec: 10,
						timelineEndSec: 20,
					}),
				],
			},
			zoomRanges: [
				makeZoom({
					id: "z_in",
					clipId: "clip_a",
					sourceStartSec: 2,
					sourceEndSec: 3,
					startMs: 2000,
					endMs: 3000,
				}),
				makeZoom({
					id: "z_out",
					clipId: "clip_a",
					sourceStartSec: 6,
					sourceEndSec: 8,
					startMs: 6000,
					endMs: 8000,
				}),
				makeZoom({
					id: "z_after",
					clipId: "clip_b",
					sourceStartSec: 2,
					sourceEndSec: 4,
					startMs: 12000,
					endMs: 14000,
				}),
			] as unknown as AxcutDocument["zoomRanges"],
		});

	it("recomputes the clip width from the new source window and reflows downstream", () => {
		const next = setClipSourceRange(doc(), "clip_a", 0, 4);
		expect(next.timeline.clips[0]).toMatchObject({ timelineStartSec: 0, timelineEndSec: 4 });
		// clip_b reflows to start where the trimmed clip now ends.
		expect(next.timeline.clips[1]).toMatchObject({ timelineStartSec: 4, timelineEndSec: 14 });
	});

	it("clamps/drops the trimmed clip's pills and refreshes the reflowed clip's ms cache", () => {
		const next = setClipSourceRange(doc(), "clip_a", 0, 4);
		const byId = Object.fromEntries(next.zoomRanges.map((z) => [z.id, z]));
		// z_in survives inside [0,4]; z_out sat past the new 4s end → gone.
		expect(Object.keys(byId).sort()).toEqual(["z_after", "z_in"]);
		expect(byId.z_in).toMatchObject({ startMs: 2000, endMs: 3000 });
		// clip_b moved from tl 10 to tl 4, so z_after's derived ms drops by 6s.
		expect(byId.z_after).toMatchObject({ startMs: 6000, endMs: 8000 });
	});

	it("orders reversed bounds, clamps negatives, and no-ops an unknown clip", () => {
		const reversed = setClipSourceRange(doc(), "clip_a", 8, -3);
		expect(reversed.timeline.clips[0]).toMatchObject({ sourceStartSec: 0, sourceEndSec: 8 });
		const untouched = setClipSourceRange(doc(), "clip_missing", 0, 2);
		expect(untouched.timeline.clips.map((c) => c.id)).toEqual(["clip_a", "clip_b"]);
		expect(untouched.timeline.clips[0]).toMatchObject({ sourceEndSec: 10, timelineEndSec: 10 });
	});

	it("does not bump preview.revision (the caller owns that)", () => {
		const before = doc();
		const next = setClipSourceRange(before, "clip_a", 0, 4);
		expect(next.preview.revision).toBe(before.preview.revision);
	});
});
