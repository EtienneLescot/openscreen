// Hosts the native D3D preview canvas (the sole pixel source) plus the
// interactive-only DOM overlays (zoom gimbal, annotations, webcam drag) that
// still need real hitboxes. The shared source of truth is `useEditorSettings`,
// so toggling a slider here updates both the live preview (via the pushed
// scene) and the eventual native export.
//
// Architecture (matches the legacy `compositeLayout.computeCompositeLayout`,
// which this file still uses to POSITION the interactive overlays/hitboxes —
// the actual pixels come from the native canvas, not from this layout):
//   .previewFrame           → canvas (wallpaper bg; never receives padding
//                             from the slider directly).
//   .screenStage            → sizes/positions the zoom/annotation overlays by
//                             the composite-layout math (PiP/dual/stack/no-cam);
//                             its own <video> is CSS-hidden (decode/clock only).
//   .webcamSlot             → drag-to-reposition hitbox for the webcam PiP,
//                             positioned by the same math; its <video> is
//                             CSS-hidden too.
//
// The composite layout is computed from `.previewFrame`'s actual rendered
// size (via ResizeObserver), so the camera + screen both resize correctly
// as the user resizes the workbench.

import type { PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	type CameraFullscreenRegion,
	type CropRegion,
	DEFAULT_CROP_REGION,
	type WebcamLayoutPreset,
	type WebcamMaskShape,
	type ZoomFocus,
} from "@/components/video-editor/types";
import { computeCameraFullscreenProgress } from "@/components/video-editor/videoPlayback/cameraFullscreenUtils";
import type {
	AxcutAnnotationRegion,
	AxcutClip,
	AxcutTrimRange,
	AxcutZoomRegion,
} from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { useEditorSettings } from "@/lib/ai-edition/store/useEditorSettings";
import { resolveActiveCameraTrack } from "@/lib/ai-edition/timeline/camera";
import { createPlaybackClockRef } from "@/lib/ai-edition/timeline/playback-clock";
import type { SpeedRegion } from "@/lib/ai-edition/timeline/speed";
import { locateVirtualPosition } from "@/lib/ai-edition/timeline/virtual-preview";
import {
	computeCameraFullscreenTargetRect,
	computeCompositeLayout,
	getWebcamLayoutCssBoxShadow,
	lerpRect,
	type WebcamCompositeLayout,
} from "@/lib/compositeLayout";
import { classifyWallpaper, resolveImageWallpaperUrl } from "@/lib/wallpaper";
import { getCssClipPath } from "@/lib/webcamMaskShapes";
import { getAspectRatioValue } from "@/utils/aspectRatioUtils";
import { AnnotationLayer } from "./AnnotationLayer";
import { NativeCompositorOverlay } from "./NativeCompositorOverlay";
import styles from "./NewEditorShell.module.css";
import { type VideoSource, VirtualPreview } from "./VirtualPreview";
import { WebcamOverlay } from "./WebcamOverlay";
import { ZoomFocusOverlay } from "./ZoomFocusOverlay";

type BlurData = NonNullable<AxcutAnnotationRegion["blurData"]>;

interface PreviewCanvasProps {
	videoSources: VideoSource[];
	clips: AxcutClip[];
	zoomRegions?: AxcutZoomRegion[];
	speedRegions?: SpeedRegion[];
	cameraFullscreenRegions?: CameraFullscreenRegion[];
	trimRanges?: AxcutTrimRange[];
	selectedZoomRegionId?: string | null;
	onZoomFocusChange?: (id: string, focus: ZoomFocus) => void;
	onZoomFocusCommit?: () => void;
	annotationRegions?: AxcutAnnotationRegion[];
	selectedAnnotationId?: string | null;
	onSelectAnnotation?: (id: string) => void;
	onAnnotationPositionChange?: (id: string, position: { x: number; y: number }) => void;
	onAnnotationSizeChange?: (id: string, size: { width: number; height: number }) => void;
	onAnnotationBlurDataChange?: (id: string, blurData: BlurData) => void;
	onAnnotationCommit?: () => void;
	seekTarget: { timeSec: number; requestId: number } | null;
	onTimeChange: (sec: number) => void;
	onSeek: (sec: number) => void;
	onLoadedMetadata: (sec: number, assetId: string) => void;
	onVideoElement: (el: HTMLVideoElement | null) => void;
	currentTimeSec: number;
	onVideoError?: () => void;
}

