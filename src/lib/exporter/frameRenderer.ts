import {
	Application,
	BlurFilter,
	Container,
	Graphics,
	Sprite,
	Texture,
	type TextureSourceLike,
} from "pixi.js";
import { MotionBlurFilter } from "pixi-filters/motion-blur";
import type {
	AnnotationRegion,
	CameraFullscreenRegion,
	CropRegion,
	Rotation3D,
	SpeedRegion,
	WebcamLayoutPreset,
	WebcamSizePreset,
	ZoomRegion,
} from "@/components/video-editor/types";
import {
	DEFAULT_ROTATION_3D,
	getZoomScale,
	isRotation3DIdentity,
	lerpRotation3D,
} from "@/components/video-editor/types";
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
} from "@/components/video-editor/videoPlayback/zoomSpring";
import {
	applyZoomTransform,
	computeFocusFromTransform,
	computeZoomTransform,
	createMotionBlurState,
	type MotionBlurState,
} from "@/components/video-editor/videoPlayback/zoomTransform";
import {
	computeCameraFullscreenTargetRect,
	computeCompositeLayout,
	getWebcamLayoutPresetDefinition,
	lerpRect,
	reactiveWebcamScale,
	type Size,
	type StyledRenderRect,
} from "@/lib/compositeLayout";
import { getSmoothedCursorPath } from "@/lib/cursor/cursorPathSmoothing";
import {
	createNativeCursorMotionBlurState,
	getNativeCursorClickBounceProgress,
	getNativeCursorClickBounceScale,
	getNativeCursorMotionBlurPx,
	projectNativeCursorToLocal,
	resetNativeCursorMotionBlurState,
	resolveInterpolatedNativeCursorFrame,
	resolveNativeCursorRenderAsset,
} from "@/lib/cursor/nativeCursor";
import { BackgroundLoadError, classifyWallpaper, resolveImageWallpaperUrl } from "@/lib/wallpaper";
import { drawCanvasClipPath } from "@/lib/webcamMaskShapes";
import type { CursorRecordingData } from "@/native/contracts";
import { renderAnnotations } from "./annotationRenderer";
import {
	getLinearGradientPoints,
	getRadialGradientShape,
	parseCssGradient,
	resolveLinearGradientAngle,
} from "./gradientParser";
import { createThreeDPass, type ThreeDPass } from "./threeDPass";
import { drawWebcamFrameImage } from "./webcamFrameDrawing";

/**
 * Ask for CPU-backed 2D canvases (`willReadFrequently`) outside Linux.
 *
 * The default is GPU-backed, which makes compositing cheap and reading back
 * expensive. That is the right trade for WebCodecs, which encodes straight from
 * the GPU texture and never descends. It is the wrong trade for the native
 * encoder, which needs the pixels on the CPU for EVERY frame — there, the
 * readback measured 54-87ms/frame and became ~75% of the loop.
 *
 * Read at runtime so one app session can measure both settings:
 *   localStorage.setItem("openscreen.readFrequently", "1")
 *
 * Temporary scaffold: once the native path is the only path, this becomes a
 * plain constant rather than a question.
 */
function cpuCanvasRequested(): boolean {
	try {
		return localStorage.getItem("openscreen.readFrequently") === "1";
	} catch {
		return false;
	}
}

/**
 * Restore the pre-2026-07-17 compositor: a fresh GPU texture per frame, the mask
 * retessellated per frame, and clearRect before every full-frame draw.
 *
 * Exists so the three fixes can be ATTRIBUTED. Comparing across bench sessions
 * would not do: this machine drifts more between sessions than the fixes are
 * worth, which is the failure mode this whole investigation keeps tripping over.
 * With the flag, one interleaved run measures old against new on one thermal
 * state, and the repeat proves it.
 *
 *   localStorage.setItem("openscreen.legacyCompositor", "1")
 */
function legacyCompositorRequested(): boolean {
	try {
		return localStorage.getItem("openscreen.legacyCompositor") === "1";
	} catch {
		return false;
	}
}

/**
 * Diagnostic: run the shadow's cache-miss path but SKIP the filter chain.
 *
 * A cache miss costs 16.7 ms/frame (Annex B), and that number is two different
 * things stacked: three chained gaussians, and the full-frame Canvas2D plumbing
 * that feeds them (a silhouette copy, a source-in fill, a filtered blit — 2 Mpx
 * each). They do not have the same fix. A shader only helps if the gaussians are
 * the cost; if it is the plumbing, the fix is to stop touching the whole frame.
 *
 * Timing the ops individually would answer nothing — Canvas2D is as lazy as the
 * GPU, so a timer around a drawImage measures submission and bills the work to
 * whatever syncs next (§7.4). Hence a flag and an arm PAIR instead: same path,
 * one filter, one none, both fenced.
 *
 * The output is wrong on purpose (no shadow is drawn). Diagnostic only.
 *
 *   localStorage.setItem("openscreen.shadowNoFilter", "1")
 */
function shadowFilterDisabled(): boolean {
	try {
		return localStorage.getItem("openscreen.shadowNoFilter") === "1";
	} catch {
		return false;
	}
}

/**
 * The recording's drop shadow, as a CSS filter chain.
 *
 * Three chained shadows, each blurring the alpha of the PREVIOUS stage's output
 * (its own shadow included) — that cascade is what gives the falloff, and it is
 * why this cannot be swapped for an SDF without changing the picture.
 *
 * Was duplicated verbatim on the flat and the 3D path; they must not drift.
 */
function shadowFilterChain(intensity: number): string {
	const offset = 12 * intensity;
	return (
		`drop-shadow(0 ${offset}px ${48 * intensity}px rgba(0,0,0,${0.7 * intensity})) ` +
		`drop-shadow(0 ${offset / 3}px ${16 * intensity}px rgba(0,0,0,${0.5 * intensity})) ` +
		`drop-shadow(0 ${offset / 6}px ${8 * intensity}px rgba(0,0,0,${0.3 * intensity}))`
	);
}

interface FrameRenderConfig {
	width: number;
	height: number;
	wallpaper: string;
	zoomRegions: ZoomRegion[];
	cameraFullscreenRegions?: CameraFullscreenRegion[];
	showShadow: boolean;
	shadowIntensity: number;
	showBlur: boolean;
	motionBlurAmount?: number;
	borderRadius?: number;
	padding?: number;
	cropRegion: CropRegion;
	cursorRecordingData?: CursorRecordingData | null;
	cursorScale?: number;
	cursorSmoothing?: number;
	cursorMotionBlur?: number;
	cursorClickBounce?: number;
	cursorClipToBounds?: boolean;
	cursorTheme?: string;
	videoWidth: number;
	videoHeight: number;
	webcamSize?: Size | null;
	webcamLayoutPreset?: WebcamLayoutPreset;
	webcamMaskShape?: import("@/components/video-editor/types").WebcamMaskShape;
	webcamMirrored?: boolean;
	webcamReactiveZoom?: boolean;
	webcamSizePreset?: WebcamSizePreset;
	webcamPosition?: { cx: number; cy: number } | null;
	annotationRegions?: AnnotationRegion[];
	speedRegions?: SpeedRegion[];
	previewWidth?: number;
	previewHeight?: number;
	cursorTelemetry?: import("@/components/video-editor/types").CursorTelemetryPoint[];
	cursorClickTimestamps?: number[];
	platform: string;
}

interface AnimationState {
	scale: number;
	focusX: number;
	focusY: number;
	progress: number;
	x: number;
	y: number;
	appliedScale: number;
	cameraFullscreenProgress: number;
}

interface LayoutCache {
	stageSize: { width: number; height: number };
	videoSize: { width: number; height: number };
	baseScale: number;
	baseOffset: { x: number; y: number };
	maskRect: { x: number; y: number; width: number; height: number };
	croppedRect: { x: number; y: number; width: number; height: number };
	maskBorderRadius: number;
	webcamRect: StyledRenderRect | null;
}

