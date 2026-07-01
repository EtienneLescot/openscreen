// Vendored from @axcut/schema (https://github.com/EtienneLescot/axcut) —
// original file: packages/axcut-schema/src/index.ts. Modifications for
// OpenScreen's AI-edition merge (Phase 0, see docs/architecture/ai-edition-roadmap.md):
//
//   1. axcutSchemaVersion bumped 2 -> 3.
//   2. clip.sourceEndSec made optional (duration is unknown until asset is probed).
//   3. documentSchema gains annotations[], zoomRanges[], legacyEditor envelopes
//      so OpenScreen's existing regions + appearance settings survive the merge.
//
// ponytail: this exists as the SSOT project model. Phase 0 only touches the
// shape — runtime ops, IPC, and exporter integration land in Phase 1+.

import { z } from "zod";

export const axcutSchemaVersion = 3;

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

export const assetSchema = z.object({
	id: z.string().min(1),
	kind: z.literal("video"),
	label: z.string().min(1),
	originalPath: z.string().min(1),
	proxyPath: z.string().optional(),
	waveformPath: z.string().optional(),
	durationSec: z.number().nonnegative().optional(),
	video: assetVideoSchema.optional(),
	audio: assetAudioSchema.optional(),
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

// ponytail: skipRanges reference asset source-time (not timeline). trimRegions
// in v2 are the inverse — a skip = the region inside the source we DON'T keep.
export const skipRangeSchema = z
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

export const timelineSchema = z.object({
	clips: z.array(clipSchema).default([]),
	gaps: z.array(gapSchema).default([]),
	skipRanges: z.array(skipRangeSchema).default([]),
	muteRanges: z.array(rangeSchema).default([]),
	speedRanges: z.array(rangeSchema).default([]),
	captionRanges: z.array(rangeSchema).default([]),
});

export const pendingQuestionSchema = z.object({
	id: z.string().min(1),
	question: z.string().min(1),
	reason: z.string().default(""),
	startWordId: z.string().optional(),
	endWordId: z.string().optional(),
});

export const previewSchema = z.object({
	strategy: z.enum(["seek", "mse-proxy"]).default("seek"),
	revision: z.number().int().nonnegative().default(0),
});

export const exportStateSchema = z.object({
	preset: z.enum(["preview-low", "final-balanced", "final-high"]).default("final-balanced"),
	lastJobId: z.string().nullable().default(null),
});

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
		type: z.literal("add_skip_range"),
		reason: z.string().default(""),
		assetId: z.string().min(1),
		startSec: z.number().nonnegative(),
		endSec: z.number().nonnegative(),
	}),
	z.object({
		type: z.literal("update_skip_range"),
		reason: z.string().default(""),
		skipRangeId: z.string().min(1),
		startSec: z.number().nonnegative(),
		endSec: z.number().nonnegative(),
	}),
	z.object({
		type: z.literal("remove_skip_range"),
		reason: z.string().default(""),
		skipRangeId: z.string().min(1),
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

export const suggestionSchema = z.object({
	id: z.string().min(1),
	status: z.enum(["pending", "approved", "rejected"]).default("pending"),
	category: z
		.enum(["cut_candidate", "style", "delivery", "topic_focus", "clarification"])
		.default("cut_candidate"),
	suggestion: z.string().min(1),
	reason: z.string().default(""),
	startWordId: z.string().optional(),
	endWordId: z.string().optional(),
	startSec: z.number().nonnegative().optional(),
	endSec: z.number().nonnegative().optional(),
	proposedOperation: timelineOperationSchema.optional(),
});

export const agentStateSchema = z.object({
	baseIntent: z.string().optional(),
	pendingQuestions: z.array(pendingQuestionSchema).default([]),
	suggestions: z.array(suggestionSchema).default([]),
	lastAppliedOperations: z.array(z.string()).default([]),
	lastReasoningSummary: z.string().optional(),
});

export const operationSchema = z.discriminatedUnion("type", [
	...timelineOperationSchema.options,
	z.object({
		type: z.literal("approve_suggestion"),
		reason: z.string().default(""),
		suggestionId: z.string().min(1),
	}),
	z.object({
		type: z.literal("reject_suggestion"),
		reason: z.string().default(""),
		suggestionId: z.string().min(1),
	}),
]);

export const revisionSchema = z.object({
	id: z.string().min(1),
	createdAt: isoDateSchema,
	author: z.enum(["system", "agent", "user"]),
	summary: z.string().min(1),
	operations: z.array(operationSchema).default([]),
});

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

export const annotationRegionSchema = z
	.object({
		id: z.string().min(1),
		startMs: z.number().nonnegative(),
		endMs: z.number().nonnegative(),
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
// by the existing pipeline (see docs/architecture/ai-edition-roadmap.md §2).
//
// ponytail: passthrough blob — v2 ProjectEditorState carries ~25 fields, several
// of which (autoZoomEnabled, autoFocusAll, cursorTheme, …) have no first-class
// home yet. Phase 1 timeline rewrite + Phase 9 settings sync will tighten this.
// Round-trip through the migration must be lossless for now.
export const legacyEditorSchema = z.object({}).passthrough().nullable().default(null);

// ponytail: the webcam is a derived stream — it is NOT edited. Cut / zoom /
// speed live on the main timeline and apply to the camera as a render of the
// same source-time progression. Source path comes from the recording
// session sidecar (auto-linked when an asset is imported from a recording).
// `offsetMs` accounts for the camera starting before/after the screen.
export const cameraTrackSchema = z
	.object({
		sourcePath: z.string().min(1),
		startMs: z.number().nonnegative().default(0),
		offsetMs: z.number().int().default(0),
		visible: z.boolean().default(true),
	})
	.nullable()
	.default(null);

export const documentSchema = z.object({
	schemaVersion: z.literal(axcutSchemaVersion),
	project: z.object({
		id: z.string().min(1),
		title: z.string().min(1),
		createdAt: isoDateSchema,
		updatedAt: isoDateSchema,
		primaryAssetId: z.string().optional(),
	}),
	assets: z.array(assetSchema).default([]),
	cameraTrack: cameraTrackSchema,
	transcript: transcriptSchema.nullable().default(null),
	transcripts: z.array(transcriptSchema).default([]),
	timeline: timelineSchema.default({
		clips: [],
		gaps: [],
		skipRanges: [],
		muteRanges: [],
		speedRanges: [],
		captionRanges: [],
	}),
	annotations: z.array(annotationRegionSchema).default([]),
	zoomRanges: z.array(zoomRegionSchema).default([]),
	legacyEditor: legacyEditorSchema.nullable().default(null),
	agent: agentStateSchema.default({
		pendingQuestions: [],
		suggestions: [],
		lastAppliedOperations: [],
	}),
	preview: previewSchema.default({ strategy: "seek", revision: 0 }),
	export: exportStateSchema.default({ preset: "final-balanced", lastJobId: null }),
	history: z
		.object({
			revisions: z.array(revisionSchema).default([]),
		})
		.default({ revisions: [] }),
});

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

export const transcribeInputSchema = z.object({
	language: transcriptLanguageSchema.default("auto"),
});

export const exportInputSchema = z.object({
	preset: exportStateSchema.shape.preset.default("final-balanced"),
});

export const applyOperationInputSchema = z.object({
	operation: operationSchema,
	sessionId: z.string().min(1).optional(),
	conversationMessage: z.string().min(1).optional(),
});

export type AxcutWord = z.infer<typeof wordSchema>;
export type AxcutTranscriptSegment = z.infer<typeof transcriptSegmentSchema>;
export type AxcutTranscript = z.infer<typeof transcriptSchema>;
export type AxcutAsset = z.infer<typeof assetSchema>;
export type AxcutClip = z.infer<typeof clipSchema>;
export type AxcutGap = z.infer<typeof gapSchema>;
export type AxcutSkipRange = z.infer<typeof skipRangeSchema>;
export type AxcutTimeline = z.infer<typeof timelineSchema>;
export type AxcutSuggestion = z.infer<typeof suggestionSchema>;
export type AxcutAgentState = z.infer<typeof agentStateSchema>;
export type AxcutTimelineOperation = z.infer<typeof timelineOperationSchema>;
export type AxcutOperation = z.infer<typeof operationSchema>;
export type AxcutRevision = z.infer<typeof revisionSchema>;
export type AxcutAnnotationRegion = z.infer<typeof annotationRegionSchema>;
export type AxcutZoomRegion = z.infer<typeof zoomRegionSchema>;
export type AxcutCameraTrack = z.infer<typeof cameraTrackSchema>;
export type AxcutLegacyEditor = z.infer<typeof legacyEditorSchema>;
export type AxcutDocument = z.infer<typeof documentSchema>;
export type AxcutDocumentInput = z.input<typeof documentSchema>;
export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;
export type AddAssetInput = z.infer<typeof addAssetInputSchema>;
export type ChatInput = z.infer<typeof chatInputSchema>;
export type TranscribeInput = z.infer<typeof transcribeInputSchema>;
export type ExportInput = z.infer<typeof exportInputSchema>;
export type ApplyOperationInput = z.infer<typeof applyOperationInputSchema>;

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
		cameraTrack: null,
		transcript: null,
		transcripts: [],
		timeline: {
			clips: [],
			gaps: [],
			skipRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		annotations: [],
		zoomRanges: [],
		legacyEditor: null,
		agent: { pendingQuestions: [], suggestions: [], lastAppliedOperations: [] },
		preview: { strategy: "seek", revision: 0 },
		export: { preset: "final-balanced", lastJobId: null },
		history: { revisions: [] },
	});
}

export function ensureDocument(value: unknown): AxcutDocument {
	return documentSchema.parse(value);
}
