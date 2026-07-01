// Bidirectional migration between OpenScreen's v2 EditorProjectData and the
// new v3 AxcutDocument. See docs/architecture/ai-edition-roadmap.md §2
// for the field-by-field mapping. The migration is pure (no DOM, no fs, no
// network) — the renderer probes asset duration at runtime.
//
// ponytail: this is the only code path that produces v3 documents today. Phase 1
// adds direct v3 writers (recording -> asset + clip) and the migration becomes
// the back-compat reader. Until then it is the front door for AI-edition.

import {
	type EditorProjectData,
	PROJECT_VERSION,
	type ProjectEditorState,
} from "@/components/video-editor/projectPersistence";
import type {
	AnnotationRegion,
	CropRegion,
	SpeedRegion,
	TrimRegion,
	ZoomRegion,
} from "@/components/video-editor/types";
import type { ProjectMedia } from "@/lib/recordingSession";
import {
	type AxcutAnnotationRegion,
	type AxcutDocument,
	type AxcutLegacyEditor,
	type AxcutSkipRange,
	type AxcutZoomRegion,
	documentSchema,
} from "../schema";
import { createId } from "./ids";

const MS_TO_SEC = 1 / 1000;
const SEC_TO_MS = 1000;

interface MigrationOptions {
	projectId?: string;
	title?: string;
	createdAt?: string;
}

function msToSec(ms: number): number {
	return Math.round(ms * MS_TO_SEC * 1000) / 1000;
}

function secToMs(sec: number): number {
	return Math.round(sec * SEC_TO_MS);
}

function clampSec(sec: number): number {
	if (!Number.isFinite(sec) || sec < 0) return 0;
	return Math.round(sec * 1000) / 1000;
}

function toLegacyMedia(input: ProjectMedia | undefined): ProjectMedia | null {
	if (!input) return null;
	const media: ProjectMedia = { screenVideoPath: input.screenVideoPath };
	if (input.webcamVideoPath) media.webcamVideoPath = input.webcamVideoPath;
	if (input.cursorCaptureMode) media.cursorCaptureMode = input.cursorCaptureMode;
	return media;
}

/**
 * Migrate a v2 EditorProjectData into a v3 AxcutDocument. The single recording
 * becomes one asset + one clip spanning the source. trimRegions become
 * skipRanges on that asset (semantically identical: both are cuts).
 */
