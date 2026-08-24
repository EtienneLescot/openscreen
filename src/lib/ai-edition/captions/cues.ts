// Caption cues, derived from the transcript.
//
// Captions are a *view* over `document.transcripts` — nothing here is stored.
// The transcript owns the words and their timings (source time, per asset); the
// clips decide which of those survive and where they land on the ruler; the
// caption settings decide how many words share a line. Change any of the three
// and the cues follow on the next render, with no regeneration step and no
// stale copy to reconcile.
//
// Two coordinate systems meet here:
//   - transcript words / segments: SOURCE seconds, per asset.
//   - cues:                        VIRTUAL (timeline) ms, what the preview uses.
// The export path takes the same virtual cues and projects them back to source
// through `projectRegionsToSourceTime`, exactly like annotations, so preview and
// export cannot drift apart.

import type { AnnotationRegion } from "@/components/video-editor/types";
import {
	dedupeAdjacentCaptionRepeats,
	finalizeCaptionSegmentsForPlayback,
	groupTimedCaptionWordsIntoLines,
	splitMergedCaptionsByWordBounds,
} from "@/lib/captioning/annotationsFromCaptions";
import type { CaptionSegment } from "@/lib/captioning/transcribe";
import type { AxcutClip, AxcutDocument, AxcutTranscript } from "../schema";
import {
	type CaptionAnchorV,
	type CaptionSettings,
	captionBackgroundCss,
	captionBoxRect,
} from "./settings";
import { type CaptionTranslations, captionTranslationUnits } from "./translations";

/** One on-screen caption line, in whichever time base the producer documented. */
export interface CaptionCue {
	id: string;
	startMs: number;
	endMs: number;
	text: string;
}

/** Captions draw above every user annotation so a blur or a sticker can't bury
 *  the subtitle. Well clear of the annotation z-range, which counts up from 1. */
export const CAPTION_Z_INDEX_BASE = 100_000;

function toCaptionSegments(transcript: AxcutTranscript): CaptionSegment[] {
	return transcript.words
		.filter((word) => word.text.trim().length > 0)
		.map((word) => ({ startSec: word.startSec, endSec: word.endSec, text: word.text }));
}

function segmentWordsAsCaptionSegments(
	transcript: AxcutTranscript,
	segmentId: string,
): CaptionSegment[] {
	const segment = transcript.segments.find((s) => s.id === segmentId);
	if (!segment) return [];
	const byId = new Map(transcript.words.map((w) => [w.id, w]));
	return segment.wordIds
		.map((id) => byId.get(id))
		.filter((w): w is NonNullable<typeof w> => w !== undefined && w.text.trim().length > 0)
		.map((w) => ({ startSec: w.startSec, endSec: w.endSec, text: w.text }));
}

/**
 * Spread a piece of text across a span as one entry per word, timed by character
 * weight. This is how translated text gets timings: a translation has its own
 * word count and word order, so the source's per-word timestamps cannot carry
 * over — but the span it was spoken in can, and does.
 */
function textAsPseudoWords(startSec: number, endSec: number, text: string): CaptionSegment[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	return splitMergedCaptionsByWordBounds([{ startSec, endSec, text: trimmed }], 1, 1);
}

/**
 * One asset's caption lines in SOURCE seconds.
 *
 * Both languages go through the SAME final step — a stream of timed single words
 * fed to `groupTimedCaptionWordsIntoLines`. That is the whole point: line layout
 * (words per line, breaking on real pauses) must not depend on which language is
 * showing. Only where the words come from differs:
 *
 *   - original:   the transcript's own word timestamps.
 *   - translated: each translation unit's text spread across the unit's span,
 *                 falling back to the original words for units not translated
 *                 yet, so a partial translation still plays.
 *
 * Grouping into units before translating also matters upstream: a Whisper
 * transcript stores one segment per word, so translating per segment would have
 * translated word by word.
 */
