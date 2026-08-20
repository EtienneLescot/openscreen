// Typed read/write layer over `document.legacyEditor`.
//
// The v3 schema keeps `legacyEditor` as a `Record<string, unknown>` envelope so
// v2 projects round-trip without losing fields. The right panes and the
// per-region inspectors need a typed surface — this module provides it.
//
// The shape mirrors the legacy editor's `ProjectEditorState` so the same names
// are used everywhere; values that v3 owns directly (zoomRanges, annotations,
// transcripts, clips) stay in their dedicated fields.

import {
	type CropRegion,
	type CursorVisualSettings,
	DEFAULT_CROP_REGION,
	DEFAULT_CURSOR_CLICK_BOUNCE,
	DEFAULT_CURSOR_CLIP_TO_BOUNDS,
	DEFAULT_CURSOR_MOTION_BLUR,
	DEFAULT_CURSOR_SIZE,
	DEFAULT_CURSOR_SMOOTHING,
	DEFAULT_WEBCAM_LAYOUT_PRESET,
	DEFAULT_WEBCAM_MASK_SHAPE,
	DEFAULT_WEBCAM_MIRRORED,
	DEFAULT_WEBCAM_POSITION,
	DEFAULT_WEBCAM_REACTIVE_ZOOM,
	DEFAULT_WEBCAM_SIZE_PRESET,
	type WebcamLayoutPreset,
	type WebcamMaskShape,
	type WebcamPosition,
	type WebcamSizePreset,
} from "@/components/video-editor/types";
import { DEFAULT_CURSOR_THEME_ID } from "@/lib/cursor/cursorThemes";
import { DEFAULT_WALLPAPER } from "@/lib/wallpaper";
import type { AspectRatio } from "@/utils/aspectRatioUtils";
import type { AxcutDocument } from "../schema";

// ponytail: avoid dragging in lib/exporter full surface here — we only
// need the type names. Wallpaper + cursor theme are stored as plain strings
// for the same reason (their canonical types live in lib/wallpaper and
// lib/cursor/cursorThemes as the source of truth).

/** Output gain bound, shared by the slider, this store and `finish_audio` (Rust).
 *
 *  A linear gain is the one audio setting that behaves identically on the preview's source
 *  file and on the export's assembled timeline, which is why it is the only one left. A sync
 *  offset was tried and removed: the preview seeks in SOURCE time while the export shifts the
 *  stretched, concatenated timeline, so the same value meant different delays under a speed
 *  region, and near a cut the export pulls audio across the junction while the preview cannot. */
export const AUDIO_GAIN_DB_LIMIT = 12;

/** dB to the linear scalar every side of the boundary multiplies by.
 *
 *  Exported rather than written out three times. `finish_audio` applies
 *  `10f32.powf(gain_db / 20.0)` per sample; the preview feeds this to a `GainNode`; the
 *  timeline waveform scales its bars by it. The claim those three make together — that what
 *  you see is what you hear is what you export — only holds while they are the same number,
 *  and a hand-copied `10 ** (dB / 20)` is exactly how that stops being true. */
export function audioGainScalar(gainDb: number): number {
	return 10 ** (gainDb / 20);
}

/**
 * Where the webcam crop window sits inside the room its zoom leaves, 0..1 per axis:
 * 0 hard against one edge, 1 against the other, 0.5 centred.
 *
 * Stored because the rect cannot hold it. At 100% zoom the crop IS the frame, so `x` and `y`
 * are necessarily 0 and the pan they used to be read back from is gone — which meant a trip
 * down to 100% and back erased the framing the user had set. Expressed as a fraction of the
 * available room, the pan survives every zoom, including the one where it does not apply.
 *
 * This never leaves the app. `webcamCropRegion` remains the only thing the scene carries to
 * the compositor, so the preview and the export see exactly what they saw before.
 */
export interface CropPan {
	x: number;
	y: number;
}

/** Centred: the crop window sits in the middle of whatever room the zoom leaves. */
const DEFAULT_CROP_PAN: CropPan = { x: 0.5, y: 0.5 };

export interface EditorSettingsSnapshot {
	wallpaper: string;
	aspectRatio: AspectRatio;
	shadowIntensity: number;
	showBlur: boolean;
	motionBlurAmount: number;
	borderRadius: number;
	padding: number;
	cropRegion: CropRegion;
	webcamLayoutPreset: WebcamLayoutPreset;
	webcamMaskShape: WebcamMaskShape;
	webcamMirrored: boolean;
	webcamReactiveZoom: boolean;
	webcamSizePreset: WebcamSizePreset;
	webcamPosition: WebcamPosition | null;
	webcamCropRegion: CropRegion;
	/** Where the crop window sits in the room the zoom leaves it, 0..1 per axis.
	 *  Authoritative: `webcamCropRegion.x/y` are rebuilt from it on read. */
	webcamCropPan: CropPan;
	audioGainDb: number;
	cursor: CursorVisualSettings;
	cursorShow: boolean;
	cursorTheme: string;
	autoFocusAll: boolean;
}

