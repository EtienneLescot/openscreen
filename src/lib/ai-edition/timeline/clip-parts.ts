// The insertion layer: media -> parts -> clip.
//
// A clip does not read a file, it reads a LIST of parts:
//
//     [ recording 0→5.3 ]  [ extension 0.4s ]  [ recording 5.3→20.9 ]
//
// The extension does NOT slide into the media's own axis — it is appended to the clip's
// list. That is the decision the whole design rests on, and its consequence is the point:
// no stored source coordinate ever moves. A word, a trim, a zoom keeps the second it was
// authored at, for ever. Adding or removing an extension cannot corrupt an anchor.
//
// This is the ONLY module that knows an extension exists. Above it, a part is just media
// with a source window and a place on the timeline, and the plain arithmetic every reader
// used before insertions works again.

import type { AxcutClip, AxcutWord } from "../schema";

/** How fast a synthesized voice will be assumed to speak, in characters per second.
 *
 *  A stand-in for measuring the real thing: there is no TTS yet, so nothing can say how
 *  long the sentence actually takes. It is deliberately one number rather than a model —
 *  ponytail: fixed rate, ask the synthesizer for the real duration once there is one. */
const CHARS_PER_SEC = 15;

/** Below this the extension is not worth a part of its own: the clip would gain a few
 *  frames nobody asked for and every reader would carry a degenerate span. */
export const MIN_EXTENSION_SEC = 0.15;

/** How long the media for an added word has to be. */
export function extensionDurationSec(text: string): number {
	const chars = text.trim().length;
	if (chars === 0) return 0;
	return Math.max(MIN_EXTENSION_SEC, chars / CHARS_PER_SEC);
}

/** True for a word the user typed in, which no one said and nothing in the media carries. */
export function isAddedWord(word: AxcutWord): boolean {
	return word.source === "synth";
}

export type ClipPart =
	| {
			kind: "recording";
			timelineStartSec: number;
			timelineEndSec: number;
			/** The window of the clip's own asset this part plays. */
			sourceStartSec: number;
			sourceEndSec: number;
	  }
	| {
			kind: "extension";
			timelineStartSec: number;
			timelineEndSec: number;
			/** The word this media exists for. Its file is derived from the pair. */
			wordId: string;
			text: string;
	  };

/**
 * One clip, as the ordered list of media it actually plays.
 *
 * Added words split the clip's source window where they sit — at the END of the word they
 * follow — and their extension goes between the halves. A word outside the window belongs
 * to another clip of the same recording and is not this clip's business.
 *
 * `words` is the transcript of the clip's OWN asset; passing another's yields the clip
 * unsplit, which is the right answer rather than an error.
 */
export function clipParts(clip: AxcutClip, words: readonly AxcutWord[]): ClipPart[] {
	const sourceEnd = clip.sourceEndSec ?? clip.sourceStartSec;
	const parts: ClipPart[] = [];
	let timeline = clip.timelineStartSec;
	let from = clip.sourceStartSec;

	const added = words
		.filter(
			(word) =>
				isAddedWord(word) &&
				word.startSec > clip.sourceStartSec &&
				word.startSec <= sourceEnd &&
				extensionDurationSec(word.text) > 0,
		)
		.sort((a, b) => a.startSec - b.startSec);

	const pushRecording = (to: number) => {
		if (to - from <= 1e-6) return;
		parts.push({
			kind: "recording",
			timelineStartSec: timeline,
			timelineEndSec: timeline + (to - from),
			sourceStartSec: from,
			sourceEndSec: to,
		});
		timeline += to - from;
		from = to;
	};

	for (const word of added) {
		pushRecording(Math.min(word.startSec, sourceEnd));
		const durationSec = extensionDurationSec(word.text);
		parts.push({
			kind: "extension",
			timelineStartSec: timeline,
			timelineEndSec: timeline + durationSec,
			wordId: word.id,
			text: word.text,
		});
		timeline += durationSec;
	}
	pushRecording(sourceEnd);

	return parts;
}

/** What the clip's timeline length has to be, given its parts. The stored `timelineEndSec`
 *  is this — the writer that adds a word is what keeps them equal. */
export function partsLengthSec(parts: readonly ClipPart[]): number {
	if (parts.length === 0) return 0;
	return parts[parts.length - 1].timelineEndSec - parts[0].timelineStartSec;
}
