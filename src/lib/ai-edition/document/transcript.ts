import type { AxcutDocument, AxcutTranscript, AxcutWord } from "../schema";
import {
	type InsertSide,
	insertGeneratedClip,
	isGeneratedAssetId,
	removeGeneratedClips,
	retextGeneratedClip,
} from "./insertion";

const CJK_EDGE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const CLOSING_PUNCTUATION = /^[,.;:!?%。，、；：！？…）)\]}>》」』】〕]/u;
const TRAILING_CLOSING_PUNCTUATION = /[,.;:!?%。，、；：！？…）)\]}>》」』】〕]+$/u;
const OPENING_PUNCTUATION = /[([<{《「『【〔（]$/u;

// The CJK-compaction rule is deliberately LANGUAGE-AGNOSTIC: two adjacent Han /
// Hiragana / Katakana characters never carry a space between them in any script
// that uses them. Gating it on the `language` tag would corrupt transcripts whose
// stored tag is "auto" (a real persisted value — see transcribe.ts's language
// fallback) or "yue": the join would inject ASCII spaces between Chinese runs.
function joinSegmentText(texts: string[]): string {
	const tokens = texts.map((text) => text.trim()).filter((text) => text.length > 0);
	return tokens.reduce((joined, token) => {
		if (joined.length === 0) return token;
		if (CLOSING_PUNCTUATION.test(token) || OPENING_PUNCTUATION.test(joined)) {
			return joined + token;
		}
		const leftContentEdge = [...joined.replace(TRAILING_CLOSING_PUNCTUATION, "")].at(-1) ?? "";
		// Spread reads the edges by CODE POINT: `.at(-1)` / `[0]` would return half a
		// surrogate pair, so a non-BMP Han edge (e.g. U+20000) would miss CJK_EDGE
		// and receive an ASCII space.
		if (CJK_EDGE.test(leftContentEdge) && CJK_EDGE.test([...token][0] ?? "")) {
			return joined + token;
		}
		return `${joined} ${token}`;
	}, "");
}

/**
 * Apply the new text to ONE word, keeping its provenance straight.
 *
 * `originalText` is the transcriber's own text, captured the first time the user
 * rewrites the word and never overwritten afterwards — a second edit still reverts
 * to what Whisper said, not to the first correction. Typing the original back
 * clears the pair, so a round trip leaves no word flagged as corrected whose
 * correction is a no-op.
 */
function rewriteWord(word: AxcutWord, text: string): AxcutWord {
	// A synthesized word has no transcribed text behind it, so there is nothing to
	// revert to and nothing to record: rewriting one leaves it synthesized.
	if (word.source === "synth") return { ...word, text };
	const original = word.originalText ?? word.text;
	if (text === original) {
		const { originalText: _reverted, source: _wasUser, ...rest } = word;
		return { ...rest, text };
	}
	return { ...word, text, originalText: original, source: "user" };
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

	const words = transcript.words.map((word) =>
		word.id === wordId ? rewriteWord(word, text) : word,
	);
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

/**
 * Write a transcript into the document — the ONLY safe way to do it.
 *
 * The document carries the same transcript twice: the per-asset `transcripts[]`
 * entry, and the legacy `transcript` mirror that a couple of readers still fall
 * back to. Writing one without the other leaves two divergent copies on disk,
 * where the mirror keeps serving the pre-edit text forever. Nothing outside this
 * function may assemble that pair.
 *
 * Lives here rather than in `transcribe.ts` (which re-exports it for its existing
 * importers): it is a pure document operation, and the Whisper adapter is not the
 * place a caller should have to look for it.
 */
export function withTranscript(
	document: AxcutDocument,
	transcript: AxcutTranscript,
): AxcutDocument {
	const transcripts = [
		...document.transcripts.filter((t) => t.assetId !== transcript.assetId),
		transcript,
	];
	return {
		...document,
		transcript:
			document.project.primaryAssetId === transcript.assetId ? transcript : document.transcript,
		transcripts,
	};
}

/**
 * {@link setWordText}, addressed the way the UI has it: an asset and a word, not a
 * transcript object. Goes through `withTranscript`, so a caller cannot forget the
 * legacy mirror.
 */
export function setDocumentWordText(
	document: AxcutDocument,
	assetId: string,
	wordId: string,
	text: string,
): AxcutDocument {
	// An inserted word's length IS its text, so rewriting it resizes the clip it plays on
	// and renames the file. Nothing a plain transcript write can express.
	if (isGeneratedAssetId(assetId)) return retextGeneratedClip(document, wordId, text);
	const transcript = document.transcripts.find((t) => t.assetId === assetId);
	if (!transcript) {
		throw new Error(`Cannot edit a word of asset "${assetId}": it has no transcript`);
	}
	return withTranscript(document, setWordText(transcript, wordId, text));
}

export type { InsertSide } from "./insertion";

/** Add a word nobody said. It becomes a CLIP — see `insertion.ts`, which is the whole of
 *  what an insertion is. */
export function insertDocumentWord(
	document: AxcutDocument,
	assetId: string,
	anchorWordId: string,
	side: InsertSide,
	text: string,
): AxcutDocument {
	return insertGeneratedClip(document, assetId, anchorWordId, side, text);
}

/** Delete inserted words, taking the whole set at once: a Backspace over several of them
 *  has to be ONE write, or undoing it takes as many presses as there were words.
 *
 *  `assetId` is not read. Each inserted word names its own clip and its own asset, so the
 *  set can span several of them and the caller does not have to group by section. */
export function removeDocumentWords(
	document: AxcutDocument,
	_assetId: string,
	wordIds: readonly string[],
): AxcutDocument {
	return removeGeneratedClips(document, wordIds);
}

/** What {@link carryOverWordEdits} managed to save from the previous transcript. */
export interface WordEditCarryOver {
	transcript: AxcutTranscript;
	/** Corrections and insertions re-applied to the new transcript. */
	carried: number;
	/** Edits the new transcript left no place for. These are lost. */
	dropped: number;
}

/**
 * Re-apply the user's word corrections onto a freshly transcribed transcript.
 *
 * A transcription run REPLACES the asset's transcript wholesale, so without this a
 * user who fixed twenty proper nouns and then regenerated lost all twenty, silently.
 *
 * The match is deliberately strict — same original text, overlapping span, one new
 * word per correction. A correction is carried only when the new run reproduced the
 * very same mistake at the very same moment; re-transcribing in another language
 * therefore carries nothing rather than stamping French corrections onto Spanish
 * words. What could not be carried is counted, not guessed at, so the caller can say
 * so.
 */
export function carryOverWordEdits(
	previous: AxcutTranscript | null | undefined,
	next: AxcutTranscript,
): WordEditCarryOver {
	const edits = (previous?.words ?? []).filter(
		(word) => word.source === "user" && word.originalText !== undefined,
	);
	// Insertions are not carried, and no longer need to be: each one is a CLIP of its own,
	// on its own asset, so re-transcribing this recording does not touch it. It stays exactly
	// where it sits on the ruler — which is more than the time-matching this replaces ever
	// managed.
	if (edits.length === 0) return { transcript: next, carried: 0, dropped: 0 };

	// Candidates are read from `next` throughout, never from the transcript being
	// built up: a word already rewritten by an earlier correction no longer carries
	// the text the next one matches on, and `claimed` is what stops two corrections
	// from landing on the same word.
	const claimed = new Set<string>();
	let transcript = next;
	let carried = 0;
	for (const edit of edits) {
		const match = next.words.find(
			(word) =>
				!claimed.has(word.id) &&
				word.text === edit.originalText &&
				word.endSec > edit.startSec &&
				word.startSec < edit.endSec,
		);
		if (!match) continue;
		claimed.add(match.id);
		transcript = setWordText(transcript, match.id, edit.text);
		carried += 1;
	}

	return { transcript, carried, dropped: edits.length - carried };
}
