import type { CaptionSegment } from "./transcribe";

/** Nudge caption starts earlier (seconds); Whisper onsets run slightly late. Do not offset ends too, that pulls lines off-screen early. */
const AUTO_CAPTION_START_BIAS_SEC = 0;

/** Extra hold after Whisper's segment end (seconds); model end times run early vs trailing vowels. Separate from the start bias. */
const AUTO_CAPTION_END_HOLD_SEC = 0;

/** Inside one Whisper phrase, sub-lines can be shorter (do not steal time from neighbors). */
const WORD_SPLIT_MIN_SPAN_SEC = 0.02;

/** Brief linger after the last word in a line (seconds); trimmed if it would overlap the next line. */
const CAPTION_LINE_END_TAIL_SEC = 0;

/** A real silence between word-level timestamps should start a new caption run. */
const WORD_RUN_BREAK_GAP_SEC = 0.24;

/** Same text again with almost no gap or overlap; common Whisper/chunk artifact. */
const DEDUPE_SAME_TEXT_MAX_GAP_SEC = 0.55;

export const SAME_CONTENT_ECHO_MAX_GAP_SEC = 1.15;

function normalizeCaptionKey(text: string): string {
	return text
		.trim()
		.replace(/\s+/g, " ")
		.replace(/[\u2018\u2019]/g, "'")
		.replace(/[\u201C\u201D]/g, '"')
		.toLowerCase()
		.replace(/[.!?,;:]+$/g, "");
}

/** Legacy echo-collapse helper kept for reference while phrase timing uses raw model spans. */
export function collapseSameContentEchoes(segments: CaptionSegment[]): CaptionSegment[] {
	const sorted = [...segments]
		.filter((s) => s.text.trim())
		.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
	const out: CaptionSegment[] = [];
	const lastIndexByKey = new Map<string, number>();

	for (const seg of sorted) {
		const key = normalizeCaptionKey(seg.text);
		const hit = lastIndexByKey.get(key);
		if (hit !== undefined) {
			const prev = out[hit]!;
			if (seg.startSec < prev.endSec + SAME_CONTENT_ECHO_MAX_GAP_SEC) {
				prev.startSec = Math.min(prev.startSec, seg.startSec);
				prev.endSec = Math.max(prev.endSec, seg.endSec);
				continue;
			}
		}
		out.push({
			startSec: seg.startSec,
			endSec: seg.endSec,
			text: seg.text.trim(),
		});
		lastIndexByKey.set(key, out.length - 1);
	}
	return out;
}

/**
 * Collapse adjacent duplicate lines (overlapping or tiny gap). Does not merge the same phrase
 * repeated later in the video when separated by real silence.
 */
export function dedupeAdjacentCaptionRepeats(segments: CaptionSegment[]): CaptionSegment[] {
	const sorted = [...segments]
		.filter((s) => s.text.trim())
		.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
	const out: CaptionSegment[] = [];
	for (const seg of sorted) {
		const t = seg.text.trim();
		const prev = out[out.length - 1];
		if (prev && normalizeCaptionKey(prev.text) === normalizeCaptionKey(t)) {
			const overlap = prev.endSec - seg.startSec;
			const gap = seg.startSec - prev.endSec;
			if (overlap > 0.015 || gap < DEDUPE_SAME_TEXT_MAX_GAP_SEC) {
				prev.startSec = Math.min(prev.startSec, seg.startSec);
				prev.endSec = Math.max(prev.endSec, seg.endSec);
				continue;
			}
		}
		out.push({ startSec: seg.startSec, endSec: seg.endSec, text: t });
	}
	return out;
}

/** Trim only real overlaps. Avoid synthetic lead/lag so caption timing matches model output. */
export function finalizeCaptionSegmentsForPlayback(segments: CaptionSegment[]): CaptionSegment[] {
	const OVERLAP_TRIM_SEC = 0.002;

	const sortedRaw = [...segments]
		.filter((s) => s.text.trim())
		.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);

	const a = sortedRaw.map((seg) => {
		let s = seg.startSec + AUTO_CAPTION_START_BIAS_SEC;
		let e = seg.endSec + AUTO_CAPTION_END_HOLD_SEC;
		s = Math.max(0, s);
		if (e <= s) e = s + 0.02;
		return { startSec: s, endSec: e, text: seg.text.trim() };
	});

	for (let i = 1; i < a.length; i++) {
		if (a[i].startSec < a[i - 1].endSec - OVERLAP_TRIM_SEC) {
			a[i - 1].endSec = Math.max(a[i - 1].startSec + 1e-4, a[i].startSec);
		}
	}

	return a;
}

