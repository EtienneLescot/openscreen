/**
 * Scene contract — the flat description the app hands the native D3D compositor so it can
 * compute the composed frame itself (preview AND export) with **no POC-fixture logic**.
 *
 * Division of labour:
 *  - App (TS, this file): *serialize* the document + editor settings into this flat shape.
 *    Pure data mapping, no per-frame math.
 *  - Native (Rust, separate): owns the per-frame math (layout geometry, zoom easing, effect
 *    application) — it reads this description + the current time and composes.
 *
 * This replaces the hardcoded fixture `timeline()` (A↔B layout animation + 6s zoom schedule)
 * that used to drive the compositor.
 *
 * NOTE (worker): implement `buildSceneDescription` below. Everything else here is the frozen
 * contract — do not change the exported types.
 */

import { DEFAULT_CROP_REGION } from "@/components/video-editor/types";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { getEditorSettings } from "@/lib/ai-edition/store/editorSettings";
import type { CompositorClipInput } from "./contracts";

/** Background behind the screen. Parsed from `settings.wallpaper`. */
export type SceneBackground =
	| { kind: "color"; color: string } // "#rrggbb"
	| { kind: "gradient"; angleDeg: number; stops: string[] } // linear-gradient(deg, c1, c2, …)
	| { kind: "image"; path: string }; // "/wallpapers/…" or a data: URL

/** A timeline zoom region (from `document.zoomRanges`). Times in seconds. */
export interface SceneZoomRegion {
	startSec: number;
	endSec: number;
	/** Target scale (>1 zooms in). Derived from `depth` (or `customScale` when present). */
	scale: number;
	/** Focus point, 0..1 of the frame. */
	focusX: number;
	focusY: number;
	/** Optional rotation preset for the zoom. */
	rotation: "iso" | "left" | "right" | null;
}

/** Webcam layout, from the editor settings. */
export interface SceneLayout {
	preset: "picture-in-picture" | "dual-frame" | "vertical-stack" | "no-webcam";
	/** Native size scale (1 = the compositor's default PiP webcam). */
	webcamSize: number;
	webcamShape: "rectangle" | "circle" | "square" | "rounded";
	webcamMirror: boolean;
	/** Normalized position (0..1) for the webcam centre, or null to use the preset default. */
	webcamPosition: { cx: number; cy: number } | null;
	/** Webcam shrinks while a zoom region is active. */
	webcamReactiveZoom: boolean;
}

/** Frame-styling effects, from the editor settings. */
export interface SceneEffects {
	/** 0..1 extra inset of the screen (padding). */
	padding: number;
	/** Blur the background (screen used as bg). */
	blur: boolean;
	/** 0..1 drop-shadow strength. */
	shadow: number;
	/** Corner radius in output px. */
	roundnessPx: number;
	/** 0..1 motion blur. */
	motionBlur: number;
}

/** Cursor rendering, from the editor settings. */
export interface SceneCursor {
	show: boolean;
	/** Direct scale (1 = default). */
	size: number;
	smoothing: number;
	/** 0..1. */
	motionBlur: number;
	clickBounce: number;
	clipToBounds: boolean;
	/** Cursor theme id (sprite set). */
	theme: string;
}

/** Everything native needs to compose the scene, serialized from one document. */
export interface SceneDescription {
	/** Ordered clips (multiclip) with source trims — same shape the export already uses. */
	clips: CompositorClipInput[];
	layout: SceneLayout;
	effects: SceneEffects;
	background: SceneBackground;
	zoomRegions: SceneZoomRegion[];
	cursor: SceneCursor;
	/** Screen source crop (fractions of the frame), or null for the full frame. */
	crop: { x: number; y: number; width: number; height: number } | null;
	/** Output frame. `fps` null = use the first clip's source fps. */
	output: { width: number; height: number; fps: number | null };
}

/** Mirror of `buildNativeClipList` in src/components/ai-edition/ExportDialog.tsx — keep these
 *  two derivation paths in lock-step so the native multiclip export and the in-process preview
 *  composer see the same clip stream. */
function buildNativeClipList(document: AxcutDocument) {
	const assetById = new Map(document.assets.map((a) => [a.id, a]));
	return [...document.timeline.clips]
		.sort((a, b) => a.timelineStartSec - b.timelineStartSec)
		.flatMap((clip) => {
			const asset = assetById.get(clip.assetId);
			if (!asset?.originalPath) return [];
			const cam = asset.cameraTrack;
			const sourceEndSec =
				clip.sourceEndSec ?? clip.sourceStartSec + (clip.timelineEndSec - clip.timelineStartSec);
			return [
				{
					screenPath: asset.originalPath,
					webcamPath: cam?.sourcePath ?? asset.originalPath,
					sourceStartSec: clip.sourceStartSec,
					sourceEndSec,
					webcamOffsetSec: cam ? (cam.startMs + cam.offsetMs) / 1000 : 0,
				},
			];
		});
}