export function migrateProjectDataToAxcutDocument(
	input: EditorProjectData,
	options: MigrationOptions = {},
): AxcutDocument {
	const now = options.createdAt ?? new Date().toISOString();
	const projectId = options.projectId ?? createId("proj");
	const title = options.title ?? (input.editor?.wallpaper?.trim() || "Untitled Project");

	const screenPath =
		typeof input.media?.screenVideoPath === "string" && input.media.screenVideoPath
			? input.media.screenVideoPath
			: typeof input.videoPath === "string" && input.videoPath
				? input.videoPath
				: null;

	const assets = screenPath
		? [
				{
					id: createId("asset"),
					kind: "video" as const,
					label: screenPath.split(/[\\/]/).pop() || "Recording",
					originalPath: screenPath,
				},
			]
		: [];

	const primaryAssetId = assets[0]?.id;

	const trimRegions: TrimRegion[] = Array.isArray(input.editor?.trimRegions)
		? input.editor.trimRegions
		: [];
	const speedRegions: SpeedRegion[] = Array.isArray(input.editor?.speedRegions)
		? input.editor.speedRegions
		: [];
	const zoomRegions: ZoomRegion[] = Array.isArray(input.editor?.zoomRegions)
		? input.editor.zoomRegions
		: [];
	const annotationRegions: AnnotationRegion[] = Array.isArray(input.editor?.annotationRegions)
		? input.editor.annotationRegions
		: [];

	const clip = primaryAssetId
		? {
				id: createId("clip"),
				assetId: primaryAssetId,
				sourceStartSec: 0,
				timelineStartSec: 0,
				timelineEndSec: 0,
				wordRefs: [] as string[],
				origin: "system" as const,
				reason: "migrated from v2",
			}
		: null;

	const skipRanges: AxcutSkipRange[] = primaryAssetId
		? trimRegions
				.filter((region) => region && typeof region.id === "string")
				.map((region) => {
					const startMs = Math.max(0, Math.min(region.startMs ?? 0, region.endMs ?? 0));
					const endMs = Math.max(startMs + 1, region.endMs ?? startMs + 1);
					return {
						id: createId("skip"),
						assetId: primaryAssetId,
						startSec: clampSec(msToSec(startMs)),
						endSec: clampSec(msToSec(endMs)),
						origin: "user" as const,
						reason: "migrated from v2 trimRegion",
					};
				})
		: [];

	// ponytail: speedRegions stay on the legacy editor envelope — axcut's
	// rangeSchema doesn't carry a speed value, and Phase 1 timeline rewrite is
	// when speed becomes a first-class timeline concept.
	const speedRanges = speedRegions.map((region) => ({
		startSec: clampSec(msToSec(Math.max(0, region.startMs ?? 0))),
		endSec: clampSec(msToSec(Math.max((region.startMs ?? 0) + 1, region.endMs ?? 0))),
		reason: "migrated from v2 speedRegion",
	}));

	// ponytail: annotations[] and zoomRanges[] mirror editor.annotationRegions
	// and editor.zoomRegions directly (same ms units) so the renderer can swap
	// them in/out without conversion. The timeline (skipRanges, speedRanges,
	// clip) uses axcut's seconds because the new timeline ops land there.
	const migratedZoomRanges: AxcutZoomRegion[] = zoomRegions
		.filter((region) => region && typeof region.id === "string")
		.map((region) => ({
			id: region.id,
			startMs: Math.max(0, region.startMs ?? 0),
			endMs: Math.max((region.startMs ?? 0) + 1, region.endMs ?? 0),
			depth: [1, 2, 3, 4, 5, 6].includes(region.depth) ? region.depth : 3,
			focus: {
				cx: Math.min(1, Math.max(0, region.focus?.cx ?? 0.5)),
				cy: Math.min(1, Math.max(0, region.focus?.cy ?? 0.5)),
			},
			...(region.focusMode === "auto" ? { focusMode: "auto" as const } : {}),
			...(region.rotationPreset ? { rotationPreset: region.rotationPreset } : {}),
			...(typeof region.customScale === "number" ? { customScale: region.customScale } : {}),
			...(region.source === "auto" || region.source === "manual" ? { source: region.source } : {}),
		}));

	const migratedAnnotations: AxcutAnnotationRegion[] = annotationRegions
		.filter((region) => region && typeof region.id === "string")
		.map((region) => ({
			id: region.id,
			startMs: Math.max(0, region.startMs ?? 0),
			endMs: Math.max((region.startMs ?? 0) + 1, region.endMs ?? 0),
			type: region.type,
			content: region.content ?? "",
			...(region.textContent ? { textContent: region.textContent } : {}),
			...(region.imageContent ? { imageContent: region.imageContent } : {}),
			position: region.position,
			size: region.size,
			style: region.style,
			zIndex: region.zIndex,
			...(region.annotationSource === "auto-caption"
				? { annotationSource: "auto-caption" as const }
				: {}),
			...(region.figureData ? { figureData: region.figureData } : {}),
			...(region.blurData ? { blurData: region.blurData } : {}),
		}));

	const legacyEditor: AxcutLegacyEditor = input.editor ? { ...input.editor } : null;

	const draft: AxcutDocument = {
		schemaVersion: 3 as const,
		project: {
			id: projectId,
			title,
			createdAt: now,
			updatedAt: now,
			...(primaryAssetId ? { primaryAssetId } : {}),
		},
		assets,
		cameraTrack: null,
		transcript: null,
		transcripts: [],
		timeline: {
			clips: clip ? [clip] : [],
			gaps: [],
			skipRanges,
			muteRanges: [],
			speedRanges,
			captionRanges: [],
		},
		annotations: migratedAnnotations,
		zoomRanges: migratedZoomRanges,
		legacyEditor,
		agent: {
			pendingQuestions: [],
			suggestions: [],
			lastAppliedOperations: [],
		},
		preview: { strategy: "seek", revision: 0 },
		export: { preset: "final-balanced", lastJobId: null },
		history: { revisions: [] },
	};

	return documentSchema.parse(draft);
}

