// Typed read/write layer over `document.legacyEditor.captions`.
//
// Captions are NOT annotations. An annotation is a piece of content the user
// authored and placed on the timeline; a caption is a *rendering* of the
// transcript — the transcript stays the single source of truth and this object
// only says how it should look and where. Nothing here stores caption text.
//
// Same envelope + same access pattern as `store/editorSettings.ts` (the
// `legacyEditor` passthrough blob), so caption settings round-trip through save
// / load / undo with every other appearance setting and need no schema bump.

import { clamp } from "@/utils/math";
import type { AxcutDocument } from "../schema";

/** Vertical anchor of the caption band inside the frame. */
export type CaptionVerticalPosition = "top" | "middle" | "bottom";

/** Horizontal alignment of the text inside the (always centred) caption band. */
export type CaptionTextAlign = "left" | "center" | "right";

export interface CaptionSettings {
	/** Master show/hide for the whole caption layer (preview AND export). */
	enabled: boolean;
	/**
	 * Which language to display. `null` = the transcript's own language, i.e. the
	 * SSOT text verbatim. Any other value selects a non-destructive translation
	 * layer (see `translations.ts`) — the transcript is never rewritten.
	 */
	language: string | null;
	/** Pixels at a 1080-high frame, the same convention as `AnnotationTextStyle.fontSize`
	 *  — both the preview overlay and the compositor scale it by the height of the box
	 *  they draw into (see `annotationScale.ts`), so it is resolution-free. */
	fontSize: number;
	fontFamily: string;
	fontWeight: "normal" | "bold";
	color: string;
	/** When false the text draws straight over the video with no plate behind it. */
	backgroundEnabled: boolean;
	/** Hex, no alpha — the alpha comes from `backgroundOpacity`. */
	backgroundColor: string;
	/** 0–1. */
	backgroundOpacity: number;
	verticalPosition: CaptionVerticalPosition;
	textAlign: CaptionTextAlign;
	/** Fine vertical nudge, in % of frame height, applied on top of the anchor. */
	offsetY: number;
	/** Caption band width, in % of frame width. */
	width: number;
	/** Lower bound on words shown at once. */
	minWordsPerLine: number;
	/** Upper bound on words shown at once. */
	maxWordsPerLine: number;
}

export const DEFAULT_CAPTION_SETTINGS: CaptionSettings = {
	enabled: false,
	language: null,
	fontSize: 48,
	fontFamily: "Inter",
	fontWeight: "bold",
	color: "#ffffff",
	backgroundEnabled: true,
	backgroundColor: "#000000",
	backgroundOpacity: 0.55,
	verticalPosition: "bottom",
	textAlign: "center",
	offsetY: 0,
	width: 80,
	minWordsPerLine: 2,
	maxWordsPerLine: 7,
};

/** Band height as a % of frame height. Generous enough for two wrapped lines at
 *  the default size; the renderers clip to it, so it is deliberately not tight. */
export const CAPTION_BAND_HEIGHT_PCT = 22;

/** Margin between the band and the frame edge for the top/bottom anchors, in %. */
const CAPTION_EDGE_MARGIN_PCT = 3;

