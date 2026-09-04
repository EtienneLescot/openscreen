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

import type { AxcutAsset, AxcutClip, AxcutDocument, AxcutWord } from "../schema";

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

/** Marks every id this module derives. Never produced by the writers, so `withExtensions`
 *  can recognise a document it has already derived — and a log line says what it is. */
export const EXTENSION_ID_PREFIX = "ext:";

/** The id an extension's media answers to. */
export function extensionAssetId(wordId: string): string {
	return `${EXTENSION_ID_PREFIX}${wordId}`;
}

/** Separates a derived piece from the clip it was cut out of. Double, so it cannot collide
 *  with the single underscores every generated clip id already carries. */
const PIECE = "__";

/** The stored clip a derived piece came from. A trim names a clip by id, and both halves of
 *  a split clip are still that clip — so both must answer to its name. */
export function baseClipId(clipId: string): string {
	const at = clipId.indexOf(PIECE);
	return at < 0 ? clipId : clipId.slice(0, at);
}

/**
 * The document as everything that RENDERS it should see it: an extension is a clip, on an
 * asset, with a file.
 *
 * This is the whole insertion layer, and it exists because of one property every mapping in
 * this codebase is built on — a clip is an UNINTERRUPTED shift between its source seconds
 * and the ruler. `timelineMap`, the native `setActiveClip`, the exporter and the DOM player
 * all assume it. A clip interrupted by generated media breaks that assumption in every one
 * of them at once, which is why teaching them each about extensions never converged: the
 * fix was eight special cases, and it was still one bug.
 *
 * So the interruption is resolved HERE, once, into the shape they already handle. Below this
 * line there are no extensions — only clips, some of which happen to play a generated file.
 *
 * Derived, never stored: one direction, nothing to reconcile. The stored clip keeps its own
 * single identity and its own source window, and the words remain the only truth about what
 * was added.
 */
export function withExtensions(document: AxcutDocument): AxcutDocument {
	// Already derived — deriving again would split the halves a second time, because the
	// added word sits exactly on the first half's end.
	if (document.assets.some((a) => a.id.startsWith(EXTENSION_ID_PREFIX))) return document;

	const wordsByAsset = new Map(document.transcripts.map((t) => [t.assetId, t.words]));
	const assetById = new Map(document.assets.map((a) => [a.id, a]));
	const assets = [...document.assets];

	const clips = document.timeline.clips.flatMap((clip): AxcutClip[] => {
		const parts = clipParts(clip, wordsByAsset.get(clip.assetId) ?? []);
		if (parts.length < 2) return [clip];
		const source = assetById.get(clip.assetId);
		let piece = 0;
		return parts.flatMap((part): AxcutClip[] => {
			if (part.kind === "recording") {
				piece += 1;
				return [
					{
						...clip,
						// The first piece keeps the clip's own name so anything holding it still
						// finds something; `baseClipId` is what makes the rest answer to it too.
						id: piece === 1 ? clip.id : `${clip.id}${PIECE}r${piece}`,
						sourceStartSec: part.sourceStartSec,
						sourceEndSec: part.sourceEndSec,
						timelineStartSec: part.timelineStartSec,
						timelineEndSec: part.timelineEndSec,
					},
				];
			}
			// Nothing to name the file after, so nothing to play: the clip simply stays short
			// of what the word asked for, rather than pointing at a path that cannot exist.
			if (!source?.originalPath) return [];
			const durationSec = part.timelineEndSec - part.timelineStartSec;
			const id = extensionAssetId(part.wordId);
			if (!assetById.has(id)) {
				const asset: AxcutAsset = {
					id,
					kind: "video",
					label: part.text.trim().slice(0, 40) || part.wordId,
					originalPath: extensionClipPath(source.originalPath, part.wordId, durationSec),
					durationSec,
					// The recording's geometry, because the generated file was made to match it.
					video: source.video,
					cameraTrack: null,
				};
				assetById.set(id, asset);
				assets.push(asset);
			}
			return [
				{
					...clip,
					id: `${clip.id}${PIECE}ext_${part.wordId}`,
					assetId: id,
					// Authored against the recording's framing, which this is not.
					cropRegion: undefined,
					sourceStartSec: 0,
					sourceEndSec: durationSec,
					timelineStartSec: part.timelineStartSec,
					timelineEndSec: part.timelineEndSec,
				},
			];
		});
	});

	if (assets.length === document.assets.length) return document;
	return { ...document, assets, timeline: { ...document.timeline, clips } };
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

/**
 * The ruler span of the extension inserted at this source second, if there is one.
 *
 * The answer to a question source time cannot express: an added word occupies no source
 * seconds, so anything measuring it there measures zero. Its span lives on its part.
 */
export function extensionSpanAtSource(
	parts: readonly ClipPart[],
	sourceSec: number,
): { startSec: number; endSec: number } | null {
	const played = recordings(parts);
	for (const [i, part] of parts.entries()) {
		if (part.kind !== "extension") continue;
		// The recording part that ENDS where this extension begins is the one whose last
		// source second the word was typed after.
		const before =
			parts
				.slice(0, i)
				.filter((p) => p.kind === "recording")
				.at(-1) ?? played[0];
		const at = before ? before.sourceEndSec : sourceSec;
		if (Math.abs(at - sourceSec) < 1e-6) {
			return { startSec: part.timelineStartSec, endSec: part.timelineEndSec };
		}
	}
	return null;
}
