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

import type { AxcutAsset, AxcutAudioTrack, AxcutClip, AxcutTranscript, AxcutWord } from "../schema";
import { type RawSpan, type RemovedRawSpan, removalAt } from "./programme-time";

/**
 * The unit the aggregation actually runs over: one stretch of ONE asset's source
 * time, laid somewhere on the timeline (issue #560).
 *
 * `AxcutClip` is one provider of this and was, for a long time, the only one —
 * which is why everything downstream is still named after clips. A voiceover is
 * the second: speech that the transcript tab could not see, because the tab was
 * wired to `timeline.clips` rather than to the shape clips happen to have.
 *
 * Deliberately structural rather than a union of the two record types. Nothing
 * below this line needs to know which lane a section came from, and the moment it
 * could ask, something would start behaving differently per lane — which is the
 * one thing this parameterisation is meant to prevent.
 */
export interface TranscriptPlacement {
	/** Unique on the timeline. Namespaces every rendered word (see {@link clipWordId}). */
	id: string;
	assetId: string;
	sourceStartSec: number;
	/** Open-ended when the placement runs to the end of its source. */
	sourceEndSec?: number;
	/** Where the window lands on the RAW ruler. Source time is per asset, so this is
	 *  the only thing that turns a word back into a moment the playhead can seek to. */
	timelineStartSec: number;
}

/** Which lane's speech the transcript tab is reading. */
export type TranscriptLane = "recording" | "voiceover";

/**
 * A source second of this placement's asset, as a moment on the RAW ruler.
 *
 * The one coordinate both lanes share. Source time is per asset, so it cannot say
 * whether two things coincide; raw time can, which is why kept-or-removed is asked here
 * and not in source time (issue #560).
 */
export function placementRawSec(placement: TranscriptPlacement, sourceSec: number): number {
	return placement.timelineStartSec + (sourceSec - placement.sourceStartSec);
}

/** The placement's own stretch of raw ruler, or null when it runs open-ended. */
export function placementRawExtent(placement: TranscriptPlacement): RawSpan | null {
	if (placement.sourceEndSec === undefined) return null;
	return {
		startSec: placement.timelineStartSec,
		endSec: placementRawSec(placement, placement.sourceEndSec),
	};
}

/** Gaps between words at least this long are surfaced as a `[silence]` token. */
export const SILENCE_THRESHOLD_SEC = 0.2;

/** True for the synthetic `[silence]` pseudo-words inserted by `withSilenceGaps`. */
export function isSilenceWord(word: AxcutWord): boolean {
	return word.id.startsWith("silence_");
}

/** True for a word the user typed in, which no one said and nothing in the media carries.
 *  Keyed on `source`, never on the id: the id shape is only there to stop a transcription
 *  run from reusing it. */
export function isInsertedWord(word: AxcutWord): boolean {
	return word.source === "synth";
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
	// Sorted by time, ties broken by the order the transcript stores them in. The tie is
	// not hypothetical: a word inserted between two contiguous words has no duration and
	// therefore shares its start with the one it sits against, and only the array says
	// which of the two the reader sees first.
	const order = new Map(words.map((word, index) => [word.id, index]));
	const sorted = [...words].sort(
		(a, b) => a.startSec - b.startSec || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
	);
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
	/**
	 * The trims that took this run — SEVERAL when they overlap, and EMPTY when the run
	 * sits in a gap between clips, which is missing from the film without anything having
	 * removed it. A restore affordance must be keyed on this being non-empty: there is no
	 * pill to click for a gap.
	 */
	trimIds: string[];
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
	/** Whether the raw moment this word occupies is still in the film. */
	kept: boolean;
	/** The trims that took it — empty when kept, and empty for a word over a gap. */
	trimIds: string[];
}

/** One placement's contribution to the aggregated flow. */
export interface ClipSection {
	/** Named `clip` for its history, not its type — see {@link TranscriptPlacement}. */
	clip: TranscriptPlacement;
	asset: AxcutAsset | null;
	transcript: AxcutTranscript | null;
	words: ClipWord[];
	trimRuns: TrimRun[];
}

