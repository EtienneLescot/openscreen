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
import type { WebcamLayoutPreset, WebcamMaskShape } from "@/components/video-editor/types";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import { useEditorSettings } from "@/lib/ai-edition/store/useEditorSettings";
import {
	computeCompositeLayout,
	getWebcamLayoutCssBoxShadow,
	type WebcamCompositeLayout,
} from "@/lib/compositeLayout";
import { getCssClipPath } from "@/lib/webcamMaskShapes";
import styles from "./NewEditorShell.module.css";
import { type VideoSource, VirtualPreview } from "./VirtualPreview";
import { WebcamOverlay } from "./WebcamOverlay";

interface PreviewCanvasProps {
	videoSources: VideoSource[];
	clips: AxcutClip[];
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
	const frameRef = useRef<HTMLDivElement | null>(null);
	const webcamSlotRef = useRef<HTMLDivElement | null>(null);
	const [canvasSize, setCanvasSize] = useState({ width: 1280, height: 720 });

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
	const [isPlaying, setIsPlaying] = useState(false);
	const handleVideoElement = useMemo(() => props.onVideoElement, [props.onVideoElement]);
	const relayIsPlaying = (el: HTMLVideoElement | null) => {
		handleVideoElement(el);
		setIsPlaying(!el?.paused);
	};
	const relayProps = { ...props, onVideoElement: relayIsPlaying };

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

	return (
		<div ref={frameRef} className={styles.previewFrame} style={frameStyle}>
			<div className={styles.bgBlur} style={blurStyle} aria-hidden />
			{layout?.screenRect ? (
				<div className={styles.screenStage} style={screenStyle}>
					<VirtualPreview {...relayProps} videoStyle={videoBorderRadiusStyle(settings)} />
				</div>
			) : null}
			{layout?.webcamRect ? (
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
