// Vendored from @axcut/schema (https://github.com/EtienneLescot/axcut) —
// original file: packages/axcut-schema/src/index.ts. Modifications for
// OpenScreen's AI-edition merge (Phase 0, see technical-documentation/architecture/document-model.md):
//
//   1. axcutSchemaVersion bumped 2 -> 3.
//   2. clip.sourceEndSec made optional (duration is unknown until asset is probed).
//   3. documentSchema gains annotations[], zoomRanges[], legacyEditor envelopes
//      so OpenScreen's existing regions + appearance settings survive the merge.
//
// ponytail: this exists as the SSOT project model. Phase 0 only touches the
// shape — runtime ops, IPC, and exporter integration land in Phase 1+.

import { z } from "zod";
// Cycle-safe: `aspectRatioUtils` has no schema dependency, and `document/outputFormat`
// is downstream of schema. We import the leaf tokeniser directly so the v5→v6 upgrader
// can rewrite `"native"` without dragging in the whole output-format module.
// Relative, not `@/`: the Electron main bundle imports this module and
// vite-plugin-electron builds it without the root resolve.alias.
import { toAspectRatioToken } from "../../../utils/aspectRatioUtils";
// Cycle-safe: `document/ids` only pulls `uuid`, and `timeline/timelineMap`'s
// transitive value-imports (region-ventilation, virtual-preview) import from this
// module TYPE-ONLY, so requiring them here never re-enters schema at runtime.
import { createId } from "../document/ids";
import { anchorRegionsWithDerivedMs } from "../timeline/timelineMap";

//   4. v5 — modifiers (zoom / annotation / speed / cameraFullscreen) become
//      CLIP-ANCHORED fragments: `{clipId, sourceStartSec, sourceEndSec}` is the
//      source of truth, `startMs`/`endMs` stay as a derived cache for the
//      transition. See technical-documentation/architecture/timeline-model.md
//   5. v6 — `"native"` AspectRatio retires. The v5→v6 upgrader rewrites every
//      stored `"native"` to a concrete `"W:H"` token (the timeline's largest
//      clip, falling back to "16:9"), so the value can be dropped from the
//      `AspectRatio` union without a runtime bridge.
export const axcutSchemaVersion = 6;

export const isoDateSchema = z.string().datetime({ offset: true });

export const wordSchema = z
	.object({
		id: z.string().min(1),
		segmentId: z.string().min(1),
		startSec: z.number().nonnegative(),
		endSec: z.number().nonnegative(),
		text: z.string(),
	})
	.refine((data) => data.endSec >= data.startSec, {
		message: "endSec must be greater than or equal to startSec",
		path: ["endSec"],
	});

export const transcriptSegmentSchema = z
	.object({
		id: z.string().min(1),
		kind: z.enum(["speech", "silence"]),
		startSec: z.number().nonnegative(),
		endSec: z.number().nonnegative(),
		text: z.string(),
		wordIds: z.array(z.string().min(1)).default([]),
	})
	.refine((data) => data.endSec >= data.startSec, {
		message: "endSec must be greater than or equal to startSec",
		path: ["endSec"],
	});

export const transcriptSchema = z.object({
	assetId: z.string().min(1),
	language: z.string().min(1),
	sourceDslPath: z.string().optional(),
	sourceJsonPath: z.string().optional(),
	segments: z.array(transcriptSegmentSchema).default([]),
	words: z.array(wordSchema).default([]),
});

export const assetVideoSchema = z.object({
	codec: z.string().default("unknown"),
	width: z.number().int().nonnegative().default(0),
	height: z.number().int().nonnegative().default(0),
	fps: z.number().nonnegative().default(0),
});

export const assetAudioSchema = z.object({
	codec: z.string().default("unknown"),
	sampleRate: z.number().int().nonnegative().default(0),
	channels: z.number().int().nonnegative().default(0),
});

// ponytail: the webcam is a derived stream — it is NOT edited. Cut / zoom /
// speed live on the main timeline and apply to the camera as a render of the
// same source-time progression. Source path comes from the recording
// session sidecar (auto-linked when an asset is imported from a recording).
// `offsetMs` accounts for the camera starting before/after the screen.
//
// Lives on the asset (not the document) since P4 (per-asset media links) —
// a project can hold multiple assets, each recorded with its own camera (or
// none). See technical-documentation/architecture/document-model.md.
export const cameraTrackSchema = z
	.object({
		sourcePath: z.string().min(1),
		startMs: z.number().nonnegative().default(0),
		offsetMs: z.number().int().default(0),
		visible: z.boolean().default(true),
	})
	.nullable()
	.default(null);

