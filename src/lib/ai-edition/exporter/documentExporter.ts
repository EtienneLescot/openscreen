// Adapter: feeds an AxcutDocument into the existing VideoExporter / GifExporter
// by mapping document fields → VideoExporterConfig. No rewrite of the export
// pipeline — the existing FrameRenderer + StreamingVideoDecoder + muxer handle
// all the rendering (annotations, zoom, blur, webcam, cursor).
//
// ponytail: the existing exporter already accepts trimRegions (gaps in source
// time). Clips define what to KEEP. The inverse of clips = trimRegions. We
// also pull zoom/annotations from the document (ms units, same as legacy) and
// appearance/cursor/webcam from legacyEditor (passthrough blob). The webcam
// file path lives on the primary asset's cameraTrack (P4 — per-asset, since a
// project can hold multiple recordings; export only ever handles the primary
// asset today, so no per-clip camera stitching is needed here).

import { toFileUrl } from "@/components/video-editor/projectPersistence";
import {
	type AnnotationRegion,
	type CropRegion,
	type SpeedRegion,
	type TrimRegion,
	type ZoomRegion,
} from "@/components/video-editor/types";
import {
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
import { primaryAssetDuration, timelineIntervals } from "../document/timeline";
import type { AxcutDocument } from "../schema";

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

function clipsToTrimRanges(
	sourceDurationSec: number,
	clips: AxcutDocument["timeline"]["clips"],
): TrimRegion[] {
	const intervals = timelineIntervals({
		...({} as AxcutDocument),
		timeline: {
			clips,
			gaps: [],
			skipRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		assets: [],
		project: { primaryAssetId: "" },
	} as unknown as AxcutDocument);
	const trims: TrimRegion[] = [];
	let cursor = 0;
	for (const interval of intervals) {
		if (interval.startSec > cursor) {
			trims.push({
				id: `trim_${trims.length + 1}`,
				startMs: Math.round(cursor * 1000),
				endMs: Math.round(interval.startSec * 1000),
			});
		}
		cursor = Math.max(cursor, interval.endSec);
	}
	if (cursor < sourceDurationSec) {
		trims.push({
			id: `trim_${trims.length + 1}`,
			startMs: Math.round(cursor * 1000),
			endMs: Math.round(sourceDurationSec * 1000),
		});
	}
	return trims;
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
	const trimRegions = clipsToTrimRanges(sourceDurationSec, document.timeline.clips);
	const zoomRegions: ZoomRegion[] = document.zoomRanges as unknown as ZoomRegion[];
	const annotationRegions: AnnotationRegion[] =
		document.annotations as unknown as AnnotationRegion[];
	const legacy = document.legacyEditor as Record<string, unknown> | null;

	const wallpaper = extractLegacyField(legacy, "wallpaper", "");
	const shadowIntensity = extractLegacyField(legacy, "shadowIntensity", 0);
	const showBlur = extractLegacyField(legacy, "showBlur", false);
	const motionBlurAmount = extractLegacyField(legacy, "motionBlurAmount", 0);
	const borderRadius = extractLegacyField(legacy, "borderRadius", 0);
	const padding = extractLegacyField(legacy, "padding", 50);
	const cropRegion = extractLegacyField<CropRegion>(legacy, "cropRegion", {
		x: 0,
		y: 0,
		width: 1,
		height: 1,
	});
	const webcamLayoutPreset = extractLegacyField(legacy, "webcamLayoutPreset", "picture-in-picture");
	const webcamMaskShape = extractLegacyField(legacy, "webcamMaskShape", "rectangle");
	const webcamMirrored = extractLegacyField(legacy, "webcamMirrored", false);
	const webcamReactiveZoom = extractLegacyField(legacy, "webcamReactiveZoom", true);
	const webcamSizePreset = extractLegacyField(legacy, "webcamSizePreset", 25);
	const webcamPosition = extractLegacyField(legacy, "webcamPosition", null);
	const cursorTheme = extractLegacyField(legacy, "cursorTheme", "");
	const speedRegions: SpeedRegion[] = extractLegacyField(legacy, "speedRegions", []);

	const sourceWidth = options.sourceWidth || 1920;
	const sourceHeight = options.sourceHeight || 1080;
	const aspectRatioValue = 16 / 9;

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
		showShadow: shadowIntensity > 0,
		shadowIntensity,
		showBlur,
		motionBlurAmount,
		borderRadius,
		padding,
		cropRegion,
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
