import { describe, expect, it } from "vitest";
import { type AxcutTranscript, createEmptyDocument, documentSchema } from "../schema";
import {
	carryOverWordEdits,
	insertDocumentWord,
	insertRangesMatchWords,
	insertWord,
	removeDocumentWords,
	removeWord,
	setDocumentWordText,
	setWordText,
	withTranscript,
} from "./transcript";

function fixture(language = "en"): AxcutTranscript {
	return {
		assetId: "asset_1",
		language,
		sourceDslPath: "transcript.dsl",
		sourceJsonPath: "transcript.json",
		segments: [
			{
				id: "segment_1",
				kind: "speech",
				startSec: 1,
				endSec: 4,
				text: "I use OpenScreen",
				wordIds: ["word_1", "word_2", "word_3"],
			},
			{
				id: "segment_2",
				kind: "speech",
				startSec: 5,
				endSec: 6,
				text: "Untouched segment",
				wordIds: ["word_4", "word_5"],
			},
		],
		// Deliberately shuffled: segment.wordIds, not this array, defines segment order.
		words: [
			{ id: "word_3", segmentId: "segment_1", startSec: 3, endSec: 4, text: "OpenScreen" },
			{ id: "word_1", segmentId: "segment_1", startSec: 1, endSec: 2, text: "I" },
			{ id: "word_5", segmentId: "segment_2", startSec: 5.5, endSec: 6, text: "segment" },
			{ id: "word_2", segmentId: "segment_1", startSec: 2, endSec: 3, text: "use" },
			{ id: "word_4", segmentId: "segment_2", startSec: 5, endSec: 5.5, text: "Untouched" },
		],
	};
}

function transcriptForTokens(language: string, tokens: string[]): AxcutTranscript {
	const wordIds = tokens.map((_, index) => `word_${index + 1}`);
	return {
		assetId: "asset_tokens",
		language,
		segments: [
			{
				id: "segment_tokens",
				kind: "speech",
				startSec: 0,
				endSec: tokens.length,
				text: tokens.join(" "),
				wordIds,
			},
			{
				id: "segment_other",
				kind: "speech",
				startSec: 20,
				endSec: 21,
				text: "other",
				wordIds: ["word_other"],
			},
		],
		words: [
			...tokens.map((text, index) => ({
				id: wordIds[index],
				segmentId: "segment_tokens",
				startSec: index,
				endSec: index + 1,
				text,
			})),
			{
				id: "word_other",
				segmentId: "segment_other",
				startSec: 20,
				endSec: 21,
				text: "other",
			},
		],
	};
}

