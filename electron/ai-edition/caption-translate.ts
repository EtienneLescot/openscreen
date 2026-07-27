// Caption translation through the configured chat LLM.
//
// This is deliberately NOT part of the agent tool loop: translating subtitles is
// a pure text transform with no reason to touch the document, so it runs as a
// one-shot, tool-free call (same shape as `chat-service`'s compaction call) and
// hands the renderer a plain `segmentId → text` map. The renderer is what writes
// it into the caption translation layer — the transcript is never modified, here
// or anywhere downstream.
//
// Segments are sent in batches with their ids attached so the model's output can
// be re-keyed exactly; anything it fails to return is simply left untranslated
// and shows the original text, which is the honest fallback for a partial run.

import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { createOpenScreenChatModel, messageContentToText } from "./deep-agent/chat-model";

/** One transcript segment to translate. */
export interface CaptionTranslateSegment {
	id: string;
	text: string;
}

export interface CaptionTranslateOptions {
	segments: CaptionTranslateSegment[];
	/** Target language, as the user named it (e.g. "French", "fr", "Português"). */
	targetLanguage: string;
	/** Source language hint from the transcript; "auto" / undefined is fine. */
	sourceLanguage?: string;
	provider: string;
	model: string;
	apiKey: string;
	baseUrl?: string;
	reasoningEffort?: string;
	/** Segments per request. Keeps each call small enough to stay reliable while
	 *  still giving the model surrounding context to translate coherently. */
	batchSize?: number;
	onProgress?: (done: number, total: number) => void;
	signal?: AbortSignal;
}

export interface CaptionTranslateResult {
	success: boolean;
	/** segmentId → translated text. Partial results are returned on failure too. */
	segments: Record<string, string>;
	error?: string;
}

const DEFAULT_BATCH_SIZE = 40;

const SYSTEM_PROMPT = [
	"You translate video subtitles.",
	"You are given a JSON array of subtitle segments, each with an `id` and a `text`.",
	"Translate every `text` into the requested target language.",
	"",
	"Rules:",
	"- Reply with JSON only: an array of objects with exactly the keys `id` and `text`. No prose, no code fences.",
	"- Return one entry per input segment, with the SAME `id`. Never merge, split, drop or reorder segments.",
	"- Keep each translation about as long as the original — these are timed subtitles, not prose.",
	"- Preserve names, product names, numbers, URLs and code identifiers verbatim.",
	"- Keep the register and the punctuation style of the original.",
	"- If a segment is already in the target language, return it unchanged.",
].join("\n");

function buildUserPrompt(
	segments: CaptionTranslateSegment[],
	targetLanguage: string,
	sourceLanguage?: string,
): string {
	const from =
		sourceLanguage && sourceLanguage !== "auto" ? ` The source language is ${sourceLanguage}.` : "";
	return [
		`Translate these subtitle segments into ${targetLanguage}.${from}`,
		"",
		JSON.stringify(
			segments.map((s) => ({ id: s.id, text: s.text })),
			null,
			0,
		),
	].join("\n");
}

/**
 * Pull the JSON array out of a model reply. Models wrap JSON in fences or add a
 * lead-in sentence often enough that a bare `JSON.parse` is not a fair test of
 * whether the translation worked — so strip the fence, then fall back to the
 * outermost bracket pair before giving up.
 */
export function parseTranslationReply(raw: string): Record<string, string> {
	const trimmed = raw.trim();
	const unfenced = trimmed
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "")
		.trim();

	const candidates = [unfenced];
	const first = unfenced.indexOf("[");
	const last = unfenced.lastIndexOf("]");
	if (first >= 0 && last > first) candidates.push(unfenced.slice(first, last + 1));

	for (const candidate of candidates) {
		try {
			const parsed: unknown = JSON.parse(candidate);
			if (!Array.isArray(parsed)) continue;
			const out: Record<string, string> = {};
			for (const entry of parsed) {
				if (!entry || typeof entry !== "object") continue;
				const { id, text } = entry as { id?: unknown; text?: unknown };
				if (typeof id === "string" && typeof text === "string" && text.trim()) {
					out[id] = text.trim();
				}
			}
			if (Object.keys(out).length > 0) return out;
		} catch {
			// Try the next candidate.
		}
	}
	return {};
}

export async function translateCaptionSegments(
	options: CaptionTranslateOptions,
): Promise<CaptionTranslateResult> {
	const segments = options.segments.filter((s) => s.text.trim().length > 0);
	if (segments.length === 0) return { success: true, segments: {} };

	const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
	const out: Record<string, string> = {};
	let done = 0;

	// Built once, not per batch: a long transcript is a lot of batches and the
	// model object is reusable across all of them.
	let model: Awaited<ReturnType<typeof createOpenScreenChatModel>>;
	try {
		model = await createOpenScreenChatModel({
			provider: options.provider,
			model: options.model,
			apiKey: options.apiKey,
			baseUrl: options.baseUrl,
			reasoningEffort: options.reasoningEffort,
		});
	} catch (error) {
		return {
			success: false,
			segments: out,
			error: error instanceof Error ? error.message : String(error),
		};
	}

	for (let i = 0; i < segments.length; i += batchSize) {
		if (options.signal?.aborted) {
			return { success: false, segments: out, error: "Translation cancelled." };
		}
		const batch = segments.slice(i, i + batchSize);
		let reply = "";
		try {
			const result = await model.invoke(
				[
					new SystemMessage(SYSTEM_PROMPT),
					new HumanMessage(buildUserPrompt(batch, options.targetLanguage, options.sourceLanguage)),
				],
				{ signal: options.signal },
			);
			reply = messageContentToText(result.content);
			if (!reply) {
				return {
					success: false,
					segments: out,
					error: "The model did not return a translation.",
				};
			}
		} catch (error) {
			return {
				success: false,
				segments: out,
				error: error instanceof Error ? error.message : String(error),
			};
		}

		const parsed = parseTranslationReply(reply);
		if (Object.keys(parsed).length === 0) {
			return {
				success: false,
				segments: out,
				error: "Could not read the model's reply as translated segments.",
			};
		}
		// Only accept ids we actually asked for — a hallucinated id would otherwise
		// sit in the translation layer forever, keyed to nothing.
		for (const segment of batch) {
			const text = parsed[segment.id];
			if (typeof text === "string" && text.trim()) out[segment.id] = text.trim();
		}

		done += batch.length;
		options.onProgress?.(done, segments.length);
	}

	return { success: true, segments: out };
}
