// Adapter: feeds an AxcutDocument into the existing VideoExporter / GifExporter
// by mapping document fields → VideoExporterConfig. No rewrite of the export
// pipeline — the existing FrameRenderer + StreamingVideoDecoder + muxer handle
// all the rendering (annotations, zoom, blur, webcam, cursor).
//
// ponytail: the existing exporter accepts trimRegions (removed spans in source
// time). Two contributors are merged into them (see computeExportTrimRegions):
// the inverse of the kept clip ranges (clip in/out) AND the DSL `trimRanges`
// (mid-clip trims — previously dropped from the render). We also pull
// zoom/annotations from the document (ms units, same as legacy) and
// appearance/cursor/webcam from legacyEditor (passthrough blob). The webcam
// file path lives on the primary asset's cameraTrack (P4 — per-asset, since a
// project can hold multiple recordings; export only ever handles the primary
// asset today, so no per-clip camera stitching is needed here).

import { toFileUrl } from "@/components/video-editor/projectPersistence";
import {
	type AnnotationRegion,
	type CameraFullscreenRegion,
	type CropRegion,
	type SpeedRegion,
	type TrimRegion,
	type ZoomRegion,
} from "@/components/video-editor/types";
import {
	type CropScheduleEntry,
	type ExportFormat,
	type ExportQuality,
	GifExporter,
	type GifFrameRate,
	type GifSizePreset,
	VideoExporter,
} from "@/lib/exporter";
import { calculateMp4ExportSettings } from "@/lib/exporter/mp4ExportSettings";
import type { ExportProgress } from "@/lib/exporter/types";
import type { CursorRecordingData, CursorTelemetryPoint } from "@/native/contracts";
import {
	type AspectRatio,
	getAspectRatioValue,
	getNativeAspectRatioValue,
} from "@/utils/aspectRatioUtils";
import { createId } from "../document/ids";
import { type Interval, normalizeIntervals, primaryAssetDuration } from "../document/timeline";
import type { AxcutDocument } from "../schema";
import { projectRegionsToSourceTime } from "../timeline/region-ventilation";

export type ExportVideoCodec = "h264" | "h265" | "vp9";

// WebCodecs encoder strings per user-facing codec choice (F2.4). The muxer
// derives its mp4 track family from the same string.
const CODEC_STRINGS: Record<ExportVideoCodec, string> = {
	h264: "avc1.640033",
	h265: "hvc1.1.6.L120.90",
	vp9: "vp09.00.10.08",
};

export interface DocumentExportOptions {
	quality: ExportQuality;
	format: ExportFormat;
	frameRate?: number;
	codec?: ExportVideoCodec;
	gifFrameRate?: GifFrameRate;
	gifLoop?: boolean;
	gifSizePreset?: GifSizePreset;
	sourceWidth?: number;
	sourceHeight?: number;
	webcamVideoUrl?: string;
	cursorRecordingData?: CursorRecordingData | null;
	cursorTelemetry?: CursorTelemetryPoint[];
	cursorClickTimestamps?: number[];
	cursorScale?: number;
	cursorSmoothing?: number;
	cursorMotionBlur?: number;
	cursorClickBounce?: number;
	cursorClipToBounds?: boolean;
	previewWidth?: number;
	previewHeight?: number;
	onProgress?: (progress: ExportProgress) => void;
}

// The source-time spans the exporter must CUT. Two independent contributors,
// merged so both reach the render (this is the fix for trims being silently
// dropped from the export — the preview + aggregated transcript already applied
// them):
//   1. Clip in/out: everything OUTSIDE the kept clip source ranges (head/tail
//      trimming + gaps between clips).
//   2. Trims: the DSL `trimRanges` — removals INSIDE a clip that don't split it.
export function computeExportTrimRegions(
	sourceDurationSec: number,
	clips: AxcutDocument["timeline"]["clips"],
	trimRanges: AxcutDocument["timeline"]["trimRanges"],
	primaryAssetId: string,
): TrimRegion[] {
	// Kept source ranges = clip in/out points, clamped to the real source
	// duration and merged. (Computed directly, not via timelineIntervals + a
	// fake empty-asset document, whose primaryAssetDuration would be 0 and
	// clamp every kept interval away.)
	const keptIntervals = normalizeIntervals(
		sourceDurationSec,
		clips.map((c) => ({ startSec: c.sourceStartSec, endSec: c.sourceEndSec ?? sourceDurationSec })),
	);

	// Cuts from clip in/out = the complement of the kept intervals over [0, dur].
	const cuts: Interval[] = [];
	let cursor = 0;
	for (const interval of keptIntervals) {
		if (interval.startSec > cursor) cuts.push({ startSec: cursor, endSec: interval.startSec });
		cursor = Math.max(cursor, interval.endSec);
	}
	if (cursor < sourceDurationSec) cuts.push({ startSec: cursor, endSec: sourceDurationSec });

	// Cuts from trims (primary asset, source time).
	for (const trim of trimRanges) {
		if (trim.assetId === primaryAssetId)
			cuts.push({ startSec: trim.startSec, endSec: trim.endSec });
	}

	// Merge/normalize so overlapping clip-gap + trim cuts collapse cleanly.
	return normalizeIntervals(sourceDurationSec, cuts).map((iv, i) => ({
		id: `trim_${i + 1}`,
		startMs: Math.round(iv.startSec * 1000),
		endMs: Math.round(iv.endSec * 1000),
	}));
}

