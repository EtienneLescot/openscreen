import type { AxcutTranscript, AxcutWord } from "../schema";

const CJK_EDGE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const CLOSING_PUNCTUATION = /^[,.;:!?%。，、；：！？…）)\]}>》」』】〕]/u;
const TRAILING_CLOSING_PUNCTUATION = /[,.;:!?%。，、；：！？…）)\]}>》」』】〕]+$/u;
const OPENING_PUNCTUATION = /[([<{《「『【〔（]$/u;

// The CJK-compaction rule is deliberately LANGUAGE-AGNOSTIC: two adjacent Han /
// Hiragana / Katakana characters never carry a space between them in any script
// that uses them. Gating it on the `language` tag would corrupt transcripts whose
// stored tag is "auto" (a real persisted value — see transcribe.ts's language
// fallback) or "yue": the join would inject ASCII spaces between Chinese runs.
function separatorBefore(joined: string, token: string): "" | " " {
	if (joined.length === 0) return "";
	if (CLOSING_PUNCTUATION.test(token) || OPENING_PUNCTUATION.test(joined)) return "";
	const leftContentEdge = [...joined.replace(TRAILING_CLOSING_PUNCTUATION, "")].at(-1) ?? "";
	// Spread reads the edges by CODE POINT: `.at(-1)` / `[0]` would return half a
	// surrogate pair, so a non-BMP Han edge (e.g. U+20000) would miss CJK_EDGE
	// and receive an ASCII space.
	if (CJK_EDGE.test(leftContentEdge) && CJK_EDGE.test([...token][0] ?? "")) return "";
	return " ";
}

function joinSegmentText(texts: string[]): string {
	const tokens = texts.map((text) => text.trim()).filter((text) => text.length > 0);
	return tokens.reduce((joined, token) => joined + separatorBefore(joined, token) + token, "");
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
		const referencedWord = wordsById.get(referencedWordId);
		if (!referencedWord) {
			throw new Error(
				`Segment "${owningSegment.id}" references missing word "${referencedWordId}"`,
			);
		}
		if (referencedWord.segmentId !== owningSegment.id) {
			throw new Error(
				`Segment "${owningSegment.id}" references word "${referencedWordId}" which belongs to segment "${referencedWord.segmentId}"`,
			);
		}
	}

	const words = transcript.words.map((word) => (word.id === wordId ? { ...word, text } : word));
	const updatedWordsById = new Map(words.map((word) => [word.id, word]));
	const segmentText = joinSegmentText(
		owningSegment.wordIds.map(
			(referencedWordId) => updatedWordsById.get(referencedWordId)?.text ?? "",
		),
	);
	const segments = transcript.segments.map((segment) =>
		segment.id === owningSegment.id ? { ...segment, text: segmentText } : segment,
	);

	return { ...transcript, words, segments };
}

interface EditableWordPosition {
	wordIndex: number;
	textOffset: number;
}

/**
 * Paragraph breaks in text mode come from the recording itself: consecutive
 * rows whose timing shows a real pause (>= PARAGRAPH_BREAK_GAP_SEC apart) start
 * a new paragraph. Rows the ASR split mid-phrase (gap 0, e.g. "Personal" / "AI"
 * / "Counselor") stay joined, so those fragments reassemble into one line.
 * Breaks are a projection of timings, never persisted: editing text rewrites
 * row texts, and the next projection re-derives breaks from the same timings.
 */
const PARAGRAPH_BREAK_GAP_SEC = 0.05;
const PARAGRAPH_BREAK = "\n\n";

interface ProjectedWord {
	wordIndex: number;
	text: string;
	start: number;
	end: number;
}

function orderedTranscriptWords(transcript: AxcutTranscript, wordIds: readonly string[]) {
	const wordsById = new Map(transcript.words.map((word) => [word.id, word]));
	const seen = new Set<string>();
	return wordIds.map((wordId) => {
		if (seen.has(wordId)) {
			throw new Error(`Transcript word "${wordId}" appears more than once in the edit range`);
		}
		seen.add(wordId);
		const word = wordsById.get(wordId);
		if (!word) {
			throw new Error(`Cannot edit missing transcript word "${wordId}"`);
		}
		return word;
	});
}

function projectTranscriptWords(transcript: AxcutTranscript, wordIds: readonly string[]) {
	const words = orderedTranscriptWords(transcript, wordIds);
	const paragraphs: { rows: { wordIndex: number; text: string; separator: string }[] }[] = [];
	let previousWord: AxcutWord | null = null;
	let previousHasText = false;
	// Smallest gap in the chain of pairs whose LEFT row still carries text.
	// Empty rows (text merged elsewhere by an edit) fold their incoming gap in
	// — a pause before an emptied row is a real recording pause — but their own
	// outgoing boundary is skipped: it borders displaced text, not the audio,
	// so vacated rows neither manufacture phantom pauses ("Hello [brave world]
	// today" stays one paragraph) nor dilute the real pause that survives
	// upstream of them.
	let chainMinGap = Number.POSITIVE_INFINITY;
	for (const [wordIndex, word] of words.entries()) {
		const token = word.text.trim();
		const gap = previousWord ? word.startSec - previousWord.endSec : Number.POSITIVE_INFINITY;
		if (token) {
			if (previousWord && previousHasText) {
				chainMinGap = Math.min(chainMinGap, gap);
			}
			const lastParagraph = paragraphs.at(-1);
			if (!lastParagraph || chainMinGap >= PARAGRAPH_BREAK_GAP_SEC) {
				paragraphs.push({ rows: [{ wordIndex, text: token, separator: "" }] });
			} else {
				const paragraphText = lastParagraph.rows.map((row) => row.separator + row.text).join("");
				lastParagraph.rows.push({
					wordIndex,
					text: token,
					separator: separatorBefore(paragraphText, token),
				});
			}
			chainMinGap = Number.POSITIVE_INFINITY;
		} else if (previousWord && previousHasText) {
			chainMinGap = Math.min(chainMinGap, gap);
		}
		previousWord = word;
		previousHasText = token.length > 0;
	}

	const projected: ProjectedWord[] = [];
	let text = "";
	for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
		if (paragraphIndex > 0) text += PARAGRAPH_BREAK;
		for (const row of paragraph.rows) {
			// The separator is emitted here, into the global string, but is NOT
			// part of row.text: offsets must index the word's trimmed text, which
			// is what edits are applied against below.
			text += row.separator;
			const start = [...text].length;
			text += row.text;
			projected.push({ wordIndex: row.wordIndex, text: row.text, start, end: [...text].length });
		}
	}
	return { words, projected, text };
}

/**
 * Builds the natural plain-text projection used by transcript text mode. It uses
 * the same punctuation/CJK separators as segment.text, so Chinese stays compact
 * and mixed Latin text remains readable. Empty persisted rows contribute nothing.
 */
export function transcriptTextForWords(
	transcript: AxcutTranscript,
	wordIds: readonly string[],
): string {
	return projectTranscriptWords(transcript, wordIds).text;
}

function locateEditablePosition(
	projected: readonly ProjectedWord[],
	wordCount: number,
	offset: number,
): EditableWordPosition {
	if (projected.length === 0) return { wordIndex: 0, textOffset: 0 };
	let previous: ProjectedWord | null = null;
	for (const entry of projected) {
		if (offset < entry.start) {
			return previous
				? { wordIndex: previous.wordIndex, textOffset: [...previous.text].length }
				: { wordIndex: entry.wordIndex, textOffset: 0 };
		}
		if (offset <= entry.end) {
			return { wordIndex: entry.wordIndex, textOffset: offset - entry.start };
		}
		previous = entry;
	}
	const last = projected.at(-1);
	if (!last) return { wordIndex: Math.max(0, wordCount - 1), textOffset: 0 };
	return { wordIndex: last.wordIndex, textOffset: [...last.text].length };
}

/**
 * Replaces a code-point range in one clip's ordered real-word projection without
 * creating word rows or changing timings. For a multi-word edit, the first affected
 * row receives prefix + replacement + suffix and later affected rows are emptied.
 */
export function replaceTranscriptTextRange(
	transcript: AxcutTranscript,
	wordIds: readonly string[],
	startOffset: number,
	endOffset: number,
	replacement: string,
): AxcutTranscript {
	const projection = projectTranscriptWords(transcript, wordIds);
	const { words } = projection;
	if (words.length === 0) {
		throw new Error("Cannot edit an empty transcript word range");
	}
	const textLength = [...projection.text].length;
	if (
		!Number.isInteger(startOffset) ||
		!Number.isInteger(endOffset) ||
		startOffset < 0 ||
		endOffset < startOffset ||
		endOffset > textLength
	) {
		throw new Error(`Invalid transcript text range ${startOffset}-${endOffset}`);
	}

	const start = locateEditablePosition(projection.projected, words.length, startOffset);
	const end = locateEditablePosition(projection.projected, words.length, endOffset);
	const firstText = [...words[start.wordIndex].text.trim()];
	const lastText = [...words[end.wordIndex].text.trim()];
	const normalizedReplacement = replacement.replace(/[\r\n]+/g, " ");
	const mergedText =
		firstText.slice(0, start.textOffset).join("") +
		normalizedReplacement +
		lastText.slice(end.textOffset).join("");

	let result = setWordText(transcript, words[start.wordIndex].id, mergedText);
	for (let index = start.wordIndex + 1; index <= end.wordIndex; index += 1) {
		result = setWordText(result, words[index].id, "");
	}
	return result;
}

/** Applies a final plain-text value by deriving its smallest code-point edit. */
export function replaceTranscriptText(
	transcript: AxcutTranscript,
	wordIds: readonly string[],
	text: string,
): AxcutTranscript {
	// The projection emits "\n\n" paragraph breaks from word timings, and the
	// editor hands the text back with those breaks intact. Canonicalize incoming
	// newlines to the same convention — lone breaks become spaces, "\n\n" runs
	// survive — so the diff below runs in projection coordinates and untouched
	// break characters match one-for-one in the common prefix/suffix. Anything a
	// break slips into the replacement, replaceTranscriptTextRange flattens back
	// to a space: rows are stored single-line and the next projection re-derives
	// the visible breaks from the same timings.
	const normalizedText = text.replace(/\r\n?/g, "\n").replace(/(?<!\n)\n(?!\n)/g, " ");
	const current = transcriptTextForWords(transcript, wordIds);
	if (current === normalizedText) return transcript;
	const before = [...current];
	const after = [...normalizedText];
	let prefixLength = 0;
	while (prefixLength < before.length && before[prefixLength] === after[prefixLength]) {
		prefixLength += 1;
	}
	let suffixLength = 0;
	while (
		suffixLength < before.length - prefixLength &&
		suffixLength < after.length - prefixLength &&
		before[before.length - 1 - suffixLength] === after[after.length - 1 - suffixLength]
	) {
		suffixLength += 1;
	}

	return replaceTranscriptTextRange(
		transcript,
		wordIds,
		prefixLength,
		before.length - suffixLength,
		after.slice(prefixLength, after.length - suffixLength).join(""),
	);
}
