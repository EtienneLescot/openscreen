// ponytail: tests for the renderer-side timeline-operation union + dispatcher
// in `src/lib/ai-edition/document/operations.ts`. Mirrors the axcut chat UI
// parity work — same operations, same summary shape, same document mutation
// rules. The IPC + service layer is exercised separately in
// `electron/ai-edition/chat-service.test.ts`.

import { describe, expect, it } from "vitest";
import { type AxcutClip, type AxcutDocument, createEmptyDocument } from "../schema";
import { applyTimelineOperation } from "./operations";

// `sourceEndSec` is optional in the schema (a clip migrated before its asset was
// probed has no known end). Every clip these operations build does have one, so
// assert that rather than folding a missing end into a zero-length clip.
function sourceLength(clip: AxcutClip): number {
	if (clip.sourceEndSec === undefined) {
		throw new Error(`clip ${clip.id} has no sourceEndSec`);
	}
	return clip.sourceEndSec - clip.sourceStartSec;
}

function makeDoc(): AxcutDocument {
	const base = createEmptyDocument({ title: "Test", projectId: "proj_ops" });
	const asset = {
		id: "asset_1",
		kind: "video" as const,
		label: "Recording",
		originalPath: "C:/videos/rec.mp4",
		durationSec: 60,
		cameraTrack: null,
	};
	return {
		...base,
		project: { ...base.project, primaryAssetId: asset.id },
		assets: [asset],
		timeline: {
			...base.timeline,
			clips: [
				{
					id: "clip_1",
					assetId: asset.id,
					sourceStartSec: 0,
					sourceEndSec: 60,
					timelineStartSec: 0,
					timelineEndSec: 60,
					wordRefs: [],
					origin: "user",
					reason: "",
				},
			],
		},
	};
}

