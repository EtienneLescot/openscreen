// Hidden-window runner for `openscreen export`. Loads an .openscreen project,
// rebuilds the same exporter configuration the editor's export dialog would,
// and streams progress back to the CLI controller in the main process.

import { useEffect, useRef, useState } from "react";
import {
	DEFAULT_CURSOR_SETTINGS,
	DEFAULT_SOURCE_DIMENSIONS,
} from "@/components/video-editor/editorDefaults";
import {
	normalizeProjectEditor,
	resolveProjectMedia,
	toFileUrl,
	validateProjectData,
} from "@/components/video-editor/projectPersistence";
import { buildAutoZoomSuggestions } from "@/components/video-editor/timeline/zoomSuggestionUtils";
import type { CursorTelemetryPoint, ZoomRegion } from "@/components/video-editor/types";
import {
	clampFocusToDepth,
	DEFAULT_ZOOM_DEPTH,
	ZOOM_DEPTH_SCALES,
} from "@/components/video-editor/types";
import type { CliDoneResult, CliExportRequest } from "@/lib/cliContracts";
import { hasNativeCursorRecordingData } from "@/lib/cursor/nativeCursor";
import { calculateOutputDimensions, GifExporter } from "@/lib/exporter/gifExporter";
import {
	calculateEffectiveSourceDimensions,
	calculateMp4ExportSettings,
} from "@/lib/exporter/mp4ExportSettings";
import type { ExportProgress } from "@/lib/exporter/types";
import { GIF_SIZE_PRESETS } from "@/lib/exporter/types";
import { VideoExporter } from "@/lib/exporter/videoExporter";
import { mixVoiceoverIntoVideo } from "@/lib/exporter/voiceoverMix";
import type { FocusRecordingData } from "@/lib/windowFocus/contracts";
import { FOCUS_SIDECAR_SUFFIX } from "@/lib/windowFocus/contracts";
import { focusTelemetryToZoomRegions } from "@/lib/windowFocus/focusToZoomRegions";
import { nativeBridgeClient } from "@/native";
import type { CursorRecordingData, NativePlatform } from "@/native/contracts";
import { getAspectRatioValue, getNativeAspectRatioValue } from "@/utils/aspectRatioUtils";

// Mirrors the private helper in VideoEditor.tsx.
function isClickInteractionType(interactionType: string | null | undefined) {
	return (
		interactionType === "click" ||
		interactionType === "double-click" ||
		interactionType === "right-click" ||
		interactionType === "middle-click"
	);
}

function probeVideoDimensions(
	url: string,
): Promise<{ width: number; height: number; durationMs: number }> {
	return new Promise((resolve, reject) => {
		const video = document.createElement("video");
		video.preload = "metadata";
		video.muted = true;
		const cleanup = () => {
			clearTimeout(timer);
			video.removeAttribute("src");
			video.load();
		};
		// A stalled load fires neither event; without a deadline the CLI hangs.
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`Timed out reading video metadata: ${url}`));
		}, 30_000);
		video.onloadedmetadata = () => {
			const width = video.videoWidth;
			const height = video.videoHeight;
			const durationMs = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0;
			cleanup();
			resolve({ width, height, durationMs });
		};
		video.onerror = () => {
			cleanup();
			reject(new Error(`Failed to load video metadata: ${url}`));
		};
		video.src = url;
	});
}

/** Fit the composition aspect ratio into the reference preview box, mirroring
 * how the editor sizes its on-screen preview container. */
function fitPreviewBox(aspectRatioValue: number, boxWidth: number, boxHeight: number) {
	let width = boxWidth;
	let height = boxWidth / aspectRatioValue;
	if (height > boxHeight) {
		height = boxHeight;
		width = boxHeight * aspectRatioValue;
	}
	return { width: Math.round(width), height: Math.round(height) };
}

/** Mirrors the editor's buildAutoZoomRegions: cursor-dwell suggestions that
 * follow the cursor (focusMode "auto") and never overlap existing regions. */