describe("setWordText", () => {
	it("immutably updates the exact word and rebuilds only its owning segment", () => {
		const transcript = fixture();
		const originalSnapshot = structuredClone(transcript);
		const originalTarget = transcript.words.find((word) => word.id === "word_2");
		const originalOtherWord = transcript.words.find((word) => word.id === "word_4");
		const originalOtherSegment = transcript.segments[1];

		const result = setWordText(transcript, "word_2", "prefer");

		expect(result).not.toBe(transcript);
		expect(result.words.map((word) => word.id)).toEqual(transcript.words.map((word) => word.id));
		expect(result.segments.map((segment) => segment.id)).toEqual(
			transcript.segments.map((segment) => segment.id),
		);
		// The provenance pair rides along with the new text — see "setWordText
		// provenance" below for the rules it follows.
		expect(result.words.find((word) => word.id === "word_2")).toEqual({
			...originalTarget,
			text: "prefer",
			originalText: "use",
			source: "user",
		});
		expect(result.segments[0]).toEqual({
			...transcript.segments[0],
			text: "I prefer OpenScreen",
		});
		for (const originalWord of transcript.words) {
			if (originalWord.id !== "word_2") {
				expect(result.words.find((word) => word.id === originalWord.id)).toBe(originalWord);
			}
		}
		expect(result.words.find((word) => word.id === "word_4")).toBe(originalOtherWord);
		expect(result.segments[1]).toBe(originalOtherSegment);
		expect(result.assetId).toBe("asset_1");
		expect(result.language).toBe("en");
		expect(result.sourceDslPath).toBe("transcript.dsl");
		expect(result.sourceJsonPath).toBe("transcript.json");
		expect(transcript).toEqual(originalSnapshot);
	});

	it("uses segment.wordIds order even when transcript.words is shuffled", () => {
		const result = setWordText(fixture(), "word_3", "Studio");

		expect(result.segments[0].text).toBe("I use Studio");
		expect(result.words.map((word) => word.id)).toEqual([
			"word_3",
			"word_1",
			"word_5",
			"word_2",
			"word_4",
		]);
	});

	it("joins English words with one space", () => {
		const result = setWordText(
			transcriptForTokens("en", ["I", "use", "OpenScreen"]),
			"word_2",
			"prefer",
		);

		expect(result.segments[0].text).toBe("I prefer OpenScreen");
	});

	it("preserves the passed word text exactly while trimming its segment contribution", () => {
		const result = setWordText(fixture(), "word_2", "  prefer  ");

		expect(result.words.find((word) => word.id === "word_2")?.text).toBe("  prefer  ");
		expect(result.segments[0].text).toBe("I prefer OpenScreen");
	});

	it.each([
		"zh",
		"zh-CN",
		"zh-TW",
		"ZH-cn",
		"auto",
		"yue",
	])("does not add artificial spaces between adjacent Chinese content for %s", (language) => {
		const result = setWordText(transcriptForTokens(language, ["你", "好", "世界"]), "word_2", "们");

		expect(result.segments[0].text).toBe("你们世界");
	});

	it("does not add a space after a non-BMP Han word (edge read by code point)", () => {
		const result = setWordText(transcriptForTokens("zh", ["\u{20000}", "好"]), "word_2", "世界");

		expect(result.segments[0].text).toBe("\u{20000}世界");
	});

	it("does not add a space before a token starting with a non-BMP Han character", () => {
		const result = setWordText(
			transcriptForTokens("zh", ["好", "\u{20000}"]),
			"word_2",
			"\u{20000}",
		);

		expect(result.segments[0].text).toBe("好\u{20000}");
	});

	it.each([
		"ja",
		"ja-JP",
		"JA-jp",
	])("does not add artificial spaces between adjacent Japanese content for %s", (language) => {
		const result = setWordText(
			transcriptForTokens(language, ["私", "は", "テスト", "です"]),
			"word_3",
			"開発者",
		);

		expect(result.segments[0].text).toBe("私は開発者です");
	});

	it("does not add a space after Chinese closing punctuation between CJK tokens", () => {
		const result = setWordText(transcriptForTokens("zh-CN", ["你好，", "世"]), "word_2", "世界");

		expect(result.segments[0].text).toBe("你好，世界");
	});

	it("does not add a space after Japanese closing punctuation between CJK tokens", () => {
		const result = setWordText(
			transcriptForTokens("ja-JP", ["これは。", "試験"]),
			"word_2",
			"テスト",
		);

		expect(result.segments[0].text).toBe("これは。テスト");
	});

	it("keeps readable boundaries in mixed CJK and Latin content", () => {
		const result = setWordText(
			transcriptForTokens("zh-CN", ["我们用", "GitHub", "Action", "部署"]),
			"word_3",
			"Actions",
		);

		expect(result.segments[0].text).toBe("我们用 GitHub Actions 部署");
	});

	it("does not put spaces before common closing punctuation", () => {
		const result = setWordText(
			transcriptForTokens("en", ["Hello", ",", "world", "?"]),
			"word_4",
			"!",
		);

		expect(result.segments[0].text).toBe("Hello, world!");
	});

	it("does not put spaces immediately after common opening punctuation", () => {
		const result = setWordText(transcriptForTokens("en", ["(", "hello", ")"]), "word_2", "world");

		expect(result.segments[0].text).toBe("(world)");
	});

	it.each([
		{ tokens: ["I", "use", "OpenScreen"], targetId: "word_2", expected: "I OpenScreen" },
		{ tokens: ["I", "use", "OpenScreen"], targetId: "word_1", expected: "use OpenScreen" },
		{ tokens: ["I", "use", "OpenScreen"], targetId: "word_3", expected: "I use" },
	])("keeps the emptied word but creates no duplicate or edge whitespace", ({
		tokens,
		targetId,
		expected,
	}) => {
		const result = setWordText(transcriptForTokens("en", tokens), targetId, "");

		expect(result.words.find((word) => word.id === targetId)?.text).toBe("");
		expect(result.segments[0].text).toBe(expected);
	});

	it.each(["missing_word", "silence_1"])("rejects non-document word ID %s", (wordId) => {
		expect(() => setWordText(fixture(), wordId, "replacement")).toThrowError(wordId);
	});

	it("rejects a target whose owning segment is missing", () => {
		const transcript = fixture();
		const target = transcript.words.find((word) => word.id === "word_2");
		if (!target) throw new Error("fixture target missing");
		target.segmentId = "segment_missing";

		expect(() => setWordText(transcript, "word_2", "replacement")).toThrowError(
			/word_2.*segment_missing|segment_missing.*word_2/,
		);
	});

	it("rejects an owning segment that references a missing word", () => {
		const transcript = fixture();
		transcript.segments[0].wordIds.splice(1, 0, "word_missing");

		expect(() => setWordText(transcript, "word_2", "replacement")).toThrowError(
			/segment_1.*word_missing|word_missing.*segment_1/,
		);
	});

	it("rejects an owning segment that references a word owned by another segment", () => {
		const transcript = fixture();
		transcript.segments[0].wordIds.push("word_4");

		expect(() => setWordText(transcript, "word_2", "replacement")).toThrowError(
			/segment_1.*word_4.*segment_2/,
		);
	});

	it("rejects an owning segment that omits the target word", () => {
		const transcript = fixture();
		transcript.segments[0].wordIds = ["word_1", "word_3"];

		expect(() => setWordText(transcript, "word_2", "replacement")).toThrowError(
			/segment_1.*word_2|word_2.*segment_1/,
		);
	});
});