describe("applyTimelineOperation.add_trim_range", () => {
	it("appends a user-origin skip and returns a one-line summary", () => {
		const result = applyTimelineOperation(makeDoc(), {
			type: "add_trim_range",
			startSec: 5,
			endSec: 8,
		});
		expect(result.summary).toMatch(/added trim 0:05\.0.0:08\.0/);
		const next = result.document;
		const skips = next.timeline.trimRanges.filter((s) => s.assetId === "asset_1");
		expect(skips).toHaveLength(1);
		expect(skips[0]).toMatchObject({
			startSec: 5,
			endSec: 8,
			origin: "user",
		});
	});

	it("normalises reversed bounds (end < start)", () => {
		const result = applyTimelineOperation(makeDoc(), {
			type: "add_trim_range",
			startSec: 10,
			endSec: 4,
		});
		const skip = result.document.timeline.trimRanges.find((s) => s.assetId === "asset_1");
		expect(skip?.startSec).toBe(4);
		expect(skip?.endSec).toBe(10);
	});

	it("preserves an existing trim on a DIFFERENT asset (multi-clip transcript pane repro)", () => {
		const doc = makeDoc();
		const otherAsset = {
			id: "asset_2",
			kind: "video" as const,
			label: "Recording 2",
			originalPath: "C:/videos/rec2.mp4",
			durationSec: 30,
			cameraTrack: null,
		};
		const docWithTwoAssets: AxcutDocument = {
			...doc,
			assets: [...doc.assets, otherAsset],
			timeline: {
				...doc.timeline,
				clips: [
					...doc.timeline.clips,
					{
						id: "clip_2",
						assetId: otherAsset.id,
						sourceStartSec: 0,
						sourceEndSec: 30,
						timelineStartSec: 60,
						timelineEndSec: 90,
						wordRefs: [],
						origin: "user",
						reason: "",
					},
				],
			},
		};
		// Edit clip 1's word (asset_1) first...
		const afterFirst = applyTimelineOperation(docWithTwoAssets, {
			type: "add_trim_range",
			assetId: "asset_1",
			startSec: 5,
			endSec: 8,
		}).document;
		// ...then edit clip 2's word (asset_2) — this must NOT wipe asset_1's trim.
		const afterSecond = applyTimelineOperation(afterFirst, {
			type: "add_trim_range",
			assetId: "asset_2",
			startSec: 2,
			endSec: 4,
		}).document;
		expect(afterSecond.timeline.trimRanges.filter((s) => s.assetId === "asset_1")).toHaveLength(1);
		expect(afterSecond.timeline.trimRanges.filter((s) => s.assetId === "asset_2")).toHaveLength(1);
	});

	// The harder version of the test above: the two clips share ONE asset, so the trims
	// live in the same source coordinate space. Merging by asset (what the code did) folded
	// two distinct user edits into one interval list that was then re-applied to both clips.
	describe("two clips over the same media", () => {
		function docWithTwins(): AxcutDocument {
			const doc = makeDoc();
			return {
				...doc,
				timeline: {
					...doc.timeline,
					clips: [
						...doc.timeline.clips,
						{
							id: "clip_2",
							assetId: "asset_1",
							sourceStartSec: 0,
							sourceEndSec: 60,
							timelineStartSec: 60,
							timelineEndSec: 120,
							wordRefs: [],
							origin: "user",
							reason: "",
						},
					],
				},
			};
		}

		it("anchors the cut to the clip the caller names", () => {
			const next = applyTimelineOperation(docWithTwins(), {
				type: "add_trim_range",
				assetId: "asset_1",
				clipId: "clip_2",
				startSec: 3,
				endSec: 5,
			}).document;
			expect(next.timeline.trimRanges).toHaveLength(1);
			expect(next.timeline.trimRanges[0]).toMatchObject({
				assetId: "asset_1",
				clipId: "clip_2",
				startSec: 3,
				endSec: 5,
			});
		});

		it("keeps each clip's cuts separate instead of merging them by asset", () => {
			const afterFirst = applyTimelineOperation(docWithTwins(), {
				type: "add_trim_range",
				assetId: "asset_1",
				clipId: "clip_1",
				startSec: 3,
				endSec: 5,
			}).document;
			// Same source range on the twin. Asset-scoped merging collapsed this into the
			// row above, so one of the two edits vanished and the survivor cut both clips.
			const afterSecond = applyTimelineOperation(afterFirst, {
				type: "add_trim_range",
				assetId: "asset_1",
				clipId: "clip_2",
				startSec: 3,
				endSec: 5,
			}).document;
			expect(afterSecond.timeline.trimRanges).toHaveLength(2);
			expect(afterSecond.timeline.trimRanges.map((s) => s.clipId).sort()).toEqual([
				"clip_1",
				"clip_2",
			]);
			// Ids must not collide either — they used to be keyed by asset alone.
			expect(new Set(afterSecond.timeline.trimRanges.map((s) => s.id)).size).toBe(2);
		});

		it("still merges touching cuts on the SAME clip into one row", () => {
			const afterFirst = applyTimelineOperation(docWithTwins(), {
				type: "add_trim_range",
				assetId: "asset_1",
				clipId: "clip_1",
				startSec: 3,
				endSec: 5,
			}).document;
			const afterSecond = applyTimelineOperation(afterFirst, {
				type: "add_trim_range",
				assetId: "asset_1",
				clipId: "clip_1",
				startSec: 5,
				endSec: 7,
			}).document;
			expect(afterSecond.timeline.trimRanges).toHaveLength(1);
			expect(afterSecond.timeline.trimRanges[0]).toMatchObject({ startSec: 3, endSec: 7 });
		});

		it("leaves a pre-v7 un-anchored cut alone when adding an anchored one", () => {
			const withLegacy: AxcutDocument = (() => {
				const doc = docWithTwins();
				return {
					...doc,
					timeline: {
						...doc.timeline,
						trimRanges: [
							{
								id: "legacy",
								assetId: "asset_1",
								startSec: 3,
								endSec: 5,
								origin: "user" as const,
								reason: "",
							},
						],
					},
				};
			})();
			const next = applyTimelineOperation(withLegacy, {
				type: "add_trim_range",
				assetId: "asset_1",
				clipId: "clip_2",
				startSec: 3,
				endSec: 5,
			}).document;
			expect(next.timeline.trimRanges).toHaveLength(2);
			expect(next.timeline.trimRanges.find((s) => s.id === "legacy")).toBeDefined();
		});
	});
});

describe("applyTimelineOperation.drop_range", () => {
	it("returns intervals that exclude the cut and a one-line summary", () => {
		const result = applyTimelineOperation(makeDoc(), {
			type: "drop_range",
			assetId: "asset_1",
			startSec: 10,
			endSec: 20,
		});
		expect(result.summary).toMatch(/dropped 0:10\.0.0:20\.0/);
		const next = result.document;
		const asset = next.assets[0];
		expect(asset).toBeDefined();
		const totalKeep = next.timeline.clips
			.filter((c) => c.assetId === "asset_1")
			.reduce((sum, c) => sum + sourceLength(c), 0);
		expect(totalKeep).toBe(50);
	});

	it("keeps the cuts the user had already made", () => {
		// ponytail: `drop_range` rebuilds the timeline, and the rebuild used to
		// replace `trimRanges` in full with the complement of the kept intervals.
		// So every UI drag of a range deleted every trim the user had placed —
		// silently, one storey below the operation that appeared to be about
		// something else entirely.
		const withTrim = applyTimelineOperation(makeDoc(), {
			type: "add_trim_range",
			startSec: 40,
			endSec: 45,
		}).document;
		const trimId = withTrim.timeline.trimRanges[0].id;
		const dropped = applyTimelineOperation(withTrim, {
			type: "drop_range",
			assetId: "asset_1",
			startSec: 10,
			endSec: 20,
		}).document;
		expect(dropped.timeline.trimRanges.map((t) => t.id)).toContain(trimId);
		expect(dropped.timeline.trimRanges.find((t) => t.id === trimId)).toMatchObject({
			startSec: 40,
			endSec: 45,
		});
	});
});