export const assetSchema = z.object({
	id: z.string().min(1),
	kind: z.literal("video"),
	label: z.string().min(1),
	originalPath: z.string().min(1),
	proxyPath: z.string().optional(),
	waveformPath: z.string().optional(),
	durationSec: z.number().nonnegative().optional(),
	// P3.1 — file size captured at import time (fs.stat in document-service).
	sizeBytes: z.number().int().nonnegative().optional(),
	video: assetVideoSchema.optional(),
	audio: assetAudioSchema.optional(),
	cameraTrack: cameraTrackSchema,
});

// A crop is a sub-rectangle of the source video, expressed as fractions
// (0-1) of its full frame. Lives on the clip (not the document/legacyEditor
// envelope) since a crop frames one specific piece of footage — two clips
// cut from the same or different assets can reasonably want different
// framings. Mirrors `CropRegion` in `src/components/video-editor/types.ts`;
// duplicated here so the schema package has no dependency on the React
// editor module (same rationale as AnnotationRegion/ZoomRegion above).
export const clipCropRegionSchema = z.object({
	x: z.number().min(0).max(1),
	y: z.number().min(0).max(1),
	width: z.number().min(0).max(1),
	height: z.number().min(0).max(1),
});

export const clipSchema = z
	.object({
		id: z.string().min(1),
		assetId: z.string().min(1),
		sourceStartSec: z.number().nonnegative(),
		// ponytail: optional because v2 migrations have unknown asset duration at
		// migration time. The renderer fills this in once StreamingVideoDecoder probes
		// the file (Phase 1+).
		sourceEndSec: z.number().nonnegative().optional(),
		timelineStartSec: z.number().nonnegative(),
		timelineEndSec: z.number().nonnegative(),
		wordRefs: z.array(z.string().min(1)).default([]),
		origin: z.enum(["system", "agent", "user"]),
		reason: z.string().default(""),
		// Absent/undefined means "no crop" (full frame) — callers should treat
		// that as the identity region {x:0,y:0,width:1,height:1} rather than
		// storing the identity explicitly, so untouched clips stay lean.
		cropRegion: clipCropRegionSchema.optional(),
	})
	.refine((data) => data.timelineEndSec >= data.timelineStartSec, {
		message: "timelineEndSec must be greater than or equal to timelineStartSec",
		path: ["timelineEndSec"],
	})
	.refine((data) => data.sourceEndSec === undefined || data.sourceEndSec >= data.sourceStartSec, {
		message: "sourceEndSec must be greater than or equal to sourceStartSec",
		path: ["sourceEndSec"],
	});

export const gapSchema = z
	.object({
		id: z.string().min(1),
		timelineStartSec: z.number().nonnegative(),
		timelineEndSec: z.number().nonnegative(),
		reason: z.string().default(""),
	})
	.refine((data) => data.timelineEndSec >= data.timelineStartSec, {
		message: "timelineEndSec must be greater than or equal to timelineStartSec",
		path: ["timelineEndSec"],
	});

export const rangeSchema = z
	.object({
		startSec: z.number().nonnegative(),
		endSec: z.number().nonnegative(),
		reason: z.string().default(""),
	})
	.refine((data) => data.endSec >= data.startSec, {
		message: "endSec must be greater than or equal to startSec",
		path: ["endSec"],
	});

// ponytail: trimRanges reference asset source-time (not timeline). trimRegions
// in v2 are the inverse — a skip = the region inside the source we DON'T keep.
export const trimRangeSchema = z
	.object({
		id: z.string().min(1),
		assetId: z.string().min(1),
		startSec: z.number().nonnegative(),
		endSec: z.number().nonnegative(),
		reason: z.string().default(""),
		origin: z.enum(["system", "agent", "user"]),
	})
	.refine((data) => data.endSec >= data.startSec, {
		message: "endSec must be greater than or equal to startSec",
		path: ["endSec"],
	});

