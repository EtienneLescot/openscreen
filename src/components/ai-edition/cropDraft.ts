// Pure crop-draft helpers for Edit Clip. The modal stores the rectangle as
// frame fractions (0–1), not rounded integer percents, so a 1px nudge is
// representable once the source size is known.

export interface CropDraft {
	x: number;
	y: number;
	width: number;
	height: number;
}

export function cropDraftFromRegion(region: CropDraft): CropDraft {
	return { x: region.x, y: region.y, width: region.width, height: region.height };
}

export function cropDraftToPct(draft: CropDraft): { x: number; y: number; w: number; h: number } {
	return {
		x: draft.x * 100,
		y: draft.y * 100,
		w: draft.width * 100,
		h: draft.height * 100,
	};
}

/** Percent step for a numeric field: one source pixel when the frame size is known. */
export function stepPct(frameSizePx: number): number {
	return frameSizePx > 0 ? 100 / frameSizePx : 0.1;
}

/**
 * What the numeric fields DISPLAY. The draft itself stays unrounded (that is
 * the point of pixel-precision crops), but a drag leaves values like
 * 33.33333333333333 behind, and eight digits of float noise in a percent
 * field reads as a bug. Two decimals is 0.01% — under a fifth of a pixel on
 * a 1920-wide source — so the display can never be visibly off from the
 * stored value. Typing writes the exact typed number; this only formats.
 */
export function displayPct(value: number): number {
	return Math.round(value * 100) / 100;
}

export const PREVIEW_MAX_HEIGHT_PX = 360;

/**
 * Preview box for the crop overlay. The crop rectangle and every drag are
 * measured against THIS element, while the <video> inside it letterboxes via
 * object-fit: contain — so the box must have the video's own aspect ratio or
 * the overlay drifts off the pixels it claims to crop (the old fixed
 * 409x230 box was 16:9 for exactly this reason). Width is therefore derived
 * from the height cap and the aspect: `min(100%, height-cap * aspect)`.
 * Declaring width this way — rather than `width: 100%` plus a max-height —
 * matters because when a max-height clamps an aspect-ratio box, CSS keeps
 * the width and BREAKS the ratio, which would letterbox portrait sources
 * all over again.
 */
export function previewBoxStyle(videoAspectRatio: number): {
	position: "relative";
	width: string;
	aspectRatio: string;
	margin: string;
	flexShrink: number;
	background: string;
	borderRadius: string;
	border: string;
	overflow: "hidden";
} {
	const aspect =
		Number.isFinite(videoAspectRatio) && videoAspectRatio > 0 ? videoAspectRatio : 16 / 9;
	return {
		position: "relative",
		width: `min(100%, calc(${PREVIEW_MAX_HEIGHT_PX}px * ${aspect}))`,
		aspectRatio: `${aspect}`,
		margin: "0 auto 14px",
		flexShrink: 0,
		background: "#0a0b0e",
		borderRadius: "var(--r-md)",
		border: "1px solid var(--border)",
		overflow: "hidden",
	};
}
