// Issue #560: the transcript tab was wired to `timeline.clips`, so a voiceover —
// speech, with words, on the timeline — could not be read, trimmed or grounded
// against. The aggregation is now parameterised by lane, and these hold the two
// providers to the same contract.

import { describe, expect, it } from "vitest";
import type { AxcutAudioTrack } from "../schema";
import {
	buildAggregatedSections,
	findCueWordId,
	lanePlacements,
	placementRawSec,
	voiceoverPlacements,
} from "./aggregated-transcript";
import { removedRawSpans } from "./programme-time";

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

// ─── The bug this parameterisation shipped with ──────────────────────────────
// `b9e0f1ff` decided kept-or-removed by asking whether a trim NAMED the placement. A
// voiceover placement carries an audio fragment id and an audio asset; every trim carries
// a video clip. They never matched, so the voiceover lane read every word as kept — over
// film that had been cut away — and a cut authored from it removed nothing at all. These
// hold the ruler-based answer that replaced it.

describe("one programme, two lanes", () => {
	const CLIPS_2 = [
		{
			id: "clip_1",
			assetId: "asset_rec",
			sourceStartSec: 0,
			sourceEndSec: 6,
			timelineStartSec: 0,
			timelineEndSec: 6,
			wordRefs: [],
			origin: "user" as const,
			reason: "",
		},
		{
			id: "clip_2",
			assetId: "asset_rec",
			sourceStartSec: 6,
			sourceEndSec: 12,
			timelineStartSec: 6,
			timelineEndSec: 12,
			wordRefs: [],
			origin: "user" as const,
			reason: "",
		},
	];

	/** A cut over raw 2..4, anchored the way the transcript pane writes one. */
	const TRIM = {
		id: "trim_1",
		assetId: "asset_rec",
		clipId: "clip_1",
		startSec: 2,
		endSec: 4,
		origin: "user" as const,
		reason: "",
	};

	/** Words at one per second, so a word's index is its second. */
	function secondsTranscript(assetId: string, count: number, from = 0) {
		return {
			assetId,
			language: "en",
			segments: [],
			words: Array.from({ length: count }, (_, i) => ({
				id: `w${from + i}`,
				segmentId: "s",
				text: `w${from + i}`,
				startSec: from + i + 0.1,
				endSec: from + i + 0.9,
			})),
		};
	}

	/** A voiceover laid over the whole programme, reading its own file from the head. */
	const VO = track({ id: "vo_1", startMs: 0, endMs: 12000, offsetMs: 0, durationSec: 12 });

	function lanes(trims: (typeof TRIM)[]) {
		const removed = removedRawSpans(CLIPS_2, trims);
		const transcripts = [secondsTranscript("asset_rec", 12), secondsTranscript("asset_vo", 12)];
		const build = (lane: "recording" | "voiceover") =>
			buildAggregatedSections(
				lanePlacements(lane, CLIPS_2, [VO]),
				// biome-ignore lint/suspicious/noExplicitAny: fixtures, not a schema exercise
				transcripts as any,
				[],
				removed,
			);
		return { recording: build("recording"), voiceover: build("voiceover") };
	}

	const cutWords = (sections: ReturnType<typeof lanes>["recording"]) =>
		sections
			.flatMap((s) => s.words)
			.filter((w) => !w.kept && !w.word.id.startsWith("silence_"))
			.map((w) => w.word.text);

	it("marks a voiceover word removed when the film under it was cut", () => {
		// THE bug. Before this, the voiceover lane returned every word kept.
		const { voiceover } = lanes([TRIM]);
		expect(cutWords(voiceover)).toEqual(["w2", "w3"]);
		const w2 = voiceover.flatMap((s) => s.words).find((w) => w.word.id === "w2");
		expect(w2?.trimIds).toEqual(["trim_1"]);
	});

	it("greys the same moment on whichever lane you read", () => {
		const { recording, voiceover } = lanes([TRIM]);
		expect(cutWords(recording)).toEqual(["w2", "w3"]);
		expect(cutWords(voiceover)).toEqual(cutWords(recording));
	});

	it("leaves both lanes whole when nothing is cut", () => {
		const { recording, voiceover } = lanes([]);
		expect(cutWords(recording)).toEqual([]);
		expect(cutWords(voiceover)).toEqual([]);
	});

	it("removes a word over an inter-clip gap, with nothing to restore", () => {
		const gapped = [CLIPS_2[0], { ...CLIPS_2[1], timelineStartSec: 8, timelineEndSec: 14 }];
		const removed = removedRawSpans(gapped, []);
		const sections = buildAggregatedSections(
			voiceoverPlacements([track({ id: "vo_1", startMs: 0, endMs: 14000, durationSec: 14 })]),
			// biome-ignore lint/suspicious/noExplicitAny: fixture, not a schema exercise
			[secondsTranscript("asset_vo", 14)] as any,
			[],
			removed,
		);
		const w6 = sections.flatMap((s) => s.words).find((w) => w.word.id === "w6"); // raw 6..7
		expect(w6?.kept).toBe(false);
		// Nothing took it, so the pane must offer no bin: a gap is not a pill.
		expect(w6?.trimIds).toEqual([]);
		const run = sections.flatMap((s) => s.trimRuns).find((r) => r.trimIds.length === 0);
		expect(run).toBeDefined();
	});

	it("keeps a word that hangs past the end of the programme", () => {
		// The projection is the identity there, so the narration still plays.
		const over = track({ id: "vo_1", startMs: 0, endMs: 20000, durationSec: 20 });
		const sections = buildAggregatedSections(
			voiceoverPlacements([over]),
			// biome-ignore lint/suspicious/noExplicitAny: fixture, not a schema exercise
			[secondsTranscript("asset_vo", 20)] as any,
			[],
			removedRawSpans(CLIPS_2, []),
		);
		const w15 = sections.flatMap((s) => s.words).find((w) => w.word.id === "w15");
		expect(w15?.kept).toBe(true);
	});

	it("highlights the voiceover lane from a raw second", () => {
		// The cue used to be resolved into a clip id, which only the recording lane has —
		// so this returned null for every moment of every voiceover.
		const { voiceover } = lanes([]);
		expect(findCueWordId(voiceover, 4.5)).toBe("vo_1:w4");
		expect(findCueWordId(voiceover, 0.5)).toBe("vo_1:w0");
	});

	it("reads a word's raw moment through its own placement", () => {
		// A take starting 3s along the ruler, 5s into its file: its source 6 is raw 4.
		const placement = { id: "p", assetId: "a", sourceStartSec: 5, timelineStartSec: 3 };
		expect(placementRawSec(placement, 6)).toBe(4);
	});

	it("contributes no placement for a looping take", () => {
		// `anchorAudioTrackFragments` does not advance `offsetMs` under loop, so a looping
		// take's later fragments map their words to raw moments the words do not occupy.
		expect(voiceoverPlacements([{ ...VO, loop: true }])).toEqual([]);
		expect(voiceoverPlacements([VO])).toHaveLength(1);
	});
});