// ─── Provenance ──────────────────────────────────────────────────
// Every field below is what makes a correction survivable: revertible by the
// user, and carryable across a re-transcription. Without them a corrected word
// is indistinguishable from a transcribed one the moment it is written.

describe("setWordText provenance", () => {
	it("records the transcriber's text the first time a word is rewritten", () => {
		const word = setWordText(fixture(), "word_3", "OpenScreenApp").words.find(
			(w) => w.id === "word_3",
		);
		expect(word).toMatchObject({
			text: "OpenScreenApp",
			originalText: "OpenScreen",
			source: "user",
		});
	});

	it("keeps the FIRST original across later edits, so revert reaches the transcriber's text", () => {
		const once = setWordText(fixture(), "word_3", "OpenScreenApp");
		const twice = setWordText(once, "word_3", "OpenScreen Studio");
		expect(twice.words.find((w) => w.id === "word_3")).toMatchObject({
			text: "OpenScreen Studio",
			originalText: "OpenScreen",
		});
	});

	it("clears the markers when the original is typed back — that round trip IS the revert", () => {
		const edited = setWordText(fixture(), "word_3", "OpenScreenApp");
		const reverted = setWordText(edited, "word_3", "OpenScreen");
		const word = reverted.words.find((w) => w.id === "word_3");
		expect(word?.text).toBe("OpenScreen");
		expect(word).not.toHaveProperty("originalText");
		expect(word).not.toHaveProperty("source");
	});

	it("leaves a synthesized word synthesized — it has no transcribed text to revert to", () => {
		const base = fixture();
		const synth: AxcutTranscript = {
			...base,
			words: base.words.map((w) =>
				w.id === "word_3" ? { ...w, source: "synth" as const, text: "spoken" } : w,
			),
		};
		const word = setWordText(synth, "word_3", "rewritten").words.find((w) => w.id === "word_3");
		expect(word).toMatchObject({ text: "rewritten", source: "synth" });
		expect(word).not.toHaveProperty("originalText");
	});

	it("does not mark the untouched words", () => {
		const result = setWordText(fixture(), "word_3", "OpenScreenApp");
		for (const word of result.words.filter((w) => w.id !== "word_3")) {
			expect(word).not.toHaveProperty("source");
		}
	});
});

