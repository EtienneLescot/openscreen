// Non-destructive translation layer for captions.
//
// The rule this module exists to enforce: **the transcript is the SSOT and is
// never rewritten**. A translation is a side table keyed by transcript segment
// id — timings, word boundaries and the original text all stay untouched, so
// switching back to the original language is a no-op read and re-transcribing
// never silently loses a translation's *timing* (only text whose segment id
// vanished becomes unused).
//
// Keying by segment id (not by caption line) is deliberate: caption lines are a
// derived, settings-dependent grouping — change "words per line" and every line
// boundary moves — whereas a segment is a stable unit of the transcript.
//
// Stored in the `legacyEditor` passthrough envelope, like `settings.ts`.

import type { AxcutDocument, AxcutTranscript } from "../schema";

export interface CaptionTranslation {
	/** Language code as chosen by the user, e.g. `"fr"`, `"pt-BR"`. */
	language: string;
	/** Human-readable name for the picker, e.g. `"Français"`. */
	label: string;
	/** ISO timestamp of the last (re)translation. */
	updatedAt: string;
	/** Model that produced it, for provenance in the UI. */
	model?: string;
	/** assetId → (transcript segment id → translated text). */
	byAsset: Record<string, Record<string, string>>;
}

/** language code → translation. */
export type CaptionTranslations = Record<string, CaptionTranslation>;

function legacyBlob(doc: AxcutDocument | null | undefined): Record<string, unknown> | null {
	const legacy = doc?.legacyEditor;
	return typeof legacy === "object" && legacy !== null && !Array.isArray(legacy)
		? (legacy as Record<string, unknown>)
		: null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringMap(value: unknown): Record<string, string> {
	if (!isPlainObject(value)) return {};
	const out: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "string") out[key] = entry;
	}
	return out;
}

export function getCaptionTranslations(doc: AxcutDocument | null | undefined): CaptionTranslations {
	const raw = legacyBlob(doc)?.captionTranslations;
	if (!isPlainObject(raw)) return {};

	const out: CaptionTranslations = {};
	for (const [language, entry] of Object.entries(raw)) {
		if (!isPlainObject(entry)) continue;
		const byAssetRaw = entry.byAsset;
		const byAsset: Record<string, Record<string, string>> = {};
		if (isPlainObject(byAssetRaw)) {
			for (const [assetId, segments] of Object.entries(byAssetRaw)) {
				byAsset[assetId] = readStringMap(segments);
			}
		}
		out[language] = {
			language,
			label: typeof entry.label === "string" && entry.label ? entry.label : language,
			updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : "",
			...(typeof entry.model === "string" ? { model: entry.model } : {}),
			byAsset,
		};
	}
	return out;
}

/**
 * Merge one asset's translated segments into a language layer, creating the
 * layer if it doesn't exist. Merging (rather than replacing) is what lets a
 * multi-asset project be translated one asset at a time, and lets a re-run over
 * a subset of segments patch just those.
 */
export function putCaptionTranslation(
	doc: AxcutDocument,
	input: {
		language: string;
		label: string;
		assetId: string;
		segments: Record<string, string>;
		model?: string;
		updatedAt?: string;
	},
): AxcutDocument {
	const existing = getCaptionTranslations(doc);
	const previous = existing[input.language];
	const merged: CaptionTranslation = {
		language: input.language,
		label: input.label || previous?.label || input.language,
		updatedAt: input.updatedAt ?? new Date().toISOString(),
		...(input.model ? { model: input.model } : previous?.model ? { model: previous.model } : {}),
		byAsset: {
			...(previous?.byAsset ?? {}),
			[input.assetId]: {
				...(previous?.byAsset?.[input.assetId] ?? {}),
				...input.segments,
			},
		},
	};

	return {
		...doc,
		legacyEditor: {
			...(legacyBlob(doc) ?? {}),
			captionTranslations: { ...existing, [input.language]: merged },
		} as Record<string, unknown>,
	};
}

/** Drop a whole language layer. The transcript is unaffected, by construction. */
export function removeCaptionTranslation(doc: AxcutDocument, language: string): AxcutDocument {
	const existing = getCaptionTranslations(doc);
	if (!(language in existing)) return doc;
	const { [language]: _dropped, ...rest } = existing;
	return {
		...doc,
		legacyEditor: {
			...(legacyBlob(doc) ?? {}),
			captionTranslations: rest,
		} as Record<string, unknown>,
	};
}

/**
 * Segments of `transcript` that have no text yet in `language` — the work list
 * for a (re)translation run, so an interrupted or extended translation only
 * costs the missing pieces.
 */
export function untranslatedSegments(
	transcript: AxcutTranscript,
	translations: CaptionTranslations,
	language: string,
): AxcutTranscript["segments"] {
	const done = translations[language]?.byAsset[transcript.assetId] ?? {};
	return transcript.segments.filter((segment) => {
		if (!segment.text.trim()) return false;
		const existing = done[segment.id];
		return typeof existing !== "string" || existing.trim().length === 0;
	});
}

/** How much of one asset's transcript is covered by a language layer. */
export function translationCoverage(
	transcript: AxcutTranscript,
	translations: CaptionTranslations,
	language: string,
): { translated: number; total: number } {
	const total = transcript.segments.filter((s) => s.text.trim()).length;
	return {
		translated: total - untranslatedSegments(transcript, translations, language).length,
		total,
	};
}