// ponytail: fallback only — used until the active source's <video> reports
// its real intrinsic size via onLoadedMetadata. Nothing in the import/record
// pipeline ever probes/stores a recording's actual resolution (AxcutAsset's
// `video.width/height` is never populated), so without this the composite
// layout always assumed 16:9 regardless of the real capture — a recording at
// any other aspect then letterboxed a SECOND time inside its own screenRect
// (the <video> contain-fits its true ratio within a box sized for the wrong
// one), on top of the intentional `settings.padding` margin.
const SCREEN_SOURCE_SIZE = { width: 1920, height: 1080 };
// ponytail: live preview defaults until the camera <video> reports its real
// dimensions via loadedmetadata. 4:3 is the legacy default — typical webcams
// capture at 1.33, and using a 16:9 default collapses vertical-stack to a
// degenerate full-bleed camera with 0px screen height.
const WEBCAM_SOURCE_SIZE = { width: 960, height: 720 };

export function PreviewCanvas(props: PreviewCanvasProps) {
	const { settings, setLive, commit } = useEditorSettings();
	const assets = useProjectStore((s) => s.document?.assets ?? []);
	const frameRef = useRef<HTMLDivElement | null>(null);
	const webcamSlotRef = useRef<HTMLDivElement | null>(null);
	// One clock per mounted canvas, shared between the screen preview (writer)
	// and the webcam overlay (reader) — see playback-clock.ts.
	const clockRefHolder = useRef<ReturnType<typeof createPlaybackClockRef>>();
	if (!clockRefHolder.current) clockRefHolder.current = createPlaybackClockRef();
	const clockRef = clockRefHolder.current;
	const [canvasSize, setCanvasSize] = useState({ width: 1280, height: 720 });
	// Real dimensions of the active source, from the <video>'s own
	// onLoadedMetadata (videoWidth/videoHeight) — null until the first source
	// loads, then falls back to SCREEN_SOURCE_SIZE.
	const [screenNativeSize, setScreenNativeSize] = useState<{
		width: number;
		height: number;
	} | null>(null);
	// ponytail: contain-fit the frame within its wrapper ourselves. CSS
	// `aspect-ratio` + `width: 100%` + `max-height: 100%` only clamps height —
	// it never shrinks width back down to match, so portrait ratios (9:16 etc)
	// silently overflowed/stretched instead of fitting. Measuring the parent
	// (not the frame, which we're about to size) lets us compute an explicit
	// pixel box that actually respects the ratio on both axes.
	const [containerSize, setContainerSize] = useState({ width: 1280, height: 720 });
	// ponytail: StrictMode's dev-only mount→cleanup→remount double-invoke
	// creates a fresh ResizeObserver, disconnects it, then creates ANOTHER
	// fresh one observing the same element in the same tick. Chromium
	// silently drops all FUTURE notifications for that element when this
	// exact disconnect-then-immediately-recreate pattern happens (confirmed
	// live: a raw counter in the callback never incremented past the initial
	// synchronous calls, even across a real viewport resize) — the frame
	// would freeze at its first-paint size and never resize again. Holding
	// the observer instance in a ref (surviving the double-invoke, since
	// only the effect body reruns) and just toggling observe/unobserve on it
	// avoids ever recreating the instance, which sidesteps the bug.
	const containerObserverRef = useRef<ResizeObserver | null>(null);
	const canvasObserverRef = useRef<ResizeObserver | null>(null);

	useEffect(() => {
		const el = frameRef.current?.parentElement;
		if (!el) return;
		// ponytail: measure the parent's content box, not its border box —
		// clientWidth/clientHeight include any padding, and sizing the frame to
		// the full padded box while it's centered in the smaller content area
		// pushed it past the padding edge, where overflow:hidden clipped the
		// video. The parent (.previewWrap) is currently zero-padding, but
		// subtracting computed padding keeps this correct if that ever changes.
		const update = () => {
			const cs = getComputedStyle(el);
			const paddingX = Number.parseFloat(cs.paddingLeft) + Number.parseFloat(cs.paddingRight);
			const paddingY = Number.parseFloat(cs.paddingTop) + Number.parseFloat(cs.paddingBottom);
			setContainerSize({
				width: (el.clientWidth || 1280) - (Number.isFinite(paddingX) ? paddingX : 0),
				height: (el.clientHeight || 720) - (Number.isFinite(paddingY) ? paddingY : 0),
			});
		};
		update();
		if (typeof ResizeObserver === "undefined") return;
		if (!containerObserverRef.current) {
			containerObserverRef.current = new ResizeObserver(update);
		}
		const observer = containerObserverRef.current;
		observer.observe(el);
		return () => observer.unobserve(el);
	}, []);

	useEffect(() => {
		const el = frameRef.current;
		if (!el) return;
		const update = () =>
			setCanvasSize({
				width: el.clientWidth || 1280,
				height: el.clientHeight || 720,
			});
		update();
		if (typeof ResizeObserver === "undefined") return;
		if (!canvasObserverRef.current) {
			canvasObserverRef.current = new ResizeObserver(update);
		}
		const observer = canvasObserverRef.current;
		observer.observe(el);
		return () => observer.unobserve(el);
	}, []);

	const frameSize = useMemo(() => {
		const ratio = getAspectRatioValue(settings.aspectRatio);
		const { width: containerWidth, height: containerHeight } = containerSize;
		if (containerWidth <= 0 || containerHeight <= 0)
			return { width: containerWidth, height: containerHeight };
		if (containerWidth / containerHeight > ratio) {
			const height = containerHeight;
			return { width: Math.round(height * ratio), height: Math.round(height) };
		}
		const width = containerWidth;
		return { width: Math.round(width), height: Math.round(width / ratio) };
	}, [containerSize, settings.aspectRatio]);

	// Crop is per-clip (see clipSchema.cropRegion) — resolve it from whichever
	// clip the playhead is currently inside, the same lookup VirtualPreview
	// itself uses to map playback position back to a clip. `undefined` (no
	// crop stored) normalises to the identity region.
	const activeClip = useMemo(
		() => locateVirtualPosition(props.clips, props.currentTimeSec)?.clip ?? null,
		[props.clips, props.currentTimeSec],
	);
	const cropRegion: CropRegion = activeClip?.cropRegion ?? DEFAULT_CROP_REGION;

	const layout = useMemo(() => {
		const preset = settings.webcamLayoutPreset as WebcamLayoutPreset;
		const mask = settings.webcamMaskShape as WebcamMaskShape;
		// ponytail: padding shrinks the available content area for ALL layouts
		// (PiP/dual/stack) so the screen doesn't fill the canvas edge-to-edge.
		// In vertical-stack this caps the camera strip height: at padding=0 the
		// camera reaches 40% of canvas; at padding=50 it falls to ~32%;
		// at padding=100 the screen takes even more.
		const paddingFit = clamp(1 - (clamp(settings.padding, 0, 100) / 100) * 0.4, 0.4, 1);
		const maxContentSize = {
			width: Math.round(canvasSize.width * paddingFit),
			height: Math.round(canvasSize.height * paddingFit),
		};
		// The screen box must be fit to the CROPPED aspect ratio, not the full
		// source frame's — otherwise VirtualPreview's crop math (which assumes
		// its container is already correctly proportioned for the crop) would
		// stretch the video to fill a mis-shaped box.
		const fullScreenSize = screenNativeSize ?? SCREEN_SOURCE_SIZE;
		const croppedScreenSize = {
			width: Math.max(1, Math.round(fullScreenSize.width * cropRegion.width)),
			height: Math.max(1, Math.round(fullScreenSize.height * cropRegion.height)),
		};
		return computeCompositeLayout({
			canvasSize,
			maxContentSize,
			screenSize: croppedScreenSize,
			webcamSize: settings.webcamLayoutPreset === "no-webcam" ? null : WEBCAM_SOURCE_SIZE,
			layoutPreset: preset,
			webcamSizePreset: settings.webcamSizePreset,
			// ponytail: PiP webcam is grabbable. Pass through the user's
			// position so the layout math places it at the dragged spot, not
			// the legacy default. Dual-frame / vertical-stack / no-webcam ignore
			// it (their preset definitions hardcode their own placement).
			webcamPosition: preset === "picture-in-picture" ? settings.webcamPosition : null,
			webcamMaskShape: mask,
		});
	}, [
		canvasSize,
		screenNativeSize,
		cropRegion,
		settings.webcamLayoutPreset,
		settings.webcamMaskShape,
		settings.webcamSizePreset,
		settings.webcamPosition,
		settings.padding,
	]);

	// Full Camera: during a cameraFullscreen region the webcam overlay grows to
	// (almost) fill the canvas and eases back. Mirror the exporter's frameRenderer
	// exactly — lerp the PiP rect toward computeCameraFullscreenTargetRect (radius
	// 0 at full) — so preview and export animate to the identical rect.
	const cameraFullscreenProgress = useMemo(
		() =>
			computeCameraFullscreenProgress(
				props.cameraFullscreenRegions ?? [],
				Math.round(props.currentTimeSec * 1000),
			),
		[props.cameraFullscreenRegions, props.currentTimeSec],
	);
	const effectiveLayout = useMemo<WebcamCompositeLayout | null>(() => {
		if (!layout?.webcamRect || cameraFullscreenProgress <= 0) return layout;
		const target = computeCameraFullscreenTargetRect(canvasSize, layout.webcamRect);
		const fullRect = {
			x: target.x,
			y: target.y,
			width: target.width,
			height: target.height,
			borderRadius: 0,
			maskShape: layout.webcamRect.maskShape,
		};
		return {
			...layout,
			webcamRect: lerpRect(layout.webcamRect, fullRect, cameraFullscreenProgress),
		};
	}, [layout, cameraFullscreenProgress, canvasSize]);

	const frameStyle = useMemo(() => buildFrameStyle(settings), [settings]);
	const screenStyle = useMemo(
		() => buildScreenStyle(layout, settings, canvasSize),
		[layout, settings, canvasSize],
	);
	const webcamStyle = useMemo(
		() => buildWebcamStyle(effectiveLayout, settings, canvasSize),
		[effectiveLayout, settings, canvasSize],
	);
	// P4 — the layout math above only knows the user's chosen preset
	// (PiP/dual/stack), not whether the clip under the playhead actually has a
	// camera. Without this, an empty (but styled — shadow, background) webcam
	// slot stays visible for clips with no camera attached.
	const activeCameraTrack = useMemo(
		() => resolveActiveCameraTrack(assets, props.clips, props.currentTimeSec),
		[assets, props.clips, props.currentTimeSec],
	);
	const showWebcamSlot = Boolean(
		layout?.webcamRect && activeCameraTrack?.visible && activeCameraTrack.sourcePath,
	);
	const [isPlaying, setIsPlaying] = useState(false);
	const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
	const handleVideoElement = useMemo(() => props.onVideoElement, [props.onVideoElement]);
	const relayIsPlaying = (el: HTMLVideoElement | null) => {
		handleVideoElement(el);
		setIsPlaying(!el?.paused);
		setVideoEl(el);
	};
	const relayLoadedMetadata = (
		durationSec: number,
		assetId: string,
		videoWidth: number,
		videoHeight: number,
	) => {
		if (videoWidth > 0 && videoHeight > 0) {
			setScreenNativeSize((prev) =>
				prev?.width === videoWidth && prev?.height === videoHeight
					? prev
					: { width: videoWidth, height: videoHeight },
			);
		}
		props.onLoadedMetadata(durationSec, assetId);
	};
	const relayProps = {
		...props,
		onVideoElement: relayIsPlaying,
		onLoadedMetadata: relayLoadedMetadata,
		cropRegion,
		clockRef,
	};

	const handleWebcamPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (settings.webcamLayoutPreset !== "picture-in-picture") return;
		if (isPlaying) return;
		const slot = webcamSlotRef.current;
		if (!slot) return;
		const slotRect = slot.getBoundingClientRect();
		const frameRect = frameRef.current?.getBoundingClientRect();
		if (!frameRect) return;
		event.preventDefault();
		event.stopPropagation();
		const offsetX = event.clientX - (slotRect.left + slotRect.width / 2);
		const offsetY = event.clientY - (slotRect.top + slotRect.height / 2);
		slot.setPointerCapture(event.pointerId);

		const handleMove = (e: PointerEvent) => {
			const frameNow = frameRef.current?.getBoundingClientRect();
			if (!frameNow) return;
			const cx = clamp01((e.clientX - offsetX - frameNow.left) / frameNow.width);
			const cy = clamp01((e.clientY - offsetY - frameNow.top) / frameNow.height);
			setLive({ webcamPosition: { cx, cy } });
		};
		const handleUp = () => {
			slot.removeEventListener("pointermove", handleMove);
			slot.removeEventListener("pointerup", handleUp);
			slot.removeEventListener("pointercancel", handleUp);
			try {
				slot.releasePointerCapture(event.pointerId);
			} catch {
				// pointer already released
			}
			void commit();
		};
		slot.addEventListener("pointermove", handleMove);
		slot.addEventListener("pointerup", handleUp);
		slot.addEventListener("pointercancel", handleUp);
	};

	const isPipGrab = settings.webcamLayoutPreset === "picture-in-picture";

	const selectedZoomRegion = props.selectedZoomRegionId
		? (props.zoomRegions?.find((z) => z.id === props.selectedZoomRegionId) ?? null)
		: null;

	return (
		<div
			ref={frameRef}
			className={styles.previewFrame}
			style={{ ...frameStyle, width: frameSize.width, height: frameSize.height }}
		>
			{/* Sole pixel source: the D3D-composited frame (wallpaper + screen + webcam +
			    cursor), streamed into a canvas. The <video> elements below are CSS-hidden
			    (visibility only — they stay mounted for decode/playback-clock/metadata
			    duties, since the native compositor doesn't drive playback itself), and the
			    interactive-only layers (ZoomFocusOverlay, AnnotationLayer, webcam drag
			    hitbox) still render on top as normal DOM so they stay clickable. No more
			    dual preview path. */}
			<NativeCompositorOverlay />
			{layout?.screenRect ? (
				<div className={styles.screenStage} style={screenStyle}>
					{(() => {
						// ponytail: PreviewCompositor (Pixi v8) regressed the screen
						// preview — the `<video>` is `visibility: hidden` while it's
						// the decode source for a Pixi VideoSource, and the
						// combination of `setPixiReady` + `canvasSize === {0,0}` on
						// mount produces a 1x1 canvas that the resize effect never
						// widens (the user reports either an empty stage showing
						// the wallpaper through, or a black rectangle where the
						// screen recording should be). Falling back to the legacy
						// VirtualPreview path — CSS-transformed <video> + measure
						// on ResizeObserver — until the Pixi path is hardened
						// behind a flag with its own tests.
						// See docs/engineering/ai-edition-preview-pixi-rollback.md
						// (todo) for the failure write-up.
						void relayProps.clockRef;
						return (
							<VirtualPreview
								{...relayProps}
								videoStyle={videoBorderRadiusStyle(layout, settings)}
							/>
						);
					})()}
					{selectedZoomRegion && props.onZoomFocusChange ? (
						<ZoomFocusOverlay
							region={selectedZoomRegion}
							isPlaying={isPlaying}
							onFocusChange={props.onZoomFocusChange}
							onFocusCommit={props.onZoomFocusCommit}
						/>
					) : null}
					{props.annotationRegions &&
					props.onSelectAnnotation &&
					props.onAnnotationPositionChange &&
					props.onAnnotationSizeChange &&
					props.onAnnotationBlurDataChange &&
					props.onAnnotationCommit ? (
						<AnnotationLayer
							annotations={props.annotationRegions}
							selectedAnnotationId={props.selectedAnnotationId ?? null}
							currentTimeSec={props.currentTimeSec}
							containerWidth={layout.screenRect.width}
							containerHeight={layout.screenRect.height}
							videoElement={videoEl}
							onSelectAnnotation={props.onSelectAnnotation}
							onPositionChange={props.onAnnotationPositionChange}
							onSizeChange={props.onAnnotationSizeChange}
							onBlurDataChange={props.onAnnotationBlurDataChange}
							onCommit={props.onAnnotationCommit}
						/>
					) : null}
				</div>
			) : null}
			{layout?.webcamRect && showWebcamSlot ? (
				<div
					ref={webcamSlotRef}
					className={styles.webcamSlot}
					style={{
						...webcamStyle,
						cursor: isPipGrab && !isPlaying ? "grab" : "default",
						touchAction: "none",
					}}
					onPointerDown={isPipGrab ? handleWebcamPointerDown : undefined}
					aria-label="Webcam preview (drag to reposition)"
				>
					<WebcamOverlay
						clips={props.clips}
						currentTimeSec={props.currentTimeSec}
						onTimeChange={props.onTimeChange}
						isPlaying={isPlaying}
						clockRef={clockRef}
						borderRadius={
							effectiveLayout?.webcamRect?.borderRadius ?? layout.webcamRect.borderRadius
						}
						webcamMaskShape={settings.webcamMaskShape}
						layoutPreset={settings.webcamLayoutPreset}
					/>
				</div>
			) : null}
		</div>
	);
}

