// CSS-driven canvas shell that wraps the active source video with the
// editor's background, frame, and overlay settings.
//
// ponytail: mouse-driven overlays (cursor, zoom, annotations) and motion blur
// still render through the legacy canvas preview pipeline for export. The
// shared source of truth is `useEditorSettings`, so toggling a slider here
// updates both the live preview and the eventual render.
//
// Architecture (matches the legacy `compositeLayout.computeCompositeLayout`):
//   .previewFrame           → canvas (wallpaper bg + blurred copy behind the
//                             video when showBlur is on; never receives padding
//                             from the slider directly).
//   .screenStage            → active source video; positioned/sized by the
//                             composite-layout math (PiP/dual/stack/no-cam).
//                             Carries the drop-shadow that gives the active
//                             recording its lifted look.
//   .webcamSlot             → live WebcamOverlay container; positioned/sized
//                             by the same math.
//   .bgBlur                 → blurred wallpaper peeking around the video.
//
// The composite layout is computed from `.previewFrame`'s actual rendered
// size (via ResizeObserver), so the camera + screen both resize correctly
// as the user resizes the workbench.

import type { PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
	WebcamLayoutPreset,
	WebcamMaskShape,
	ZoomFocus,
} from "@/components/video-editor/types";
import type {
	AxcutAnnotationRegion,
	AxcutClip,
	AxcutSkipRange,
	AxcutZoomRegion,
} from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { useEditorSettings } from "@/lib/ai-edition/store/useEditorSettings";
import { resolveActiveCameraTrack } from "@/lib/ai-edition/timeline/camera";
import { createPlaybackClockRef } from "@/lib/ai-edition/timeline/playback-clock";
import type { SpeedRegion } from "@/lib/ai-edition/timeline/speed";
import {
	computeCompositeLayout,
	getWebcamLayoutCssBoxShadow,
	type WebcamCompositeLayout,
} from "@/lib/compositeLayout";
import { getCssClipPath } from "@/lib/webcamMaskShapes";
import { getAspectRatioValue } from "@/utils/aspectRatioUtils";
import { AnnotationLayer } from "./AnnotationLayer";
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
	skipRanges?: AxcutSkipRange[];
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
	// ponytail: contain-fit the frame within its wrapper ourselves. CSS
	// `aspect-ratio` + `width: 100%` + `max-height: 100%` only clamps height —
	// it never shrinks width back down to match, so portrait ratios (9:16 etc)
	// silently overflowed/stretched instead of fitting. Measuring the parent
	// (not the frame, which we're about to size) lets us compute an explicit
	// pixel box that actually respects the ratio on both axes.
	const [containerSize, setContainerSize] = useState({ width: 1280, height: 720 });

	useEffect(() => {
		const el = frameRef.current?.parentElement;
		if (!el) return;
		// ponytail: clientWidth/clientHeight include the container's padding
		// (.previewCanvas has var(--sp-5) on all sides). Sizing the frame to
		// that full padded box, then centering it in the smaller content-box
		// grid track, pushed it past the padding edge on every axis —
		// overflow:hidden then clipped the video instead of letting it fit.
		// Subtracting the computed padding gives the actual content box.
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
		const observer = new ResizeObserver(update);
		observer.observe(el);
		return () => observer.disconnect();
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
		const observer = new ResizeObserver(update);
		observer.observe(el);
		return () => observer.disconnect();
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
		return computeCompositeLayout({
			canvasSize,
			maxContentSize,
			screenSize: SCREEN_SOURCE_SIZE,
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
		settings.webcamLayoutPreset,
		settings.webcamMaskShape,
		settings.webcamSizePreset,
		settings.webcamPosition,
		settings.padding,
	]);

	const frameStyle = useMemo(() => buildFrameStyle(settings), [settings]);
	const blurStyle = useMemo(() => buildBlurStyle(settings), [settings]);
	const screenStyle = useMemo(
		() => buildScreenStyle(layout, settings, canvasSize),
		[layout, settings, canvasSize],
	);
	const webcamStyle = useMemo(
		() => buildWebcamStyle(layout, settings, canvasSize),
		[layout, settings, canvasSize],
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
	const relayProps = { ...props, onVideoElement: relayIsPlaying, clockRef };

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
			<div className={styles.bgBlur} style={blurStyle} aria-hidden />
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
						return <VirtualPreview {...relayProps} videoStyle={videoBorderRadiusStyle(settings)} />;
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
						borderRadius={layout.webcamRect.borderRadius}
						webcamMaskShape={settings.webcamMaskShape}
						layoutPreset={settings.webcamLayoutPreset}
					/>
				</div>
			) : null}
		</div>
	);
}