// ─── Document-level write ────────────────────────────────────────
// The document carries the transcript twice. A word edit that writes only one
// copy leaves the legacy mirror serving pre-edit text forever — the failure that
// closed the standalone Python editor (#469).

function makeDoc(primaryAssetId = "asset_1") {
	const base = createEmptyDocument({ title: "Test", projectId: "proj_transcript" });
	return withTranscript({ ...base, project: { ...base.project, primaryAssetId } }, fixture());
}

describe("setDocumentWordText", () => {
	it("writes BOTH the per-asset transcript and the legacy mirror", () => {
		const result = setDocumentWordText(makeDoc(), "asset_1", "word_3", "OpenScreenApp");
		const stored = result.transcripts.find((t) => t.assetId === "asset_1");
		expect(stored?.words.find((w) => w.id === "word_3")?.text).toBe("OpenScreenApp");
		expect(result.transcript?.words.find((w) => w.id === "word_3")?.text).toBe("OpenScreenApp");
		expect(result.transcript).toBe(stored);
	});

	it("leaves the mirror alone when the edited asset is not the primary one", () => {
		const doc = makeDoc("asset_other");
		const result = setDocumentWordText(doc, "asset_1", "word_3", "OpenScreenApp");
		expect(result.transcript).toBe(doc.transcript);
		expect(result.transcripts.find((t) => t.assetId === "asset_1")?.words).not.toBe(
			doc.transcripts.find((t) => t.assetId === "asset_1")?.words,
		);
	});

	it("rejects an asset with no transcript rather than writing a second one", () => {
		expect(() => setDocumentWordText(makeDoc(), "asset_missing", "word_3", "x")).toThrow(
			/no transcript/,
		);
	});

	it("keeps the input document untouched", () => {
		const doc = makeDoc();
		const before = JSON.stringify(doc);
		setDocumentWordText(doc, "asset_1", "word_3", "OpenScreenApp");
		expect(JSON.stringify(doc)).toBe(before);
	});
});

// ─── Carry-over across a re-transcription ────────────────────────

function retranscribed(words: Array<[string, string, number, number]>): AxcutTranscript {
	return {
		assetId: "asset_1",
		language: "en",
		segments: [
			{
				id: "segment_1",
				kind: "speech",
				startSec: words[0][2],
				endSec: words[words.length - 1][3],
				text: words.map(([, text]) => text).join(" "),
				wordIds: words.map(([id]) => id),
			},
		],
		words: words.map(([id, text, startSec, endSec]) => ({
			id,
			segmentId: "segment_1",
			startSec,
			endSec,
			text,
		})),
	};
}