export function captionLinesForAsset(
	transcript: AxcutTranscript,
	settings: CaptionSettings,
	translations: CaptionTranslations,
): CaptionSegment[] {
	const minWords = settings.minWordsPerLine;
	const maxWords = settings.maxWordsPerLine;

	// Whisper repeats a phrase across chunk boundaries often enough that raw lines
	// would stutter on screen; the dedupe + overlap trim are the same pass the old
	// caption generator ran before writing annotations, kept because the artefact
	// is in the transcript, not in how it used to be stored.
	const polish = (lines: CaptionSegment[]) =>
		finalizeCaptionSegmentsForPlayback(dedupeAdjacentCaptionRepeats(lines));

	const stream =
		settings.language === null
			? originalWordStream(transcript)
			: translatedWordStream(transcript, translations, settings.language);

	if (stream.length === 0) return [];
	return polish(groupTimedCaptionWordsIntoLines(stream, minWords, maxWords));
}

function originalWordStream(transcript: AxcutTranscript): CaptionSegment[] {
	const words = toCaptionSegments(transcript);
	if (words.length > 0) return words;
	// A transcript with segments but no words (hand-authored / imported) still
	// deserves captions — spread each segment's own text across its span.
	return transcript.segments.flatMap((s) => textAsPseudoWords(s.startSec, s.endSec, s.text));
}

function translatedWordStream(
	transcript: AxcutTranscript,
	translations: CaptionTranslations,
	language: string,
): CaptionSegment[] {
	const translated = translations[language]?.byAsset[transcript.assetId] ?? {};
	return captionTranslationUnits(transcript).flatMap((unit) => {
		const replacement = translated[unit.id];
		if (typeof replacement === "string" && replacement.trim()) {
			return textAsPseudoWords(unit.startSec, unit.endSec, replacement);
		}
		// Not translated yet — keep the original words, with their real timings.
		const originals = unit.segmentIds.flatMap((id) =>
			segmentWordsAsCaptionSegments(transcript, id),
		);
		return originals.length > 0
			? originals
			: textAsPseudoWords(unit.startSec, unit.endSec, unit.text);
	});
}

/**
 * Map a source-time span onto the ruler through the clips that play it.
 *
 * The inverse of `virtualSpanToSourceSpans` (region-ventilation): a line whose
 * source range is split across two clips — or played twice by a duplicated clip —
 * yields one timeline span per covering clip, so the caption appears wherever
 * its audio actually plays and nowhere else. A span no clip plays yields [].
 */
export function sourceSpanToTimelineSpans(
	assetId: string,
	startSec: number,
	endSec: number,
	clips: AxcutClip[],
): Array<{ startSec: number; endSec: number }> {
	const out: Array<{ startSec: number; endSec: number }> = [];
	for (const clip of clips) {
		if (clip.assetId !== assetId) continue;
		const clipSourceEnd = clip.sourceEndSec ?? Number.POSITIVE_INFINITY;
		const s = Math.max(startSec, clip.sourceStartSec);
		const e = Math.min(endSec, clipSourceEnd);
		if (e <= s) continue;
		out.push({
			startSec: clip.timelineStartSec + (s - clip.sourceStartSec),
			endSec: clip.timelineStartSec + (e - clip.sourceStartSec),
		});
	}
	return out;
}

/**
 * Every caption cue for the document, in VIRTUAL (timeline) ms.
 *
 * Returns [] when the layer is off — the caller doesn't need to check twice, and
 * "hidden" costs nothing to render.
 */
