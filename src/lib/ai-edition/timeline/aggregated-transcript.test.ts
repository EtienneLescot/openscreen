import { describe, expect, it } from "vitest";
import type { AxcutAsset, AxcutClip, AxcutTranscript, AxcutTrimRange } from "../schema";
import {
	buildAggregatedSections,
	buildClipSection,
	findCueWordId,
	isSilenceWord,
} from "./aggregated-transcript";

function makeClip(overrides: Partial<AxcutClip> = {}): AxcutClip {
	return {
		id: "clip_1",
		assetId: "asset_1",
		sourceStartSec: 0,
		sourceEndSec: 10,
		timelineStartSec: 0,
		timelineEndSec: 10,
		wordRefs: [],
		origin: "system",
		reason: "",
		...overrides,
	};
}

function makeAsset(overrides: Partial<AxcutAsset> = {}): AxcutAsset {
	return {
		id: "asset_1",
		kind: "video",
		label: "demo.mp4",
		originalPath: "/tmp/demo.mp4",
		durationSec: 30,
		...overrides,
	};
}

function makeTranscript(words: AxcutTranscript["words"]): AxcutTranscript {
	return { assetId: "asset_1", language: "en", segments: [], words };
}

function makeTrim(overrides: Partial<AxcutTrimRange>): AxcutTrimRange {
	return {
		id: overrides.id ?? "trim_1",
		assetId: overrides.assetId ?? "asset_1",
		startSec: overrides.startSec ?? 0,
		endSec: overrides.endSec ?? 0,
		origin: overrides.origin ?? "user",
		reason: overrides.reason ?? "",
	};
}

describe("buildClipSection", () => {
	it("marks every word in source range as kept when no trims exist", () => {
		const clip = makeClip({ sourceStartSec: 0, sourceEndSec: 3 });
		const transcript = makeTranscript([
			{ id: "w1", segmentId: "s1", startSec: 0, endSec: 1, text: "hi" },
			{ id: "w2", segmentId: "s1", startSec: 1, endSec: 2, text: "there" },
			{ id: "w3", segmentId: "s1", startSec: 2, endSec: 3, text: "friend" },
		]);

		const section = buildClipSection(clip, transcript, makeAsset(), []);
		expect(section.words.map((cw) => cw.kept)).toEqual([true, true, true]);
		expect(section.trimRuns).toEqual([]);
	});

	it("flags words inside a trim range as removed and groups them into one TrimRun", () => {
		const clip = makeClip({ sourceStartSec: 0, sourceEndSec: 5 });
		const transcript = makeTranscript([
			{ id: "w1", segmentId: "s1", startSec: 0, endSec: 1, text: "hi" },
			{ id: "w2", segmentId: "s1", startSec: 1, endSec: 2, text: "uh" },
			{ id: "w3", segmentId: "s1", startSec: 2, endSec: 3, text: "long" },
			{ id: "w4", segmentId: "s1", startSec: 3, endSec: 4, text: "pause" },
			{ id: "w5", segmentId: "s1", startSec: 4, endSec: 5, text: "bye" },
		]);
		const trim = makeTrim({ id: "trim_a", startSec: 1, endSec: 4 });

		const section = buildClipSection(clip, transcript, makeAsset(), [trim]);
		expect(section.words.map((cw) => cw.kept)).toEqual([true, false, false, false, true]);
		expect(section.words.map((cw) => cw.trimId)).toEqual([
			null,
			"trim_a",
			"trim_a",
			"trim_a",
			null,
		]);
		expect(section.trimRuns).toHaveLength(1);
		expect(section.trimRuns[0]).toMatchObject({
			trimId: "trim_a",
			startWordIndex: 1,
			endWordIndex: 3,
			durationSec: 3,
		});
	});

	it("splits separated trim ranges into multiple TrimRuns", () => {
		const clip = makeClip({ sourceStartSec: 0, sourceEndSec: 6 });
		const transcript = makeTranscript([
			{ id: "w1", segmentId: "s1", startSec: 0, endSec: 1, text: "a" },
			{ id: "w2", segmentId: "s1", startSec: 1, endSec: 2, text: "b" },
			{ id: "w3", segmentId: "s1", startSec: 2, endSec: 3, text: "c" },
			{ id: "w4", segmentId: "s1", startSec: 3, endSec: 4, text: "d" },
			{ id: "w5", segmentId: "s1", startSec: 4, endSec: 5, text: "e" },
			{ id: "w6", segmentId: "s1", startSec: 5, endSec: 6, text: "f" },
		]);
		const trims = [
			makeTrim({ id: "trim_a", startSec: 1, endSec: 2 }),
			makeTrim({ id: "trim_b", startSec: 3, endSec: 4 }),
		];

		const section = buildClipSection(clip, transcript, makeAsset(), trims);
		expect(section.trimRuns).toHaveLength(2);
		expect(section.trimRuns[0]).toMatchObject({
			trimId: "trim_a",
			startWordIndex: 1,
			endWordIndex: 1,
		});
		expect(section.trimRuns[1]).toMatchObject({
			trimId: "trim_b",
			startWordIndex: 3,
			endWordIndex: 3,
		});
	});

	it("does NOT apply trims from a different asset", () => {
		const clip = makeClip({ sourceStartSec: 0, sourceEndSec: 3 });
		const transcript = makeTranscript([
			{ id: "w1", segmentId: "s1", startSec: 0, endSec: 1, text: "hi" },
			{ id: "w2", segmentId: "s1", startSec: 1, endSec: 2, text: "there" },
		]);
		const trim = makeTrim({ id: "trim_x", assetId: "asset_2", startSec: 0.5, endSec: 2.5 });

		const section = buildClipSection(clip, transcript, makeAsset(), [trim]);
		// Trailing gap 2s→3s is a silence — the different-asset trim doesn't
		// cover any of the three entries, so all stay kept.
		expect(section.words.map((cw) => cw.kept)).toEqual([true, true, true]);
	});

	it("treats every word the same (no filler concept)", () => {
		const clip = makeClip({ sourceStartSec: 0, sourceEndSec: 3 });
		const transcript = makeTranscript([
			{ id: "w1", segmentId: "s1", startSec: 0, endSec: 1, text: "okay" },
			{ id: "w2", segmentId: "s1", startSec: 1, endSec: 2, text: "real" },
			{ id: "w3", segmentId: "s1", startSec: 2, endSec: 3, text: "Um," },
		]);

		const section = buildClipSection(clip, transcript, makeAsset(), []);
		// ponytail: the LLM (not the renderer) decides what is a filler. Every
		// word renders as plain text in the right pane.
		expect(section.words.map((cw) => cw.kept)).toEqual([true, true, true]);
		expect(section.words.map((cw) => cw.trimId)).toEqual([null, null, null]);
	});

	it("returns an empty words list when the clip has no matching transcript", () => {
		const clip = makeClip({ sourceStartSec: 0, sourceEndSec: 5 });
		const section = buildClipSection(clip, null, makeAsset(), []);

		expect(section.words).toEqual([]);
		expect(section.trimRuns).toEqual([]);
		expect(section.transcript).toBeNull();
	});

	it("ignores transcript words outside the clip's source range", () => {
		const clip = makeClip({ sourceStartSec: 2, sourceEndSec: 4 });
		const transcript = makeTranscript([
			{ id: "w_before", segmentId: "s1", startSec: 0, endSec: 1, text: "trim" },
			{ id: "w_mid", segmentId: "s1", startSec: 2.5, endSec: 3.5, text: "in" },
			{ id: "w_after", segmentId: "s1", startSec: 5, endSec: 6, text: "trim" },
		]);

		const section = buildClipSection(clip, transcript, makeAsset(), []);
		// Leading (2s→2.5s) and trailing (3.5s→4s) gaps are both silences.
		expect(section.words.map((cw) => cw.word.id)).toEqual(["silence_1", "w_mid", "silence_2"]);
	});
});

