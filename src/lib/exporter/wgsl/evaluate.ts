// evaluate — (document appearance, t) → FrameState. Pure CPU, no GPU, no canvas.
//
// The architecture's load-bearing idea (rendering-architecture.md §8a): every
// per-frame appearance decision is a deterministic function of the document and
// a time. Extracting it means preview and export cannot drift on layout, easing
// or timing, because there is only one place that decides them.
//
// This is an EXTRACTION, not a rewrite: the geometry already lives in pure
// modules (computeCompositeLayout, zoomSpring, zoomTransform, cameraFullscreen).
// evaluate() calls exactly what FrameRenderer.updateLayout/updateAnimationState
// call, in the same order, so the WGSL compositor inherits their behaviour rather
// than reimplementing it — including the spring, which is the part nobody would
// reproduce identically by eye.
//
// The one thing this file owns that FrameRenderer does not: `velocity`, and the
// SHAPE of the output. The state is a plain struct, sized to become ~200 bytes of
// uniforms.

import type {
	CameraFullscreenRegion,
	CropRegion,
	Rotation3D,
	WebcamMaskShape,
	ZoomRegion,
} from "@/components/video-editor/types";
import { DEFAULT_ROTATION_3D, getZoomScale, lerpRotation3D } from "@/components/video-editor/types";
import { computeCameraFullscreenProgress } from "@/components/video-editor/videoPlayback/cameraFullscreenUtils";
import {
	AUTO_FOLLOW_PARAMS,
	DEFAULT_FOCUS,
} from "@/components/video-editor/videoPlayback/constants";
import { advanceFollowFocus } from "@/components/video-editor/videoPlayback/cursorFollowUtils";
import { clampFocusToScale } from "@/components/video-editor/videoPlayback/focusUtils";
import { findDominantRegion } from "@/components/video-editor/videoPlayback/zoomRegionUtils";
import {
	createZoomSpringState,
	resetZoomSpring,
	stepZoomSpring,
	type ZoomSpringState,
} from "@/components/video-editor/videoPlayback/zoomSpring";
import {
	computeFocusFromTransform,
	computeZoomTransform,
} from "@/components/video-editor/videoPlayback/zoomTransform";
import {
	computeCameraFullscreenTargetRect,
	computeCompositeLayout,
	lerpRect,
	reactiveWebcamScale,
	type Size,
	type StyledRenderRect,
	type WebcamLayoutPreset,
	type WebcamSizePreset,
} from "@/lib/compositeLayout";

/** Everything about the document that does not depend on `t`. */
export interface EvaluateScene {
	outputSize: Size;
	videoSize: Size;
	webcamSize: Size | null;
	cropRegion: CropRegion;
	padding: number;
	borderRadius: number;
	shadowIntensity: number;
	motionBlurAmount: number;
	zoomRegions: ZoomRegion[];
	cameraFullscreenRegions: CameraFullscreenRegion[];
	webcamLayoutPreset: WebcamLayoutPreset;
	webcamSizePreset: WebcamSizePreset;
	webcamMaskShape: WebcamMaskShape;
	webcamPosition: { cx: number; cy: number } | null;
	webcamMirrored: boolean;
	webcamReactiveZoom: boolean;
	cursorTelemetry?: import("@/components/video-editor/types").CursorTelemetryPoint[];
}

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface FrameState {
	/** Where the (cropped) recording lands on the stage, before the camera moves. */
	screenRect: Rect;
	/** Corner radius of the recording, in output pixels, BEFORE the camera scales it. */
	borderRadius: number;
	/** The camera: applied (spring-smoothed) scale + translation, in output pixels. */
	camera: { scale: number; x: number; y: number };
	/** The recording's on-screen box WITH the camera applied — what the shadow follows. */
	cameraRect: Rect;
	cameraBorderRadius: number;
	/** Source-space crop, normalised 0..1. */
	crop: CropRegion;
	/** Webcam destination, already carrying reactive-zoom shrink and Full Camera growth. */
	webcamRect: (StyledRenderRect & { shape: WebcamMaskShape }) | null;
	webcamMirrored: boolean;
	/** Per-frame camera movement, normalised. Drives motion blur; 0 on a still frame. */
	velocity: number;
	motionBlurAmount: number;
	shadowIntensity: number;
	rotation3D: Rotation3D;
	cameraFullscreenProgress: number;
}

/**
 * The parts of the animation that depend on the PREVIOUS frame.
 *
 * evaluate() is a pure function of (scene, t, prev) — not of (scene, t) alone,
 * because the zoom spring and the auto-focus smoother are integrators: they chase
 * their target over time. Threading their state through the signature keeps the
 * function pure and, more to the point, keeps it honest — a renderer that seeks
 * must reset this, and the type makes that impossible to forget.
 */
export interface EvaluateMemory {
	spring: ZoomSpringState;
	prevTimeMs: number | null;
	prevTargetProgress: number;
	smoothedAutoFocus: { cx: number; cy: number } | null;
	prevCamera: { scale: number; x: number; y: number } | null;
}

