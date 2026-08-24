import { describe, expect, it } from "vitest";
import {
	type AxcutClip,
	type AxcutDocument,
	type AxcutTrimRange,
	axcutSchemaVersion,
} from "../schema";
import {
	buildTimelineFromIntervals,
	duplicateClip,
	invertIntervals,
	moveClip,
	normalizeIntervals,
	planTimelineReplacement,
	primaryAssetDuration,
	rederiveRegionMs,
	removeClip,
	removeRegion,
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
		schemaVersion: axcutSchemaVersion,
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
				cameraTrack: null,
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
		});

		it("throws when there is no primary asset", () => {
			const doc = makeDoc({
				assets: [],
				project: { id: "p", title: "t", createdAt: "", updatedAt: "", primaryAssetId: undefined },
			});
			expect(() => replaceTimeline(doc, [], "x")).toThrow();
		});
	});

	// ── D-DESTRUCT ────────────────────────────────────────────────────────────
	//
	// `replaceTimeline` was destructive in three separate ways, each invisible
	// from its return value: it re-minted every id, it merged adjacent intervals
	// (so handing it the timeline's OWN intervals collapsed two clips into one),
	// it replaced `trimRanges` wholesale, and it re-anchored every modifier from
	// its ruler position rather than its content. The document stayed
	// schema-valid throughout, which is why nothing caught it.
	describe("replaceTimeline is not destructive by default", () => {
		/** Two adjacent clips over one asset, a user cut inside the first, and a
		 *  zoom anchored to the second — the shape the workbench measures. */
		function twoClipDoc(): AxcutDocument {
			return makeDoc({
				timeline: {
					clips: [
						makeClip({ id: "clip_1", sourceStartSec: 0, sourceEndSec: 30, timelineEndSec: 30 }),
						makeClip({
							id: "clip_2",
							sourceStartSec: 30,
							sourceEndSec: 60,
							timelineStartSec: 30,
							timelineEndSec: 60,
							reason: "demo",
						}),
					],
					gaps: [],
					trimRanges: [makeTrim({ id: "trim_1", startSec: 12, endSec: 17 })],
					muteRanges: [],
					speedRanges: [],
					captionRanges: [],
				},
				zoomRanges: [
					{
						id: "zoom_demo",
						startMs: 40_000,
						endMs: 45_000,
						depth: 3,
						focus: { cx: 0.5, cy: 0.5 },
						clipId: "clip_2",
						sourceStartSec: 40,
						sourceEndSec: 45,
					},
				] as unknown as AxcutDocument["zoomRanges"],
			});
		}

		it("keeps both clips and the user's cut when handed the timeline's own intervals", () => {
			// The identity call. `normalizeIntervals` merges [0,30] and [30,60] into
			// one span, so this used to return a single `clip_1` spanning 0–60 with
			// zero trims: nothing asked for, everything changed.
			const updated = replaceTimeline(
				twoClipDoc(),
				[
					{ startSec: 0, endSec: 30 },
					{ startSec: 30, endSec: 60 },
				],
				"identity",
				"agent",
			);
			expect(updated.timeline.clips.map((c) => c.id)).toEqual(["clip_1", "clip_2"]);
			expect(updated.timeline.trimRanges.map((t) => t.id)).toEqual(["trim_1"]);
			expect(updated.timeline.trimRanges[0]).toMatchObject({ startSec: 12, endSec: 17 });
		});

		it("keeps a preserved clip's origin and label instead of stamping its own", () => {
			const updated = replaceTimeline(
				twoClipDoc(),
				[
					{ startSec: 0, endSec: 30 },
					{ startSec: 30, endSec: 60 },
				],
				"rebuilt by the agent",
				"agent",
			);
			expect(updated.timeline.clips[1]).toMatchObject({ origin: "user", reason: "demo" });
		});

		it("leaves an anchored zoom on its own footage, not on whatever slid under it", () => {
			// clip_1 shrinks to 0–25, so clip_2 (kept intact) slides from ruler 30 to
			// ruler 25 while its CONTENT is unchanged. Re-anchoring the zoom from its
			// RAW ms — what a rebuild used to do to EVERY modifier — reads the ruler
			// rather than the content: ruler 40 now falls at source 45, so the zoom
			// came back five seconds into footage the user never pointed at, with a
			// schema-valid document and nothing said.
			const updated = replaceTimeline(
				twoClipDoc(),
				[
					{ startSec: 0, endSec: 25 },
					{ startSec: 30, endSec: 60 },
				],
				"shrink the intro",
				"agent",
			);
			const clip2 = updated.timeline.clips.find((c) => c.id === "clip_2");
			expect(clip2).toMatchObject({ timelineStartSec: 25, sourceStartSec: 30 });
			expect(updated.zoomRanges[0]).toMatchObject({
				id: "zoom_demo",
				clipId: "clip_2",
				sourceStartSec: 40,
				sourceEndSec: 45,
			});
			// And its derived ms followed its clip: ruler 25 + (40 − 30) = 35 s.
			expect(updated.zoomRanges[0]).toMatchObject({ startMs: 35_000, endMs: 40_000 });
		});

		it("narrows a straddling trim instead of deleting it, and keeps its id", () => {
			const updated = replaceTimeline(twoClipDoc(), [{ startSec: 0, endSec: 15 }], "cut", "agent");
			const kept = updated.timeline.trimRanges.find((t) => t.id === "trim_1");
			expect(kept).toMatchObject({ startSec: 12, endSec: 15 });
			// And the stretch beyond the kept interval is cut by the complement.
			expect(updated.timeline.trimRanges.some((t) => t.startSec === 15 && t.endSec === 60)).toBe(
				true,
			);
		});

		it("never touches another asset's cuts", () => {
			// The same bug `operations.ts` had already had to fix for add_trim_range:
			// `trimRanges` was replaced in full by the complement of the PRIMARY
			// asset's intervals, with no assetId filter anywhere.
			const doc = makeDoc({
				timeline: {
					clips: [],
					gaps: [],
					trimRanges: [makeTrim({ id: "trim_other", assetId: "asset_2", startSec: 1, endSec: 2 })],
					muteRanges: [],
					speedRanges: [],
					captionRanges: [],
				},
			});
			const updated = replaceTimeline(doc, [{ startSec: 0, endSec: 60 }], "rebuild", "agent");
			expect(updated.timeline.trimRanges.map((t) => t.id)).toContain("trim_other");
		});

		it("mints unique ids for the slots that match nothing", () => {
			// Positional `clip_${i+1}` / `trim_${i+1}` are what let an id survive a
			// rebuild while designating something else — and they would collide
			// outright with a preserved id sitting at the same index.
			const updated = replaceTimeline(
				twoClipDoc(),
				[
					{ startSec: 0, endSec: 30 },
					{ startSec: 40, endSec: 50 },
				],
				"cut",
				"agent",
			);
			const ids = updated.timeline.clips.map((c) => c.id);
			expect(ids[0]).toBe("clip_1");
			expect(ids[1]).not.toBe("clip_2");
			expect(new Set(ids).size).toBe(ids.length);
			const trimIds = updated.timeline.trimRanges.map((t) => t.id);
			expect(new Set(trimIds).size).toBe(trimIds.length);
		});

		it("still resets everything when the caller opts out — restoreFullTimeline", () => {
			// The one caller whose semantics ARE "throw it all away". If preservation
			// leaked in here, the Restore button would stop restoring.
			const restored = restoreFullTimeline(twoClipDoc());
			expect(restored.timeline.clips.map((c) => c.id)).toEqual(["clip_1"]);
			expect(restored.timeline.clips[0]).toMatchObject({ sourceStartSec: 0, sourceEndSec: 60 });
			expect(restored.timeline.trimRanges).toHaveLength(0);
		});
	});

	// The anchoring contract itself, stated once and checked after each structural
	// edit rather than re-derived per case. `timelineMap` holds that a fragment's
	// `{clipId, sourceStartSec, sourceEndSec}` is the truth and its `startMs`/
	// `endMs` are a CACHE of where that lands on the ruler — so any operation that
	// moves clips must leave the two agreeing. Both halves of D-DESTRUCT were
	// violations of exactly this: the rebuild recomputed the anchor from the
	// cache (backwards), and nothing checked the result.
	describe("the anchor/derived-ms invariant survives a structural edit", () => {
		/** Every anchored region's cached ms equals what its clip's live position
		 *  says they should be, and no region points at a clip that is gone. */
		function assertAnchorsAgree(document: AxcutDocument): void {
			const clips = document.timeline.clips;
			for (const region of document.zoomRanges as unknown as Array<{
				id: string;
				startMs: number;
				endMs: number;
				clipId?: string;
				sourceStartSec?: number;
				sourceEndSec?: number;
			}>) {
				if (!region.clipId) continue;
				const clip = clips.find((c) => c.id === region.clipId);
				expect(clip, `${region.id} anchored to a clip that no longer exists`).toBeDefined();
				if (!clip || region.sourceStartSec === undefined || region.sourceEndSec === undefined) {
					continue;
				}
				const offset = clip.timelineStartSec - clip.sourceStartSec;
				expect(region.startMs, `${region.id} startMs`).toBe(
					Math.round((region.sourceStartSec + offset) * 1000),
				);
				expect(region.endMs, `${region.id} endMs`).toBe(
					Math.round((region.sourceEndSec + offset) * 1000),
				);
			}
		}

		/** Three clips, and a zoom straddling the boundary between the last two —
		 *  stored as TWO fragments, which is the case where a reorder can pull the
		 *  halves of one pill apart. */
		function straddled(): AxcutDocument {
			return makeDoc({
				timeline: {
					clips: [
						makeClip({ id: "clip_1", sourceStartSec: 0, sourceEndSec: 20, timelineEndSec: 20 }),
						makeClip({
							id: "clip_2",
							sourceStartSec: 20,
							sourceEndSec: 40,
							timelineStartSec: 20,
							timelineEndSec: 40,
						}),
						makeClip({
							id: "clip_3",
							sourceStartSec: 40,
							sourceEndSec: 60,
							timelineStartSec: 40,
							timelineEndSec: 60,
						}),
					],
					gaps: [],
					trimRanges: [],
					muteRanges: [],
					speedRanges: [],
					captionRanges: [],
				},
				zoomRanges: [
					{
						id: "zoom_a",
						startMs: 35_000,
						endMs: 40_000,
						depth: 3,
						focus: { cx: 0.5, cy: 0.5 },
						clipId: "clip_2",
						sourceStartSec: 35,
						sourceEndSec: 40,
					},
					{
						id: "zoom_b",
						startMs: 40_000,
						endMs: 45_000,
						depth: 3,
						focus: { cx: 0.5, cy: 0.5 },
						clipId: "clip_3",
						sourceStartSec: 40,
						sourceEndSec: 45,
					},
				] as unknown as AxcutDocument["zoomRanges"],
			});
		}

		it("holds after a moveClip", () => {
			const moved = moveClip(straddled(), "clip_3", 0, "user", "");
			expect(moved.timeline.clips.map((c) => c.id)).toEqual(["clip_3", "clip_1", "clip_2"]);
			assertAnchorsAgree(moved);
			// Each half of the straddling pill went with its OWN clip, so they are
			// no longer adjacent on the ruler — which is correct, and is why
			// fragments carry an anchor rather than a shared group marker.
			const byId = new Map(moved.zoomRanges.map((z) => [z.id, z]));
			expect(byId.get("zoom_b")?.startMs).toBe(0);
			expect(byId.get("zoom_a")?.startMs).toBe(55_000);
		});

		it("holds after a rebuild that keeps every clip", () => {
			const rebuilt = replaceTimeline(
				straddled(),
				[
					{ startSec: 0, endSec: 20 },
					{ startSec: 20, endSec: 40 },
					{ startSec: 40, endSec: 60 },
				],
				"identity",
				"agent",
			);
			assertAnchorsAgree(rebuilt);
			expect(rebuilt.zoomRanges.map((z) => z.id)).toEqual(["zoom_a", "zoom_b"]);
		});

		it("holds after a rebuild that drops the clip a fragment lived on", () => {
			// clip_3 is gone, so `zoom_b` has no content left. It must be DROPPED,
			// not re-pointed at whatever now occupies its old ruler position.
			const rebuilt = replaceTimeline(
				straddled(),
				[
					{ startSec: 0, endSec: 20 },
					{ startSec: 20, endSec: 40 },
				],
				"drop the tail",
				"agent",
			);
			assertAnchorsAgree(rebuilt);
			expect(rebuilt.zoomRanges.map((z) => z.id)).toEqual(["zoom_a"]);
		});

		it("keeps a region that was never anchored at all", () => {
			// The other half of the orphan rule: a v2 migration produces regions
			// with RAW ms and no anchor, because anchoring needs a clip with a real
			// extent. Dropping "cannot place it" wholesale would delete those.
			const doc = straddled();
			const unanchored: AxcutDocument = {
				...doc,
				zoomRanges: [
					{
						id: "zoom_legacy",
						startMs: 55_000,
						endMs: 58_000,
						depth: 3,
						focus: { cx: 0.5, cy: 0.5 },
					},
				] as unknown as AxcutDocument["zoomRanges"],
			};
			const rebuilt = replaceTimeline(
				unanchored,
				[{ startSec: 0, endSec: 20 }],
				"drop the tail",
				"agent",
			);
			expect(rebuilt.zoomRanges.map((z) => z.id)).toEqual(["zoom_legacy"]);
		});

		it("holds after a setClipRange that narrows a fragment's window", () => {
			const narrowed = setClipSourceRange(straddled(), "clip_2", 20, 37);
			assertAnchorsAgree(narrowed);
			// zoom_a covered 35–40 of a window that now ends at 37: clamped, kept.
			expect(narrowed.zoomRanges.find((z) => z.id === "zoom_a")).toMatchObject({
				sourceStartSec: 35,
				sourceEndSec: 37,
			});
		});
	});

	describe("planTimelineReplacement", () => {
		function twoClipDoc(): AxcutDocument {
			return makeDoc({
				timeline: {
					clips: [
						makeClip({ id: "clip_1", sourceStartSec: 0, sourceEndSec: 30, timelineEndSec: 30 }),
						makeClip({
							id: "clip_2",
							sourceStartSec: 30,
							sourceEndSec: 60,
							timelineStartSec: 30,
							timelineEndSec: 60,
						}),
					],
					gaps: [],
					trimRanges: [makeTrim({ id: "trim_1", startSec: 12, endSec: 17 })],
					muteRanges: [],
					speedRanges: [],
					captionRanges: [],
				},
			});
		}

		it("reads a swap as a reorder — the intent only survives before the sort", () => {
			const plan = planTimelineReplacement(twoClipDoc(), [
				{ startSec: 30, endSec: 60 },
				{ startSec: 0, endSec: 30 },
			]);
			expect(plan.reorderRequested).toBe(true);
		});

		it("does not call an ordinary rebuild a reorder", () => {
			const plan = planTimelineReplacement(twoClipDoc(), [
				{ startSec: 0, endSec: 30 },
				{ startSec: 30, endSec: 60 },
			]);
			expect(plan.reorderRequested).toBe(false);
			expect(plan.lostClipIds).toEqual([]);
			expect(plan.slots.map((s) => s.keepClipId)).toEqual(["clip_1", "clip_2"]);
		});

		it("names the clips a narrower rebuild would cost", () => {
			const plan = planTimelineReplacement(twoClipDoc(), [{ startSec: 0, endSec: 20 }]);
			expect(plan.lostClipIds).toEqual(["clip_1", "clip_2"]);
		});

		it("reports a trim that falls outside the kept spans as absorbed, not lost", () => {
			// Its id goes, its CUT does not: that stretch is excluded anyway. Calling
			// it a loss would make the guard refuse a rebuild that costs nothing.
			const plan = planTimelineReplacement(twoClipDoc(), [{ startSec: 0, endSec: 10 }]);
			expect(plan.absorbedTrimIds).toEqual(["trim_1"]);
			expect(plan.clippedTrimIds).toEqual([]);
		});

		it("counts the modifiers that would be re-anchored onto other footage", () => {
			const doc = twoClipDoc();
			const withZoom: AxcutDocument = {
				...doc,
				zoomRanges: [
					{
						id: "zoom_demo",
						startMs: 40_000,
						endMs: 45_000,
						depth: 3,
						focus: { cx: 0.5, cy: 0.5 },
						clipId: "clip_2",
						sourceStartSec: 40,
						sourceEndSec: 45,
					},
				] as unknown as AxcutDocument["zoomRanges"],
			};
			expect(
				planTimelineReplacement(withZoom, [{ startSec: 0, endSec: 20 }]).slidRegionIds,
			).toEqual(["zoom_demo"]);
			expect(
				planTimelineReplacement(withZoom, [
					{ startSec: 0, endSec: 30 },
					{ startSec: 30, endSec: 60 },
				]).slidRegionIds,
			).toEqual([]);
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

	// Two clips over the SAME media, same source window — the shape the previous test
	// deliberately avoided by keeping the windows disjoint. Here `assetId` + source
	// overlap cannot tell the clips apart; only `clipId` can.
	describe("two clips sharing one asset over the same source window", () => {
		const sharedClips = () => [
			makeClip({
				id: "clip_1",
				sourceStartSec: 0,
				sourceEndSec: 11.8,
				timelineStartSec: 0,
				timelineEndSec: 11.8,
			}),
			makeClip({
				id: "clip_2",
				sourceStartSec: 0,
				sourceEndSec: 11.8,
				timelineStartSec: 11.8,
				timelineEndSec: 23.6,
			}),
		];

		it("cuts only the anchored clip, leaving its twin whole", () => {
			const trim = makeTrim({ id: "t1", clipId: "clip_2", startSec: 3, endSec: 4 });
			const segments = resolvePlaybackSegments(sharedClips(), [trim]);
			// clip_1 survives as one untouched segment; clip_2 splits around [3,4].
			expect(segments).toHaveLength(3);
			expect(segments[0]).toMatchObject({ id: "clip_1", sourceStartSec: 0, sourceEndSec: 11.8 });
			expect(segments[1]).toMatchObject({
				id: "clip_2_seg1",
				sourceStartSec: 0,
				sourceEndSec: 3,
			});
			expect(segments[2]).toMatchObject({
				id: "clip_2_seg2",
				sourceStartSec: 4,
				sourceEndSec: 11.8,
			});
		});

		it("still cuts both clips for a pre-v7 trim that names no clip", () => {
			// Back-compat: an un-anchored row keeps its historical asset-wide meaning, so a
			// document written before the anchor existed renders exactly as it used to.
			const trim = makeTrim({ id: "t1", startSec: 3, endSec: 4 });
			const segments = resolvePlaybackSegments(sharedClips(), [trim]);
			expect(segments.map((s) => s.id)).toEqual([
				"clip_1_seg1",
				"clip_1_seg2",
				"clip_2_seg1",
				"clip_2_seg2",
			]);
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

	it("duplicateClip inserts the copy immediately after the original", () => {
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
	});

	// A trim used to reach the copy for free, by matching on `assetId`. Now that it names
	// its clip the copy has to be given its own, or duplicating a cut clip would silently
	// produce an uncut one.
	it("duplicateClip copies the original's anchored trims onto the copy, independently", () => {
		const doc = makeDoc({
			timeline: {
				...makeDoc().timeline,
				clips: [makeClip({ id: "clip_a", sourceStartSec: 0, sourceEndSec: 10 })],
				trimRanges: [makeTrim({ id: "t1", clipId: "clip_a", startSec: 2, endSec: 4 })],
			},
		});
		const next = duplicateClip(doc, "clip_a");
		const copyId = next.timeline.clips[1].id;
		expect(next.timeline.trimRanges).toHaveLength(2);
		const copied = next.timeline.trimRanges.find((t) => t.clipId === copyId);
		expect(copied).toMatchObject({ startSec: 2, endSec: 4 });
		// Fresh id — a shared one would make the two cuts one row again.
		expect(copied?.id).not.toBe("t1");
		// Both clips are cut, exactly as before the anchor existed.
		expect(resolvePlaybackSegments(next.timeline.clips, next.timeline.trimRanges)).toHaveLength(4);
	});

	it("removeClip drops the deleted clip's trims but keeps a twin's", () => {
		const doc = makeDoc({
			timeline: {
				...makeDoc().timeline,
				clips: [
					makeClip({ id: "clip_1", sourceStartSec: 0, sourceEndSec: 10 }),
					makeClip({
						id: "clip_2",
						sourceStartSec: 0,
						sourceEndSec: 10,
						timelineStartSec: 10,
						timelineEndSec: 20,
					}),
				],
				trimRanges: [
					makeTrim({ id: "t1", clipId: "clip_1", startSec: 2, endSec: 4 }),
					makeTrim({ id: "t2", clipId: "clip_2", startSec: 6, endSec: 8 }),
					makeTrim({ id: "legacy", startSec: 1, endSec: 2 }),
				],
			},
		});
		const next = removeClip(doc, "clip_2");
		// `t2`'s content is gone with its clip; an asset-wide match would have moved it
		// onto the surviving twin, which is the wrong-clip class this whole change removes.
		expect(next.timeline.trimRanges.map((t) => t.id)).toEqual(["t1", "legacy"]);
	});

	it("moveClip reorders clips", () => {
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
});

describe("removeRegion — the one shared region-delete mutator", () => {
	it("drops the whole pill a zoom id belongs to, and keeps a different-identity pill", () => {
		// z1 + z2 are the same identity (depth/focus) and touch → one pill; z3 differs.
		const doc = makeDoc({
			zoomRanges: [
				makeZoom({ id: "z1", startMs: 0, endMs: 2000 }),
				makeZoom({ id: "z2", startMs: 2000, endMs: 4000 }),
				makeZoom({ id: "z3", startMs: 5000, endMs: 6000, depth: 5 as const }),
			] as unknown as AxcutDocument["zoomRanges"],
		});
		const next = removeRegion(doc, "zoom", "z1");
		expect(next.zoomRanges.map((z) => z.id)).toEqual(["z3"]);
	});

	it("falls back to the single row when there is no clip layout to group against", () => {
		// No clips → `coalescedTrimGroups` can map nothing, so there is no pill to expand to.
		// The row must still be deletable rather than silently surviving.
		const doc = makeDoc({
			timeline: {
				...makeDoc().timeline,
				trimRanges: [makeTrim({ id: "trim_1" }), makeTrim({ id: "trim_2" })],
			},
		});
		const next = removeRegion(doc, "trim", "trim_1");
		expect(next.timeline.trimRanges.map((t) => t.id)).toEqual(["trim_2"]);
	});

	// A trim grown across a clip boundary CANNOT be one row — source time is per clip — so
	// `ventilateTimelineSpanToTrims` writes one per covered clip and the ruler merges them
	// back into the single stripe the user clicks. Deleting by bare id left the other half
	// still cutting content. Every other kind already expanded to its pill.
	describe("a trim ventilated across a clip boundary", () => {
		// clip_a plays source 0-10 at ruler 0-10; clip_b plays source 0-10 at ruler 10-20.
		// One drag from ruler 8 to 12 stores rows at ruler 8-10 and 10-12: they touch, so
		// they are one pill.
		const doc = () =>
			makeDoc({
				timeline: {
					...makeDoc().timeline,
					clips: [
						makeClip({
							id: "clip_a",
							sourceStartSec: 0,
							sourceEndSec: 10,
							timelineStartSec: 0,
							timelineEndSec: 10,
						}),
						makeClip({
							id: "clip_b",
							sourceStartSec: 0,
							sourceEndSec: 10,
							timelineStartSec: 10,
							timelineEndSec: 20,
						}),
					],
					trimRanges: [
						makeTrim({ id: "half_a", clipId: "clip_a", startSec: 8, endSec: 10 }),
						makeTrim({ id: "half_b", clipId: "clip_b", startSec: 0, endSec: 2 }),
						// A separate cut elsewhere on clip_a — its own pill, must survive.
						makeTrim({ id: "other", clipId: "clip_a", startSec: 2, endSec: 3 }),
					],
				},
			});

		it("deletes both halves whichever one was clicked", () => {
			expect(removeRegion(doc(), "trim", "half_a").timeline.trimRanges.map((t) => t.id)).toEqual([
				"other",
			]);
			expect(removeRegion(doc(), "trim", "half_b").timeline.trimRanges.map((t) => t.id)).toEqual([
				"other",
			]);
		});

		it("leaves no content still cut once the pill is deleted", () => {
			// The point of the bug, not just the row count: half the stripe kept removing
			// footage after the user had deleted it.
			const next = removeRegion(doc(), "trim", "half_a");
			const segments = resolvePlaybackSegments(next.timeline.clips, next.timeline.trimRanges);
			// clip_b is whole again; clip_a is split only by the unrelated `other` cut.
			expect(segments.map((s) => s.id)).toEqual(["clip_a_seg1", "clip_a_seg2", "clip_b"]);
			expect(segments.at(-1)).toMatchObject({ sourceStartSec: 0, sourceEndSec: 10 });
		});

		it("does not swallow a non-touching cut on the same clip", () => {
			const next = removeRegion(doc(), "trim", "other");
			expect(next.timeline.trimRanges.map((t) => t.id).sort()).toEqual(["half_a", "half_b"]);
		});
	});

	it("removes speed and camera-fullscreen regions under legacyEditor", () => {
		const doc = makeDoc({
			legacyEditor: {
				speedRegions: [{ id: "sp1", startMs: 0, endMs: 1000, speed: 2 }],
				cameraFullscreenRegions: [{ id: "cf1", startMs: 0, endMs: 1000 }],
			},
		});
		const afterSpeed = removeRegion(doc, "speed", "sp1");
		expect((afterSpeed.legacyEditor as { speedRegions: unknown[] }).speedRegions).toHaveLength(0);
		const afterCam = removeRegion(doc, "cameraFullscreen", "cf1");
		expect(
			(afterCam.legacyEditor as { cameraFullscreenRegions: unknown[] }).cameraFullscreenRegions,
		).toHaveLength(0);
	});

	it("is a no-op for an unknown id", () => {
		const doc = makeDoc({
			zoomRanges: [
				makeZoom({ id: "z1", startMs: 0, endMs: 2000 }),
			] as unknown as AxcutDocument["zoomRanges"],
		});
		const next = removeRegion(doc, "zoom", "nope");
		expect(next.zoomRanges.map((z) => z.id)).toEqual(["z1"]);
	});
});

describe("removeClip — delete a clip, close the gap, drop its pills", () => {
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
					id: "z_a",
					clipId: "clip_a",
					sourceStartSec: 2,
					sourceEndSec: 4,
					startMs: 2000,
					endMs: 4000,
				}),
				makeZoom({
					id: "z_b",
					clipId: "clip_b",
					sourceStartSec: 2,
					sourceEndSec: 4,
					startMs: 12000,
					endMs: 14000,
				}),
			] as unknown as AxcutDocument["zoomRanges"],
		});

	it("reflows survivors to close the gap and drops pills anchored to the removed clip", () => {
		const next = removeClip(doc(), "clip_a");
		expect(next.timeline.clips.map((c) => c.id)).toEqual(["clip_b"]);
		// clip_b slides to the front.
		expect(next.timeline.clips[0]).toMatchObject({ timelineStartSec: 0, timelineEndSec: 10 });
		// z_a's clip is gone → dropped; z_b's derived ms drops by the 10s clip_b moved.
		expect(next.zoomRanges.map((z) => z.id)).toEqual(["z_b"]);
		expect(next.zoomRanges[0]).toMatchObject({ startMs: 2000, endMs: 4000 });
	});

	it("preserves a bare clipId that is not a complete source anchor", () => {
		const before = doc();
		before.zoomRanges.push(
			makeZoom({
				id: "partial_anchor",
				clipId: "clip_a",
				sourceStartSec: undefined,
				sourceEndSec: undefined,
				startMs: 500,
				endMs: 1500,
			}),
		);

		const next = removeClip(before, "clip_a");

		expect(next.zoomRanges.map((region) => region.id)).toEqual(["z_b", "partial_anchor"]);
		expect(next.zoomRanges[1]).toMatchObject({
			clipId: "clip_a",
			startMs: 500,
			endMs: 1500,
		});
	});

	it("drops every modifier anchored to the last remaining clip", () => {
		const before = makeDoc({
			timeline: {
				...makeDoc().timeline,
				clips: [
					makeClip({ id: "clip_a", sourceStartSec: 0, sourceEndSec: 10, timelineEndSec: 10 }),
				],
			},
			zoomRanges: [
				makeZoom({ id: "anchored_zoom", clipId: "clip_a", sourceEndSec: 1, endMs: 1000 }),
				makeZoom({
					id: "legacy_zoom",
					clipId: undefined,
					sourceStartSec: undefined,
					sourceEndSec: undefined,
				}),
				// #249, and the branch nothing pinned: with no clip left, `removeClip` skips
				// `rederiveRegionMs` entirely, so this filter is the only thing deciding. A bare
				// `clipId` is not an anchor -- the region is still placed by its raw ms, so the
				// clip going away must not take it. Without this case the ternary can be
				// refactored back to the old semantics with a green suite.
				makeZoom({
					id: "partial_zoom",
					clipId: "clip_a",
					sourceStartSec: undefined,
					sourceEndSec: undefined,
				}),
				// The same region after an in-memory edit that never round-tripped through zod:
				// `null`, not `undefined`. The document layer used to call this one anchored
				// (`!== undefined`) while the export path called it unanchored (`typeof`), and
				// the two answers moved it to two different places -- `rederiveAnchoredRegion`
				// slid it to `Math.max(null, ...)`, i.e. the clip start, while the exporter kept
				// using its raw ms. One predicate now. Both halves get a case, because a single
				// region carrying two `null`s still reads unanchored if only one check is
				// loosened, and would pin neither.
				makeZoom({
					id: "null_start_zoom",
					clipId: "clip_a",
					sourceStartSec: null as unknown as undefined,
					sourceEndSec: 1,
				}),
				makeZoom({
					id: "null_end_zoom",
					clipId: "clip_a",
					sourceStartSec: 0,
					sourceEndSec: null as unknown as undefined,
				}),
			],
			annotations: [
				{
					id: "anchored_annotation",
					clipId: "clip_a",
					sourceStartSec: 0,
					sourceEndSec: 1,
					startMs: 0,
					endMs: 1000,
					type: "text",
					content: "remove me",
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
						id: "anchored_speed",
						clipId: "clip_a",
						sourceStartSec: 0,
						sourceEndSec: 1,
						startMs: 0,
						endMs: 1000,
						speed: 2,
					},
					{ id: "legacy_speed", startMs: 0, endMs: 1000, speed: 1.5 },
				],
				cameraFullscreenRegions: [
					{
						id: "anchored_camera",
						clipId: "clip_a",
						sourceStartSec: 0,
						sourceEndSec: 1,
						startMs: 0,
						endMs: 1000,
					},
				],
			},
		});

		const next = removeClip(before, "clip_a");

		expect(next.timeline.clips).toEqual([]);
		expect(next.zoomRanges.map((region) => region.id)).toEqual([
			"legacy_zoom",
			"partial_zoom",
			"null_start_zoom",
			"null_end_zoom",
		]);
		expect(next.annotations).toEqual([]);
		expect((next.legacyEditor as { speedRegions: Array<{ id: string }> }).speedRegions).toEqual([
			expect.objectContaining({ id: "legacy_speed" }),
		]);
		expect(
			(next.legacyEditor as { cameraFullscreenRegions: unknown[] }).cameraFullscreenRegions,
		).toEqual([]);
	});

	it("is a no-op for an unknown clip", () => {
		const before = doc();
		const next = removeClip(before, "clip_missing");
		expect(next.timeline.clips.map((c) => c.id)).toEqual(["clip_a", "clip_b"]);
		expect(next).toBe(before);
	});
});

// #356: `legacyEditorSchema` is `z.object({}).passthrough()`, so a project file whose
// envelope holds a non-array where a region collection belongs is schema-valid and loads
// without a word. Every clip edit — delete / move / duplicate / source-range — walks those
// collections through `mapAllRegionCollections`, which used to call `.filter()` on whatever
// it found and take the whole editor down with `regions.filter is not a function`. The
// malformed value is left exactly as it was found (the same call `upgradeV4DocumentToV5`
// makes): the rest of the document still edits, and nothing the user had is discarded.
describe("a malformed legacyEditor envelope", () => {
	const doc = (legacyEditor: AxcutDocument["legacyEditor"]) =>
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
			legacyEditor,
		});

	it("deletes a clip instead of throwing, and keeps the sibling collection working", () => {
		const before = doc({
			speedRegions: "oops",
			cameraFullscreenRegions: [
				{
					id: "cam_b",
					clipId: "clip_b",
					sourceStartSec: 2,
					sourceEndSec: 4,
					startMs: 12000,
					endMs: 14000,
				},
			],
		});

		const next = removeClip(before, "clip_a");

		expect(next.timeline.clips.map((c) => c.id)).toEqual(["clip_b"]);
		const legacy = next.legacyEditor as {
			speedRegions: unknown;
			cameraFullscreenRegions: Array<{ id: string; startMs: number; endMs: number }>;
		};
		// Untouched, not dropped — we cannot walk it, which is not a reason to delete it.
		expect(legacy.speedRegions).toBe("oops");
		// The well-formed neighbour is still rederived: clip_b slid 10s to the front.
		expect(legacy.cameraFullscreenRegions).toEqual([
			expect.objectContaining({ id: "cam_b", startMs: 2000, endMs: 4000 }),
		]);
	});

	it("passes the envelope through by reference when no collection is walkable", () => {
		const before = doc({ speedRegions: "oops", cameraFullscreenRegions: { id: "not_a_list" } });

		const next = removeClip(before, "clip_a");

		expect(next.timeline.clips.map((c) => c.id)).toEqual(["clip_b"]);
		expect(next.legacyEditor).toBe(before.legacyEditor);
		expect(next.legacyEditor).toEqual({
			speedRegions: "oops",
			cameraFullscreenRegions: { id: "not_a_list" },
		});
	});

	it("edits a clip's source range instead of throwing", () => {
		const before = doc({ speedRegions: null, cameraFullscreenRegions: 42 });

		const next = setClipSourceRange(before, "clip_a", 2, 5);

		expect(next.timeline.clips[0]).toMatchObject({ sourceStartSec: 2, sourceEndSec: 5 });
		expect(next.legacyEditor).toEqual({ speedRegions: null, cameraFullscreenRegions: 42 });
	});
});
