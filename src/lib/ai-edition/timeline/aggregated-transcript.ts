// Aggregated transcript view for the right pane — joins the per-asset
// transcripts into a single flowing read of every clip on the timeline.
//
// ponytail: pure functions, no React. Mirrors axcut's
// apps/web/src/components/CurrentTranscriptView.tsx#buildClipTranscriptProjections
// + buildTranscriptRuns. Word kept/removed is decided by whether the word
// falls inside one of the document's `timeline.trimRanges` for the same
// asset — not by `clip.wordRefs` (which is now only used by the timeline
// retime math, not by the right pane).
//
// ponytail: no "filler" concept here. axcut does not classify words as
// filler in the right-pane renderer — the LLM (via the deep-agent's
// fillerLexicon + fillerOrHesitation reason) is the only place that
// names a word a filler. The transcript view shows plain text for every
// kept word; the user or the LLM decides what to mark as skipped.

import type { AxcutAsset, AxcutClip, AxcutTranscript, AxcutTrimRange, AxcutWord } from "../schema";
import { trimAppliesToClip } from "./trim-mapping";

/** Gaps between words at least this long are surfaced as a `[silence]` token. */
export const SILENCE_THRESHOLD_SEC = 0.2;

/** True for the synthetic `[silence]` pseudo-words inserted by `withSilenceGaps`. */
export function isSilenceWord(word: AxcutWord): boolean {
	return word.id.startsWith("silence_");
}

/**
 * Insert a synthetic `[silence]` pseudo-word into every gap of at least
 * `SILENCE_THRESHOLD_SEC` between consecutive words (and at the clip's
 * leading/trailing edges). These behave like any other word for trim
 * tagging/runs — `buildClipSection` marks them kept/removed the same way —
 * so the transcript panel can show already-trimmed silences distinctly
 * from untrimmed ones and let the user trim/restore them directly.
 */
function withSilenceGaps(
	words: AxcutWord[],
	clipStartSec: number,
	clipEndSec: number | undefined,
): AxcutWord[] {
	const sorted = [...words].sort((a, b) => a.startSec - b.startSec);
	const result: AxcutWord[] = [];
	let cursor = clipStartSec;
	let n = 0;
	const pushGap = (start: number, end: number) => {
		if (end - start < SILENCE_THRESHOLD_SEC) return;
		n += 1;
		result.push({
			id: `silence_${n}`,
			segmentId: "silence",
			startSec: start,
			endSec: end,
			text: "[silence]",
		});
	};
	for (const word of sorted) {
		pushGap(cursor, word.startSec);
		result.push(word);
		cursor = Math.max(cursor, word.endSec);
	}
	if (typeof clipEndSec === "number" && Number.isFinite(clipEndSec)) {
		pushGap(cursor, clipEndSec);
	}
	return result;
}

/** A contiguous run of removed words inside one clip's source range. */
export interface TrimRun {
	/** Id of the trim range this run came from (used by the bin-icon restore). */
	trimId: string;
	/** Index of the first removed word in `words`. */
	startWordIndex: number;
	/** Inclusive index of the last removed word in `words`. */
	endWordIndex: number;
	/** Asset id the trim belongs to. */
	assetId: string;
	/** Wall-clock seconds from the first removed word's start to the last removed word's end. */
	durationSec: number;
}

/**
 * This word AS RENDERED IN THIS CLIP. A transcript belongs to an ASSET, so two clips over
 * the same media project the very same `AxcutWord` twice; `word.id` therefore identifies
 * a moment in the media, never a thing on screen. Anything that points AT the rendered
 * word — the React key, `data-word-id`, the cue highlight, the caret anchor — must use
 * this instead, or it addresses both copies at once.
 *
 * Silence pseudo-words make this unconditional rather than a shared-media special case:
 * `withSilenceGaps` numbers them from 1 per clip, so `silence_1` collides between ANY two
 * clips, related assets or not.
 */
export function clipWordId(clipId: string, wordId: string): string {
	return `${clipId}:${wordId}`;
}

/** One word in the clip's source range, tagged kept / removed. */
export interface ClipWord {
	/** {@link clipWordId} — the word's identity *in this clip*, unique across the pane. */
	id: string;
	word: AxcutWord;
	/** Whether the word is inside a trimRange for this clip's asset. */
	kept: boolean;
	/** Id of the trim range that removed this word, if any. */
	trimId: string | null;
}

/** One clip's contribution to the aggregated flow. */
export interface ClipSection {
	clip: AxcutClip;
	asset: AxcutAsset | null;
	transcript: AxcutTranscript | null;
	words: ClipWord[];
	trimRuns: TrimRun[];
}

function wordsInRange(transcript: AxcutTranscript, startSec: number, endSec: number): AxcutWord[] {
	return transcript.words.filter((w) => w.endSec > startSec && w.startSec < endSec);
}

/** Find the trim range covering this word's center (returns the deepest match). */
function findCoveringTrim(word: AxcutWord, trimRanges: AxcutTrimRange[]): AxcutTrimRange | null {
	const center = (word.startSec + word.endSec) / 2;
	for (const trim of trimRanges) {
		if (center >= trim.startSec && center <= trim.endSec) return trim;
	}
	return null;
}