/** Join phrases that are close in time so the editor does not create dozens of separate overlays. */
export function mergeAdjacentCaptionSegments(
	segments: CaptionSegment[],
	options?: { maxGapSec?: number; maxChars?: number; maxBlockDurationSec?: number },
): CaptionSegment[] {
	const maxGapSec = options?.maxGapSec ?? 1.35;
	const maxChars = options?.maxChars ?? 320;
	const maxBlockDurationSec = options?.maxBlockDurationSec ?? 12;

	const sorted = [...segments].sort((a, b) => a.startSec - b.startSec);
	const out: CaptionSegment[] = [];

	for (const seg of sorted) {
		const text = seg.text.trim();
		if (!text) continue;

		const prev = out[out.length - 1];
		if (!prev) {
			out.push({ startSec: seg.startSec, endSec: seg.endSec, text });
			continue;
		}

		const gap = seg.startSec - prev.endSec;
		const mergedText = `${prev.text} ${text}`.trim();
		const mergedEnd = Math.max(prev.endSec, seg.endSec);
		const wouldSpan = mergedEnd - prev.startSec;
		if (gap <= maxGapSec && mergedText.length <= maxChars && wouldSpan <= maxBlockDurationSec) {
			prev.endSec = mergedEnd;
			prev.text = mergedText;
		} else {
			out.push({ startSec: seg.startSec, endSec: seg.endSec, text });
		}
	}

	return out;
}

function partitionPhraseCaptionSegments(
	segments: CaptionSegment[],
	options?: { maxGapSec?: number; maxChars?: number; maxBlockDurationSec?: number },
): CaptionSegment[][] {
	const maxGapSec = options?.maxGapSec ?? 0;
	const maxChars = options?.maxChars ?? Number.POSITIVE_INFINITY;
	const maxBlockDurationSec = options?.maxBlockDurationSec ?? Number.POSITIVE_INFINITY;

	const sorted = [...segments]
		.filter((s) => s.text.trim())
		.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
	if (sorted.length === 0) return [];

	const groups: CaptionSegment[][] = [];
	let current: CaptionSegment[] = [];

	for (const seg of sorted) {
		const text = seg.text.trim();
		if (!text) continue;

		if (current.length === 0) {
			current.push({ ...seg, text });
			continue;
		}

		const prev = current[current.length - 1]!;
		const groupStart = current[0]!.startSec;
		const gap = seg.startSec - prev.endSec;
		const currentChars = current.reduce((sum, item) => sum + item.text.length, 0);
		const wouldChars = currentChars + 1 + text.length;
		const wouldSpan = Math.max(prev.endSec, seg.endSec) - groupStart;

		if (gap <= maxGapSec && wouldChars <= maxChars && wouldSpan <= maxBlockDurationSec) {
			current.push({ ...seg, text });
			continue;
		}

		groups.push(current);
		current = [{ ...seg, text }];
	}

	if (current.length > 0) {
		groups.push(current);
	}

	return groups;
}

export interface CaptionSegmentLayoutOptions {
	/** Lower bound on words per on-screen caption (default 2). */
	minWordsPerCaption?: number;
	/** Upper bound on words per on-screen caption (default 7). */
	maxWordsPerCaption?: number;
	/**
	 * `word`: each `CaptionSegment` is a single token with Whisper word timestamps (default).
	 * `phrase`: merged phrase spans; use proportional line splitting inside each span.
	 */
	timestampGranularity?: "word" | "phrase";
}