/** Strip a trailing position percentage (or any whitespace tail) from a gradient stop token,
 *  returning the colour piece. The presets never nest parens so a whitespace split is fine. */
function firstTokenOf(stop: string): string {
	const trimmed = stop.trim();
	if (trimmed.length === 0) return trimmed;
	const spaceIdx = trimmed.indexOf(" ");
	return spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
}

/** Parse the settings wallpaper string into the discriminated SceneBackground union. */
function parseWallpaper(wallpaper: string) {
	if (wallpaper.startsWith("#")) {
		return { kind: "color", color: wallpaper } as const;
	}
	if (wallpaper.startsWith("linear-gradient(")) {
		// Strip the outer wrapper once — assume well-formed `linear-gradient(...)`.
		const openIdx = wallpaper.indexOf("(");
		const closeIdx = wallpaper.lastIndexOf(")");
		const inner = wallpaper.slice(openIdx + 1, closeIdx);
		// Presets never contain nested parens; a flat comma split is sufficient.
		const tokens = inner
			.split(",")
			.map((t) => t.trim())
			.filter((t) => t.length > 0);
		const angleMatch = /^-?\d+(\.\d+)?deg$/.exec(tokens[0] ?? "");
		const angleDeg = angleMatch ? parseFloat(tokens[0]) : 180;
		const stopsRaw = angleMatch ? tokens.slice(1) : tokens;
		const stops = stopsRaw.map(firstTokenOf).filter((s) => s.length > 0);
		return { kind: "gradient", angleDeg, stops } as const;
	}
	return { kind: "image", path: wallpaper } as const;
}

/** Largest asset pixel area among the timeline's used assets; falls back to any asset with
 *  dims, then 1920x1080. Mirrors `referenceSource` in ExportDialog.tsx. */
function pickOutputDims(document: AxcutDocument): { width: number; height: number } {
	const usedAssetIds = new Set(document.timeline.clips.map((c) => c.assetId));
	const consider = (w: number, h: number, best: { width: number; height: number } | null) => {
		if (w > 0 && h > 0 && (!best || w * h > best.width * best.height)) {
			return { width: w, height: h };
		}
		return best;
	};
	let best: { width: number; height: number } | null = null;
	for (const a of document.assets) {
		if (usedAssetIds.has(a.id)) {
			best = consider(a.video?.width ?? 0, a.video?.height ?? 0, best);
		}
	}
	if (!best) {
		for (const a of document.assets) {
			best = consider(a.video?.width ?? 0, a.video?.height ?? 0, best);
		}
	}
	return best ?? { width: 1920, height: 1080 };
}

/** Serialize a document into a {@link SceneDescription}. Pure — no per-frame math. */
export function buildSceneDescription(document: AxcutDocument): SceneDescription {
	const settings = getEditorSettings(document);

	const crop =
		settings.cropRegion.x === DEFAULT_CROP_REGION.x &&
		settings.cropRegion.y === DEFAULT_CROP_REGION.y &&
		settings.cropRegion.width === DEFAULT_CROP_REGION.width &&
		settings.cropRegion.height === DEFAULT_CROP_REGION.height
			? null
			: {
					x: settings.cropRegion.x,
					y: settings.cropRegion.y,
					width: settings.cropRegion.width,
					height: settings.cropRegion.height,
				};

	return {
		clips: buildNativeClipList(document),
		layout: {
			preset: settings.webcamLayoutPreset,
			webcamSize: settings.webcamSizePreset / 16.7,
			webcamShape: settings.webcamMaskShape,
			webcamMirror: settings.webcamMirrored,
			webcamPosition: settings.webcamPosition,
			webcamReactiveZoom: settings.webcamReactiveZoom,
		},
		effects: {
			padding: settings.padding / 100,
			blur: settings.showBlur,
			shadow: settings.shadowIntensity,
			roundnessPx: settings.borderRadius,
			motionBlur: settings.motionBlurAmount,
		},
		cursor: {
			show: settings.cursorShow,
			size: settings.cursor.size,
			smoothing: settings.cursor.smoothing,
			motionBlur: settings.cursor.motionBlur,
			clickBounce: settings.cursor.clickBounce,
			clipToBounds: settings.cursor.clipToBounds,
			theme: settings.cursorTheme,
		},
		background: parseWallpaper(settings.wallpaper),
		zoomRegions: (document.zoomRanges ?? []).map((region) => ({
			startSec: region.startMs / 1000,
			endSec: region.endMs / 1000,
			scale: region.customScale ?? region.depth / 2 + 0.5,
			focusX: region.focus.cx,
			focusY: region.focus.cy,
			rotation: region.rotationPreset ?? null,
		})),
		crop,
		output: { ...pickOutputDims(document), fps: null },
	};
}