export const timelineSchema = z.preprocess(
	// Back-compat: the field was renamed skipRanges → trimRanges. Old persisted
	// documents (disk + browser-shim localStorage) still carry `skipRanges`;
	// fold it into `trimRanges` on load so trims aren't silently dropped.
	(value) => {
		if (value && typeof value === "object" && !Array.isArray(value)) {
			const v = value as Record<string, unknown>;
			if (v.skipRanges !== undefined && v.trimRanges === undefined) {
				return { ...v, trimRanges: v.skipRanges };
			}
		}
		return value;
	},
	z.object({
		clips: z.array(clipSchema).default([]),
		gaps: z.array(gapSchema).default([]),
		trimRanges: z.array(trimRangeSchema).default([]),
		muteRanges: z.array(rangeSchema).default([]),
		speedRanges: z.array(rangeSchema).default([]),
		captionRanges: z.array(rangeSchema).default([]),
	}),
);

export const timelineOperationSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("replace_timeline"),
		reason: z.string().default(""),
		intervals: z
			.array(z.object({ startSec: z.number().nonnegative(), endSec: z.number().nonnegative() }))
			.default([]),
	}),
	z.object({
		type: z.literal("drop_range"),
		reason: z.string().default(""),
		startSec: z.number().nonnegative(),
		endSec: z.number().nonnegative(),
	}),
	z.object({
		type: z.literal("drop_word_range"),
		reason: z.string().default(""),
		startWordId: z.string().min(1),
		endWordId: z.string().min(1),
	}),
	z.object({
		type: z.literal("add_trim_range"),
		reason: z.string().default(""),
		assetId: z.string().min(1),
		startSec: z.number().nonnegative(),
		endSec: z.number().nonnegative(),
	}),
	z.object({
		type: z.literal("update_trim_range"),
		reason: z.string().default(""),
		trimRangeId: z.string().min(1),
		startSec: z.number().nonnegative(),
		endSec: z.number().nonnegative(),
	}),
	z.object({
		type: z.literal("remove_trim_range"),
		reason: z.string().default(""),
		trimRangeId: z.string().min(1),
	}),
	z.object({
		type: z.literal("update_clip_range"),
		reason: z.string().default(""),
		clipId: z.string().min(1),
		sourceStartSec: z.number().nonnegative(),
		sourceEndSec: z.number().nonnegative().optional(),
	}),
	z.object({
		type: z.literal("duplicate_clip"),
		reason: z.string().default(""),
		clipId: z.string().min(1),
	}),
	z.object({
		type: z.literal("move_clip"),
		reason: z.string().default(""),
		clipId: z.string().min(1),
		timelineStartSec: z.number().nonnegative(),
	}),
	z.object({
		type: z.literal("insert_asset_clip"),
		reason: z.string().default(""),
		assetId: z.string().min(1),
		beforeClipId: z.string().min(1).nullable(),
		afterClipId: z.string().min(1).nullable(),
		sourceStartSec: z.number().nonnegative(),
		sourceEndSec: z.number().nonnegative().optional(),
	}),
	z.object({
		type: z.literal("restore_full_timeline"),
		reason: z.string().default(""),
	}),
]);

// OpenScreen additions to the axcut document. Mirrors src/components/video-editor/types.ts
// (AnnotationRegion / ZoomRegion) — duplicated here so the schema package has no
// dependency on the React editor module.

const blurDataSchema = z
	.object({
		type: z.enum(["blur", "mosaic"]).default("mosaic"),
		shape: z.enum(["rectangle", "oval", "freehand"]).default("rectangle"),
		color: z.enum(["white", "black"]).default("white"),
		intensity: z.number().nonnegative().default(12),
		blockSize: z.number().nonnegative().default(12),
		freehandPoints: z
			.array(z.object({ x: z.number().nonnegative(), y: z.number().nonnegative() }))
			.optional(),
	})
	.optional();

const figureDataSchema = z
	.object({
		arrowDirection: z
			.enum(["up", "down", "left", "right", "up-right", "up-left", "down-right", "down-left"])
			.default("right"),
		color: z.string().default("#34B27B"),
		strokeWidth: z.number().nonnegative().default(4),
	})
	.optional();

