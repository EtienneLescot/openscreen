// An insertion is a clip. These pin what that buys and what it costs.
//
// The one genuinely delicate part is the inverse: taking the generated clip away has to put
// the halves back together, and must NOT do it when the user has since made them two clips
// he means to keep.

import { describe, expect, it } from "vitest";
import type { AxcutDocument } from "../schema";
import { insertGeneratedClip, removeGeneratedClips, retextGeneratedClip } from "./insertion";
import { moveClip, removeClip, resolvePlaybackSegments } from "./timeline";

const doc = (over: Partial<AxcutDocument> = {}): AxcutDocument =>
	({
		schemaVersion: 5,
		project: { id: "p1", title: "t", createdAt: "", updatedAt: "", primaryAssetId: "a1" },
		assets: [
			{
				id: "a1",
				kind: "video",
				label: "take",
				originalPath: "C:/rec/take.mp4",
				video: { width: 1920, height: 1080, fps: 30 },
				cameraTrack: null,
			},
		],
		transcript: null,
		transcripts: [
			{
				assetId: "a1",
				language: "en",
				segments: [
					{ id: "s1", kind: "speech", startSec: 0, endSec: 6, text: "a b", wordIds: ["w1", "w2"] },
				],
				words: [
					{ id: "w1", segmentId: "s1", startSec: 1, endSec: 4, text: "hello" },
					{ id: "w2", segmentId: "s1", startSec: 5, endSec: 6, text: "world" },
				],
			},
		],
		timeline: {
			clips: [
				{
					id: "c1",
					assetId: "a1",
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
		audioTracks: [],
		legacyEditor: null,
		...over,
	}) as unknown as AxcutDocument;

/** Insert "hi" after `w1`, which ends at source second 4. */
const withInsertion = (base = doc()) => insertGeneratedClip(base, "a1", "w1", "after", "hi");
// "hi" is 2 chars at 15/s, under the floor.
const GEN_SEC = 0.15;

describe("insertGeneratedClip", () => {
	it("cuts the clip in two and puts the generated clip between the halves", () => {
		const clips = withInsertion().timeline.clips;
		expect(clips.map((c) => c.assetId)).toEqual(["a1", "ext:synth_1", "a1"]);
		expect(clips[1].timelineEndSec - clips[1].timelineStartSec).toBeCloseTo(GEN_SEC, 6);
	});

	it("leaves both halves on the source seconds they always had", () => {
		const clips = withInsertion().timeline.clips;
		expect([clips[0].sourceStartSec, clips[0].sourceEndSec]).toEqual([0, 4]);
		expect([clips[2].sourceStartSec, clips[2].sourceEndSec]).toEqual([4, 10]);
	});

	it("lays them end to end, so the film grew by exactly the insertion", () => {
		const clips = withInsertion().timeline.clips;
		expect(clips[0].timelineStartSec).toBe(0);
		for (const [i, clip] of clips.slice(0, -1).entries()) {
			expect(clip.timelineEndSec).toBeCloseTo(clips[i + 1].timelineStartSec, 9);
		}
		expect(clips[2].timelineEndSec).toBeCloseTo(10 + GEN_SEC, 6);
	});

	it("gives the generated clip its own media, and its own transcript to be read from", () => {
		const next = withInsertion();
		const asset = next.assets.find((a) => a.id === "ext:synth_1");
		expect(asset?.originalPath).toBe("C:/rec/.openscreen-extensions/synth_1_150.mp4");
		const transcript = next.transcripts.find((t) => t.assetId === "ext:synth_1");
		expect(transcript?.words).toEqual([
			{
				id: "synth_1",
				segmentId: "seg_1",
				startSec: 0,
				endSec: GEN_SEC,
				text: "hi",
				source: "synth",
			},
		]);
	});

	it("keeps a trim authored across the cut cutting on both sides of it", () => {
		// Anchored to the clip that no longer exists as one. Copied onto both halves, each
		// subtracting its own overlap — so the film loses the same 3..5 it did before.
		const base = doc();
		base.timeline.trimRanges = [
			{ id: "t1", clipId: "c1", assetId: "a1", startSec: 3, endSec: 5 },
		] as unknown as AxcutDocument["timeline"]["trimRanges"];
		const next = withInsertion(base);
		const kept = resolvePlaybackSegments(next.timeline.clips, next.timeline.trimRanges)
			.filter((s) => s.assetId === "a1")
			.map((s) => [s.sourceStartSec, s.sourceEndSec]);
		expect(kept).toEqual([
			[0, 3],
			[5, 10],
		]);
	});
});

describe("removeGeneratedClips", () => {
	it("puts the clip back exactly as it was", () => {
		const back = removeGeneratedClips(withInsertion(), ["synth_1"]);
		expect(back.timeline.clips).toHaveLength(1);
		expect(back.timeline.clips[0]).toMatchObject({
			assetId: "a1",
			sourceStartSec: 0,
			sourceEndSec: 10,
			timelineStartSec: 0,
			timelineEndSec: 10,
		});
	});

	it("takes the media it was the only user of with it", () => {
		const back = removeGeneratedClips(withInsertion(), ["synth_1"]);
		expect(back.assets.map((a) => a.id)).toEqual(["a1"]);
		expect(back.transcripts.map((t) => t.assetId)).toEqual(["a1"]);
	});

	it("does NOT rejoin halves the user has since made different clips", () => {
		// A crop on one half is an edit the user made deliberately. Rejoining would throw it
		// away to make the inverse look tidy, which is the one thing this must never do.
		const next = withInsertion();
		const cropped = {
			...next,
			timeline: {
				...next.timeline,
				clips: next.timeline.clips.map((c, i) =>
					i === 2 ? { ...c, cropRegion: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } } : c,
				),
			},
		};
		const back = removeGeneratedClips(cropped, ["synth_1"]);
		expect(back.timeline.clips).toHaveLength(2);
		expect(back.timeline.clips[1].timelineStartSec).toBeCloseTo(4, 6);
	});

	it("rejoins the recording when the generated clip is dragged away instead", () => {
		// Nothing in `insertion.ts` knows this happens. The clip list holds the invariant, so
		// moving the insertion out of the middle heals the cut exactly as deleting it does.
		const next = withInsertion();
		const moved = moveClip(next, "ext:synth_1", 2, "user", "");
		expect(moved.timeline.clips.map((c) => c.assetId)).toEqual(["a1", "ext:synth_1"]);
		expect(moved.timeline.clips[0]).toMatchObject({ sourceStartSec: 0, sourceEndSec: 10 });
	});

	it("is a no-op for a word that has no clip", () => {
		const base = doc();
		expect(removeGeneratedClips(base, ["synth_9"])).toBe(base);
	});
});

describe("the seam only closes under generated media", () => {
	it("leaves two halves of a recording apart when an ORDINARY clip between them goes", () => {
		// Cutting a recording into consecutive clips is something this app does on purpose —
		// `replaceTimeline` builds exactly that so each piece can carry its own zoom. Deleting
		// a B-roll clip laid between two of them must not collapse the two into one.
		const base = doc({
			assets: [
				...doc().assets,
				{
					id: "a2",
					kind: "video",
					label: "broll",
					originalPath: "C:/rec/broll.mp4",
					cameraTrack: null,
				},
			],
		} as never);
		base.timeline.clips = [
			{ ...base.timeline.clips[0], id: "left", sourceEndSec: 4, timelineEndSec: 4 },
			{
				...base.timeline.clips[0],
				id: "broll",
				assetId: "a2",
				sourceStartSec: 0,
				sourceEndSec: 2,
				timelineStartSec: 4,
				timelineEndSec: 6,
			},
			{
				...base.timeline.clips[0],
				id: "right",
				sourceStartSec: 4,
				sourceEndSec: 10,
				timelineStartSec: 6,
				timelineEndSec: 12,
			},
		];
		const after = removeClip(base, "broll");
		expect(after.timeline.clips.map((c) => c.id)).toEqual(["left", "right"]);
	});

	it("keeps a word that has no clip a no-op", () => {
		const base = doc();
		expect(removeGeneratedClips(base, ["synth_9"])).toBe(base);
	});
});

describe("retextGeneratedClip", () => {
	it("resizes the clip to the new text and renames the file it plays", () => {
		const next = retextGeneratedClip(withInsertion(), "synth_1", "a much longer sentence");
		const seconds = "a much longer sentence".length / 15;
		const clip = next.timeline.clips.find((c) => c.id === "ext:synth_1");
		expect(clip?.sourceEndSec).toBeCloseTo(seconds, 6);
		expect(clip?.timelineEndSec ?? 0 - (clip?.timelineStartSec ?? 0)).toBeGreaterThan(0);
		expect(next.assets.find((a) => a.id === "ext:synth_1")?.originalPath).toBe(
			`C:/rec/.openscreen-extensions/synth_1_${Math.round(seconds * 1000)}.mp4`,
		);
	});
});
