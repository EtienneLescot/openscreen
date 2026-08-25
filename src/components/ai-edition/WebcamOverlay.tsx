// Live webcam preview overlay. Reads the ACTIVE clip's asset `cameraTrack`
// (P4 — the camera link lives per-asset, not on the document, since a
// project can hold multiple recordings each with their own camera or none)
// and drives a real <video> element at the right source-time. The webcam is
// a derived stream — cuts/zoom/speed come from the main timeline. This
// component only reads; it does not write.
//
// ponytail: the camera plays in parallel with the screen. Source-time mapping
//   cameraTime = clip.sourceStartSec + (currentTimeSec − clip.timelineStartSec)
//   adjustment = (cameraTrack.startMs + cameraTrack.offsetMs) / 1000
//   final      = max(0, cameraTime − adjustment)
// (startMs is when the camera comes online; offsetMs is the early/late delay).
// Because this is resolved from the active clip's asset, the overlay
// naturally disappears when the playhead moves onto a clip whose asset has
// no camera, and reappears when it moves onto one that does.

import { useEffect, useMemo, useRef, useState } from "react";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import type { WebcamLayoutPreset, WebcamMaskShape } from "@/components/video-editor/types";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { useEditorSettings } from "@/lib/ai-edition/store/useEditorSettings";
import { resolveActiveCameraTrack } from "@/lib/ai-edition/timeline/camera";
import {
	CAMERA_SYNC_TOLERANCE_PAUSED_SEC,
	type PlaybackClockRef,
	resolveCameraSyncTarget,
} from "@/lib/ai-edition/timeline/playback-clock";
import { locateVirtualPosition } from "@/lib/ai-edition/timeline/virtual-preview";
import {
	renderSegmentedWebcam,
	type SegmentationRenderOptions,
} from "@/lib/ai-edition/webcamSegmentation";
import { getCssClipPath } from "@/lib/webcamMaskShapes";
import { setWebcamNativeSize } from "@/native/webcamSizeCache";
import styles from "./NewEditorShell.module.css";

interface WebcamOverlayProps {
	clips: AxcutClip[];
	currentTimeSec: number;
	onTimeChange: (sec: number) => void;
	isPlaying: boolean;
	// ponytail: container renders without a frame; the <video> is the only
	// thing the user actually sees. Border radius + clip-path therefore
	// belong on the video so they actually round the camera content.
	borderRadius: number;
	webcamMaskShape: WebcamMaskShape;
	layoutPreset: WebcamLayoutPreset;
	// The screen preview's live clock (see playback-clock.ts). When present,
	// sync is driven from this ref on our own rAF tick instead of the
	// currentTimeSec/isPlaying PROPS above — those props still gate whether
	// the camera element renders at all (see cameraTrack below), but the
	// numeric sync target comes straight from the screen's own rAF, this
	// frame, with no React round trip in between.
	clockRef?: PlaybackClockRef;
}