export const DEFAULT_EDITOR_SETTINGS: EditorSettingsSnapshot = {
	wallpaper: DEFAULT_WALLPAPER,
	aspectRatio: "16:9",
	// Opinionated by default: the wallpaper and the padding were already on, but
	// with square corners and no shadow the recording read as a rectangle pasted
	// onto the background rather than a window floating above it (#271 reported
	// the symptom and blamed the padding). These three are the rest of that look;
	// shipping the background without them was shipping half a composition.
	shadowIntensity: 0.2,
	showBlur: false,
	motionBlurAmount: 0.2,
	borderRadius: 40,
	padding: 50,
	cropRegion: DEFAULT_CROP_REGION,
	webcamLayoutPreset: DEFAULT_WEBCAM_LAYOUT_PRESET,
	webcamMaskShape: DEFAULT_WEBCAM_MASK_SHAPE,
	webcamMirrored: DEFAULT_WEBCAM_MIRRORED,
	webcamReactiveZoom: DEFAULT_WEBCAM_REACTIVE_ZOOM,
	webcamSizePreset: DEFAULT_WEBCAM_SIZE_PRESET,
	webcamPosition: DEFAULT_WEBCAM_POSITION,
	webcamCropRegion: DEFAULT_CROP_REGION,
	webcamCropPan: DEFAULT_CROP_PAN,
	audioGainDb: 0,
	cursor: {
		size: DEFAULT_CURSOR_SIZE,
		smoothing: DEFAULT_CURSOR_SMOOTHING,
		motionBlur: DEFAULT_CURSOR_MOTION_BLUR,
		clickBounce: DEFAULT_CURSOR_CLICK_BOUNCE,
		clipToBounds: DEFAULT_CURSOR_CLIP_TO_BOUNDS,
	},
	cursorShow: true,
	cursorTheme: DEFAULT_CURSOR_THEME_ID,
	autoFocusAll: false,
};

interface LegacyShape {
	wallpaper?: string;
	aspectRatio?: AspectRatio;
	shadowIntensity?: number;
	showBlur?: boolean;
	motionBlurAmount?: number;
	borderRadius?: number;
	padding?: number;
	cropRegion?: CropRegion;
	webcamLayoutPreset?: WebcamLayoutPreset;
	webcamMaskShape?: WebcamMaskShape;
	webcamMirrored?: boolean;
	webcamReactiveZoom?: boolean;
	webcamSizePreset?: WebcamSizePreset;
	webcamPosition?: WebcamPosition | null;
	webcamCropRegion?: CropRegion;
	webcamCropPan?: CropPan;
	audioGainDb?: number;
	cursorSize?: number;
	cursorSmoothing?: number;
	cursorMotionBlur?: number;
	cursorClickBounce?: number;
	cursorClipToBounds?: boolean;
	cursorShow?: boolean;
	cursorTheme?: string;
	autoFocusAll?: boolean;
}
function isShape(value: unknown): value is LegacyShape {
	return typeof value === "object" && value !== null;
}

function isNumber(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v);
}
function isBoolean(v: unknown): v is boolean {
	return typeof v === "boolean";
}
function isString(v: unknown): v is string {
	return typeof v === "string";
}