// Renders video frames with all effects (background, zoom, crop, blur, shadow) to an offscreen canvas for export.

export class FrameRenderer {
	private app: Application | null = null;
	private cameraContainer: Container | null = null;
	private videoContainer: Container | null = null;
	private videoSprite: Sprite | null = null;
	/** Source geometry behind videoSprite's texture — see renderFrame's reuse. */
	private videoFrameSize: { width: number; height: number } | null = null;
	/** Shape currently tessellated into maskGraphics, so it is rebuilt only on change. */
	private maskShape: { width: number; height: number; radius: number } | null = null;
	/** Bench-only: undo the compositor fixes so they can be measured. */
	private legacyCompositor = legacyCompositorRequested();
	/** Bench-only: price the filter chain apart from the plumbing feeding it. */
	private shadowNoFilter = shadowFilterDisabled();
	/** Shadow filter output, keyed by the geometry it was computed for. */
	private shadowCache: { key: string; canvas: HTMLCanvasElement } | null = null;
	/**
	 * How often the geometry key held, and how often it paid for the filter chain.
	 *
	 * The miss rate IS the Step-3 decision input (see rendering-architecture.md
	 * §13): the cache captures the shadow's cost on still frames, and a moving
	 * camera must miss by design. Only a count says which case a real timeline is.
	 */
	private shadowCacheHits = 0;
	private shadowCacheMisses = 0;
	/** Scratch holding videoCanvas's alpha as an opaque black shape. */
	private shadowSilhouetteCanvas: HTMLCanvasElement | null = null;
	/** The wallpaper, blurred once. It is a still image — see blurredBackgroundLayer. */
	private blurredBackground: HTMLCanvasElement | null = null;
	/** Which backgroundSprite blurredBackground was built from, so a reload invalidates it. */
	private blurredBackgroundSource: HTMLCanvasElement | null = null;
	private backgroundSprite: HTMLCanvasElement | null = null;
	private maskGraphics: Graphics | null = null;
	private blurFilter: BlurFilter | null = null;
	private motionBlurFilter: MotionBlurFilter | null = null;
	private shadowCanvas: HTMLCanvasElement | null = null;
	private shadowCtx: CanvasRenderingContext2D | null = null;
	private compositeCanvas: HTMLCanvasElement | null = null;
	private compositeCtx: CanvasRenderingContext2D | null = null;
	private foregroundCanvas: HTMLCanvasElement | null = null;
	private foregroundCtx: CanvasRenderingContext2D | null = null;
	private rasterCanvas: HTMLCanvasElement | null = null;
	private rasterCtx: CanvasRenderingContext2D | null = null;
	private threeDPass: ThreeDPass | null = null;
	private currentRotation3D: Rotation3D = { ...DEFAULT_ROTATION_3D };
	private cursorImageCache = new Map<string, HTMLImageElement>();
	private warnedKeys = new Set<string>();
	private config: FrameRenderConfig;
	private animationState: AnimationState;
	private layoutCache: LayoutCache | null = null;
	private currentVideoTime = 0;
	private motionBlurState: MotionBlurState = createMotionBlurState();
	private nativeCursorMotionBlurState = createNativeCursorMotionBlurState();
	private smoothedAutoFocus: { cx: number; cy: number } | null = null;
	private prevAnimationTimeMs: number | null = null;
	private zoomSpringState = createZoomSpringState();
	private prevTargetProgress = 0;
	private isLinux = false;
	/** CPU-backed 2D canvases — see cpuCanvasRequested(). Fixed per instance. */
	private cpuCanvas = false;

	constructor(config: FrameRenderConfig) {
		this.config = config;
		this.isLinux = config.platform === "linux";
		this.cpuCanvas = this.isLinux || cpuCanvasRequested();
		this.animationState = {
			scale: 1,
			focusX: DEFAULT_FOCUS.cx,
			focusY: DEFAULT_FOCUS.cy,
			progress: 0,
			x: 0,
			y: 0,
			appliedScale: 1,
			cameraFullscreenProgress: 0,
		};
	}

	/**
	 * Swaps the active crop before rendering the next frame — crop is per-clip
	 * (see clipSchema.cropRegion), not a single value for the whole export.
	 * `updateLayout()` (called at the top of every `renderFrame`) reads
	 * `this.config.cropRegion` fresh each time, and the cursor overlay does
	 * the same, so mutating it here is picked up correctly by both without
	 * any extra cache invalidation.
	 */
	setCropRegion(cropRegion: CropRegion): void {
		this.config.cropRegion = cropRegion;
	}

	/**
	 * Reconfigure the renderer's INPUT for the next segment of a multi-asset
	 * export (v2 segment loop). Output dimensions stay fixed for the whole
	 * export; only the source-dependent fields change. `updateLayout()` reads
	 * these from `this.config` fresh every frame and `renderFrame` swaps the
	 * video texture per frame, so mutating config here is picked up with no
	 * teardown. Virtual-time zoom/annotation state is intentionally preserved
	 * (those effects span segments), but per-source cursor/auto-focus continuity
	 * is reset so a new asset doesn't inherit the previous one's smoothed motion.
	 */
	setSource(source: {
		videoWidth: number;
		videoHeight: number;
		webcamSize?: Size | null;
		cursorRecordingData?: CursorRecordingData | null;
		cursorScale?: number;
		// Timeline-authored effects PROJECTED to this segment's SOURCE time — the
		// export loop passes each frame its source timestamp, so zoom/annotation
		// (and cursor samples) all match in one coordinate system even under speed.
		zoomRegions?: ZoomRegion[];
		annotationRegions?: AnnotationRegion[];
		speedRegions?: SpeedRegion[];
	}): void {
		this.config.videoWidth = source.videoWidth;
		this.config.videoHeight = source.videoHeight;
		this.config.webcamSize = source.webcamSize ?? null;
		this.config.cursorRecordingData = source.cursorRecordingData ?? null;
		this.config.cursorScale = source.cursorScale ?? 0;
		if (source.zoomRegions) this.config.zoomRegions = source.zoomRegions;
		if (source.annotationRegions) this.config.annotationRegions = source.annotationRegions;
		if (source.speedRegions) this.config.speedRegions = source.speedRegions;
		this.layoutCache = null;
		this.smoothedAutoFocus = null;
		this.zoomSpringState = createZoomSpringState();
		this.prevAnimationTimeMs = null;
		resetNativeCursorMotionBlurState(this.nativeCursorMotionBlurState);
	}

