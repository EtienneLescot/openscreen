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
//   • Where does an insertion land on the RULER? A range is anchored in SOURCE time, so it has
//     to be projected through whichever clip plays that moment — `rulerInserts`.
//   • What does the ruler look like once the insertions are counted? Stored raw seconds and
//     the seconds the user actually scrubs are no longer the same number, and
//     `expandRawSec` / `collapseRawSec` are the one place that difference is resolved.
//
// The two are inverses everywhere except INSIDE an insertion, where they cannot be: a stretch
// of ruler maps to the single source moment being held. `collapseRawSec` returns that
// moment, which is exactly what a decoder parked on a held frame should be told.

import type { AxcutClip, AxcutInsertRange, AxcutWord } from "../schema";

/** An insertion placed on the raw ruler, ready to be counted. */
export interface RulerInsert {
	id: string;
	wordId: string;
	/** Where the insertion begins, in STORED raw seconds — before any insertion is counted. */
	atRawSec: number;
	durationSec: number;
}

/**
 * Project each insert onto the raw ruler through the clip that plays its source moment.
 *
 * A range whose moment no clip plays yields nothing: the insertion exists for a word that is
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
	const claimed = new Set<string>();
	for (const clip of clips) {
		const sourceEnd = clip.sourceEndSec ?? Number.POSITIVE_INFINITY;
		const mine = inserts
			// Inclusive at both edges: an insertion sits at the END of the word it follows,
			// which is routinely a clip's own boundary. Claimed once, by the first clip that
			// plays the moment — two clips over the same recording are two places, not two
			// insertions.
			.filter(
				(insert) =>
					insert.assetId === clip.assetId &&
					!claimed.has(insert.id) &&
					insert.atSec >= clip.sourceStartSec &&
					insert.atSec <= sourceEnd,
			)
			.sort((a, b) => a.atSec - b.atSec);
		// Each insertion opens after the ones before it in the same clip: the clip's length
		// already carries all of them, so a plain source-shift would stack them all at the
		// first one's position.
		let carriedSec = 0;
		for (const insert of mine) {
			claimed.add(insert.id);
			placed.push({
				id: insert.id,
				wordId: insert.wordId,
				atRawSec: clip.timelineStartSec + (insert.atSec - clip.sourceStartSec) + carriedSec,
				durationSec: insert.durationSec,
			});
			carriedSec += insert.durationSec;
		}
	}
	return placed.sort((a, b) => a.atRawSec - b.atRawSec);
}

/**
 * A clip's own source moment → where it lands on the timeline.
 *
 * Not a plain shift, and this is the whole consequence of an insertion being MEDIA: the
 * clip is longer than its source window by everything inserted inside it, so a moment past
 * an insertion sits that much further along. Every place that used to convert between a
 * "raw" and an "expanded" ruler is really asking this, of one clip.
 *
 * `edge` decides what happens AT an insertion's own moment, which is a real choice and not
 * a rounding detail. `"opens"` puts the moment before the inserted media — right for a
 * position, and for the START of a span, so the span does not swallow the insertion that
 * precedes it. `"closes"` puts it after — right for the END of a span, so a stretch running
 * up to an insertion covers it rather than stopping short and leaving it orphaned.
 */
export function sourceToTimelineSec(
	/** Only the three fields that locate a clip — so a voiceover placement, which carries
	 *  the same three, maps through this too (issue #560). */
	clip: Pick<AxcutClip, "assetId" | "sourceStartSec" | "timelineStartSec">,
	sourceSec: number,
	inserts: readonly AxcutInsertRange[],
	edge: "opens" | "closes" = "opens",
): number {
	let added = 0;
	for (const insert of inserts) {
		if (insert.assetId !== clip.assetId) continue;
		if (insert.atSec <= clip.sourceStartSec) continue;
		if (edge === "opens" ? insert.atSec < sourceSec : insert.atSec <= sourceSec + 1e-6) {
			added += insert.durationSec;
		}
	}
	return clip.timelineStartSec + (sourceSec - clip.sourceStartSec) + added;
}

/**
 * The inverse: a timeline second → the source moment the clip is showing there.
 *
 * Inside an insertion there is no source moment — that is what makes it an insertion — so
 * it answers with the moment the inserted media follows, and names the insertion. A caller
 * driving a decoder needs both: where to park, and the fact that it should stay parked.
 */
export function timelineToSourceSec(
	clip: AxcutClip,
	timelineSec: number,
	inserts: readonly AxcutInsertRange[],
): { sourceSec: number; insideInsert: AxcutInsertRange | null } {
	const mine = inserts
		.filter((insert) => insert.assetId === clip.assetId && insert.atSec > clip.sourceStartSec)
		.sort((a, b) => a.atSec - b.atSec);
	let added = 0;
	for (const insert of mine) {
		const opensAt = clip.timelineStartSec + (insert.atSec - clip.sourceStartSec) + added;
		if (timelineSec < opensAt) break;
		if (timelineSec < opensAt + insert.durationSec) {
			return { sourceSec: insert.atSec, insideInsert: insert };
		}
		added += insert.durationSec;
	}
	return {
		sourceSec: clip.sourceStartSec + (timelineSec - clip.timelineStartSec) - added,
		insideInsert: null,
	};
}

/**
 * The insertion a frame of playback ran into, if it ran into one.
 *
 * Half-open on the LEFT, and that is the whole point: a player parks on the insertion's
 * frame and pins its clock to exactly `atRawSec` for the first frame of it, so `>` is what
 * refuses that same moment on the way in a second time. Closed on the right (with the frame
 * epsilon) so an insertion landing precisely on a frame boundary is played, not skipped.
 */
export function insertionEnteredBetween(
	prevSec: number,
	nextSec: number,
	inserts: readonly RulerInsert[],
	epsilonSec = 1e-6,
): RulerInsert | undefined {
	return inserts.find(
		(insert) => insert.atRawSec > prevSec && insert.atRawSec <= nextSec + epsilonSec,
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
 * Claimed once, and half-open at a clip's far edge except for the last: an insertion sits at the
 * END of the word it follows, which is routinely a split boundary, and testing both edges
 * inclusively painted the same word in BOTH halves (issue #560).
 *
 * Returns RAW seconds. The caller expands them; it used to mix a raw-then-expanded position
 * for a word with an insertion and a fraction of the clip's SOURCE span for one without, in the
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