const annotationStyleSchema = z.object({
	color: z.string().default("#ffffff"),
	backgroundColor: z.string().default("transparent"),
	// `backgroundColor: "transparent"` is how every renderer reads "no background", so switching
	// the background off has to overwrite the colour the user picked — and switching it back on had
	// nothing left to restore, which is why it always came back black. This keeps that last colour
	// so the toggle is reversible. Nothing renders it: the paint path still reads `backgroundColor`
	// alone.
	lastBackgroundColor: z.string().optional(),
	fontSize: z.number().nonnegative().default(32),
	fontFamily: z.string().default("Inter"),
	fontWeight: z.enum(["normal", "bold"]).default("bold"),
	fontStyle: z.enum(["normal", "italic"]).default("normal"),
	textDecoration: z.enum(["none", "underline"]).default("none"),
	textAlign: z.enum(["left", "center", "right"]).default("center"),
	textAnimation: z
		.enum(["none", "fade", "rise", "pop", "slide-left", "typewriter", "pulse"])
		.optional(),
});

// v5 clip anchor — the source of truth for a modifier's position. A region the user drew
// across a clip boundary is stored as one fragment per covered clip; they need no shared
// marker, because two regions with equal properties that touch render as one pill by the
// universal merge rule (see timelineMap). Optional during the Stage B transition: the
// v4→v5 migration fills it in, and regions created by not-yet-migrated code still validate
// on startMs/endMs alone, which remain a DERIVED cache of the fragment's ruler span.
const clipAnchorShape = {
	clipId: z.string().min(1).optional(),
	sourceStartSec: z.number().nonnegative().optional(),
	sourceEndSec: z.number().nonnegative().optional(),
};

export const annotationRegionSchema = z
	.object({
		id: z.string().min(1),
		startMs: z.number().nonnegative(),
		endMs: z.number().nonnegative(),
		...clipAnchorShape,
		type: z.enum(["text", "image", "figure", "blur"]),
		content: z.string().default(""),
		textContent: z.string().optional(),
		imageContent: z.string().optional(),
		position: z.object({
			x: z.number().min(0).max(100),
			y: z.number().min(0).max(100),
		}),
		size: z.object({
			width: z.number().positive(),
			height: z.number().positive(),
		}),
		style: annotationStyleSchema,
		zIndex: z.number().int().nonnegative(),
		annotationSource: z.literal("auto-caption").optional(),
		figureData: figureDataSchema,
		blurData: blurDataSchema,
	})
	.refine((data) => data.endMs >= data.startMs, {
		message: "endMs must be greater than or equal to startMs",
		path: ["endMs"],
	});

export const zoomRegionSchema = z
	.object({
		id: z.string().min(1),
		startMs: z.number().nonnegative(),
		endMs: z.number().nonnegative(),
		...clipAnchorShape,
		depth: z.union([
			z.literal(1),
			z.literal(2),
			z.literal(3),
			z.literal(4),
			z.literal(5),
			z.literal(6),
		]),
		focus: z.object({
			cx: z.number().min(0).max(1),
			cy: z.number().min(0).max(1),
		}),
		focusMode: z.enum(["manual", "auto"]).optional(),
		rotationPreset: z.enum(["iso", "left", "right"]).optional(),
		customScale: z.number().positive().optional(),
		source: z.enum(["auto", "manual"]).optional(),
	})
	.refine((data) => data.endMs >= data.startMs, {
		message: "endMs must be greater than or equal to startMs",
		path: ["endMs"],
	});

// Legacy OpenScreen appearance / export settings that the v3 schema doesn't
// normalize into the timeline / assets model. They are applied at export time
// by the existing pipeline (see technical-documentation/architecture/document-model.md).
//
// ponytail: passthrough blob — v2 ProjectEditorState carries ~25 fields, several
// of which (autoZoomEnabled, autoFocusAll, cursorTheme, …) have no first-class
// home yet. Phase 1 timeline rewrite + Phase 9 settings sync will tighten this.
// Round-trip through the migration must be lossless for now.
export const legacyEditorSchema = z.object({}).passthrough().nullable().default(null);

