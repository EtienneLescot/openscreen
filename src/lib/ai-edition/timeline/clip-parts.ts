// What an insertion is made of: a duration, a name, and a file.
//
// An insertion IS a clip (see `document/insertion.ts`), so there is nothing here that maps
// between coordinate systems and nothing downstream that knows an insertion exists. What
// remains is the handful of rules the writer and the generator both have to agree on — how
// long an added word takes, what its asset is called, and where its file lives — expressed
// once so the renderer names the file the main process writes.

import type { AxcutWord } from "../schema";

/** How fast a synthesized voice will be assumed to speak, in characters per second.
 *
 *  A stand-in for measuring the real thing: there is no TTS yet, so nothing can say how
 *  long the sentence actually takes. It is deliberately one number rather than a model —
 *  ponytail: fixed rate, ask the synthesizer for the real duration once there is one. */
const CHARS_PER_SEC = 15;

/** Below this the clip would be a few frames nobody asked for. */
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

/** Marks every id an insertion owns — its asset and its clip share it. Never produced by
 *  anything else, so a reader can tell generated media from a recording at a glance. */
export const EXTENSION_ID_PREFIX = "ext:";

/** The id an insertion's media answers to. */
export function extensionAssetId(wordId: string): string {
	return `${EXTENSION_ID_PREFIX}${wordId}`;
}

/** Hidden, because it is derived: deleting it costs nothing but a regeneration. */
export const EXTENSIONS_DIR = ".openscreen-extensions";

/** Where the generated media for an added word lives.
 *
 *  Beside the recording, in a hidden sibling folder, and derived by pure string work from
 *  the asset path and the word — so the renderer and the main process arrive at the same
 *  path without asking each other. The name carries the duration, so a re-typed word asks
 *  for a different file and a stale one is simply never named again. */
export function extensionClipPath(assetPath: string, wordId: string, durationSec: number): string {
	const sep = assetPath.includes("\\") ? "\\" : "/";
	const dir = assetPath.slice(0, Math.max(0, assetPath.lastIndexOf(sep)));
	return `${dir}${sep}${EXTENSIONS_DIR}${sep}${wordId}_${Math.round(durationSec * 1000)}.mp4`;
}