	async initialize(): Promise<void> {
		const canvas = document.createElement("canvas");
		canvas.width = this.config.width;
		canvas.height = this.config.height;

		// colorSpace isn't available on all platforms
		try {
			if (canvas && "colorSpace" in canvas) {
				canvas.colorSpace = "srgb";
			}
		} catch (error) {
			console.warn("[FrameRenderer] colorSpace not supported on this platform:", error);
		}

		this.app = new Application();
		await this.app.init({
			canvas,
			width: this.config.width,
			height: this.config.height,
			backgroundAlpha: 0,
			antialias: true,
			resolution: 1,
			autoDensity: true,
		});

		this.cameraContainer = new Container();
		this.videoContainer = new Container();
		this.app.stage.addChild(this.cameraContainer);
		this.cameraContainer.addChild(this.videoContainer);

		// Background renders separately, not in PixiJS
		await this.setupBackground();

		this.blurFilter = new BlurFilter();
		this.blurFilter.quality = 5;
		this.blurFilter.resolution = this.app.renderer.resolution;
		this.blurFilter.blur = 0;
		this.motionBlurFilter = new MotionBlurFilter([0, 0], 5, 0);
		this.videoContainer.filters = [this.blurFilter, this.motionBlurFilter];

		// Composite canvas: final output with shadows
		this.compositeCanvas = document.createElement("canvas");
		this.compositeCanvas.width = this.config.width;
		this.compositeCanvas.height = this.config.height;

		// Hint frequent CPU readback: Linux exports via getImageData every frame,
		// and so does the native encoder path (see cpuCanvasRequested).
		this.compositeCtx = this.compositeCanvas.getContext("2d", {
			willReadFrequently: this.cpuCanvas,
		});

		if (!this.compositeCtx) {
			throw new Error("Failed to get 2D context for composite canvas");
		}

		// willReadFrequently is a HINT: report what Chromium actually granted, not
		// what we asked for. An arm that silently no-ops would otherwise read as
		// "the lever does not help" when it means "the lever was never pulled".
		console.warn(
			`[export perf] canvas requested willReadFrequently=${this.cpuCanvas} granted=${
				this.compositeCtx.getContextAttributes?.()?.willReadFrequently
			}`,
		);

		this.rasterCanvas = document.createElement("canvas");
		this.rasterCanvas.width = this.config.width;
		this.rasterCanvas.height = this.config.height;
		this.rasterCtx = this.rasterCanvas.getContext("2d");
		if (!this.rasterCtx) {
			throw new Error("Failed to get 2D context for raster canvas");
		}

		// Foreground (transparent): recording + shadow + webcam + cursor + annotations.
		// The 3D pass operates only on this layer so the wallpaper stays flat behind it.
		this.foregroundCanvas = document.createElement("canvas");
		this.foregroundCanvas.width = this.config.width;
		this.foregroundCanvas.height = this.config.height;
		// Flips WITH the composite canvas, never against it: a GPU-backed
		// foreground drawn onto a CPU-backed composite would force its own
		// readback on every drawImage — worse than either setting alone.
		this.foregroundCtx = this.foregroundCanvas.getContext("2d", {
			willReadFrequently: this.cpuCanvas,
		});
		if (!this.foregroundCtx) {
			throw new Error("Failed to get 2D context for foreground canvas");
		}

		if (this.config.showShadow) {
			this.shadowCanvas = document.createElement("canvas");
			this.shadowCanvas.width = this.config.width;
			this.shadowCanvas.height = this.config.height;
			this.shadowCtx = this.shadowCanvas.getContext("2d", {
				willReadFrequently: false,
			});

			if (!this.shadowCtx) {
				throw new Error("Failed to get 2D context for shadow canvas");
			}
		}

		this.maskGraphics = new Graphics();
		this.videoContainer.addChild(this.maskGraphics);
		this.videoContainer.mask = this.maskGraphics;

		try {
			this.threeDPass = createThreeDPass(this.config.width, this.config.height);
		} catch (error) {
			console.warn("[FrameRenderer] 3D pass unavailable, rotation fields will be ignored:", error);
			this.threeDPass = null;
		}
	}

	private async setupBackground(): Promise<void> {
		const wallpaper = this.config.wallpaper;

		const bgCanvas = document.createElement("canvas");
		bgCanvas.width = this.config.width;
		bgCanvas.height = this.config.height;
		const bgCtx = bgCanvas.getContext("2d")!;

		const classified = classifyWallpaper(wallpaper);

		if (classified.kind === "color") {
			bgCtx.fillStyle = classified.value;
			bgCtx.fillRect(0, 0, this.config.width, this.config.height);
		} else if (classified.kind === "gradient") {
			const parsedGradient = parseCssGradient(classified.value);
			if (!parsedGradient) {
				throw new BackgroundLoadError(classified.value);
			}
			const gradient =
				parsedGradient.type === "linear"
					? (() => {
							const points = getLinearGradientPoints(
								resolveLinearGradientAngle(parsedGradient.descriptor),
								this.config.width,
								this.config.height,
							);
							return bgCtx.createLinearGradient(points.x0, points.y0, points.x1, points.y1);
						})()
					: (() => {
							const shape = getRadialGradientShape(
								parsedGradient.descriptor,
								this.config.width,
								this.config.height,
							);
							return bgCtx.createRadialGradient(
								shape.cx,
								shape.cy,
								0,
								shape.cx,
								shape.cy,
								shape.radius,
							);
						})();

			parsedGradient.stops.forEach((stop) => {
				gradient.addColorStop(stop.offset, stop.color);
			});

			bgCtx.fillStyle = gradient;
			bgCtx.fillRect(0, 0, this.config.width, this.config.height);
		} else {
			const imageUrl = resolveImageWallpaperUrl(classified.path);
			const img = new Image();
			if (imageUrl.startsWith("http") && !imageUrl.startsWith(window.location.origin)) {
				img.crossOrigin = "anonymous";
			}

			try {
				await new Promise<void>((resolve, reject) => {
					img.onload = () => resolve();
					img.onerror = (err) => reject(err);
					img.src = imageUrl;
				});
			} catch (err) {
				throw new BackgroundLoadError(imageUrl, err);
			}

			const imgAspect = img.width / img.height;
			const canvasAspect = this.config.width / this.config.height;

			let drawWidth: number;
			let drawHeight: number;
			let drawX: number;
			let drawY: number;

			if (imgAspect > canvasAspect) {
				drawHeight = this.config.height;
				drawWidth = drawHeight * imgAspect;
				drawX = (this.config.width - drawWidth) / 2;
				drawY = 0;
			} else {
				drawWidth = this.config.width;
				drawHeight = drawWidth / imgAspect;
				drawX = 0;
				drawY = (this.config.height - drawHeight) / 2;
			}

			bgCtx.drawImage(img, drawX, drawY, drawWidth, drawHeight);
		}

		this.backgroundSprite = bgCanvas;
	}