const documentSchemaShape = z.object({
	schemaVersion: z.literal(axcutSchemaVersion),
	project: z.object({
		id: z.string().min(1),
		title: z.string().min(1),
		createdAt: isoDateSchema,
		updatedAt: isoDateSchema,
		primaryAssetId: z.string().optional(),
	}),
	assets: z.array(assetSchema).default([]),
	transcript: transcriptSchema.nullable().default(null),
	transcripts: z.array(transcriptSchema).default([]),
	timeline: timelineSchema.default({
		clips: [],
		gaps: [],
		trimRanges: [],
		muteRanges: [],
		speedRanges: [],
		captionRanges: [],
	}),
	annotations: z.array(annotationRegionSchema).default([]),
	zoomRanges: z.array(zoomRegionSchema).default([]),
	legacyEditor: legacyEditorSchema.nullable().default(null),
});

// P4 — v3 documents carried a single project-level `cameraTrack` (one project
// = one camera, inherited from the pre-multi-clip editor). v4 moves it onto
// the owning asset (see `assetSchema.cameraTrack` above) so each asset in a
// multi-clip project can carry its own camera link. This preprocess upgrades
// any v3 document transparently at every `documentSchema.parse(...)` call
// site — it does NOT touch v2 (still handled solely by the separate
// `migrateProjectDataToAxcutDocument` pure function) or reject unknown
// versions; anything that isn't exactly v3 passes through unchanged and is
// rejected by the `schemaVersion` literal check below as before.
function upgradeV3DocumentToV4(raw: unknown): unknown {
	if (!raw || typeof raw !== "object") return raw;
	const doc = raw as Record<string, unknown>;
	if (doc.schemaVersion !== 3) return raw;

	const legacyCameraTrack = doc.cameraTrack ?? null;
	const assets = Array.isArray(doc.assets) ? doc.assets : [];
	const project = (doc.project ?? {}) as { primaryAssetId?: string };
	const targetAssetId = project.primaryAssetId ?? (assets[0] as { id?: string } | undefined)?.id;

	const nextAssets = assets.map((asset) => {
		if (!asset || typeof asset !== "object") return asset;
		const a = asset as Record<string, unknown>;
		return legacyCameraTrack && a.id === targetAssetId && a.cameraTrack === undefined
			? { ...a, cameraTrack: legacyCameraTrack }
			: a;
	});

	const { cameraTrack: _legacyCameraTrack, ...rest } = doc;
	return { ...rest, schemaVersion: 4, assets: nextAssets };
}

/**
 * v4 → v5 — modifiers become CLIP-ANCHORED fragments. Every RAW-virtual-ms region
 * (document `zoomRanges` / `annotations`, plus the `legacyEditor.speedRegions` /
 * `cameraFullscreenRegions` envelopes) is ventilated across the stored RAW clip
 * layout it was authored against, yielding one fragment per covered clip, with
 * `startMs`/`endMs` re-derived as a transition cache. The fragments carry no marker
 * tying them together: they share the same properties, so the ruler already renders
 * them as one pill whenever they are adjacent (see timelineMap merge rule).
 *
 * A region covering no clip (zero-length, or off the end of the timeline) is
 * dropped: it could never play. A document with no clips has nothing to anchor to,
 * so its regions pass through untouched (still valid — the anchor is optional).
 */
function upgradeV4DocumentToV5(raw: unknown): unknown {
	if (!raw || typeof raw !== "object") return raw;
	const doc = raw as Record<string, unknown>;
	if (doc.schemaVersion !== 4) return raw;

	const timeline = (doc.timeline ?? {}) as Record<string, unknown>;
	const clips = (Array.isArray(timeline.clips) ? timeline.clips : []) as unknown as AxcutClip[];

	const anchor = (value: unknown, prefix: string): unknown => {
		if (!Array.isArray(value) || clips.length === 0) return value;
		return anchorRegionsWithDerivedMs(
			value as Array<{ id: string; startMs: number; endMs: number }>,
			clips,
			() => createId(prefix),
		);
	};

	const legacy =
		doc.legacyEditor && typeof doc.legacyEditor === "object" && !Array.isArray(doc.legacyEditor)
			? (doc.legacyEditor as Record<string, unknown>)
			: null;

	return {
		...doc,
		schemaVersion: 5,
		zoomRanges: anchor(doc.zoomRanges, "zoom"),
		annotations: anchor(doc.annotations, "ann"),
		legacyEditor: legacy
			? {
					...legacy,
					...(Array.isArray(legacy.speedRegions)
						? { speedRegions: anchor(legacy.speedRegions, "speed") }
						: {}),
					...(Array.isArray(legacy.cameraFullscreenRegions)
						? { cameraFullscreenRegions: anchor(legacy.cameraFullscreenRegions, "camfull") }
						: {}),
				}
			: doc.legacyEditor,
	};
}