/**
 * Build one clip section. Words inside the clip's source range that fall
 * inside any trim range for the same asset are marked removed; the rest
 * are kept. Contiguous removed words from the same trim range group into
 * one `TrimRun` (for the trim-duration pill + bin-icon restore).
 */
export function buildClipSection(
	clip: AxcutClip,
	transcript: AxcutTranscript | null,
	asset: AxcutAsset | null,
	trimRanges: AxcutTrimRange[],
): ClipSection {
	// `trimAppliesToClip` — not a bare `assetId` match — is what keeps a cut on the
	// second of two clips over the same media from also greying out the first one's
	// words. Same media, same source range: only the clip anchor tells them apart.
	const clipTrims = trimRanges.filter(
		(trim) =>
			trimAppliesToClip(trim, clip) &&
			trim.endSec > clip.sourceStartSec &&
			trim.startSec < (clip.sourceEndSec ?? Infinity),
	);

	const words = transcript
		? withSilenceGaps(
				wordsInRange(transcript, clip.sourceStartSec, clip.sourceEndSec ?? Infinity),
				clip.sourceStartSec,
				clip.sourceEndSec,
			)
		: [];
	const tagged: ClipWord[] = words.map((word) => {
		const covering = findCoveringTrim(word, clipTrims);
		return {
			id: clipWordId(clip.id, word.id),
			word,
			kept: covering === null,
			trimId: covering?.id ?? null,
		};
	});

	const trimRuns: TrimRun[] = [];
	let runStart = -1;
	let runEnd = -1;
	let runTrimId = "";
	let runMinStart = 0;
	let runMaxEnd = 0;
	const flush = () => {
		if (runStart >= 0) {
			trimRuns.push({
				trimId: runTrimId,
				assetId: clip.assetId,
				startWordIndex: runStart,
				endWordIndex: runEnd,
				durationSec: Math.max(0, runMaxEnd - runMinStart),
			});
		}
		runStart = -1;
		runEnd = -1;
		runTrimId = "";
		runMinStart = 0;
		runMaxEnd = 0;
	};
	tagged.forEach((cw, i) => {
		if (cw.kept) {
			flush();
			return;
		}
		// Split the run if the trim range id changes (overlapping trims).
		if (runStart >= 0 && cw.trimId !== runTrimId) {
			flush();
		}
		if (runStart < 0) {
			runStart = i;
			runMinStart = cw.word.startSec;
			runTrimId = cw.trimId ?? "";
		}
		runEnd = i;
		runMaxEnd = Math.max(runMaxEnd, cw.word.endSec);
	});
	flush();

	return { clip, asset, transcript, words: tagged, trimRuns };
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
	trimRanges: AxcutTrimRange[],
): ClipSection[] {
	const transcriptById = new Map(transcripts.map((t) => [t.assetId, t]));
	const assetById = new Map(assets.map((a) => [a.id, a]));
	return clips.map((clip) =>
		buildClipSection(
			clip,
			transcriptById.get(clip.assetId) ?? null,
			assetById.get(clip.assetId) ?? null,
			trimRanges,
		),
	);
}

/** Where the playback head currently is, in source time. */
export interface CuePosition {
	assetId: string;
	/** Which clip is playing — the primary selector for the cue's section. Source time is
	 *  per asset, so `assetId` cannot separate two clips over one media; pass this whenever
	 *  the caller knows it (the transcript pane always does). */
	clipId?: string;
	sourceTimeSec: number;
}

/**
 * Find the word in `sections` that the playback head is currently inside, as a
 * {@link clipWordId} — NOT a bare `word.id`, which would name the same moment in every
 * clip drawing on that media and light up all of them. Used to highlight the active word
 * and auto-scroll the transcript. Mirrors axcut's `findCueWordId` in CurrentTranscriptView.
 *
 *   - If the head is before the first word → null.
 *   - If the head is between two words        → the previous word (so the
 *     highlight "sticks" until the next word starts).
 *   - Silence tokens (id starts with `silence_`) are skipped over so a
 *     long pause doesn't surface a fake cue word.
 *
 * The section is chosen by `cue.clipId` when the caller knows which clip is playing.
 * Matching on `assetId` alone always resolved to the FIRST section of that asset, so with
 * a clip duplicated on the timeline the cue tracked clip 1 while clip 2 played. `assetId`
 * stays as the fallback for callers that have no clip in hand.
 */
export function findCueWordId(sections: ClipSection[], cue: CuePosition | null): string | null {
	if (!cue) return null;
	const withWords = sections.filter((s) => s.words.length > 0);
	// No fallback when `clipId` is given but that clip has no transcript: the playing clip
	// simply has no cue word, and borrowing another clip's would point at the wrong text.
	const match = cue.clipId
		? withWords.find((s) => s.clip.id === cue.clipId)
		: withWords.find((s) => s.clip.assetId === cue.assetId);
	if (!match) return null;

	const t = cue.sourceTimeSec;
	let previous: string | null = null;
	for (const cw of match.words) {
		if (isSilenceWord(cw.word)) continue;
		if (t < cw.word.startSec) return previous;
		if (t >= cw.word.startSec && t <= cw.word.endSec) return cw.id;
		previous = cw.id;
	}
	return previous;
}