export function deriveCaptionCues(
	document: AxcutDocument | null | undefined,
	settings: CaptionSettings,
	translations: CaptionTranslations,
): CaptionCue[] {
	if (!document || !settings.enabled) return [];
	const clips = document.timeline.clips;
	if (clips.length === 0) return [];

	const transcripts = new Map(document.transcripts.map((t) => [t.assetId, t]));
	// A transcript is only projected once per asset even when several clips draw
	// from it (line grouping is the expensive part, clipping is cheap).
	const linesByAsset = new Map<string, CaptionSegment[]>();
	const cues: CaptionCue[] = [];
	let n = 0;

	for (const assetId of new Set(clips.map((c) => c.assetId))) {
		const transcript = transcripts.get(assetId);
		if (!transcript) continue;
		linesByAsset.set(assetId, captionLinesForAsset(transcript, settings, translations));
	}

	for (const [assetId, lines] of linesByAsset) {
		for (const line of lines) {
			const text = line.text.trim();
			if (!text) continue;
			for (const span of sourceSpanToTimelineSpans(assetId, line.startSec, line.endSec, clips)) {
				const startMs = Math.round(span.startSec * 1000);
				const endMs = Math.max(Math.round(span.endSec * 1000), startMs + 1);
				cues.push({ id: `caption-${n++}`, startMs, endMs, text });
			}
		}
	}

	cues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
	// Lines from one asset can't overlap, but two clips playing overlapping
	// source ranges can put two cues on the same instant. Keep the ruler honest
	// by ending the earlier one where the later begins.
	for (let i = 1; i < cues.length; i++) {
		const prev = cues[i - 1];
		const cur = cues[i];
		if (prev.endMs > cur.startMs) prev.endMs = Math.max(prev.startMs + 1, cur.startMs);
	}
	return cues;
}

/** The cue playing at `timeMs`, or null. Ties go to the one that started later,
 *  which is what "the next line has taken over" looks like. */
export function captionCueAt(cues: CaptionCue[], timeMs: number): CaptionCue | null {
	let found: CaptionCue | null = null;
	for (const cue of cues) {
		if (timeMs >= cue.startMs && timeMs < cue.endMs) found = cue;
		else if (cue.startMs > timeMs) break;
	}
	return found;
}

/**
 * A caption's region, which is an `AnnotationRegion` measured against a different box.
 *
 * The `space` marker is why this type exists instead of a field on `AnnotationRegion`:
 * an annotation is authored on top of the visible video and must keep tracking the
 * screen rect, while a caption belongs to the output frame. Widening the shared type
 * would also put a frame-space band — whose `y` legitimately goes negative when it
 * overhangs the frame edge — through `annotationRegionSchema`, which bounds position
 * to 0..100. Captions are never stored, so they never meet that schema.
 */
export type CaptionTextRegion = AnnotationRegion & {
	space: "frame";
	/** Which edge of the drawn block the compositor pins to the region's box. Carried
	 *  here rather than on `AnnotationTextStyle` for the same reason as `space`: an
	 *  annotation must keep rendering centred, and widening the shared style would put
	 *  the key in every stored annotation's payload. */
	verticalAlign: CaptionAnchorV;
};

/**
 * Cues as text annotation regions, so the export renderer draws captions through
 * the exact same text path as annotations (wrapping, background plate,
 * alignment) instead of a second, subtly-different implementation.
 *
 * These regions are synthetic: they are never stored in the document and carry
 * no `annotationSource` marker, because they are not annotations.
 */
export function captionCuesToTextRegions(
	cues: CaptionCue[],
	settings: CaptionSettings,
	aspectValue: number,
): CaptionTextRegion[] {
	const rect = captionBoxRect(settings, aspectValue);
	return cues.map((cue, index) => ({
		space: "frame" as const,
		// The edge the compositor pins the drawn block to inside `size`. Without it the
		// rasterizers centre the block — which is what made a caption drift vertically
		// every time its text wrapped to another line.
		verticalAlign: rect.verticalAlign,
		id: cue.id,
		startMs: cue.startMs,
		endMs: cue.endMs,
		type: "text" as const,
		content: cue.text,
		position: { x: rect.x, y: rect.y },
		size: { width: rect.width, height: rect.height },
		style: {
			color: settings.color,
			backgroundColor: captionBackgroundCss(settings),
			fontSize: settings.fontSize,
			fontFamily: settings.fontFamily,
			fontWeight: settings.fontWeight,
			fontStyle: "normal" as const,
			textDecoration: "none" as const,
			// One horizontal control, not two: `anchorH` picks which edge of the block is
			// pinned to the column, and the rasterizers' plate maths already snaps the
			// plate onto that edge (`text_linux.rs` `plate_x`, and its two mirrors).
			textAlign: settings.anchorH,
			textAnimation: "none" as const,
		},
		zIndex: CAPTION_Z_INDEX_BASE + index,
	}));
}
