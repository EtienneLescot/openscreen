// One walk over a voice-over take (issue #560).
//
// A CUT under a take takes time away: the voice is silent through it with its own clock
// still running, which is what keeps the words after a cut landing on the picture they
// belong to. That is the whole of what this does.
//
// It used to also add time, for an insertion inside the take. It does not any more: an
// insertion IS a track of its own (`document/insertionTrack.ts`), so the take arrives here
// already split into pills that each play an uninterrupted stretch of their file. Both
// cursors therefore advance together everywhere, and the walk is a subtraction again.
//
// It runs on the PILL, never on a stored fragment. The document stores one fragment per clip
// a take covers, and the mixer sums with `+=` at an absolute offset — so a fragment-wise walk
// ships a take playing on top of itself. `anchorAudioTrackFragments` is untouched and stays
// correct for the music and loop paths that still read it.

import type { AxcutAudioTrack } from "../schema";
import type { RemovedRawSpan } from "./programme-time";

/** One stretch of a take, in playback order. */
export interface TakePiece {
	/**
	 * `play` — the file is heard. `removed` — the film lost this stretch, so the take is
	 * silent through it, its own clock still running underneath.
	 */
	kind: "play" | "removed";
	/** Stored RAW ruler seconds. */
	rawStartSec: number;
	rawEndSec: number;
	/** The take's own file. */
	sourceStartSec: number;
	sourceEndSec: number;
}

const EPSILON_SEC = 1e-9;

/** The take, stretch by stretch, in playback order: what is heard, and what a cut mutes. */
export function takeProgramme(
	pill: Pick<AxcutAudioTrack, "startMs" | "endMs" | "offsetMs">,
	removed: readonly RemovedRawSpan[],
): TakePiece[] {
	const rawStart = pill.startMs / 1000;
	const rawEnd = Math.max(rawStart, pill.endMs / 1000);
	const sourceStart = Math.max(0, pill.offsetMs / 1000);

	const cuts = [...removed]
		.filter((span) => span.endSec > rawStart && span.startSec < rawEnd)
		.sort((a, b) => a.startSec - b.startSec);

	const pieces: TakePiece[] = [];
	let raw = rawStart;
	// The source clock never parks, so it is a plain shift of the raw one.
	const push = (kind: TakePiece["kind"], to: number) => {
		if (to - raw <= EPSILON_SEC) return;
		pieces.push({
			kind,
			rawStartSec: raw,
			rawEndSec: to,
			sourceStartSec: sourceStart + (raw - rawStart),
			sourceEndSec: sourceStart + (to - rawStart),
		});
		raw = to;
	};

	for (const cut of cuts) {
		// `max(_, raw)` because sorted cuts can still overlap; the second one then starts
		// behind the cursor and contributes only whatever it reaches past it.
		push("play", Math.min(Math.max(cut.startSec, raw), rawEnd));
		push("removed", Math.min(cut.endSec, rawEnd));
	}
	push("play", rawEnd);

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
 * at the preview's call site, and the fades are measured against the consumed source.
 */
export function consumedSourceSec(pieces: readonly TakePiece[]): number {
	return pieces.reduce((sum, piece) => sum + (piece.sourceEndSec - piece.sourceStartSec), 0);
}

/** Where the voice is, and whether it is heard, at a raw moment. */
export function takePlaybackAt(
	pieces: readonly TakePiece[],
	rawSec: number,
): { targetTimeSec: number; shouldPlay: boolean } | null {
	for (const piece of pieces) {
		if (rawSec < piece.rawStartSec) break;
		if (rawSec >= piece.rawEndSec) continue;

		const target = piece.sourceStartSec + (rawSec - piece.rawStartSec);
		return { targetTimeSec: target, shouldPlay: piece.kind === "play" };
	}
	return null;
}