// ponytail: resolve `settings.wallpaper` to an actual CSS background. Image
// wallpapers must go through resolveImageWallpaperUrl (→ getAssetPath): in the
// packaged Electron app the renderer loads over file://, where a bare
// `/wallpapers/foo.jpg` points at the filesystem root and 404s, so the custom
// background silently failed to paint (worked in the http dev server only).
// classifyWallpaper also handles color-function (rgb/hsl/…) and every gradient
// variant, which the old ad-hoc startsWith checks missed.
function resolveWallpaperImageUrl(imagePath: string): string | null {
	try {
		return resolveImageWallpaperUrl(imagePath);
	} catch {
		return null;
	}
}

// Canvas: wallpaper only — no padding, no shadow.
function buildFrameStyle(
	settings: ReturnType<typeof useEditorSettings>["settings"],
): React.CSSProperties {
	const w = classifyWallpaper(settings.wallpaper);
	if (w.kind === "color") return { backgroundColor: w.value };
	if (w.kind === "gradient") return { backgroundImage: w.value, backgroundSize: "cover" };
	const url = resolveWallpaperImageUrl(w.path);
	if (!url) return {};
	return {
		backgroundImage: `url(${url})`,
		backgroundSize: "cover",
		backgroundPosition: "center",
		backgroundRepeat: "no-repeat",
	};
}