	async renderFrame(
		videoFrame: VideoFrame,
		timestamp: number,
		webcamFrame?: VideoFrame | null,
	): Promise<void> {
		if (!this.app || !this.videoContainer || !this.cameraContainer) {
			throw new Error("Renderer not initialized");
		}

		this.currentVideoTime = timestamp / 1000000;

		// Reuse the GPU texture across frames. Texture.from() allocates a new
		// TextureSource per call (every VideoFrame is a distinct object, so nothing
		// caches), and destroy(true) frees the GL texture behind it — an allocate +
		// upload + free of a 1080p texture on every single frame. Swapping the
		// resource re-uploads the pixels into the texture we already have.
		//
		// Only valid while the geometry is unchanged: segments can carry different
		// source sizes, so a size change still rebuilds (and frees) the source.
		const frameWidth = videoFrame.displayWidth;
		const frameHeight = videoFrame.displayHeight;
		const sizeUnchanged =
			!this.legacyCompositor &&
			this.videoFrameSize?.width === frameWidth &&
			this.videoFrameSize?.height === frameHeight;

		if (!this.videoSprite) {
			const texture = Texture.from(videoFrame as unknown as TextureSourceLike);
			this.videoSprite = new Sprite(texture);
			this.videoContainer.addChild(this.videoSprite);
			this.videoFrameSize = { width: frameWidth, height: frameHeight };
		} else if (sizeUnchanged) {
			const source = this.videoSprite.texture.source;
			source.resource = videoFrame;
			source.update();
		} else {
			// Destroy old texture before swapping to avoid a leak
			const oldTexture = this.videoSprite.texture;
			const newTexture = Texture.from(videoFrame as unknown as TextureSourceLike);
			this.videoSprite.texture = newTexture;
			oldTexture.destroy(true);
			this.videoFrameSize = { width: frameWidth, height: frameHeight };
		}

		this.updateLayout(webcamFrame);

		const timeMs = this.currentVideoTime * 1000;
		const TICKS_PER_FRAME = 1;

		let maxMotionIntensity = 0;
		for (let i = 0; i < TICKS_PER_FRAME; i++) {
			const motionIntensity = this.updateAnimationState(timeMs);
			maxMotionIntensity = Math.max(maxMotionIntensity, motionIntensity);
		}

		const layoutCache = this.layoutCache;
		if (!layoutCache) {
			throw new Error("Layout cache not initialized");
		}

		// Feed the spring-smoothed transform (appliedScale/x/y) via transformOverride, like the
		// preview. Without it applyZoomTransform recomputes the camera from the raw eased target and
		// the spring is discarded, so the export snaps to the target every frame while the preview
		// glides (very visible for auto-focus, whose target pans with the cursor). It also keeps the
		// camera, mask, and cursor (which already read appliedScale/x/y) consistent.
		applyZoomTransform({
			cameraContainer: this.cameraContainer,
			blurFilter: this.blurFilter,
			motionBlurFilter: this.motionBlurFilter,
			stageSize: layoutCache.stageSize,
			baseMask: layoutCache.maskRect,
			zoomScale: this.animationState.scale,
			zoomProgress: this.animationState.progress,
			focusX: this.animationState.focusX,
			focusY: this.animationState.focusY,
			motionIntensity: maxMotionIntensity,
			isPlaying: true,
			motionBlurAmount: this.config.motionBlurAmount ?? 0,
			motionBlurState: this.motionBlurState,
			frameTimeMs: timeMs,
			transformOverride: {
				scale: this.animationState.appliedScale,
				x: this.animationState.x,
				y: this.animationState.y,
			},
		});

		// Render the PixiJS stage (video only, transparent background)
		this.app.renderer.render(this.app.stage);

		// Skip baking the shadow when the rotation pass will run; bilinear sampling would
		// alias it to a hard edge. Re-applied fresh after rotation.
		const willRotate = !isRotation3DIdentity(this.currentRotation3D);
		this.compositeWithShadows(webcamFrame, !willRotate);

		await this.drawNativeCursor(timeMs);

		// Annotations go on top of foreground so they rotate with the recording
		if (
			this.config.annotationRegions &&
			this.config.annotationRegions.length > 0 &&
			this.foregroundCtx
		) {
			const previewWidth = this.config.previewWidth ?? this.config.width;
			const previewHeight = this.config.previewHeight ?? this.config.height;
			const scaleX = this.config.width / previewWidth;
			const scaleY = this.config.height / previewHeight;
			const scaleFactor = (scaleX + scaleY) / 2;

			await renderAnnotations(
				this.foregroundCtx,
				this.config.annotationRegions,
				this.config.width,
				this.config.height,
				timeMs,
				scaleFactor,
			);
		}

		// Rotate foreground only; wallpaper (on compositeCanvas) stays untouched
		if (willRotate && this.threeDPass && this.foregroundCanvas && this.foregroundCtx) {
			const passCanvas = this.threeDPass.apply(this.foregroundCanvas, this.currentRotation3D);
			const w = this.foregroundCanvas.width;
			const h = this.foregroundCanvas.height;
			this.foregroundCtx.clearRect(0, 0, w, h);
			if (this.isLinux) {
				// drawImage(webglCanvas) is unreliable on Linux/Wayland, so use readPixels
				const pixels = this.threeDPass.readPixels();
				const imageData = this.foregroundCtx.createImageData(w, h);
				imageData.data.set(pixels);
				this.foregroundCtx.putImageData(imageData, 0, 0);
			} else {
				this.foregroundCtx.drawImage(passCanvas, 0, 0);
			}
		}

		// Apply shadow fresh on the rotated silhouette. Flat path already baked it in
		// compositeWithShadows, so guard on willRotate to avoid doubling. Same 3-layer
		// filter chain as the flat path to keep the soft Gaussian intact.
		if (
			willRotate &&
			this.config.showShadow &&
			this.config.shadowIntensity > 0 &&
			this.shadowCanvas &&
			this.shadowCtx &&
			this.foregroundCanvas
		) {
			const shadowCtx = this.shadowCtx;
			const w = this.foregroundCanvas.width;
			const h = this.foregroundCanvas.height;
			shadowCtx.clearRect(0, 0, w, h);
			shadowCtx.save();
			// NOT cacheable, unlike the flat path: this blurs foregroundCanvas, whose
			// alpha carries the webcam, the cursor and the annotations — it changes
			// every frame, so there is no geometry to key on. The 3D path stays at
			// full price until it is restructured.
			shadowCtx.filter = shadowFilterChain(this.config.shadowIntensity);
			shadowCtx.drawImage(this.foregroundCanvas, 0, 0, w, h);
			shadowCtx.restore();
			if (this.compositeCtx) {
				this.compositeCtx.drawImage(this.shadowCanvas, 0, 0);
			}
		} else if (this.compositeCtx && this.foregroundCanvas) {
			// Flat path or 3D-without-shadow: stamp foreground directly
			this.compositeCtx.drawImage(this.foregroundCanvas, 0, 0);
		}
	}

	// Video's on-screen boundary including the zoom camera transform. The PIXI mask
	// lives inside cameraContainer, so during zoom the visible video extends beyond
	// the static maskRect and a static clip would crop it. Mirrors the preview.
	private cameraAwareMaskRect() {
		if (!this.layoutCache) return null;
		const { x: maskX, y: maskY, width: maskW, height: maskH } = this.layoutCache.maskRect;
		const camS = this.animationState.appliedScale;
		const camX = this.animationState.x;
		const camY = this.animationState.y;
		// No stage clamping: the canvas clips to its own bounds, matching CSS inset().
		// Clamping x/y would pin rounded corners to the stage edge instead of the true
		// mask boundary, mismatching preview/export when zoom/pan pushes the mask off-stage.
		return {
			x: camX + camS * maskX,
			y: camY + camS * maskY,
			width: camS * maskW,
			height: camS * maskH,
			br: this.layoutCache.maskBorderRadius * camS,
		};
	}