/**
 * Largest raw asset footprint among the timeline's clips. A local copy of the
 * `referenceClipDims` pick from `document/outputFormat` — duplicated here so the schema
 * package doesn't import from a module that itself imports from this one (cycle), and so
 * the upgrader doesn't need the runtime `probedAssetDims` map (it runs at load time, before
 * any asset is probed). Crop IS applied: `"native"` resolved to the *cropped* clip
 * dimensions at runtime (`clipEffectiveDims` → `calculateEffectiveSourceDimensions`),
 * so ignoring it here would silently reframe every cropped project.
 */
/** Mirrors `atLeastEven` in mp4ExportSettings — H.264 4:2:0 rejects odd dims. */
function atLeastEven(value: number): number {
	return Math.max(2, Math.floor(value / 2) * 2);
}

function largestClipDims(doc: Record<string, unknown>): { width: number; height: number } | null {
	const timeline = (doc.timeline ?? {}) as Record<string, unknown>;
	const clips = Array.isArray(timeline.clips) ? timeline.clips : [];
	const assets = Array.isArray(doc.assets) ? doc.assets : [];
	const assetById = new Map<string, Record<string, unknown>>();
	for (const a of assets) {
		if (a && typeof a === "object" && typeof (a as { id?: unknown }).id === "string") {
			assetById.set((a as { id: string }).id, a as Record<string, unknown>);
		}
	}
	let best: { width: number; height: number } | null = null;
	let bestArea = 0;
	for (const clip of clips) {
		if (!clip || typeof clip !== "object") continue;
		const c = clip as Record<string, unknown>;
		const assetId = c.assetId;
		if (typeof assetId !== "string") continue;
		const asset = assetById.get(assetId);
		if (!asset) continue;
		const video = (asset.video ?? {}) as Record<string, unknown>;
		const rawW = typeof video.width === "number" ? video.width : 0;
		const rawH = typeof video.height === "number" ? video.height : 0;
		if (rawW <= 0 || rawH <= 0) continue;
		// Apply the clip's crop, exactly as `calculateEffectiveSourceDimensions`
		// (mp4ExportSettings) does at runtime — including the snap to even pixels,
		// so the reduced token matches the size the encoder is actually handed.
		// "native" meant "the cropped source's shape"; ignoring crop here would
		// bake the wrong ratio into every cropped project.
		const crop = (c.cropRegion ?? {}) as Record<string, unknown>;
		const cropW = typeof crop.width === "number" && crop.width > 0 ? crop.width : 1;
		const cropH = typeof crop.height === "number" && crop.height > 0 ? crop.height : 1;
		const w = atLeastEven(Math.round(rawW * cropW));
		const h = atLeastEven(Math.round(rawH * cropH));
		const area = w * h;
		if (area > bestArea) {
			bestArea = area;
			best = { width: w, height: h };
		}
	}
	return best;
}

/**
 * v5 → v6 — retire the `"native"` AspectRatio. `"native"` was a runtime-only sentinel
 * that resolved to the timeline's largest clip; v6 makes that resolution permanent by
 * baking the concrete `"W:H"` token into the document. The new value matches the OLD
 * runtime answer (largest clip), so projects migrate losslessly — preview and export
 * will keep framing the same shape they did yesterday.
 *
 * Falls back to `"16:9"` when the timeline has no clips with known dimensions (the same
 * value the runtime bridge in `resolveAspectRatioValue` returned when no document was
 * available). A document without a `legacyEditor` envelope is unchanged apart from the
 * version bump.
 */
