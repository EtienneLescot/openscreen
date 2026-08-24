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

/**
 * Which frame edge the caption block is pinned to. The block grows AWAY from it:
 * a bottom-anchored caption extends upward as its text wraps, so the anchored
 * edge never moves.
 *
 * This is the whole redesign in one field. The old model placed a fixed-height
 * band and let each renderer centre the ink inside it — and a centred block moves
 * BOTH its edges when it grows, which is why widening the band used to shift the
 * caption vertically and why no setting could hold it against an edge.
 *
 * `tts:displayAlign` (TTML/IMSC), `\an2` vs `\an8` (ASS), `line:0`/`line:-1`
 * (WebVTT) are the same idea; bottom-anchored growth is the default in all of
 * them. There is deliberately no "middle": it is the old pathology given a name
 * (XSL 1.1 defines `display-align: center` as keeping both edge distances equal),
 * and a bottom anchor with a large `insetY` reaches the same place while still
 * growing upward.
 */
export type CaptionAnchorV = "bottom" | "top";

/**
 * Which edge of the caption block is pinned horizontally — and, for a wrapped
 * caption, the ragged edge.
 *
 * One property, as in ASS, where the `\an` digit is the only horizontal control
 * the format has. It replaces BOTH the old `textAlign` (which aligned text inside
 * an invisible band) and the old `offsetX` (which moved that band): two controls
 * that fought over one visual outcome, neither of which could be understood
 * without seeing the band.
 */
export type CaptionAnchorH = "left" | "center" | "right";

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
	anchorV: CaptionAnchorV;
	/** Distance from the frame edge named by `anchorV` to the near edge of what is
	 *  actually DRAWN — the plate when the background is on, the glyph block when it
	 *  is off — in % of frame height. Always ≥ 0: it is a margin from a named edge,
	 *  which is how every subtitle format states position (ASS `MarginV`, WebVTT
	 *  `line`, TTML `tts:origin`) and why nothing here is ever a signed number.
	 *  0 puts the caption flush against the frame edge; 50 puts that edge on the
	 *  frame's midline. */
	insetY: number;
	anchorH: CaptionAnchorH;
	/** The same idea on the horizontal axis (ASS `MarginL` / `MarginR`): distance
	 *  from the frame edge named by `anchorH` to the near edge of the drawn block.
	 *  Ignored when `anchorH` is `"center"` — a centred block has no edge to measure
	 *  from, so the inspector hides the control rather than offering a dead one. */
	insetX: number;
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
	anchorV: "bottom",
	// Overridden per output aspect on first read (`defaultCaptionInsetY` /
	// `defaultCaptionInsetX`); these are the landscape values, and the ones a document
	// keeps once anything has been written.
	insetY: 1.5,
	anchorH: "center",
	insetX: 10,
	minWordsPerLine: 2,
	maxWordsPerLine: 7,
};

/** Reference frame height the px-valued settings are authored against, matching
 *  `annotationScale.ts` — `fontSize` is "pixels at a 1080-high frame". */
const CAPTION_REFERENCE_FRAME_HEIGHT = 1080;

/** Line box as a multiple of the font size, taken as an UPPER BOUND across the three
 *  rasterizers (cosmic-text is 1.4, DirectWrite and CoreText both lower). It only
 *  sizes the box's headroom, never the caption's position — see `captionBoxRect`. */
const CAPTION_LINE_HEIGHT_EM = 1.5;

/** Vertical padding the background plate adds above AND below the text block,
 *  as a multiple of the font size — `text_plate.rs::PAD_Y_EM`. */
const CAPTION_PLATE_PAD_Y_EM = 0.1;