export function createEvaluateMemory(): EvaluateMemory {
	return {
		spring: createZoomSpringState(),
		prevTimeMs: null,
		prevTargetProgress: 0,
		smoothedAutoFocus: null,
		prevCamera: null,
	};
}

/** Layout is independent of `t`, so it is computed once per (scene, webcam presence). */
export function evaluateLayout(scene: EvaluateScene, hasWebcam: boolean) {
	const { width, height } = scene.outputSize;
	const crop = scene.cropRegion;
	const croppedVideo = {
		width: scene.videoSize.width * crop.width,
		height: scene.videoSize.height * crop.height,
	};

	// Padding is a percentage (0-100) where 50% ~ 0.8 scale; vertical stack is
	// full-bleed and ignores it. Same constants as the Canvas2D path, on purpose.
	const effectivePadding = scene.webcamLayoutPreset === "vertical-stack" ? 0 : scene.padding;
	const paddingScale = 1.0 - (effectivePadding / 100) * 0.4;

	const layout = computeCompositeLayout({
		canvasSize: { width, height },
		maxContentSize: { width: width * paddingScale, height: height * paddingScale },
		screenSize: croppedVideo,
		webcamSize: hasWebcam ? scene.webcamSize : null,
		layoutPreset: scene.webcamLayoutPreset,
		webcamSizePreset: scene.webcamSizePreset,
		webcamPosition: scene.webcamPosition,
		webcamMaskShape: scene.webcamMaskShape,
	});
	if (!layout) return null;

	const screenRect = layout.screenRect;
	const scale = layout.screenCover
		? Math.max(screenRect.width / croppedVideo.width, screenRect.height / croppedVideo.height)
		: screenRect.width / croppedVideo.width;

	// The mask is the visible box of the recording: the cropped source at `scale`,
	// centred in screenRect, clipped to it. Cover mode overflows and is cut.
	const displayed = { width: croppedVideo.width * scale, height: croppedVideo.height * scale };
	const maskRect = {
		x: screenRect.x + Math.max(0, (screenRect.width - displayed.width) / 2),
		y: screenRect.y + Math.max(0, (screenRect.height - displayed.height) / 2),
		width: Math.min(screenRect.width, displayed.width),
		height: Math.min(screenRect.height, displayed.height),
	};

	return {
		stageSize: { width, height },
		maskRect,
		borderRadius: scene.borderRadius,
		webcamRect: layout.webcamRect ?? null,
	};
}

export type EvaluateLayout = NonNullable<ReturnType<typeof evaluateLayout>>;