export function getEditorSettings(doc: AxcutDocument | null | undefined): EditorSettingsSnapshot {
	const legacy = isShape(doc?.legacyEditor) ? (doc.legacyEditor as LegacyShape) : null;
	const num = (v: unknown, fallback: number) => (isNumber(v) ? v : fallback);
	const bool = (v: unknown, fallback: boolean) => (isBoolean(v) ? v : fallback);
	const str = (v: unknown, fallback: string) => (isString(v) ? v : fallback);

	const cursor: CursorVisualSettings = {
		size: num(legacy?.cursorSize, DEFAULT_EDITOR_SETTINGS.cursor.size),
		smoothing: num(legacy?.cursorSmoothing, DEFAULT_EDITOR_SETTINGS.cursor.smoothing),
		motionBlur: num(legacy?.cursorMotionBlur, DEFAULT_EDITOR_SETTINGS.cursor.motionBlur),
		clickBounce: num(legacy?.cursorClickBounce, DEFAULT_EDITOR_SETTINGS.cursor.clickBounce),
		clipToBounds: bool(legacy?.cursorClipToBounds, DEFAULT_EDITOR_SETTINGS.cursor.clipToBounds),
	};

	// The pan is authoritative and the rect's offset is rebuilt from it, so the two cannot
	// drift apart — on disk, or in a patch that wrote one and not the other. Only the SIZE
	// survives from the stored rect; `pan * (1 - size)` is a position that cannot leave the
	// frame, which is why nothing here clamps it.
	const storedCrop = normaliseCropRegion(legacy?.webcamCropRegion);
	const webcamCropPan = normaliseCropPan(legacy?.webcamCropPan, storedCrop);
	const webcamCrop: CropRegion = {
		...storedCrop,
		x: webcamCropPan.x * (1 - storedCrop.width),
		y: webcamCropPan.y * (1 - storedCrop.height),
	};

	return {
		wallpaper: str(legacy?.wallpaper, DEFAULT_EDITOR_SETTINGS.wallpaper),
		aspectRatio: legacy?.aspectRatio ?? DEFAULT_EDITOR_SETTINGS.aspectRatio,
		shadowIntensity: num(legacy?.shadowIntensity, DEFAULT_EDITOR_SETTINGS.shadowIntensity),
		showBlur: bool(legacy?.showBlur, DEFAULT_EDITOR_SETTINGS.showBlur),
		motionBlurAmount: num(legacy?.motionBlurAmount, DEFAULT_EDITOR_SETTINGS.motionBlurAmount),
		borderRadius: num(legacy?.borderRadius, DEFAULT_EDITOR_SETTINGS.borderRadius),
		padding: num(legacy?.padding, DEFAULT_EDITOR_SETTINGS.padding),
		cropRegion: legacy?.cropRegion ?? DEFAULT_EDITOR_SETTINGS.cropRegion,
		webcamLayoutPreset: legacy?.webcamLayoutPreset ?? DEFAULT_EDITOR_SETTINGS.webcamLayoutPreset,
		webcamMaskShape: legacy?.webcamMaskShape ?? DEFAULT_EDITOR_SETTINGS.webcamMaskShape,
		webcamMirrored: bool(legacy?.webcamMirrored, DEFAULT_EDITOR_SETTINGS.webcamMirrored),
		webcamReactiveZoom: bool(
			legacy?.webcamReactiveZoom,
			DEFAULT_EDITOR_SETTINGS.webcamReactiveZoom,
		),
		webcamSizePreset: num(legacy?.webcamSizePreset, DEFAULT_EDITOR_SETTINGS.webcamSizePreset),
		webcamPosition: normaliseWebcamPosition(legacy?.webcamPosition),
		webcamCropRegion: webcamCrop,
		webcamCropPan: webcamCropPan,
		// Same bound the slider offers and the native `finish_audio` clamps to. Two
		// different ranges for one value is how a project ends up exporting a gain the
		// UI cannot display.
		audioGainDb: Math.min(
			AUDIO_GAIN_DB_LIMIT,
			Math.max(-AUDIO_GAIN_DB_LIMIT, num(legacy?.audioGainDb, 0)),
		),
		cursor,
		cursorShow: bool(legacy?.cursorShow, DEFAULT_EDITOR_SETTINGS.cursorShow),
		cursorTheme: str(legacy?.cursorTheme, DEFAULT_EDITOR_SETTINGS.cursorTheme),
		autoFocusAll: bool(legacy?.autoFocusAll, DEFAULT_EDITOR_SETTINGS.autoFocusAll),
	};
}
export interface EditorSettingsPatch {
	wallpaper?: string;
	aspectRatio?: AspectRatio;
	shadowIntensity?: number;
	showBlur?: boolean;
	motionBlurAmount?: number;
	borderRadius?: number;
	padding?: number;
	cropRegion?: CropRegion;
	webcamLayoutPreset?: WebcamLayoutPreset;
	webcamMaskShape?: WebcamMaskShape;
	webcamMirrored?: boolean;
	webcamReactiveZoom?: boolean;
	webcamSizePreset?: WebcamSizePreset;
	webcamPosition?: WebcamPosition | null;
	webcamCropRegion?: CropRegion;
	webcamCropPan?: CropPan;
	audioGainDb?: number;
	cursor?: Partial<CursorVisualSettings> & { theme?: string; show?: boolean };
	autoFocusAll?: boolean;
}

