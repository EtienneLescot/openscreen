import type { TrimRegion } from "@/components/video-editor/types";
import type { CaptionSegment, TranscribeMono16kResult } from "./transcribe";

/**
 * Pure transcription algorithm for the captioning Web Worker: takes a built Whisper
 * `transcriber` and turns mono 16 kHz audio into timed caption segments. No DOM or
 * Transformers.js imports so it runs in a worker and unit-tests in isolation.
 */

/** A Transformers.js automatic-speech-recognition pipeline call. */
export type TranscriberFn = (
	audio: Float32Array,
	opts: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Pull the language Whisper settled on from a chunk stream. The pipeline
 * tags every chunk with the language code it used (forced via the
 * `language` arg, or auto-detected when no `language` was given). We
 * surface the first non-null value — later chunks only differ when the
 * model genuinely switched, which is rare and we don't expose it.
 */
function pickDetectedLanguage(result: unknown): string | null {
	const chunks = (result as { chunks?: unknown[] })?.chunks;
	if (!Array.isArray(chunks)) return null;
	for (const c of chunks) {
		const lang = (c as { language?: unknown })?.language;
		if (typeof lang === "string" && lang.length > 0) return lang;
	}
	return null;
}

function segmentOverlapsTrim(startMs: number, endMs: number, trims: TrimRegion[]): boolean {
	return trims.some((t) => startMs < t.endMs && endMs > t.startMs);
}

/** Same trim-out rule as {@link segmentsFromTranscriberChunks}; for retry passes that used empty trims. */
function dropSegmentsOverlappingTrimRegions(
	segments: CaptionSegment[],
	trimRegions: TrimRegion[],
): CaptionSegment[] {
	if (trimRegions.length === 0) return segments;
	return segments.filter((s) => {
		const startMs = Math.round(s.startSec * 1000);
		const endMs = Math.round(s.endSec * 1000);
		return !segmentOverlapsTrim(startMs, endMs, trimRegions);
	});
}

/** Whisper runs with internal 30s chunks; keep each forward pass bounded for WASM memory. */
const TRANSCRIBE_SLICE_SAMPLES = 12 * 60 * 16_000;

/** Very short slices are skipped in the multi-slice loop unless padded (see `padTailSliceForTranscribe`). */
const MIN_TRANSCRIBE_SLICE_SAMPLES = 800;

/**
 * Pad a short tail slice so Whisper still runs; timestamps are clamped with `realDurationSec` so
 * padding does not extend perceived audio on the timeline.
 */
function padTailSliceForTranscribe(samples: Float32Array): {
	slice: Float32Array;
	realDurationSec: number;
} {
	const realDurationSec = samples.length / 16_000;
	if (samples.length >= MIN_TRANSCRIBE_SLICE_SAMPLES) {
		return { slice: samples, realDurationSec };
	}
	const padded = new Float32Array(MIN_TRANSCRIBE_SLICE_SAMPLES);
	padded.set(samples);
	return { slice: padded, realDurationSec };
}

/** Converts raw Whisper chunk output into sorted, deduped, trim-filtered caption segments. */
function segmentsFromTranscriberChunks(
	chunks: Array<{ timestamp?: [number | null, number | null]; text?: unknown }>,
	timeOffsetSec: number,
	trims: TrimRegion[],
	audioDurationSec: number,
): CaptionSegment[] {
	const sorted = [...chunks].sort((x, y) => {
		const ax = x.timestamp?.[0];
		const ay = y.timestamp?.[0];
		const na = typeof ax === "number" ? ax : -1;
		const nb = typeof ay === "number" ? ay : -1;
		return na - nb;
	});

	const segments: CaptionSegment[] = [];

	for (let idx = 0; idx < sorted.length; idx++) {
		const c = sorted[idx]!;
		const ts = c.timestamp as [number | null, number | null] | undefined;
		if (!ts) continue;
		let a = ts[0];
		let b = ts[1];
		if (a == null) a = 0;
		a = Math.max(0, a);
		if (b == null) {
			let nextStart: number | null = null;
			for (let j = idx + 1; j < sorted.length; j++) {
				const na = sorted[j]?.timestamp?.[0];
				if (typeof na === "number") {
					nextStart = na;
					break;
				}
			}
			b = nextStart ?? audioDurationSec;
		}
		if (b <= a) {
			b = Math.min(a + 0.25, audioDurationSec);
		}
		b = Math.min(b, audioDurationSec);

		const text = String(c.text ?? "")
			.replace(/\s+/g, " ")
			.trim();
		if (!text) continue;

		const startSec = a + timeOffsetSec;
		const sliceEnd = timeOffsetSec + audioDurationSec;
		const endSec = Math.min(Math.max(startSec + 0.08, b + timeOffsetSec), sliceEnd);
		const startMs = Math.round(startSec * 1000);
		const endMs = Math.round(endSec * 1000);
		if (segmentOverlapsTrim(startMs, endMs, trims)) continue;

		segments.push({ startSec, endSec, text });
	}

	segments.sort((u, v) => u.startSec - v.startSec || u.endSec - v.endSec);
	const rawDeduped: CaptionSegment[] = [];
	for (const seg of segments) {
		const prev = rawDeduped[rawDeduped.length - 1];
		if (prev && prev.text === seg.text && seg.startSec <= prev.endSec) {
			prev.endSec = Math.max(prev.endSec, seg.endSec);
			prev.startSec = Math.min(prev.startSec, seg.startSec);
			continue;
		}
		rawDeduped.push(seg);
	}
	return rawDeduped;
}

/** Runs the transcriber on one audio slice, chunking only long clips. */
async function runTranscriberOnSlice(
	transcriber: TranscriberFn,
	samples: Float32Array,
	opts: {
		forceFullSequences: boolean;
		timestampMode: "word" | "phrase";
		language?: string;
	},
): Promise<{ result: unknown; detectedLanguage: string | null }> {
	const durationSec = samples.length / 16_000;
	// Only chunk long clips; short-audio chunking regressed some Whisper.js runs (empty chunks).
	const chunking = durationSec > 30 ? { chunk_length_s: 30, stride_length_s: 5 } : {};
	// `return_language` makes the pipeline keep the `language` field on each
	// output chunk so we can read back what Whisper settled on (forced or
	// auto-detected). Without it the tokenizer strips language from chunks
	// and we lose the detection.
	const result = await transcriber(samples, {
		return_timestamps: opts.timestampMode === "word" ? "word" : true,
		force_full_sequences: opts.forceFullSequences,
		// Only set `language` when explicitly forced. Omitting it lets Whisper
		// auto-detect from the audio, which is what the "Auto" picker wants.
		...(opts.language ? { language: opts.language } : {}),
		return_language: true,
		...chunking,
	});
	return { result, detectedLanguage: pickDetectedLanguage(result) };
}

/** Flattens the various shapes a Transformers.js ASR result can take into a chunk list. */
function getChunksFromTranscriberResult(result: unknown): Array<{
	timestamp?: [number | null, number | null];
	text?: unknown;
}> {
	if (result == null) return [];
	if (Array.isArray(result)) {
		const out: Array<{ timestamp?: [number | null, number | null]; text?: unknown }> = [];
		for (const item of result) {
			const chunks = (item as { chunks?: unknown })?.chunks;
			if (Array.isArray(chunks)) out.push(...chunks);
		}
		return out;
	}
	const chunks = (result as { chunks?: unknown })?.chunks;
	return Array.isArray(chunks) ? chunks : [];
}

/** Prefer `chunks`; if the model only returned top-level `text`, synthesize one span for timing. */
function extractChunksFromAsrResult(result: unknown): Array<{
	timestamp?: [number | null, number | null];
	text?: unknown;
}> {
	const fromChunks = getChunksFromTranscriberResult(result);
	if (fromChunks.length > 0) return fromChunks;
	const single = Array.isArray(result) ? result[0] : result;
	const text =
		typeof (single as { text?: unknown })?.text === "string"
			? String((single as { text: string }).text).trim()
			: "";
	if (text) {
		return [{ timestamp: [0, null], text }];
	}
	return [];
}

/**
 * Drives Whisper over (possibly sliced) mono 16 kHz audio and returns timed segments.
 * Long audio is split so one pass doesn't exhaust WASM memory; timestamps are shifted
 * back onto the full timeline. Tries word- then phrase-level timestamps, with a
 * trim-ignoring retry, before giving up.
 */
export async function runTranscription(
	transcriber: TranscriberFn,
	samples: Float32Array,
	trims: TrimRegion[],
	options?: { language?: string },
): Promise<TranscribeMono16kResult> {
	const forcedLanguage = options?.language;
	const transcribeOne = async (
		ignoreTrims: boolean,
		forceFullSequences: boolean,
		timestampMode: "word" | "phrase",
	): Promise<{ segments: CaptionSegment[]; detectedLanguage: string | null }> => {
		try {
			const activeTrims = ignoreTrims ? [] : trims;
			if (samples.length <= TRANSCRIBE_SLICE_SAMPLES) {
				const { slice, realDurationSec } = padTailSliceForTranscribe(samples);
				const { result, detectedLanguage } = await runTranscriberOnSlice(transcriber, slice, {
					forceFullSequences,
					timestampMode,
					language: forcedLanguage,
				});
				return {
					segments: segmentsFromTranscriberChunks(
						extractChunksFromAsrResult(result),
						0,
						activeTrims,
						realDurationSec,
					),
					detectedLanguage,
				};
			}

			const all: CaptionSegment[] = [];
			let detectedLanguage: string | null = null;
			for (let offset = 0; offset < samples.length; offset += TRANSCRIBE_SLICE_SAMPLES) {
				const end = Math.min(offset + TRANSCRIBE_SLICE_SAMPLES, samples.length);
				const sliceRaw = samples.subarray(offset, end);
				const isFinalSlice = end >= samples.length;
				if (sliceRaw.length === 0) continue;
				if (sliceRaw.length < MIN_TRANSCRIBE_SLICE_SAMPLES && !isFinalSlice) continue;

				const { slice, realDurationSec } =
					sliceRaw.length < MIN_TRANSCRIBE_SLICE_SAMPLES && isFinalSlice
						? padTailSliceForTranscribe(sliceRaw)
						: { slice: sliceRaw, realDurationSec: sliceRaw.length / 16_000 };

				const { result, detectedLanguage: sliceLang } = await runTranscriberOnSlice(
					transcriber,
					slice,
					{
						forceFullSequences,
						timestampMode,
						language: forcedLanguage,
					},
				);
				if (detectedLanguage === null && sliceLang) detectedLanguage = sliceLang;
				const tOff = offset / 16_000;
				all.push(
					...segmentsFromTranscriberChunks(
						extractChunksFromAsrResult(result),
						tOff,
						activeTrims,
						realDurationSec,
					),
				);
			}
			return { segments: all, detectedLanguage };
		} catch (e) {
			console.warn("[captioning] Whisper pass failed:", e);
			return { segments: [], detectedLanguage: null };
		}
	};

	const attemptModes: Array<"word" | "phrase"> = ["word", "phrase"];
	for (const timestampMode of attemptModes) {
		let pass = await transcribeOne(false, true, timestampMode);
		let segments = pass.segments;
		let detectedLanguage = pass.detectedLanguage;
		if (segments.length === 0) {
			pass = await transcribeOne(false, false, timestampMode);
			segments = pass.segments;
			detectedLanguage = pass.detectedLanguage;
		}
		if (segments.length === 0 && trims.length > 0) {
			pass = await transcribeOne(true, true, timestampMode);
			segments = dropSegmentsOverlappingTrimRegions(pass.segments, trims);
			detectedLanguage = pass.detectedLanguage;
			if (segments.length === 0) {
				pass = await transcribeOne(true, false, timestampMode);
				segments = dropSegmentsOverlappingTrimRegions(pass.segments, trims);
				detectedLanguage = pass.detectedLanguage;
			}
		}
		if (segments.length > 0) {
			return { segments, granularity: timestampMode, detectedLanguage };
		}
	}

	return { segments: [], granularity: "phrase", detectedLanguage: null };
}