describe("silence gaps", () => {
	it("inserts a [silence] pseudo-word for gaps at or above the threshold", () => {
		const clip = makeClip({ sourceStartSec: 0, sourceEndSec: 3 });
		const transcript = makeTranscript([
			{ id: "w1", segmentId: "s1", startSec: 0, endSec: 1, text: "hi" },
			{ id: "w2", segmentId: "s1", startSec: 1.3, endSec: 2, text: "there" },
		]);

		const section = buildClipSection(clip, transcript, makeAsset(), []);
		const ids = section.words.map((cw) => cw.word.id);
		expect(ids).toEqual(["w1", "silence_1", "w2", "silence_2"]);
		expect(section.words.filter((cw) => isSilenceWord(cw.word))).toHaveLength(2);
		expect(section.words[1]?.word.text).toBe("[silence]");
	});

	it("does not insert a silence for gaps under the threshold", () => {
		const clip = makeClip({ sourceStartSec: 0, sourceEndSec: 2 });
		const transcript = makeTranscript([
			{ id: "w1", segmentId: "s1", startSec: 0, endSec: 1, text: "hi" },
			{ id: "w2", segmentId: "s1", startSec: 1.1, endSec: 2, text: "there" },
		]);

		const section = buildClipSection(clip, transcript, makeAsset(), []);
		expect(section.words.map((cw) => cw.word.id)).toEqual(["w1", "w2"]);
	});

	it("marks a silence as removed when a trim range covers it, restorable via its trimId", () => {
		const clip = makeClip({ sourceStartSec: 0, sourceEndSec: 3 });
		const transcript = makeTranscript([
			{ id: "w1", segmentId: "s1", startSec: 0, endSec: 1, text: "hi" },
			{ id: "w2", segmentId: "s1", startSec: 2, endSec: 3, text: "there" },
		]);
		const trim = makeTrim({ id: "trim_silence", startSec: 1, endSec: 2 });

		const section = buildClipSection(clip, transcript, makeAsset(), [trim]);
		const silence = section.words.find((cw) => isSilenceWord(cw.word));
		expect(silence?.kept).toBe(false);
		expect(silence?.trimId).toBe("trim_silence");
	});
});