// Canvas: wallpaper only — no padding, no shadow.
function buildFrameStyle(
	settings: ReturnType<typeof useEditorSettings>["settings"],
): React.CSSProperties {
	const wallpaper = settings.wallpaper;
	const isImageWallpaper = wallpaper.startsWith("/wallpapers/") || wallpaper.startsWith("data:");
	const isColor = wallpaper.startsWith("#");
	const isGradient =
		wallpaper.startsWith("linear-") ||
		wallpaper.startsWith("radial-") ||
		wallpaper.startsWith("conic-");

	if (isImageWallpaper) {
		return {
			backgroundImage: `url(${wallpaper})`,
			backgroundSize: "cover",
			backgroundPosition: "center",
			backgroundRepeat: "no-repeat",
		};
	}
	if (isColor) return { backgroundColor: wallpaper };
	return {
		backgroundImage: isGradient ? wallpaper : undefined,
		backgroundSize: "cover",
	};
}

// Screen stage: rectangle from the composite layout, converted to percentages
// of the canvas. NO borderRadius on the container — the rounded corners are
// applied on the <video> itself so they actually clip the video content
// rather than drawing a border around it. Box-shadow follows the user's
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
	void layout.screenBorderRadius;
	void settings.borderRadius;
	return {
		position: "absolute",
		left: `${(r.x / canvasSize.width) * 100}%`,
		top: `${(r.y / canvasSize.height) * 100}%`,
		width: `${(r.width / canvasSize.width) * 100}%`,
		height: `${(r.height / canvasSize.height) * 100}%`,
		overflow: "hidden",
		display: "flex",
		boxShadow: shadow,
	};
}

function videoBorderRadiusStyle(
	settings: ReturnType<typeof useEditorSettings>["settings"],
): React.CSSProperties {
	return { borderRadius: `${settings.borderRadius}px` };
}

// Webcam slot: full composite-layout rect with mask shape + shadow. NO
// borderRadius here — the rounded corners live on the <video> inside so they
// actually clip the camera content rather than drawing a frame around it.
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
		boxShadow: getWebcamLayoutCssBoxShadow(settings.webcamLayoutPreset as WebcamLayoutPreset),
	};
	void r.borderRadius;
	void mask;
	return clipPath ? { ...base, clipPath } : base;
}

// Blurred wallpaper copy. Hidden when showBlur is off.
function buildBlurStyle(
	settings: ReturnType<typeof useEditorSettings>["settings"],
): React.CSSProperties {
	if (!settings.showBlur) return { display: "none" };
	const wallpaper = settings.wallpaper;
	const isImageWallpaper = wallpaper.startsWith("/wallpapers/") || wallpaper.startsWith("data:");
	const isColor = wallpaper.startsWith("#");
	const isGradient =
		wallpaper.startsWith("linear-") ||
		wallpaper.startsWith("radial-") ||
		wallpaper.startsWith("conic-");

	if (isImageWallpaper) {
		return {
			backgroundImage: `url(${wallpaper})`,
			backgroundSize: "cover",
			backgroundPosition: "center",
			filter: "blur(28px)",
			opacity: 1,
		};
	}
	if (isColor) {
		return {
			backgroundColor: wallpaper,
			filter: "blur(28px)",
			opacity: 1,
		};
	}
	if (isGradient) {
		return {
			background: wallpaper,
			backgroundSize: "cover",
			filter: "blur(28px)",
			opacity: 1,
		};
	}
	return { display: "none" };
}

function clamp(v: number, min: number, max: number): number {
	return Math.min(Math.max(v, min), max);
}

function clamp01(v: number, min = 0, max = 1): number {
	return clamp(v, min, max);
}