export function WebcamOverlay(props: WebcamOverlayProps) {
	const { settings } = useEditorSettings();
	const assets = useProjectStore((s) => s.document?.assets ?? null);

	const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
	const [hasError, setHasError] = useState(false);

	// Fallback (pre-clockRef / first paint) position from props, used only for
	// the initial correction on loadedmetadata before the rAF loop below has
	// had a chance to run.
	const position = useMemo(
		() => locateVirtualPosition(props.clips, props.currentTimeSec),
		[props.clips, props.currentTimeSec],
	);

	const cameraTrack = useMemo(
		() => resolveActiveCameraTrack(assets ?? [], props.clips, props.currentTimeSec),
		[assets, props.clips, props.currentTimeSec],
	);

	const cameraTime = useMemo(() => {
		if (!cameraTrack?.visible || !position) return null;
		const offsetSec = (cameraTrack.startMs + cameraTrack.offsetMs) / 1000;
		return Math.max(0, position.sourceTimeSec - offsetSec);
	}, [cameraTrack, position]);

	// Refs so the rAF tick below always reads the latest clips/assets without
	// re-creating the loop on every document mutation.
	const clipsRef = useRef(props.clips);
	clipsRef.current = props.clips;
	const assetsRef = useRef(assets);
	assetsRef.current = assets;

	// Drive the camera <video> directly off the shared playback clock: read
	// it every rAF tick, resolve which clip/camera is active THIS frame, and
	// correct time/rate/play-state in one place. This replaces two separate
	// prop-driven effects (time correction + play/pause mirroring), both of
	// which depended on a React state round trip from the screen preview.
	useEffect(() => {
		if (!videoEl || !props.clockRef) return;
		const clockRef = props.clockRef;
		let raf = 0;
		const tick = () => {
			raf = window.requestAnimationFrame(tick);
			const clock = clockRef.current;
			const clipsNow = clipsRef.current;
			const positionNow = locateVirtualPosition(clipsNow, clock.virtualTimeSec);
			const trackNow = resolveActiveCameraTrack(
				assetsRef.current ?? [],
				clipsNow,
				clock.virtualTimeSec,
			);
			const target = resolveCameraSyncTarget(
				clock,
				trackNow,
				positionNow ? positionNow.sourceTimeSec : null,
			);
			if (!target) return;

			if (videoEl.playbackRate !== target.playbackRate) {
				videoEl.playbackRate = target.playbackRate;
			}

			if (Math.abs(videoEl.currentTime - target.targetTimeSec) > target.toleranceSec) {
				try {
					videoEl.currentTime = target.targetTimeSec;
				} catch {
					// ponytail: silent — video not ready yet
				}
			}

			if (target.isPlaying && videoEl.paused) {
				void videoEl.play().catch(() => setHasError(true));
			} else if (!target.isPlaying && !videoEl.paused) {
				videoEl.pause();
			}
		};
		raf = window.requestAnimationFrame(tick);
		return () => window.cancelAnimationFrame(raf);
	}, [videoEl, props.clockRef]);

	// Fallback for when no clockRef is wired up (defensive — all current call
	// sites pass one): keep the old prop-driven correction so the overlay
	// still works, just with the previously-reported latency.
	useEffect(() => {
		if (!videoEl || props.clockRef) return;
		if (cameraTime === null) return;
		if (Math.abs(videoEl.currentTime - cameraTime) > CAMERA_SYNC_TOLERANCE_PAUSED_SEC) {
			try {
				videoEl.currentTime = cameraTime;
			} catch {
				// ponytail: silent — video not ready yet
			}
		}
	}, [videoEl, cameraTime, props.clockRef]);

	useEffect(() => {
		if (!videoEl || props.clockRef) return;
		if (props.isPlaying) {
			void videoEl.play().catch(() => setHasError(true));
		} else {
			videoEl.pause();
		}
	}, [videoEl, props.isPlaying, props.clockRef]);

	const canvasRef = useRef<HTMLCanvasElement | null>(null);

	// Same idiom as the playback-clock loop above: the rAF tick reads the latest
	// settings through a ref so the loop is not re-created on every document mutation.
	const requestRenderRef = useRef<(() => void) | null>(null);
	const segmentationOptionsRef = useRef<SegmentationRenderOptions>({
		mode: settings.webcamBackgroundMode,
		blurIntensity: settings.webcamBlurIntensity,
		wallpaper: settings.webcamWallpaper,
		crop: settings.webcamCropRegion,
	});

	// Neural segmentation render loop when background effect is active
	useEffect(() => {
		if (!videoEl || settings.webcamBackgroundMode === "none") return;
		const canvas = canvasRef.current;
		if (!canvas) return;

		let isDestroyed = false;
		let raf = 0;

		const render = async () => {
			if (isDestroyed || videoEl.readyState < 2) return;
			// Read through the ref, not the closure: the loop must survive a document
			// mutation (a slider drag writes a new document on every tick) without being
			// torn down and rebuilt.
			try {
				await renderSegmentedWebcam(videoEl, canvas, segmentationOptionsRef.current);
			} catch (err) {
				console.error("[WebcamOverlay] Segmentation error:", err);
			}
		};

		// One frame in flight at a time, with a TRAILING re-run: dropping overlapping
		// requests outright would leave the canvas on the pre-seek frame while scrubbing
		// (each `seeked` lands while the previous render is still running, and nothing
		// re-renders once it finishes because the rAF loop only draws while playing).
		let inFlight: Promise<void> | null = null;
		let rerunRequested = false;
		const requestRender = () => {
			if (inFlight) {
				rerunRequested = true;
				return;
			}
			const run = () => {
				inFlight = render().finally(() => {
					inFlight = null;
					if (rerunRequested && !isDestroyed) {
						rerunRequested = false;
						run();
					}
				});
			};
			run();
		};

		const processFrame = () => {
			if (isDestroyed) return;
			if (!videoEl.paused) requestRender();
			raf = window.requestAnimationFrame(processFrame);
		};

		requestRender();
		// Exposed so the settings effect below can repaint a PAUSED preview: the rAF pump
		// only draws while playing, so without this, dragging the blur slider or picking a
		// wallpaper would change nothing on screen until playback resumed.
		requestRenderRef.current = requestRender;
		videoEl.addEventListener("seeked", requestRender);
		videoEl.addEventListener("loadeddata", requestRender);
		raf = window.requestAnimationFrame(processFrame);

		return () => {
			isDestroyed = true;
			requestRenderRef.current = null;
			window.cancelAnimationFrame(raf);
			videoEl.removeEventListener("seeked", requestRender);
			videoEl.removeEventListener("loadeddata", requestRender);
		};
	}, [videoEl, settings.webcamBackgroundMode]);

	// Publish the latest options to the loop, then repaint. Keyed on the SCALAR crop
	// values rather than `settings.webcamCropRegion`'s identity, which `getEditorSettings`
	// rebuilds on every document mutation. The repaint matters because the rAF pump only
	// draws while playing: without it, dragging the blur slider or picking a wallpaper
	// would change nothing on screen until playback resumed.
	const { x: cropX, y: cropY, width: cropW, height: cropH } = settings.webcamCropRegion;
	useEffect(() => {
		segmentationOptionsRef.current = {
			mode: settings.webcamBackgroundMode,
			blurIntensity: settings.webcamBlurIntensity,
			wallpaper: settings.webcamWallpaper,
			// Native crops the webcam with `webcam_crop` before the cover-fit; the canvas
			// has to do the same or a cropped camera previews uncropped.
			crop: { x: cropX, y: cropY, width: cropW, height: cropH },
		};
		requestRenderRef.current?.();
	}, [
		settings.webcamBackgroundMode,
		settings.webcamBlurIntensity,
		settings.webcamWallpaper,
		cropX,
		cropY,
		cropW,
		cropH,
	]);

	if (!cameraTrack?.sourcePath || !cameraTrack.visible) {
		return null;
	}

	// ponytail: the layout computes the final borderRadius (preset fraction for
	// dual-frame/overlay, 0 for stack, half-circle for circle PiP, etc.). Push it onto
	// the element that actually carries the pixels so it clips the camera content; the
	// container stays a transparent, overflow:hidden wrapper.
	const videoStyle: React.CSSProperties = {
		display: hasError ? "none" : "block",
		transform: settings.webcamMirrored ? "scaleX(-1)" : undefined,
		clipPath: getCssClipPath(props.webcamMaskShape) ?? undefined,
		borderRadius: `${props.borderRadius}px`,
	};

	// With an effect on, the pixels come from the segmentation canvas — background
	// included, in every mode — so the <video> stays mounted only as the decode/clock
	// source. There is deliberately no CSS background layer behind it: one existed and
	// was either invisible (an opaque canvas covers it) or a second, differently-painted
	// copy of the same wallpaper, which is exactly how preview and export drifted apart.
	const isCustomEffect = settings.webcamBackgroundMode !== "none";

	return (
		<>
			<video
				key={cameraTrack.sourcePath}
				ref={(el) => {
					setVideoEl(el);
					setHasError(false);
				}}
				src={toFileUrl(cameraTrack.sourcePath)}
				className={styles.webcamVideo}
				muted
				playsInline
				preload="metadata"
				onError={() => setHasError(true)}
				onLoadedMetadata={(event) => {
					const target = event.currentTarget;
					const w = target.videoWidth;
					const h = target.videoHeight;
					if (w > 0 && h > 0) {
						setWebcamNativeSize(cameraTrack.sourcePath, { width: w, height: h });
					}
					if (
						cameraTime !== null &&
						videoEl &&
						Math.abs(videoEl.currentTime - cameraTime) > CAMERA_SYNC_TOLERANCE_PAUSED_SEC
					) {
						try {
							videoEl.currentTime = cameraTime;
						} catch {
							// silent
						}
					}
				}}
				style={
					isCustomEffect
						? { ...videoStyle, position: "absolute", opacity: 0, pointerEvents: "none" }
						: videoStyle
				}
			/>
			{isCustomEffect ? (
				<canvas ref={canvasRef} className={styles.webcamCanvas} style={videoStyle} />
			) : null}
		</>
	);
}
