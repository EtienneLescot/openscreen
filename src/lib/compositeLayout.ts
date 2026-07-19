export interface RenderRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Floor for the reactive webcam multiplier so the camera never shrinks below ~35% at deep zoom. */
export const WEBCAM_REACTIVE_ZOOM_MIN_SCALE = 0.35;

/**
 * Maps the live zoom scale to a webcam size multiplier, inversely (2x zoom, half size; 3x, a
 * third) so the camera stays out of the way while zoomed and returns to full size as zoom eases
 * back. Clamped to a floor so it never disappears. appliedScale is already eased per frame, so
 * the camera animates in sync for free.
 */
export function reactiveWebcamScale(zoomScale: number): number {
	const safe = Number.isFinite(zoomScale) && zoomScale > 0 ? zoomScale : 1;
	return Math.max(WEBCAM_REACTIVE_ZOOM_MIN_SCALE, Math.min(1, 1 / safe));
}

export interface StyledRenderRect extends RenderRect {
	borderRadius: number;
	maskShape?: import("@/components/video-editor/types").WebcamMaskShape;
}

/**
 * Linearly interpolates position/size/borderRadius between two rects. Used to grow the
 * webcam overlay from its normal layout to a full-canvas rect during a "Full Camera"
 * timeline region, at progress `t` (0 = from, 1 = to). Pure and shape-agnostic so preview
 * (DOM transform) and export (canvas draw) can share the exact same math.
 */
export function lerpRect(
	from: StyledRenderRect,
	to: StyledRenderRect,
	t: number,
): StyledRenderRect {
	const clamped = Math.max(0, Math.min(1, t));
	return {
		x: from.x + (to.x - from.x) * clamped,
		y: from.y + (to.y - from.y) * clamped,
		width: from.width + (to.width - from.width) * clamped,
		height: from.height + (to.height - from.height) * clamped,
		borderRadius: from.borderRadius + (to.borderRadius - from.borderRadius) * clamped,
		maskShape: from.maskShape,
	};
}

/**
 * Inset fraction (of the canvas' shorter dimension) left as a visible border around the
 * webcam when Full Camera expands it, so rounded/circular webcam masks never touch the
 * canvas edge at full screen. Matches the same order of magnitude as `MARGIN_FRACTION`
 * used for the picture-in-picture layout above.
 */
export const CAMERA_FULLSCREEN_MARGIN_FRACTION = 0.025;

/**
 * Computes the Full Camera "grown" target rect: the largest rect matching `aspectRect`'s
 * aspect ratio that fits centered inside the canvas, inset by `CAMERA_FULLSCREEN_MARGIN_FRACTION`
 * of the canvas' shorter dimension. Preserving the base rect's aspect ratio (rather than
 * filling the canvas' own aspect ratio) keeps the webcam undistorted throughout the lerp,
 * since `lerpRect` only stays proportion-correct if both endpoints share the same ratio.
 * Pure function shared by preview (`VideoPlayback.tsx`) and export (`frameRenderer.ts`) so
 * both animate to the identical rect.
 */
export function computeCameraFullscreenTargetRect(
	canvasSize: Size,
	aspectRect: { width: number; height: number },
): RenderRect {
	const { width: canvasWidth, height: canvasHeight } = canvasSize;
	const margin = Math.round(
		Math.min(canvasWidth, canvasHeight) * CAMERA_FULLSCREEN_MARGIN_FRACTION,
	);
	const boundsWidth = Math.max(0, canvasWidth - margin * 2);
	const boundsHeight = Math.max(0, canvasHeight - margin * 2);

	const aspect =
		aspectRect.width > 0 && aspectRect.height > 0 ? aspectRect.width / aspectRect.height : 1;

	let width = boundsWidth;
	let height = width / aspect;
	if (height > boundsHeight) {
		height = boundsHeight;
		width = height * aspect;
	}

	const x = margin + (boundsWidth - width) / 2;
	const y = margin + (boundsHeight - height) / 2;

	return { x, y, width, height };
}