describe("carryOverWordEdits", () => {
	const corrected = () => setWordText(fixture(), "word_3", "OpenScreenApp");

	it("re-applies a correction when the run repeats the same mistake at the same moment", () => {
		const next = retranscribed([
			["w1", "I", 1, 2],
			["w2", "use", 2, 3],
			["w3", "OpenScreen", 3.1, 3.9],
		]);
		const result = carryOverWordEdits(corrected(), next);
		expect(result.carried).toBe(1);
		expect(result.dropped).toBe(0);
		expect(result.transcript.words.find((w) => w.id === "w3")).toMatchObject({
			text: "OpenScreenApp",
			originalText: "OpenScreen",
			source: "user",
		});
		// The segment text is rebuilt too, so the captions follow.
		expect(result.transcript.segments[0].text).toBe("I use OpenScreenApp");
	});

	it("drops the correction when the run heard something else there", () => {
		const next = retranscribed([["w3", "Open Screen", 3, 4]]);
		const result = carryOverWordEdits(corrected(), next);
		expect(result).toMatchObject({ carried: 0, dropped: 1 });
		expect(result.transcript).toBe(next);
	});

	it("drops the correction when the same word lands somewhere else entirely", () => {
		const next = retranscribed([["w3", "OpenScreen", 40, 41]]);
		expect(carryOverWordEdits(corrected(), next)).toMatchObject({ carried: 0, dropped: 1 });
	});

	it("never lands two corrections on the same new word", () => {
		// Both corrections have the SAME original text and both spans overlap the one
		// word the new run produced. Without the claim, the second would overwrite the
		// first and the count would claim two were saved.
		const previous = setWordText(
			setWordText(
				retranscribed([
					["p1", "the", 1, 2],
					["p2", "the", 2, 3],
				]),
				"p1",
				"a",
			),
			"p2",
			"an",
		);
		const result = carryOverWordEdits(previous, retranscribed([["w1", "the", 1, 3]]));
		expect(result).toMatchObject({ carried: 1, dropped: 1 });
		expect(result.transcript.words[0].text).toBe("a");
	});

	it("returns the new transcript untouched when nothing was ever corrected", () => {
		const next = retranscribed([["w1", "I", 1, 2]]);
		const result = carryOverWordEdits(fixture(), next);
		expect(result.transcript).toBe(next);
		expect(result).toMatchObject({ carried: 0, dropped: 0 });
	});

	it("handles a first-ever transcription (no previous transcript)", () => {
		const next = retranscribed([["w1", "I", 1, 2]]);
		expect(carryOverWordEdits(null, next).transcript).toBe(next);
	});
});

// ─── Inserting a word nobody said ────────────────────────────────
// The word carries no audio, so what it may occupy is the silence around it and nothing
// else. These pin that boundary: never over a spoken word, never a duration invented out
// of nothing when there is no pause to take.

describe("insertWord", () => {
	// "I"(1–2) "use"(2–3) "OpenScreen"(3–4), then a gap, then segment 2 at 5.
	it("takes the silence after the word it follows, up to what its text needs", () => {
		const result = insertWord(fixture(), "word_3", "after", "everywhere");
		const inserted = result.words.find((w) => w.source === "synth");
		expect(inserted?.startSec).toBe(4);
		// 10 characters at 15/s = 0.67s, and the next word is a full second away.
		expect(inserted?.endSec).toBeCloseTo(4 + 10 / 15, 5);
	});

	it("never runs over the word that comes next", () => {
		// "use" ends at 3 and "OpenScreen" starts there: a long word gets no room at all.
		const inserted = insertWord(fixture(), "word_2", "after", "a very long addition").words.find(
			(w) => w.source === "synth",
		);
		expect(inserted).toMatchObject({ startSec: 3, endSec: 3 });
	});

	it("borrows backwards when it goes before the first word", () => {
		const inserted = insertWord(fixture(), "word_1", "before", "Well").words.find(
			(w) => w.source === "synth",
		);
		// "word_1" starts at 1, and nothing precedes it — the floor is the media's own start.
		expect(inserted?.endSec).toBe(1);
		expect(inserted?.startSec).toBeCloseTo(1 - 0.4, 5);
	});

	it("marks it synthesized, with an id no transcription run can reuse", () => {
		const inserted = insertWord(fixture(), "word_3", "after", "indeed").words.find(
			(w) => w.source === "synth",
		);
		expect(inserted).toMatchObject({ text: "indeed", source: "synth", segmentId: "segment_1" });
		expect(inserted?.id).toMatch(/^synth_\d+$/);
		expect(inserted).not.toHaveProperty("originalText");
	});

	it("numbers past the inserts already there", () => {
		const once = insertWord(fixture(), "word_3", "after", "one");
		const twice = insertWord(once, "word_3", "after", "two");
		const ids = twice.words.filter((w) => w.source === "synth").map((w) => w.id);
		expect(new Set(ids).size).toBe(2);
		expect(ids).toContain("synth_2");
	});

	it("lands in the segment's reading order, and rebuilds its text", () => {
		const transcript = fixture();
		const result = insertWord(transcript, "word_2", "after", "really");
		const segment = result.segments.find((seg) => seg.id === "segment_1");
		expect(segment?.wordIds).toEqual(["word_1", "word_2", "synth_1", "word_3"]);
		expect(segment?.text).toBe("I use really OpenScreen");
		// The segment the insert did not land in is carried over untouched, not rebuilt.
		expect(result.segments[1]).toBe(transcript.segments[1]);
	});

	it("sits beside its anchor in the words array, which is what orders a zero-length insert", () => {
		const result = insertWord(fixture(), "word_2", "after", "really");
		const ids = result.words.map((w) => w.id);
		expect(ids.indexOf("synth_1")).toBe(ids.indexOf("word_2") + 1);
	});

	it("refuses empty text and unknown anchors", () => {
		expect(() => insertWord(fixture(), "word_2", "after", "   ")).toThrow(/empty/);
		expect(() => insertWord(fixture(), "nope", "after", "x")).toThrow(/missing/);
	});

	it("keeps the input transcript untouched", () => {
		const transcript = fixture();
		const before = JSON.stringify(transcript);
		insertWord(transcript, "word_2", "after", "really");
		expect(JSON.stringify(transcript)).toBe(before);
	});
});

