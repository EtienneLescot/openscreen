// One walk over a voice-over take (issue #560).
//
// A take is subject to two opposite forces at once and they must not be two passes. A CUT
// under it takes time away — step 3 already slices the mix by `removedRawSpans`. An
// INSERTION inside it adds time: a word added to the take's transcript needs somewhere to
// be spoken, so the voice stops and resumes on the same word.
//
// What this walk deliberately does NOT do:
//
//   - It does not react to an insertion in the RECORDING lane. A word added to the film
//     freezes the picture; the take has its own audio and keeps talking, finishing that
//     much earlier against a picture that has slid. The maintainer settled this: "the
//     voice-over is not impacted by the insertion in the recording track". A take is as
//     long as the audio it holds, and nothing under it changes that.
//   - It does not lengthen the programme. The clips decide the length, full stop. A take
//     insertion pushes the take's later content later inside the SAME timeline, and
//     whatever that pushes past the last frame is lost at export — `mix_external_tracks`
//     clamps every track to the programme. Placing content inside the useful span of the
//     timeline is the user's job.
//
// It runs on the PILL, never on a stored fragment. The document stores one fragment per
// clip a take covers; growing one fragment leaves its successor's head where it was, and
// the mixer sums with `+=` at an absolute offset — so a fragment-wise walk ships a take
// playing on top of itself. `anchorAudioTrackFragments` is untouched and stays correct for
// the music and loop paths that still read it.

import type { PlaybackSpeedRegion } from "../document/timeline";
import { rawSpanForOutDuration } from "../document/timeline";
import type { AxcutAudioTrack } from "../schema";
import type { RemovedRawSpan } from "./programme-time";

/** One stretch of a take, in playback order. */
export interface TakePiece {
	/**
	 * `play` — the file is heard. `hold` — the voice is parked on one source moment while
	 * the timeline runs on (an insertion). `removed` — the film lost this stretch, so the
	 * take is silent through it, its own clock still running underneath.
	 */
	kind: "play" | "hold" | "removed";
	/** Stored RAW ruler seconds. Insertions occupy raw time here because they consume it
	 *  from the take's own span — they do not create programme time. */
	rawStartSec: number;
	rawEndSec: number;
	/** The take's own file. Equal on a `hold`: the moment the voice is parked on. */
	sourceStartSec: number;
	sourceEndSec: number;
	/** The insertion that produced a `hold`. */
	holdId?: string;
	/** The word that insertion exists for. */
	wordId?: string;
}

/** An insertion inside one take, in the take's own source seconds. */
export interface TakeInsert {
	id: string;
	wordId: string;
	atSourceSec: number;
	/** OUTPUT seconds. A voice plays at 1x in the mix, so a pause for a spoken word is
	 *  measured on the take's own clock, not on a raw ruler a speed region compresses. */
	durationSec: number;
}

const EPSILON_SEC = 1e-9;

/**
 * The take, stretch by stretch, in playback order.
 *
 * Both cursors advance together except inside a `hold`, where the source parks. A `removed`
 * stretch advances BOTH — the cut mutes the take without rewinding it, which is what keeps
 * the words after a cut landing on the picture they belong to (the behaviour step 3 shipped
 * and its tests pin).
 *
 * With no insertions this reduces exactly to `subtractRemoved` over the take's span, which
 * is the property that lets the export and the preview keep their current answers.
 */