function nextLegacy(current: LegacyShape | null, patch: EditorSettingsPatch): LegacyShape {
	const base: LegacyShape = current ?? {};
	// Spread, but only over keys the patch actually set — a plain {...base,
	// ...patch} would write undefined over a value the caller left alone.
	// `cursor` is handled separately below: its keys are renamed (size ->
	// cursorSize), so it is not a straight passthrough.
	// The Pick keeps what the 16 `if`s used to check: a patch key with no
	// LegacyShape counterpart fails to compile instead of leaking into the
	// persisted blob.
	const { cursor: _cursor, ...rest } = patch;
	const defined = Object.fromEntries(
		Object.entries(rest).filter(([, v]) => v !== undefined),
	) as Partial<Pick<LegacyShape, keyof Omit<EditorSettingsPatch, "cursor">>>;
	const next: LegacyShape = { ...base, ...defined };
	if (patch.cursor) {
		const c = patch.cursor;
		if (c.size !== undefined) next.cursorSize = c.size;
		if (c.smoothing !== undefined) next.cursorSmoothing = c.smoothing;
		if (c.motionBlur !== undefined) next.cursorMotionBlur = c.motionBlur;
		if (c.clickBounce !== undefined) next.cursorClickBounce = c.clickBounce;
		if (c.clipToBounds !== undefined) next.cursorClipToBounds = c.clipToBounds;
		if (c.theme !== undefined) next.cursorTheme = c.theme;
		if (c.show !== undefined) next.cursorShow = c.show;
	}
	return next;
}

export function patchEditorSettings(doc: AxcutDocument, patch: EditorSettingsPatch): AxcutDocument {
	const current = isShape(doc.legacyEditor) ? (doc.legacyEditor as LegacyShape) : null;
	return {
		...doc,
		legacyEditor: nextLegacy(current, patch) as Record<string, unknown>,
	};
}

// Normalise a webcam position from legacy storage. Anything outside 0-1 is
// clamped so a malformed `legacyEditor` doesn't seed the drag with bad coords.
function normaliseWebcamPosition(value: unknown): WebcamPosition | null {
	if (!value || typeof value !== "object") return DEFAULT_WEBCAM_POSITION;
	const candidate = value as Record<string, unknown>;
	const cxRaw = candidate.cx;
	const cyRaw = candidate.cy;
	if (typeof cxRaw !== "number" || typeof cyRaw !== "number") return DEFAULT_WEBCAM_POSITION;
	return {
		cx: Math.min(1, Math.max(0, cxRaw)),
		cy: Math.min(1, Math.max(0, cyRaw)),
	};
}

const MIN_CROP_SIZE = 0.01;

/**
 * Recovers the pan of a crop rect authored before the pan was stored.
 *
 * `x / (1 - width)` is the expression the pane used to derive the slider's value from the
 * rect on every render, and it has to stay that expression: every project on disk today has
 * a rect and no pan, so anything else here would silently reframe them on first open. A
 * full-frame crop has no room to sit in, so it reports centred — the one case where the
 * answer is arbitrary, and the one case where nothing depends on it.
 */
function panOfCropRegion(crop: CropRegion): CropPan {
	// Guarded at 1 and not at some epsilon below it: the zoom slider is integer percent, so
	// the smallest window short of full frame is 100/101 and leaves ~0.0099 of room — a
	// perfectly ordinary divisor that a wider guard would throw away as if it were centred.
	// `normaliseCropRegion` keeps `x + width <= 1`, so the quotient is in range by
	// construction; the clamp is for a hand-edited document that got there another way.
	const axis = (offset: number, size: number) =>
		size >= 1 ? 0.5 : Math.min(1, Math.max(0, offset / (1 - size)));
	return { x: axis(crop.x, crop.width), y: axis(crop.y, crop.height) };
}

function normaliseCropPan(value: unknown, crop: CropRegion): CropPan {
	if (!value || typeof value !== "object") return panOfCropRegion(crop);
	const candidate = value as Record<string, unknown>;
	const fallback = panOfCropRegion(crop);
	return {
		x: isNumber(candidate.x) ? Math.min(1, Math.max(0, candidate.x)) : fallback.x,
		y: isNumber(candidate.y) ? Math.min(1, Math.max(0, candidate.y)) : fallback.y,
	};
}

function normaliseCropRegion(value: unknown): CropRegion {
	if (!value || typeof value !== "object") return DEFAULT_CROP_REGION;
	const candidate = value as Record<string, unknown>;
	const x = isNumber(candidate.x) ? Math.min(1 - MIN_CROP_SIZE, Math.max(0, candidate.x)) : 0;
	const y = isNumber(candidate.y) ? Math.min(1 - MIN_CROP_SIZE, Math.max(0, candidate.y)) : 0;
	const width = isNumber(candidate.width)
		? Math.min(1 - x, Math.max(MIN_CROP_SIZE, candidate.width))
		: 1 - x;
	const height = isNumber(candidate.height)
		? Math.min(1 - y, Math.max(MIN_CROP_SIZE, candidate.height))
		: 1 - y;
	return { x, y, width, height };
}
