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
	/** Fine vertical nudge, in % of OUTPUT FRAME height, applied on top of the anchor.
	 *  Positive moves down. The reachable span depends on the anchor — see
	 *  `captionOffsetRange`, which the inspector uses for its slider bounds so that
	 *  every position on the slider is a position the band can actually take. */
	offsetY: number;
	/** Fine horizontal nudge, in % of OUTPUT FRAME width, applied on top of the
	 *  (centred) anchor. Positive moves toward the right edge of the exported frame —
	 *  this is frame geometry, so it is never mirrored by an RTL interface locale. */
	offsetX: number;
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
	offsetX: 0,
	width: 80,
	minWordsPerLine: 2,
	maxWordsPerLine: 7,
};

/** Band height as a % of frame height. Generous enough for two wrapped lines at
 *  the default size; the renderers clip to it, so it is deliberately not tight. */
export const CAPTION_BAND_HEIGHT_PCT = 22;

/** Margin between the band and the frame edge for the top/bottom anchors, in %. */
export const CAPTION_EDGE_MARGIN_PCT = 3;

/** Reference frame height the px-valued settings are authored against, matching
 *  `annotationScale.ts` — `fontSize` is "pixels at a 1080-high frame". */
const CAPTION_REFERENCE_FRAME_HEIGHT = 1080;

/** Line box as a multiple of the font size. Mirrors the rasterizers so the band
 *  maths and the drawn glyphs agree: `text_linux.rs` is `font_size * 1.4`, and the
 *  other two backends lay out through the same `text_plate` box model. */
const CAPTION_LINE_HEIGHT_EM = 1.4;

/** Vertical padding the background plate adds above AND below the text block,
 *  as a multiple of the font size — `text_plate.rs::PAD_Y_EM`. */
const CAPTION_PLATE_PAD_Y_EM = 0.1;

/** Lines the band is sized to hold. The band is a fixed 22% box and all three
 *  rasterizers centre the text inside it, so this is what decides how much of the
 *  box is guaranteed to carry ink — and therefore how far the box may hang off the
 *  frame before a caption would be clipped (see `captionOffsetRange`). */
const CAPTION_BAND_CAPACITY_LINES = 2;

/**
 * Height of the drawn caption block — the background plate when it is on, the text
 * block alone when it is off — as a % of frame height, capped at the band it lives
 * in. The band is deliberately taller than its content, so this is the slice of the
 * band that actually carries pixels.
 */
export function captionInkHeightPct(settings: CaptionSettings): number {
	const lines = CAPTION_BAND_CAPACITY_LINES * CAPTION_LINE_HEIGHT_EM;
	const plate = settings.backgroundEnabled ? 2 * CAPTION_PLATE_PAD_Y_EM : 0;
	const px = clamp(settings.fontSize, 12, 200) * (lines + plate);
	return Math.min(CAPTION_BAND_HEIGHT_PCT, (px / CAPTION_REFERENCE_FRAME_HEIGHT) * 100);
}

/**
 * How far the band may hang off the top/bottom of the frame, in % of frame height.
 *
 * This is the whole of the "the offset can't reach the edge" half of #396. The band
 * is a 22%-tall box whose text every renderer centres, so a band stopped flush at the
 * frame edge still leaves its glyphs half a band short of it. Letting the box spill by
 * exactly its empty margin puts the ink on the edge while keeping every drawn pixel
 * on-frame — and costs nothing in the rasterizers, which already clip to the box.
 */
function captionBandOverhangPct(settings: CaptionSettings): number {
	return Math.max(0, (CAPTION_BAND_HEIGHT_PCT - captionInkHeightPct(settings)) / 2);
}

/** The band's anchor position before the user's nudge, in % of the frame. */
function captionAnchor(settings: CaptionSettings): { x: number; y: number } {
	const width = clamp(settings.width, 20, 100);
	const height = CAPTION_BAND_HEIGHT_PCT;
	return {
		x: (100 - width) / 2,
		y:
			settings.verticalPosition === "top"
				? CAPTION_EDGE_MARGIN_PCT
				: settings.verticalPosition === "middle"
					? (100 - height) / 2
					: 100 - height - CAPTION_EDGE_MARGIN_PCT,
	};
}

/** Inclusive min/max for each offset, in % of the frame. */
export interface CaptionOffsetRange {
	x: { min: number; max: number };
	y: { min: number; max: number };
}

