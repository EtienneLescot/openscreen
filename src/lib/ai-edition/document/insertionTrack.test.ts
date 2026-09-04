// The voice-over half of the insertion model. Same shape as the clips, different
// coordinates — and one rule that is the opposite of the clip lane's, pinned here because it
// was settled deliberately: a take insertion does NOT lengthen the film.

import { describe, expect, it } from "vitest";
import type { AxcutDocument } from "../schema";
import { collapseTracksToPills } from "./audioTracks";
import { insertGeneratedClip } from "./insertion";
import {
	insertGeneratedTrack,
	removeGeneratedTracks,
	retextGeneratedTrack,
} from "./insertionTrack";

const doc = (): AxcutDocument =>
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
			{ id: "vo", kind: "audio", label: "vo", originalPath: "C:/rec/vo.wav", cameraTrack: null },
		],
		transcript: null,
		transcripts: [
			{
				assetId: "a1",
				language: "en",
				segments: [],
				words: [{ id: "w1", segmentId: "s1", startSec: 1, endSec: 4, text: "hello" }],
			},
			{
				assetId: "vo",
				language: "en",
				segments: [],
				words: [
					{ id: "v1", segmentId: "s1", startSec: 1, endSec: 4, text: "spoken" },
					{ id: "v2", segmentId: "s1", startSec: 6, endSec: 8, text: "later" },
				],
			},
		],
		timeline: {
			clips: [
				{
					id: "c1",
					assetId: "a1",
					sourceStartSec: 0,
					sourceEndSec: 20,
					timelineStartSec: 0,
					timelineEndSec: 20,
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
		audioTracks: [
			{
				id: "t1",
				startMs: 2000,
				endMs: 12000,
				assetId: "vo",
				kind: "voiceover",
				durationSec: 10,
				offsetMs: 0,
				gainDb: 0,
				loop: false,
				fadeInMs: 200,
				fadeOutMs: 300,
				muted: false,
				label: "vo",
				origin: "user",
			},
		],
		legacyEditor: null,
	}) as unknown as AxcutDocument;

/** Insert "hi" after `v1`, which ends at file second 4 — ruler second 6. */
const inserted = () => insertGeneratedTrack(doc(), "vo", "v1", "after", "hi");
const GEN_MS = 150;

const takes = (d: AxcutDocument) =>
	[...d.audioTracks]
		.sort((a, b) => a.startMs - b.startMs)
		.map((t) => ({
			assetId: t.assetId,
			startMs: t.startMs,
			endMs: t.endMs,
			offsetMs: t.offsetMs,
		}));

describe("insertGeneratedTrack", () => {
	it("cuts the take in two and puts the generated audio between the halves", () => {
		expect(takes(inserted())).toEqual([
			{ assetId: "vo", startMs: 2000, endMs: 6000, offsetMs: 0 },
			{ assetId: "ext:synth_1", startMs: 6000, endMs: 6000 + GEN_MS, offsetMs: 0 },
			// The file picks up where it stopped: 4s consumed, so the tail starts at 4s in.
			{ assetId: "vo", startMs: 6000 + GEN_MS, endMs: 12000 + GEN_MS, offsetMs: 4000 },
		]);
	});

	it("does NOT lengthen the film — that is the clips' business, and they did not move", () => {
		expect(inserted().timeline.clips).toEqual(doc().timeline.clips);
	});

	it("fades once at each real edge, not at the seam it just made", () => {
		const ordered = [...inserted().audioTracks].sort((a, b) => a.startMs - b.startMs);
		expect(ordered.map((t) => [t.fadeInMs, t.fadeOutMs])).toEqual([
			[200, 0],
			[0, 0],
			[0, 300],
		]);
	});

	it("gives the generated audio its own transcript, to be read like any other", () => {
		const t = inserted().transcripts.find((x) => x.assetId === "ext:synth_1");
		expect(t?.words.map((w) => [w.text, w.source])).toEqual([["hi", "synth"]]);
	});
});

describe("removeGeneratedTracks", () => {
	it("puts the take back exactly as it was", () => {
		const back = removeGeneratedTracks(inserted(), ["synth_1"]);
		expect(takes(back)).toEqual([{ assetId: "vo", startMs: 2000, endMs: 12000, offsetMs: 0 }]);
	});

	it("takes the media it was the only user of with it", () => {
		const back = removeGeneratedTracks(inserted(), ["synth_1"]);
		expect(back.assets.some((a) => a.id === "ext:synth_1")).toBe(false);
		expect(back.transcripts.some((t) => t.assetId === "ext:synth_1")).toBe(false);
	});
});

describe("retextGeneratedTrack", () => {
	it("resizes it and pushes only what came after, by the difference", () => {
		const longer = retextGeneratedTrack(inserted(), "synth_1", "a much longer line");
		const spanMs = Math.round((("a much longer line".length / 15) as number) * 1000);
		expect(takes(longer)).toEqual([
			{ assetId: "vo", startMs: 2000, endMs: 6000, offsetMs: 0 },
			{ assetId: "ext:synth_1", startMs: 6000, endMs: 6000 + spanMs, offsetMs: 0 },
			{ assetId: "vo", startMs: 6000 + spanMs, endMs: 12000 + spanMs, offsetMs: 4000 },
		]);
	});
});

describe("the two lanes stay out of each other's way", () => {
	it("a word added to the FILM leaves the take's own span alone", () => {
		// Settled deliberately: the take has its own audio and keeps talking against a picture
		// that has slid. Its ruler span is re-anchored, never stretched.
		const before = doc();
		const after = insertGeneratedClip(before, "a1", "w1", "after", "hi");
		// The clips it covers became three, so the take is stored as three fragments — that is
		// ventilation, and it is what keeps a take playing continuously across a cut. What must
		// not change is the take itself: one pill, the same length, holding the same audio.
		const vo = collapseTracksToPills(after.audioTracks).filter((t) => t.assetId === "vo");
		expect(vo).toHaveLength(1);
		expect(vo[0].endMs - vo[0].startMs).toBe(10000);
	});
});