	private async drawNativeCursor(timeMs: number) {
		if (!this.foregroundCtx || !this.layoutCache) {
			return;
		}

		if ((this.config.cursorScale ?? 1) <= 0) {
			resetNativeCursorMotionBlurState(this.nativeCursorMotionBlurState);
			return;
		}

		const activeNativeCursor = resolveInterpolatedNativeCursorFrame(
			this.config.cursorRecordingData,
			timeMs,
		);
		if (!activeNativeCursor) {
			resetNativeCursorMotionBlurState(this.nativeCursorMotionBlurState);
			return;
		}
		// Position comes from the precomputed smoothed path (deterministic, matches preview);
		// the frame still supplies the cursor image, type, and click timing.
		const smoothedPos = getSmoothedCursorPath(
			this.config.cursorRecordingData,
			this.config.cursorSmoothing ?? 0,
		)?.sampleAt(timeMs);
		const displaySample = smoothedPos
			? { ...activeNativeCursor.sample, cx: smoothedPos.cx, cy: smoothedPos.cy }
			: activeNativeCursor.sample;

		const projectedPoint = projectNativeCursorToLocal({
			cropRegion: this.config.cropRegion,
			maskRect: this.layoutCache.croppedRect,
			sample: displaySample,
		});
		if (!projectedPoint) {
			resetNativeCursorMotionBlurState(this.nativeCursorMotionBlurState);
			return;
		}

		const renderAsset = resolveNativeCursorRenderAsset(
			activeNativeCursor.asset,
			1,
			displaySample,
			this.config.cursorTheme,
		);
		let image: HTMLImageElement;
		try {
			image = await this.getCursorImage(renderAsset);
		} catch (error) {
			this.warnOnce("native-cursor-image-load", "Failed to load native cursor asset", error);
			return;
		}
		const scale =
			Math.max(0, this.config.cursorScale ?? 1) *
			getNativeCursorClickBounceScale(
				this.config.cursorClickBounce ?? 0,
				getNativeCursorClickBounceProgress(this.config.cursorRecordingData, timeMs),
			);
		const appliedScale = this.animationState.appliedScale;
		// Normalize cursor size to croppedRect.width (the painted video width).
		// The preview path still uses screenRect.width; they agree in cover mode but
		// differ in fit-to-height letterbox — known asymmetry pending the preview-path
		// follow-up to project the cursor onto the cropped sub-rect as well.
		const sizeNorm =
			this.layoutCache.videoSize.width > 0
				? this.layoutCache.maskRect.width / this.layoutCache.videoSize.width
				: 1;
		const canvasX = projectedPoint.x * appliedScale + this.animationState.x;
		const canvasY = projectedPoint.y * appliedScale + this.animationState.y;
		const blurPx = getNativeCursorMotionBlurPx({
			motionBlur: this.config.cursorMotionBlur ?? 0,
			point: { x: canvasX, y: canvasY },
			state: this.nativeCursorMotionBlurState,
			timeMs,
		});
		// Clip only when explicitly enabled; by default the cursor may overflow the canvas
		const cursorClip = this.config.cursorClipToBounds === true ? this.cameraAwareMaskRect() : null;
		this.foregroundCtx.save();
		this.foregroundCtx.beginPath();
		if (cursorClip) {
			this.foregroundCtx.roundRect(
				cursorClip.x,
				cursorClip.y,
				cursorClip.width,
				cursorClip.height,
				cursorClip.br,
			);
			this.foregroundCtx.clip();
		}
		const previousFilter = this.foregroundCtx.filter;
		if (blurPx > 0) {
			this.foregroundCtx.filter = `blur(${blurPx.toFixed(2)}px)`;
		}
		this.foregroundCtx.drawImage(
			image,
			canvasX - renderAsset.hotspotX * scale * appliedScale * sizeNorm,
			canvasY - renderAsset.hotspotY * scale * appliedScale * sizeNorm,
			renderAsset.width * scale * appliedScale * sizeNorm,
			renderAsset.height * scale * appliedScale * sizeNorm,
		);
		this.foregroundCtx.filter = previousFilter;
		this.foregroundCtx.restore();
	}

	private async getCursorImage(asset: { id: string; imageDataUrl: string }) {
		const cachedImage = this.cursorImageCache.get(asset.id);
		if (cachedImage) {
			return cachedImage;
		}

		const image = new Image();
		await new Promise<void>((resolve, reject) => {
			image.onload = () => resolve();
			image.onerror = () => reject(new Error(`Failed to load cursor asset ${asset.id}`));
			image.src = asset.imageDataUrl;
		});

		this.cursorImageCache.set(asset.id, image);
		return image;
	}

	private warnOnce(key: string, message: string, error: unknown) {
		if (this.warnedKeys.has(key)) {
			return;
		}
		this.warnedKeys.add(key);
		console.warn(`[FrameRenderer] ${message}:`, error);
	}

	private updateLayout(webcamFrame?: VideoFrame | null): void {
		if (!this.app || !this.videoSprite || !this.maskGraphics || !this.videoContainer) return;

		const { width, height } = this.config;
		const { cropRegion, borderRadius = 0, padding = 0 } = this.config;
		const videoWidth = this.config.videoWidth;
		const videoHeight = this.config.videoHeight;

		const cropStartX = cropRegion.x;
		const cropStartY = cropRegion.y;
		const cropEndX = cropRegion.x + cropRegion.width;
		const cropEndY = cropRegion.y + cropRegion.height;

		const croppedVideoWidth = videoWidth * (cropEndX - cropStartX);
		const croppedVideoHeight = videoHeight * (cropEndY - cropStartY);

		// Padding is a percentage (0-100), where 50% ~ 0.8 scale.
		// Vertical stack is full-bleed, so it ignores padding.
		const effectivePadding = this.config.webcamLayoutPreset === "vertical-stack" ? 0 : padding;
		const paddingScale = 1.0 - (effectivePadding / 100) * 0.4;
		const viewportWidth = width * paddingScale;
		const viewportHeight = height * paddingScale;
		const compositeLayout = computeCompositeLayout({
			canvasSize: { width, height },
			maxContentSize: { width: viewportWidth, height: viewportHeight },
			screenSize: { width: croppedVideoWidth, height: croppedVideoHeight },
			webcamSize: webcamFrame ? this.config.webcamSize : null,
			layoutPreset: this.config.webcamLayoutPreset,
			webcamSizePreset: this.config.webcamSizePreset,
			webcamPosition: this.config.webcamPosition,
			webcamMaskShape: this.config.webcamMaskShape,
		});
		if (!compositeLayout) return;

		const screenRect = compositeLayout.screenRect;

		// Cover mode scales to fill the rect (may crop), otherwise fit-to-width
		let scale: number;
		if (compositeLayout.screenCover) {
			scale = Math.max(
				screenRect.width / croppedVideoWidth,
				screenRect.height / croppedVideoHeight,
			);
		} else {
			scale = screenRect.width / croppedVideoWidth;
		}

		this.videoSprite.width = videoWidth * scale;
		this.videoSprite.height = videoHeight * scale;

		// Center the cropped region within the screenRect
		const croppedDisplayWidth = croppedVideoWidth * scale;
		const croppedDisplayHeight = croppedVideoHeight * scale;
		const coverOffsetX = (screenRect.width - croppedDisplayWidth) / 2;
		const coverOffsetY = (screenRect.height - croppedDisplayHeight) / 2;

		const cropPixelX = cropStartX * videoWidth * scale;
		const cropPixelY = cropStartY * videoHeight * scale;
		this.videoSprite.x = -cropPixelX + coverOffsetX;
		this.videoSprite.y = -cropPixelY + coverOffsetY;

		this.videoContainer.x = screenRect.x;
		this.videoContainer.y = screenRect.y;

		// Scale border radius by the export/preview canvas ratio
		const previewWidth = this.config.previewWidth ?? this.config.width;
		const previewHeight = this.config.previewHeight ?? this.config.height;
		const canvasScaleFactor = Math.min(width / previewWidth, height / previewHeight);
		const scaledBorderRadius =
			compositeLayout.screenBorderRadius != null
				? compositeLayout.screenBorderRadius
				: compositeLayout.screenCover
					? 0
					: borderRadius * canvasScaleFactor;

		// Retessellate only when the shape actually changes. The mask is a rounded
		// rect: while nothing zooms or resizes it is byte-identical from frame to
		// frame, and clear()/roundRect()/fill() rebuilds its geometry every time.
		// A zoom easing does change it per frame — that is the case this cannot help.
		if (
			this.legacyCompositor ||
			this.maskShape?.width !== screenRect.width ||
			this.maskShape?.height !== screenRect.height ||
			this.maskShape?.radius !== scaledBorderRadius
		) {
			this.maskGraphics.clear();
			this.maskGraphics.roundRect(0, 0, screenRect.width, screenRect.height, scaledBorderRadius);
			this.maskGraphics.fill({ color: 0xffffff });
			this.maskShape = {
				width: screenRect.width,
				height: screenRect.height,
				radius: scaledBorderRadius,
			};
		}

		// baseOffset is the stage position of the full (uncropped) sprite's top-left, matching
		// preview semantics, so consumers (e.g. cursor highlight) can map normalized
		// recording-space coords to stage coords uniformly:
		//   stagePos = baseOffset + (cx, cy) * (videoWidth, videoHeight) * baseScale
		this.layoutCache = {
			stageSize: { width, height },
			videoSize: { width: croppedVideoWidth, height: croppedVideoHeight },
			baseScale: scale,
			baseOffset: {
				x: compositeLayout.screenRect.x + coverOffsetX - cropPixelX,
				y: compositeLayout.screenRect.y + coverOffsetY - cropPixelY,
			},
			maskRect: compositeLayout.screenRect,
			croppedRect: {
				x: compositeLayout.screenRect.x + coverOffsetX,
				y: compositeLayout.screenRect.y + coverOffsetY,
				width: croppedDisplayWidth,
				height: croppedDisplayHeight,
			},
			maskBorderRadius: scaledBorderRadius,
			webcamRect: compositeLayout.webcamRect,
		};
	}