function buildAutoZoomRegions(
	cursorTelemetry: CursorTelemetryPoint[],
	totalMs: number,
	existingRegions: ZoomRegion[],
): ZoomRegion[] {
	const suggestions = buildAutoZoomSuggestions({
		cursorTelemetry,
		totalMs,
		existingRegions,
		defaultDurationMs: Math.max(1000, Math.round(totalMs * 0.05)),
	});
	let nextId = 1;
	return suggestions.map((suggestion) => ({
		id: `cli-auto-zoom-${nextId++}`,
		startMs: Math.round(suggestion.span.start),
		endMs: Math.round(suggestion.span.end),
		depth: DEFAULT_ZOOM_DEPTH,
		customScale: ZOOM_DEPTH_SCALES[DEFAULT_ZOOM_DEPTH],
		focus: clampFocusToDepth(suggestion.focus, DEFAULT_ZOOM_DEPTH),
		focusMode: "auto" as const,
		source: "auto" as const,
	}));
}

function replaceExtension(filePath: string, newExtension: string): string {
	return filePath.replace(/\.(openscreen|json)$/i, "") + newExtension;
}

async function runExport(request: CliExportRequest): Promise<CliDoneResult> {
	const loaded = await nativeBridgeClient.project.loadProjectFileFromPath(request.projectPath);
	if (!loaded.success || loaded.project === undefined) {
		throw new Error(loaded.error ?? loaded.message ?? "Failed to load project file");
	}
	if (!validateProjectData(loaded.project)) {
		throw new Error("Project file is not a valid .openscreen project");
	}
	const project = loaded.project;
	const media = resolveProjectMedia(project);
	if (!media) {
		throw new Error("Project file does not reference any recorded media");
	}
	// Prefer the main process's approved session paths: they carry the
	// packed-project sibling fallback when the stored absolute paths are stale.
	try {
		const sessionResult = await window.electronAPI.getCurrentRecordingSession();
		const session = sessionResult?.session;
		if (session?.screenVideoPath) {
			media.screenVideoPath = session.screenVideoPath;
			if (media.webcamVideoPath && session.webcamVideoPath) {
				media.webcamVideoPath = session.webcamVideoPath;
			}
		}
	} catch {
		// Fall back to the paths stored in the project file.
	}
	const editor = normalizeProjectEditor(project.editor ?? {});

	const format = request.format ?? editor.exportFormat;
	if (request.audioPath && format === "gif") {
		throw new Error(
			"--audio is only supported for MP4 exports (this project's stored format is gif; pass --format mp4)",
		);
	}
	const quality = request.quality ?? editor.exportQuality;
	const gifFrameRate = request.gifFrameRate ?? editor.gifFrameRate;
	const gifSizePreset = request.gifSizePreset ?? editor.gifSizePreset;
	const outPath =
		request.outPath ?? replaceExtension(request.projectPath, format === "gif" ? ".gif" : ".mp4");

	const videoUrl = toFileUrl(media.screenVideoPath);
	const webcamVideoUrl = media.webcamVideoPath ? toFileUrl(media.webcamVideoPath) : undefined;

	// Cursor sidecar data (native recordings). Both lookups tolerate missing files.
	let cursorTelemetry: CursorTelemetryPoint[] = [];
	let cursorRecordingData: CursorRecordingData | null = null;
	try {
		cursorTelemetry = await nativeBridgeClient.cursor.getTelemetry(media.screenVideoPath);
	} catch {
		cursorTelemetry = [];
	}
	try {
		cursorRecordingData = await nativeBridgeClient.cursor.getRecordingData(media.screenVideoPath);
	} catch {
		cursorRecordingData = null;
	}

	const recordingClicks =
		cursorRecordingData?.samples
			.filter((sample) => isClickInteractionType(sample.interactionType))
			.map((sample) => sample.timeMs) ?? [];
	const cursorClickTimestamps =
		recordingClicks.length > 0
			? recordingClicks
			: cursorTelemetry
					.filter((sample) => isClickInteractionType(sample.interactionType))
					.map((sample) => sample.timeMs);

	let platform: NativePlatform | null = null;
	try {
		platform = await nativeBridgeClient.system.getPlatform();
	} catch {
		platform = null;
	}
	const hasEditableCursorRecording =
		(media.cursorCaptureMode ?? "editable-overlay") === "editable-overlay" &&
		(platform === "win32" || platform === "darwin") &&
		hasNativeCursorRecordingData(cursorRecordingData);
	const effectiveShowCursor = DEFAULT_CURSOR_SETTINGS.show && hasEditableCursorRecording;

	const probed = await probeVideoDimensions(videoUrl);
	const sourceWidth = probed.width || DEFAULT_SOURCE_DIMENSIONS.width;
	const sourceHeight = probed.height || DEFAULT_SOURCE_DIMENSIONS.height;

	if (request.followWindows) {
		const sidecarPath = `${media.screenVideoPath}${FOCUS_SIDECAR_SUFFIX}`;
		const response = await fetch(toFileUrl(sidecarPath)).catch(() => null);
		if (!response?.ok) {
			throw new Error(
				`--follow-windows needs the focus telemetry sidecar (${sidecarPath}); record with "record --follow-windows"`,
			);
		}
		const focusData = (await response.json()) as FocusRecordingData;
		const followRegions = focusTelemetryToZoomRegions(focusData, {
			totalMs: probed.durationMs,
			existingRegions: editor.zoomRegions,
		});
		if (followRegions.length > 0) {
			editor.zoomRegions = [...editor.zoomRegions, ...followRegions].sort(
				(a, b) => a.startMs - b.startMs,
			);
		}
		window.electronAPI.cliLog(
			"info",
			`Follow-windows: added ${followRegions.length} region(s) from focus telemetry`,
		);
	}

	if (request.autoZoom) {
		const autoRegions = buildAutoZoomRegions(
			cursorTelemetry,
			probed.durationMs,
			editor.zoomRegions,
		);
		if (autoRegions.length > 0) {
			editor.zoomRegions = [...editor.zoomRegions, ...autoRegions];
		}
		window.electronAPI.cliLog(
			"info",
			`Auto-zoom: added ${autoRegions.length} region(s) from cursor telemetry`,
		);
	}
	const effectiveSourceDimensions = calculateEffectiveSourceDimensions(
		sourceWidth,
		sourceHeight,
		editor.cropRegion,
	);
	const aspectRatioValue =
		editor.aspectRatio === "native"
			? getNativeAspectRatioValue(sourceWidth, sourceHeight, editor.cropRegion)
			: getAspectRatioValue(editor.aspectRatio);

	const preview = fitPreviewBox(
		aspectRatioValue,
		request.previewWidth ?? 1280,
		request.previewHeight ?? 720,
	);

	const onProgress = (progress: ExportProgress) => {
		window.electronAPI.cliProgress({
			percentage: progress.percentage,
			currentFrame: progress.currentFrame,
			totalFrames: progress.totalFrames,
			estimatedTimeRemaining: progress.estimatedTimeRemaining,
			phase: progress.phase,
		});
	};

	const sharedConfig = {
		videoUrl,
		webcamVideoUrl,
		wallpaper: editor.wallpaper,
		zoomRegions: editor.zoomRegions,
		cameraFullscreenRegions: editor.cameraFullscreenRegions,
		trimRegions: editor.trimRegions,
		speedRegions: editor.speedRegions,
		showShadow: editor.shadowIntensity > 0,
		shadowIntensity: editor.shadowIntensity,
		showBlur: editor.showBlur,
		motionBlurAmount: editor.motionBlurAmount,
		borderRadius: editor.borderRadius,
		padding: editor.padding,
		cropRegion: editor.cropRegion,
		cursorRecordingData,
		cursorScale: effectiveShowCursor ? DEFAULT_CURSOR_SETTINGS.size : 0,
		cursorSmoothing: DEFAULT_CURSOR_SETTINGS.smoothing,
		cursorMotionBlur: DEFAULT_CURSOR_SETTINGS.motionBlur,
		cursorClickBounce: DEFAULT_CURSOR_SETTINGS.clickBounce,
		cursorClipToBounds: DEFAULT_CURSOR_SETTINGS.clipToBounds,
		cursorTheme: editor.cursorTheme,
		annotationRegions: editor.annotationRegions,
		webcamLayoutPreset: editor.webcamLayoutPreset,
		webcamMaskShape: editor.webcamMaskShape,
		webcamMirrored: editor.webcamMirrored,
		webcamReactiveZoom: editor.webcamReactiveZoom,
		webcamSizePreset: editor.webcamSizePreset,
		webcamPosition: editor.webcamPosition,
		previewWidth: preview.width,
		previewHeight: preview.height,
		cursorTelemetry,
		cursorClickTimestamps,
		onProgress,
	};

	let blob: Blob;
	let warnings: string[] | undefined;
	let outWidth: number;
	let outHeight: number;

	if (format === "gif") {
		const gifDimensions = calculateOutputDimensions(
			effectiveSourceDimensions.width,
			effectiveSourceDimensions.height,
			gifSizePreset,
			GIF_SIZE_PRESETS,
			aspectRatioValue,
		);
		outWidth = gifDimensions.width;
		outHeight = gifDimensions.height;
		const gifExporter = new GifExporter({
			...sharedConfig,
			width: gifDimensions.width,
			height: gifDimensions.height,
			frameRate: gifFrameRate,
			loop: editor.gifLoop,
			sizePreset: gifSizePreset,
			videoPadding: editor.padding,
		});
		const result = await gifExporter.export();
		if (!result.success || !result.blob) {
			throw new Error(result.error ?? "GIF export failed");
		}
		blob = result.blob;
		warnings = result.warnings;
	} else {
		const mp4Settings = calculateMp4ExportSettings({
			quality,
			sourceWidth: effectiveSourceDimensions.width,
			sourceHeight: effectiveSourceDimensions.height,
			aspectRatioValue,
		});
		outWidth = mp4Settings.width;
		outHeight = mp4Settings.height;
		const exporter = new VideoExporter({
			...sharedConfig,
			width: mp4Settings.width,
			height: mp4Settings.height,
			frameRate: 60,
			bitrate: mp4Settings.bitrate,
			codec: "avc1.640033",
		});
		const result = await exporter.export();
		if (!result.success || !result.blob) {
			throw new Error(result.error ?? "MP4 export failed");
		}
		blob = result.blob;
		warnings = result.warnings;
	}

	if (request.audioPath && format === "mp4") {
		window.electronAPI.cliProgress({ percentage: 100, phase: "mixing-voiceover" });
		const audioResponse = await fetch(toFileUrl(request.audioPath));
		if (!audioResponse.ok) {
			throw new Error(`Failed to read voiceover file: ${request.audioPath}`);
		}
		const voiceoverData = await audioResponse.arrayBuffer();
		blob = await mixVoiceoverIntoVideo(blob, {
			voiceoverData,
			mode: request.audioMode,
			offsetSec: request.audioOffsetSec,
		});
	}

	const arrayBuffer = await blob.arrayBuffer();
	const saveResult = await window.electronAPI.writeExportToPath(arrayBuffer, outPath);
	if (!saveResult.success || !saveResult.path) {
		throw new Error(saveResult.message ?? `Failed to write output to ${outPath}`);
	}

	return {
		success: true,
		outputPath: saveResult.path,
		format,
		width: outWidth,
		height: outHeight,
		warnings,
	};
}

export function CliExportRunner() {
	const startedRef = useRef(false);
	const [status, setStatus] = useState("Starting export…");

	useEffect(() => {
		if (startedRef.current) return;
		startedRef.current = true;

		void (async () => {
			try {
				const request = (await window.electronAPI.cliGetRequest()) as CliExportRequest;
				if (request.kind !== "export") {
					throw new Error(`cli-export window received a ${request.kind} request`);
				}
				setStatus(`Exporting ${request.projectPath}…`);
				const result = await runExport(request);
				await window.electronAPI.cliDone(result);
			} catch (error) {
				const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
				await window.electronAPI.cliDone({ success: false, error: message });
			}
		})();
	}, []);

	return (
		<div className="flex h-screen items-center justify-center bg-[#09090b] text-white/60 text-sm">
			{status}
		</div>
	);
}

export default CliExportRunner;
