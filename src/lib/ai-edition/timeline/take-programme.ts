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
): TakePiece[] {
	const rawStart = pill.startMs / 1000;
	const rawEnd = Math.max(rawStart, pill.endMs / 1000);
	const sourceStart = Math.max(0, pill.offsetMs / 1000);

	// Every boundary the walk has to stop at, on the RAW ruler, resolved sequentially:
	// an insertion's raw moment depends on the holds before it, so it cannot be mapped in
	// one pass up front.

	const cuts = [...removed]
		.filter((span) => span.endSec > rawStart && span.startSec < rawEnd)
		.sort((a, b) => a.startSec - b.startSec);

	const pieces: TakePiece[] = [];
	let raw = rawStart;
	let source = sourceStart;
	let nextCut = 0;

	const push = (kind: TakePiece["kind"], rawTo: number, sourceTo: number) => {
		if (rawTo - raw <= EPSILON_SEC) return;
		pieces.push({
			kind,
			rawStartSec: raw,
			rawEndSec: rawTo,
			sourceStartSec: source,
			sourceEndSec: sourceTo,
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
	const maxPasses = 4 * (removed.length + 2);
	let passes = 0;
	while (raw < rawEnd - EPSILON_SEC) {
		if (passes++ > maxPasses) break;
		// Skip cuts the walk has already passed.
		while (nextCut < cuts.length && cuts[nextCut].endSec <= raw + EPSILON_SEC) nextCut++;

		const cut = cuts[nextCut];

		// Inside a cut: silent to the cut's end, both cursors running.
		if (cut && cut.startSec <= raw + EPSILON_SEC) {
			const to = Math.min(cut.endSec, rawEnd);
			push("removed", to, source + (to - raw));
			continue;
		}

		// Otherwise play up to whichever boundary comes first.
		let to = rawEnd;
		if (cut) to = Math.min(to, cut.startSec);
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
): { targetTimeSec: number; shouldPlay: boolean } | null {
	for (const piece of pieces) {
		if (rawSec < piece.rawStartSec) break;
		if (rawSec >= piece.rawEndSec) continue;

		const target = piece.sourceStartSec + (rawSec - piece.rawStartSec);
		return { targetTimeSec: target, shouldPlay: piece.kind === "play" };
	}
	return null;
}
