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

/** A word-level segment with timestamps from whisper.cpp's native DTW token
 *  timestamps (`t_dtw`, computed with the SMALL aheads preset — see
 *  technical-documentation/architecture/transcription-and-captions.md § Decision rationale). Absolute seconds
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

/** GPU/backend tag reported by the whisper.cpp helper (read from the device it
 *  actually bound at runtime). `gpuDetector` only picks the binary; the real
 *  backend is corrected from the helper response. */
export type SttBackend =
	| "whispercpp-metal"
	| "whispercpp-vulkan"
	| "whispercpp-cuda"
	| "whispercpp-cpu";

/**
 * Wall-clock cost of a transcription, measured by the helper around
 * `whisper_full` (`electron/native/whisper-stt/src/main.cpp`) and reported on
 * every `/inference` response. Used both per chunk and summed over a whole run.
 *
 * `rtf` follows whisper.cpp's convention, which is also the POC report's:
 * wall-clock DIVIDED BY audio duration, so lower is faster and < 1 means faster
 * than real-time. The figure a reader can act on ("2.1x real-time") is its
 * reciprocal — see `realtimeSpeed()` in
 * `src/lib/ai-edition/transcription/status.ts`.
 *
 * Optional everywhere it appears because a staged helper binary can pre-date
 * the `timing` field: `electron/native/bin/<tag>/` is gitignored, so a dev tree
 * keeps whatever was last built there. Absent rather than zeroed on purpose —
 * "not reported" and "took no time" must not render the same way.
 */
export interface SttTiming {
	elapsedSec: number;
	audioSec: number;
	rtf: number;
}

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
	/**
	 * Seconds of audio transcribed so far, and the total for this request. Only
	 * when `phase === "transcribe"`. Progress is reported per CHUNK (see
	 * `chunking.ts`), so it steps rather than sweeps — whisper gives no
	 * sub-request progress signal to interpolate from.
	 */
	completedSec?: number;
	totalSec?: number;
	/**
	 * Backend the helper ACTUALLY bound, as reported by the chunk that just
	 * landed — not `gpuDetector`'s guess, which only picks a binary.
	 *
	 * This is the only signal a user has that they are on the slow path. Both
	 * routes onto it are silent (the helper retries without GPU when init
	 * returns null; the Node side can relaunch with `--cpu`), and the CPU path
	 * costs roughly half the throughput — median 2.07x on the reference machine,
	 * see tools/stt-eval/whispercpp-dtw-poc/REPORT.md 5.3.
	 */
	backend?: SttBackend;
	/**
	 * Real-time factor for the run SO FAR (total wall-clock / total audio), not
	 * for the chunk that just landed. Per-chunk values swing with how much speech
	 * a chunk happens to hold, and a figure that jumps every 90s reads as noise
	 * rather than as progress.
	 *
	 * Computed over the chunks that reported timing. Unlike
	 * `SttTranscribeResponse.timing` this is a ratio rather than a total, so it
	 * stays meaningful even when a chunk reports nothing.
	 */
	rtf?: number;
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
	/**
	 * Summed over every chunk of this request — and absent unless ALL of them
	 * reported, because a total that quietly skips a chunk describes a shorter
	 * recording than the one that was transcribed.
	 */
	timing?: SttTiming;
}

/** IPC success envelope; thrown errors cross as a rejection. */
export type SttTranscribeResult = SttTranscribeResponse;