describe("removeWord", () => {
	const withInsert = () => insertWord(fixture(), "word_2", "after", "really");

	it("takes the word out of the array, the segment, and its text", () => {
		const result = removeWord(withInsert(), "synth_1");
		expect(result.words.some((w) => w.id === "synth_1")).toBe(false);
		const segment = result.segments.find((seg) => seg.id === "segment_1");
		expect(segment?.wordIds).toEqual(["word_1", "word_2", "word_3"]);
		expect(segment?.text).toBe("I use OpenScreen");
	});

	// Deleting a transcribed word would leave the film saying something the transcript
	// denies. The operation for making a spoken word go away is a trim.
	it("refuses a word that was actually spoken", () => {
		expect(() => removeWord(fixture(), "word_2")).toThrow(/Refusing to remove transcribed word/);
	});

	it("refuses a word that is not there", () => {
		expect(() => removeWord(fixture(), "nope")).toThrow(/missing/);
	});
});

describe("insertDocumentWord / removeDocumentWords", () => {
	it("writes both the per-asset transcript and the legacy mirror", () => {
		const result = insertDocumentWord(makeDoc(), "asset_1", "word_2", "after", "really");
		expect(result.transcript?.words.some((w) => w.id === "synth_1")).toBe(true);
		expect(result.transcript).toBe(result.transcripts.find((t) => t.assetId === "asset_1"));
	});

	// One save for the whole set: a Backspace over three inserted words must be one Ctrl+Z.
	it("removes several inserted words in a single document", () => {
		let doc = insertDocumentWord(makeDoc(), "asset_1", "word_2", "after", "one");
		doc = insertDocumentWord(doc, "asset_1", "word_3", "after", "two");
		const result = removeDocumentWords(doc, "asset_1", ["synth_1", "synth_2"]);
		expect(result.transcripts[0].words.some((w) => w.source === "synth")).toBe(false);
	});

	it("rejects an asset with no transcript", () => {
		expect(() => insertDocumentWord(makeDoc(), "nope", "word_2", "after", "x")).toThrow(
			/no transcript/,
		);
	});
});

