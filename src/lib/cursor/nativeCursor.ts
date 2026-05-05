import { type Container, Point } from "pixi.js";
import appStartingUrl from "@/assets/cursors/Cursor=App-Starting.svg";
import crosshairUrl from "@/assets/cursors/Cursor=Cross.svg";
import arrowUrl from "@/assets/cursors/Cursor=Default.svg";
import pointerUrl from "@/assets/cursors/Cursor=Hand-(Pointing).svg";
import helpUrl from "@/assets/cursors/Cursor=Help.svg";
import moveUrl from "@/assets/cursors/Cursor=Move.svg";
import notAllowedUrl from "@/assets/cursors/Cursor=Not-Allowed.svg";
import resizeNeswUrl from "@/assets/cursors/Cursor=Resize-North-East-South-West.svg";
import resizeNsUrl from "@/assets/cursors/Cursor=Resize-North-South.svg";
import resizeNwseUrl from "@/assets/cursors/Cursor=Resize-North-West-South-East.svg";
import resizeEwUrl from "@/assets/cursors/Cursor=Resize-West-East.svg";
import textUrl from "@/assets/cursors/Cursor=Text-Cursor.svg";
import upArrowUrl from "@/assets/cursors/Cursor=Up-Arrow.svg";
import waitUrl from "@/assets/cursors/Cursor=Wait.svg";
import type { CropRegion } from "@/components/video-editor/types";
import type {
	CursorRecordingData,
	CursorRecordingSample,
	NativeCursorAsset,
	NativeCursorType,
} from "@/native/contracts";

export interface ActiveNativeCursorFrame {
	asset: NativeCursorAsset;
	sample: CursorRecordingSample;
}

interface ProjectNativeCursorOptions {
	cropRegion: CropRegion;
	maskRect: { x: number; y: number; width: number; height: number };
	videoContainerPosition: { x: number; y: number };
	sample: CursorRecordingSample;
}

interface ProjectNativeCursorToStageOptions extends ProjectNativeCursorOptions {
	cameraContainer: Container;
}

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}

interface PrettyNativeCursorAsset {
	imageDataUrl: string;
	width: number;
	height: number;
	hotspotX: number;
	hotspotY: number;
}

const PRETTY_NATIVE_CURSOR_ASSETS: Partial<Record<NativeCursorType, PrettyNativeCursorAsset>> = {
	arrow: {
		imageDataUrl: arrowUrl,
		width: 32,
		height: 32,
		hotspotX: 5.8,
		hotspotY: 3.2,
	},
	text: {
		imageDataUrl: textUrl,
		width: 32,
		height: 32,
		hotspotX: 16,
		hotspotY: 16,
	},
	pointer: {
		imageDataUrl: pointerUrl,
		width: 32,
		height: 32,
		hotspotX: 11.8,
		hotspotY: 2.6,
	},
	crosshair: {
		imageDataUrl: crosshairUrl,
		width: 32,
		height: 32,
		hotspotX: 16,
		hotspotY: 16,
	},
	"resize-ew": {
		imageDataUrl: resizeEwUrl,
		width: 32,
		height: 32,
		hotspotX: 16,
		hotspotY: 16,
	},
	"resize-ns": {
		imageDataUrl: resizeNsUrl,
		width: 32,
		height: 32,
		hotspotX: 16,
		hotspotY: 16,
	},
	"resize-nesw": {
		imageDataUrl: resizeNeswUrl,
		width: 32,
		height: 32,
		hotspotX: 16,
		hotspotY: 16,
	},
	"resize-nwse": {
		imageDataUrl: resizeNwseUrl,
		width: 32,
		height: 32,
		hotspotX: 16,
		hotspotY: 16,
	},
	move: {
		imageDataUrl: moveUrl,
		width: 32,
		height: 32,
		hotspotX: 16,
		hotspotY: 16,
	},
	"not-allowed": {
		imageDataUrl: notAllowedUrl,
		width: 32,
		height: 32,
		hotspotX: 16,
		hotspotY: 16,
	},
	wait: {
		imageDataUrl: waitUrl,
		width: 32,
		height: 32,
		hotspotX: 16,
		hotspotY: 16,
	},
	"app-starting": {
		imageDataUrl: appStartingUrl,
		width: 32,
		height: 32,
		hotspotX: 5.8,
		hotspotY: 3.2,
	},
	help: {
		imageDataUrl: helpUrl,
		width: 32,
		height: 32,
		hotspotX: 5.8,
		hotspotY: 3.2,
	},
	"up-arrow": {
		imageDataUrl: upArrowUrl,
		width: 32,
		height: 32,
		hotspotX: 16,
		hotspotY: 3,
	},
};

