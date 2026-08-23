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
import { DEFAULT_CROP_REGION, getZoomScale } from "@/components/video-editor/types";
import { annotationFontSizeFraction } from "@/lib/ai-edition/annotationScale";
import {
	captionCuesToTextRegions,
	deriveCaptionCues,
	getCaptionSettings,
	getCaptionTranslations,
} from "@/lib/ai-edition/captions";
import { createId } from "@/lib/ai-edition/document/ids";
import { pickOutputDims } from "@/lib/ai-edition/document/outputFormat";
import { resolvePlaybackSegments } from "@/lib/ai-edition/document/timeline";
import type { AxcutClip, AxcutDocument } from "@/lib/ai-edition/schema";
import { getEditorSettings } from "@/lib/ai-edition/store/editorSettings";
import { assetCameraSource } from "@/lib/ai-edition/timeline/camera";
import { resolveClipSourceEndSec } from "@/lib/ai-edition/timeline/clipDuration";
import { projectRegionsToSource } from "@/lib/ai-edition/timeline/timelineMap";
import {
	computeCompositeLayout,
	type RenderRect,
	resolveWebcamLayoutPreset,
	resolveWebcamReactiveZoom,
	webcamSizeToFraction,
} from "@/lib/compositeLayout";
import { parseCssGradient, resolveLinearGradientAngle } from "@/lib/exporter/gradientParser";
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

/** A timeline annotation (`document.annotations`), projected onto each clip's source time the
 *  same way zoom and speed regions are.
 *
 *  Until now annotations never crossed this bridge at all: `AnnotationLayer` draws them as DOM
 *  siblings of the preview, so they showed up in the preview and were simply absent from every
 *  render. Sending them here is what lets the compositor draw them into the actual output.
 *
 *  Coordinate space, which the renderer must match exactly: `x`/`y`/`w`/`h` are fractions of the
 *  SCREEN layer's rect, not of the output frame — the web overlay is handed
 *  `layout.screenRect` as its container. And they are deliberately NOT affected by the zoom
 *  crop: the overlay is a sibling of the element carrying the zoom transform, so annotations
 *  hold still while the content zooms underneath them.
 *
 *  `space: "frame"` opts an entry out of that and measures it against the output frame instead.
 *  Only captions set it: an annotation is authored on top of the visible video, so it must track
 *  the screen rect, whereas a subtitle belongs to the frame the viewer sees and has to hold still
 *  when padding resizes the footage under it (issue #396). The key is omitted entirely for
 *  annotations, so their payload — and the older binaries that read it — are unchanged. */
