import type { AxcutDocument, AxcutInsertRange, AxcutTranscript, AxcutWord } from "../schema";
import { createId } from "./ids";
import { reflowClipsForInserts } from "./timeline";

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
	const transcript = document.transcripts.find((t) => t.assetId === assetId);
	if (!transcript) {
		throw new Error(`Cannot edit a word of asset "${assetId}": it has no transcript`);
	}
	// Rewriting an added word changes how long it takes to read, so its pause is resized
	// here too — the one writer, whatever the edit was.
	return withInsertRangesForWords(
		withTranscript(document, setWordText(transcript, wordId, text)),
		assetId,
	);
}

/** Where a new word goes relative to the word the caret was resting on. */
export type InsertSide = "before" | "after";

/**
 * How long an inserted word needs to be readable on screen. Subtitle practice is roughly
 * fifteen characters a second, with a floor so a one-letter word is not a single frame.
 * It is only ever a REQUEST — `insertWord` gives the word whatever silence is actually
 * free, and no more.
 */
function readingSeconds(text: string): number {
	return Math.max(0.4, text.trim().length / 15);
}

/** `synth_N`, numbered past every id already in the transcript.
 *
 *  The prefix buys uniqueness, not meaning: a transcription run regenerates `word_N` from
 *  1, so a synthesized word holding one of those ids would be overwritten by the next run.
 *  What the word IS lives in `source`, which is what every reader checks. */
function nextSynthWordId(transcript: AxcutTranscript): string {
	let highest = 0;
	for (const word of transcript.words) {
		const match = /^synth_(\d+)$/.exec(word.id);
		if (match) highest = Math.max(highest, Number(match[1]));
	}
	return `synth_${highest + 1}`;
}

/**
 * Insert a word that no one said.
 *
 * It carries no audio, so it takes the SILENCE it is dropped into and nothing else: from
 * the word it follows up to what its text needs to be read, and never past the word that
 * comes next. Dropped between two words that run straight into each other it has no
 * duration at all and simply rides their caption line — which is where it reads correctly
 * anyway, since there is no pause on screen to fill.
 *
 * That is the whole of what an inserted word can do today: it reaches the captions and
 * stops there. When a voice can be synthesized for it, `source: "synth"` is what marks the
 * words that need speaking, and the span computed here is the slot that audio has to fit.
 */
export function insertWord(
	transcript: AxcutTranscript,
	anchorWordId: string,
	side: InsertSide,
	text: string,
): AxcutTranscript {
	const trimmed = text.trim();
	if (trimmed.length === 0) {
		throw new Error("Cannot insert an empty word");
	}
	const anchorIndex = transcript.words.findIndex((word) => word.id === anchorWordId);
	if (anchorIndex < 0) {
		throw new Error(`Cannot insert next to missing transcript word "${anchorWordId}"`);
	}
	const anchor = transcript.words[anchorIndex];
	const segment = transcript.segments.find((seg) => seg.id === anchor.segmentId);
	if (!segment) {
		throw new Error(
			`Transcript word "${anchorWordId}" references missing segment "${anchor.segmentId}"`,
		);
	}
	const anchorSlot = segment.wordIds.indexOf(anchorWordId);
	if (anchorSlot < 0) {
		throw new Error(`Segment "${segment.id}" does not reference anchor word "${anchorWordId}"`);
	}

	const wanted = readingSeconds(trimmed);
	let startSec: number;
	let endSec: number;
	if (side === "after") {
		startSec = anchor.endSec;
		// The next word IN TIME, which is not necessarily the next one in the array — the
		// array is insertion order, and only time decides what the new word may overlap.
		const nextStart = transcript.words
			.filter((word) => word.startSec >= startSec && word.id !== anchorWordId)
			.reduce<number | null>(
				(soonest, word) => (soonest === null ? word.startSec : Math.min(soonest, word.startSec)),
				null,
			);
		endSec = nextStart === null ? startSec + wanted : Math.min(startSec + wanted, nextStart);
	} else {
		endSec = anchor.startSec;
		const previousEnd = transcript.words
			.filter((word) => word.endSec <= endSec && word.id !== anchorWordId)
			.reduce<number | null>(
				(latest, word) => (latest === null ? word.endSec : Math.max(latest, word.endSec)),
				null,
			);
		const floor = previousEnd === null ? 0 : previousEnd;
		startSec = Math.max(floor, endSec - wanted);
	}

	const inserted: AxcutWord = {
		id: nextSynthWordId(transcript),
		segmentId: segment.id,
		startSec,
		endSec: Math.max(startSec, endSec),
		text: trimmed,
		source: "synth",
	};

	// Position in `words` matters as well as the timings: a zero-length insert shares its
	// start with the word it sits against, and the reading order of that tie is the array
	// order (see `withSilenceGaps`).
	const at = side === "after" ? anchorIndex + 1 : anchorIndex;
	const words = [...transcript.words.slice(0, at), inserted, ...transcript.words.slice(at)];
	const slot = side === "after" ? anchorSlot + 1 : anchorSlot;
	const wordIds = [...segment.wordIds.slice(0, slot), inserted.id, ...segment.wordIds.slice(slot)];
	const byId = new Map(words.map((word) => [word.id, word]));
	const segmentText = joinSegmentText(wordIds.map((id) => byId.get(id)?.text ?? ""));

	return {
		...transcript,
		words,
		segments: transcript.segments.map((seg) =>
			seg.id === segment.id ? { ...seg, wordIds, text: segmentText } : seg,
		),
	};
}