export function hasNativeCursorRecordingData(
	recordingData: CursorRecordingData | null | undefined,
): recordingData is CursorRecordingData {
	return Boolean(
		recordingData &&
			recordingData.provider === "native" &&
			recordingData.samples.length > 0 &&
			recordingData.assets.length > 0,
	);
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
	if (!hasNativeCursorRecordingData(recordingData)) {
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

export function resolveInterpolatedNativeCursorFrame(
	recordingData: CursorRecordingData | null | undefined,
	timeMs: number,
): ActiveNativeCursorFrame | null {
	if (!hasNativeCursorRecordingData(recordingData)) {
		return null;
	}

	const samples = recordingData.samples;
	let activeIndex = -1;

	for (let index = samples.length - 1; index >= 0; index -= 1) {
		if (samples[index].timeMs <= timeMs) {
			activeIndex = index;
			break;
		}
	}

	if (activeIndex < 0) {
		return null;
	}

	const activeSample = samples[activeIndex];
	if (activeSample.visible === false || !activeSample.assetId) {
		return null;
	}

	const asset = recordingData.assets.find((candidate) => candidate.id === activeSample.assetId);
	if (!asset) {
		return null;
	}

	const nextSample = samples[activeIndex + 1];
	if (
		!nextSample ||
		nextSample.timeMs <= activeSample.timeMs ||
		nextSample.visible === false ||
		nextSample.assetId !== activeSample.assetId ||
		timeMs <= activeSample.timeMs
	) {
		return { asset, sample: activeSample };
	}

	const interpolation = clamp(
		(timeMs - activeSample.timeMs) / (nextSample.timeMs - activeSample.timeMs),
		0,
		1,
	);

	return {
		asset,
		sample: {
			...activeSample,
			cx: activeSample.cx + (nextSample.cx - activeSample.cx) * interpolation,
			cy: activeSample.cy + (nextSample.cy - activeSample.cy) * interpolation,
		},
	};
}

export function projectNativeCursorToLocal({
	cropRegion,
	maskRect,
	videoContainerPosition,
	sample,
}: ProjectNativeCursorOptions) {
	const croppedPosition = getCroppedCursorPosition(sample, cropRegion);
	if (!croppedPosition) {
		return null;
	}

	return new Point(
		videoContainerPosition.x + maskRect.x + croppedPosition.cx * maskRect.width,
		videoContainerPosition.y + maskRect.y + croppedPosition.cy * maskRect.height,
	);
}

export function projectNativeCursorToStage({
	cameraContainer,
	...options
}: ProjectNativeCursorToStageOptions) {
	const localPoint = projectNativeCursorToLocal(options);
	if (!localPoint) {
		return null;
	}
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

export function resolvePrettyNativeCursorAsset(
	asset: NativeCursorAsset,
	sample?: CursorRecordingSample,
) {
	const cursorType = sample?.cursorType ?? asset.cursorType ?? null;
	return cursorType ? (PRETTY_NATIVE_CURSOR_ASSETS[cursorType] ?? null) : null;
}

export function resolveNativeCursorRenderAsset(
	asset: NativeCursorAsset,
	deviceScaleFactor: number,
	sample?: CursorRecordingSample,
) {
	const prettyAsset = resolvePrettyNativeCursorAsset(asset, sample);
	if (prettyAsset) {
		return {
			id: `pretty:${sample?.cursorType ?? asset.cursorType}`,
			imageDataUrl: prettyAsset.imageDataUrl,
			width: prettyAsset.width,
			height: prettyAsset.height,
			hotspotX: prettyAsset.hotspotX,
			hotspotY: prettyAsset.hotspotY,
		};
	}

	const metrics = getNativeCursorDisplayMetrics(asset, deviceScaleFactor);
	return {
		id: asset.id,
		imageDataUrl: asset.imageDataUrl,
		width: metrics.width,
		height: metrics.height,
		hotspotX: metrics.hotspotX,
		hotspotY: metrics.hotspotY,
	};
}
