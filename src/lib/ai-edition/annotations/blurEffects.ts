// Port of `src/lib/blurEffects.ts` (the preview-facing helpers only —
// `applyMosaicToImageData` is export-pipeline-only and unused by the live
// preview, so it isn't ported here).

import type { AxcutAnnotationRegion } from "@/lib/ai-edition/schema";
import {
	DEFAULT_BLUR_BLOCK_SIZE,
	DEFAULT_BLUR_INTENSITY,
	MAX_BLUR_BLOCK_SIZE,
	MAX_BLUR_INTENSITY,
	MIN_BLUR_BLOCK_SIZE,
	MIN_BLUR_INTENSITY,
} from "./constants";

type BlurData = NonNullable<AxcutAnnotationRegion["blurData"]>;
type BlurColor = BlurData["color"];

function clamp(value: number, min: number, max: number) {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, value));
}

export function normalizeBlurColor(value: unknown): BlurColor {
	return value === "black" ? "black" : "white";
}

export function getNormalizedBlurIntensity(blurData?: BlurData | null): number {
	return clamp(
		blurData?.intensity ?? DEFAULT_BLUR_INTENSITY,
		MIN_BLUR_INTENSITY,
		MAX_BLUR_INTENSITY,
	);
}

export function getNormalizedMosaicBlockSize(blurData?: BlurData | null, scaleFactor = 1): number {
	const rawBlockSize = clamp(
		blurData?.blockSize ?? DEFAULT_BLUR_BLOCK_SIZE,
		MIN_BLUR_BLOCK_SIZE,
		MAX_BLUR_BLOCK_SIZE,
	);
	return Math.max(1, Math.round(rawBlockSize * Math.max(scaleFactor, 0.01)));
}

export function getBlurOverlayColor(blurData?: BlurData | null): string {
	const blurColor = normalizeBlurColor(blurData?.color);
	return blurColor === "black" ? "rgba(0, 0, 0, 0.72)" : "rgba(255, 255, 255, 0.06)";
}

export function getMosaicGridOverlayColor(blurData?: BlurData | null): string {
	return normalizeBlurColor(blurData?.color) === "black"
		? "rgba(255,255,255,0.05)"
		: "rgba(255,255,255,0.04)";
}
