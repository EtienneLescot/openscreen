// Time the film does not have.
//
// An added word needs somewhere to be spoken. Where the transcript has free silence it
// borrows it; where it does not, the film holds its frame and everything after it moves
// along the ruler. That created time is stored as an `AxcutInsertRange` — the inverse of a
// trim, and deliberately the same shape, because a region is what this timeline already
// carries safely from end to end. (An earlier attempt made CLIPS for it; see the schema's
// note on `insertRangeSchema` for how that ended.)
//
// This module is the arithmetic, and nothing else: pure, no document, no React. It answers
// two questions.
//
//   • Where does a pause land on the RULER? A range is anchored in SOURCE time, so it has
//     to be projected through whichever clip plays that moment — `rulerInserts`.
//   • What does the ruler look like once the pauses are counted? Stored raw seconds and
//     the seconds the user actually scrubs are no longer the same number, and
//     `expandRawSec` / `collapseRawSec` are the one place that difference is resolved.
//
// The two are inverses everywhere except INSIDE a pause, where they cannot be: a stretch
// of ruler maps to the single source moment being held. `collapseRawSec` returns that
// moment, which is exactly what a decoder parked on a held frame should be told.

import type { AxcutClip, AxcutInsertRange, AxcutWord } from "../schema";

/** A pause placed on the raw ruler, ready to be counted. */
export interface RulerInsert {
	id: string;
	wordId: string;
	/** Where the pause begins, in STORED raw seconds — before any pause is counted. */
	atRawSec: number;
	durationSec: number;
}

/**
 * Project each insert onto the raw ruler through the clip that plays its source moment.
 *
 * A range whose moment no clip plays yields nothing: the pause exists for a word that is
 * not on the timeline, so there is no ruler position for it and nothing to add. Same rule
 * the captions follow for a line no clip covers.
 *
 * Ordered by ruler position, which is what lets the accumulation below be a single pass.
 */
export function rulerInserts(
	inserts: readonly AxcutInsertRange[],
	clips: readonly AxcutClip[],
): RulerInsert[] {
	const placed: RulerInsert[] = [];
	for (const insert of inserts) {
		for (const clip of clips) {
			if (clip.assetId !== insert.assetId) continue;
			const sourceEnd = clip.sourceEndSec ?? Number.POSITIVE_INFINITY;
			// Inclusive at both edges: a pause sits at the END of the word it follows, which
			// is routinely a clip's own boundary.
			if (insert.atSec < clip.sourceStartSec || insert.atSec > sourceEnd) continue;
			placed.push({
				id: insert.id,
				wordId: insert.wordId,
				atRawSec: clip.timelineStartSec + (insert.atSec - clip.sourceStartSec),
				durationSec: insert.durationSec,
			});
			break;
		}
	}
	return placed.sort((a, b) => a.atRawSec - b.atRawSec);
}

/** How much time the pauses add in total — what the ruler grows by. */
export function totalInsertedSec(inserts: readonly RulerInsert[]): number {
	return inserts.reduce((sum, insert) => sum + insert.durationSec, 0);
}

/**
 * Stored raw seconds → the ruler the user sees.
 *
 * Monotone and total: every stored moment has exactly one place on the expanded ruler.
 * A moment sitting exactly ON a pause maps to where the pause BEGINS, so the frame that
 * is about to be held keeps its own instant and the pause opens after it.
 */
export function expandRawSec(sec: number, inserts: readonly RulerInsert[]): number {
	let out = sec;
	for (const insert of inserts) {
		if (insert.atRawSec < sec) out += insert.durationSec;
	}
	return out;
}

/**
 * The ruler the user sees → stored raw seconds.
 *
 * The inverse of {@link expandRawSec} outside a pause. Inside one it cannot be an inverse
 * — a whole stretch of ruler stands for a single held moment — and it returns that moment,
 * flagged, so a caller driving a decoder knows to hold rather than to seek.
 */
export function collapseRawSec(
	sec: number,
	inserts: readonly RulerInsert[],
): { sec: number; heldBy: RulerInsert | null } {
	let offset = 0;
	for (const insert of inserts) {
		const startsAt = insert.atRawSec + offset;
		if (sec < startsAt) break;
		if (sec < startsAt + insert.durationSec) {
			return { sec: insert.atRawSec, heldBy: insert };
		}
		offset += insert.durationSec;
	}
	return { sec: sec - offset, heldBy: null };
}

/**
 * The pause a frame of playback stepped over, if it stepped over one.
 *
 * Half-open on the LEFT, and that is the whole point: a player that holds pins its raw
 * playhead to exactly `atRawSec` for the length of the pause, so `>` is what refuses that
 * same moment on the way OUT. With `>=` the pause is re-entered the instant it ends and the
 * film never gets past it. Closed on the right (with the frame epsilon) so a pause landing
 * precisely on a frame boundary is held rather than skipped.
 */
export function holdEnteredBetween(
	prevRawSec: number,
	nextRawSec: number,
	inserts: readonly RulerInsert[],
	epsilonSec = 1e-6,
): RulerInsert | undefined {
	return inserts.find(
		(insert) => insert.atRawSec > prevRawSec && insert.atRawSec <= nextRawSec + epsilonSec,
	);
}

/** An added word, placed on the raw ruler through the clip that carries it. */
export interface InsertedWordMark {
	clipId: string;
	wordId: string;
	text: string;
	atRawSec: number;
}

/**
 * Where each added word's mark belongs, one per word.
 *
 * Claimed once, and half-open at a clip's far edge except for the last: a pause sits at the
 * END of the word it follows, which is routinely a split boundary, and testing both edges
 * inclusively painted the same word in BOTH halves (issue #560).
 *
 * Returns RAW seconds. The caller expands them; it used to mix a raw-then-expanded position
 * for a word with a pause and a fraction of the clip's SOURCE span for one without, in the
 * same ternary — two clocks, and the clip box is not drawn in the second.
 */
export function insertedWordMarks(
	transcripts: ReadonlyArray<{ assetId: string; words: ReadonlyArray<AxcutWord> }>,
	clips: readonly AxcutClip[],
): InsertedWordMark[] {
	const byAsset = new Map<string, ReadonlyArray<AxcutWord>>();
	for (const transcript of transcripts) {
		const added = transcript.words.filter((word) => word.source === "synth");
		if (added.length > 0) byAsset.set(transcript.assetId, added);
	}
	if (byAsset.size === 0) return [];

	const marks: InsertedWordMark[] = [];
	const claimed = new Set<string>();
	clips.forEach((clip, index) => {
		const words = byAsset.get(clip.assetId);
		const sourceEnd = clip.sourceEndSec ?? clip.sourceStartSec;
		if (!words || sourceEnd <= clip.sourceStartSec) return;
		const isLast = index === clips.length - 1;
		for (const word of words) {
			if (claimed.has(word.id)) continue;
			if (word.startSec < clip.sourceStartSec) continue;
			if (word.startSec > sourceEnd || (!isLast && word.startSec === sourceEnd)) continue;
			claimed.add(word.id);
			marks.push({
				clipId: clip.id,
				wordId: word.id,
				text: word.text,
				atRawSec: clip.timelineStartSec + (word.startSec - clip.sourceStartSec),
			});
		}
	});
	return marks;
}