export interface Size {
	width: number;
	height: number;
}

export type WebcamLayoutPreset =
	| "picture-in-picture"
	| "vertical-stack"
	| "dual-frame"
	| "no-webcam";
/** Webcam size as a percentage of the canvas reference dimension (10–50). */
export type WebcamSizePreset = number;

export interface WebcamLayoutShadow {
	color: string;
	blur: number;
	offsetX: number;
	offsetY: number;
}

interface BorderRadiusRule {
	max: number;
	min: number;
	fraction: number;
}

interface OverlayTransform {
	type: "overlay";
	marginFraction: number;
	minMargin: number;
	minSize: number;
}

interface StackTransform {
	type: "stack";
	gapFraction: number;
	minGap: number;
}

interface SplitTransform {
	type: "split";
	gapFraction: number;
	minGap: number;
	screenUnits: number;
	webcamUnits: number;
}

export interface WebcamLayoutPresetDefinition {
	label: string;
	transform: OverlayTransform | StackTransform | SplitTransform;
	borderRadius: BorderRadiusRule;
	shadow: WebcamLayoutShadow | null;
}

export interface WebcamCompositeLayout {
	screenRect: RenderRect;
	webcamRect: StyledRenderRect | null;
	screenBorderRadius?: number;
	/** When true, the video should be scaled to cover screenRect (cropping overflow). */
	screenCover?: boolean;
}

/** Convert a webcam size percentage (10–50) to a fraction (0..1) of the reference dimension. */
export function webcamSizeToFraction(percent: number): number {
	const safe = Number.isFinite(percent) ? percent : 25;
	const clamped = Math.max(10, Math.min(50, safe));
	return clamped / 100;
}

const MARGIN_FRACTION = 0.02;
const MAX_BORDER_RADIUS = 24;
const WEBCAM_LAYOUT_PRESET_MAP: Record<WebcamLayoutPreset, WebcamLayoutPresetDefinition> = {
	"picture-in-picture": {
		label: "Picture in Picture",
		transform: {
			type: "overlay",
			marginFraction: MARGIN_FRACTION,
			minMargin: 0,
			minSize: 0,
		},
		borderRadius: {
			max: MAX_BORDER_RADIUS,
			min: 12,
			fraction: 0.12,
		},
		shadow: {
			color: "rgba(0,0,0,0.35)",
			blur: 24,
			offsetX: 0,
			offsetY: 10,
		},
	},
	"vertical-stack": {
		label: "Vertical Stack",
		transform: {
			type: "stack",
			gapFraction: 0.02,
			minGap: 8,
		},
		borderRadius: {
			max: 24,
			min: 8,
			fraction: 0.06,
		},
		shadow: null,
	},
	"dual-frame": {
		label: "Dual Frame",
		transform: {
			type: "split",
			gapFraction: 0.02,
			minGap: 12,
			screenUnits: 2,
			webcamUnits: 1,
		},
		borderRadius: {
			max: MAX_BORDER_RADIUS,
			min: 12,
			fraction: 0.06,
		},
		shadow: null,
	},
	"no-webcam": {
		label: "No Webcam",
		transform: {
			type: "overlay",
			marginFraction: 0,
			minMargin: 0,
			minSize: 0,
		},
		borderRadius: {
			max: 0,
			min: 0,
			fraction: 0,
		},
		shadow: null,
	},
};

export const WEBCAM_LAYOUT_PRESETS = Object.entries(WEBCAM_LAYOUT_PRESET_MAP).map(
	([value, preset]) => ({
		value: value as WebcamLayoutPreset,
		label: preset.label,
	}),
);

export function getWebcamLayoutPresetDefinition(
	preset: WebcamLayoutPreset = "picture-in-picture",
): WebcamLayoutPresetDefinition {
	return WEBCAM_LAYOUT_PRESET_MAP[preset];
}

export function getWebcamLayoutCssBoxShadow(
	preset: WebcamLayoutPreset = "picture-in-picture",
): string {
	const shadow = getWebcamLayoutPresetDefinition(preset).shadow;
	return shadow
		? `${shadow.offsetX}px ${shadow.offsetY}px ${shadow.blur}px ${shadow.color}`
		: "none";
}