function computeCaptionLineIndexRanges(
	wordCount: number,
	minWords: number,
	maxWords: number,
): Array<{ from: number; to: number }> {
	const minW = Math.max(1, Math.min(Math.floor(minWords), Math.floor(maxWords)));
	const maxW = Math.max(minW, Math.floor(maxWords));
	const sliceRanges: Array<{ from: number; to: number }> = [];
	let i = 0;
	while (i < wordCount) {
		const remaining = wordCount - i;
		if (remaining <= maxW) {
			if (sliceRanges.length > 0 && remaining < minW) {
				sliceRanges[sliceRanges.length - 1]!.to = wordCount;
			} else {
				sliceRanges.push({ from: i, to: wordCount });
			}
			break;
		}

		let take = maxW;
		const after = remaining - take;
		if (after > 0 && after < minW) {
			take = remaining - minW;
			if (take < minW) {
				sliceRanges.push({ from: i, to: wordCount });
				break;
			}
			if (take > maxW) {
				take = maxW;
			}
		}
		sliceRanges.push({ from: i, to: i + take });
		i += take;
	}
	return sliceRanges;
}

/**
 * Groups per-word segments into on-screen lines using each token's Whisper timestamps
 * (no proportional stretching across a long phrase span).
 */
export function groupTimedCaptionWordsIntoLines(
	segments: CaptionSegment[],
	minWords: number,
	maxWords: number,
): CaptionSegment[] {
	const words = [...segments]
		.filter((s) => s.text.trim())
		.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
	if (words.length === 0) return [];

	const minW = Math.max(1, Math.min(Math.floor(minWords), Math.floor(maxWords)));
	const maxW = Math.max(minW, Math.floor(maxWords));
	const out: CaptionSegment[] = [];

	let runStart = 0;
	const flushRun = (runEndExclusive: number) => {
		const run = words.slice(runStart, runEndExclusive);
		if (run.length === 0) return;
		const ranges = computeCaptionLineIndexRanges(run.length, minW, maxW);
		for (const { from, to } of ranges) {
			const slice = run.slice(from, to);
			const s = slice[0]!.startSec;
			const rawEnd = slice[slice.length - 1]!.endSec;
			const e = Math.max(s + WORD_SPLIT_MIN_SPAN_SEC, rawEnd + CAPTION_LINE_END_TAIL_SEC);
			out.push({
				startSec: s,
				endSec: e,
				text: slice.map((w) => w.text.trim()).join(" "),
			});
		}
	};

	for (let i = 1; i < words.length; i++) {
		const prev = words[i - 1]!;
		const cur = words[i]!;
		const gap = cur.startSec - prev.endSec;
		if (gap >= WORD_RUN_BREAK_GAP_SEC) {
			flushRun(i);
			runStart = i;
		}
	}
	flushRun(words.length);

	for (let i = 0; i < out.length - 1; i++) {
		if (out[i]!.endSec > out[i + 1]!.startSec + 1e-3) {
			out[i]!.endSec = Math.max(
				out[i]!.startSec + WORD_SPLIT_MIN_SPAN_SEC,
				out[i + 1]!.startSec - 1e-4,
			);
		}
	}
	return out;
}

/**
 * Splits each merged transcription span into shorter captions with about
 * `minWords`-`maxWords` words. Times are interpolated by character weight inside the span.
 */
export function splitMergedCaptionsByWordBounds(
	merged: CaptionSegment[],
	minWords: number,
	maxWords: number,
): CaptionSegment[] {
	const minW = Math.max(1, Math.min(Math.floor(minWords), Math.floor(maxWords)));
	const maxW = Math.max(minW, Math.floor(maxWords));
	const out: CaptionSegment[] = [];

	for (const seg of merged) {
		const words = seg.text.trim().split(/\s+/).filter(Boolean);
		if (words.length === 0) continue;

		if (words.length <= maxW) {
			out.push({
				startSec: seg.startSec,
				endSec: seg.endSec,
				text: words.join(" "),
			});
			continue;
		}

		out.push(...splitOneSegmentByWordBounds(seg.startSec, seg.endSec, words, minW, maxW));
	}

	return out;
}

function wrapCaptionTextByWordBounds(text: string, minWords: number, maxWords: number): string {
	const words = text.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return "";
	const minW = Math.max(1, Math.min(Math.floor(minWords), Math.floor(maxWords)));
	const maxW = Math.max(minW, Math.floor(maxWords));
	const ranges = computeCaptionLineIndexRanges(words.length, minW, maxW);
	return ranges.map(({ from, to }) => words.slice(from, to).join(" ")).join("\n");
}