describe("applyTimelineOperation.replace_timeline", () => {
	it("rebuilds clips from the kept intervals", () => {
		const result = applyTimelineOperation(makeDoc(), {
			type: "replace_timeline",
			intervals: [
				{ startSec: 0, endSec: 5 },
				{ startSec: 10, endSec: 30 },
			],
			reason: "trim silences",
		});
		expect(result.summary).toMatch(/rebuilt timeline .2 interval/);
		const clips = result.document.timeline.clips.filter((c) => c.assetId === "asset_1");
		expect(clips).toHaveLength(2);
		const totalClip = clips.reduce((s, c) => s + sourceLength(c), 0);
		expect(totalClip).toBe(25);
	});
});

describe("applyTimelineOperation.restore_full_timeline", () => {
	it("drops every skip and restores a single full clip", () => {
		const doc = applyTimelineOperation(makeDoc(), {
			type: "add_trim_range",
			startSec: 5,
			endSec: 10,
		}).document;
		const restored = applyTimelineOperation(doc, { type: "restore_full_timeline" });
		expect(restored.summary).toBe("restored full timeline");
		const asset = restored.document.assets[0];
		expect(asset).toBeDefined();
		const totalClip = restored.document.timeline.clips
			.filter((c) => c.assetId === "asset_1")
			.reduce((s, c) => s + sourceLength(c), 0);
		expect(totalClip).toBe(60);
		expect(restored.document.timeline.trimRanges).toHaveLength(0);
	});
});

describe("applyTimelineOperation.update_clip_range", () => {
	it("trims the named clip and reseats the timeline to the new source length", () => {
		const result = applyTimelineOperation(makeDoc(), {
			type: "update_clip_range",
			clipId: "clip_1",
			sourceStartSec: 10,
			sourceEndSec: 25,
		});
		const clip = result.document.timeline.clips.find((c) => c.id === "clip_1");
		expect(clip?.sourceStartSec).toBe(10);
		expect(clip?.sourceEndSec).toBe(25);
		// The clip's width follows its 15s source window, not the stale 60s.
		expect(clip?.timelineStartSec).toBe(0);
		expect(clip?.timelineEndSec).toBe(15);
	});

	it("clamps and drops anchored pills against the narrowed window (façade parity with the modal)", () => {
		const doc = makeDoc();
		doc.zoomRanges = [
			{
				id: "z_keep",
				startMs: 12000,
				endMs: 14000,
				clipId: "clip_1",
				sourceStartSec: 12,
				sourceEndSec: 14,
				depth: 3,
				focus: { cx: 0.5, cy: 0.5 },
			},
			{
				id: "z_edge",
				startMs: 20000,
				endMs: 30000,
				clipId: "clip_1",
				sourceStartSec: 20,
				sourceEndSec: 30,
				depth: 3,
				focus: { cx: 0.5, cy: 0.5 },
			},
			{
				id: "z_drop",
				startMs: 40000,
				endMs: 45000,
				clipId: "clip_1",
				sourceStartSec: 40,
				sourceEndSec: 45,
				depth: 3,
				focus: { cx: 0.5, cy: 0.5 },
			},
		] as unknown as AxcutDocument["zoomRanges"];
		const result = applyTimelineOperation(doc, {
			type: "update_clip_range",
			clipId: "clip_1",
			sourceStartSec: 10,
			sourceEndSec: 25,
		});
		const zooms = result.document.zoomRanges;
		expect(zooms.map((z) => z.id)).toEqual(["z_keep", "z_edge"]);
		// z_edge (20-30) survives only where it overlaps the [10,25] window → 20-25.
		expect(zooms.find((z) => z.id === "z_edge")).toMatchObject({
			sourceStartSec: 20,
			sourceEndSec: 25,
		});
	});
});
