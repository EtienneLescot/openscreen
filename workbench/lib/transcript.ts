// ponytail: the reception shape for REAL word timings.
//
// `lib/fixtures.ts` shipped `words: []` everywhere, and every editorial oracle
// that asks "how many seconds of SPEECH did this cut destroy?" then has to fall
// back on `kind: "silence"` segments — a fixture-authored approximation whose
// boundaries are, by construction, exactly where the scenario put the silences.
// Measuring a model against boundaries invented by the same file that declares
// the answer is close to measuring nothing: the interesting question is what a
// cut does to real speech, whose edges are ragged.
//
// So this module is the door a real Whisper transcript walks through. Nothing
// here is bound to a fixture: `wordsFromWhisper` takes what the recogniser
// emitted, `transcriptFromWords` turns timings into the document's own
// `AxcutTranscript`, and `fixtures.ts` uses the same two functions for its
// synthetic demo, so the synthetic path and the real path cannot drift.
//
// THE ONE RULE: per-word timestamps and evenly-split segment text are NOT the
// same evidence. `document/transcribe.ts:59-71` splits a segment's text over
// its span when the recogniser gave no words, which manufactures a timestamp
// per token; an oracle reporting "the trim ate 0.12 s of speech" from those
// numbers is reporting arithmetic, not measurement. `wordsFromWhisper` labels
// which of the two it found, and `transcriptFromWhisper` refuses the fabricated
// one unless the caller says, in writing, that it accepts it.

import { readFileSync } from "node:fs";
import { type AxcutTranscript, transcriptSchema } from "../../src/lib/ai-edition/schema";
import { mergeSpans, SPAN_EPSILON_SEC, type Span } from "./spans";

/** One recognised word, in SOURCE seconds. */
export interface WordTiming {
	text: string;
	startSec: number;
	endSec: number;
	/** 0–1 when the recogniser reported one. Never used to score — carried so a
	 * future oracle can discount a cut placed on an unsure word. */
	confidence?: number;
}

export type WordTimingSource = "word" | "segment";

export interface LoadedWords {
	words: WordTiming[];
	/**
	 * `"word"` — real per-word timestamps from the recogniser.
	 * `"segment"` — no words in the file; timings derived by splitting a
	 * segment's text evenly across its span. Precision that is not there.
	 */
	timingSource: WordTimingSource;
	/** As reported by the file, when it says. */
	language?: string;
}

/**
 * Gaps at least this long count as a silence worth cutting.
 *
 * The app surfaces `[silence]` tokens from 0.2 s (`aggregated-transcript.ts:20`),
 * which is the right threshold for a caption view and the wrong one here: at
 * 0.2 s every inter-word breath in a real transcript becomes a "silence the
 * model failed to cut", and the coverage oracle drowns. 0.35 s is the shortest
 * gap a listener reads as a pause rather than as diction. Override it per
 * fixture rather than editing this constant.
 */
export const DEFAULT_SILENCE_MIN_SEC = 0.35;

interface RawWord {
	word?: unknown;
	text?: unknown;
	start?: unknown;
	end?: unknown;
	startSec?: unknown;
	endSec?: unknown;
	probability?: unknown;
	confidence?: unknown;
	offsets?: { from?: unknown; to?: unknown };
}

interface RawSegment extends RawWord {
	words?: unknown;
	tokens?: unknown;
}

