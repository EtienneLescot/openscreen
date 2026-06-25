// Adapter: wraps OpenScreen's existing local Whisper pipeline (transformers.js,
// src/lib/captioning/) as a transcribeAsset function that returns an
// AxcutTranscript and persists it into the document.
//
// ponytail: reuses extractMono16kFromVideoUrl + transcribeMono16kToSegments
// verbatim. No Python, no faster-whisper, no network calls. Privacy-safe.

import { toFileUrl } from "@/components/video-editor/projectPersistence";
import { extractMono16kFromVideoUrl, transcribeMono16kToSegments } from "@/lib/captioning";
import type { AxcutDocument, AxcutTranscript, AxcutTranscriptSegment, AxcutWord } from "../schema";

export interface TranscribeAssetOptions {
	language?: string;
	onStatus?: (status: string) => void;
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

	options.onStatus?.("extracting-audio");
	const audioResult = await extractMono16kFromVideoUrl(videoUrl, {
		signal: options.signal,
	});

	options.onStatus?.("transcribing");
	const result = await transcribeMono16kToSegments(audioResult.samples, {
		trimRegions: [],
		signal: options.signal,
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
		language: options.language ?? "auto",
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
		preview: { ...document.preview, revision: document.preview.revision + 1 },
	};
}
