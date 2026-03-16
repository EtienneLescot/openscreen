import { type Container, Point } from "pixi.js";
import type { CropRegion } from "@/components/video-editor/types";
import type {
	CursorRecordingData,
	CursorRecordingSample,
	NativeCursorAsset,
} from "@/native/contracts";

export interface ActiveNativeCursorFrame {
	asset: NativeCursorAsset;
	sample: CursorRecordingSample;
}

interface ProjectNativeCursorOptions {
	cameraContainer: Container;
	cropRegion: CropRegion;
	maskRect: { width: number; height: number };
	videoContainerPosition: { x: number; y: number };
	sample: CursorRecordingSample;
}

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}

function getCroppedCursorPosition(sample: CursorRecordingSample, cropRegion: CropRegion) {
	if (cropRegion.width <= 0 || cropRegion.height <= 0) {
		return null;
	}

	const croppedCx = (sample.cx - cropRegion.x) / cropRegion.width;
	const croppedCy = (sample.cy - cropRegion.y) / cropRegion.height;

	if (croppedCx < 0 || croppedCx > 1 || croppedCy < 0 || croppedCy > 1) {
		return null;
	}

	return {
		cx: clamp(croppedCx, 0, 1),
		cy: clamp(croppedCy, 0, 1),
	};
}

export function resolveActiveNativeCursorFrame(
	recordingData: CursorRecordingData | null | undefined,
	timeMs: number,
): ActiveNativeCursorFrame | null {
	if (!recordingData || recordingData.provider !== "native" || recordingData.assets.length === 0) {
		return null;
	}

	for (let index = recordingData.samples.length - 1; index >= 0; index -= 1) {
		const sample = recordingData.samples[index];
		if (sample.timeMs > timeMs) {
			continue;
		}

		if (sample.visible === false || !sample.assetId) {
			return null;
		}

		const asset = recordingData.assets.find((candidate) => candidate.id === sample.assetId);
		if (!asset) {
			return null;
		}

		return { sample, asset };
	}

	return null;
}

export function projectNativeCursorToStage({
	cameraContainer,
	cropRegion,
	maskRect,
	videoContainerPosition,
	sample,
}: ProjectNativeCursorOptions) {
	const croppedPosition = getCroppedCursorPosition(sample, cropRegion);
	if (!croppedPosition) {
		return null;
	}

	const localPoint = new Point(
		videoContainerPosition.x + croppedPosition.cx * maskRect.width,
		videoContainerPosition.y + croppedPosition.cy * maskRect.height,
	);

	return cameraContainer.toGlobal(localPoint);
}

export function getNativeCursorDisplayMetrics(asset: NativeCursorAsset, deviceScaleFactor: number) {
	const scaleFactor = asset.scaleFactor ?? deviceScaleFactor ?? 1;
	return {
		width: asset.width / scaleFactor,
		height: asset.height / scaleFactor,
		hotspotX: asset.hotspotX / scaleFactor,
		hotspotY: asset.hotspotY / scaleFactor,
	};
}
