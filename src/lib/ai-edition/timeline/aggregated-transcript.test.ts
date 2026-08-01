import { describe, expect, it } from "vitest";
import type { AxcutAsset, AxcutClip, AxcutTranscript, AxcutTrimRange } from "../schema";
import {
	buildAggregatedSections,
	buildClipSection,
	clipWordId,
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
		cameraTrack: null,
		...overrides,
	};
}

function makeTranscript(words: AxcutTranscript["words"]): AxcutTranscript {
	return { assetId: "asset_1", language: "en", segments: [], words };
}

function makeTrim(overrides: Partial<AxcutTrimRange>): AxcutTrimRange {
	return {
		id: "trim_1",
		assetId: "asset_1",
		startSec: 0,
		endSec: 0,
		origin: "user",
		reason: "",
		// Spread, not a field-by-field pick: the pick silently dropped any field it did
		// not name, so `clipId` never reached the code under test.
		...overrides,
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

	// The repro: one media, two clips, same source window. `assetId` + source overlap
	// matches both, so before trims carried a clip anchor the cut showed up on the clip
	// the user never touched — and the bin icon on that phantom run deleted the real one.
	describe("two clips over the same media", () => {
		const words = () => [
			{ id: "w1", segmentId: "s1", startSec: 0, endSec: 1, text: "a" },
			{ id: "w2", segmentId: "s1", startSec: 1, endSec: 2, text: "b" },
			{ id: "w3", segmentId: "s1", startSec: 2, endSec: 3, text: "c" },
		];
		const clip1 = () => makeClip({ id: "clip_1", sourceStartSec: 0, sourceEndSec: 3 });
		const clip2 = () =>
			makeClip({
				id: "clip_2",
				sourceStartSec: 0,
				sourceEndSec: 3,
				timelineStartSec: 3,
				timelineEndSec: 6,
			});

		it("marks the words removed only in the clip the trim is anchored to", () => {
			const trim = makeTrim({ id: "trim_c2", clipId: "clip_2", startSec: 1, endSec: 2 });
			const sections = buildAggregatedSections(
				[clip1(), clip2()],
				[makeTranscript(words())],
				[makeAsset()],
				[trim],
			);

			expect(sections[0].words.map((cw) => cw.kept)).toEqual([true, true, true]);
			expect(sections[0].trimRuns).toHaveLength(0);
			expect(sections[1].words.map((cw) => cw.kept)).toEqual([true, false, true]);
			expect(sections[1].trimRuns).toHaveLength(1);
			expect(sections[1].trimRuns[0]).toMatchObject({ trimId: "trim_c2", startWordIndex: 1 });
		});

		it("still marks both clips for a pre-v7 trim that names no clip", () => {
			// Back-compat: an un-anchored row keeps the asset-wide meaning it had, so an
			// existing document reads exactly as it did before the anchor was introduced.
			const trim = makeTrim({ id: "trim_legacy", startSec: 1, endSec: 2 });
			const sections = buildAggregatedSections(
				[clip1(), clip2()],
				[makeTranscript(words())],
				[makeAsset()],
				[trim],
			);
			expect(sections[0].trimRuns).toHaveLength(1);
			expect(sections[1].trimRuns).toHaveLength(1);
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
				id: clipWordId(clipId, id),
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
		expect(findCueWordId([section], { assetId: "asset_1", sourceTimeSec: 1.5 })).toBe("c1:w2");
	});

	it("returns the previous word when the cue is between two words", () => {
		const section = makeSection("c1", "asset_1", [
			["w1", 0, 1],
			["w2", 2, 3],
		]);
		expect(findCueWordId([section], { assetId: "asset_1", sourceTimeSec: 1.5 })).toBe("c1:w1");
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
		expect(findCueWordId([section], { assetId: "asset_1", sourceTimeSec: 99 })).toBe("c1:w2");
	});

	// Two clips over the same media project the SAME transcript words twice, so the cue
	// has to be resolved against the clip that is actually playing. Matching on assetId
	// alone always returned the first section — the highlight tracked clip 1 forever.
	describe("two clips over the same media", () => {
		const sections = () => [
			makeSection("c1", "asset_1", [
				["w1", 0, 1],
				["w2", 1, 2],
			]),
			makeSection("c2", "asset_1", [
				["w1", 0, 1],
				["w2", 1, 2],
			]),
		];

		it("resolves the cue against the clip that is playing", () => {
			expect(
				findCueWordId(sections(), { assetId: "asset_1", clipId: "c2", sourceTimeSec: 1.5 }),
			).toBe("c2:w2");
			expect(
				findCueWordId(sections(), { assetId: "asset_1", clipId: "c1", sourceTimeSec: 1.5 }),
			).toBe("c1:w2");
		});

		it("returns an id that cannot match the other clip's copy of the same word", () => {
			const cue = findCueWordId(sections(), {
				assetId: "asset_1",
				clipId: "c2",
				sourceTimeSec: 1.5,
			});
			// The whole point: `word.id` is "w2" in BOTH sections, so a bare word id lit up
			// both blocks. Exactly one rendered word may claim the cue.
			const claiming = sections().flatMap((s) => s.words.filter((cw) => cw.id === cue));
			expect(claiming).toHaveLength(1);
		});

		it("falls back to the asset when the caller names no clip", () => {
			expect(findCueWordId(sections(), { assetId: "asset_1", sourceTimeSec: 1.5 })).toBe("c1:w2");
		});

		it("returns null rather than another clip's words when the playing clip has none", () => {
			const withEmptyC2 = [sections()[0], makeSection("c2", "asset_1", [])];
			expect(
				findCueWordId(withEmptyC2, { assetId: "asset_1", clipId: "c2", sourceTimeSec: 1.5 }),
			).toBeNull();
		});
	});
});

describe("clipWordId", () => {
	it("separates the same transcript word rendered in two clips", () => {
		expect(clipWordId("clip_1", "w1")).not.toBe(clipWordId("clip_2", "w1"));
	});

	it("separates the per-clip silence tokens, which collide for ANY two clips", () => {
		// `withSilenceGaps` numbers silences from 1 within each clip, so `silence_1` exists
		// in every section — unrelated assets included.
		expect(clipWordId("clip_1", "silence_1")).not.toBe(clipWordId("clip_2", "silence_1"));
	});

	it("gives buildClipSection words ids unique across the whole pane", () => {
		const transcript = makeTranscript([
			{ id: "w1", segmentId: "s1", startSec: 0, endSec: 1, text: "a" },
			// 1s gap → a `silence_1` pseudo-word in each section.
			{ id: "w2", segmentId: "s1", startSec: 2, endSec: 3, text: "b" },
		]);
		const sections = buildAggregatedSections(
			[
				makeClip({ id: "clip_1", sourceStartSec: 0, sourceEndSec: 3 }),
				makeClip({
					id: "clip_2",
					sourceStartSec: 0,
					sourceEndSec: 3,
					timelineStartSec: 3,
					timelineEndSec: 6,
				}),
			],
			[transcript],
			[makeAsset()],
			[],
		);
		const rawIds = sections.flatMap((s) => s.words.map((cw) => cw.word.id));
		const scopedIds = sections.flatMap((s) => s.words.map((cw) => cw.id));
		// The raw ids collide across the two sections; the scoped ones do not.
		expect(new Set(rawIds).size).toBeLessThan(rawIds.length);
		expect(new Set(scopedIds).size).toBe(scopedIds.length);
	});
});