/**
 * Visual lines the box is sized to hold.
 *
 * HEADROOM, NOT A POSITION. Because the block is anchored to one edge of this box,
 * getting the height wrong no longer moves the caption — it only changes how many
 * lines can be drawn before the renderer clips. That is the entire point of the
 * redesign: the old `CAPTION_BAND_CAPACITY_LINES = 2` *positioned* the ink (the band
 * was fixed and the ink centred inside it), so being wrong about it moved the
 * subtitle.
 *
 * Three is ample: `deriveCaptionCues` already groups the transcript into cues of
 * `minWordsPerLine`..`maxWordsPerLine` words, so one cue is one logical line and only
 * wraps when the column is narrow or the font large. At the default 48px this is 20%
 * of frame height — slightly LESS than the 22% band it replaces, so the per-cue
 * texture gets marginally smaller rather than larger.
 */
const CAPTION_BOX_LINES = 3;

/** Aspect ratio at or above which a frame counts as landscape for the safe column. */
const CAPTION_LANDSCAPE_ASPECT = 1.5;

/**
 * The column captions are laid out in, as % of frame width. This IS the max-width —
 * derived from the output aspect, never stored, never exposed as a control.
 *
 * It used to be a `width` slider, which was the most confusing control in the pane:
 * the background plate hugs the TEXT, so moving it changed nothing visible until the
 * text happened to be long enough to wrap. It only ever constrained wrapping, which
 * is a question about how much text is on screen — and that is already answered,
 * legibly, by `minWordsPerLine` / `maxWordsPerLine`.
 *
 * The numbers are the BBC line-length table: 68% of a 16:9 frame (≈45 characters at
 * 48px on 1080p, inside the Netflix 42 / BBC 37 band the editorial specs legislate),
 * 90% for squarer and vertical frames. Centred, a 16:9 column runs 16%→84%, inside
 * BBC's 12.5/87.5 title-safe box.
 */
export function captionSafeColumn(aspectValue: number): { x: number; width: number } {
	return aspectValue >= CAPTION_LANDSCAPE_ASPECT ? { x: 16, width: 68 } : { x: 5, width: 90 };
}

/** Default distance from the anchored edge, in % of frame height.
 *
 *  The landscape value is picked against the editor's DEFAULT PADDING rather than from
 *  a broadcast spec: the footage sits inset inside the frame, so a caption a hair off
 *  the frame edge lands where the eye expects it *relative to the picture*. It was
 *  chosen by looking at a 16:9 export.
 *
 *  Vertical keeps a much larger inset, and for an unrelated reason: the bottom eighth
 *  of a 9:16 export is where TikTok, Reels and Shorts draw their own chrome over the
 *  video, so a caption sitting a hair off that edge is a caption behind a UI. Nobody
 *  has eyeballed this one — it is the conservative value, and the slider is right
 *  there if it proves wrong. */
export function defaultCaptionInsetY(aspectValue: number): number {
	return aspectValue >= CAPTION_LANDSCAPE_ASPECT ? 1.5 : 12.5;
}

/** Default distance for the horizontal anchor, in % of frame width. Same source as the
 *  landscape `insetY`: it matches the default padding, not the safe column's own margin,
 *  which is why it is stated here rather than borrowed from `captionSafeColumn`. */
export function defaultCaptionInsetX(aspectValue: number): number {
	return aspectValue >= CAPTION_LANDSCAPE_ASPECT ? 10 : 5;
}

/** Upper bound for the vertical inset, in % of the frame. 50 puts the anchored edge
 *  on the midline — past that the anchor would point into the far half of the frame,
 *  which is what the opposite anchor is for. */
export const CAPTION_INSET_Y_MAX = 50;

/** Upper bound for the horizontal inset. A finer adjustment on a narrower axis: the
 *  column is already inset from the frame edge, and pushing much past this eats the
 *  wrap width without moving the caption anywhere useful. */
export const CAPTION_INSET_X_MAX = 25;

/** Where the caption box sits, as percentages of the OUTPUT FRAME.
 *
 *  Not of the screen rect: captions are subtitles, so they belong to the frame the
 *  viewer sees and must hold still when padding resizes the footage underneath them.
 *  `cues.ts` stamps the regions it builds from this with `space: "frame"`, which is
 *  what tells the compositor to measure them against the frame. */