/**
 * Delete an inserted word.
 *
 * Only a synthesized one: a transcribed word is the label on a piece of audio, and the
 * operation for making that go away is a trim, which removes the sound with it. Deleting
 * the label alone would leave the film saying a word the transcript denies.
 */
export function removeWord(transcript: AxcutTranscript, wordId: string): AxcutTranscript {
	const target = transcript.words.find((word) => word.id === wordId);
	if (!target) {
		throw new Error(`Cannot remove missing transcript word "${wordId}"`);
	}
	if (target.source !== "synth") {
		throw new Error(
			`Refusing to remove transcribed word "${wordId}": cut it with a trim, or blank its text`,
		);
	}
	const words = transcript.words.filter((word) => word.id !== wordId);
	const byId = new Map(words.map((word) => [word.id, word]));
	return {
		...transcript,
		words,
		segments: transcript.segments.map((segment) => {
			if (!segment.wordIds.includes(wordId)) return segment;
			const wordIds = segment.wordIds.filter((id) => id !== wordId);
			return {
				...segment,
				wordIds,
				text: joinSegmentText(wordIds.map((id) => byId.get(id)?.text ?? "")),
			};
		}),
	};
}

/**
 * How much created time an added word still needs, on top of the silence it borrowed.
 *
 * Zero when the pause it landed in was already long enough — an added word between two
 * sentences costs the film nothing.
 */
function pauseDeficitSec(word: AxcutWord): number {
	const borrowed = word.endSec - word.startSec;
	return Math.max(0, readingSeconds(word.text) - borrowed);
}

/** Below this, a pause is not worth a record — a few milliseconds of held frame is a
 *  stutter, not a slot to speak in. */
const MIN_PAUSE_SEC = 0.05;

/**
 * Bring the document's insert ranges back in line with its words.
 *
 * The ranges are STORED, so something has to keep them true; this is that something, and
 * it is the only writer. Called after every word write, it adds the pause an added word
 * needs, resizes one whose text changed length, and drops the ones whose word is gone —
 * so no caller has to remember any of the three. `insertRangesMatchWords` is the same rule
 * read back, for a test to hold this to.
 */
function withInsertRangesForWords(document: AxcutDocument, assetId: string): AxcutDocument {
	// The reason is user-visible on the region, and it is not the same fact on both lanes:
	// the film holds a FRAME, a take holds nothing but silence — no picture is involved
	// (issue #560). Keying, below, stays lane-agnostic: one row per word per asset.
	const isTake = document.assets.find((a) => a.id === assetId)?.kind === "audio";
	const transcript = document.transcripts.find((t) => t.assetId === assetId);
	const words = transcript?.words ?? [];
	const wanted = new Map<string, number>();
	for (const word of words) {
		if (word.source !== "synth") continue;
		const deficit = pauseDeficitSec(word);
		if (deficit >= MIN_PAUSE_SEC) wanted.set(word.id, deficit);
	}

	const existing = document.timeline.insertRanges;
	const kept: AxcutInsertRange[] = [];
	const seen = new Set<string>();
	for (const range of existing) {
		// Ranges for OTHER assets are none of this call's business.
		if (range.assetId !== assetId) {
			kept.push(range);
			continue;
		}
		const durationSec = wanted.get(range.wordId);
		if (durationSec === undefined) continue; // its word is gone, or needs no pause now
		seen.add(range.wordId);
		const word = words.find((w) => w.id === range.wordId);
		const atSec = word?.endSec ?? range.atSec;
		kept.push(
			durationSec === range.durationSec && atSec === range.atSec
				? range
				: { ...range, atSec, durationSec },
		);
	}
	for (const [wordId, durationSec] of wanted) {
		if (seen.has(wordId)) continue;
		const word = words.find((w) => w.id === wordId);
		if (!word) continue;
		kept.push({
			id: createId("insert"),
			assetId,
			atSec: word.endSec,
			durationSec,
			wordId,
			reason: isTake
				? `Silence for the added word "${word.text}".`
				: `Held frame for the added word "${word.text}".`,
			origin: "user",
		});
	}

	if (kept.length === existing.length && kept.every((range, i) => range === existing[i])) {
		return document;
	}
	// The clips grow with them. An insertion is media inside the clip, so the clip is that
	// much longer — the single fact every downstream reader needs, written once, here, where
	// the ranges themselves are written.
	return {
		...document,
		timeline: {
			...document.timeline,
			insertRanges: kept,
			clips: reflowClipsForInserts(document.timeline.clips, kept),
		},
	};
}

