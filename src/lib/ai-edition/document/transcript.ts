import type { AxcutTranscript } from "../schema";

const CJK_EDGE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const CLOSING_PUNCTUATION = /^[,.;:!?%。，、；：！？…）)\]}>》」』】〕]/u;
const TRAILING_CLOSING_PUNCTUATION = /[,.;:!?%。，、；：！？…）)\]}>》」』】〕]+$/u;
const OPENING_PUNCTUATION = /[([<{《「『【〔（]$/u;

function joinSegmentText(language: string, texts: string[]): string {
	const tokens = texts.map((text) => text.trim()).filter((text) => text.length > 0);
	const primaryLanguage = language.split("-")[0].toLowerCase();
	const compactCjk = primaryLanguage === "zh" || primaryLanguage === "ja";

	return tokens.reduce((joined, token) => {
		if (joined.length === 0) return token;
		if (CLOSING_PUNCTUATION.test(token) || OPENING_PUNCTUATION.test(joined)) {
			return joined + token;
		}
		const leftContentEdge = joined.replace(TRAILING_CLOSING_PUNCTUATION, "").at(-1) ?? "";
		if (compactCjk && CJK_EDGE.test(leftContentEdge) && CJK_EDGE.test(token[0] ?? "")) {
			return joined + token;
		}
		return `${joined} ${token}`;
	}, "");
}

export function setWordText(
	transcript: AxcutTranscript,
	wordId: string,
	text: string,
): AxcutTranscript {
	const targetWord = transcript.words.find((word) => word.id === wordId);
	if (!targetWord) {
		throw new Error(`Cannot set text for missing transcript word "${wordId}"`);
	}

	const owningSegment = transcript.segments.find((segment) => segment.id === targetWord.segmentId);
	if (!owningSegment) {
		throw new Error(
			`Transcript word "${wordId}" references missing segment "${targetWord.segmentId}"`,
		);
	}
	if (!owningSegment.wordIds.includes(wordId)) {
		throw new Error(`Segment "${owningSegment.id}" does not reference target word "${wordId}"`);
	}

	const wordsById = new Map(transcript.words.map((word) => [word.id, word]));
	for (const referencedWordId of owningSegment.wordIds) {
		if (!wordsById.has(referencedWordId)) {
			throw new Error(
				`Segment "${owningSegment.id}" references missing word "${referencedWordId}"`,
			);
		}
	}

	const words = transcript.words.map((word) => (word.id === wordId ? { ...word, text } : word));
	const updatedWordsById = new Map(words.map((word) => [word.id, word]));
	const segmentText = joinSegmentText(
		transcript.language,
		owningSegment.wordIds.map(
			(referencedWordId) => updatedWordsById.get(referencedWordId)?.text ?? "",
		),
	);
	const segments = transcript.segments.map((segment) =>
		segment.id === owningSegment.id ? { ...segment, text: segmentText } : segment,
	);

	return { ...transcript, words, segments };
}
