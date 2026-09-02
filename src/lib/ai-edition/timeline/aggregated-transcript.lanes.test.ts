// Issue #560: the transcript tab was wired to `timeline.clips`, so a voiceover —
// speech, with words, on the timeline — could not be read, trimmed or grounded
// against. The aggregation is now parameterised by lane, and these hold the two
// providers to the same contract.

import { describe, expect, it } from "vitest";
import type { AxcutAudioTrack } from "../schema";
import {
	buildAggregatedSections,
	lanePlacements,
	voiceoverPlacements,
} from "./aggregated-transcript";

function track(over: Partial<AxcutAudioTrack> & { id: string }): AxcutAudioTrack {
	return {
		startMs: 0,
		endMs: 4000,
		clipId: "clip_1",
		sourceStartSec: 0,
		sourceEndSec: 4,
		assetId: "asset_vo",
		kind: "voiceover",
		durationSec: 30,
		offsetMs: 0,
		gainDb: 0,
		loop: false,
		fadeInMs: 0,
		fadeOutMs: 0,
		muted: false,
		label: "",
		origin: "user",
		...over,
	} as unknown as AxcutAudioTrack;
}

describe("voiceoverPlacements", () => {
	it("windows the source by the fragment's own offset, not the file's head", () => {
		// A fragment that starts 6s into its file and plays for 4s is 6s..10s of
		// speech. Reading from 0 would caption the wrong sentence entirely.
		const [placement] = voiceoverPlacements([
			track({ id: "t1", offsetMs: 6000, startMs: 2000, endMs: 6000 }),
		]);
		expect(placement.sourceStartSec).toBe(6);
		expect(placement.sourceEndSec).toBe(10);
		expect(placement.timelineStartSec).toBe(2);
	});

	it("leaves music out — it is never transcribed, so it is never a lane", () => {
		const placements = voiceoverPlacements([
			track({ id: "t1", kind: "music" }),
			track({ id: "t2", kind: "voiceover" }),
		]);
		expect(placements.map((p) => p.id)).toEqual(["t2"]);
	});

	it("orders by the ruler, not by the order the tracks were written", () => {
		const placements = voiceoverPlacements([
			track({ id: "late", startMs: 9000, endMs: 12000 }),
			track({ id: "early", startMs: 1000, endMs: 3000 }),
		]);
		expect(placements.map((p) => p.id)).toEqual(["early", "late"]);
	});

	it("keeps every fragment of a ventilated track", () => {
		// A bed spanning a cut is one pill and two fragments; collapsing them here
		// would re-read the file from its head on the far side of the cut.
		const placements = voiceoverPlacements([
			track({ id: "f1", trackId: "T", startMs: 0, endMs: 3000, offsetMs: 0 }),
			track({ id: "f2", trackId: "T", startMs: 3000, endMs: 5000, offsetMs: 3000 }),
		]);
		expect(placements.map((p) => [p.sourceStartSec, p.sourceEndSec])).toEqual([
			[0, 3],
			[3, 5],
		]);
	});
});

describe("lanePlacements", () => {
	const CLIPS = [
		{
			id: "clip_1",
			assetId: "asset_rec",
			sourceStartSec: 0,
			sourceEndSec: 12,
			timelineStartSec: 0,
			timelineEndSec: 12,
			wordRefs: [],
			origin: "user" as const,
			reason: "",
		},
	];

	it("reads the recording by default and the voiceover on request", () => {
		const tracks = [track({ id: "t1" })];
		expect(lanePlacements("recording", CLIPS, tracks).map((p) => p.assetId)).toEqual(["asset_rec"]);
		expect(lanePlacements("voiceover", CLIPS, tracks).map((p) => p.assetId)).toEqual(["asset_vo"]);
	});

	it("gives the aggregator sections it can key words on", () => {
		// The whole point of the parameterisation: everything downstream consumes
		// sections, and a voiceover section has to be indistinguishable from a clip's.
		const transcript = {
			assetId: "asset_vo",
			language: "en",
			words: [
				{ id: "w1", segmentId: "s", text: "bonjour", startSec: 0.2, endSec: 0.8 },
				{ id: "w2", segmentId: "s", text: "tout", startSec: 0.8, endSec: 1.1 },
			],
			segments: [],
		};
		const sections = buildAggregatedSections(
			lanePlacements("voiceover", CLIPS, [track({ id: "t1" })]),
			// biome-ignore lint/suspicious/noExplicitAny: fixture, not a schema exercise
			[transcript as any],
			[],
			[],
		);
		expect(sections).toHaveLength(1);
		expect(sections[0].words.filter((w) => !w.word.id.startsWith("silence_"))).toHaveLength(2);
		// Namespaced by placement id, so two placements over one asset never collide.
		expect(sections[0].words[0].id.startsWith("t1:")).toBe(true);
	});
});