describe("carryOverWordEdits with inserted words", () => {
	const withInsert = () => insertWord(fixture(), "word_2", "after", "really");

	it("puts an insert back after whatever the new run now ends last before it", () => {
		// The insert sits at 3s. The new transcript says "I"(1–2) "used"(2–3) "it"(3.5–4).
		const next = retranscribed([
			["n1", "I", 1, 2],
			["n2", "used", 2, 3],
			["n3", "it", 3.5, 4],
		]);
		const result = carryOverWordEdits(withInsert(), next);
		expect(result).toMatchObject({ carried: 1, dropped: 0 });
		const ids = result.transcript.words.map((w) => w.id);
		expect(ids.indexOf("synth_1")).toBe(ids.indexOf("n2") + 1);
		expect(result.transcript.words.find((w) => w.id === "synth_1")).toMatchObject({
			text: "really",
			source: "synth",
		});
	});

	it("puts it at the head when the new run has nothing before it", () => {
		const carried = carryOverWordEdits(
			insertWord(fixture(), "word_1", "before", "Well"),
			retranscribed([["n1", "I", 1, 2]]),
		);
		expect(carried.carried).toBe(1);
		expect(carried.transcript.words[0].text).toBe("Well");
	});

	it("counts an insert it could not place, rather than losing it quietly", () => {
		const empty: AxcutTranscript = { assetId: "asset_1", language: "en", segments: [], words: [] };
		expect(carryOverWordEdits(withInsert(), empty)).toMatchObject({ carried: 0, dropped: 1 });
	});

	it("carries corrections and inserts together", () => {
		const both = insertWord(
			setWordText(fixture(), "word_3", "OpenScreenApp"),
			"word_2",
			"after",
			"really",
		);
		const next = retranscribed([
			["n1", "I", 1, 2],
			["n2", "use", 2, 3],
			["n3", "OpenScreen", 3, 4],
		]);
		const result = carryOverWordEdits(both, next);
		expect(result).toMatchObject({ carried: 2, dropped: 0 });
		expect(result.transcript.words.find((w) => w.id === "n3")?.text).toBe("OpenScreenApp");
		expect(result.transcript.words.some((w) => w.text === "really")).toBe(true);
	});
});

// ─── The pause an added word needs ───────────────────────────────
// Created time is STORED, as a region beside the trims. Something has to keep those
// records true against the words they belong to, and `withInsertRangesForWords` is the one
// writer — these hold it to the invariant it maintains. The first attempt at this made
// CLIPS instead, and every other writer of `timeline.clips` disagreed with them.

