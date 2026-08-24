// Pure status logic for the transcription pipeline: what state one asset's
// transcript is in, and whether a transcript-dependent action (Smart cuts,
// captions…) may run right now.
//
// Kept free of React and of both stores so the rules can be unit-tested on
// plain data — `store/transcriptionStore.ts` owns the queue and the side
// effects, this module owns the vocabulary.

import type { AxcutDocument, AxcutTranscript } from "../schema";

/** Why a transcription run could not produce anything. */
export type TranscriptionFailureKind = "no-audio" | "unsupported-audio" | "error";

export interface TranscriptionFailure {
	kind: TranscriptionFailureKind;
	/** Raw engine/exception message — surfaced as a tooltip / toast description. */
	message: string;
}

/** Which part of the pipeline a running job is in (mirrors `TranscribeAssetOptions.onStatus`). */
export type TranscriptionPhase = "extracting-audio" | "loading-model" | "transcribing";

/**
 * How far a running transcription has got, in seconds of audio.
 *
 * Only the `"transcribing"` phase reports this, and only once the main process
 * starts landing chunks — audio extraction and the first-run model download
 * have nothing to measure. Absent means "running, no measurable progress", not
 * "zero": the UI must fall back to an indeterminate spinner rather than render
 * a bar stuck at 0%.
 */
export interface TranscriptionProgress {
	completedSec: number;
	totalSec: number;
}

/** `0..1`, or null when the job reports no measurable progress. */
export function progressFraction(progress: TranscriptionProgress | undefined): number | null {
	if (!progress || !(progress.totalSec > 0)) return null;
	return Math.min(1, Math.max(0, progress.completedSec / progress.totalSec));
}

/**
 * Turn the engine's RTF (wall-clock / audio, whisper.cpp's convention, lower is
 * faster) into the figure a reader can act on: "× real-time", where 2.1 means
 * 2.1 seconds of audio transcribed per second of work.
 *
 * Null whenever nothing usable was reported — a helper binary older than the
 * `timing` field sends none at all — so the UI shows no figure rather than a
 * confident "0.0×".
 */
export function realtimeSpeed(rtf: number | undefined): number | null {
	if (rtf === undefined || !Number.isFinite(rtf) || rtf <= 0) return null;
	return 1 / rtf;
}

/**
 * True when the run is on the CPU path rather than a GPU one.
 *
 * Worth its own predicate because it is the one backend value that changes what
 * the user should expect: the same helper on the GPU is ~2x faster (median
 * 2.07x, tools/stt-eval/whispercpp-dtw-poc/REPORT.md 5.3), and every route onto
 * the CPU path is a silent fallback.
 */
export function isCpuBackend(backend: string | undefined): boolean {
	return backend === "whispercpp-cpu";
}

/**
 * A media that has no audio track (or one Whisper cannot read) will fail the
 * same way on every attempt, so that verdict is worth remembering: it is
 * persisted on the asset and stops the auto pass from re-extracting the audio
 * of a silent screen recording on every project open. Everything else
 * ("error") is treated as transient and retried on the next load.
 */
export function isPermanentFailure(kind: TranscriptionFailureKind): kind is PersistableFailureKind {
	return kind !== "error";
}

/** The failure kinds `assetSchema.transcriptionFailure` accepts. */
export type PersistableFailureKind = Exclude<TranscriptionFailureKind, "error">;

/**
 * Map an exception out of `transcribeAsset` onto a failure the UI can explain.
 * The two deterministic cases come from `extractMono16kWebDemuxer` — it is the
 * only layer that knows whether the container actually holds audio.
 */
export function classifyTranscriptionError(error: unknown): TranscriptionFailure {
	const message = error instanceof Error ? error.message : String(error);
	if (/no audio track/i.test(message) || /zero audio frames/i.test(message)) {
		return { kind: "no-audio", message };
	}
	if (/audio codec not supported/i.test(message)) {
		return { kind: "unsupported-audio", message };
	}
	return { kind: "error", message };
}

export function isAbortError(error: unknown): boolean {
	return (
		(error instanceof DOMException && error.name === "AbortError") ||
		(error instanceof Error && error.name === "AbortError")
	);
}

export type AssetTranscriptionStatus =
	/** Nothing attempted yet (no local engine, or the auto pass hasn't reached it). */
	| "idle"
	| "queued"
	| "running"
	/** A transcript exists and holds at least one word. */
	| "ready"
	/** A transcript exists but Whisper heard no speech — nothing for the agent to cut on. */
	| "empty"
	| "failed";

export interface AssetTranscriptionView {
	assetId: string;
	status: AssetTranscriptionStatus;
	phase?: TranscriptionPhase;
	progress?: TranscriptionProgress;
	failure?: TranscriptionFailure;
	/**
	 * Backend the running job is actually using, once a chunk has reported one.
	 * Only meaningful while `status === "running"` — it describes a run in
	 * flight, not the transcript a finished run left behind.
	 */
	backend?: string;
	/** Real-time factor for the run so far; pair with `realtimeSpeed()` to display. */
	rtf?: number;
}

/** In-flight (or last-failed) state of one asset's job. Mirrors the store entry. */
export interface TranscriptionJobLike {
	status: "queued" | "running" | "failed";
	phase?: TranscriptionPhase;
	progress?: TranscriptionProgress;
	failure?: TranscriptionFailure;
	backend?: string;
	rtf?: number;
}

