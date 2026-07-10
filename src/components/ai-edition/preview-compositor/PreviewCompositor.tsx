// Single-canvas Pixi/WebGL compositor for the screen recording, replacing
// the CSS-transform + plain <video> approach `VirtualPreview` used.
//
// Why: the screen recording used to be a bare <video> element with zoom/pan
// applied as a CSS `transform` on its wrapper div, re-computed on every
// virtual-time tick. That's a DOM style write + layout/paint cost 60x/sec on
// top of the browser's own video decode/paint — main branch instead decodes
// the video straight into a Pixi texture and applies zoom/pan as a Pixi
// container transform, so the whole frame (video + mask + zoom) is one GPU
// draw call per tick with no DOM reflow. This component ports that approach
// for the screen source only (the webcam stays a plain <video> — see
// WebcamOverlay.tsx and playback-clock.ts for its own, separately-fixed,
// sync story; main doesn't Pixi-composite the webcam either).
//
// The actual timeline-aware playback logic (clip-boundary advancement, skip
// ranges, speed regions, asset switching, seeking) is unchanged from
// VirtualPreview — only the RENDERING of the active frame moved from
// CSS+<video> to Pixi+<canvas>. The <video> element itself is kept in the
// DOM (invisible) purely as the decode source Pixi's VideoSource wraps, and
// so CursorPreviewLayer's existing "measure the sibling <video>" sizing
// keeps working unmodified.

import { Application, Container, Graphics, Sprite, Texture, VideoSource } from "pixi.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fromFileUrl } from "@/components/video-editor/projectPersistence";
import type { AxcutClip, AxcutTrimRange, AxcutZoomRegion } from "@/lib/ai-edition/schema";
import { useEditorSettings } from "@/lib/ai-edition/store/useEditorSettings";
import type { PlaybackClockRef } from "@/lib/ai-edition/timeline/playback-clock";
import { findActiveSpeedRegion, type SpeedRegion } from "@/lib/ai-edition/timeline/speed";
import {
	clampVirtualTime,
	locateSourcePosition,
	locateVirtualPosition,
	totalVirtualDuration,
} from "@/lib/ai-edition/timeline/virtual-preview";
import {
	computeZoomPreviewTransform,
	IDENTITY_ZOOM_TRANSFORM,
} from "@/lib/ai-edition/timeline/zoom-preview";
import { CursorPreviewLayer } from "../CursorPreviewLayer";
import styles from "./PreviewCompositor.module.css";

export interface VideoSourceDescriptor {
	id: string;
	src: string;
	label: string;
}

interface PreviewCompositorProps {
	videoSources: VideoSourceDescriptor[];
	clips: AxcutClip[];
	zoomRegions?: AxcutZoomRegion[];
	speedRegions?: SpeedRegion[];
	trimRanges?: AxcutTrimRange[];
	seekTarget?: { timeSec: number; isSource?: boolean; requestId: number } | null;
	onTimeChange?: (timeSec: number) => void;
	onLoadedMetadata?: (durationSec: number, assetId: string) => void;
	onVideoElement?: (element: HTMLVideoElement | null) => void;
	onVideoError?: () => void;
	/** Written every tick so the webcam overlay can stay locked to this clock. */
	clockRef?: PlaybackClockRef;
}

interface Size {
	width: number;
	height: number;
}