/**
 * The invariant {@link withInsertRangesForWords} maintains, read back: every stored pause
 * belongs to an added word that still needs one, sits where that word ends, and lasts what
 * its text needs. Exported for the test that holds the writer to it.
 */
export function insertRangesMatchWords(document: AxcutDocument): boolean {
	const byAsset = new Map(document.transcripts.map((t) => [t.assetId, t]));
	const expected = new Set<string>();
	for (const transcript of document.transcripts) {
		for (const word of transcript.words) {
			if (word.source === "synth" && pauseDeficitSec(word) >= MIN_PAUSE_SEC) {
				expected.add(`${transcript.assetId}::${word.id}`);
			}
		}
	}
	const seen = new Set<string>();
	for (const range of document.timeline.insertRanges) {
		const key = `${range.assetId}::${range.wordId}`;
		if (!expected.has(key) || seen.has(key)) return false;
		seen.add(key);
		const word = byAsset.get(range.assetId)?.words.find((w) => w.id === range.wordId);
		if (!word) return false;
		if (range.atSec !== word.endSec) return false;
		if (Math.abs(range.durationSec - pauseDeficitSec(word)) > 1e-9) return false;
	}
	return seen.size === expected.size;
}

/** {@link insertWord}, addressed by asset. Goes through `withTranscript` for the same
 *  reason {@link setDocumentWordText} does, and leaves behind the pause the new word
 *  needs — see {@link withInsertRangesForWords}. */
export function insertDocumentWord(
	document: AxcutDocument,
	assetId: string,
	anchorWordId: string,
	side: InsertSide,
	text: string,
): AxcutDocument {
	const transcript = document.transcripts.find((t) => t.assetId === assetId);
	if (!transcript) {
		throw new Error(`Cannot insert a word into asset "${assetId}": it has no transcript`);
	}
	return withInsertRangesForWords(
		withTranscript(document, insertWord(transcript, anchorWordId, side, text)),
		assetId,
	);
}

/** {@link removeWord}, addressed by asset and taking the whole set at once: a Backspace
 *  over several inserted words has to be ONE write, or undoing it takes as many presses as
 *  there were words. */
export function removeDocumentWords(
	document: AxcutDocument,
	assetId: string,
	wordIds: readonly string[],
): AxcutDocument {
	const transcript = document.transcripts.find((t) => t.assetId === assetId);
	if (!transcript) {
		throw new Error(`Cannot remove a word from asset "${assetId}": it has no transcript`);
	}
	return withInsertRangesForWords(
		withTranscript(
			document,
			wordIds.reduce((acc, wordId) => removeWord(acc, wordId), transcript),
		),
		assetId,
	);
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
	const inserts = (previous?.words ?? [])
		.filter((word) => word.source === "synth")
		.sort((a, b) => a.startSec - b.startSec);
	if (edits.length === 0 && inserts.length === 0) {
		return { transcript: next, carried: 0, dropped: 0 };
	}

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

	// An inserted word has no original text to recognise, so time is what places it: the
	// audio did not change between runs, only how it was heard. Each one goes back after
	// whatever the new transcript now ends last before it — including a word re-inserted a
	// moment ago, which is what keeps two inserts at the same spot in their old order.
	for (const insert of inserts) {
		const before = transcript.words
			.filter((word) => word.endSec <= insert.startSec)
			.reduce<AxcutWord | null>(
				(latest, word) => (latest === null || word.endSec >= latest.endSec ? word : latest),
				null,
			);
		const head = transcript.words[0];
		const target = before ?? head ?? null;
		if (!target) continue;
		transcript = insertWord(transcript, target.id, before ? "after" : "before", insert.text);
		carried += 1;
	}

	return { transcript, carried, dropped: edits.length + inserts.length - carried };
}