function upgradeV5DocumentToV6(raw: unknown): unknown {
	if (!raw || typeof raw !== "object") return raw;
	const doc = raw as Record<string, unknown>;
	if (doc.schemaVersion !== 5) return raw;

	const legacy =
		doc.legacyEditor && typeof doc.legacyEditor === "object" && !Array.isArray(doc.legacyEditor)
			? (doc.legacyEditor as Record<string, unknown>)
			: null;

	if (!legacy || legacy.aspectRatio !== "native") {
		return { ...doc, schemaVersion: 6 };
	}

	// OPPORTUNISTIC, never forced. Baking requires real source dimensions, and a
	// project imported from v1.7 has none yet: `migrateProjectDataToAxcutDocument`
	// builds its asset from `{version:2, media, editor}`, which carries only file
	// paths — dimensions arrive later, when `useTimeline`'s probe effect writes
	// `asset.video` back to disk.
	//
	// So when dimensions are unknown we leave `"native"` in place rather than
	// stamping a hardcoded ratio. `"native"` keeps resolving dynamically at runtime
	// (`resolveAspectRatioValue`), which IS the v1.7 behaviour, and the next load
	// after the probe has persisted dimensions converts it for real. Forcing
	// `"16:9"` here would permanently reframe every portrait v1.7 project that used
	// "Native", on its first open in v1.8, with no way back.
	const dims = largestClipDims(doc);
	if (!dims) {
		return { ...doc, schemaVersion: 6 };
	}
	return {
		...doc,
		schemaVersion: 6,
		legacyEditor: { ...legacy, aspectRatio: toAspectRatioToken(dims.width, dims.height) },
	};
}

export const documentSchema = z.preprocess(
	(raw) => upgradeV5DocumentToV6(upgradeV4DocumentToV5(upgradeV3DocumentToV4(raw))),
	documentSchemaShape,
);

export const createProjectInputSchema = z.object({
	title: z.string().trim().min(1).default("Untitled Project"),
});

export const addAssetInputSchema = z.object({
	path: z.string().trim().min(1),
	label: z.string().trim().optional(),
	autoTranscribe: z.boolean().default(true),
});

export const chatInputSchema = z.object({
	sessionId: z.string().trim().min(1).optional(),
	message: z.string().trim().min(1),
});

export const transcriptLanguageSchema = z.enum([
	"auto",
	"en",
	"fr",
	"de",
	"es",
	"it",
	"pt",
	"nl",
	"ja",
	"ko",
	"zh",
]);

export type AxcutWord = z.infer<typeof wordSchema>;
export type AxcutTranscriptSegment = z.infer<typeof transcriptSegmentSchema>;
export type AxcutTranscript = z.infer<typeof transcriptSchema>;
export type AxcutAsset = z.infer<typeof assetSchema>;
export type AxcutClip = z.infer<typeof clipSchema>;
export type AxcutClipCropRegion = z.infer<typeof clipCropRegionSchema>;
export type AxcutGap = z.infer<typeof gapSchema>;
export type AxcutTrimRange = z.infer<typeof trimRangeSchema>;
export type AxcutTimeline = z.infer<typeof timelineSchema>;
export type AxcutTimelineOperation = z.infer<typeof timelineOperationSchema>;
export type AxcutAnnotationRegion = z.infer<typeof annotationRegionSchema>;
export type AxcutZoomRegion = z.infer<typeof zoomRegionSchema>;
export type AxcutCameraTrack = z.infer<typeof cameraTrackSchema>;
export type AxcutLegacyEditor = z.infer<typeof legacyEditorSchema>;
export type AxcutDocument = z.infer<typeof documentSchema>;
export type AxcutDocumentInput = z.input<typeof documentSchema>;
export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;
export type AddAssetInput = z.infer<typeof addAssetInputSchema>;
export type ChatInput = z.infer<typeof chatInputSchema>;

export function createEmptyDocument(
	input: CreateProjectInput & { projectId: string; createdAt?: string },
): AxcutDocument {
	const createdAt = input.createdAt ?? new Date().toISOString();
	return documentSchema.parse({
		schemaVersion: axcutSchemaVersion,
		project: {
			id: input.projectId,
			title: input.title,
			createdAt,
			updatedAt: createdAt,
		},
		assets: [],
		transcript: null,
		transcripts: [],
		timeline: {
			clips: [],
			gaps: [],
			trimRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		annotations: [],
		zoomRanges: [],
		legacyEditor: null,
	});
}

export function ensureDocument(value: unknown): AxcutDocument {
	return documentSchema.parse(value);
}