// Screen stage: rectangle from the composite layout, converted to percentages
// of the canvas. The container carries the SAME borderRadius as the <video>
// inside it (still clipped via the video's own radius, this is belt-and-
// braces) — a box-shadow only follows the shape of the element it's applied
// to, so a square container behind a rounded video drew a squared-off shadow
// poking out past the video's rounded corners. Box-shadow follows the user's
// `shadowIntensity` setting only — at intensity 0 the stage is flat so it
// bleeds into the canvas cleanly.
function buildScreenStyle(
	layout: WebcamCompositeLayout | null,
	settings: ReturnType<typeof useEditorSettings>["settings"],
	canvasSize: { width: number; height: number },
): React.CSSProperties {
	if (!layout?.screenRect) return { display: "none" };
	const r = layout.screenRect;
	const shadow = settings.shadowIntensity
		? `0 ${4 + settings.shadowIntensity * 20}px ${16 + settings.shadowIntensity * 36}px rgba(0,0,0,${0.18 + settings.shadowIntensity * 0.45})`
		: undefined;
	const borderRadius = layout.screenBorderRadius ?? settings.borderRadius;
	return {
		position: "absolute",
		left: `${(r.x / canvasSize.width) * 100}%`,
		top: `${(r.y / canvasSize.height) * 100}%`,
		width: `${(r.width / canvasSize.width) * 100}%`,
		height: `${(r.height / canvasSize.height) * 100}%`,
		overflow: "hidden",
		display: "flex",
		borderRadius: `${borderRadius}px`,
		boxShadow: shadow,
	};
}