function wordsInRange(transcript: AxcutTranscript, startSec: number, endSec: number): AxcutWord[] {
	return transcript.words.filter((w) =>
		// An inserted word dropped between two words that run into each other has NO
		// duration, and an overlap test excludes a point at either edge of the range —
		// which silently lost every word inserted at the very start of a clip. A word with
		// no span is in the clip when its moment is.
		w.endSec > w.startSec
			? w.endSec > startSec && w.startSec < endSec
			: w.startSec >= startSec && w.startSec < endSec,
	);
}

/**
 * Build one placement's section. A word is removed when the RAW moment it occupies is not
 * in the film; the rest are kept. Contiguous removed words taken by the same trims group
 * into one `TrimRun` (for the trim-duration pill + bin-icon restore).
 *
 * Takes the precomputed removed set, not the trim rows. Filtering rows by identity —
 * `trimAppliesToClip`, which is what this did — is a question a voiceover placement can
 * never answer yes to: it carries an audio fragment id and an audio asset, while every
 * trim carries a video clip. That is what left the voiceover lane reading every word as
 * kept over film that had been cut away (issue #560). Asking the ruler instead makes both
 * lanes agree by construction, and keeps the recording lane's answers identical: the same
 * per-clip walk decides both.
 */
export function buildClipSection(
	clip: TranscriptPlacement,
	transcript: AxcutTranscript | null,
	asset: AxcutAsset | null,
	removed: RemovedRawSpan[],
): ClipSection {
	const words = transcript
		? withSilenceGaps(
				wordsInRange(transcript, clip.sourceStartSec, clip.sourceEndSec ?? Infinity),
				clip.sourceStartSec,
				clip.sourceEndSec,
			)
		: [];
	const tagged: ClipWord[] = words.map((word) => {
		// The word's CENTRE, mirroring the rule the identity filter used, so the recording
		// lane's tagging does not shift under this change.
		const covering = removalAt(removed, placementRawSec(clip, (word.startSec + word.endSec) / 2));
		return {
			id: clipWordId(clip.id, word.id),
			word,
			kept: covering === null,
			trimIds: covering?.trimIds ?? [],
		};
	});

	const trimRuns: TrimRun[] = [];
	let runStart = -1;
	let runEnd = -1;
	let runTrimIds: string[] = [];
	let runMinStart = 0;
	let runMaxEnd = 0;
	const flush = () => {
		if (runStart >= 0) {
			trimRuns.push({
				trimIds: runTrimIds,
				assetId: clip.assetId,
				startWordIndex: runStart,
				endWordIndex: runEnd,
				durationSec: Math.max(0, runMaxEnd - runMinStart),
			});
		}
		runStart = -1;
		runEnd = -1;
		runTrimIds = [];
		runMinStart = 0;
		runMaxEnd = 0;
	};
	const key = (ids: string[]) => ids.join("|");
	tagged.forEach((cw, i) => {
		if (cw.kept) {
			flush();
			return;
		}
		// Split the run when the SET of trims changes, so two cuts meeting at a word
		// boundary stay two pills. A run whose set is empty is a gap between clips: still
		// removed, still one run, but with nothing to restore.
		if (runStart >= 0 && key(cw.trimIds) !== key(runTrimIds)) {
			flush();
		}
		if (runStart < 0) {
			runStart = i;
			runMinStart = cw.word.startSec;
			runTrimIds = cw.trimIds;
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
	clips: TranscriptPlacement[],
	transcripts: AxcutTranscript[],
	assets: AxcutAsset[],
	removed: RemovedRawSpan[],
): ClipSection[] {
	const transcriptById = new Map(transcripts.map((t) => [t.assetId, t]));
	const assetById = new Map(assets.map((a) => [a.id, a]));
	return clips.map((clip) =>
		buildClipSection(
			clip,
			transcriptById.get(clip.assetId) ?? null,
			assetById.get(clip.assetId) ?? null,
			removed,
		),
	);
}

/**
 * The voiceover lane as placements, in timeline order.
 *
 * Music is excluded here rather than filtered downstream: it is not transcribed at
 * all (STT on a bed is noise we pay for), so a music placement could only ever
 * produce an empty section that reads as a failed transcription.
 *
 * One placement PER FRAGMENT, not per user-visible track. A track that spans a cut
 * is ventilated into a fragment per clip, each with its own `offsetMs` advanced by
 * what its predecessors consumed (`anchorAudioTrackFragments`) — so the fragments
 * already carry exactly the source windows this needs, and collapsing them back
 * into one pill here would re-read the file from its head at every cut.
 *
 * A LOOPING take contributes nothing at all. `anchorAudioTrackFragments` deliberately
 * does not advance `offsetMs` across the fragments of a looping track, so their words map
 * to raw moments the words do not occupy — a placement built from them would read
 * kept-or-removed on false evidence, and would author a cut in the wrong place.
 */
export function voiceoverPlacements(audioTracks: AxcutAudioTrack[]): TranscriptPlacement[] {
	return audioTracks
		.filter((track) => track.kind === "voiceover" && !track.loop)
		.slice()
		.sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id))
		.map((track) => {
			const offsetSec = track.offsetMs / 1000;
			return {
				id: track.id,
				assetId: track.assetId,
				sourceStartSec: offsetSec,
				sourceEndSec: offsetSec + Math.max(0, track.endMs - track.startMs) / 1000,
				timelineStartSec: track.startMs / 1000,
			};
		});
}

/** The placements a lane contributes, in timeline order. */
export function lanePlacements(
	lane: TranscriptLane,
	clips: AxcutClip[],
	audioTracks: AxcutAudioTrack[],
): TranscriptPlacement[] {
	return lane === "voiceover" ? voiceoverPlacements(audioTracks) : clips;
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
 * Takes a RAW ruler second. It used to take a clip id resolved from the playhead, which
 * only ever named a video clip — so the voiceover lane never highlighted anything at all.
 * Raw time is what both lanes have in common, and it also settles the case the clip id was
 * introduced for: with one clip duplicated on the timeline, the two sections occupy
 * different raw extents even though their source ranges are identical.
 *
 * The section is the one whose raw extent contains the head. An open-ended placement (a
 * clip whose media has not been probed) has no extent of its own and runs to the next
 * section's head, then to the end of time.
 */
export function findCueWordId(sections: ClipSection[], rawSec: number | null): string | null {
	if (rawSec === null || !Number.isFinite(rawSec)) return null;
	// No fallback to a neighbouring section: a placement with no transcript simply has no
	// cue word, and borrowing another's would point at the wrong text.
	const withWords = sections
		.filter((s) => s.words.length > 0)
		.sort((a, b) => a.clip.timelineStartSec - b.clip.timelineStartSec);

	let match: ClipSection | null = null;
	for (const [i, section] of withWords.entries()) {
		if (rawSec < section.clip.timelineStartSec) break;
		const extent = placementRawExtent(section.clip);
		const endSec =
			extent?.endSec ?? withWords[i + 1]?.clip.timelineStartSec ?? Number.POSITIVE_INFINITY;
		if (rawSec < endSec) {
			match = section;
			break;
		}
	}
	if (!match) return null;

	// Back to the placement's own source clock, which is what the words are stamped in.
	const t = match.clip.sourceStartSec + (rawSec - match.clip.timelineStartSec);
	let previous: string | null = null;
	for (const cw of match.words) {
		if (isSilenceWord(cw.word)) continue;
		if (t < cw.word.startSec) return previous;
		if (t >= cw.word.startSec && t <= cw.word.endSec) return cw.id;
		previous = cw.id;
	}
	return previous;
}
