import { describe, expect, it } from "vitest";
import type { AxcutTranscript } from "../schema";
import {
	replaceTranscriptText,
	replaceTranscriptTextRange,
	setWordText,
	transcriptTextForWords,
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
		expect(result.words.find((word) => word.id === "word_2")).toEqual({
			...originalTarget,
			text: "prefer",
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

describe("replaceTranscriptTextRange", () => {
	it("inserts and replaces within one word", () => {
		const inserted = replaceTranscriptTextRange(
			fixture(),
			["word_1", "word_2", "word_3"],
			3,
			3,
			" really",
		);
		expect(inserted.words.find((word) => word.id === "word_2")?.text).toBe("u reallyse");
		expect(transcriptTextForWords(inserted, ["word_1", "word_2", "word_3"])).toBe(
			"I u reallyse OpenScreen",
		);

		const replaced = replaceTranscriptTextRange(
			fixture(),
			["word_1", "word_2", "word_3"],
			3,
			5,
			"sed",
		);
		expect(replaced.words.find((word) => word.id === "word_2")?.text).toBe("used");
		expect(replaced.segments[0].text).toBe("I used OpenScreen");
	});

	it.each([
		{ label: "backward", start: 1, end: 2 },
		{ label: "forward", start: 1, end: 2 },
	])("deletes one non-BMP code point $label without splitting it", ({ start, end }) => {
		const transcript = transcriptForTokens("en", ["A😀B", "tail"]);
		const result = replaceTranscriptTextRange(transcript, ["word_1", "word_2"], start, end, "");

		expect(result.words.find((word) => word.id === "word_1")?.text).toBe("AB");
		expect(transcriptTextForWords(result, ["word_1", "word_2"])).toBe("AB tail");
	});

	it("replaces across words, empties later affected rows, and leaves unaffected rows alone", () => {
		const transcript = transcriptForTokens("en", ["Hello", "brave", "world", "today"]);
		const untouched = transcript.words.find((word) => word.id === "word_4");
		const snapshot = structuredClone(transcript);
		const result = replaceTranscriptTextRange(
			transcript,
			["word_1", "word_2", "word_3", "word_4"],
			2,
			17,
			"llo",
		);

		expect(result.words.find((word) => word.id === "word_1")?.text).toBe("Hello");
		expect(result.words.find((word) => word.id === "word_2")?.text).toBe("");
		expect(result.words.find((word) => word.id === "word_3")?.text).toBe("");
		expect(result.words.find((word) => word.id === "word_4")).toBe(untouched);
		// The chain of gaps across the emptied rows is all zero (one spoken
		// phrase), so no break is manufactured: a full-sentence merge reads as
		// one line again.
		expect(transcriptTextForWords(result, ["word_1", "word_2", "word_3", "word_4"])).toBe(
			"Hello today",
		);
		expect(transcript).toEqual(snapshot);
	});

	it("attaches an insertion at a word boundary to the preceding real word", () => {
		const result = replaceTranscriptTextRange(
			transcriptForTokens("en", ["Hello", "world"]),
			["word_1", "word_2"],
			5,
			5,
			"!",
		);

		expect(result.words.find((word) => word.id === "word_1")?.text).toBe("Hello!");
		expect(result.words.find((word) => word.id === "word_2")?.text).toBe("world");
	});

	it("rebuilds every segment touched by a cross-segment replacement", () => {
		const transcript = fixture();
		// Offsets are code points into the projection starting at "use": 33 ends
		// after "segment" (the two projected break chars shift it by 2 vs flat).
		const result = replaceTranscriptTextRange(
			transcript,
			["word_2", "word_3", "word_4", "word_5"],
			1,
			33,
			"crossed",
		);

		expect(result.segments[0].text).toBe("I ucrossed");
		expect(result.segments[1].text).toBe("");
	});

	it.each(["missing_word", "silence_1"])("rejects non-document word ID %s", (wordId) => {
		expect(() => replaceTranscriptTextRange(fixture(), ["word_1", wordId], 0, 0, "x")).toThrowError(
			wordId,
		);
	});

	it("derives the minimal code-point range when replacing the full visible text", () => {
		const transcript = transcriptForTokens("en", ["one", "two", "three"]);
		const result = replaceTranscriptText(
			transcript,
			["word_1", "word_2", "word_3"],
			"one TWO three",
		);

		expect(result.words.find((word) => word.id === "word_1")?.text).toBe("one");
		expect(result.words.find((word) => word.id === "word_2")?.text).toBe("TWO");
		expect(result.words.find((word) => word.id === "word_3")?.text).toBe("three");
	});

	it("projects Chinese compactly while keeping mixed Latin boundaries readable", () => {
		const transcript = transcriptForTokens("auto", ["我", "使用", "Claude", "Code", "剪视频"]);

		expect(
			transcriptTextForWords(transcript, ["word_1", "word_2", "word_3", "word_4", "word_5"]),
		).toBe("我使用 Claude Code 剪视频");
	});

	it("replaces mixed CJK/Latin text using offsets from the natural projection", () => {
		const transcript = transcriptForTokens("zh", ["我", "使用", "克劳德扣", "剪视频"]);
		const wordIds = ["word_1", "word_2", "word_3", "word_4"];
		const result = replaceTranscriptText(transcript, wordIds, "我使用 Claude Code 剪视频");

		expect(transcriptTextForWords(result, wordIds)).toBe("我使用 Claude Code 剪视频");
		expect(result.words.find((word) => word.id === "word_1")?.text).toBe("我");
		expect(result.words.find((word) => word.id === "word_4")?.text).toBe("剪视频");
		expect(result.segments[0].text).toBe("我使用 Claude Code 剪视频");
	});

	it("normalizes pasted line breaks to spaces", () => {
		const transcript = transcriptForTokens("en", ["one", "two"]);
		const result = replaceTranscriptText(transcript, ["word_1", "word_2"], "one pasted\ntext two");

		expect(transcriptTextForWords(result, ["word_1", "word_2"])).toBe("one pasted text two");
	});
});

describe("text-mode paragraph projection", () => {
	/** Contiguous first paragraph, then a real speech pause, then a second one. */
	function paragraphFixture(): AxcutTranscript {
		return {
			assetId: "asset_para",
			language: "auto",
			segments: [
				{
					id: "segment_para",
					kind: "speech",
					startSec: 0,
					endSec: 5,
					text: "大家好世界 AA BB",
					wordIds: ["word_1", "word_2", "word_3", "word_4"],
				},
			],
			words: [
				{ id: "word_1", segmentId: "segment_para", startSec: 0, endSec: 1, text: "大家好" },
				// Gap 0 — an ASR fragment of the same phrase, reassembles inline.
				{ id: "word_2", segmentId: "segment_para", startSec: 1, endSec: 2, text: "世界" },
				// Real pause between takes — starts a new paragraph.
				{ id: "word_3", segmentId: "segment_para", startSec: 3, endSec: 4, text: "AA" },
				{ id: "word_4", segmentId: "segment_para", startSec: 4, endSec: 5, text: "BB" },
			],
		};
	}

	const paraWordIds = ["word_1", "word_2", "word_3", "word_4"];

	it("breaks paragraphs at speech pauses and reassembles gap-0 ASR fragments", () => {
		expect(transcriptTextForWords(paragraphFixture(), paraWordIds)).toBe("大家好世界\n\nAA BB");
	});

	it("maps an edit spanning the paragraph break onto the correct rows", () => {
		// "大家好世界⏎⏎AA BB" — code-point offsets 5-8: "界" is overwritten by
		// "X", the two break chars are consumed, "A" becomes " Y".
		const result = replaceTranscriptTextRange(paragraphFixture(), paraWordIds, 5, 8, "X Y");

		expect(result.words.find((word) => word.id === "word_2")?.text).toBe("世界X YA");
		expect(result.words.find((word) => word.id === "word_3")?.text).toBe("");
		expect(result.words.find((word) => word.id === "word_4")?.text).toBe("BB");
		// The break itself is never stored: the next projection re-derives it
		// from the unchanged timings.
		expect(transcriptTextForWords(result, paraWordIds)).toBe("大家好世界X YA\n\nBB");
	});

	it("replaces text with the breaks intact and leaves the other paragraph's rows alone", () => {
		const transcript = paragraphFixture();
		const snapshot = structuredClone(transcript);
		const result = replaceTranscriptText(transcript, paraWordIds, "大家好世界\n\nAA CC");

		expect(result.words.find((word) => word.id === "word_4")?.text).toBe("CC");
		expect(result.words.find((word) => word.id === "word_1")?.text).toBe(
			snapshot.words.find((word) => word.id === "word_1")?.text,
		);
		expect(transcriptTextForWords(result, paraWordIds)).toBe("大家好世界\n\nAA CC");
	});

	it("canonicalizes lone newlines to spaces but keeps \\n\\n paragraph breaks", () => {
		const transcript = paragraphFixture();

		// A lone hand-typed newline is a soft wrap: it lands as a trailing space
		// in the row before it (rows are stored single-line); the "世界" merge
		// goes to the row holding the text before the wrap point.
		const softWrap = replaceTranscriptText(transcript, paraWordIds, "大家好\n世界\n\nAA BB");
		expect(softWrap.words.find((word) => word.id === "word_1")?.text).toBe("大家好 ");
		// CRLF pastes from Windows editors collapse onto the same projection
		// unchanged — a pure no-op.
		expect(replaceTranscriptText(transcript, paraWordIds, "大家好世界\r\n\r\nAA BB")).toBe(
			transcript,
		);
	});

	it("merging across a break: the pause survives upstream and re-projects after the emptied row", () => {
		const transcript = paragraphFixture();
		const result = replaceTranscriptText(transcript, paraWordIds, "大家好世界AA BB");

		// Rows are stored single-line — the merge lands in the row before the
		// old break, the emptied row keeps its timing, nothing is lost:
		expect(result.words.find((word) => word.id === "word_2")?.text).toBe("世界AA");
		expect(result.words.find((word) => word.id === "word_3")?.text).toBe("");
		expect(result.words.find((word) => word.id === "word_4")?.text).toBe("BB");
		// The real 1s pause now sits INSIDE the merged row ("世界|AA"), which a
		// between-rows break cannot express. Known approximation: the break
		// re-projects right after the emptied row, keeping paragraph two alive
		// rather than silently absorbing it.
		expect(transcriptTextForWords(result, paraWordIds)).toBe("大家好世界AA\n\nBB");
	});
});