function videoBorderRadiusStyle(
	layout: WebcamCompositeLayout | null,
	settings: ReturnType<typeof useEditorSettings>["settings"],
): React.CSSProperties {
	const borderRadius = layout?.screenBorderRadius ?? settings.borderRadius;
	return { borderRadius: `${borderRadius}px` };
}

// Webcam slot: full composite-layout rect with mask shape + shadow. The
// container's own borderRadius matches r.borderRadius (same radius the inner
// <video> clips to, and for "circle" that's already a half-dimension radius)
// so the box-shadow — which only ever follows border-radius, never
// clip-path — traces the same rounded/circular shape instead of a square
// poking out behind the masked content.
function buildWebcamStyle(
	layout: WebcamCompositeLayout | null,
	settings: ReturnType<typeof useEditorSettings>["settings"],
	canvasSize: { width: number; height: number },
): React.CSSProperties {
	if (!layout?.webcamRect) return { display: "none" };
	const r = layout.webcamRect;
	const mask = settings.webcamMaskShape as WebcamMaskShape;
	const clipPath = getCssClipPath(mask);
	const base: React.CSSProperties = {
		position: "absolute",
		left: `${(r.x / canvasSize.width) * 100}%`,
		top: `${(r.y / canvasSize.height) * 100}%`,
		width: `${(r.width / canvasSize.width) * 100}%`,
		height: `${(r.height / canvasSize.height) * 100}%`,
		overflow: "hidden",
		display: "flex",
		background: "transparent",
		borderRadius: `${r.borderRadius}px`,
		boxShadow: getWebcamLayoutCssBoxShadow(settings.webcamLayoutPreset as WebcamLayoutPreset),
	};
	return clipPath ? { ...base, clipPath } : base;
}

function clamp(v: number, min: number, max: number): number {
	return Math.min(Math.max(v, min), max);
}

function clamp01(v: number, min = 0, max = 1): number {
	return clamp(v, min, max);
}
