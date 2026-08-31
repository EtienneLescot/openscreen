import { describe, expect, it } from "vitest";
import { type AxcutTranscript, createEmptyDocument } from "../schema";
import { carryOverWordEdits, setDocumentWordText, setWordText, withTranscript } from "./transcript";

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