describe("insert ranges", () => {
	function docWithClip() {
		const doc = makeDoc();
		return {
			...doc,
			timeline: {
				...doc.timeline,
				clips: [
					{
						id: "clip_1",
						assetId: "asset_1",
						sourceStartSec: 0,
						sourceEndSec: 10,
						timelineStartSec: 0,
						timelineEndSec: 10,
						wordRefs: [],
						origin: "user" as const,
						reason: "",
					},
				],
			},
		};
	}

	it("stores a pause when the free silence does not cover the word", () => {
		// "really" after word_2: word_3 starts exactly where word_2 ends, so the word
		// borrows nothing and needs its whole reading time — max(0.4, 6/15) = 0.4s.
		const result = insertDocumentWord(docWithClip(), "asset_1", "word_2", "after", "really");
		expect(result.timeline.insertRanges).toHaveLength(1);
		expect(result.timeline.insertRanges[0]).toMatchObject({
			assetId: "asset_1",
			wordId: "synth_1",
			atSec: 3,
			durationSec: 0.4,
			origin: "user",
		});
		expect(insertRangesMatchWords(result)).toBe(true);
	});

	// The reason is user-visible on the region, and the two lanes do not hold the same
	// thing: the film holds a FRAME, a take holds silence and no picture is involved
	// (issue #560). The keying above is lane-agnostic and stays that way — one row per
	// word per asset, whichever lane the asset is on.
	it("names what is actually held, per lane", () => {
		const film = insertDocumentWord(docWithClip(), "asset_1", "word_2", "after", "really");
		expect(film.timeline.insertRanges[0].reason).toContain("Held frame");

		// `createEmptyDocument` carries no assets, so the lane has to be given one to read.
		const base = docWithClip();
		const take = insertDocumentWord(
			{
				...base,
				assets: [
					{
						id: "asset_1",
						kind: "audio" as const,
						label: "take.mp3",
						originalPath: "/take.mp3",
						durationSec: 30,
						cameraTrack: null,
					},
				],
			},
			"asset_1",
			"word_2",
			"after",
			"really",
		);
		expect(take.timeline.insertRanges[0].reason).toContain("Silence");
		expect(take.timeline.insertRanges[0].reason).not.toContain("frame");
		// Same row otherwise, and the invariant still holds on an audio asset.
		expect(take.timeline.insertRanges[0]).toMatchObject({ atSec: 3, durationSec: 0.4 });
		expect(insertRangesMatchWords(take)).toBe(true);
	});

	// An insertion is MEDIA inside the clip, so the clip carrying it is exactly that much
	// longer — the one fact every reader downstream depends on, and the reason none of them
	// needs a second ruler to convert to. Its source window is untouched: no frame of the
	// recording was added or removed.
	it("lengthens the clip that carries the insertion, by the insertion", () => {
		const before = docWithClip();
		const result = insertDocumentWord(before, "asset_1", "word_2", "after", "really");
		const [range] = result.timeline.insertRanges;
		const was = before.timeline.clips[0];
		const now = result.timeline.clips[0];
		expect(now.timelineEndSec - now.timelineStartSec).toBeCloseTo(
			was.timelineEndSec - was.timelineStartSec + range.durationSec,
			5,
		);
		expect(now.sourceStartSec).toBe(was.sourceStartSec);
		expect(now.sourceEndSec).toBe(was.sourceEndSec);
	});

	it("gives the length back when the word goes", () => {
		const before = docWithClip();
		const added = insertDocumentWord(before, "asset_1", "word_2", "after", "really");
		const removed = removeDocumentWords(added, "asset_1", ["synth_1"]);
		expect(removed.timeline.clips).toEqual(before.timeline.clips);
	});

	it("stores nothing when the word fits in silence that is already there", () => {
		// word_3 ends at 4 and word_4 starts at 5: a full second, more than "really" needs.
		const result = insertDocumentWord(docWithClip(), "asset_1", "word_3", "after", "really");
		expect(result.timeline.insertRanges).toEqual([]);
		expect(insertRangesMatchWords(result)).toBe(true);
	});

	it("resizes the pause when the word is rewritten longer", () => {
		const added = insertDocumentWord(docWithClip(), "asset_1", "word_2", "after", "really");
		const longer = setDocumentWordText(added, "asset_1", "synth_1", "really quite genuinely so");
		const [range] = longer.timeline.insertRanges;
		expect(range.durationSec).toBeCloseTo(25 / 15, 5);
		expect(range.id).toBe(added.timeline.insertRanges[0].id);
		expect(insertRangesMatchWords(longer)).toBe(true);
	});

	it("drops the pause with the word", () => {
		const added = insertDocumentWord(docWithClip(), "asset_1", "word_2", "after", "really");
		const gone = removeDocumentWords(added, "asset_1", ["synth_1"]);
		expect(gone.timeline.insertRanges).toEqual([]);
		expect(insertRangesMatchWords(gone)).toBe(true);
	});

	it("keeps one pause per added word, and no more", () => {
		let doc = insertDocumentWord(docWithClip(), "asset_1", "word_2", "after", "really");
		doc = insertDocumentWord(doc, "asset_1", "word_1", "after", "personally");
		expect(doc.timeline.insertRanges).toHaveLength(2);
		expect(new Set(doc.timeline.insertRanges.map((r) => r.wordId)).size).toBe(2);
		expect(insertRangesMatchWords(doc)).toBe(true);
	});

	// Correcting a SPOKEN word must not invent a pause: it has audio behind it already.
	it("stores nothing for an ordinary correction", () => {
		const result = setDocumentWordText(docWithClip(), "asset_1", "word_3", "OpenScreenApp");
		expect(result.timeline.insertRanges).toEqual([]);
	});

	it("survives the document schema", () => {
		const added = insertDocumentWord(docWithClip(), "asset_1", "word_2", "after", "really");
		const parsed = documentSchema.parse(JSON.parse(JSON.stringify(added)));
		expect(parsed.timeline.insertRanges).toHaveLength(1);
		expect(insertRangesMatchWords(parsed)).toBe(true);
	});
});