export interface SceneAnnotation {
	id: string;
	startSec: number;
	endSec: number;
	/** See `SceneZoomRegion.clipIndex`. */
	clipIndex?: number;
	kind: "text" | "image" | "figure" | "blur";
	/** Which box `x`/`y`/`w`/`h` — and `text.fontSizeRel` — are fractions of. Absent means
	 *  `"screen"`, the historical behaviour and the only one annotations ever use. */
	space?: "frame";
	/** Rect as fractions of the box named by `space` (x, y top-left). */
	x: number;
	y: number;
	w: number;
	h: number;
	/** Paint order among annotations; the compositor draws ascending. */
	zIndex: number;
	/** Present for `kind: "text"`. Colours are CSS strings, parsed native-side like the
	 *  background colour is (`parse_hex`); `"transparent"` means no fill. */
	text?: {
		content: string;
		color: string;
		backgroundColor: string;
		/** Font size as a FRACTION of the height of the box named by `space`, like everything
		 *  else in this struct — multiply by that box's height in output pixels. See
		 *  `annotationScale.ts`: the preview applies the identical product against its own box,
		 *  so preview and render agree at any resolution. The denominator MUST follow `space`:
		 *  measuring the rect against the frame while sizing the text off the screen rect would
		 *  hold a caption still and still shrink its text with the padding slider. */
		fontSizeRel: number;
		fontFamily: string;
		fontWeight: "normal" | "bold";
		fontStyle: "normal" | "italic";
		textDecoration: "none" | "underline";
		textAlign: "left" | "center" | "right";
		/** Which edge of the drawn text block is pinned to the box. Omitted for
		 *  annotations, which keep the historical centring — so their payload does not
		 *  change shape at all. Captions send it because a centred block moves BOTH its
		 *  edges as it grows, which made a subtitle drift every time its text wrapped. */
		verticalAlign?: "top" | "center" | "bottom";
		animation: string | null;
	};
	/** Present for `kind: "image"` — the authored `imageContent` (path or data URI). */
	imagePath?: string;
	/** Present for `kind: "figure"`. */
	figure?: {
		direction:
			| "up"
			| "down"
			| "left"
			| "right"
			| "up-right"
			| "up-left"
			| "down-right"
			| "down-left";
		color: string;
		strokeWidth: number;
	};
	/** Present for `kind: "blur"`. `freehandPoints` are fractions of the screen layer, same
	 *  space as the rect. */
	blur?: {
		style: "blur" | "mosaic";
		shape: "rectangle" | "oval" | "freehand";
		color: "white" | "black";
		intensity: number;
		blockSize: number;
		freehandPoints?: Array<{ x: number; y: number }>;
	};
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
	/**
	 * The mask shape the layout actually RESOLVED to, not the raw `webcamMaskShape`
	 * setting. Only picture-in-picture honours the setting; the block layouts cut a
	 * rectangle out of the welded block whatever the user last picked in the shape
	 * picker (which the UI hides there). Shipping the raw setting is what let a circle
	 * chosen in PiP follow the user into "Side by side" and round the camera off into a
	 * disc — see `computeCompositeLayout`, which is the one place that decides.
	 */
	webcamShape: "rectangle" | "circle" | "square" | "rounded";
	webcamMirror: boolean;
	/** Normalized position (0..1) for the webcam centre, or null to use the preset default. */
	webcamPosition: { cx: number; cy: number } | null;
	/** Webcam shrinks while a zoom region is active. */
	webcamReactiveZoom: boolean;
	/** User-authored webcam framing, as fractions of the camera source. */
	webcamCrop: { x: number; y: number; width: number; height: number };
	/**
	 * Webcam rect resolved by the app (= `computeCompositeLayout(...).webcamRect`, pixels
	 * → fractions of the output frame, parity EXACTE entre preview et natif). When set, the
	 * native compositor consumes it directly for the base webcam placement instead of its
	 * own hardcoded PiP math; it still applies `webcamSize` (slider) + reactive-zoom scaling
	 * + Full Camera lerp on top. Absent (older payloads / passthrough) → the native side
	 * falls back to its legacy `preset_placements` for the affected preset.
	 */
	webcamRect?: SceneRect | null;
	/**
	 * Screen rect resolved by the app (= `computeCompositeLayout(...).screenRect`, same
	 * fractions-of-the-output-frame convention as `webcamRect`). Already padded and
	 * already at the crop's aspect ratio, so the native compositor must consume it as-is
	 * — no `padding_scale`, no aspect fit. Without it the native side kept its hardcoded
	 * `preset_placements` screen box while honouring the app's camera box, which is what
	 * pushed the side-by-side camera past the edge of the scene.
	 */
	screenRect?: SceneRect | null;
	/**
	 * Should the screen FILL its box, cropping the overflow (`object-fit: cover`), rather
	 * than fit inside it? True for the block layouts, whose screen box is an arbitrary-ratio
	 * slot. This is `computeCompositeLayout(...).screenCover`, which `frameRenderer` already
	 * honours on the web path; shipping it here is what lets the native compositor agree.
	 * Without it native stretched the source to fill the slot — most visible on a cropped
	 * clip, the crop pushing the source aspect further from the slot's.
	 */
	screenCover?: boolean;
	/**
	 * One resolved layout per visible clip, index-aligned with `SceneDescription.clips`
	 * and `cropByClip`. The scalar fields above are the FIRST clip's entry (fallback for
	 * older payloads and the value native uses before a clip is active).
	 *
	 * Per clip because the screen source's SHAPE is per clip — a clip is a screen
	 * recording plus an optional camera and audio, and nothing forces two clips to share
	 * a recording size or ratio. Cropping is one more way that shape varies: a 16:9
	 * recording cropped to 9:16 must lay out exactly like one recorded natively in 9:16.
	 * Distinct from the scene's aspect ratio, which is global.
	 *
	 * Resolving one layout for the whole scene was therefore already wrong for a document
	 * mixing recording resolutions; cropping only made it reachable in a single document.
	 */
	layoutByClip?: Array<ResolvedClipLayout | null>;
	/**
	 * Corner radius of the screen box, as a fraction of that box's own SHORT SIDE, when
	 * the preset imposes one (the block layouts frame screen and camera alike). Null →
	 * the native side falls back to the user's Roundness slider.
	 *
	 * A fraction, not pixels — see `roundnessFrac` for why the whole contract works this
	 * way. The denominator is the box rather than the frame on purpose: a corner radius
	 * belongs to the thing it rounds, so the rounding stays put when the box is resized.
	 */
	screenRadiusFrac?: number | null;
	/**
	 * Corner radius of the webcam box, as a fraction of ITS own short side — same rule as
	 * `screenRadiusFrac`, resolved by the same `computeCompositeLayout` call, so "the
	 * block frames screen and camera alike" can actually hold. It could not before: the
	 * screen took the app's radius while the camera kept a second, independent table in
	 * Rust (`min * 0.5 | 0.3 | 0.12`, unclamped, keyed off the raw mask shape), so the two
	 * halves of one welded block were rounded by two formulas that could not agree.
	 */
	webcamRadiusFrac?: number | null;
}

