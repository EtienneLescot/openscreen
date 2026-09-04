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

/** Where the generated media for an added word lives.
 *
 *  Beside the recording it was cut from, in a hidden sibling folder, and derived by pure
 *  string work from the asset path and the word — so the renderer and the main process
 *  arrive at the same path without asking each other. That is what keeps the file DERIVED:
 *  no one stores it, anyone can name it, and the process that can spawn ffmpeg is the only
 *  one that has to create it.
 *
 *  The name carries the duration, so a re-typed word asks for a different file and a stale
 *  one is simply never named again. */
export function extensionClipPath(assetPath: string, wordId: string, durationSec: number): string {
	const sep = assetPath.includes("\\") ? "\\" : "/";
	const dir = assetPath.slice(0, Math.max(0, assetPath.lastIndexOf(sep)));
	return `${dir}${sep}${EXTENSIONS_DIR}${sep}${wordId}_${Math.round(durationSec * 1000)}.mp4`;
}

/** The id an extension's media answers to, so a player that keys sources by asset finds it
 *  without knowing what an extension is. Prefixed rather than opaque: it can never collide
 *  with a real asset id, and it says what it is in a log line. */
export function extensionAssetId(wordId: string): string {
	return `ext:${wordId}`;
}

/**
 * The clips a PLAYER should see: each extension spliced in as a clip of its own.
 *
 * The DOM preview already knows how to play several clips over several files and swap at the
 * boundary. An extension is exactly that — a different file, played for a stretch — so it is
 * handed one rather than taught a new case. `resolvePlaybackSegments` does the same thing
 * one layer down, with the trims applied; this is the untrimmed list the player's own clock
 * maps against.
 */
export function clipsWithExtensions(
	clips: readonly AxcutClip[],
	transcripts: ReadonlyArray<{ assetId: string; words: readonly AxcutWord[] }>,
): AxcutClip[] {
	const wordsByAsset = new Map(transcripts.map((t) => [t.assetId, t.words]));
	return clips.flatMap((clip) =>
		clipParts(clip, wordsByAsset.get(clip.assetId) ?? []).map((part) =>
			part.kind === "extension"
				? {
						...clip,
						id: `${clip.id}__ext_${part.wordId}`,
						assetId: extensionAssetId(part.wordId),
						sourceStartSec: 0,
						sourceEndSec: part.timelineEndSec - part.timelineStartSec,
						timelineStartSec: part.timelineStartSec,
						timelineEndSec: part.timelineEndSec,
					}
				: {
						...clip,
						sourceStartSec: part.sourceStartSec,
						sourceEndSec: part.sourceEndSec,
						timelineStartSec: part.timelineStartSec,
						timelineEndSec: part.timelineEndSec,
					},
		),
	);
}

/** Hidden, because it is derived: deleting it costs nothing but a regeneration. */
export const EXTENSIONS_DIR = ".openscreen-extensions";

/** What the clip's timeline length has to be, given its parts. The stored `timelineEndSec`
 *  is this — the writer that adds a word is what keeps them equal. */
export function partsLengthSec(parts: readonly ClipPart[]): number {
	if (parts.length === 0) return 0;
	return parts[parts.length - 1].timelineEndSec - parts[0].timelineStartSec;
}

/** The parts that carry source time. An extension has none, which is the whole point. */
function recordings(parts: readonly ClipPart[]): Array<Extract<ClipPart, { kind: "recording" }>> {
	return parts.filter((p): p is Extract<ClipPart, { kind: "recording" }> => p.kind === "recording");
}

/**
 * A source second of the clip's media, as a second on the ruler. THE conversion.
 *
 * Every reader that writes `timelineStartSec + (sec - sourceStartSec)` is wrong the moment
 * the clip carries an extension: the seconds after one are pushed along by it, and the
 * reader lands everything early by the total inserted before it. That is one bug with one
 * home, not one per reader.
 *
 * A second sitting exactly where an insertion split maps to the moment AFTER the extension,
 * because that is where the recorded media of that second actually plays. The added word
 * itself never asks this question — it has no source second at all, and `extensionAt`
 * names its moment directly.
 */
export function partsRawSec(parts: readonly ClipPart[], sourceSec: number): number {
	const played = recordings(parts);
	if (played.length === 0) return parts[0]?.timelineStartSec ?? sourceSec;
	let part = played[0];
	for (const candidate of played) {
		if (candidate.sourceStartSec <= sourceSec) part = candidate;
	}
	return part.timelineStartSec + (sourceSec - part.sourceStartSec);
}

/**
 * The inverse: a second on the ruler, as a second of the clip's media.
 *
 * Inside an extension the source clock is PARKED at the second the insertion split. That is
 * the honest answer — none of the recording plays there, and the split is the last second
 * that did.
 */
export function partsSourceSec(parts: readonly ClipPart[], rawSec: number): number {
	const played = recordings(parts);
	if (played.length === 0) return rawSec;
	let part = played[0];
	for (const candidate of played) {
		if (candidate.timelineStartSec <= rawSec) part = candidate;
	}
	return Math.min(part.sourceEndSec, part.sourceStartSec + (rawSec - part.timelineStartSec));
}

/**
 * The added word being spoken at this moment on the ruler, if any.
 *
 * Asked of the parts directly rather than resolved through source time, where an extension
 * and the media that follows it share one second and nothing could tell them apart.
 */
export function extensionAt(parts: readonly ClipPart[], rawSec: number): string | null {
	for (const part of parts) {
		if (part.kind !== "extension") continue;
		if (rawSec >= part.timelineStartSec && rawSec < part.timelineEndSec) return part.wordId;
	}
	return null;
}