const IDENTITY_CROP: CropRegion = { x: 0, y: 0, width: 1, height: 1 };

// Crop is per-clip (clipSchema.cropRegion), applied clip-by-clip — not
// per-frame interpolation. The export renderer switches to whichever entry's
// [startSec, endSec) covers the current frame's SOURCE time right before
// rendering it (see VideoExporter/GifExporter + FrameRenderer.setCropRegion).
// Only clips on `primaryAssetId` matter here — export renders one continuous
// source video (the primary asset), so a clip pointing at a different asset
// has no meaningful source-time range against this one.
export function computeCropSchedule(
	clips: AxcutDocument["timeline"]["clips"],
	sourceDurationSec: number,
	primaryAssetId: string,
): CropScheduleEntry[] {
	return clips
		.filter((c) => c.assetId === primaryAssetId)
		.map((c) => ({
			startSec: c.sourceStartSec,
			endSec: c.sourceEndSec ?? sourceDurationSec,
			cropRegion: c.cropRegion ?? IDENTITY_CROP,
		}));
}

function extractLegacyField<T>(
	legacy: Record<string, unknown> | null,
	key: string,
	fallback: T,
): T {
	if (legacy && typeof legacy[key] === typeof fallback) {
		return legacy[key] as T;
	}
	return fallback;
}