	private updateAnimationState(timeMs: number): number {
		if (!this.cameraContainer || !this.layoutCache) return 0;

		this.animationState.cameraFullscreenProgress = computeCameraFullscreenProgress(
			this.config.cameraFullscreenRegions ?? [],
			timeMs,
		);

		const { region, strength, blendedScale, rotation3D, transition } = findDominantRegion(
			this.config.zoomRegions,
			timeMs,
			{ connectZooms: true, cursorTelemetry: this.config.cursorTelemetry },
		);

		const defaultFocus = DEFAULT_FOCUS;
		let targetScaleFactor = 1;
		let targetFocus = { ...defaultFocus };
		let targetProgress = 0;

		this.currentRotation3D =
			region && strength > 0
				? lerpRotation3D(DEFAULT_ROTATION_3D, rotation3D, strength)
				: { ...DEFAULT_ROTATION_3D };

		if (region && strength > 0) {
			const zoomScale = blendedScale ?? getZoomScale(region);
			const regionFocus = clampFocusToScale(region.focus, zoomScale);

			targetScaleFactor = zoomScale;
			targetFocus = regionFocus;
			targetProgress = strength;

			// Adaptive smoothing for auto-follow mode
			if (region.focusMode === "auto" && !transition) {
				const raw = targetFocus;
				const dtMs = this.prevAnimationTimeMs != null ? timeMs - this.prevAnimationTimeMs : 0;
				const isZoomingIn = targetProgress < 0.999 && targetProgress >= this.prevTargetProgress;
				if (targetProgress >= 0.999) {
					// Full zoom: move faster when far, decelerate when close
					const prev = this.smoothedAutoFocus ?? raw;
					const smoothed = advanceFollowFocus(prev, raw, dtMs, AUTO_FOLLOW_PARAMS);
					this.smoothedAutoFocus = smoothed;
					targetFocus = smoothed;
				} else if (isZoomingIn) {
					// Track cursor directly while zooming in; keep ref in sync to avoid a snap
					// when full-zoom begins
					this.smoothedAutoFocus = raw;
				} else {
					// Zoom-out: keep smoothing to avoid a snap at the start
					const prev = this.smoothedAutoFocus ?? raw;
					const smoothed = advanceFollowFocus(prev, raw, dtMs, AUTO_FOLLOW_PARAMS);
					this.smoothedAutoFocus = smoothed;
					targetFocus = smoothed;
				}
			} else if (region.focusMode !== "auto") {
				this.smoothedAutoFocus = null;
			}
			this.prevTargetProgress = targetProgress;

			if (transition) {
				const startTransform = computeZoomTransform({
					stageSize: this.layoutCache.stageSize,
					baseMask: this.layoutCache.maskRect,
					zoomScale: transition.startScale,
					zoomProgress: 1,
					focusX: transition.startFocus.cx,
					focusY: transition.startFocus.cy,
				});
				const endTransform = computeZoomTransform({
					stageSize: this.layoutCache.stageSize,
					baseMask: this.layoutCache.maskRect,
					zoomScale: transition.endScale,
					zoomProgress: 1,
					focusX: transition.endFocus.cx,
					focusY: transition.endFocus.cy,
				});

				const interpolatedTransform = {
					scale:
						startTransform.scale +
						(endTransform.scale - startTransform.scale) * transition.progress,
					x: startTransform.x + (endTransform.x - startTransform.x) * transition.progress,
					y: startTransform.y + (endTransform.y - startTransform.y) * transition.progress,
				};

				targetScaleFactor = interpolatedTransform.scale;
				targetFocus = computeFocusFromTransform({
					stageSize: this.layoutCache.stageSize,
					baseMask: this.layoutCache.maskRect,
					zoomScale: interpolatedTransform.scale,
					x: interpolatedTransform.x,
					y: interpolatedTransform.y,
				});
				targetProgress = 1;
			}
		}

		const state = this.animationState;

		const prevScale = state.appliedScale;
		const prevX = state.x;
		const prevY = state.y;

		state.scale = targetScaleFactor;
		state.focusX = targetFocus.cx;
		state.focusY = targetFocus.cy;
		state.progress = targetProgress;

		const projectedTransform = computeZoomTransform({
			stageSize: this.layoutCache.stageSize,
			baseMask: this.layoutCache.maskRect,
			zoomScale: state.scale,
			zoomProgress: state.progress,
			focusX: state.focusX,
			focusY: state.focusY,
		});

		// Spring-chase the eased target (same as preview) so exported motion glides past the jerk
		// at the steep start of the ease. Stepped by content time; snapped on the first frame or
		// any large time jump.
		const dtMs = this.prevAnimationTimeMs != null ? timeMs - this.prevAnimationTimeMs : 0;
		let appliedScale: number;
		let appliedX: number;
		let appliedY: number;
		if (this.prevAnimationTimeMs == null || dtMs <= 0 || dtMs > 80) {
			resetZoomSpring(this.zoomSpringState, projectedTransform);
			appliedScale = projectedTransform.scale;
			appliedX = projectedTransform.x;
			appliedY = projectedTransform.y;
		} else {
			const sprung = stepZoomSpring(this.zoomSpringState, projectedTransform, dtMs);
			appliedScale = sprung.scale;
			appliedX = sprung.x;
			appliedY = sprung.y;
		}

		state.x = appliedX;
		state.y = appliedY;
		state.appliedScale = appliedScale;

		this.prevAnimationTimeMs = timeMs;

		return Math.max(
			Math.abs(appliedScale - prevScale),
			Math.abs(appliedX - prevX) / Math.max(1, this.layoutCache.stageSize.width),
			Math.abs(appliedY - prevY) / Math.max(1, this.layoutCache.stageSize.height),
		);
	}

	// On Linux/Wayland the implicit GPU-to-2D texture-sharing path behind
	// drawImage(webglCanvas) can fail silently (EGL/Ozone), giving green/empty
	// frames. gl.readPixels copies GPU to CPU directly, bypassing that path.
	private readbackVideoCanvas(): HTMLCanvasElement {
		const glCanvas = this.app!.canvas as HTMLCanvasElement;
		const gl =
			(glCanvas.getContext("webgl2") as WebGL2RenderingContext | null) ??
			(glCanvas.getContext("webgl") as WebGLRenderingContext | null);

		if (!gl || !this.rasterCanvas || !this.rasterCtx) {
			return glCanvas;
		}

		const w = glCanvas.width;
		const h = glCanvas.height;
		const buf = new Uint8Array(w * h * 4);
		gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);

		// readPixels returns rows bottom-to-top; flip vertically
		const rowSize = w * 4;
		const temp = new Uint8Array(rowSize);
		for (let top = 0, bot = h - 1; top < bot; top++, bot--) {
			const tOff = top * rowSize;
			const bOff = bot * rowSize;
			temp.set(buf.subarray(tOff, tOff + rowSize));
			buf.copyWithin(tOff, bOff, bOff + rowSize);
			buf.set(temp, bOff);
		}

		const imageData = new ImageData(new Uint8ClampedArray(buf.buffer), w, h);
		this.rasterCtx.putImageData(imageData, 0, 0);

