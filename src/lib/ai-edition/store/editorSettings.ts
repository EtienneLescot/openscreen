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

export interface EditorSettingsSnapshot {
	wallpaper: string;
	aspectRatio: AspectRatio;
	shadowIntensity: number;
	showBlur: boolean;
	showTrimWaveform: boolean;
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
	cursor: CursorVisualSettings;
	cursorShow: boolean;
	cursorTheme: string;
	autoFocusAll: boolean;
}

export const DEFAULT_EDITOR_SETTINGS: EditorSettingsSnapshot = {
	wallpaper: DEFAULT_WALLPAPER,
	aspectRatio: "16:9",
	shadowIntensity: 0,
	showBlur: false,
	showTrimWaveform: true,
	motionBlurAmount: 0,
	borderRadius: 0,
	padding: 50,
	cropRegion: DEFAULT_CROP_REGION,
	webcamLayoutPreset: DEFAULT_WEBCAM_LAYOUT_PRESET,
	webcamMaskShape: DEFAULT_WEBCAM_MASK_SHAPE,
	webcamMirrored: DEFAULT_WEBCAM_MIRRORED,
	webcamReactiveZoom: DEFAULT_WEBCAM_REACTIVE_ZOOM,
	webcamSizePreset: DEFAULT_WEBCAM_SIZE_PRESET,
	webcamPosition: DEFAULT_WEBCAM_POSITION,
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
	showTrimWaveform?: boolean;
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
	return {
		wallpaper: str(legacy?.wallpaper, DEFAULT_EDITOR_SETTINGS.wallpaper),
		aspectRatio: legacy?.aspectRatio ?? DEFAULT_EDITOR_SETTINGS.aspectRatio,
		shadowIntensity: num(legacy?.shadowIntensity, DEFAULT_EDITOR_SETTINGS.shadowIntensity),
		showBlur: bool(legacy?.showBlur, DEFAULT_EDITOR_SETTINGS.showBlur),
		showTrimWaveform: bool(legacy?.showTrimWaveform, DEFAULT_EDITOR_SETTINGS.showTrimWaveform),
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
	showTrimWaveform?: boolean;
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
	cursor?: Partial<CursorVisualSettings> & { theme?: string; show?: boolean };
	autoFocusAll?: boolean;
}

function nextLegacy(current: LegacyShape | null, patch: EditorSettingsPatch): LegacyShape {
	const base: LegacyShape = current ?? {};
	const next: LegacyShape = { ...base };
	if (patch.wallpaper !== undefined) next.wallpaper = patch.wallpaper;
	if (patch.aspectRatio !== undefined) next.aspectRatio = patch.aspectRatio;
	if (patch.shadowIntensity !== undefined) next.shadowIntensity = patch.shadowIntensity;
	if (patch.showBlur !== undefined) next.showBlur = patch.showBlur;
	if (patch.showTrimWaveform !== undefined) next.showTrimWaveform = patch.showTrimWaveform;
	if (patch.motionBlurAmount !== undefined) next.motionBlurAmount = patch.motionBlurAmount;
	if (patch.borderRadius !== undefined) next.borderRadius = patch.borderRadius;
	if (patch.padding !== undefined) next.padding = patch.padding;
	if (patch.cropRegion !== undefined) next.cropRegion = patch.cropRegion;
	if (patch.webcamLayoutPreset !== undefined) next.webcamLayoutPreset = patch.webcamLayoutPreset;
	if (patch.webcamMaskShape !== undefined) next.webcamMaskShape = patch.webcamMaskShape;
	if (patch.webcamMirrored !== undefined) next.webcamMirrored = patch.webcamMirrored;
	if (patch.webcamReactiveZoom !== undefined) next.webcamReactiveZoom = patch.webcamReactiveZoom;
	if (patch.webcamSizePreset !== undefined) next.webcamSizePreset = patch.webcamSizePreset;
	if (patch.webcamPosition !== undefined) next.webcamPosition = patch.webcamPosition;
	if (patch.autoFocusAll !== undefined) next.autoFocusAll = patch.autoFocusAll;
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