function num(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Seconds from any of the three spellings a whisper front-end uses:
 * `start`/`end` (s), `startSec`/`endSec` (s), `offsets.from`/`to` (ms). */
function spanOf(raw: RawWord): Span | null {
	const start = num(raw.start) ?? num(raw.startSec);
	const end = num(raw.end) ?? num(raw.endSec);
	if (start !== null && end !== null) return { startSec: start, endSec: Math.max(start, end) };
	const from = num(raw.offsets?.from);
	const to = num(raw.offsets?.to);
	if (from !== null && to !== null) {
		return { startSec: from / 1000, endSec: Math.max(from, to) / 1000 };
	}
	return null;
}

function textOf(raw: RawWord): string {
	const value = typeof raw.word === "string" ? raw.word : raw.text;
	return typeof value === "string" ? value.trim() : "";
}

function wordOf(raw: RawWord): WordTiming | null {
	const span = spanOf(raw);
	const text = textOf(raw);
	if (!span || !text) return null;
	const confidence = num(raw.probability) ?? num(raw.confidence);
	return {
		text,
		startSec: Math.max(0, span.startSec),
		// A recogniser can emit start === end on a clipped word; a zero-length
		// word would then vanish from every span union. Give it one frame.
		endSec: Math.max(span.startSec + 0.02, span.endSec),
		...(confidence === null ? {} : { confidence }),
	};
}

/** Splits a segment's text evenly over its span — the fabricated path, mirroring
 * `document/transcribe.ts:59-71` so the two agree when it IS used. */
function splitSegmentEvenly(raw: RawSegment): WordTiming[] {
	const span = spanOf(raw);
	const text = textOf(raw);
	if (!span || !text) return [];
	const tokens = text.split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return [];
	const each = (span.endSec - span.startSec) / tokens.length;
	return tokens.map((token, index) => ({
		text: token,
		startSec: span.startSec + index * each,
		endSec: span.startSec + (index + 1) * each,
	}));
}

/**
 * Reads word timings out of whatever a whisper front-end produced.
 *
 * Accepted, because these are the shapes this project actually meets:
 *   • `{ segments: [{ start, end, text, words: [{ word, start, end }] }] }`
 *     — OpenAI `verbose_json` and faster-whisper, the shape
 *     `electron/stt/whisperServer.ts:54-70` already parses;
 *   • `{ words: [...] }` — the same words, flat;
 *   • `{ wordSegments: [{ word, startSec, endSec, confidence }] }` — OpenScreen's
 *     own `SttResult` (`electron/stt/index.ts:104`);
 *   • `{ transcription: [{ offsets: {from,to}, tokens: [{ text, offsets }] }] }`
 *     — whisper.cpp `--output-json-full`, whose offsets are MILLISECONDS and
 *     whose per-token timings are real ones;
 *   • segments with no words at all — split evenly, and reported as such.
 */
export function wordsFromWhisper(json: unknown): LoadedWords {
	const root = (json ?? {}) as Record<string, unknown>;
	const language = typeof root.language === "string" ? root.language : undefined;
	const collect = (list: unknown): WordTiming[] =>
		Array.isArray(list) ? list.map((item) => wordOf(item as RawWord)).filter(isWord) : [];

	const flat = [...collect(root.words), ...collect(root.wordSegments)];
	if (flat.length > 0) return { words: sortWords(flat), timingSource: "word", language };

	const segments: RawSegment[] = Array.isArray(root.segments)
		? (root.segments as RawSegment[])
		: Array.isArray(root.transcription)
			? (root.transcription as RawSegment[])
			: [];

	// `tokens` is whisper.cpp's spelling of the same thing. Sub-word pieces
	// rather than words, but the timings are measured, not interpolated — which
	// is the only distinction that matters to an oracle.
	const nested = segments.flatMap((segment) => [
		...collect(segment.words),
		...collect(segment.tokens),
	]);
	if (nested.length > 0) return { words: sortWords(nested), timingSource: "word", language };

	const split = segments.flatMap(splitSegmentEvenly);
	return { words: sortWords(split), timingSource: "segment", language };
}

function isWord(value: WordTiming | null): value is WordTiming {
	return value !== null;
}

function sortWords(words: WordTiming[]): WordTiming[] {
	return [...words].sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
}

export interface TranscriptFromWordsOptions {
	assetId: string;
	words: WordTiming[];
	language?: string;
	/** Trailing silence up to the asset's end is emitted when this is given. */
	durationSec?: number;
	silenceMinSec?: number;
}

/**
 * Groups words into speech segments and materialises the gaps as `kind:
 * "silence"` segments — the two things the agent's `getTranscript` shows and
 * the only source it has for "where are the silences".
 *
 * Note what this does NOT do: it never rounds a boundary to a tidy number. The
 * ragged edges are the point; a cut placed 40 ms into a word is a defect the
 * hand-written fixtures literally cannot express.
 */
export function transcriptFromWords(options: TranscriptFromWordsOptions): AxcutTranscript {
	const silenceMinSec = options.silenceMinSec ?? DEFAULT_SILENCE_MIN_SEC;
	const words = sortWords(options.words).filter((w) => w.endSec > w.startSec);
	const segments: Array<Record<string, unknown>> = [];
	const outWords: Array<Record<string, unknown>> = [];

	const flushSilence = (startSec: number, endSec: number) => {
		if (endSec - startSec < silenceMinSec) return;
		segments.push({
			id: `seg_${segments.length + 1}`,
			kind: "silence",
			startSec,
			endSec,
			text: "",
			wordIds: [],
		});
	};

	let group: WordTiming[] = [];
	const flushSpeech = () => {
		if (group.length === 0) return;
		const segmentId = `seg_${segments.length + 1}`;
		const wordIds: string[] = [];
		for (const word of group) {
			const id = `word_${outWords.length + 1}`;
			outWords.push({
				id,
				segmentId,
				startSec: word.startSec,
				endSec: word.endSec,
				text: word.text,
			});
			wordIds.push(id);
		}
		segments.push({
			id: segmentId,
			kind: "speech",
			startSec: group[0].startSec,
			endSec: group.at(-1)?.endSec ?? group[0].endSec,
			text: group.map((w) => w.text).join(" "),
			wordIds,
		});
		group = [];
	};

	let cursor = 0;
	for (const word of words) {
		const gap = word.startSec - cursor;
		if (group.length > 0 && gap >= silenceMinSec) {
			flushSpeech();
			flushSilence(cursor, word.startSec);
		} else if (group.length === 0 && word.startSec > cursor) {
			flushSilence(cursor, word.startSec);
		}
		group.push(word);
		cursor = Math.max(cursor, word.endSec);
	}
	flushSpeech();
	if (options.durationSec !== undefined && options.durationSec > cursor) {
		flushSilence(cursor, options.durationSec);
	}

	return transcriptSchema.parse({
		assetId: options.assetId,
		language: options.language ?? "en",
		segments,
		words: outWords,
	});
}

export interface TranscriptFromWhisperOptions {
	assetId: string;
	durationSec?: number;
	language?: string;
	silenceMinSec?: number;
	/**
	 * Accept a file whose segments carry no per-word timestamps, whose timings
	 * are therefore an even split of the segment text. Off by default: the
	 * editorial oracles quote per-word numbers, and quoting them off a split is
	 * fabricated precision.
	 */
	allowSegmentSplit?: boolean;
}

export function transcriptFromWhisper(
	json: unknown,
	options: TranscriptFromWhisperOptions,
): AxcutTranscript {
	const loaded = wordsFromWhisper(json);
	if (loaded.words.length === 0) {
		throw new Error(
			"transcription whisper sans aucun mot exploitable — attendu `segments[].words[]`, " +
				"`words[]`, `wordSegments[]` ou `transcription[].offsets`",
		);
	}
	if (loaded.timingSource === "segment" && !options.allowSegmentSplit) {
		throw new Error(
			"cette transcription ne porte aucun horodatage par mot : les timings seraient " +
				"un découpage régulier du texte des segments (précision fabriquée). " +
				"Relancez whisper avec les timestamps par mot, ou passez allowSegmentSplit: true.",
		);
	}
	return transcriptFromWords({
		assetId: options.assetId,
		words: loaded.words,
		language: options.language ?? loaded.language,
		durationSec: options.durationSec,
		silenceMinSec: options.silenceMinSec,
	});
}

/** Reads a whisper JSON file from disk. Separate from `transcriptFromWhisper`
 * so every test can stay in memory — the only I/O in this module is here. */
export function loadWhisperTranscript(
	file: string,
	options: TranscriptFromWhisperOptions,
): AxcutTranscript {
	return transcriptFromWhisper(JSON.parse(readFileSync(file, "utf8")), options);
}

/**
 * Synthetic words for a demonstration fixture, until a real transcript is
 * injected. Deliberately NOT tidy: `jitterSec` pushes boundaries off the round
 * numbers so an oracle that only ever ran against `[10, 12.5]` cannot pass by
 * accident.
 */
export function synthesizeWords(options: {
	/** Spoken stretches, in source seconds. */
	speech: Array<[number, number]>;
	/** Average words per second. Ordinary speech is 2.5–3. */
	rate?: number;
	jitterSec?: number;
	vocabulary?: string[];
}): WordTiming[] {
	const rate = options.rate ?? 2.6;
	const jitter = options.jitterSec ?? 0.04;
	const vocabulary = options.vocabulary ?? [
		"so",
		"here",
		"the",
		"editor",
		"opens",
		"and",
		"we",
		"drag",
		"a",
		"clip",
		"onto",
		"the",
		"timeline",
	];
	const words: WordTiming[] = [];
	// A deterministic, seeded wobble — `Math.random()` would make every fixture
	// a different document and every golden comparison worthless.
	let seed = 7;
	const wobble = () => {
		seed = (seed * 1103515245 + 12345) % 2147483648;
		return ((seed / 2147483648) * 2 - 1) * jitter;
	};
	for (const [start, end] of options.speech) {
		const count = Math.max(1, Math.round((end - start) * rate));
		const each = (end - start) / count;
		for (let i = 0; i < count; i += 1) {
			const wordStart = start + i * each + (i === 0 ? 0 : wobble());
			const wordEnd = Math.min(end, start + (i + 1) * each + (i === count - 1 ? 0 : wobble()));
			if (wordEnd - wordStart <= SPAN_EPSILON_SEC) continue;
			words.push({
				text: vocabulary[words.length % vocabulary.length],
				startSec: wordStart,
				endSec: wordEnd,
			});
		}
	}
	return words;
}

/** Merged spans covering every word — the ground truth "this is speech". */
export function wordSpans(words: WordTiming[]): Span[] {
	return mergeSpans(words.map((w) => ({ startSec: w.startSec, endSec: w.endSec })));
}