const VERTICAL_POSITIONS: readonly CaptionVerticalPosition[] = ["top", "middle", "bottom"];
const TEXT_ALIGNS: readonly CaptionTextAlign[] = ["left", "center", "right"];

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function readNumber(value: unknown, fallback: number, min: number, max: number): number {
	return isFiniteNumber(value) ? clamp(value, min, max) : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function readString(value: unknown, fallback: string): string {
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return typeof value === "string" && (allowed as readonly string[]).includes(value)
		? (value as T)
		: fallback;
}

function legacyBlob(doc: AxcutDocument | null | undefined): Record<string, unknown> | null {
	const legacy = doc?.legacyEditor;
	return typeof legacy === "object" && legacy !== null && !Array.isArray(legacy)
		? (legacy as Record<string, unknown>)
		: null;
}

function storedCaptions(doc: AxcutDocument | null | undefined): Record<string, unknown> | null {
	const stored = legacyBlob(doc)?.captions;
	return typeof stored === "object" && stored !== null && !Array.isArray(stored)
		? (stored as Record<string, unknown>)
		: null;
}

export function getCaptionSettings(doc: AxcutDocument | null | undefined): CaptionSettings {
	const raw = storedCaptions(doc);
	const d = DEFAULT_CAPTION_SETTINGS;
	if (!raw) return { ...d };

	const minWords = Math.round(readNumber(raw.minWordsPerLine, d.minWordsPerLine, 1, 12));
	const maxWords = Math.round(readNumber(raw.maxWordsPerLine, d.maxWordsPerLine, 1, 12));

	return {
		enabled: readBoolean(raw.enabled, d.enabled),
		// `null` is a meaningful value here ("show the original"), so an explicit
		// null must survive; only a missing/garbage entry falls back to the default.
		language: raw.language === null || typeof raw.language === "string" ? raw.language : d.language,
		fontSize: readNumber(raw.fontSize, d.fontSize, 12, 200),
		fontFamily: readString(raw.fontFamily, d.fontFamily),
		fontWeight: readEnum(raw.fontWeight, ["normal", "bold"] as const, d.fontWeight),
		color: readString(raw.color, d.color),
		backgroundEnabled: readBoolean(raw.backgroundEnabled, d.backgroundEnabled),
		backgroundColor: readString(raw.backgroundColor, d.backgroundColor),
		backgroundOpacity: readNumber(raw.backgroundOpacity, d.backgroundOpacity, 0, 1),
		verticalPosition: readEnum(raw.verticalPosition, VERTICAL_POSITIONS, d.verticalPosition),
		textAlign: readEnum(raw.textAlign, TEXT_ALIGNS, d.textAlign),
		offsetY: readNumber(raw.offsetY, d.offsetY, -45, 45),
		width: readNumber(raw.width, d.width, 20, 100),
		minWordsPerLine: Math.min(minWords, maxWords),
		maxWordsPerLine: Math.max(minWords, maxWords),
	};
}

export type CaptionSettingsPatch = Partial<CaptionSettings>;

/** Apply a patch and return the new document. Pure — no persistence. */
export function patchCaptionSettings(
	doc: AxcutDocument,
	patch: CaptionSettingsPatch,
): AxcutDocument {
	const next: CaptionSettings = { ...getCaptionSettings(doc), ...patch };
	return {
		...doc,
		legacyEditor: {
			...(legacyBlob(doc) ?? {}),
			captions: next,
		} as Record<string, unknown>,
	};
}

/** Where the caption band sits in the frame, as annotation-style percentages. */
export interface CaptionBandRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * The band is always horizontally centred — `textAlign` aligns the text *inside*
 * it, which is how subtitles behave everywhere. Vertical placement is the anchor
 * preset plus the user's nudge, clamped so the band can never leave the frame.
 */
export function captionBandRect(settings: CaptionSettings): CaptionBandRect {
	const width = clamp(settings.width, 20, 100);
	const height = CAPTION_BAND_HEIGHT_PCT;
	const anchorY =
		settings.verticalPosition === "top"
			? CAPTION_EDGE_MARGIN_PCT
			: settings.verticalPosition === "middle"
				? (100 - height) / 2
				: 100 - height - CAPTION_EDGE_MARGIN_PCT;
	return {
		x: (100 - width) / 2,
		y: clamp(anchorY + settings.offsetY, 0, 100 - height),
		width,
		height,
	};
}

/** `backgroundColor` + `backgroundOpacity` as one CSS/canvas colour, or
 *  `"transparent"` when the plate is off. */
export function captionBackgroundCss(settings: CaptionSettings): string {
	if (!settings.backgroundEnabled) return "transparent";
	const hex = settings.backgroundColor.replace("#", "");
	const full =
		hex.length === 3
			? hex
					.split("")
					.map((c) => c + c)
					.join("")
			: hex;
	const r = Number.parseInt(full.slice(0, 2), 16);
	const g = Number.parseInt(full.slice(2, 4), 16);
	const b = Number.parseInt(full.slice(4, 6), 16);
	if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
		return `rgba(0, 0, 0, ${clamp(settings.backgroundOpacity, 0, 1)})`;
	}
	return `rgba(${r}, ${g}, ${b}, ${clamp(settings.backgroundOpacity, 0, 1)})`;
}
