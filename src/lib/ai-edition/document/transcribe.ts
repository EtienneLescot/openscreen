// Adapter: wraps OpenScreen's existing local Whisper pipeline (transformers.js,
// src/lib/captioning/) as a transcribeAsset function that returns an
// AxcutTranscript and persists it into the document.
//
// ponytail: reuses extractMono16kFromVideoUrl + transcribeMono16kToSegments
// verbatim. No Python, no faster-whisper, no network calls. Privacy-safe.

import { toFileUrl } from "@/components/video-editor/projectPersistence";
import { extractMono16kFromVideoUrl, transcribeMono16kToSegments } from "@/lib/captioning";
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
	const audioResult = await extractMono16kFromVideoUrl(videoUrl, {
		signal: options.signal,
	});

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
	const result = await transcribeMono16kToSegments(audioResult.samples, {
		trimRegions: [],
		signal: options.signal,
		language: forcedLanguage,
		// Forward the main process's per-chunk progress. Without this the status
		// callback only ever fired the two coarse phases above, so a 30-minute
		// recording showed one static "transcribing" for ten minutes.
		onStatus: (status) =>
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
			}),
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

export function withTranscript(
	document: AxcutDocument,
	transcript: AxcutTranscript,
): AxcutDocument {
	const transcripts = [
		...document.transcripts.filter((t) => t.assetId !== transcript.assetId),
		transcript,
	];
	return {
		...document,
		transcript:
			document.project.primaryAssetId === transcript.assetId ? transcript : document.transcript,
		transcripts,
	};
}