export function evaluate(
	scene: EvaluateScene,
	layout: EvaluateLayout,
	timeMs: number,
	memory: EvaluateMemory,
): FrameState {
	const cameraFullscreenProgress = computeCameraFullscreenProgress(
		scene.cameraFullscreenRegions,
		timeMs,
	);

	const { region, strength, blendedScale, rotation3D, transition } = findDominantRegion(
		scene.zoomRegions,
		timeMs,
		{ connectZooms: true, cursorTelemetry: scene.cursorTelemetry },
	);

	let targetScale = 1;
	let targetFocus = { ...DEFAULT_FOCUS };
	let targetProgress = 0;
	const currentRotation3D =
		region && strength > 0
			? lerpRotation3D(DEFAULT_ROTATION_3D, rotation3D, strength)
			: { ...DEFAULT_ROTATION_3D };

	const dtMs = memory.prevTimeMs != null ? timeMs - memory.prevTimeMs : 0;

	if (region && strength > 0) {
		const zoomScale = blendedScale ?? getZoomScale(region);
		targetScale = zoomScale;
		targetFocus = clampFocusToScale(region.focus, zoomScale);
		targetProgress = strength;

		if (region.focusMode === "auto" && !transition) {
			const raw = targetFocus;
			const isZoomingIn = targetProgress < 0.999 && targetProgress >= memory.prevTargetProgress;
			if (targetProgress >= 0.999 || !isZoomingIn) {
				const prev = memory.smoothedAutoFocus ?? raw;
				const smoothed = advanceFollowFocus(prev, raw, dtMs, AUTO_FOLLOW_PARAMS);
				memory.smoothedAutoFocus = smoothed;
				targetFocus = smoothed;
			} else {
				memory.smoothedAutoFocus = raw;
			}
		} else if (region.focusMode !== "auto") {
			memory.smoothedAutoFocus = null;
		}
		memory.prevTargetProgress = targetProgress;

		if (transition) {
			const start = computeZoomTransform({
				stageSize: layout.stageSize,
				baseMask: layout.maskRect,
				zoomScale: transition.startScale,
				zoomProgress: 1,
				focusX: transition.startFocus.cx,
				focusY: transition.startFocus.cy,
			});
			const end = computeZoomTransform({
				stageSize: layout.stageSize,
				baseMask: layout.maskRect,
				zoomScale: transition.endScale,
				zoomProgress: 1,
				focusX: transition.endFocus.cx,
				focusY: transition.endFocus.cy,
			});
			const t = transition.progress;
			const interpolated = {
				scale: start.scale + (end.scale - start.scale) * t,
				x: start.x + (end.x - start.x) * t,
				y: start.y + (end.y - start.y) * t,
			};
			targetScale = interpolated.scale;
			targetFocus = computeFocusFromTransform({
				stageSize: layout.stageSize,
				baseMask: layout.maskRect,
				zoomScale: interpolated.scale,
				x: interpolated.x,
				y: interpolated.y,
			});
			targetProgress = 1;
		}
	}

	const projected = computeZoomTransform({
		stageSize: layout.stageSize,
		baseMask: layout.maskRect,
		zoomScale: targetScale,
		zoomProgress: targetProgress,
		focusX: targetFocus.cx,
		focusY: targetFocus.cy,
	});

	// Spring-chase the eased target, exactly as the preview does, so the export
	// glides past the jerk at the steep start of the ease instead of snapping to
	// the target every frame. Snapped on the first frame or any large time jump
	// (a seek): integrating across a gap would fling the camera.
	let camera: { scale: number; x: number; y: number };
	if (memory.prevTimeMs == null || dtMs <= 0 || dtMs > 80) {
		resetZoomSpring(memory.spring, projected);
		camera = { scale: projected.scale, x: projected.x, y: projected.y };
	} else {
		camera = stepZoomSpring(memory.spring, projected, dtMs);
	}

	const prev = memory.prevCamera;
	const velocity = prev
		? Math.max(
				Math.abs(camera.scale - prev.scale),
				Math.abs(camera.x - prev.x) / Math.max(1, layout.stageSize.width),
				Math.abs(camera.y - prev.y) / Math.max(1, layout.stageSize.height),
			)
		: 0;
	memory.prevCamera = { ...camera };
	memory.prevTimeMs = timeMs;

	// The recording's box with the camera applied. The shader needs this directly:
	// it is what the rounded corners, the mask and the shadow are all cut from.
	const m = layout.maskRect;
	const cameraRect = {
		x: camera.x + camera.scale * m.x,
		y: camera.y + camera.scale * m.y,
		width: camera.scale * m.width,
		height: camera.scale * m.height,
	};

	return {
		screenRect: m,
		borderRadius: layout.borderRadius,
		camera,
		cameraRect,
		cameraBorderRadius: layout.borderRadius * camera.scale,
		crop: scene.cropRegion,
		webcamRect: evaluateWebcamRect(scene, layout, camera.scale, cameraFullscreenProgress),
		webcamMirrored: scene.webcamMirrored,
		velocity,
		motionBlurAmount: scene.motionBlurAmount,
		shadowIntensity: scene.shadowIntensity,
		rotation3D: currentRotation3D,
		cameraFullscreenProgress,
	};
}

/**
 * Where the webcam lands: docked PiP, shrunk by the zoom, or grown to fill the
 * stage during a Full Camera region.
 *
 * Both movements are the reason the shadow cache could never hold on this
 * product's real timelines: they change the webcam's geometry every frame of an
 * animation, and the user's answer to §13 is that they are the norm.
 */
function evaluateWebcamRect(
	scene: EvaluateScene,
	layout: EvaluateLayout,
	appliedScale: number,
	fullscreenProgress: number,
): (StyledRenderRect & { shape: WebcamMaskShape }) | null {
	const base = layout.webcamRect;
	if (!base) return null;
	const shape = base.maskShape ?? scene.webcamMaskShape ?? "rectangle";

	if (fullscreenProgress > 0) {
		// Full Camera owns size and position outright; reactive zoom is ignored for
		// the frame (mixing "shrink for zoom" and "grow to full" means nothing).
		const target = computeCameraFullscreenTargetRect(scene.outputSize, base);
		const full: StyledRenderRect = {
			x: target.x,
			y: target.y,
			width: target.width,
			height: target.height,
			borderRadius: 0,
			maskShape: base.maskShape,
		};
		const r = lerpRect(base, full, fullscreenProgress);
		return { ...r, shape };
	}

	const reactive =
		scene.webcamReactiveZoom && scene.webcamLayoutPreset === "picture-in-picture"
			? reactiveWebcamScale(appliedScale)
			: 1;
	if (!(reactive < 1)) return { ...base, shape };

	// Anchor the shrink to the docked corner (bottom-right by default), like the
	// preview, so the bubble stays flush with the edges instead of drifting toward
	// the centre. Same bias rule as the Canvas2D path — deliberately identical.
	const pos = scene.webcamPosition;
	const biasX = (pos ? pos.cx >= 0.5 : true) ? 1 : 0;
	const biasY = (pos ? pos.cy >= 0.5 : true) ? 1 : 0;
	return {
		...base,
		x: base.x + base.width * (1 - reactive) * biasX,
		y: base.y + base.height * (1 - reactive) * biasY,
		width: base.width * reactive,
		height: base.height * reactive,
		borderRadius: base.borderRadius * reactive,
		shape,
	};
}