/**
 * The offsets the current settings can actually honour.
 *
 * Both the reader's clamp and the inspector's sliders come from here, so the two can
 * never disagree: every value the slider can produce moves the band, and no value it
 * can produce is silently discarded. The old code hard-coded ±45 in both places and
 * then clamped the *result*, which is why nearly half the bottom-anchored slider's
 * travel did nothing at all.
 */
export function captionOffsetRange(settings: CaptionSettings): CaptionOffsetRange {
	const width = clamp(settings.width, 20, 100);
	const anchor = captionAnchor(settings);
	const overhang = captionBandOverhangPct(settings);
	return {
		// Horizontally the band stays wholly on-frame: `textAlign` lets a line hug the
		// band's own edge, so an overhang here would push text off the frame.
		x: { min: -anchor.x, max: 100 - width - anchor.x },
		y: {
			min: -overhang - anchor.y,
			max: 100 - CAPTION_BAND_HEIGHT_PCT + overhang - anchor.y,
		},
	};
}

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

	const settings: CaptionSettings = {
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
		// Read wide here, then clamp to what the geometry allows below: the reachable
		// span depends on the anchor, the width and the font size, which are only known
		// once the rest of the object is built.
		offsetY: readNumber(raw.offsetY, d.offsetY, -100, 100),
		offsetX: readNumber(raw.offsetX, d.offsetX, -100, 100),
		width: readNumber(raw.width, d.width, 20, 100),
		minWordsPerLine: Math.min(minWords, maxWords),
		maxWordsPerLine: Math.max(minWords, maxWords),
	};

	// Normalising here rather than at the draw call keeps the stored value, the slider
	// position and the drawn band the same number. A value that the current anchor
	// cannot reach — a leftover from another anchor, or from the old ±45 domain — is
	// pulled to the nearest reachable one instead of being clamped invisibly later.
	const range = captionOffsetRange(settings);
	settings.offsetY = clamp(settings.offsetY, range.y.min, range.y.max);
	settings.offsetX = clamp(settings.offsetX, range.x.min, range.x.max);
	return settings;
}

export type CaptionSettingsPatch = Partial<CaptionSettings>;

/** Apply a patch and return the new document. Pure — no persistence. */
export function patchCaptionSettings(
	doc: AxcutDocument,
	patch: CaptionSettingsPatch,
): AxcutDocument {
	const next: CaptionSettings = { ...getCaptionSettings(doc), ...patch };
	// Re-clamp against the geometry the patch just produced, not the one it
	// replaced: `width`, `fontSize`, `backgroundEnabled` and `verticalPosition` all
	// move the reachable span, so a patch to any of them can strand an offset
	// outside it. `getCaptionSettings` would pull it back on the next read, but
	// until then the document would hold a number the band never draws — and the
	// next patch would write that stale number back out.
	const range = captionOffsetRange(next);
	next.offsetY = clamp(next.offsetY, range.y.min, range.y.max);
	next.offsetX = clamp(next.offsetX, range.x.min, range.x.max);
	return {
		...doc,
		legacyEditor: {
			...(legacyBlob(doc) ?? {}),
			captions: next,
		} as Record<string, unknown>,
	};
}

/** Where the caption band sits, as percentages of the OUTPUT FRAME.
 *
 *  Not of the screen rect: captions are subtitles, so they belong to the frame the
 *  viewer sees and must hold still when padding resizes the footage underneath them.
 *  `cues.ts` stamps the regions it builds from this with `space: "frame"`, which is
 *  what tells the compositor to measure them against the frame (see `CaptionTextRegion`). */
export interface CaptionBandRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Anchor preset plus the user's nudge, on both axes.
 *
 * `textAlign` aligns the text *inside* the band, which is how subtitles behave
 * everywhere; `offsetX` moves the band itself, which is the only way to reach a
 * corner. Offsets are clamped to `captionOffsetRange` — the same span the inspector
 * hands its sliders, so nothing the user can dial in is quietly thrown away.
 */
export function captionBandRect(settings: CaptionSettings): CaptionBandRect {
	const width = clamp(settings.width, 20, 100);
	const anchor = captionAnchor(settings);
	const range = captionOffsetRange(settings);
	return {
		x: anchor.x + clamp(settings.offsetX, range.x.min, range.x.max),
		y: anchor.y + clamp(settings.offsetY, range.y.min, range.y.max),
		width,
		height: CAPTION_BAND_HEIGHT_PCT,
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