export async function exportAxcutDocument(
	document: AxcutDocument,
	options: DocumentExportOptions,
): Promise<ExportResult> {
	const asset =
		document.assets.find((a) => a.id === document.project.primaryAssetId) ?? document.assets[0];
	if (!asset) {
		return { success: false, error: "No asset to export." };
	}

	const videoUrl = toFileUrl(asset.originalPath);
	const sourceDurationSec = asset.durationSec ?? primaryAssetDuration(document);
	const trimRegions = computeExportTrimRegions(
		sourceDurationSec,
		document.timeline.clips,
		document.timeline.trimRanges,
		asset.id,
	);
	// Effects are authored in virtual (edited-timeline) time, but the export
	// frame loop matches them against each frame's *source* time — so project
	// them onto source ranges through the clips they cover (clip in/out + order),
	// splitting any region that straddles a clip boundary. This is what makes a
	// multi-clip export's zooms/annotations/speed land on the same frames as the
	// preview. Identity single-clip projects are unchanged (source == virtual).
	const clips = document.timeline.clips;
	const zoomRegions = projectRegionsToSourceTime(
		document.zoomRanges as unknown as ZoomRegion[],
		clips,
		() => createId("zoom"),
	);
	const annotationRegions = projectRegionsToSourceTime(
		document.annotations as unknown as AnnotationRegion[],
		clips,
		() => createId("ann"),
	);
	const legacy = document.legacyEditor as Record<string, unknown> | null;

	const wallpaper = extractLegacyField(legacy, "wallpaper", "");
	const shadowIntensity = extractLegacyField(legacy, "shadowIntensity", 0);
	const showBlur = extractLegacyField(legacy, "showBlur", false);
	const motionBlurAmount = extractLegacyField(legacy, "motionBlurAmount", 0);
	const borderRadius = extractLegacyField(legacy, "borderRadius", 0);
	const padding = extractLegacyField(legacy, "padding", 50);
	const cropSchedule = computeCropSchedule(clips, sourceDurationSec, asset.id);
	const cropRegion: CropRegion = IDENTITY_CROP;
	const webcamLayoutPreset = extractLegacyField(legacy, "webcamLayoutPreset", "picture-in-picture");
	const webcamMaskShape = extractLegacyField(legacy, "webcamMaskShape", "rectangle");
	const webcamMirrored = extractLegacyField(legacy, "webcamMirrored", false);
	const webcamReactiveZoom = extractLegacyField(legacy, "webcamReactiveZoom", true);
	const webcamSizePreset = extractLegacyField(legacy, "webcamSizePreset", 25);
	const webcamPosition = extractLegacyField(legacy, "webcamPosition", null);
	const cursorTheme = extractLegacyField(legacy, "cursorTheme", "");
	const speedRegions: SpeedRegion[] = projectRegionsToSourceTime(
		extractLegacyField<SpeedRegion[]>(legacy, "speedRegions", []),
		clips,
		() => createId("speed"),
	);
	const cameraFullscreenRegions: CameraFullscreenRegion[] = projectRegionsToSourceTime(
		extractLegacyField<CameraFullscreenRegion[]>(legacy, "cameraFullscreenRegions", []),
		clips,
		() => createId("camfull"),
	);

	const sourceWidth = options.sourceWidth || 1920;
	const sourceHeight = options.sourceHeight || 1080;
	// Respect the timeline's selected aspect ratio (the whole-canvas framing set
	// in the editor), not a hardcoded 16:9. "native" follows the source's own
	// pixel aspect. This is a per-timeline choice, not per-clip.
	const aspectRatio = extractLegacyField<AspectRatio>(legacy, "aspectRatio", "16:9");
	const aspectRatioValue =
		aspectRatio === "native"
			? getNativeAspectRatioValue(sourceWidth, sourceHeight)
			: getAspectRatioValue(aspectRatio);

	const settings = calculateMp4ExportSettings({
		quality: options.quality,
		sourceWidth,
		sourceHeight,
		aspectRatioValue,
	});

	const cameraTrack = asset.cameraTrack;

	const commonConfig = {
		videoUrl,
		// ponytail: the camera is a derived stream from cameraTrack; the legacy
		// exporter accepts webcamVideoUrl as a visual-only second source.
		webcamVideoUrl:
			cameraTrack && cameraTrack.visible && cameraTrack.sourcePath
				? toFileUrl(cameraTrack.sourcePath)
				: options.webcamVideoUrl,
		wallpaper,
		zoomRegions,
		trimRegions,
		speedRegions,
		cameraFullscreenRegions,
		showShadow: shadowIntensity > 0,
		shadowIntensity,
		showBlur,
		motionBlurAmount,
		borderRadius,
		padding,
		cropRegion,
		cropSchedule,
		annotationRegions,
		webcamLayoutPreset: webcamLayoutPreset as
			| "picture-in-picture"
			| "no-webcam"
			| "vertical-stack"
			| "dual-frame",
		webcamMaskShape: webcamMaskShape as "rectangle" | "circle" | "square" | "rounded",
		webcamMirrored,
		webcamReactiveZoom,
		webcamSizePreset,
		webcamPosition,
		cursorRecordingData: options.cursorRecordingData ?? null,
		cursorScale: options.cursorScale ?? 0,
		cursorSmoothing: options.cursorSmoothing,
		cursorMotionBlur: options.cursorMotionBlur,
		cursorClickBounce: options.cursorClickBounce,
		cursorClipToBounds: options.cursorClipToBounds,
		cursorTheme,
		cursorTelemetry: options.cursorTelemetry,
		cursorClickTimestamps: options.cursorClickTimestamps,
		previewWidth: options.previewWidth,
		previewHeight: options.previewHeight,
		onProgress: options.onProgress,
	};

	if (options.format === "gif") {
		const exporter = new GifExporter({
			...commonConfig,
			width: 1280,
			height: 720,
			frameRate: options.gifFrameRate ?? 15,
			loop: options.gifLoop ?? true,
			sizePreset: options.gifSizePreset ?? "medium",
		} as unknown as ConstructorParameters<typeof GifExporter>[0]);
		return exporter.export();
	}

	const exporter = new VideoExporter({
		...commonConfig,
		width: settings.width,
		height: settings.height,
		frameRate: options.frameRate ?? 60,
		bitrate: settings.bitrate,
		codec: CODEC_STRINGS[options.codec ?? "h264"],
	});
	return exporter.export();
}

import type { ExportResult } from "@/lib/exporter/types";