/**
 * The shape-dependent half of a layout, resolved for one clip. See `layoutByClip`.
 *
 * Radii are fractions of their own box's short side, exactly as the scalar
 * `screenRadiusFrac`/`webcamRadiusFrac` above — no length crosses this contract in
 * pixels, per-clip or not.
 */
export interface ResolvedClipLayout {
	screenRect: SceneRect;
	webcamRect: SceneRect | null;
	screenRadiusFrac: number | null;
	webcamRadiusFrac: number | null;
	webcamShape: "rectangle" | "circle" | "square" | "rounded";
	screenCover: boolean;
}

/** Frame-styling effects, from the editor settings. */
export interface SceneEffects {
	/** 0..1 extra inset of the screen (padding). */
	padding: number;
	/** Blur the background (screen used as bg). */
	blur: boolean;
	/** 0..1 drop-shadow strength. */
	shadow: number;
	/**
	 * Roundness slider, as a fraction of the output frame's SHORT SIDE.
	 *
	 * Every length crossing this contract is a fraction, never a pixel count, and that is
	 * load-bearing rather than stylistic: the native compositor rasterises the preview
	 * into a small contain-fitted frame and the export at full output size, so a pixel
	 * means two different things on the two sides of the boundary. Absolute values used to
	 * cross it and silently meant "render-target pixels" — which is why the preview drew
	 * the PiP circle as a shrunken blob while the export was correct, and why a 4K export
	 * got a proportionally weaker shadow than a 1080p one. A fraction has no unit to get
	 * wrong; the native side multiplies by whatever its reference measures right now.
	 *
	 * The slider itself stays in pixels for the user — the division happens here, once.
	 */
	roundnessFrac: number;
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
	 * Annotations projected onto each clip's source time, ascending by `zIndex` so the
	 * compositor can draw them in order without re-sorting. Empty when none set.
	 */
	annotations: SceneAnnotation[];
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
	 * Audio finishing, applied identically by the preview and by `finish_audio` (Rust).
	 *
	 * One field, and it takes some resisting to keep it that way. The preview plays the
	 * untouched SOURCE file, seeked; the export runs on the assembled timeline — trimmed,
	 * speed-adjusted, concatenated. A linear gain is the only operation that means the same
	 * thing on both. Anything with memory (a filter, a compressor) diverges across cuts;
	 * anything measured over the whole programme (a loudness normaliser) cannot be computed
	 * preview-side at all; and even a plain delay diverges, because the preview would apply
	 * it in source seconds while this applies it in timeline seconds — a 2x speed region
	 * halves it, and near a cut the export pulls audio across the junction while the preview
	 * only has the active asset. A sync offset shipped here and was removed for exactly that.
	 */
	audio: {
		gainDb: number;
	};
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

/** Parse the settings wallpaper string into the discriminated SceneBackground union. */
function parseWallpaper(wallpaper: string) {
	if (wallpaper.startsWith("#")) {
		return { kind: "color", color: wallpaper } as const;
	}
	if (wallpaper.startsWith("linear-gradient(")) {
		// parseCssGradient handles nested parens (rgba()/hsl() stops) and the
		// "to bottom right" keyword directions that a flat comma split drops.
		// It's anchored on a trailing ")", so it rejects strings this branch
		// accepts (a trailing space is enough) — stay a gradient when it does,
		// rather than falling through and handing the native side a CSS string
		// as an image path.
		const parsed = parseCssGradient(wallpaper);
		return {
			kind: "gradient",
			angleDeg: resolveLinearGradientAngle(parsed?.descriptor ?? null),
			stops: parsed?.stops.map((stop) => stop.color) ?? [],
		} as const;
	}
	return { kind: "image", path: wallpaper } as const;
}

/**
 * The ONE clip list every native-facing consumer must build from — trim-narrowed
 * (`resolvePlaybackSegments`, so word-level cuts from the transcript editor actually reach
 * native instead of only affecting the transcript panel's own strikethrough), sorted, and
 * filtered to clips whose asset has a resolvable path. Shared by `buildSceneDescription`
 * below, `ExportDialog.tsx`'s `buildNativeClipList` (native MP4 export), and
 * `NativeCompositorOverlay.tsx`'s `nativeClips` (live preview) — previously these three each
 * hand-rolled their own sort+filter, acknowledged as needing to be "kept in lock-step".
 */
export function resolveVisibleClips(document: AxcutDocument): AxcutClip[] {
	const assetById = new Map(document.assets.map((a) => [a.id, a]));
	return resolvePlaybackSegments(document.timeline.clips, document.timeline.trimRanges)
		.sort((a, b) => a.timelineStartSec - b.timelineStartSec)
		.filter((clip) => assetById.get(clip.assetId)?.originalPath);
}

/** Serialize a document into a {@link SceneDescription}. Pure — no per-frame math. */
export function buildSceneDescription(
	document: AxcutDocument,
	webcamSourceSize: { width: number; height: number } | null = null,
): SceneDescription {
	const settings = getEditorSettings(document);

	const assetById = new Map(document.assets.map((a) => [a.id, a]));
	const visibleClips = resolveVisibleClips(document);
	const clips: CompositorClipInput[] = visibleClips.flatMap((clip) => {
		const asset = assetById.get(clip.assetId);
		if (!asset?.originalPath) return [];
		const camera = assetCameraSource(asset);
		// ponytail: `asset.audio` exists in the schema but the probe pipeline never
		// populates it, so there is no per-asset "is there a track?" signal to read
		// yet. Every consumer downstream degrades on a stream-less file (audio.rs
		// returns Ok(None)), so this stays optimistic. NOT "recordings always carry
		// audio" — a capture made with no mic and no system audio has no audio
		// stream at all (issue #348). Swap to `Boolean(asset.audio)` the day the
		// probe fills it in.
		return [
			{
				screenPath: asset.originalPath,
				webcamPath: camera.path,
				sourceStartSec: clip.sourceStartSec,
				sourceEndSec: resolveClipSourceEndSec(clip, asset),
				webcamOffsetSec: camera.offsetSec,
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

	// Zoom + Full Camera + speed regions are authored in RAW virtual (timeline) ms
	// in the document — the ruler where trims still occupy their space — but the
	// compositor matches them against each frame's SOURCE time. `projectRegionsToSource`
	// bridges the two through `timelineMap`: it resolves each region's RAW coordinate
	// against every visible segment's OWN raw extent (via `document.timeline.clips`,
	// the un-compressed layout) and maps the overlap to that segment's source range,
	// tagging it with the segment's `clipIndex` in `visibleClips` (= the order of
	// `Scene.clips`). A region whose source range a trim splits across two kept
	// segments yields one entry per segment.
	//
	// BUG corrigé : ces projections utilisaient `visibleClips` (COMPRESSÉ, trims retirés)
	// à la fois pour le recouvrement ET la source, alors que les régions sont posées en
	// coordonnées RAW. Dès qu'un trim retirait Δs avant une région, la coordonnée RAW
	// dépassait la position compressée de Δ → la région se déclenchait Δ trop tôt (offset
	// visible en preview ET au rendu). On passe désormais le layout RAW pour le mapping
	// raw→source et on ne garde `visibleClips` que pour l'ordre/`clipIndex`.
	const projectedZoomRegions = projectRegionsToSource(
		document.zoomRanges ?? [],
		visibleClips,
		document.timeline.clips,
		() => createId("zoom"),
	);
	// Same raw→source projection as the zoom regions above, for the same reason: annotations are
	// authored in RAW document time and the compositor matches each frame's SOURCE time.
	//
	// Captions join the annotations here rather than getting a bridge of their own: they are text
	// with the same time base drawn through the same rasterizer, so the compositor already knows
	// how to draw them. Skipping this would have left them visible in the DOM
	// overlay and absent from the composited pixels — the exact preview/render gap the annotation
	// work above closed. They are derived on the fly and never stored (see lib/ai-edition/captions).
	//
	// What they do NOT share is the reference box: each caption region carries `space: "frame"`,
	// so the compositor measures it against the output frame while annotations stay on the screen
	// rect. Subtitles have to sit where the viewer's frame ends, not where the footage does, or
	// they slide inward the moment padding shrinks the screen rect (issue #396).
	//
	// The output aspect is what decides the caption column and the default inset (a
	// caption 5% off the bottom of a 16:9 export sits under the platform's own chrome
	// on a 9:16 one). It comes off `pickOutputDims`, hoisted above the webcam block that
	// used to own it so there is exactly ONE caller — preview and export cannot pick a
	// different column from each other.
	const outputDims = pickOutputDims(document, settings.aspectRatio);
	const captionAspect = outputDims.height > 0 ? outputDims.width / outputDims.height : 16 / 9;
	const captionSettings = getCaptionSettings(document, captionAspect);
	const captionRegions = captionCuesToTextRegions(
		deriveCaptionCues(document, captionSettings, getCaptionTranslations(document)),
		captionSettings,
		captionAspect,
	);
	const projectedAnnotations = projectRegionsToSource(
		[
			...(document.annotations ?? []),
			...(captionRegions as unknown as NonNullable<AxcutDocument["annotations"]>),
		],
		visibleClips,
		document.timeline.clips,
		() => createId("ann"),
	);
	const projectedCameraFullscreenRegions = projectRegionsToSource(
		((document.legacyEditor as Record<string, unknown> | null)?.cameraFullscreenRegions as
			| CameraFullscreenRegion[]
			| undefined) ?? [],
		visibleClips,
		document.timeline.clips,
		() => createId("camfull"),
	);
	// Speed regions carry an extra `speed` field the standard `rangeSchema` does not, so we
	// can't read from `document.timeline.speedRanges` today (see SceneDescription.speedRegions
	// comment). The legacy web exporter reads from `legacyEditor.speedRegions`; we mirror it.
	// `projectRegionsToSource` accepts any `T extends { id; startMs; endMs }` and copies
	// every other field verbatim via `{...region}` — so the `speed` field passes through,
	// and the splitting-across-clips semantics match zoomRegions / cameraFullscreenRegions.
	const projectedSpeedRegions = projectRegionsToSource(
		((document.legacyEditor as Record<string, unknown> | null)?.speedRegions as
			| SpeedRegion[]
			| undefined) ?? [],
		visibleClips,
		document.timeline.clips,
		() => createId("speed"),
	);

	// Webcam rect, single source of truth between preview & native :
	// on résout le rect AVEC LA MÊME maths que `PreviewCanvas.computeCompositeLayout` et on
	// l'envoie au natif dans `layout.webcamRect` (fractions du cadre de sortie). Le natif le
	// consomme tel quel (voir `compositor.rs::preset_placements` bypass). La résolution ici se
	// fait sur la résolution de sortie (= taille du canvas rendu) avec les unités sources du
	// premier asset visible — la même convention que `pickOutputDims` + SCREEN_SOURCE_SIZE /
	// WEBCAM_SOURCE_SIZE dans PreviewCanvas — ce qui garde preview/export/natif alignés.
	// (`outputDims` est résolu plus haut, avec le bloc sous-titres qui en dépend aussi.)
	// ponytail: when the active camera has been probed (real webcam dims cached by
	// WebcamOverlay's loadedmetadata handler), use them so the box matches the actual
	// camera aspect. Without this the box defaults to a hardcoded 4:3 (960x720) and the
	// Rust `fit_cam_aspect` closure shrinks the real content inside the wrong-aspect box,
	// leaving visible empty margin inside the PiP container (typical case: a 16:9 webcam
	// shipped to a 4:3 box). The probed size is keyed by sourcePath and survives across
	// re-mounts of the same camera — `webcamSourceSize` is the dimension snapshot the
	// caller (NativeCompositorOverlay) currently knows about.
	// The block layouts (side-by-side / top-bottom) inset the welded screen+camera
	// block by the padding, so the rect we ship must be resolved against the same
	// padded content area the preview uses — `compositor.rs` consumes an app-provided
	// `webcamRect` verbatim (it only scale_frame's the SCREEN by padding), so an
	// unpadded rect here would leave the camera behind while the screen moved.
	const paddingFit = 1 - (Math.min(100, Math.max(0, settings.padding)) / 100) * 0.4;
	/**
	 * The screen source SHAPE of a clip = its recording's own dimensions × its crop.
	 *
	 * Both halves vary per clip and always have: a clip is a screen recording + an
	 * optional camera + optional audio, and nothing forces two clips to have been
	 * recorded at the same size or ratio. Cropping is simply one more way that shape
	 * varies — a 16:9 recording cropped to 9:16 must lay out exactly like a clip
	 * recorded natively in 9:16. This is NOT the scene's aspect ratio, which is global
	 * (`outputDims`); it is per clip.
	 *
	 * So the layout has to be resolved per clip. Resolving it once for the whole scene
	 * was already wrong for a document mixing recording resolutions — the crop only
	 * made the existing defect visible, by letting one document hold two shapes.
	 */
	const screenSourceSizeOf = (clip: AxcutClip, index: number) => {
		const video = assetById.get(clip.assetId)?.video;
		const crop = cropByClip[index]; // index-aligned; null = identity crop
		return {
			width: Math.max(1, Math.round((video?.width || 1920) * (crop?.width ?? 1))),
			height: Math.max(1, Math.round((video?.height || 1080) * (crop?.height ?? 1))),
		};
	};
	/** Does THIS clip have a camera to lay out? Same expression as the `webcamPath` sent
	 *  with the clip above, so the layout and the decoder can never disagree about it.
	 *  Note this is NOT `hasAnyClipWithCamera` (which gates the Layout panel): that one
	 *  ignores `visible` on purpose, so the panel stays reachable to un-hide a camera. */
	const clipHasCamera = (clip: AxcutClip) =>
		assetCameraSource(assetById.get(clip.assetId)).path !== "";
	/**
	 * The layout preset is GLOBAL — one panel for the whole timeline — but the camera is
	 * per clip: a project mixes a screen+webcam recording with a plain import that has
	 * none. A clip with no camera must lay out as if the preset were "no-webcam".
	 *
	 * Skipping this is not merely a stray thumbnail: the block presets (`dual-frame`,
	 * `vertical-stack`) size the SCREEN off the block, so a camera-less clip kept the
	 * screen squeezed into its half with nothing beside it. `has_webcam` (native) only
	 * gates the camera's own draw — it cannot give the screen its frame back.
	 */
	/**
	 * The camera source SHAPE of a clip, resolved the same way and for the same reasons
	 * as `screenSourceSizeOf` above: per clip, because two clips need not have been
	 * recorded with the same camera.
	 *
	 * The order matters. `cameraTrack.width/height` comes FIRST because it is the only
	 * source every caller has: it is in the document, so the export dialog and the CLI
	 * runner read it exactly as the preview does. `webcamSourceSize` is second, as a
	 * fresher-than-disk override for the window before the backfill has written the
	 * dimensions — it is what a mounted <video> just reported, and only the preview can
	 * ever supply it. The hardcoded 4:3 is last and is now only reached for a document
	 * that predates the field, opened somewhere with no camera element mounted.
	 *
	 * That ordering is the fix: the box used to depend on WHO was asking rather than on
	 * what was recorded, so a 16:9 camera was framed 16:9 in the preview and 4:3 in the
	 * export. Everything below reads the same answer now.
	 */
	const webcamSourceSizeOf = (clip: AxcutClip) => {
		const camera = assetById.get(clip.assetId)?.cameraTrack;
		const source =
			camera?.width && camera?.height
				? { width: camera.width, height: camera.height }
				: (webcamSourceSize ?? { width: 960, height: 720 });
		return {
			width: Math.max(1, Math.round(source.width * settings.webcamCropRegion.width)),
			height: Math.max(1, Math.round(source.height * settings.webcamCropRegion.height)),
		};
	};
	const layoutForClip = (
		screenSize: { width: number; height: number },
		hasCamera: boolean,
		camSize: { width: number; height: number },
	) => {
		const preset = resolveWebcamLayoutPreset(settings.webcamLayoutPreset, hasCamera);
		return computeCompositeLayout({
			canvasSize: outputDims,
			maxContentSize: {
				width: Math.round(outputDims.width * paddingFit),
				height: Math.round(outputDims.height * paddingFit),
			},
			screenSize,
			webcamSize: preset === "no-webcam" ? null : camSize,
			layoutPreset: preset,
			webcamSizePreset: settings.webcamSizePreset,
			webcamPosition: preset === "picture-in-picture" ? settings.webcamPosition : null,
			webcamMaskShape: settings.webcamMaskShape,
		});
	};
	const toFrameFractions = (r: RenderRect) => ({
		x: r.x / outputDims.width,
		y: r.y / outputDims.height,
		width: r.width / outputDims.width,
		height: r.height / outputDims.height,
	});
	// Corner radii leave as a fraction of the box they round (see `screenRadiusFrac`).
	// Both the radius and the box are measured in output pixels here, so the ratio is
	// scale-invariant — the clamp `computeCompositeLayout` applies in absolute pixels
	// still lands exactly where it did, at any render size.
	const radiusFractionOf = (box: RenderRect | null | undefined, radius: number | undefined) => {
		const shortSide = box ? Math.min(box.width, box.height) : 0;
		return box && shortSide > 0 && radius != null ? radius / shortSide : null;
	};
	const resolvedLayoutOf = (layout: ReturnType<typeof layoutForClip>) =>
		layout
			? {
					screenRect: toFrameFractions(layout.screenRect),
					webcamRect: layout.webcamRect ? toFrameFractions(layout.webcamRect) : null,
					screenRadiusFrac: radiusFractionOf(layout.screenRect, layout.screenBorderRadius),
					webcamRadiusFrac: radiusFractionOf(layout.webcamRect, layout.webcamRect?.borderRadius),
					webcamShape: layout.webcamRect?.maskShape ?? settings.webcamMaskShape,
					screenCover: layout.screenCover ?? false,
				}
			: null;
	// One resolved layout per visible clip, index-aligned with `clips` / `cropByClip`.
	// `for_clip_window` (Rust) selects the entry for the clip being composed, so the
	// draw path keeps reading a single `layout` and needs no per-clip branch of its own.
	const layoutByClip = visibleClips.map((clip, index) =>
		resolvedLayoutOf(
			layoutForClip(screenSourceSizeOf(clip, index), clipHasCamera(clip), webcamSourceSizeOf(clip)),
		),
	);
	// Scalar fields stay the FIRST clip's layout: they are the fallback for a payload
	// without `layoutByClip`, and the value native starts from before any clip is active.
	const computedLayout = visibleClips[0]
		? layoutForClip(
				screenSourceSizeOf(visibleClips[0], 0),
				clipHasCamera(visibleClips[0]),
				webcamSourceSizeOf(visibleClips[0]),
			)
		: null;
	const webcamRect = computedLayout?.webcamRect
		? toFrameFractions(computedLayout.webcamRect)
		: null;
	const screenRect = computedLayout ? toFrameFractions(computedLayout.screenRect) : null;

	return {
		clips,
		layout: {
			preset: settings.webcamLayoutPreset,
			// web-consistent 0..1 fraction of the canvas reference dimension
			// (see `SceneLayout.webcamSize` for the consumer-facing semantics).
			webcamSize: webcamSizeToFraction(settings.webcamSizePreset),
			// The RESOLVED shape, not the raw setting — the block layouts always cut a
			// rectangle, whatever shape the user last picked under picture-in-picture.
			webcamShape: computedLayout?.webcamRect?.maskShape ?? settings.webcamMaskShape,
			webcamMirror: settings.webcamMirrored,
			webcamPosition: settings.webcamPosition,
			// Gated by the preset: the block layouts size their camera off the screen
			// box, so it must never shrink mid-zoom (the UI hides the toggle too).
			webcamReactiveZoom: resolveWebcamReactiveZoom(
				settings.webcamLayoutPreset,
				settings.webcamReactiveZoom,
			),
			webcamCrop: settings.webcamCropRegion,
			webcamRect,
			screenRect,
			screenRadiusFrac: radiusFractionOf(
				computedLayout?.screenRect,
				computedLayout?.screenBorderRadius,
			),
			screenCover: computedLayout?.screenCover ?? false,
			webcamRadiusFrac: radiusFractionOf(
				computedLayout?.webcamRect,
				computedLayout?.webcamRect?.borderRadius,
			),
			layoutByClip,
		},
		effects: {
			padding: settings.padding / 100,
			blur: settings.showBlur,
			shadow: settings.shadowIntensity,
			// The slider is in output pixels; the contract is in fractions of the frame's
			// short side. This division is the whole conversion — see `roundnessFrac`.
			roundnessFrac:
				settings.borderRadius / Math.max(1, Math.min(outputDims.width, outputDims.height)),
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
		audio: {
			gainDb: settings.audioGainDb,
		},
		background: parseWallpaper(settings.wallpaper),
		zoomRegions: projectedZoomRegions.map((region) => ({
			id: region.id,
			startSec: region.startMs / 1000,
			endSec: region.endMs / 1000,
			// `ZOOM_DEPTH_SCALES` et rien d'autre. Cette ligne portait sa propre formule,
			// `depth / 2 + 0.5`, qui ne coïncide avec la table qu'à la profondeur 2 — et le focus,
			// lui, est borné avec la table (`getFocusBoundsForScale`, via `getZoomScale`). Les deux
			// échelles se contredisaient donc : à la profondeur 3 le gimbal butait à 1/(2×1.8) =
			// 0.2778 pendant que le compositeur découpait une demi-fenêtre de 1/(2×2.0) = 0.25, si
			// bien que la fenêtre source s'arrêtait 2.78 % avant le bord — 53 px sur 1920
			// définitivement hors d'atteinte, gimbal à fond dans le coin. Le symptôme rapporté :
			// « le zoom coupe les bords extérieurs ».
			//
			// ponytail: et c'est `getZoomScale` en entier, pas la table seule. La ligne
			// lisait `region.customScale ?? ZOOM_DEPTH_SCALES[depth]`, donc sans le clamp
			// [1.0, 5.0] que l'UI applique. Or `zoomRegionSchema` n'exige de `customScale`
			// que d'être positif : un document portant `customScale: 12` est valide, rendait
			// 5× dans l'aperçu web et 12× ici. Même désaccord que ci-dessus, un cran plus bas.
			scale: getZoomScale(region),
			focusX: region.focus.cx,
			focusY: region.focus.cy,
			// The global Auto-Focus toggle OVERRIDES each region's own mode rather than merely
			// seeding it — that's what `settings.zoom.focusMode.lockedDisclaimer` promises the
			// user ("turn it off to set focus mode per zoom"), and it's what makes the toolbar
			// button a one-click "make every zoom follow the cursor".
			focusMode: settings.autoFocusAll ? "auto" : (region.focusMode ?? null),
			rotation: region.rotationPreset ?? null,
			clipIndex: region.clipIndex,
		})),
		annotations: projectedAnnotations
			.map((region) => {
				const style = region.style;
				// Only captions carry a space; annotations must keep emitting the exact same keys
				// they always have, so the field is omitted rather than sent as null/undefined.
				const space = (region as { space?: "frame" }).space;
				// Same treatment, same reason: only captions pin an edge.
				const verticalAlign = (region as { verticalAlign?: "top" | "bottom" }).verticalAlign;
				const base = {
					id: region.id,
					startSec: region.startMs / 1000,
					endSec: region.endMs / 1000,
					clipIndex: region.clipIndex,
					kind: region.type,
					...(space ? { space } : {}),
					// Authored as percentages of the box named by `space` — the screen rect unless
					// this is a caption; the native side wants fractions either way.
					x: region.position.x / 100,
					y: region.position.y / 100,
					w: region.size.width / 100,
					h: region.size.height / 100,
					zIndex: region.zIndex,
				} as const;
				if (region.type === "text") {
					return {
						...base,
						text: {
							// `content` first, and with `||` rather than `??`. The inspector's textarea
							// writes to `content`; `textContent` is the parallel slot, which
							// `addAnnotation` initialises to "". Since "" is neither null nor undefined,
							// `textContent ?? content` returned that empty string for every annotation
							// created since — so the compositor was handed nothing to draw and text
							// vanished from the preview the moment the DOM overlay stopped painting it.
							content: region.content || region.textContent || "",
							color: style.color,
							backgroundColor: style.backgroundColor,
							fontSizeRel: annotationFontSizeFraction(style.fontSize),
							fontFamily: style.fontFamily,
							fontWeight: style.fontWeight,
							fontStyle: style.fontStyle,
							textDecoration: style.textDecoration,
							textAlign: style.textAlign,
							...(verticalAlign ? { verticalAlign } : {}),
							animation: style.textAnimation ?? null,
						},
					};
				}
				if (region.type === "image") {
					// `content` first: that is the field the live overlay reads (it checks
					// `content.startsWith("data:image")`), `imageContent` being the parallel slot
					// older documents used. Reading them the other way round would render an image
					// the preview isn't showing.
					return { ...base, imagePath: region.content || region.imageContent || "" };
				}
				if (region.type === "figure") {
					const figure = region.figureData;
					return {
						...base,
						figure: {
							direction: figure?.arrowDirection ?? "right",
							color: figure?.color ?? "#34B27B",
							strokeWidth: figure?.strokeWidth ?? 4,
						},
					};
				}
				const blur = region.blurData;
				return {
					...base,
					blur: {
						style: blur?.type ?? "mosaic",
						shape: blur?.shape ?? "rectangle",
						color: blur?.color ?? "white",
						intensity: blur?.intensity ?? 12,
						blockSize: blur?.blockSize ?? 12,
						...(blur?.freehandPoints
							? {
									freehandPoints: blur.freehandPoints.map((p) => ({
										x: p.x / 100,
										y: p.y / 100,
									})),
								}
							: {}),
					},
				};
			})
			// Ascending zIndex so the compositor paints in order without sorting per frame.
			.sort((a, b) => a.zIndex - b.zIndex),
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
