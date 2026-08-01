// Shared cursor preview layer for the editor.
//
// Renders the cursor on top of a <video> element. Uses the same cursor
// assets, smoothing, click bounce, motion blur, and themed native cursor
// bitmaps as the legacy editor's Pixi-based path. Reads cursor visual
// config from `useEditorSettings`.
//
// The cursor data lives in `src/lib/cursor/` so both editors share the
// same `PixiCursorOverlay` class: the new editor mounts this component as
// a sibling of the <video>, and the legacy editor drives the same
// `PixiCursorOverlay` directly from inside its existing Pixi stage
// (which carries the additional zoom / crop / 3D transform math).

import { Application, Container } from "pixi.js";
import {
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { CropRegion, CursorTelemetryPoint } from "@/components/video-editor/types";
import type { AxcutCursorMotionRegion } from "@/lib/ai-edition/schema";
import { useEditorSettings } from "@/lib/ai-edition/store/useEditorSettings";
import {
	type CursorMotionOwner,
	type CursorMotionPath,
	findCursorMotionRegionAtSourceTime,
	projectCursorMotionPointToCrop,
	sampleCursorMotion,
	unprojectCursorMotionPointFromCrop,
} from "@/lib/cursor/cursorMotion";
import { getSmoothedCursorPath } from "@/lib/cursor/cursorPathSmoothing";
import {
	createNativeCursorMotionBlurState,
	getNativeCursorClickBounceProgress,
	getNativeCursorClickBounceScale,
	getNativeCursorMotionBlurPx,
	hasNativeCursorRecordingData,
	resolveInterpolatedNativeCursorFrame,
	resolveNativeCursorRenderAsset,
} from "@/lib/cursor/nativeCursor";
import {
	DEFAULT_CURSOR_CONFIG,
	PixiCursorOverlay,
	preloadCursorAssets,
} from "@/lib/cursor/pixiCursorRenderer";
import type { CursorRecordingData } from "@/native/contracts";
import styles from "./CursorPreviewLayer.module.css";

const IDENTITY_CURSOR_CROP: CropRegion = { x: 0, y: 0, width: 1, height: 1 };

export interface CursorPreviewLayerProps {
	videoPath: string | null;
	currentTimeSec: number;
	isPlaying: boolean;
	cursorRecordingData?: CursorRecordingData | null;
	cursorTelemetry?: CursorTelemetryPoint[];
	cropRegion?: CropRegion;
	assetId?: string | null;
	clipId?: string | null;
	cursorMotionRegions?: AxcutCursorMotionRegion[];
	selectedCursorMotionRegionId?: string | null;
	onControlPointChange?: (id: string, index: number, point: { cx: number; cy: number }) => void;
	onControlPointCommit?: () => void;
}

export function CursorPreviewLayer({
	videoPath,
	currentTimeSec,
	isPlaying,
	cursorRecordingData = null,
	cursorTelemetry = [],
	cropRegion = IDENTITY_CURSOR_CROP,
	assetId = null,
	clipId = null,
	cursorMotionRegions = [],
	selectedCursorMotionRegionId = null,
	onControlPointChange,
	onControlPointCommit,
}: CursorPreviewLayerProps) {
	const { settings } = useEditorSettings();

	const hasNativeCursor = useMemo(
		() => hasNativeCursorRecordingData(cursorRecordingData),
		[cursorRecordingData],
	);
	const recordedMotionPath = useMemo<CursorMotionPath | null>(() => {
		const data = hasNativeCursor
			? cursorRecordingData
			: cursorTelemetry.length > 0
				? {
						version: 1,
						provider: "none" as const,
						samples: cursorTelemetry as never,
						assets: [],
					}
				: null;
		const path = getSmoothedCursorPath(data, settings.cursor.smoothing);
		return path ? { sampleAtSourceTime: (timeMs) => path.sampleAt(timeMs) } : null;
	}, [cursorRecordingData, cursorTelemetry, hasNativeCursor, settings.cursor.smoothing]);
	const owner = useMemo<CursorMotionOwner | null>(
		() => (assetId && clipId ? { assetId, clipId } : null),
		[assetId, clipId],
	);
	const selectedMotionRegion = useMemo(
		() =>
			cursorMotionRegions.find(
				(region) =>
					region.id === selectedCursorMotionRegionId &&
					region.assetId === assetId &&
					region.clipId === clipId,
			) ?? null,
		[cursorMotionRegions, selectedCursorMotionRegionId, assetId, clipId],
	);

	// Layer ref — the DOM <div> that hosts the Pixi canvas + native-cursor
	// <img>. Sized to the <video> via ResizeObserver; both editors mount the
	// layer as a sibling of the <video> so the measurements line up.
	const layerRef = useRef<HTMLDivElement | null>(null);
	const [size, setSize] = useState({ width: 0, height: 0 });

	// biome-ignore lint/correctness/useExhaustiveDependencies: re-run when videoPath changes so the observer re-attaches to the active preview.
	useEffect(() => {
		const layer = layerRef.current;
		if (!layer) return;
		const update = () => {
			const rect = layer.getBoundingClientRect();
			setSize({ width: rect.width, height: rect.height });
		};
		update();
		const ro = new ResizeObserver(update);
		ro.observe(layer);
		window.addEventListener("resize", update);
		return () => {
			ro.disconnect();
			window.removeEventListener("resize", update);
		};
	}, [videoPath]);

	// Pixi application + cursor overlay lifecycle. The app is created once
	// per videoPath and torn down on swap. The overlay is created after
	// cursor assets finish loading (otherwise it'd throw on missing assets).
	const appRef = useRef<Application | null>(null);
	const overlayRef = useRef<PixiCursorOverlay | null>(null);
	const [pixiReady, setPixiReady] = useState(false);
	const appMountedRef = useRef<HTMLDivElement | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: re-create on videoPath so the Pixi stage tracks the current asset.
	useEffect(() => {
		if (!videoPath) {
			setPixiReady(false);
			return;
		}
		const host = layerRef.current;
		if (!host) return;
		let mounted = true;
		let app: Application | null = null;

		(async () => {
			let enabled = true;
			try {
				await preloadCursorAssets();
			} catch {
				enabled = false;
			}
			if (!mounted) return;
			if (!enabled) {
				setPixiReady(false);
				return;
			}
			app = new Application();
			await app.init({
				width: size.width || 1,
				height: size.height || 1,
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
			appMountedRef.current = host;

			const overlay = new PixiCursorOverlay({
				dotRadius: DEFAULT_CURSOR_CONFIG.dotRadius * settings.cursor.size,
				smoothingFactor: settings.cursor.smoothing,
				motionBlur: settings.cursor.motionBlur,
				clickBounce: settings.cursor.clickBounce,
			});
			overlay.container.label = "cursor-overlay";
			app.stage.addChild(overlay.container as Container);
			overlayRef.current = overlay;
			setPixiReady(true);
		})();

		return () => {
			mounted = false;
			setPixiReady(false);
			if (overlayRef.current) {
				overlayRef.current.destroy();
				overlayRef.current = null;
			}
			if (app && app.renderer) {
				const canvas = app.canvas;
				if (canvas.parentElement === host) host.removeChild(canvas);
				app.destroy(true, { children: true, texture: true, textureSource: true });
			}
			appRef.current = null;
			appMountedRef.current = null;
		};
		// ponytail: settings.* are read inside the async init only on
		// mount; live updates go through the rAF tick + the live-update
		// effect below.
	}, [videoPath]);

	// Live-update the overlay's config when the panel sliders move. The
	// effect is debounced via the rAF tick — the smoothing slider in
	// particular benefits from resetting the spring state.
	useEffect(() => {
		const overlay = overlayRef.current;
		if (!overlay) return;
		overlay.setDotRadius(DEFAULT_CURSOR_CONFIG.dotRadius * settings.cursor.size);
		overlay.setSmoothingFactor(settings.cursor.smoothing);
		overlay.setMotionBlur(settings.cursor.motionBlur);
		overlay.setClickBounce(settings.cursor.clickBounce);
		overlay.reset();
	}, [
		settings.cursor.size,
		settings.cursor.smoothing,
		settings.cursor.motionBlur,
		settings.cursor.clickBounce,
	]);

	// Native cursor (DOM <img>) refs.
	const imageRef = useRef<HTMLImageElement | null>(null);
	const clipRef = useRef<HTMLDivElement | null>(null);
	const motionBlurStateRef = useRef(createNativeCursorMotionBlurState());
	const lastImageIdRef = useRef<string | null>(null);

	// rAF tick — drives both the Pixi overlay (telemetry cursor) and the
	// native cursor DOM <img> (recorded cursor). Reads the latest refs
	// inside the tick so React state churn doesn't restart the loop.
	const timeRef = useRef(currentTimeSec);
	const playingRef = useRef(isPlaying);
	const showCursorRef = useRef(settings.cursorShow);
	const cursorThemeRef = useRef(settings.cursorTheme);
	const sizeRef = useRef(size);
	const hasNativeRef = useRef(hasNativeCursor);
	const recordingDataRef = useRef(cursorRecordingData);
	const telemetryRef = useRef(cursorTelemetry);
	const recordedMotionPathRef = useRef(recordedMotionPath);
	const cursorMotionRegionsRef = useRef(cursorMotionRegions);
	const ownerRef = useRef(owner);
	const cropRegionRef = useRef(cropRegion);
	const clickBounceRef = useRef(settings.cursor.clickBounce);
	const cursorSizeRef = useRef(settings.cursor.size);
	const cursorMotionBlurRef = useRef(settings.cursor.motionBlur);
	const cursorClipToBoundsRef = useRef(settings.cursor.clipToBounds);

	useEffect(() => {
		timeRef.current = currentTimeSec;
	}, [currentTimeSec]);
	useEffect(() => {
		playingRef.current = isPlaying;
	}, [isPlaying]);
	useEffect(() => {
		showCursorRef.current = settings.cursorShow;
	}, [settings.cursorShow]);
	useEffect(() => {
		cursorThemeRef.current = settings.cursorTheme;
	}, [settings.cursorTheme]);
	useEffect(() => {
		sizeRef.current = size;
	}, [size]);
	useEffect(() => {
		hasNativeRef.current = hasNativeCursor;
	}, [hasNativeCursor]);
	useEffect(() => {
		recordingDataRef.current = cursorRecordingData;
	}, [cursorRecordingData]);
	useEffect(() => {
		telemetryRef.current = cursorTelemetry;
	}, [cursorTelemetry]);
	useEffect(() => {
		recordedMotionPathRef.current = recordedMotionPath;
	}, [recordedMotionPath]);
	useEffect(() => {
		cursorMotionRegionsRef.current = cursorMotionRegions;
	}, [cursorMotionRegions]);
	useEffect(() => {
		ownerRef.current = owner;
	}, [owner]);
	useEffect(() => {
		cropRegionRef.current = cropRegion;
	}, [cropRegion]);
	useEffect(() => {
		clickBounceRef.current = settings.cursor.clickBounce;
	}, [settings.cursor.clickBounce]);
	useEffect(() => {
		cursorSizeRef.current = settings.cursor.size;
	}, [settings.cursor.size]);
	useEffect(() => {
		cursorMotionBlurRef.current = settings.cursor.motionBlur;
	}, [settings.cursor.motionBlur]);
	useEffect(() => {
		cursorClipToBoundsRef.current = settings.cursor.clipToBounds;
	}, [settings.cursor.clipToBounds]);

	// rAF loop is restarted only when the Pixi app mounts (or unmounts).
	useEffect(() => {
		if (!pixiReady) return;
		let raf = 0;
		const tick = () => {
			raf = window.requestAnimationFrame(tick);
			const overlay = overlayRef.current;
			if (!overlay) return;
			const timeMs = timeRef.current * 1000;
			const viewport = { x: 0, y: 0, ...sizeRef.current };
			const activeMotion = ownerRef.current
				? findCursorMotionRegionAtSourceTime(
						cursorMotionRegionsRef.current,
						ownerRef.current,
						timeMs,
					)
				: null;
			const samples =
				hasNativeRef.current ||
				(activeMotion && activeMotion.preset !== "recorded") ||
				cropRegionRef.current.x !== 0 ||
				cropRegionRef.current.y !== 0 ||
				cropRegionRef.current.width !== 1 ||
				cropRegionRef.current.height !== 1
					? []
					: telemetryRef.current;
			overlay.update(samples, timeMs, viewport, showCursorRef.current, !playingRef.current);
		};
		raf = window.requestAnimationFrame(tick);
		return () => window.cancelAnimationFrame(raf);
	}, [pixiReady]);

	// Native cursor DOM <img> tick — separate from the Pixi tick because
	// this layer doesn't depend on the Pixi app mount.
	useEffect(() => {
		if (!videoPath) return;
		let raf = 0;
		const tick = () => {
			raf = window.requestAnimationFrame(tick);
			renderNativeCursorFrame({
				hasNativeCursor: hasNativeRef.current,
				recordingData: recordingDataRef.current,
				telemetry: telemetryRef.current,
				timeMs: timeRef.current * 1000,
				isPlaying: playingRef.current,
				size: sizeRef.current,
				cursorSize: cursorSizeRef.current,
				cursorClickBounce: clickBounceRef.current,
				cursorMotionBlur: cursorMotionBlurRef.current,
				cursorTheme: cursorThemeRef.current,
				cursorClipToBounds: cursorClipToBoundsRef.current,
				showCursor: showCursorRef.current,
				cropRegion: cropRegionRef.current,
				motionPath: recordedMotionPathRef.current,
				cursorMotionRegions: cursorMotionRegionsRef.current,
				owner: ownerRef.current,
				imageRef,
				clipRef,
				lastImageIdRef,
				motionBlurStateRef,
			});
		};
		raf = window.requestAnimationFrame(tick);
		return () => window.cancelAnimationFrame(raf);
	}, [videoPath]);

	if (!videoPath) return null;

	return (
		<div
			ref={layerRef}
			className={styles.layer}
			data-clip={settings.cursor.clipToBounds ? "on" : "off"}
		>
			<div ref={clipRef} className={styles.nativeCursorClip}>
				<img ref={imageRef} alt="" className={styles.nativeCursor} draggable={false} />
			</div>
			{selectedMotionRegion && owner && recordedMotionPath ? (
				<CursorMotionEditorOverlay
					region={selectedMotionRegion}
					owner={owner}
					path={recordedMotionPath}
					cropRegion={cropRegion}
					isPlaying={isPlaying}
					onControlPointChange={onControlPointChange}
					onControlPointCommit={onControlPointCommit}
				/>
			) : null}
		</div>
	);
}

function CursorMotionEditorOverlay({
	region,
	owner,
	path,
	cropRegion,
	isPlaying,
	onControlPointChange,
	onControlPointCommit,
}: {
	region: AxcutCursorMotionRegion;
	owner: CursorMotionOwner;
	path: CursorMotionPath;
	cropRegion: CropRegion;
	isPlaying: boolean;
	onControlPointChange?: (id: string, index: number, point: { cx: number; cy: number }) => void;
	onControlPointCommit?: () => void;
}) {
	const draggingIndexRef = useRef<number | null>(null);
	const trajectories = useMemo(() => {
		const recorded: Array<{ cx: number; cy: number }> = [];
		const edited: Array<{ cx: number; cy: number }> = [];
		const steps = 48;
		for (let index = 0; index <= steps; index += 1) {
			const timeMs =
				region.sourceStartMs + ((region.sourceEndMs - region.sourceStartMs) * index) / steps;
			const recordedPoint = path.sampleAtSourceTime(timeMs);
			const projectedRecorded = recordedPoint
				? projectCursorMotionPointToCrop(recordedPoint, cropRegion)
				: null;
			if (projectedRecorded) recorded.push(projectedRecorded);
			const editedPoint = sampleCursorMotion({
				path,
				regions: [region],
				owner,
				sourceTimeMs: timeMs,
			});
			const projectedEdited = editedPoint
				? projectCursorMotionPointToCrop(editedPoint, cropRegion)
				: null;
			if (projectedEdited) edited.push(projectedEdited);
		}
		return { recorded, edited };
	}, [cropRegion, owner, path, region]);
	const points = (values: Array<{ cx: number; cy: number }>) =>
		values.map((point) => `${point.cx.toFixed(4)},${point.cy.toFixed(4)}`).join(" ");
	const sourceControls =
		region.controlPoints.length > 0
			? region.controlPoints
			: [
					{
						cx: (region.startPoint.cx + region.endPoint.cx) / 2,
						cy: (region.startPoint.cy + region.endPoint.cy) / 2,
					},
				];
	const controls = sourceControls
		.map((point, index) => ({
			index,
			point: projectCursorMotionPointToCrop(point, cropRegion),
		}))
		.filter(
			(control): control is { index: number; point: { cx: number; cy: number } } =>
				control.point !== null,
		);
	const projectedStart = projectCursorMotionPointToCrop(region.startPoint, cropRegion);
	const projectedEnd = projectCursorMotionPointToCrop(region.endPoint, cropRegion);

	const updateControlPoint = (event: ReactPointerEvent<SVGCircleElement>, index: number) => {
		const svg = event.currentTarget.ownerSVGElement;
		if (!svg) return;
		const bounds = svg.getBoundingClientRect();
		if (bounds.width <= 0 || bounds.height <= 0) return;
		const sourcePoint = unprojectCursorMotionPointFromCrop(
			{
				cx: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
				cy: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
			},
			cropRegion,
		);
		if (sourcePoint) onControlPointChange?.(region.id, index, sourcePoint);
	};
	const finishDrag = (event: ReactPointerEvent<SVGCircleElement>) => {
		if (draggingIndexRef.current === null) return;
		draggingIndexRef.current = null;
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
		onControlPointCommit?.();
	};

	return (
		<svg
			className={styles.motionEditor}
			viewBox="0 0 1 1"
			preserveAspectRatio="none"
			aria-label="Selected cursor path"
		>
			<polyline
				className={styles.motionRecordedPath}
				points={points(trajectories.recorded)}
				vectorEffect="non-scaling-stroke"
			/>
			<polyline
				className={styles.motionEditedPath}
				points={points(trajectories.edited)}
				vectorEffect="non-scaling-stroke"
			/>
			{projectedStart ? (
				<circle
					className={styles.motionAnchor}
					cx={projectedStart.cx}
					cy={projectedStart.cy}
					r={0.009}
					vectorEffect="non-scaling-stroke"
				/>
			) : null}
			{projectedEnd ? (
				<circle
					className={styles.motionAnchor}
					cx={projectedEnd.cx}
					cy={projectedEnd.cy}
					r={0.009}
					vectorEffect="non-scaling-stroke"
				/>
			) : null}
			{region.preset !== "recorded" && !isPlaying
				? controls.map((control) => (
						<circle
							key={`${region.id}-control-${control.index}`}
							className={styles.motionControl}
							cx={control.point.cx}
							cy={control.point.cy}
							r={0.014}
							vectorEffect="non-scaling-stroke"
							onPointerDown={(event) => {
								event.preventDefault();
								event.stopPropagation();
								draggingIndexRef.current = control.index;
								event.currentTarget.setPointerCapture(event.pointerId);
								updateControlPoint(event, control.index);
							}}
							onPointerMove={(event) => {
								if (draggingIndexRef.current === control.index) {
									updateControlPoint(event, control.index);
								}
							}}
							onPointerUp={finishDrag}
							onPointerCancel={finishDrag}
							onLostPointerCapture={finishDrag}
						/>
					))
				: null}
		</svg>
	);
}

interface NativeCursorFrameInputs {
	hasNativeCursor: boolean;
	recordingData: CursorRecordingData | null;
	telemetry: CursorTelemetryPoint[];
	timeMs: number;
	isPlaying: boolean;
	size: { width: number; height: number };
	cursorSize: number;
	cursorClickBounce: number;
	cursorMotionBlur: number;
	cursorTheme: string;
	cursorClipToBounds: boolean;
	showCursor: boolean;
	cropRegion: CropRegion;
	motionPath: CursorMotionPath | null;
	cursorMotionRegions: AxcutCursorMotionRegion[];
	owner: CursorMotionOwner | null;
	imageRef: React.MutableRefObject<HTMLImageElement | null>;
	clipRef: React.MutableRefObject<HTMLDivElement | null>;
	lastImageIdRef: React.MutableRefObject<string | null>;
	motionBlurStateRef: React.MutableRefObject<ReturnType<typeof createNativeCursorMotionBlurState>>;
}

function renderNativeCursorFrame(inputs: NativeCursorFrameInputs) {
	const {
		hasNativeCursor,
		recordingData,
		telemetry,
		timeMs,
		isPlaying,
		size,
		cursorSize,
		cursorClickBounce,
		cursorMotionBlur,
		cursorTheme,
		cursorClipToBounds,
		showCursor,
		cropRegion,
		motionPath,
		cursorMotionRegions,
		owner,
		imageRef,
		clipRef,
		lastImageIdRef,
		motionBlurStateRef,
	} = inputs;

	const imageEl = imageRef.current;
	const clipEl = clipRef.current;
	const hide = () => {
		if (imageEl) imageEl.style.display = "none";
		if (clipEl) clipEl.style.clipPath = "none";
	};

	if (!showCursor || size.width <= 0 || size.height <= 0) {
		hide();
		return;
	}

	if (!hasNativeCursor || !recordingData) {
		// ponytail: telemetry-only fallback. Draw a synthetic dot at the
		// smoothed path. The Pixi overlay already does this with the
		// bundled SVG art; the DOM <img> is the no-native path used in
		// legacy recordings (no cursor bitmaps captured).
		const samples = telemetry;
		if (samples.length === 0) {
			hide();
			return;
		}
		const pos =
			owner && motionPath
				? sampleCursorMotion({
						path: motionPath,
						regions: cursorMotionRegions,
						owner,
						sourceTimeMs: timeMs,
					})
				: motionPath?.sampleAtSourceTime(timeMs);
		if (!pos || !imageEl) {
			hide();
			return;
		}
		const projectedPosition = projectCursorMotionPointToCrop(pos, cropRegion);
		if (!projectedPosition) {
			hide();
			return;
		}
		const radius = Math.max(4, 28 * Math.max(0, cursorSize));
		const x = projectedPosition.cx * size.width;
		const y = projectedPosition.cy * size.height;
		if (lastImageIdRef.current !== "fallback-dot") {
			imageEl.src =
				"data:image/svg+xml;utf8," +
				encodeURIComponent(
					`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="14" fill="#ff4040" stroke="#fff" stroke-width="2"/></svg>`,
				);
			lastImageIdRef.current = "fallback-dot";
		}
		imageEl.style.display = "block";
		imageEl.style.width = `${radius * 2}px`;
		imageEl.style.height = `${radius * 2}px`;
		imageEl.style.transform = `translate3d(${x - radius}px, ${y - radius}px, 0)`;
		imageEl.style.filter = "none";
		return;
	}

	const frame = resolveInterpolatedNativeCursorFrame(recordingData, timeMs);
	if (!frame) {
		hide();
		return;
	}
	const pos =
		owner && motionPath
			? sampleCursorMotion({
					path: motionPath,
					regions: cursorMotionRegions,
					owner,
					sourceTimeMs: timeMs,
				})
			: motionPath?.sampleAtSourceTime(timeMs);
	const displaySample = pos ? { ...frame.sample, cx: pos.cx, cy: pos.cy } : frame.sample;
	const projectedPosition = projectCursorMotionPointToCrop(displaySample, cropRegion);
	if (!projectedPosition) {
		hide();
		return;
	}
	const renderAsset = resolveNativeCursorRenderAsset(frame.asset, 1, displaySample, cursorTheme);
	const bounceProgress = getNativeCursorClickBounceProgress(recordingData, timeMs);
	const scale =
		Math.max(0, cursorSize) * getNativeCursorClickBounceScale(cursorClickBounce, bounceProgress);
	const x = projectedPosition.cx * size.width;
	const y = projectedPosition.cy * size.height;
	const motionBlurPx = isPlaying
		? getNativeCursorMotionBlurPx({
				motionBlur: cursorMotionBlur,
				point: { x, y },
				state: motionBlurStateRef.current,
				timeMs,
			})
		: 0;

	if (imageEl) {
		if (lastImageIdRef.current !== renderAsset.id) {
			imageEl.src = renderAsset.imageDataUrl;
			lastImageIdRef.current = renderAsset.id;
		}
		imageEl.style.display = "block";
		imageEl.style.width = `${renderAsset.width * scale}px`;
		imageEl.style.height = `${renderAsset.height * scale}px`;
		imageEl.style.transform = `translate3d(${x - renderAsset.hotspotX * scale}px, ${
			y - renderAsset.hotspotY * scale
		}px, 0)`;
		imageEl.style.filter = motionBlurPx > 0 ? `blur(${motionBlurPx.toFixed(2)}px)` : "none";
	}
	if (clipEl) {
		if (!cursorClipToBounds) {
			clipEl.style.clipPath = "none";
		} else {
			clipEl.style.clipPath = `inset(0 0 0 0)`;
		}
	}
}