export function findAssetTranscript(
	document: AxcutDocument | null,
	assetId: string,
): AxcutTranscript | null {
	if (!document) return null;
	return (
		document.transcripts.find((t) => t.assetId === assetId) ??
		(document.transcript?.assetId === assetId ? document.transcript : null)
	);
}

/** A transcript with no word is "empty", not "ready": captions and AI cuts have nothing to work with. */
export function transcriptHasSpeech(transcript: AxcutTranscript | null): boolean {
	if (!transcript) return false;
	return transcript.words.length > 0 || transcript.segments.some((s) => s.text.trim().length > 0);
}

/**
 * Fold the live job (if any), the persisted failure (if any) and the stored
 * transcript into the single status the UI renders. Precedence, in order:
 *
 *   1. A run in flight — a regenerate over an existing transcript must read as
 *      "running", not "ready".
 *   2. A stored transcript — it OUTRANKS a failed job on purpose. A regenerate
 *      that fails (whisper restart, decode hiccup) leaves the previous
 *      transcript untouched on the document, and it is still perfectly usable:
 *      the pane renders it, captions read it, the agent can cut on it. Reading
 *      that asset as "failed" would have disabled Smart cuts for the rest of the
 *      session over a transcript that is right there. The failure still travels
 *      on the view (tooltips surface it), it just doesn't veto the content.
 *   3. Only then a failure — nothing was ever produced for this asset.
 */
export function deriveAssetStatus(input: {
	assetId: string;
	job?: TranscriptionJobLike;
	transcript?: AxcutTranscript | null;
	persistedFailure?: TranscriptionFailure | null;
}): AssetTranscriptionView {
	const { assetId, job, transcript, persistedFailure } = input;
	if (job && job.status !== "failed") {
		return {
			assetId,
			status: job.status,
			phase: job.phase,
			progress: job.progress,
			backend: job.backend,
			rtf: job.rtf,
		};
	}
	if (transcript) {
		return {
			assetId,
			status: transcriptHasSpeech(transcript) ? "ready" : "empty",
			failure: job?.failure,
		};
	}
	if (job?.status === "failed") {
		return { assetId, status: "failed", failure: job.failure };
	}
	if (persistedFailure) {
		return { assetId, status: "failed", failure: persistedFailure };
	}
	return { assetId, status: "idle" };
}

export type TranscriptGateState = "ready" | "pending" | "blocked";

export type TranscriptGateReason =
	/** The project holds no media at all. */
	| "no-media"
	/** Every media is silent (no audio track / unreadable audio). */
	| "no-audio"
	/** At least one run failed for a reason worth retrying. */
	| "failed"
	/** Transcripts exist but hold no speech. */
	| "no-speech"
	/** Nothing has been transcribed yet and nothing is running (no local engine). */
	| "not-started";

export interface TranscriptGate {
	state: TranscriptGateState;
	/** Null when `state === "ready"`. */
	reason: TranscriptGateReason | null;
	/** Engine message behind a `failed` reason, for the tooltip/description. */
	message?: string;
	/** How many assets are still queued or running — drives the "2 remaining" hint. */
	pendingCount: number;
}

/**
 * Decide whether a transcript-dependent action may run over a set of assets.
 *
 * Pending beats ready on purpose: with one media transcribed and another still
 * running, letting the agent loose now would have it plan cuts against half the
 * timeline and then watch the document change underneath it.
 */
export function resolveTranscriptGate(views: AssetTranscriptionView[]): TranscriptGate {
	if (views.length === 0) {
		return { state: "blocked", reason: "no-media", pendingCount: 0 };
	}
	const pendingCount = views.filter((v) => v.status === "queued" || v.status === "running").length;
	if (pendingCount > 0) {
		return { state: "pending", reason: null, pendingCount };
	}
	if (views.some((v) => v.status === "ready")) {
		return { state: "ready", reason: null, pendingCount: 0 };
	}
	const failures = views.filter((v) => v.status === "failed");
	if (failures.length > 0) {
		const everyFailureIsSilence = failures.every(
			(v) => v.failure?.kind === "no-audio" || v.failure?.kind === "unsupported-audio",
		);
		return {
			state: "blocked",
			reason: everyFailureIsSilence ? "no-audio" : "failed",
			message: failures.find((v) => v.failure?.message)?.failure?.message,
			pendingCount: 0,
		};
	}
	if (views.some((v) => v.status === "empty")) {
		return { state: "blocked", reason: "no-speech", pendingCount: 0 };
	}
	return { state: "blocked", reason: "not-started", pendingCount: 0 };
}

/**
 * Assets a transcript-dependent timeline action actually depends on: the ones
 * the timeline plays. An asset sitting in the media bin but not on the timeline
 * must not keep the Smart-cuts entry disabled — and, symmetrically, must not
 * make it look ready when the clip on screen has no transcript. Falls back to
 * the whole bin while the timeline is still empty.
 */
export function transcriptRelevantAssetIds(document: AxcutDocument | null): string[] {
	if (!document) return [];
	const onTimeline: string[] = [];
	for (const clip of document.timeline.clips) {
		if (!onTimeline.includes(clip.assetId)) onTimeline.push(clip.assetId);
	}
	const known = new Set(document.assets.map((a) => a.id));
	const filtered = onTimeline.filter((id) => known.has(id));
	return filtered.length > 0 ? filtered : document.assets.map((a) => a.id);
}