function expandPhraseSegmentToPseudoWords(segment: CaptionSegment): CaptionSegment[] {
	const words = segment.text.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return [];
	if (words.length === 1) {
		return [
			{
				startSec: segment.startSec,
				endSec: segment.endSec,
				text: words[0]!,
			},
		];
	}

	return splitOneSegmentByWordBounds(segment.startSec, segment.endSec, words, 1, 1);
}

export function groupPhraseCaptionSegmentsIntoLines(
	segments: CaptionSegment[],
	minWords: number,
	maxWords: number,
	options?: { maxGapSec?: number; maxChars?: number; maxBlockDurationSec?: number },
): CaptionSegment[] {
	const groups = partitionPhraseCaptionSegments(segments, options);
	const out: CaptionSegment[] = [];

	for (const group of groups) {
		if (group.length === 1) {
			const only = group[0]!;
			const wrapped = wrapCaptionTextByWordBounds(only.text, minWords, maxWords).trim();
			if (!wrapped) continue;
			const lineTexts = wrapped
				.split("\n")
				.map((t) => t.trim())
				.filter(Boolean);
			const n = lineTexts.length;
			const rawDur = only.endSec - only.startSec;
			if (n > 1 && rawDur < n * WORD_SPLIT_MIN_SPAN_SEC) {
				out.push({
					startSec: only.startSec,
					endSec: only.endSec,
					text: lineTexts.join(" "),
				});
				continue;
			}
			const dur = Math.max(rawDur, WORD_SPLIT_MIN_SPAN_SEC * n);
			if (n <= 1) {
				out.push({
					startSec: only.startSec,
					endSec: only.endSec,
					text: lineTexts[0] ?? wrapped,
				});
				continue;
			}
			for (let i = 0; i < n; i++) {
				const startSec = only.startSec + (dur * i) / n;
				const boundary = only.startSec + (dur * (i + 1)) / n;
				const endSec =
					i === n - 1 ? only.endSec : Math.max(startSec + WORD_SPLIT_MIN_SPAN_SEC, boundary);
				out.push({
					startSec,
					endSec,
					text: lineTexts[i]!,
				});
			}
			continue;
		}

		const pseudoWords = group.flatMap(expandPhraseSegmentToPseudoWords);
		out.push(...groupTimedCaptionWordsIntoLines(pseudoWords, minWords, maxWords));
	}

	return out;
}

function splitOneSegmentByWordBounds(
	startSec: number,
	endSec: number,
	words: string[],
	minWords: number,
	maxWords: number,
): CaptionSegment[] {
	const sliceRanges = computeCaptionLineIndexRanges(words.length, minWords, maxWords);

	const dur = Math.max(endSec - startSec, 0.05);
	const weights = words.map((w) => Math.max(1, w.length));
	const totalW = weights.reduce((a, b) => a + b, 0);

	const weightSum = (from: number, to: number) => {
		let s = 0;
		for (let k = from; k < to; k++) s += weights[k] ?? 0;
		return s;
	};

	const result: CaptionSegment[] = [];
	let prevEnd = startSec;
	for (const { from, to } of sliceRanges) {
		const wb = weightSum(0, from);
		const ws = weightSum(from, to);
		let s = startSec + (wb / totalW) * dur;
		let e = startSec + ((wb + ws) / totalW) * dur;
		s = Math.max(s, prevEnd);
		e = Math.max(s + WORD_SPLIT_MIN_SPAN_SEC, e);
		e = Math.min(e, endSec);
		if (e <= s) {
			e = Math.min(endSec, s + WORD_SPLIT_MIN_SPAN_SEC);
		}
		prevEnd = e;
		result.push({
			startSec: s,
			endSec: e,
			text: words.slice(from, to).join(" "),
		});
	}
	if (result.length > 0) {
		result[result.length - 1].endSec = endSec;
		for (let i = 0; i < result.length - 1; i++) {
			if (result[i].endSec > result[i + 1].startSec + 0.002) {
				result[i].endSec = Math.max(result[i].startSec + 1e-4, result[i + 1].startSec);
			}
		}
	}
	return result;
}
