// Aggregated transcript view for the right pane — joins the per-asset
// transcripts into a single flowing read of every clip on the timeline.
//
// ponytail: pure functions, no React. Mirrors axcut's
// apps/web/src/components/CurrentTranscriptView.tsx#buildClipTranscriptProjections
// + buildTranscriptRuns. Word kept/removed is decided by whether the word
// falls inside one of the document's `timeline.skipRanges` for the same
// asset — not by `clip.wordRefs` (which is now only used by the timeline
// retime math, not by the right pane).
//
// ponytail: no "filler" concept here. axcut does not classify words as
// filler in the right-pane renderer — the LLM (via the deep-agent's
// fillerLexicon + fillerOrHesitation reason) is the only place that
// names a word a filler. The transcript view shows plain text for every
// kept word; the user or the LLM decides what to mark as skipped.

import type { AxcutAsset, AxcutClip, AxcutSkipRange, AxcutTranscript, AxcutWord } from "../schema";

/** A contiguous run of removed words inside one clip's source range. */
export interface SkipRun {
	/** Id of the skip range this run came from (used by the bin-icon restore). */
	skipId: string;
	/** Index of the first removed word in `words`. */
	startWordIndex: number;
	/** Inclusive index of the last removed word in `words`. */
	endWordIndex: number;
	/** Asset id the skip belongs to. */
	assetId: string;
	/** Wall-clock seconds from the first removed word's start to the last removed word's end. */
	durationSec: number;
}

/** One word in the clip's source range, tagged kept / removed. */
export interface ClipWord {
	word: AxcutWord;
	/** Whether the word is inside a skipRange for this clip's asset. */
	kept: boolean;
	/** Id of the skip range that removed this word, if any. */
	skipId: string | null;
}

/** One clip's contribution to the aggregated flow. */
export interface ClipSection {
	clip: AxcutClip;
	asset: AxcutAsset | null;
	transcript: AxcutTranscript | null;
	words: ClipWord[];
	skipRuns: SkipRun[];
}

function wordsInRange(transcript: AxcutTranscript, startSec: number, endSec: number): AxcutWord[] {
	return transcript.words.filter((w) => w.endSec > startSec && w.startSec < endSec);
}

/** Find the skip range covering this word's center (returns the deepest match). */
function findCoveringSkip(word: AxcutWord, skipRanges: AxcutSkipRange[]): AxcutSkipRange | null {
	const center = (word.startSec + word.endSec) / 2;
	for (const skip of skipRanges) {
		if (center >= skip.startSec && center <= skip.endSec) return skip;
	}
	return null;
}

/**
 * Build one clip section. Words inside the clip's source range that fall
 * inside any skip range for the same asset are marked removed; the rest
 * are kept. Contiguous removed words from the same skip range group into
 * one `SkipRun` (for the trim-duration pill + bin-icon restore).
 */
export function buildClipSection(
	clip: AxcutClip,
	transcript: AxcutTranscript | null,
	asset: AxcutAsset | null,
	skipRanges: AxcutSkipRange[],
): ClipSection {
	const clipSkips = skipRanges.filter(
		(skip) =>
			skip.assetId === clip.assetId &&
			skip.endSec > clip.sourceStartSec &&
			skip.startSec < (clip.sourceEndSec ?? Infinity),
	);

	const words = transcript
		? wordsInRange(transcript, clip.sourceStartSec, clip.sourceEndSec ?? Infinity)
		: [];
	const tagged: ClipWord[] = words.map((word) => {
		const covering = findCoveringSkip(word, clipSkips);
		return {
			word,
			kept: covering === null,
			skipId: covering?.id ?? null,
		};
	});

	const skipRuns: SkipRun[] = [];
	let runStart = -1;
	let runEnd = -1;
	let runSkipId = "";
	let runMinStart = 0;
	let runMaxEnd = 0;
	const flush = () => {
		if (runStart >= 0) {
			skipRuns.push({
				skipId: runSkipId,
				assetId: clip.assetId,
				startWordIndex: runStart,
				endWordIndex: runEnd,
				durationSec: Math.max(0, runMaxEnd - runMinStart),
			});
		}
		runStart = -1;
		runEnd = -1;
		runSkipId = "";
		runMinStart = 0;
		runMaxEnd = 0;
	};
	tagged.forEach((cw, i) => {
		if (cw.kept) {
			flush();
			return;
		}
		// Split the run if the skip range id changes (overlapping skips).
		if (runStart >= 0 && cw.skipId !== runSkipId) {
			flush();
		}
		if (runStart < 0) {
			runStart = i;
			runMinStart = cw.word.startSec;
			runSkipId = cw.skipId ?? "";
		}
		runEnd = i;
		runMaxEnd = Math.max(runMaxEnd, cw.word.endSec);
	});
	flush();

	return { clip, asset, transcript, words: tagged, skipRuns };
}

/**
 * Build every clip section in timeline order. Clips without a matching
 * transcript still render (asset label + an empty flow) so the user sees
 * the clip exists but no transcript is available for it yet.
 */
export function buildAggregatedSections(
	clips: AxcutClip[],
	transcripts: AxcutTranscript[],
	assets: AxcutAsset[],
	skipRanges: AxcutSkipRange[],
): ClipSection[] {
	const transcriptById = new Map(transcripts.map((t) => [t.assetId, t]));
	const assetById = new Map(assets.map((a) => [a.id, a]));
	return clips.map((clip) =>
		buildClipSection(
			clip,
			transcriptById.get(clip.assetId) ?? null,
			assetById.get(clip.assetId) ?? null,
			skipRanges,
		),
	);
}

/** Where the playback head currently is, in source time. */
export interface CuePosition {
	assetId: string;
	/** Optional clip id filter (lets the caller restrict to a single clip). */
	clipId?: string;
	sourceTimeSec: number;
}

/**
 * Find the word in `sections` that the playback head is currently inside.
 * Used to highlight the active word and auto-scroll the transcript. Mirrors
 * axcut's `findCueWordId` in CurrentTranscriptView.
 *
 *   - If the head is before the first word → null.
 *   - If the head is between two words        → the previous word (so the
 *     highlight "sticks" until the next word starts).
 *   - Silence tokens (id starts with `silence_`) are skipped over so a
 *     long pause doesn't surface a fake cue word.
 */
export function findCueWordId(sections: ClipSection[], cue: CuePosition | null): string | null {
	if (!cue) return null;
	const assetMatch = sections
		.filter((s) => s.words.length > 0)
		.find((s) => s.clip.assetId === cue.assetId);
	if (!assetMatch) return null;
	// ponytail: clipId is part of the cue position for future use, but the
	// word-id projection already encodes clipId in the prefix; the
	// current iteration just walks every word in the asset. If we need
	// clip-scoped lookup later, store the clip id on each ClipWord.
	const pool = assetMatch.words;

	const t = cue.sourceTimeSec;
	let previous: string | null = null;
	for (const cw of pool) {
		if (cw.word.id.startsWith("silence_")) continue;
		if (t < cw.word.startSec) return previous;
		if (t >= cw.word.startSec && t <= cw.word.endSec) return cw.word.id;
		previous = cw.word.id;
	}
	return previous;
}