export interface CaptionBoxRect {
	x: number;
	y: number;
	width: number;
	height: number;
	/** Which edge of the drawn block the compositor pins to this box. Travels to the
	 *  rasterizers as `verticalAlign`; absent there means "centre", which is the
	 *  behaviour every annotation still gets. */
	verticalAlign: CaptionAnchorV;
}

/**
 * The box a caption is laid out in, and the edge its drawn block is pinned to.
 *
 * The invariant this exists to guarantee, and the one the tests assert:
 *
 * > Bottom anchor: the drawn block's bottom edge is at `100 − insetY` % of frame
 * > height. Top anchor: its top edge is at `insetY` %. For every font size, every
 * > background state, every word count, every wrap outcome, every output resolution.
 *
 * Nothing in that sentence mentions line height, line count or the plate — and no
 * estimate of the block's height participates in placing it. The height below is only
 * how much room the block gets before it would be clipped, which is why being wrong
 * about it is now cheap.
 */
export function captionBoxRect(settings: CaptionSettings, aspectValue: number): CaptionBoxRect {
	const column = captionSafeColumn(aspectValue);
	const insetY = clamp(settings.insetY, 0, CAPTION_INSET_Y_MAX);
	const insetX = clamp(settings.insetX, 0, CAPTION_INSET_X_MAX);

	// Room for `CAPTION_BOX_LINES` lines plus the plate's own padding, capped so the
	// box itself never leaves the frame.
	const lines = CAPTION_BOX_LINES * CAPTION_LINE_HEIGHT_EM;
	const plate = settings.backgroundEnabled ? 2 * CAPTION_PLATE_PAD_Y_EM : 0;
	const capacityPct =
		((clamp(settings.fontSize, 12, 200) * (lines + plate)) / CAPTION_REFERENCE_FRAME_HEIGHT) * 100;
	const height = clamp(capacityPct, 10, 100 - insetY);

	// Left/right narrow the box rather than pushing it off-frame: the column is a MAX
	// width, so moving the pinned edge inward simply leaves less room to wrap in — and
	// that is visible in the guide overlay, unlike a range that silently shrinks.
	const width = settings.anchorH === "center" ? column.width : Math.min(column.width, 100 - insetX);
	const x =
		settings.anchorH === "left"
			? insetX
			: settings.anchorH === "right"
				? 100 - insetX - width
				: (100 - width) / 2;

	return {
		x,
		y: settings.anchorV === "bottom" ? 100 - insetY - height : insetY,
		width,
		height,
		verticalAlign: settings.anchorV,
	};
}

const ANCHORS_V: readonly CaptionAnchorV[] = ["bottom", "top"];
const ANCHORS_H: readonly CaptionAnchorH[] = ["left", "center", "right"];

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

/** Geometry of the band this file used to draw, kept only to migrate documents that
 *  still store it. A fixed 22%-tall box with `CAPTION_EDGE_MARGIN_PCT = 3` of margin,
 *  whose ink every renderer centred — the arrangement the anchor model replaces. */
const LEGACY_BAND_HEIGHT_PCT = 22;
const LEGACY_EDGE_MARGIN_PCT = 3;
const LEGACY_LINE_HEIGHT_EM = 1.4;
const LEGACY_CAPACITY_LINES = 2;

/**
 * Reconstruct where a pre-anchor document actually DREW its caption, and pin whichever
 * edge was closer to its frame edge.
 *
 * Migrating the fields would be meaningless — `verticalPosition` + `offsetY` describe a
 * band, and the band is gone. What survives is the pixels: the old band was a fixed
 * 22% box with the ink centred inside it, so the drawn block's top and bottom edges are
 * fully recoverable from the four settings that decided them. Pinning the nearer edge
 * is exactly what an anchor is, so a migrated caption does not move on screen.
 *
 * Returns `null` when the document stores nothing from the old model, which is the
 * common case after the first save and makes this inert.
 */