export function computeCompositeLayout(params: {
	canvasSize: Size;
	maxContentSize?: Size;
	screenSize: Size;
	webcamSize?: Size | null;
	layoutPreset?: WebcamLayoutPreset;
	webcamSizePreset?: WebcamSizePreset;
	webcamPosition?: { cx: number; cy: number } | null;
	webcamMaskShape?: import("@/components/video-editor/types").WebcamMaskShape;
}): WebcamCompositeLayout | null {
	const {
		canvasSize,
		maxContentSize = canvasSize,
		screenSize,
		webcamSize,
		layoutPreset = "picture-in-picture",
		webcamSizePreset = 25,
		webcamPosition,
		webcamMaskShape = "rectangle",
	} = params;
	const { width: canvasWidth, height: canvasHeight } = canvasSize;
	const { width: screenWidth, height: screenHeight } = screenSize;

	// no-webcam: hide the webcam, screen fills the canvas normally.
	if (layoutPreset === "no-webcam") {
		const screenRect = centerRect({
			canvasSize,
			size: screenSize,
			maxSize: maxContentSize,
		});
		return { screenRect, webcamRect: null };
	}

	const webcamWidth = webcamSize?.width;
	const webcamHeight = webcamSize?.height;
	const preset = getWebcamLayoutPresetDefinition(layoutPreset);

	const MAX_STAGE_FRACTION = webcamSizeToFraction(webcamSizePreset);

	if (canvasWidth <= 0 || canvasHeight <= 0 || screenWidth <= 0 || screenHeight <= 0) {
		return null;
	}

	if (preset.transform.type === "stack") {
		if (!webcamWidth || !webcamHeight || webcamWidth <= 0 || webcamHeight <= 0) {
			// No webcam, so screen fills the whole canvas (cover mode).
			return {
				screenRect: { x: 0, y: 0, width: canvasWidth, height: canvasHeight },
				webcamRect: null,
				screenCover: true,
			};
		}

		// ponytail: padding insets the content vertically (like dual-frame
		// insets it horizontally). `maxContentSize` from `PreviewCanvas` is
		// already padded to `canvasSize × paddingFit`; we derive a content
		// area, vertically center the screen+gap+camera stack inside it, and
		// keep the wallpaper visible at the top and bottom of the canvas.
		const contentHeight = Math.min(
			canvasHeight,
			Math.max(1, Math.round(maxContentSize?.height ?? canvasHeight)),
		);
		const contentWidth = Math.min(
			canvasWidth,
			Math.max(1, Math.round(maxContentSize?.width ?? canvasWidth)),
		);
		const contentY = Math.max(0, Math.floor((canvasHeight - contentHeight) / 2));

		// ponytail: gap between screen and camera, scaled off the padded
		// content width so the proportional spacing stays consistent.
		const gap = Math.max(
			preset.transform.minGap,
			Math.round(contentWidth * preset.transform.gapFraction),
		);

		// Webcam: full content width at the bottom, capped at 40% of the
		// padded content area so the screen always has room (otherwise a
		// 16:9 webcam in a 16:9 canvas collapses the screen to 0px). Aspect
		// is preserved when the request overflows the cap. The 40% follows the
		// same 1-of-N ratio the dual-frame preset uses for screenUnits/webcamUnits.
		const webcamAspect = webcamWidth / webcamHeight;
		const requestedWebcamWidth = contentWidth;
		const requestedWebcamHeight = Math.round(requestedWebcamWidth / webcamAspect);
		const stackCapHeight = Math.max(1, Math.round(contentHeight * 0.4));
		const resolvedWebcamHeight = Math.min(requestedWebcamHeight, stackCapHeight);
		const resolvedWebcamWidth = Math.round(resolvedWebcamHeight * webcamAspect);

		// Screen: fills remaining space above the camera + gap, content width.
		const screenRectHeight = Math.max(0, contentHeight - resolvedWebcamHeight - gap);

		// Camera border-radius follows the same preset fraction rule as
		// dual-frame so the strip gets gentle rounded corners.
		const webcamBorderRadius = Math.min(
			preset.borderRadius.max,
			Math.max(
				preset.borderRadius.min,
				Math.round(
					Math.min(resolvedWebcamWidth, resolvedWebcamHeight) * preset.borderRadius.fraction,
				),
			),
		);

		return {
			screenRect: {
				// ponytail: the content area (padded by `maxContentSize`) is
				// centered in the canvas — top/bottom from the canvas, and
				// left/right from the canvas when `maxContentSize` is narrower
				// than canvasWidth. This matches the dual-frame pattern where
				// padding = canvas-margin.
				x: Math.max(0, Math.floor((canvasWidth - contentWidth) / 2)),
				y: contentY,
				width: contentWidth,
				height: screenRectHeight,
			},
			webcamRect: {
				// ponytail: legacy hardcoded x:0 which left-aligned the camera
				// strip in the bottom-left when its aspect produced a narrower
				// width than the canvas. Center the strip horizontally within
				// the padded content area when there's room to spare, and
				// match the screen's horizontal inset.
				x:
					Math.max(0, Math.floor((canvasWidth - contentWidth) / 2)) +
					Math.floor((contentWidth - resolvedWebcamWidth) / 2),
				// ponytail: place camera BELOW the gap inside the padded area so
				// screen and camera don't touch.
				y: contentY + screenRectHeight + gap,
				width: resolvedWebcamWidth,
				height: resolvedWebcamHeight,
				borderRadius: webcamBorderRadius,
			},
			screenCover: true,
		};
	}

	if (preset.transform.type === "split") {
		const screenRect = centerRect({
			canvasSize,
			size: screenSize,
			maxSize: maxContentSize,
		});

		if (!webcamWidth || !webcamHeight || webcamWidth <= 0 || webcamHeight <= 0) {
			return { screenRect, webcamRect: null };
		}

		const contentWidth = Math.min(canvasWidth, Math.max(1, Math.round(maxContentSize.width)));
		const contentHeight = Math.min(canvasHeight, Math.max(1, Math.round(maxContentSize.height)));
		const contentX = Math.max(0, Math.floor((canvasWidth - contentWidth) / 2));
		const contentY = Math.max(0, Math.floor((canvasHeight - contentHeight) / 2));
		const gap = Math.max(
			preset.transform.minGap,
			Math.round(contentWidth * preset.transform.gapFraction),
		);
		const totalUnits = preset.transform.screenUnits + preset.transform.webcamUnits;
		const availableWidth = Math.max(1, contentWidth - gap);
		const screenSlotWidth = Math.max(
			1,
			Math.round((availableWidth * preset.transform.screenUnits) / totalUnits),
		);
		const webcamSlotWidth = Math.max(1, availableWidth - screenSlotWidth);

		const screenSlot = {
			x: contentX,
			y: contentY,
			width: screenSlotWidth,
			height: contentHeight,
		};
		const webcamSlot = {
			x: contentX + screenSlotWidth + gap,
			y: contentY,
			width: webcamSlotWidth,
			height: contentHeight,
		};

		const webcamBorderRadius = Math.min(
			preset.borderRadius.max,
			Math.max(
				preset.borderRadius.min,
				Math.round(Math.min(webcamSlot.width, webcamSlot.height) * preset.borderRadius.fraction),
			),
		);

		return {
			screenRect: screenSlot,
			screenBorderRadius: webcamBorderRadius,
			webcamRect: {
				x: webcamSlot.x,
				y: webcamSlot.y,
				width: webcamSlot.width,
				height: webcamSlot.height,
				borderRadius: webcamBorderRadius,
				maskShape: "rectangle",
			},
			screenCover: true,
		};
	}

	const transform = preset.transform;
	const screenRect = centerRect({
		canvasSize,
		size: screenSize,
		maxSize: maxContentSize,
	});

	if (!webcamWidth || !webcamHeight || webcamWidth <= 0 || webcamHeight <= 0) {
		return { screenRect, webcamRect: null };
	}

	const margin = Math.max(
		transform.minMargin,
		Math.round(Math.min(canvasWidth, canvasHeight) * transform.marginFraction),
	);
	// Geometric mean so the webcam keeps a consistent visual proportion in portrait or landscape.
	const referenceDim = Math.sqrt(canvasWidth * canvasHeight);
	const maxWidth = Math.max(transform.minSize, referenceDim * MAX_STAGE_FRACTION);
	const maxHeight = Math.max(transform.minSize, referenceDim * MAX_STAGE_FRACTION);
	const scale = Math.min(maxWidth / webcamWidth, maxHeight / webcamHeight);
	let width = Math.round(webcamWidth * scale);
	let height = Math.round(webcamHeight * scale);

	// Shape-specific dimension adjustments
	if (webcamMaskShape === "circle" || webcamMaskShape === "square") {
		const side = Math.min(width, height);
		width = side;
		height = side;
	}

	let webcamX: number;
	let webcamY: number;

	if (webcamPosition) {
		// cx/cy are the webcam center as a fraction of the canvas.
		webcamX = Math.round(webcamPosition.cx * canvasWidth - width / 2);
		webcamY = Math.round(webcamPosition.cy * canvasHeight - height / 2);
		// Clamp inside canvas bounds.
		webcamX = Math.max(0, Math.min(canvasWidth - width, webcamX));
		webcamY = Math.max(0, Math.min(canvasHeight - height, webcamY));
	} else {
		// Default: bottom-right with margin
		webcamX = Math.max(0, Math.round(canvasWidth - margin - width));
		webcamY = Math.max(0, Math.round(canvasHeight - margin - height));
	}

	// Shape-specific border radius
	let borderRadius: number;
	if (webcamMaskShape === "rounded") {
		borderRadius = Math.round(Math.min(width, height) * 0.3);
	} else if (webcamMaskShape === "circle") {
		borderRadius = Math.round(Math.min(width, height) / 2);
	} else {
		borderRadius = Math.min(
			preset.borderRadius.max,
			Math.max(
				preset.borderRadius.min,
				Math.round(Math.min(width, height) * preset.borderRadius.fraction),
			),
		);
	}

	return {
		screenRect,
		webcamRect: {
			x: webcamX,
			y: webcamY,
			width,
			height,
			borderRadius,
			maskShape: webcamMaskShape,
		},
	};
}

