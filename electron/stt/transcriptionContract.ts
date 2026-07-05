/**
 * Shared types for the native speech-to-text pipeline. The renderer talks to
 * the main process through these types; the main-process STT modules talk to
 * each other through them. No runtime imports — keeps the contract folder
 * cheap to share with renderer + main + test code.
 *
 * ponytail: the renderer doesn't import the `SttBackend` union (only the
 * `Stt*Segment` shapes), so renaming the literals is safe — the wire types
 * other than `SttBackend` are unchanged from the previous whisper.cpp-based
 * contract and don't need to move.
 */

/** A word-level segment with timestamps from CTranslate2's `.align()` (DTW over
 *  the Whisper model's cross-attention weights — see
 *  docs/engineering/stt-ctranslate2-migration.md § Decision). Absolute seconds
 *  in the source recording. */
export interface SttWordSegment {
	word: string;
	startSec: number;
	endSec: number;
	/** Confidence in `[0, 1]` when the recognizer exposes one; otherwise `undefined`. */
	confidence?: number;
}

/** A phrase-level segment from the recognizer (Whisper phrase). */
export interface SttPhraseSegment {
	text: string;
	startSec: number;
	endSec: number;
}

/** GPU/backend tag picked by `gpuDetector`. Mirrors the bundled binary variant. */
export type SttBackend = "ctranslate2-cuda" | "ctranslate2-cpu";

/** Status phase the renderer surfaces over `onStatus("model" | "transcribe")`. */
export type SttStatusPhase = "model" | "transcribe";

/** Status event the main process emits to the renderer while preparing/running STT. */
export interface SttStatusEvent {
	phase: SttStatusPhase;
	/** Bytes downloaded so far; only when `phase === "model"` and a download is in flight. */
	downloadedBytes?: number;
	/** Total bytes for the in-flight download. */
	totalBytes?: number;
	/** Which model is downloading. */
	model?: "whisper";
}

/** IPC request: renderer → main. */
export interface SttTranscribeRequest {
	samples: Float32Array;
	/**
	 * ISO 639-1 language code (e.g. "en", "fr"). Omit / `"auto"` to let Whisper detect.
	 * The spec locks language detection on by default; we only honour an explicit value.
	 */
	language?: string;
}

/** IPC response: main → renderer. */
export interface SttTranscribeResponse {
	segments: SttPhraseSegment[];
	wordSegments: SttWordSegment[];
	detectedLanguage: string;
	backend: SttBackend;
}

/** IPC success envelope; thrown errors cross as a rejection. */
export type SttTranscribeResult = SttTranscribeResponse;