describe("buildAggregatedSections", () => {
	it("joins per-clip sections across two assets in timeline order", () => {
		const clips = [
			makeClip({ id: "c1", assetId: "asset_1", sourceStartSec: 0, sourceEndSec: 2 }),
			makeClip({
				id: "c2",
				assetId: "asset_2",
				sourceStartSec: 0,
				sourceEndSec: 2,
				timelineStartSec: 2,
				timelineEndSec: 4,
			}),
		];
		const transcripts = [
			makeTranscript([
				{ id: "w1", segmentId: "s1", startSec: 0, endSec: 1, text: "hi" },
				{ id: "w2", segmentId: "s1", startSec: 1, endSec: 2, text: "there" },
			]),
			{
				assetId: "asset_2",
				language: "en",
				segments: [],
				words: [
					{ id: "w3", segmentId: "s1", startSec: 0, endSec: 1, text: "bye" },
					{ id: "w4", segmentId: "s1", startSec: 1, endSec: 2, text: "now" },
				],
			},
		];
		const assets = [
			makeAsset({ id: "asset_1", label: "first.mp4" }),
			makeAsset({ id: "asset_2", label: "second.mp4" }),
		];

		const sections = buildAggregatedSections(clips, transcripts, assets, []);
		expect(sections).toHaveLength(2);
		expect(sections[0]?.clip.id).toBe("c1");
		expect(sections[1]?.clip.id).toBe("c2");
		expect(sections[0]?.asset?.label).toBe("first.mp4");
		expect(sections[1]?.asset?.label).toBe("second.mp4");
	});

	it("still renders a section when a clip's asset has no transcript", () => {
		const clips = [makeClip({ id: "c1" }), makeClip({ id: "c2", assetId: "asset_2" })];
		const transcripts = [makeTranscript([])];
		const assets = [makeAsset(), makeAsset({ id: "asset_2" })];

		const sections = buildAggregatedSections(clips, transcripts, assets, []);
		expect(sections).toHaveLength(2);
		expect(sections[0]?.transcript).toBeTruthy();
		expect(sections[1]?.transcript).toBeNull();
		expect(sections[1]?.words).toEqual([]);
	});
});

describe("findCueWordId", () => {
	function makeSection(
		clipId: string,
		assetId: string,
		wordTimes: Array<[string, number, number]>,
	) {
		return {
			clip: makeClip({ id: clipId, assetId, sourceStartSec: 0, sourceEndSec: 100 }),
			asset: makeAsset({ id: assetId }),
			transcript: null,
			words: wordTimes.map(([id, start, end]) => ({
				word: { id, segmentId: "s1", startSec: start, endSec: end, text: id },
				kept: true,
				trimId: null,
			})),
			trimRuns: [],
		};
	}

	it("returns null when cue is null", () => {
		const section = makeSection("c1", "asset_1", [["w1", 0, 1]]);
		expect(findCueWordId([section], null)).toBeNull();
	});

	it("returns null when no section matches the cue asset", () => {
		const section = makeSection("c1", "asset_1", [["w1", 0, 1]]);
		const cue = { assetId: "asset_2", sourceTimeSec: 0.5 };
		expect(findCueWordId([section], cue)).toBeNull();
	});

	it("returns the word containing the cue time", () => {
		const section = makeSection("c1", "asset_1", [
			["w1", 0, 1],
			["w2", 1, 2],
			["w3", 2, 3],
		]);
		expect(findCueWordId([section], { assetId: "asset_1", sourceTimeSec: 1.5 })).toBe("w2");
	});

	it("returns the previous word when the cue is between two words", () => {
		const section = makeSection("c1", "asset_1", [
			["w1", 0, 1],
			["w2", 2, 3],
		]);
		expect(findCueWordId([section], { assetId: "asset_1", sourceTimeSec: 1.5 })).toBe("w1");
	});

	it("returns the previous word when the cue is before the first word", () => {
		const section = makeSection("c1", "asset_1", [
			["w1", 5, 6],
			["w2", 7, 8],
		]);
		expect(findCueWordId([section], { assetId: "asset_1", sourceTimeSec: 0.5 })).toBeNull();
	});

	it("returns the last word when the cue is after the last word", () => {
		const section = makeSection("c1", "asset_1", [
			["w1", 0, 1],
			["w2", 1, 2],
		]);
		expect(findCueWordId([section], { assetId: "asset_1", sourceTimeSec: 99 })).toBe("w2");
	});
});