function migrateLegacyPlacement(
	raw: Record<string, unknown>,
	fontSize: number,
	backgroundEnabled: boolean,
	fallbackInsetY: number,
): Pick<CaptionSettings, "anchorV" | "insetY" | "anchorH" | "insetX"> | null {
	const legacyVertical = raw.verticalPosition;
	const hasLegacy =
		typeof legacyVertical === "string" ||
		isFiniteNumber(raw.offsetY) ||
		isFiniteNumber(raw.offsetX) ||
		isFiniteNumber(raw.width);
	if (!hasLegacy) return null;

	// The old band's anchor, before the user's nudge.
	const width = clamp(isFiniteNumber(raw.width) ? raw.width : 80, 20, 100);
	const anchorY =
		legacyVertical === "top"
			? LEGACY_EDGE_MARGIN_PCT
			: legacyVertical === "middle"
				? (100 - LEGACY_BAND_HEIGHT_PCT) / 2
				: 100 - LEGACY_BAND_HEIGHT_PCT - LEGACY_EDGE_MARGIN_PCT;
	const anchorX = (100 - width) / 2;

	// The ink the old model actually drew: a block of this height, centred in the band.
	const inkPx =
		clamp(fontSize, 12, 200) *
		(LEGACY_CAPACITY_LINES * LEGACY_LINE_HEIGHT_EM + (backgroundEnabled ? 0.2 : 0));
	const inkHeight = Math.min(
		LEGACY_BAND_HEIGHT_PCT,
		(inkPx / CAPTION_REFERENCE_FRAME_HEIGHT) * 100,
	);
	const overhang = Math.max(0, (LEGACY_BAND_HEIGHT_PCT - inkHeight) / 2);

	const offsetY = clamp(
		isFiniteNumber(raw.offsetY) ? raw.offsetY : 0,
		-overhang - anchorY,
		100 - LEGACY_BAND_HEIGHT_PCT + overhang - anchorY,
	);
	const bandY = anchorY + offsetY;
	const inkTop = bandY + (LEGACY_BAND_HEIGHT_PCT - inkHeight) / 2;
	const inkBottom = inkTop + inkHeight;

	// Pin the edge the caption was nearer to; ties go to the bottom, the default.
	const distanceToTop = inkTop;
	const distanceToBottom = 100 - inkBottom;
	const anchorV: CaptionAnchorV = distanceToTop < distanceToBottom ? "top" : "bottom";
	const insetY = clamp(
		anchorV === "top" ? distanceToTop : distanceToBottom,
		0,
		CAPTION_INSET_Y_MAX,
	);

	// Horizontally the old model had two controls fighting: `offsetX` moved the band and
	// `textAlign` moved the text inside it. What the viewer saw is the combination, so
	// take the one anchor nearest to where the ink actually sat.
	const offsetX = clamp(
		isFiniteNumber(raw.offsetX) ? raw.offsetX : 0,
		-anchorX,
		100 - width - anchorX,
	);
	const bandX = anchorX + offsetX;
	const legacyAlign = raw.textAlign;
	const inkCentre =
		legacyAlign === "left" ? bandX : legacyAlign === "right" ? bandX + width : bandX + width / 2;
	const anchorH: CaptionAnchorH =
		inkCentre < 100 / 3 ? "left" : inkCentre > (2 * 100) / 3 ? "right" : "center";
	// And the distance from that edge to where the band actually sat — the same
	// reproduce-the-pixels rule as the vertical half. Returning 0 here would have
	// snapped every migrated left/right caption flush to the frame edge, which is a
	// place the old band almost never was.
	const insetX = clamp(
		anchorH === "left" ? bandX : anchorH === "right" ? 100 - (bandX + width) : 0,
		0,
		CAPTION_INSET_X_MAX,
	);

	return {
		anchorV,
		insetY: Number.isFinite(insetY) ? insetY : fallbackInsetY,
		anchorH,
		insetX,
	};
}

/**
 * Read the caption settings, migrating a pre-anchor document on the way through.
 *
 * `aspectValue` only decides the DEFAULT inset for a document that has never carried
 * caption settings — a 5% inset is right for landscape and lands under the platform
 * chrome on a 9:16 export. Once anything is written, the stored value wins.
 */