function centerRect(params: { canvasSize: Size; size: Size; maxSize: Size }): RenderRect {
	const { canvasSize, size, maxSize } = params;
	return centerRectInBounds({
		bounds: { x: 0, y: 0, width: canvasSize.width, height: canvasSize.height },
		size,
		maxSize,
	});
}

function centerRectInBounds(params: { bounds: RenderRect; size: Size; maxSize: Size }): RenderRect {
	const { bounds, size, maxSize } = params;
	const { x: boundsX, y: boundsY, width: boundsWidth, height: boundsHeight } = bounds;
	const { width, height } = size;
	const { width: maxWidth, height: maxHeight } = maxSize;
	const scale = Math.min(maxWidth / width, maxHeight / height);
	const resolvedWidth = Math.round(width * scale);
	const resolvedHeight = Math.round(height * scale);

	if (
		maxWidth >= boundsWidth &&
		maxHeight >= boundsHeight &&
		Math.abs(boundsWidth - resolvedWidth) <= 4 &&
		Math.abs(boundsHeight - resolvedHeight) <= 4
	) {
		return {
			x: boundsX,
			y: boundsY,
			width: boundsWidth,
			height: boundsHeight,
		};
	}

	return {
		x: boundsX + Math.max(0, Math.floor((boundsWidth - resolvedWidth) / 2)),
		y: boundsY + Math.max(0, Math.floor((boundsHeight - resolvedHeight) / 2)),
		width: resolvedWidth,
		height: resolvedHeight,
	};
}