export function takeProgramme(
	pill: Pick<AxcutAudioTrack, "startMs" | "endMs" | "offsetMs">,
	removed: readonly RemovedRawSpan[],
	inserts: readonly TakeInsert[],
	speedRegions: PlaybackSpeedRegion[] = [],
): TakePiece[] {
	const rawStart = pill.startMs / 1000;
	const rawEnd = Math.max(rawStart, pill.endMs / 1000);
	const sourceStart = Math.max(0, pill.offsetMs / 1000);

	// Every boundary the walk has to stop at, on the RAW ruler, resolved sequentially:
	// an insertion's raw moment depends on the holds before it, so it cannot be mapped in
	// one pass up front.
	const pending = [...inserts]
		.filter((ins) => ins.durationSec > 0)
		.sort((a, b) => a.atSourceSec - b.atSourceSec || a.id.localeCompare(b.id));

	const cuts = [...removed]
		.filter((span) => span.endSec > rawStart && span.startSec < rawEnd)
		.sort((a, b) => a.startSec - b.startSec);

	const pieces: TakePiece[] = [];
	let raw = rawStart;
	let source = sourceStart;
	let nextInsert = 0;
	let nextCut = 0;

	const push = (kind: TakePiece["kind"], rawTo: number, sourceTo: number, ins?: TakeInsert) => {
		if (rawTo - raw <= EPSILON_SEC) return;
		pieces.push({
			kind,
			rawStartSec: raw,
			rawEndSec: rawTo,
			sourceStartSec: source,
			sourceEndSec: sourceTo,
			...(ins ? { holdId: ins.id, wordId: ins.wordId } : {}),
		});
		raw = rawTo;
		source = sourceTo;
	};

	// A hang is the worst failure a renderer can have. This loop terminates because every
	// pass either advances `raw` or consumes a boundary, so the passes are bounded by the
	// boundary count — but that is an argument, and an argument is not a guarantee. A
	// mutation of the boundary arithmetic span it forever rather than failing an assertion,
	// so the bound is enforced. Counting passes rather than watching `raw` on purpose: a
	// pass that consumes a zero-length insertion makes real progress without moving `raw`,
	// and a no-progress test would cut the walk short on a legitimate document.
	const maxPasses = 4 * (removed.length + inserts.length + 2);
	let passes = 0;
	while (raw < rawEnd - EPSILON_SEC) {
		if (passes++ > maxPasses) break;
		// Skip cuts and insertions the walk has already passed.
		while (nextCut < cuts.length && cuts[nextCut].endSec <= raw + EPSILON_SEC) nextCut++;
		while (nextInsert < pending.length && pending[nextInsert].atSourceSec <= source - EPSILON_SEC) {
			// Its moment is behind the source cursor: a cut swallowed it, or two inserts
			// share a moment and the first already consumed it. Either way it buys nothing.
			nextInsert++;
		}

		const cut = cuts[nextCut];
		const insert = pending[nextInsert];

		// Sitting exactly on an insertion's moment: hold before anything else, so two
		// inserts at one moment become two adjacent holds rather than one merged stretch.
		if (insert && insert.atSourceSec <= source + EPSILON_SEC) {
			const held = Math.min(
				rawSpanForOutDuration(raw, insert.durationSec, speedRegions),
				rawEnd - raw,
			);
			nextInsert++;
			if (held > EPSILON_SEC) {
				pieces.push({
					kind: "hold",
					rawStartSec: raw,
					rawEndSec: raw + held,
					sourceStartSec: source,
					sourceEndSec: source,
					holdId: insert.id,
					wordId: insert.wordId,
				});
				raw += held;
			}
			continue;
		}

		// Inside a cut: silent to the cut's end, both cursors running.
		if (cut && cut.startSec <= raw + EPSILON_SEC) {
			const to = Math.min(cut.endSec, rawEnd);
			push("removed", to, source + (to - raw));
			continue;
		}

		// Otherwise play up to whichever boundary comes first.
		let to = rawEnd;
		if (cut) to = Math.min(to, cut.startSec);
		if (insert) to = Math.min(to, raw + (insert.atSourceSec - source));
		push("play", Math.max(raw, to), source + (Math.max(raw, to) - raw));
	}

	return pieces;
}

/** The take's stretch of raw ruler, or null when it has none. */
export function takeRulerExtent(pieces: readonly TakePiece[]): {
	startSec: number;
	endSec: number;
} | null {
	if (pieces.length === 0) return null;
	return { startSec: pieces[0].rawStartSec, endSec: pieces[pieces.length - 1].rawEndSec };
}

/**
 * Seconds of the take's FILE the walk consumes.
 *
 * Deliberately not called `spanSec`: that name already means the trim-projected OUTPUT span
 * at the preview's call site, and the fades are measured against the consumed source — feed
 * them a span grown by a hold and the fade-out starts early in the preview only.
 */
export function consumedSourceSec(pieces: readonly TakePiece[]): number {
	return pieces.reduce((sum, piece) => sum + (piece.sourceEndSec - piece.sourceStartSec), 0);
}

/** Where the voice is, and whether it is heard, at a raw moment. */
export function takePlaybackAt(
	pieces: readonly TakePiece[],
	rawSec: number,
): { targetTimeSec: number; shouldPlay: boolean; heldBy?: string } | null {
	for (const piece of pieces) {
		if (rawSec < piece.rawStartSec) break;
		if (rawSec >= piece.rawEndSec) continue;
		if (piece.kind === "hold") {
			// Parked on ONE source moment, not clamped to a moving target: resuming from the
			// post-insert source would restart the narration on the wrong word, and a target
			// that drifts every frame would re-seek a paused element every frame.
			return { targetTimeSec: piece.sourceStartSec, shouldPlay: false, heldBy: piece.holdId };
		}
		const target = piece.sourceStartSec + (rawSec - piece.rawStartSec);
		return { targetTimeSec: target, shouldPlay: piece.kind === "play" };
	}
	return null;
}