export function getCaptionSettings(
	doc: AxcutDocument | null | undefined,
	aspectValue = 16 / 9,
): CaptionSettings {
	const raw = storedCaptions(doc);
	const d = DEFAULT_CAPTION_SETTINGS;
	const defaultInsetY = defaultCaptionInsetY(aspectValue);
	if (!raw) return { ...d, insetY: defaultInsetY, insetX: defaultCaptionInsetX(aspectValue) };

	const minWords = Math.round(readNumber(raw.minWordsPerLine, d.minWordsPerLine, 1, 12));
	const maxWords = Math.round(readNumber(raw.maxWordsPerLine, d.maxWordsPerLine, 1, 12));
	const fontSize = readNumber(raw.fontSize, d.fontSize, 12, 200);
	const backgroundEnabled = readBoolean(raw.backgroundEnabled, d.backgroundEnabled);

	// New fields win whenever they are present, so the migration runs once and is inert
	// afterwards; it only speaks for a document that still carries the old ones.
	const legacy = migrateLegacyPlacement(raw, fontSize, backgroundEnabled, defaultInsetY);
	const placement = {
		anchorV: readEnum(raw.anchorV, ANCHORS_V, legacy?.anchorV ?? d.anchorV),
		insetY: readNumber(raw.insetY, legacy?.insetY ?? defaultInsetY, 0, CAPTION_INSET_Y_MAX),
		anchorH: readEnum(raw.anchorH, ANCHORS_H, legacy?.anchorH ?? d.anchorH),
		insetX: readNumber(
			raw.insetX,
			legacy?.insetX ?? defaultCaptionInsetX(aspectValue),
			0,
			CAPTION_INSET_X_MAX,
		),
	};

	return {
		enabled: readBoolean(raw.enabled, d.enabled),
		// `null` is a meaningful value here ("show the original"), so an explicit
		// null must survive; only a missing/garbage entry falls back to the default.
		language: raw.language === null || typeof raw.language === "string" ? raw.language : d.language,
		fontSize,
		fontFamily: readString(raw.fontFamily, d.fontFamily),
		fontWeight: readEnum(raw.fontWeight, ["normal", "bold"] as const, d.fontWeight),
		color: readString(raw.color, d.color),
		backgroundEnabled,
		backgroundColor: readString(raw.backgroundColor, d.backgroundColor),
		backgroundOpacity: readNumber(raw.backgroundOpacity, d.backgroundOpacity, 0, 1),
		...placement,
		minWordsPerLine: Math.min(minWords, maxWords),
		maxWordsPerLine: Math.max(minWords, maxWords),
	};
}

export type CaptionSettingsPatch = Partial<CaptionSettings>;

/**
 * Apply a patch and return the new document. Pure — no persistence.
 *
 * There is no re-clamping pass any more, and that absence is the point: an inset is a
 * distance from a named edge, so it means the same thing whatever the font size, the
 * background or the other axis does. The old offsets had to be re-clamped on every
 * patch because their reachable span moved with four other fields — which is also why
 * they could not be shown to a user as a plain number.
 */
export function patchCaptionSettings(
	doc: AxcutDocument,
	patch: CaptionSettingsPatch,
	aspectValue = 16 / 9,
): AxcutDocument {
	// The aspect matters on the FIRST write to a document that has never carried
	// caption settings: that write is what materialises the defaults, and a portrait
	// export wants a much larger inset than a landscape one. Reading without it here
	// would freeze the landscape default into a 9:16 project — the exact failure the
	// aspect-derived default exists to prevent.
	const next: CaptionSettings = { ...getCaptionSettings(doc, aspectValue), ...patch };
	next.insetY = clamp(next.insetY, 0, CAPTION_INSET_Y_MAX);
	next.insetX = clamp(next.insetX, 0, CAPTION_INSET_X_MAX);
	return {
		...doc,
		legacyEditor: {
			...(legacyBlob(doc) ?? {}),
			captions: next,
		} as Record<string, unknown>,
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
