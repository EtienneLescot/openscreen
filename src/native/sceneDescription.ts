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

import type { CameraFullscreenRegion, SpeedRegion } from "@/components/video-editor/types";
import { DEFAULT_CROP_REGION } from "@/components/video-editor/types";
import { createId } from "@/lib/ai-edition/document/ids";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { getEditorSettings } from "@/lib/ai-edition/store/editorSettings";
import { resolveClipSourceEndSec } from "@/lib/ai-edition/timeline/clipDuration";
import { projectRegionsToSourceTime } from "@/lib/ai-edition/timeline/region-ventilation";
import { computeCompositeLayout, webcamSizeToFraction } from "@/lib/compositeLayout";
import type { AspectRatio } from "@/utils/aspectRatioUtils";
import { getAspectRatioValue, getNativeAspectRatioValue } from "@/utils/aspectRatioUtils";
import type { CompositorClipInput } from "./contracts";

/** Background behind the screen. Parsed from `settings.wallpaper`. */
export type SceneBackground =
	| { kind: "color"; color: string } // "#rrggbb"
	| { kind: "gradient"; angleDeg: number; stops: string[] } // linear-gradient(deg, c1, c2, …)
	| { kind: "image"; path: string }; // "/wallpapers/…" or a data: URL

/** A timeline zoom region (from `document.zoomRanges`). Times in seconds. */
export interface SceneZoomRegion {
	/** Stable id — native uses it to pair adjacent regions for connected zoom-pan. */
	id: string;
	startSec: number;
	endSec: number;
	/** Target scale (>1 zooms in). Derived from `depth` (or `customScale` when present). */
	scale: number;
	/** Focus point, 0..1 of the frame. */
	focusX: number;
	focusY: number;
	/** "auto" follows cursor telemetry instead of the fixed focus point. */
	focusMode: "manual" | "auto" | null;
	/** Optional rotation preset for the zoom. */
	rotation: "iso" | "left" | "right" | null;
	/** Index of the clip (within `SceneDescription.clips`) whose source time this region's
	 *  `startSec`/`endSec` are expressed in — disambiguates clips whose source windows
	 *  numerically overlap (same or different asset). Unset only for a region that
	 *  `projectRegionsToSourceTime` couldn't place on any clip. */
	clipIndex?: number;
}

/** A "Full Camera" timeline region (from `legacyEditor.cameraFullscreenRegions`). Times in seconds. */
export interface SceneCameraFullscreenRegion {
	startSec: number;
	endSec: number;
	/** See `SceneZoomRegion.clipIndex`. */
	clipIndex?: number;
}

/** A speed region projected onto each clip's source time. The native compositor matches
 *  these against each decoded frame's SOURCE time, the same way zoom regions do — that's
 *  why the spans live in seconds and the underlying projection is `projectRegionsToSourceTime`.
 *  A region straddling a clip boundary splits into one entry per covered clip; both fragments
 *  carry the SAME `speed` value (the projection function only rewrites `startMs`/`endMs`/`id`,
 *  every other field passes through verbatim). */
export interface SceneSpeedRegion {
	startSec: number;
	endSec: number;
	/** Playback rate multiplier (1 = unchanged). */
	speed: number;
	/** See `SceneZoomRegion.clipIndex`. */
	clipIndex?: number;
}

