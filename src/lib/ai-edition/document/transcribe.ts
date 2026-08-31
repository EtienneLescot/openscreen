// Adapter: wraps OpenScreen's existing local Whisper pipeline (transformers.js,
// src/lib/captioning/) as a transcribeAsset function that returns an
// AxcutTranscript and persists it into the document.
//
// ponytail: reuses extractMono16kFromVideoUrl + transcribeMono16kToSegments
// verbatim. No Python, no faster-whisper, no network calls. Privacy-safe.

import { toFileUrl } from "@/components/video-editor/projectPersistence";
import {
	extractMono16kFromVideoUrl,
	transcribeMono16kToSegments,
	transcribeSourceFileToSegments,
} from "@/lib/captioning";
import type { SttRendererStatus } from "@/lib/captioning/transcribe";
import { STT_NATIVE_EXTRACTION_UNAVAILABLE } from "../../../../electron/stt/transcriptionContract";
import type { AxcutDocument, AxcutTranscript, AxcutTranscriptSegment, AxcutWord } from "../schema";

/**
 * What the caller can show while a transcription runs. `completedSec` /
 * `totalSec` arrive only during `"transcribing"`, once the main process starts
 * landing chunks — until then the phase alone is all there is to show.
 */
export interface TranscribeStatus {
	phase: "extracting-audio" | "loading-model" | "transcribing";
	completedSec?: number;
	totalSec?: number;
	/** Backend the helper bound for this run; `"whispercpp-cpu"` is the slow path. */
	backend?: string;
	/** Real-time factor for the run so far — wall-clock / audio, lower is faster. */
	rtf?: number;
	/** Bytes of the speech model fetched so far. Only during `"loading-model"`. */
	downloadedBytes?: number;
	/** Total bytes of the in-flight model download. */
	totalBytes?: number;
}

export interface TranscribeAssetOptions {
	language?: string;
	onStatus?: (status: TranscribeStatus) => void;
	signal?: AbortSignal;
}

export async function transcribeAsset(
	document: AxcutDocument,
	assetId: string,
	options: TranscribeAssetOptions = {},
): Promise<AxcutTranscript> {
	const asset = document.assets.find((a) => a.id === assetId);
	if (!asset) {
		throw new Error(`Asset ${assetId} not found in document.`);
	}

	const videoUrl = toFileUrl(asset.originalPath);

	options.onStatus?.({ phase: "extracting-audio" });

	// Stay on loading-model until the main process reports inference chunks.
	// Emitting "transcribing" here used to label the cold `server.start()` wait
	// as if recognition had begun.
	options.onStatus?.({ phase: "loading-model" });
	// Only pass `language` to the worker when the caller forced a specific
	// code. `"auto"` (or any falsy value) leaves Whisper to detect from
	// the audio. The pipeline tags every chunk with the language it used
	// (forced or detected) and we read it back via `result.detectedLanguage`
	// so the stored transcript reflects reality, not the input option.
	const forcedLanguage =
		options.language && options.language !== "auto" ? options.language : undefined;

	// Forward the main process's per-chunk progress. Without this the status
	// callback only ever fired the two coarse phases above, so a 30-minute
	// recording showed one static "transcribing" for ten minutes.
	const forwardStatus = (status: SttRendererStatus) =>
		options.onStatus?.({
			phase: status.phase === "model" ? "loading-model" : "transcribing",
			completedSec: status.completedSec,
			totalSec: status.totalSec,
			// Which device is doing the work, and how fast. The main process is the
			// only place that knows either, and a silent CPU fallback is exactly the
			// case a user cannot otherwise diagnose.
			backend: status.backend,
			rtf: status.rtf,
			...(status.downloadedBytes !== undefined
				? { downloadedBytes: status.downloadedBytes }
				: {}),
			...(status.totalBytes !== undefined ? { totalBytes: status.totalBytes } : {}),
		});

	// Native first. `extractMono16kFromVideoUrl` runs in the RENDERER: it reads the
	// whole media into memory, copies it twice and resamples on the UI thread, which
	// is what froze the editor at project open on a long import (measured on a
	// four-minute bed: ~86 MB of decoded float32 there against 15.7 MB in the main
	// process). Handing the path over keeps every byte on the other side of the IPC,
	// and the whisper helper it feeds was already a separate process.
	//
	// The fallback is not decoration: an install with no resolvable ffmpeg — a dev
	// checkout that never fetched it, a platform build missing the binary — must still
	// transcribe rather than lose the feature. Only THAT case falls back. "This file
	// has no audio" is a verdict, and re-deriving it in the renderer would buy the same
	// answer for the price of the decode this exists to avoid.
	const result = await transcribeSourceFileToSegments(asset.originalPath, {
		trimRegions: [],
		signal: options.signal,
		language: forcedLanguage,
		onStatus: forwardStatus,
	}).catch(async (error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		if (!message.includes(STT_NATIVE_EXTRACTION_UNAVAILABLE)) throw error;
		const audioResult = await extractMono16kFromVideoUrl(videoUrl, {
			signal: options.signal,
		});
		options.onStatus?.({ phase: "transcribing" });
		return transcribeMono16kToSegments(audioResult.samples, {
			trimRegions: [],
			signal: options.signal,
			language: forcedLanguage,
			onStatus: forwardStatus,
		});
	});

	const segments: AxcutTranscriptSegment[] = [];
	const words: AxcutWord[] = [];

	for (let segIndex = 0; segIndex < result.segments.length; segIndex++) {
		const seg = result.segments[segIndex];
		const segId = `seg_${segIndex + 1}`;
		const wordIds: string[] = [];

		const tokens = seg.text.trim().split(/\s+/).filter(Boolean);
		if (tokens.length === 0) continue;

		const wordDuration = (seg.endSec - seg.startSec) / tokens.length;
		for (let w = 0; w < tokens.length; w++) {
			const wordId = `word_${words.length + 1}`;
			const startSec = seg.startSec + w * wordDuration;
			const endSec = startSec + wordDuration;
			words.push({
				id: wordId,
				segmentId: segId,
				startSec,
				endSec,
				text: tokens[w],
			});
			wordIds.push(wordId);
		}

		segments.push({
			id: segId,
			kind: "speech" as const,
			startSec: seg.startSec,
			endSec: seg.endSec,
			text: seg.text,
			wordIds,
		});
	}

	return {
		assetId,
		// Prefer the model-reported language (covers both forced picks and
		// auto-detect); fall back to the input option, then "auto" when
		// nothing was detected (very rare on tiny.en — usually a no-audio run).
		language: result.detectedLanguage ?? options.language ?? "auto",
		segments,
		words,
	};
}

// `withTranscript` used to live here. It moved to `document/transcript.ts`, next to
// the other writers of the same object: it is a pure document operation, and the
// Whisper adapter is not where a caller should have to look for it.
