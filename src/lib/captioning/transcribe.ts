import type { TrimRegion } from "@/components/video-editor/types";
import type { SttWordSegment } from "../../../electron/stt/transcriptionContract";

export interface CaptionSegment {
	startSec: number;
	endSec: number;
	text: string;
}

/**
 * How caption layout should interpret `CaptionSegment` times from
 * `transcribeMono16kToSegments`. The native pipeline gets per-word timestamps
 * from whisper.cpp's own output; `"phrase"` is a fallback for the rare case
 * where whisper reports zero words for a segment.
 */
export type CaptionTimestampGranularity = "word" | "phrase";

export interface TranscribeMono16kResult {
	segments: CaptionSegment[];
	granularity: CaptionTimestampGranularity;
	/**
	 * ISO 639-1 code Whisper settled on for the chunk stream — either the
	 * forced one (when `language` was supplied) or what it auto-detected.
	 * Null when the model produced no language token.
	 */
	detectedLanguage?: string | null;
}

export type SttRendererStatusPhase = "model" | "transcribe";

/**
 * Progress the main process reports while a transcription runs. `completedSec` /
 * `totalSec` are present only during `"transcribe"`, and only once chunking has
 * started — they let the UI show a real bar instead of an indeterminate spinner
 * for what can be several minutes of work.
 */
export interface SttRendererStatus {
	phase: SttRendererStatusPhase;
	completedSec?: number;
	totalSec?: number;
	/**
	 * Backend the helper actually bound (`"whispercpp-cpu"` when the GPU path was
	 * not taken). Reported per chunk during `"transcribe"`.
	 */
	backend?: string;
	/** Real-time factor for the run so far — wall-clock / audio, lower is faster. */
	rtf?: number;
}

interface RendererSttApi {
	transcribe: (request: { samples: Float32Array; language?: string }) => Promise<{
		segments: CaptionSegment[];
		wordSegments: SttWordSegment[];
		detectedLanguage: string;
		backend: string;
	}>;
	cancel?: () => Promise<void>;
	onStatus?: (callback: (event: SttRendererStatus) => void) => () => void;
}

/**
 * Transcribes mono 16 kHz audio into per-word timed caption segments. The
 * renderer is a thin IPC adapter: it forwards the audio to the Electron main
 * process where `whisper-server` runs recognition and emits its own
 * per-word timestamps in the same pass.
 *
 * The previous in-Web-Worker implementation (Transformers.js + ORT-WASM) was
 * 0.5× realtime on tiny models and had no word-level accuracy under 50 ms;
 * see `technical-documentation/architecture/transcription-and-captions.md` § History for context.
 */
export function transcribeMono16kToSegments(
	samples: Float32Array,
	options?: {
		trimRegions?: TrimRegion[];
		onStatus?: (status: SttRendererStatus) => void;
		signal?: AbortSignal;
		language?: string;
	},
): Promise<TranscribeMono16kResult> {
	if (options?.signal?.aborted) {
		return Promise.reject(new DOMException("Aborted", "AbortError"));
	}
	const api = (window as Window & { electronAPI?: { stt?: RendererSttApi } }).electronAPI?.stt;
	if (!api?.transcribe) {
		// Renderer-only fallback (browser tests, dev tooling without Electron).
		// We don't try to run any model here — the worker migration is permanent.
		return Promise.resolve({ segments: [], granularity: "word" });
	}

	const unsubscribe = options?.onStatus && api.onStatus?.((event) => options.onStatus?.(event));
	// Aborting has to reach the MAIN process: the work is a chunk loop over there,
	// and a renderer that merely stops awaiting still leaves the helper busy for
	// minutes — with the replacement request queued behind it, which is what made
	// "regenerate in another language" look dead.
	const onAbort = () => void api.cancel?.();
	options?.signal?.addEventListener("abort", onAbort, { once: true });
	const forcedLanguage =
		options?.language && options.language !== "auto" ? options.language : undefined;
	// ponytail: word timestamps come back already absolute from whisper.cpp
	// because its built-in Silero VAD (started on the server with
	// `--vad --vad-model`) splits audio into speech regions *before* the ASR
	// decoder runs and offsets each region's timestamps to its position in the
	// original audio. No trim + offset math here on purpose: an earlier
	// iteration trimmed leading silence with a peak detector and got false
	// positives on quiet music intros / room tone. VAD or nothing.
	return api
		.transcribe({ samples, language: forcedLanguage })
		.then((result) => {
			const words = result.wordSegments ?? [];
			let segments: CaptionSegment[];
			let granularity: CaptionTimestampGranularity;
			if (words.length > 0) {
				segments = words.map((w) => ({
					startSec: w.startSec,
					endSec: w.endSec,
					text: w.word,
				}));
				granularity = "word";
			} else {
				// ponytail: whisper dropped every word for a segment (e.g. OOV
				// heavy); fall back to raw phrase spans so the user still gets
				// captions to edit.
				segments = (result.segments ?? []).map((s) => ({
					startSec: s.startSec,
					endSec: s.endSec,
					text: s.text,
				}));
				granularity = "phrase";
			}
			return { segments, granularity, detectedLanguage: result.detectedLanguage };
		})
		.catch((error: unknown) => {
			// A run the caller cancelled surfaces as an abort, not as an engine
			// failure: the store drops it silently instead of toasting the user
			// about something they asked for.
			if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
			throw error;
		})
		.finally(() => {
			options?.signal?.removeEventListener("abort", onAbort);
			unsubscribe?.();
		});
}