/**
 * Migrate a v3 AxcutDocument back to a v2 EditorProjectData. Used when the
 * user toggles AI-edition off after a project was opened as v3. Round-trip is
 * not perfectly lossless — skipRanges map back to trimRegions (1:1), but the
 * timeline rebuild for clip ranges is best-effort and the speed regions remain
 * in the legacyEditor envelope where the migration put them.
 */
export function migrateAxcutDocumentToProjectData(input: AxcutDocument): EditorProjectData {
	const document = input;
	const assets = Array.isArray(document.assets) ? document.assets : [];
	const primary = document.project?.primaryAssetId
		? assets.find((a) => a.id === document.project.primaryAssetId)
		: assets[0];
	// ponytail: surface the camera track back to v2 so the legacy VideoEditor
	// can still find the webcam path through `media.webcamVideoPath`.
	const media: ProjectMedia | null = primary
		? toLegacyMedia({
				screenVideoPath: primary.originalPath,
				...(document.cameraTrack?.sourcePath
					? { webcamVideoPath: document.cameraTrack.sourcePath }
					: {}),
			})
		: null;

	const trimRegions: TrimRegion[] = (document.timeline?.skipRanges ?? []).map((region, index) => ({
		id: region.id ?? `trim-${index + 1}`,
		startMs: secToMs(clampSec(region.startSec ?? 0)),
		endMs: secToMs(Math.max(clampSec(region.startSec ?? 0) + 0.001, clampSec(region.endSec ?? 0))),
	}));

	const editor: ProjectEditorState = {
		wallpaper: "",
		shadowIntensity: 0,
		showBlur: false,
		showTrimWaveform: true,
		motionBlurAmount: 0,
		borderRadius: 0,
		padding: 50,
		cropRegion: { x: 0, y: 0, width: 1, height: 1 } as CropRegion,
		zoomRegions: [],
		autoZoomEnabled: false,
		autoFocusAll: false,
		trimRegions,
		speedRegions: [],
		annotationRegions: [],
		aspectRatio: "16:9",
		webcamLayoutPreset: "picture-in-picture",
		webcamMaskShape: "rectangle",
		webcamMirrored: false,
		webcamReactiveZoom: true,
		webcamSizePreset: 25,
		webcamPosition: null,
		exportQuality: "good",
		exportFormat: "mp4",
		gifFrameRate: 15,
		gifLoop: true,
		gifSizePreset: "medium",
		cursorTheme: "",
	};

	const legacy = document.legacyEditor;
	if (legacy && typeof legacy === "object") {
		Object.assign(editor, legacy);
	}

	const reverseZoomRegions: ZoomRegion[] = (document.zoomRanges ?? []).map((region) => ({
		id: region.id,
		startMs: region.startMs ?? 0,
		endMs: region.endMs ?? region.startMs ?? 0,
		depth: region.depth,
		focus: region.focus,
		...(region.focusMode ? { focusMode: region.focusMode } : {}),
		...(region.rotationPreset ? { rotationPreset: region.rotationPreset } : {}),
		...(typeof region.customScale === "number" ? { customScale: region.customScale } : {}),
		...(region.source ? { source: region.source } : {}),
	}));
	editor.zoomRegions = reverseZoomRegions;

	const reverseAnnotationRegions: AnnotationRegion[] = (document.annotations ?? []).map(
		(region) => ({
			id: region.id,
			startMs: region.startMs ?? 0,
			endMs: region.endMs ?? region.startMs ?? 0,
			type: region.type,
			content: region.content,
			...(region.textContent ? { textContent: region.textContent } : {}),
			...(region.imageContent ? { imageContent: region.imageContent } : {}),
			position: region.position,
			size: region.size,
			style: region.style,
			zIndex: region.zIndex,
			...(region.annotationSource ? { annotationSource: region.annotationSource } : {}),
			...(region.figureData ? { figureData: region.figureData } : {}),
			...(region.blurData ? { blurData: region.blurData } : {}),
		}),
	);
	editor.annotationRegions = reverseAnnotationRegions;

	return {
		version: PROJECT_VERSION,
		...(media ? { media } : {}),
		editor,
		...(primary ? { videoPath: primary.originalPath } : {}),
	};
}