		return this.rasterCanvas;
	}

	// applyShadowToRecording is false when the 3D pass will rotate this canvas next;
	// the shadow is re-applied after rotation to avoid aliasing.
	/**
	 * The wallpaper, blurred once instead of 1418 times.
	 *
	 * backgroundSprite is rasterised once at load and never touched again — it is
	 * a still image. Blurring it per frame recomputes an identical result every
	 * time; measured at ~5 ms/frame.
	 *
	 * Byte-identical by construction: the original blurs while scaling to w*h, so
	 * the blur lands in destination space. Doing that once into a w*h canvas and
	 * blitting it 1:1 is the same operation, hoisted.
	 *
	 * Returns null when there is nothing to hoist (no blur), so the caller keeps
	 * drawing the sprite directly rather than through a pointless copy.
	 */
	private blurredBackgroundLayer(w: number, h: number): HTMLCanvasElement | null {
		if (!this.config.showBlur || !this.backgroundSprite || this.legacyCompositor) return null;
		// Keyed on the sprite's identity, not just the size: loading a different
		// wallpaper replaces the sprite, and a size-only check would keep serving
		// the previous one's blur.
		if (
			this.blurredBackgroundSource === this.backgroundSprite &&
			this.blurredBackground?.width === w &&
			this.blurredBackground.height === h
		) {
			return this.blurredBackground;
		}
		const canvas = document.createElement("canvas");
		canvas.width = w;
		canvas.height = h;
		const ctx = canvas.getContext("2d");
		if (!ctx) return null;
		ctx.filter = "blur(6px)"; // Canvas blur is weaker than CSS
		ctx.drawImage(this.backgroundSprite, 0, 0, w, h);
		ctx.filter = "none";
		this.blurredBackground = canvas;
		this.blurredBackgroundSource = this.backgroundSprite;
		return canvas;
	}

	/**
	 * Everything the shadow's shape depends on. If two frames agree here, the
	 * filter output is identical and re-running it is pure waste.
	 *
	 * Taken from the world transforms rather than from the layout inputs, so a
	 * new way to move the recording cannot silently bypass the cache and serve a
	 * stale shadow. A zoom easing changes this every frame — by design: that case
	 * MUST miss.
	 */
	private shadowGeometryKey(): string {
		const v = this.videoContainer?.worldTransform;
		const s = this.app?.stage?.worldTransform;
		const m = this.maskShape;
		return [
			v ? `${v.a},${v.b},${v.c},${v.d},${v.tx},${v.ty}` : "-",
			s ? `${s.a},${s.b},${s.c},${s.d},${s.tx},${s.ty}` : "-",
			m ? `${m.width},${m.height},${m.radius}` : "-",
			this.config.shadowIntensity,
		].join("|");
	}

	/**
	 * The shadow layer, rebuilt only when the geometry moves.
	 *
	 * drop-shadow reads SourceAlpha only, and videoCanvas's alpha is just the
	 * masked rounded rect — so the filter blurs 2M pixels of VIDEO to compute
	 * something that depends on nothing but the silhouette. Measured: ~30 ms per
	 * frame, twice the cost of the entire rest of the compositor.
	 *
	 * So it runs against the silhouette instead, and the silhouette is taken from
	 * videoCanvas's own alpha (source-in over black) rather than re-derived from
	 * the layout — same pixels, same anti-aliasing, nothing to keep in sync.
	 *
	 * Returns the filter output, which is `silhouette OVER shadow`: the caller
	 * draws videoCanvas on top, and it covers the silhouette exactly.
	 */
	private cachedShadowLayer(
		videoCanvas: HTMLCanvasElement,
		w: number,
		h: number,
	): HTMLCanvasElement | null {
		const key = this.shadowGeometryKey();
		if (this.shadowCache?.key === key) {
			this.shadowCacheHits++;
			return this.shadowCache.canvas;
		}
		this.shadowCacheMisses++;

		if (!this.shadowSilhouetteCanvas) {
			this.shadowSilhouetteCanvas = document.createElement("canvas");
			this.shadowSilhouetteCanvas.width = w;
			this.shadowSilhouetteCanvas.height = h;
		}
		if (!this.shadowCache) {
			const canvas = document.createElement("canvas");
			canvas.width = w;
			canvas.height = h;
			this.shadowCache = { key: "", canvas };
		}
		const silCtx = this.shadowSilhouetteCanvas.getContext("2d");
		const outCtx = this.shadowCache.canvas.getContext("2d");
		if (!silCtx || !outCtx) return null;

		// Silhouette: videoCanvas's exact alpha, filled black.
		silCtx.globalCompositeOperation = "copy";
		silCtx.drawImage(videoCanvas, 0, 0, w, h);
		silCtx.globalCompositeOperation = "source-in";
		silCtx.fillStyle = "#000";
		silCtx.fillRect(0, 0, w, h);
		silCtx.globalCompositeOperation = "source-over";

		outCtx.globalCompositeOperation = "copy";
		// Diagnostic arm: everything but the gaussians, so the pair prices them.
		if (!this.shadowNoFilter) outCtx.filter = shadowFilterChain(this.config.shadowIntensity);
		outCtx.drawImage(this.shadowSilhouetteCanvas, 0, 0, w, h);
		outCtx.filter = "none";
		outCtx.globalCompositeOperation = "source-over";

		this.shadowCache.key = key;
		return this.shadowCache.canvas;
	}

	private compositeWithShadows(
		webcamFrame: VideoFrame | null | undefined,
		applyShadowToRecording: boolean,
	): void {
		if (
			!this.compositeCanvas ||
			!this.compositeCtx ||
			!this.foregroundCanvas ||
			!this.foregroundCtx ||
			!this.app
		)
			return;

		const videoCanvas = this.isLinux
			? this.readbackVideoCanvas()
			: (this.app.canvas as HTMLCanvasElement);

		const bgCtx = this.compositeCtx;
		const fgCtx = this.foregroundCtx;
		const w = this.compositeCanvas.width;
		const h = this.compositeCanvas.height;

		// Background (compositeCanvas): wallpaper only. Stays flat, never touched by the
		// 3D rotation pass, matching the preview.
		//
		// "copy" replaces the whole destination, so the clearRect that used to
		// precede it is redundant: the draw below covers all w*h. Two full-frame
		// passes become one. It is only safe BECAUSE the draw covers everything —
		// hence the else branch below still clears explicitly.
		if (this.legacyCompositor) bgCtx.clearRect(0, 0, w, h);
		if (this.backgroundSprite) {
			const bgCanvas = this.blurredBackgroundLayer(w, h) ?? this.backgroundSprite;
			const stillNeedsBlur = this.config.showBlur && bgCanvas === this.backgroundSprite;
			bgCtx.save();
			if (!this.legacyCompositor) bgCtx.globalCompositeOperation = "copy";
			if (stillNeedsBlur) {
				bgCtx.filter = "blur(6px)"; // Canvas blur is weaker than CSS
			}
			bgCtx.drawImage(bgCanvas, 0, 0, w, h);
			bgCtx.restore();
		} else {
			// Nothing is drawn, so this is the only thing dropping the previous frame.
			bgCtx.clearRect(0, 0, w, h);
			console.warn("[FrameRenderer] No background sprite found during compositing!");
		}

		// Foreground (transparent): recording + webcam. Shadow baked here only on the
		// flat path; the 3D path applies it after rotation (see renderFrame).
		//
		// Same trick as the background: both branches below draw a full w*h image,
		// so "copy" subsumes the clear. restore() puts source-over back before the
		// webcam is drawn on top — with "copy" still set, it would wipe the frame.
		if (this.legacyCompositor) fgCtx.clearRect(0, 0, w, h);
		fgCtx.save();
		if (!this.legacyCompositor) fgCtx.globalCompositeOperation = "copy";
		if (
			applyShadowToRecording &&
			this.config.showShadow &&
			this.config.shadowIntensity > 0 &&
			this.shadowCanvas &&
			this.shadowCtx
		) {
			const cached = this.legacyCompositor ? null : this.cachedShadowLayer(videoCanvas, w, h);
			if (cached) {
				// The filter ran once for this geometry; per frame this is one blit.
				fgCtx.drawImage(cached, 0, 0, w, h);
				fgCtx.globalCompositeOperation = "source-over";
				fgCtx.drawImage(videoCanvas, 0, 0, w, h);
			} else {
				const shadowCtx = this.shadowCtx;
				shadowCtx.clearRect(0, 0, w, h);
				shadowCtx.save();
				shadowCtx.filter = shadowFilterChain(this.config.shadowIntensity);
				shadowCtx.drawImage(videoCanvas, 0, 0, w, h);
				shadowCtx.restore();
				fgCtx.drawImage(this.shadowCanvas, 0, 0, w, h);
			}
		} else {
			fgCtx.drawImage(videoCanvas, 0, 0, w, h);
		}
		fgCtx.restore();

		const webcamRect = this.layoutCache?.webcamRect ?? null;
		if (webcamFrame && webcamRect) {
			const preset = getWebcamLayoutPresetDefinition(this.config.webcamLayoutPreset);
			const shape = webcamRect.maskShape ?? this.config.webcamMaskShape ?? "rectangle";
			const cameraFullProgress = this.animationState.cameraFullscreenProgress;
			let drawRect: StyledRenderRect;
			if (cameraFullProgress > 0) {
				// Full Camera takes over the webcam's size/position entirely, growing it to cover
				// the whole stage (inset by a margin, aspect-preserving — see
				// computeCameraFullscreenTargetRect). Reactive zoom is ignored for this frame (see
				// design notes 6.4): mixing "shrink for zoom" and "grow to full" in the same frame
				// doesn't make sense.
				const targetRect = computeCameraFullscreenTargetRect(
					{ width: this.config.width, height: this.config.height },
					webcamRect,
				);
				const fullRect: StyledRenderRect = {
					x: targetRect.x,
					y: targetRect.y,
					width: targetRect.width,
					height: targetRect.height,
					borderRadius: 0,
					maskShape: webcamRect.maskShape,
				};
				drawRect = lerpRect(webcamRect, fullRect, cameraFullProgress);
			} else {
				// Scale the PiP webcam inversely with the eased zoom, anchoring the shrink to the
				// docked corner (bottom-right by default) like the preview, so it stays flush to the
				// edges instead of drifting toward center.
				const reactiveFactor =
					this.config.webcamReactiveZoom && this.config.webcamLayoutPreset === "picture-in-picture"
						? reactiveWebcamScale(this.animationState.appliedScale)
						: 1;
				const camPos = this.config.webcamPosition;
				const biasX = (camPos ? camPos.cx >= 0.5 : true) ? 1 : 0;
				const biasY = (camPos ? camPos.cy >= 0.5 : true) ? 1 : 0;
				drawRect =
					reactiveFactor < 1
						? {
								width: webcamRect.width * reactiveFactor,
								height: webcamRect.height * reactiveFactor,
								x: webcamRect.x + webcamRect.width * (1 - reactiveFactor) * biasX,
								y: webcamRect.y + webcamRect.height * (1 - reactiveFactor) * biasY,
								borderRadius: webcamRect.borderRadius * reactiveFactor,
							}
						: webcamRect;
			}
			const sourceWidth =
				("displayWidth" in webcamFrame && webcamFrame.displayWidth > 0
					? webcamFrame.displayWidth
					: webcamFrame.codedWidth) || webcamRect.width;
			const sourceHeight =
				("displayHeight" in webcamFrame && webcamFrame.displayHeight > 0
					? webcamFrame.displayHeight
					: webcamFrame.codedHeight) || webcamRect.height;
			const sourceAspect = sourceWidth / sourceHeight;
			const targetAspect = webcamRect.width / webcamRect.height;
			const sourceCropWidth =
				sourceAspect > targetAspect ? Math.round(sourceHeight * targetAspect) : sourceWidth;
			const sourceCropHeight =
				sourceAspect > targetAspect ? sourceHeight : Math.round(sourceWidth / targetAspect);
			const sourceCropX = Math.max(0, Math.round((sourceWidth - sourceCropWidth) / 2));
			const sourceCropY = Math.max(0, Math.round((sourceHeight - sourceCropHeight) / 2));
			fgCtx.save();
			drawCanvasClipPath(
				fgCtx,
				drawRect.x,
				drawRect.y,
				drawRect.width,
				drawRect.height,
				shape,
				drawRect.borderRadius,
			);
			if (preset.shadow) {
				fgCtx.shadowColor = preset.shadow.color;
				fgCtx.shadowBlur = preset.shadow.blur;
				fgCtx.shadowOffsetX = preset.shadow.offsetX;
				fgCtx.shadowOffsetY = preset.shadow.offsetY;
			}
			fgCtx.fillStyle = "#000000";
			fgCtx.fill();
			fgCtx.clip();
			drawWebcamFrameImage(
				fgCtx,
				webcamFrame as unknown as CanvasImageSource,
				{
					x: sourceCropX,
					y: sourceCropY,
					width: sourceCropWidth,
					height: sourceCropHeight,
				},
				{
					x: drawRect.x,
					y: drawRect.y,
					width: drawRect.width,
					height: drawRect.height,
				},
				this.config.webcamMirrored,
			);
			fgCtx.restore();
		}
	}

	getCanvas(): HTMLCanvasElement {
		if (!this.compositeCanvas) {
			throw new Error("Renderer not initialized");
		}
		return this.compositeCanvas;
	}

	/** Shadow cache hits/misses for the frames rendered so far — see the fields. */
	shadowCacheStats(): { hits: number; misses: number } {
		return { hits: this.shadowCacheHits, misses: this.shadowCacheMisses };
	}

	/**
	 * Bench-only sync point — gate G0, docs/architecture/rendering-architecture.md §7.1.
	 *
	 * Draw calls queue GPU work; the cost lands on whichever operation first needs
	 * the pixels, which today is the encoder — so the compositor's execution is
	 * billed to `encodeWait`. Forcing execution HERE moves that cost into the
	 * caller's `fence` timer and the stage table finally says where the time goes.
	 *
	 * gl.finish() drains the Pixi context. Canvas2D has no finish(): the 1×1
	 * getImageData is the equivalent — it forces the pending raster work of the
	 * whole surface chain (pixi canvas → shadow/foreground → composite) to
	 * complete, while transferring a single pixel.
	 */
	finishGpuWork(): void {
		const gl = (this.app?.renderer as unknown as { gl?: WebGLRenderingContext } | null)?.gl;
		gl?.finish();
		this.compositeCtx?.getImageData(0, 0, 1, 1);
	}

	destroy(): void {
		if (this.videoSprite) {
			this.videoSprite.destroy();
			this.videoSprite = null;
		}
		this.backgroundSprite = null;
		if (this.app) {
			this.app.destroy(true, {
				children: true,
				texture: true,
				textureSource: true,
			});
			this.app = null;
		}
		this.cameraContainer = null;
		this.videoContainer = null;
		this.maskGraphics = null;
		this.blurFilter = null;
		this.motionBlurFilter = null;
		this.shadowCanvas = null;
		this.shadowCtx = null;
		this.compositeCanvas = null;
		this.compositeCtx = null;
		this.foregroundCanvas = null;
		this.foregroundCtx = null;
		this.rasterCanvas = null;
		this.rasterCtx = null;
		if (this.threeDPass) {
			this.threeDPass.destroy();
			this.threeDPass = null;
		}
		this.cursorImageCache.clear();
	}
}