/** Normalized rect in 0..1 of the output frame (x, y top-left; width, height). */
export interface SceneRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Webcam layout, from the editor settings. */
export interface SceneLayout {
	preset: "picture-in-picture" | "dual-frame" | "vertical-stack" | "no-webcam";
	/**
	 * Webcam size as a fraction (0..1) of the canvas reference dimension, derived from
	 * `webcamSizeToFraction(settings.webcamSizePreset)`. Matches the web's canonical
	 * composite-layout helper (0.10 = small, 0.25 ≈ default, 0.50 = max). The native
	 * compositor must consume this directly as a fraction of the reference dimension —
	 * an earlier revision emitted `settings.webcamSizePreset / 16.7` (a multiplier
	 * where ~1 ≈ default PiP size); that unit was incorrect vs. the web pipeline and has
	 * been replaced here. If you are touching the Rust consumer of this field, treat the
	 * incoming value as a 0..1 fraction of the canvas reference dimension, NOT as a
	 * size-multiplier.
	 */
	webcamSize: number;
	webcamShape: "rectangle" | "circle" | "square" | "rounded";
	webcamMirror: boolean;
	/** Normalized position (0..1) for the webcam centre, or null to use the preset default. */
	webcamPosition: { cx: number; cy: number } | null;
	/** Webcam shrinks while a zoom region is active. */
	webcamReactiveZoom: boolean;
	/**
	 * Webcam rect resolved by the app (= `computeCompositeLayout(...).webcamRect`, pixels
	 * → fractions of the output frame, parity EXACTE entre preview et natif). When set, the
	 * native compositor consumes it directly for the base webcam placement instead of its
	 * own hardcoded PiP math; it still applies `webcamSize` (slider) + reactive-zoom scaling
	 * + Full Camera lerp on top. Absent (older payloads / passthrough) → the native side
	 * falls back to its legacy `preset_placements` for the affected preset.
	 */
	webcamRect?: SceneRect | null;
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
	/**
	 * "Full Camera" regions projected onto each clip's source time (one entry per
	 * source-time span after `projectRegionsToSourceTime`). Empty when none set.
	 */
	cameraFullscreenRegions: SceneCameraFullscreenRegion[];
	/**
	 * Speed regions projected onto each clip's source time (one entry per
	 * source-time span after `projectRegionsToSourceTime`). Empty when none set.
	 *
	 * ponytail: speed regions today live at `document.legacyEditor.speedRegions`
	 * — the new `timeline.speedRanges` schema field is `z.array(rangeSchema)` and
	 * `rangeSchema` is `{startSec, endSec, reason}`, which does NOT carry a `speed`
	 * value (see migrate.ts comment "speedRegions stay on the legacy editor envelope
	 * — axcut's rangeSchema doesn't carry a speed value, and Phase 1 timeline rewrite
	 * is when speed becomes a first-class timeline concept"). We read from
	 * `legacyEditor.speedRegions` (where the `speed` multiplier actually lives) so
	 * the native compositor gets a populated `speed`, matching the legacy web
	 * exporter's read site. When the schema rewrite lands, swap the source to
	 * `document.timeline.speedRanges` and keep the same projection call.
	 */
	speedRegions: SceneSpeedRegion[];
	cursor: SceneCursor;
	/**
	 * Per-clip screen crop (fractions of the frame), or null for the identity
	 * (full-frame) crop. One entry per clip in the same order as `clips`, so a
	 * clip that owns its own cropRegion is rendered with that crop and a clip
	 * without one stays at the full frame. Replaces the old single global
	 * `crop` field, which lost per-clip crops on multi-clip documents.
	 */
	cropByClip: Array<{ x: number; y: number; width: number; height: number } | null>;
	/** Output frame. `fps` null = use the first clip's source fps. */
	output: { width: number; height: number; fps: number | null };
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
function referenceAssetDims(document: AxcutDocument): { width: number; height: number } {
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

/** The output frame's dimensions, honoring the timeline's chosen aspect ratio.
 *
 * BUG corrigé : cette fonction ne retournait QUE les dimensions brutes du plus gros asset
 * source (typiquement 16:9), sans jamais tenir compte du ratio réellement choisi par
 * l'utilisateur. `output.width`/`height` alimente le calcul "fit" côté natif
 * (`compose_frame`, compositor.rs) qui compare `output` à la résolution interne 16:9 pour
 * savoir de combien corriger l'écran/la webcam avant l'étirement final — avec la valeur
 * précédente (toujours ~16:9), cette correction était systématiquement un no-op, quel que
 * soit le ratio affiché dans l'UI (9:16, 1:1…), d'où la déformation qui persistait.
 *
 * PREMIÈRE tentative fautive : lire `document.legacyEditor.aspectRatio` (comme
 * `EXPORT_ASPECT` dans ExportDialog.tsx) — sauf que RIEN n'écrit jamais ce champ. Le vrai
 * sélecteur UI (le dropdown de ratio, V4Timeline.tsx) appelle `setSettings({aspectRatio})`,
 * qui persiste dans le store `editorSettings` (`settings.aspectRatio`, déjà résolu par
 * `getEditorSettings(document)` dans `buildSceneDescription` — donc ExportDialog.tsx lit
 * probablement aussi la mauvaise source, latent bug distinct à vérifier séparément).
 *
 * Convention alignée sur `calculateSourceDimensions` (mp4ExportSettings.ts) : le plus grand
 * côté de l'asset de référence reste la base, l'autre côté est dérivé du ratio choisi.
 */
function pickOutputDims(
	document: AxcutDocument,
	aspectRatio: AspectRatio,
): { width: number; height: number } {
	const reference = referenceAssetDims(document);
	const ratio =
		aspectRatio === "native"
			? getNativeAspectRatioValue(reference.width, reference.height)
			: getAspectRatioValue(aspectRatio);
	const longSide = Math.max(reference.width, reference.height);
	if (ratio >= 1) {
		return { width: longSide, height: Math.round(longSide / ratio) };
	}
	return { width: Math.round(longSide * ratio), height: longSide };
}

/** Serialize a document into a {@link SceneDescription}. Pure — no per-frame math. */
export function buildSceneDescription(
	document: AxcutDocument,
	webcamSourceSize: { width: number; height: number } | null = null,
): SceneDescription {
	const settings = getEditorSettings(document);

	// Sort+filter the clips once, in the order they will appear in the scene's
	// `clips[]` stream, so the per-clip `cropByClip[]` schedule stays aligned
	// 1:1 with `clips[]` by index. Mirror of `buildNativeClipList` in
	// src/components/ai-edition/ExportDialog.tsx — keep these two derivation
	// paths in lock-step so the native multiclip export and the in-process
	// preview composer see the same clip stream.
	const assetById = new Map(document.assets.map((a) => [a.id, a]));
	const visibleClips = [...document.timeline.clips]
		.sort((a, b) => a.timelineStartSec - b.timelineStartSec)
		.filter((clip) => assetById.get(clip.assetId)?.originalPath);
	const clips: CompositorClipInput[] = visibleClips.flatMap((clip) => {
		const asset = assetById.get(clip.assetId);
		if (!asset?.originalPath) return [];
		const cam = asset.cameraTrack;
		// ponytail: screen recordings from this app always carry a decodable audio
		// track (confirmed via ffprobe on real recordings); webcam files never do
		// and clips only ever reference their SCREEN path for the main video. The
		// `asset.audio` schema slot exists but is never populated by the probe
		// pipeline today, so we can't rely on it as an "is there a track?" signal —
		// matching the legacy web exporter (which just tries-and-catches in
		// `decodeSegmentAudioPcm`), we default `hasAudio: true` for every clip whose
		// asset has an `originalPath`. The visibleClips filter above already
		// guarantees that precondition by the time we reach this branch. If a
		// per-asset audio-probe flag is added later, swap to `Boolean(asset.audio)`.
		return [
			{
				screenPath: asset.originalPath,
				webcamPath: cam?.sourcePath ?? asset.originalPath,
				sourceStartSec: clip.sourceStartSec,
				sourceEndSec: resolveClipSourceEndSec(clip, asset),
				webcamOffsetSec: cam ? (cam.startMs + cam.offsetMs) / 1000 : 0,
				hasAudio: true,
			},
		];
	});
	const cropByClip = visibleClips.map(
		(clip): { x: number; y: number; width: number; height: number } | null => {
			const cropRegion = clip.cropRegion;
			if (!cropRegion) return null;
			if (
				cropRegion.x === DEFAULT_CROP_REGION.x &&
				cropRegion.y === DEFAULT_CROP_REGION.y &&
				cropRegion.width === DEFAULT_CROP_REGION.width &&
				cropRegion.height === DEFAULT_CROP_REGION.height
			) {
				return null;
			}
			return {
				x: cropRegion.x,
				y: cropRegion.y,
				width: cropRegion.width,
				height: cropRegion.height,
			};
		},
	);

	// Zoom + Full Camera regions are authored in virtual (timeline) ms in the
	// document, but the compositor matches them against each frame's SOURCE
	// time the same way the web export's frame loop does. Project them onto the
	// covered clips' source ranges (splitting any region that straddles a clip
	// boundary) so the native side gets the same shape the export pipeline
	// already proves correct.
	//
	// BUG corrigé : ces trois projections utilisaient `document.timeline.clips` BRUT
	// (ordre non trié, non filtré) au lieu de `visibleClips` (trié par timelineStartSec
	// + filtré, = l'ordre EXACT de `clips[]` envoyé au natif). Le `clipIndex` projeté sur
	// chaque région ne correspondait donc jamais à l'index réel dans `Scene.clips`, ET
	// `clipIndex` n'était de toute façon jamais émis avant ce fix (voir `region-ventilation.ts`)
	// — le natif retombait alors sur un simple recouvrement temporel (`belongs` dans
	// `for_clip_window`, compositor.rs), qui laissait fuir un zoom d'un clip vers un autre
	// dès que leurs fenêtres source se chevauchaient numériquement (typiquement deux clips
	// qui démarrent tous les deux près du temps source 0 de leur propre fichier).
	const projectedZoomRegions = projectRegionsToSourceTime(
		document.zoomRanges ?? [],
		visibleClips,
		() => createId("zoom"),
	);
	const projectedCameraFullscreenRegions = projectRegionsToSourceTime(
		((document.legacyEditor as Record<string, unknown> | null)?.cameraFullscreenRegions as
			| CameraFullscreenRegion[]
			| undefined) ?? [],
		visibleClips,
		() => createId("camfull"),
	);
	// Speed regions carry an extra `speed` field the standard `rangeSchema` does not, so we
	// can't read from `document.timeline.speedRanges` today (see SceneDescription.speedRegions
	// comment). The legacy web exporter reads from `legacyEditor.speedRegions`; we mirror it.
	// `projectRegionsToSourceTime` accepts any `T extends { id; startMs; endMs }` and copies
	// every other field verbatim via `{...region}` — so the `speed` field passes through,
	// and the splitting-across-clips semantics match zoomRegions / cameraFullscreenRegions.
	const projectedSpeedRegions = projectRegionsToSourceTime(
		((document.legacyEditor as Record<string, unknown> | null)?.speedRegions as
			| SpeedRegion[]
			| undefined) ?? [],
		visibleClips,
		() => createId("speed"),
	);

	// Webcam rect, single source of truth between preview & native :
	// on résout le rect AVEC LA MÊME maths que `PreviewCanvas.computeCompositeLayout` et on
	// l'envoie au natif dans `layout.webcamRect` (fractions du cadre de sortie). Le natif le
	// consomme tel quel (voir `compositor.rs::preset_placements` bypass). La résolution ici se
	// fait sur la résolution de sortie (= taille du canvas rendu) avec les unités sources du
	// premier asset visible — la même convention que `pickOutputDims` + SCREEN_SOURCE_SIZE /
	// WEBCAM_SOURCE_SIZE dans PreviewCanvas — ce qui garde preview/export/natif alignés.
	const outputDims = pickOutputDims(document, settings.aspectRatio);
	// ponytail: when the active camera has been probed (real webcam dims cached by
	// WebcamOverlay's loadedmetadata handler), use them so the box matches the actual
	// camera aspect. Without this the box defaults to a hardcoded 4:3 (960x720) and the
	// Rust `fit_cam_aspect` closure shrinks the real content inside the wrong-aspect box,
	// leaving visible empty margin inside the PiP container (typical case: a 16:9 webcam
	// shipped to a 4:3 box). The probed size is keyed by sourcePath and survives across
	// re-mounts of the same camera — `webcamSourceSize` is the dimension snapshot the
	// caller (NativeCompositorOverlay) currently knows about.
	const computedLayout = computeCompositeLayout({
		canvasSize: outputDims,
		screenSize: { width: 1920, height: 1080 },
		webcamSize:
			settings.webcamLayoutPreset === "no-webcam"
				? null
				: (webcamSourceSize ?? { width: 960, height: 720 }),
		layoutPreset: settings.webcamLayoutPreset,
		webcamSizePreset: settings.webcamSizePreset,
		webcamPosition:
			settings.webcamLayoutPreset === "picture-in-picture" ? settings.webcamPosition : null,
		webcamMaskShape: settings.webcamMaskShape,
	});
	const webcamRect = computedLayout?.webcamRect
		? {
				x: computedLayout.webcamRect.x / outputDims.width,
				y: computedLayout.webcamRect.y / outputDims.height,
				width: computedLayout.webcamRect.width / outputDims.width,
				height: computedLayout.webcamRect.height / outputDims.height,
			}
		: null;

	return {
		clips,
		layout: {
			preset: settings.webcamLayoutPreset,
			// web-consistent 0..1 fraction of the canvas reference dimension
			// (see `SceneLayout.webcamSize` for the consumer-facing semantics).
			webcamSize: webcamSizeToFraction(settings.webcamSizePreset),
			webcamShape: settings.webcamMaskShape,
			webcamMirror: settings.webcamMirrored,
			webcamPosition: settings.webcamPosition,
			webcamReactiveZoom: settings.webcamReactiveZoom,
			webcamRect,
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
		zoomRegions: projectedZoomRegions.map((region) => ({
			id: region.id,
			startSec: region.startMs / 1000,
			endSec: region.endMs / 1000,
			scale: region.customScale ?? region.depth / 2 + 0.5,
			focusX: region.focus.cx,
			focusY: region.focus.cy,
			focusMode: region.focusMode ?? null,
			rotation: region.rotationPreset ?? null,
			clipIndex: region.clipIndex,
		})),
		cameraFullscreenRegions: projectedCameraFullscreenRegions.map((region) => ({
			startSec: region.startMs / 1000,
			endSec: region.endMs / 1000,
			clipIndex: region.clipIndex,
		})),
		speedRegions: projectedSpeedRegions.map((region) => ({
			startSec: region.startMs / 1000,
			endSec: region.endMs / 1000,
			speed: region.speed,
			clipIndex: region.clipIndex,
		})),
		cropByClip,
		output: { ...pickOutputDims(document, settings.aspectRatio), fps: null },
	};
}