export function PreviewCompositor({
	videoSources,
	clips,
	zoomRegions = [],
	speedRegions = [],
	trimRanges = [],
	seekTarget,
	onTimeChange,
	onLoadedMetadata,
	onVideoElement,
	onVideoError,
	clockRef,
}: PreviewCompositorProps) {
	const { settings } = useEditorSettings();
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const frameRef = useRef<HTMLDivElement | null>(null);
	const canvasHostRef = useRef<HTMLDivElement | null>(null);

	const isProgrammaticSeekRef = useRef(false);
	const pendingSeekRef = useRef<{ sourceTimeSec: number; play: boolean } | null>(null);
	const [virtualTimeSec, setVirtualTimeSec] = useState(0);
	const [isPlaying, setIsPlaying] = useState(false);
	const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
	const [sourceIndex, setSourceIndex] = useState(0);
	const [canvasSize, setCanvasSize] = useState<Size>({ width: 0, height: 0 });

	const virtualDurationSec = useMemo(() => totalVirtualDuration(clips), [clips]);
	const activeSource = videoSources[sourceIndex] ?? null;

	// See VirtualPreview's original comment: the cursor overlay wants
	// source-media time, not virtual-timeline time.
	const [sourceTimeSec, setSourceTimeSec] = useState(0);

	const sourceTimeSecRef = useRef(0);
	sourceTimeSecRef.current = sourceTimeSec;
	const clipsRef = useRef(clips);
	clipsRef.current = clips;
	const videoSourcesRef = useRef(videoSources);
	videoSourcesRef.current = videoSources;
	const sourceIndexRef = useRef(sourceIndex);
	sourceIndexRef.current = sourceIndex;
	const virtualTimeSecRef = useRef(virtualTimeSec);
	virtualTimeSecRef.current = virtualTimeSec;
	const virtualDurationSecRef = useRef(virtualDurationSec);
	virtualDurationSecRef.current = virtualDurationSec;
	const speedRegionsRef = useRef(speedRegions);
	speedRegionsRef.current = speedRegions;
	const trimRangesRef = useRef(trimRanges);
	trimRangesRef.current = trimRanges;

	const updateVirtualTime = useCallback(
		(nextTimeSec: number) => {
			setVirtualTimeSec(nextTimeSec);
			onTimeChange?.(nextTimeSec);
			const v = videoRef.current;
			if (v) {
				const activeRegion = findActiveSpeedRegion(
					speedRegionsRef.current,
					Math.round(nextTimeSec * 1000),
				);
				const rate = activeRegion?.speed ?? 1;
				if (v.playbackRate !== rate) v.playbackRate = rate;
			}
		},
		[onTimeChange],
	);

	// Playback/time-mapping rAF — ported verbatim from VirtualPreview, plus
	// publishing this frame's state to the shared clock for the webcam.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-create when the active source swaps.
	useEffect(() => {
		let raf = 0;
		const tick = () => {
			raf = window.requestAnimationFrame(tick);
			const v = videoRef.current;
			if (!v || !Number.isFinite(v.currentTime)) {
				return;
			}
			if (clockRef) {
				clockRef.current.sourceTimeSec = v.currentTime;
				clockRef.current.isPlaying = !v.paused;
				clockRef.current.playbackRate = v.playbackRate;
				clockRef.current.virtualTimeSec = virtualTimeSecRef.current;
			}
			const activeSourceId = videoSourcesRef.current[sourceIndexRef.current]?.id;
			if (!v.paused) {
				const activeTrim = trimRangesRef.current.find(
					(skip) =>
						skip.assetId === activeSourceId &&
						v.currentTime >= skip.startSec &&
						v.currentTime < skip.endSec,
				);
				if (activeTrim) {
					if (activeTrim.endSec >= (v.duration || Infinity)) {
						v.pause();
					} else {
						v.currentTime = activeTrim.endSec + 0.05;
					}
					return;
				}
			}
			if (v.readyState >= 2) {
				setSourceTimeSec(v.currentTime);
			}
			if (clipsRef.current.length === 0) {
				updateVirtualTime(v.currentTime);
				return;
			}
			if (isProgrammaticSeekRef.current) {
				isProgrammaticSeekRef.current = false;
				const pos = locateSourcePosition(clipsRef.current, v.currentTime, activeSourceId);
				if (pos) updateVirtualTime(clampVirtualTime(clipsRef.current, pos.virtualTimeSec));
				return;
			}
			const position = locateSourcePosition(clipsRef.current, v.currentTime, activeSourceId);
			if (!position) {
				const nextClip = clipsRef.current.find(
					(clip) => clip.timelineStartSec > virtualTimeSecRef.current + 0.001,
				);
				if (nextClip) seekToVirtualTime(nextClip.timelineStartSec, true);
				else {
					v.pause();
					updateVirtualTime(virtualDurationSecRef.current);
					setIsPlaying(false);
				}
				return;
			}
			const reachedClipEnd = v.currentTime >= (position.clip.sourceEndSec ?? Infinity) - 0.04;
			if (reachedClipEnd) {
				const nextClip = clipsRef.current[position.clipIndex + 1];
				if (!nextClip) {
					v.pause();
					updateVirtualTime(virtualDurationSecRef.current);
					setIsPlaying(false);
					return;
				}
				seekToVirtualTime(nextClip.timelineStartSec, true);
				return;
			}
			updateVirtualTime(clampVirtualTime(clipsRef.current, position.virtualTimeSec));
		};
		raf = window.requestAnimationFrame(tick);
		return () => window.cancelAnimationFrame(raf);
	}, [activeSource?.src]);

	const activeSourceKey = activeSource?.src ?? null;
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-run on source swap
	useEffect(() => {
		onVideoElement?.(videoRef.current);
		return () => onVideoElement?.(null);
	}, [onVideoElement, activeSourceKey]);

	const seekToVirtualTime = useCallback(
		(nextVirtualTimeSec: number, preservePlayback = false) => {
			const position = locateVirtualPosition(clips, nextVirtualTimeSec);
			if (!position) {
				updateVirtualTime(0);
				setIsPlaying(false);
				return;
			}
			const targetIndex = videoSources.findIndex((vs) => vs.id === position.clip.assetId);
			const isAssetSwitch = targetIndex >= 0 && targetIndex !== sourceIndex;
			const shouldContinuePlayback = preservePlayback && isPlaying;

			if (isAssetSwitch) {
				setSourceIndex(targetIndex);
				setLoadState("loading");
				updateVirtualTime(position.virtualTimeSec);
				pendingSeekRef.current = {
					sourceTimeSec: position.sourceTimeSec,
					play: shouldContinuePlayback,
				};
				return;
			}

			const video = videoRef.current;
			if (!video) return;

			isProgrammaticSeekRef.current = true;
			updateVirtualTime(position.virtualTimeSec);
			if (Math.abs(video.currentTime - position.sourceTimeSec) > 0.01) {
				video.currentTime = position.sourceTimeSec;
			}
			if (shouldContinuePlayback) {
				void video.play().catch(() => setIsPlaying(false));
			}
		},
		[clips, videoSources, sourceIndex, isPlaying, updateVirtualTime],
	);

	const seekToSourceTime = useCallback((sourceTimeSec: number) => {
		const video = videoRef.current;
		if (!video) return;
		isProgrammaticSeekRef.current = true;
		if (Math.abs(video.currentTime - sourceTimeSec) > 0.01) {
			video.currentTime = sourceTimeSec;
		}
	}, []);

	useEffect(() => {
		if (!seekTarget) return;
		if (seekTarget.isSource) {
			seekToSourceTime(seekTarget.timeSec);
		} else {
			seekToVirtualTime(seekTarget.timeSec);
		}
	}, [seekTarget, seekToVirtualTime, seekToSourceTime]);

	// --- Pixi compositor -----------------------------------------------

	const appRef = useRef<Application | null>(null);
	const spriteRef = useRef<Sprite | null>(null);
	const maskRef = useRef<Graphics | null>(null);
	const cameraContainerRef = useRef<Container | null>(null);
	const [pixiReady, setPixiReady] = useState(false);

	// Keep the canvas host positioned/sized exactly over the hidden video's
	// rendered (contain-fit) box — same rect-tracking technique
	// CursorPreviewLayer already uses for its own overlay.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-run on source swap so the observer re-attaches
	useEffect(() => {
		const video = videoRef.current;
		const frame = frameRef.current;
		const host = canvasHostRef.current;
		if (!video || !frame || !host) return;
		const update = () => {
			const videoRect = video.getBoundingClientRect();
			const frameRect = frame.getBoundingClientRect();
			if (videoRect.width <= 0 || videoRect.height <= 0) return;
			const width = Math.round(videoRect.width);
			const height = Math.round(videoRect.height);
			host.style.left = `${Math.round(videoRect.left - frameRect.left)}px`;
			host.style.top = `${Math.round(videoRect.top - frameRect.top)}px`;
			host.style.width = `${width}px`;
			host.style.height = `${height}px`;
			setCanvasSize((prev) =>
				prev.width === width && prev.height === height ? prev : { width, height },
			);
		};
		update();
		const ro = new ResizeObserver(update);
		ro.observe(video);
		ro.observe(frame);
		return () => ro.disconnect();
	}, [activeSourceKey]);

	// Create the Pixi Application + video sprite once per active source.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-create when the active source swaps
	useEffect(() => {
		const video = videoRef.current;
		const host = canvasHostRef.current;
		if (!video || !host || !activeSource) return;
		let mounted = true;
		let app: Application | null = null;

		(async () => {
			app = new Application();
			await app.init({
				width: canvasSize.width || 1,
				height: canvasSize.height || 1,
				backgroundAlpha: 0,
				antialias: true,
				resolution: window.devicePixelRatio || 1,
				autoDensity: true,
			});
			if (!mounted) {
				app.destroy(true, { children: true, texture: true, textureSource: true });
				return;
			}
			app.ticker.maxFPS = 60;
			host.appendChild(app.canvas);
			appRef.current = app;

			const source = VideoSource.from(video);
			(source as unknown as { autoPlay: boolean }).autoPlay = false;
			(source as unknown as { autoUpdate: boolean }).autoUpdate = true;
			const texture = Texture.from(source);
			const sprite = new Sprite(texture);
			const mask = new Graphics();
			const cameraContainer = new Container();
			cameraContainer.addChild(sprite);
			cameraContainer.mask = mask;
			app.stage.addChild(mask, cameraContainer);

			spriteRef.current = sprite;
			maskRef.current = mask;
			cameraContainerRef.current = cameraContainer;
			setPixiReady(true);
		})();

		return () => {
			mounted = false;
			setPixiReady(false);
			if (app?.renderer) {
				const canvas = app.canvas;
				if (canvas.parentElement === host) host.removeChild(canvas);
				app.destroy(true, { children: true, texture: true, textureSource: true });
			}
			appRef.current = null;
			spriteRef.current = null;
			maskRef.current = null;
			cameraContainerRef.current = null;
		};
	}, [activeSourceKey]);

	// Resize the renderer + redraw the rounded-corner mask whenever the
	// measured box or the border-radius setting changes.
	useEffect(() => {
		if (!pixiReady) return;
		const app = appRef.current;
		const mask = maskRef.current;
		const sprite = spriteRef.current;
		if (!app || !mask || !sprite) return;
		const { width, height } = canvasSize;
		if (width <= 0 || height <= 0) return;
		app.renderer.resize(width, height);
		sprite.width = width;
		sprite.height = height;
		mask.clear();
		mask.roundRect(0, 0, width, height, settings.borderRadius).fill({ color: 0xffffff });
	}, [pixiReady, canvasSize, settings.borderRadius]);

	// Zoom/pan: same easing math as before (computeZoomPreviewTransform),
	// applied as a Pixi container transform instead of a CSS `transform`
	// string. Pixi composes scale-then-position around origin (0,0) by
	// default, matching CSS's `translate() scale()` composition order with
	// `transform-origin: 0 0` — so the percentage-based translate output
	// maps directly onto pixel offsets of the (pre-scale) canvas size.
	useEffect(() => {
		if (!pixiReady) return;
		const cameraContainer = cameraContainerRef.current;
		if (!cameraContainer) return;
		const activeSpeedRegion = findActiveSpeedRegion(
			speedRegionsRef.current,
			Math.round(virtualTimeSec * 1000),
		);
		const playbackRate = activeSpeedRegion?.speed ?? 1;
		const transform =
			zoomRegions.length === 0
				? IDENTITY_ZOOM_TRANSFORM
				: computeZoomPreviewTransform(zoomRegions, virtualTimeSec * 1000, undefined, playbackRate);
		cameraContainer.scale.set(transform.scale);
		cameraContainer.position.set(
			(transform.translateXPercent / 100) * canvasSize.width,
			(transform.translateYPercent / 100) * canvasSize.height,
		);
	}, [pixiReady, zoomRegions, virtualTimeSec, canvasSize]);

	return (
		<div className={styles.container}>
			{activeSource ? (
				<div
					ref={frameRef}
					className={styles.videoFrame}
					style={{ cursor: settings.cursorShow ? "none" : undefined }}
				>
					<video
						key={activeSource.src}
						ref={videoRef}
						src={activeSource.src}
						className={styles.video}
						preload="metadata"
						playsInline
						onLoadedMetadata={(e) => {
							setLoadState("ready");
							onLoadedMetadata?.(e.currentTarget.duration, activeSource.id);
							if (pendingSeekRef.current) {
								const { sourceTimeSec, play } = pendingSeekRef.current;
								pendingSeekRef.current = null;
								e.currentTarget.currentTime = sourceTimeSec;
								if (play) {
									void e.currentTarget.play().catch(() => setIsPlaying(false));
								}
							} else if (clips.length > 0) {
								seekToVirtualTime(virtualTimeSec);
							}
						}}
						onWaiting={() => setLoadState("loading")}
						onCanPlay={() => setLoadState("ready")}
						onError={() => {
							pendingSeekRef.current = null;
							setLoadState("error");
							setIsPlaying(false);
							onVideoError?.();
						}}
						onPause={() => setIsPlaying(false)}
						onPlay={() => setIsPlaying(true)}
						onEnded={() => setIsPlaying(false)}
					/>
					<div ref={canvasHostRef} className={styles.canvasHost} />
					{loadState !== "ready" && (
						<div className={styles.overlay}>
							{loadState === "error" ? "Video preview could not be loaded." : "Loading preview…"}
						</div>
					)}
					<CursorPreviewLayer
						videoPath={activeSource ? fromFileUrl(activeSource.src) : null}
						currentTimeSec={sourceTimeSec}
						isPlaying={isPlaying}
					/>
				</div>
			) : (
				<div className={styles.placeholder}>Attach a video to start previewing.</div>
			)}
		</div>
	);
}
