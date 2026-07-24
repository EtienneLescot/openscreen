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
 * The camera's rect during a "Full Camera" region: its layout rect at `progress` 0,
 * the WHOLE frame at 1.
 *
 * Full Camera is not a zoom of the picture-in-picture bubble — it is the camera taking
 * the frame. The endpoint is exactly `[0, 0, canvasWidth, canvasHeight]`: no margin, no
 * padding, no corner rounding, and nothing of the composition (wallpaper, screen,
 * shadow) left showing behind it. The box may change aspect ratio on its way there
 * because every renderer cover-crops the camera into whatever box it is handed, so the
 * image is never stretched by the animation.
 *
 * The mask shape degenerates to a plain rounded rectangle whose radius eases to 0, which
 * is what makes the morph continuous instead of a pop: `computeCompositeLayout` already
 * gives a circle mask a radius of half its (square) box, and a rounded rect at that
 * radius IS that circle — so one lerp carries every shape out of existence with no
 * per-shape branch.
 *
 * Pure, and shared by the preview, both exporters and the native compositor, so all four
 * animate to the identical rect.
 */
export function computeCameraFullscreenRect(
	base: StyledRenderRect,
	canvasSize: Size,
	progress: number,
): StyledRenderRect {
	const t = Math.max(0, Math.min(1, progress));
	const lerp = (from: number, to: number) => from + (to - from) * t;
	return {
		x: lerp(base.x, 0),
		y: lerp(base.y, 0),
		width: lerp(base.width, canvasSize.width),
		height: lerp(base.height, canvasSize.height),
		borderRadius: lerp(base.borderRadius, 0),
		maskShape: "rectangle",
	};
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

/**
 * Screen + camera welded into one solid block that keeps the screen capture's own
 * aspect ratio, then contain-fits into the (padded) scene — see the design notes in
 * `computeCompositeLayout`. Used by both "Side by side" and "Top / bottom".
 */
interface BlockTransform {
	type: "block";
	/** Where the camera sits relative to the screen: beside it, or under it. */
	direction: "row" | "column";
	/** Gap between screen and camera, as a fraction of the screen's own width. */
	gapFraction: number;
}

export interface WebcamLayoutPresetDefinition {
	label: string;
	transform: OverlayTransform | BlockTransform;
	borderRadius: BorderRadiusRule;
	shadow: WebcamLayoutShadow | null;
}

/**
 * Presets whose camera box is welded to the screen. Their geometry is fully derived
 * from the screen capture's aspect ratio, so the webcam-size slider, the mask-shape
 * picker and the reactive "shrink on zoom" scaling have nothing to act on there.
 */
export function isWebcamBlockLayout(preset: WebcamLayoutPreset = "picture-in-picture"): boolean {
	return preset === "dual-frame" || preset === "vertical-stack";
}

/**
 * Whether "shrink on zoom" (the reactive webcam scaling) applies to a preset. Only the
 * free-floating picture-in-picture bubble can shrink: the block layouts size their
 * camera off the screen box, so shrinking it would break the "same width / same height
 * as the screen capture" contract and tear a hole in the block. Single rule shared by
 * the UI (which hides the toggle), the preview, both exporters and the native scene.
 */
export function supportsWebcamReactiveZoom(
	preset: WebcamLayoutPreset = "picture-in-picture",
): boolean {
	return preset === "picture-in-picture";
}

/** Effective reactive-zoom flag: the stored setting, gated by the active preset. */
export function resolveWebcamReactiveZoom(
	preset: WebcamLayoutPreset | undefined,
	enabled: boolean | undefined,
): boolean {
	return Boolean(enabled) && supportsWebcamReactiveZoom(preset);
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
/**
 * Breathing room between the screen box and the camera box inside a block layout,
 * as a fraction of the screen's own width. Expressed against the screen (not the
 * canvas) so it scales with the block itself: the same value reads as the same
 * visual gap whether the block is width- or height-constrained by the scene.
 */
const BLOCK_GAP_FRACTION = 0.02;
/**
 * How far the camera box may drift from square, as a maximum aspect ratio (its
 * reciprocal is the minimum). The camera's free side is chosen to make the whole
 * block match the SCENE's aspect ratio — perfect contain-fit, no bars — but the
 * result is then held within `[1/T, T]` of square, so the camera never becomes an
 * extreme slice. This single knob is the whole of "the camera tends toward square,
 * going only slightly rectangular when filling the scene asks it to". `1.25` keeps
 * it between 4:5 and 5:4.
 */
const BLOCK_CAMERA_ASPECT_TOLERANCE = 1.25;
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
		label: "Top / bottom",
		transform: {
			type: "block",
			direction: "column",
			gapFraction: BLOCK_GAP_FRACTION,
		},
		borderRadius: {
			max: 24,
			min: 8,
			fraction: 0.06,
		},
		shadow: null,
	},
	"dual-frame": {
		label: "Side by side",
		transform: {
			type: "block",
			direction: "row",
			gapFraction: BLOCK_GAP_FRACTION,
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

	if (preset.transform.type === "block") {
		const block = preset.transform;

		if (!webcamWidth || !webcamHeight || webcamWidth <= 0 || webcamHeight <= 0) {
			// No camera on this clip: the block degenerates to the screen alone, which
			// contain-fits the padded area like every other preset does.
			return {
				screenRect: centerRect({ canvasSize, size: screenSize, maxSize: maxContentSize }),
				webcamRect: null,
			};
		}

		// The block is laid out in UNIT space first, where the screen is exactly
		// 1 wide and `h = 1 / screenAspect` tall. The gap and the camera are
		// expressed against that same unit, so a single contain-fit at the end
		// scales screen, gap and camera together.
		//
		// The camera's SOURCE aspect ratio plays no part: the box is a mask cut
		// from the block's geometry, and the camera video is cover-cropped into it
		// downstream (`screenCover` for the screen, the renderers' cover crop for
		// the camera).
		const screenAspect = screenWidth / screenHeight;
		const unitScreenHeight = 1 / screenAspect; // h
		const gap = block.gapFraction;
		const isRow = block.direction === "row";

		// The camera shares the screen's cross-edge (same height beside it, same
		// width under it — the aligned edge that makes them one solid block), so its
		// size ALONG the split axis is the one free dimension. Three constraints fix
		// it, in order:
		//   1. screen keeps its own aspect ratio      → screen is 1 × h, untouched;
		//   2. the block contain-fits the scene        → pick `along` so the block's
		//      aspect equals the scene's (fills it, no bars) — see `alongForFill`;
		//   3. the camera tends toward square          → but clamp `along` so the
		//      camera stays within `[1/T, T]` of square, so filling the scene only
		//      nudges it slightly rectangular, never into a slice.
		// Square is `along === cameraCross`; the clamp is symmetric in both layouts.
		const cameraCross = isRow ? unitScreenHeight : 1;
		const sceneAspect = canvasWidth / canvasHeight;
		const alongForFill = isRow
			? sceneAspect * unitScreenHeight - 1 - gap // block width  = 1 + gap + along
			: 1 / sceneAspect - unitScreenHeight - gap; // block height = h + gap + along
		const cameraAlong = Math.min(
			cameraCross * BLOCK_CAMERA_ASPECT_TOLERANCE,
			Math.max(cameraCross / BLOCK_CAMERA_ASPECT_TOLERANCE, alongForFill),
		);

		const unitCameraWidth = isRow ? cameraAlong : 1;
		const unitCameraHeight = isRow ? unitScreenHeight : cameraAlong;
		const blockWidth = isRow ? 1 + gap + cameraAlong : 1;
		const blockHeight = isRow ? unitScreenHeight : unitScreenHeight + gap + cameraAlong;

		// Contain-fit the whole block into the padded content area. `maxContentSize`
		// is `canvasSize × paddingFit`, so padding shrinks the BLOCK (not just the
		// screen) and padding 0 leaves it flush against the two scene edges its own
		// ratio makes it touch — bottom/top for a column, left/right for a row.
		const contentWidth = Math.min(canvasWidth, Math.max(1, maxContentSize.width));
		const contentHeight = Math.min(canvasHeight, Math.max(1, maxContentSize.height));
		const scale = Math.min(contentWidth / blockWidth, contentHeight / blockHeight);

		const originX = (canvasWidth - blockWidth * scale) / 2;
		const originY = (canvasHeight - blockHeight * scale) / 2;

		const screenRect = snapRect(originX, originY, scale, unitScreenHeight * scale);
		const cameraRect = snapRect(
			isRow ? originX + (1 + gap) * scale : originX,
			isRow ? originY : originY + (unitScreenHeight + gap) * scale,
			unitCameraWidth * scale,
			unitCameraHeight * scale,
		);

		const webcamBorderRadius = Math.min(
			preset.borderRadius.max,
			Math.max(
				preset.borderRadius.min,
				Math.round(Math.min(cameraRect.width, cameraRect.height) * preset.borderRadius.fraction),
			),
		);

		return {
			screenRect,
			// Both halves of the block are framed alike, so the screen picks up the
			// camera's corner rounding instead of the free-standing Roundness slider.
			screenBorderRadius: webcamBorderRadius,
			webcamRect: {
				...cameraRect,
				borderRadius: webcamBorderRadius,
				maskShape: "rectangle",
			},
			// The screen box already carries the capture's exact aspect ratio, so
			// cover and contain agree here; cover just absorbs the ±1px rounding
			// above instead of letterboxing a hairline of wallpaper into the frame.
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
	// The SHORT axis, not the geometric mean: sqrt(w*h) sits close to the diagonal, so at an
	// extreme aspect ratio (e.g. 9:16) it barely shrinks even though the actual narrow axis is
	// much smaller — the webcam box then ends up a large fraction of that narrow axis, eating
	// most of the room there is to drag it around (reported: dragging the webcam PiP felt stuck
	// in a wide "dead band" near each edge — confirmed via logging: a 230px-wide 9:16 frame at a
	// modest 34% size preset produced a 104px-wide box, 45% of the frame's own width). Using the
	// short axis directly still keeps the box the same size when width/height are swapped
	// (min(a,b) is symmetric, same as sqrt(a*b) was), but it now actually shrinks with whichever
	// axis is the tight constraint, instead of only reacting to the frame's overall area.
	const referenceDim = Math.min(canvasWidth, canvasHeight);
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

/**
 * Rounds a float rect to whole pixels by rounding its EDGES rather than its origin
 * and size independently. Adjacent boxes computed from the same float grid then keep
 * a consistent gap, and the block's outer edges land exactly where the contain-fit
 * put them, instead of drifting by a pixel per box.
 */
function snapRect(x: number, y: number, width: number, height: number): RenderRect {
	const left = Math.round(x);
	const top = Math.round(y);
	return {
		x: left,
		y: top,
		width: Math.max(1, Math.round(x + width) - left),
		height: Math.max(1, Math.round(y + height) - top),
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
