import { describe, expect, it } from "vitest";
import type { AxcutTranscript } from "../schema";
import { setWordText } from "./transcript";

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
	])("does not add artificial spaces between adjacent Chinese content for %s", (language) => {
		const result = setWordText(transcriptForTokens(language, ["你", "好", "世界"]), "word_2", "们");

		expect(result.segments[0].text).toBe("你们世界");
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

	it("rejects an owning segment that omits the target word", () => {
		const transcript = fixture();
		transcript.segments[0].wordIds = ["word_1", "word_3"];

		expect(() => setWordText(transcript, "word_2", "replacement")).toThrowError(
			/segment_1.*word_2|word_2.*segment_1/,
		);
	});
});
