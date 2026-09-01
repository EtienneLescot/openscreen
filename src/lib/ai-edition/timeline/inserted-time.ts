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

import type { AxcutClip, AxcutInsertRange } from "../schema";

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
