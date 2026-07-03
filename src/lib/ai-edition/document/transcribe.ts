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

// ponytail: emit the upstream `AXCUT_TRANSCRIPT v1` plain-text DSL for display
// in the Source Transcript modal. Mirrors `axcut_core/dsl.py` just enough for
// the modal's <pre> body — a small segment/word loop, no Python needed. The
// runtime still uses the structured `AxcutTranscript`; this string is the
// "what the user reads" view of the same data.
// Escape both single and double quotes — the DSL wraps every string in
// double quotes and uses SQL/Python-style `''` doubling for an embedded
// single quote.
function escapeDslString(s: string): string {
	return s.replace(/"/g, '""').replace(/'/g, "''");
}

export function toAxcutTranscriptDsl(
	transcript: AxcutTranscript,
	sourceLabel?: string,
	durationSec?: number,
): string {
	const lines: string[] = ["AXCUT_TRANSCRIPT v1"];
	const meta: string[] = [];
	if (sourceLabel) meta.push(`source_video="${sourceLabel}"`);
	if (typeof durationSec === "number" && Number.isFinite(durationSec)) {
		meta.push(`duration=${durationSec.toFixed(3)}`);
	}
	meta.push(`language="${transcript.language || "auto"}"`, `kind="source"`);
	lines.push(`META ${meta.join(" ")}`);

	const segIndexById = new Map<string, number>();
	transcript.segments.forEach((seg, i) => segIndexById.set(seg.id, i + 1));

	for (const seg of transcript.segments) {
		lines.push(
			`SEGMENT id=s${String(segIndexById.get(seg.id) ?? 0).padStart(4, "0")} start=${seg.startSec.toFixed(3)} end=${seg.endSec.toFixed(3)} text="${escapeDslString(seg.text)}"`,
		);
		for (const wordId of seg.wordIds) {
			const word = transcript.words.find((w) => w.id === wordId);
			if (!word) continue;
			const wSegIdx = segIndexById.get(word.segmentId) ?? 0;
			lines.push(
				`WORD id=w${String(transcript.words.indexOf(word) + 1).padStart(6, "0")} segment=s${String(wSegIdx).padStart(4, "0")} start=${word.startSec.toFixed(3)} end=${word.endSec.toFixed(3)} text="${escapeDslString(word.text)}"`,
			);
		}
		lines.push("ENDSEGMENT");
	}
	return lines.join("\n");
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
