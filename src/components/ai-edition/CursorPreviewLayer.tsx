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
import { useEffect, useMemo, useRef, useState } from "react";
import { useEditorSettings } from "@/lib/ai-edition/store/useEditorSettings";
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
import { useCursorRecordingData } from "@/native/hooks/useCursorRecordingData";
import { useCursorTelemetry } from "@/native/hooks/useCursorTelemetry";
import styles from "./CursorPreviewLayer.module.css";

interface CursorPreviewLayerProps {
	videoPath: string | null;
	currentTimeSec: number;
	isPlaying: boolean;
}

export function CursorPreviewLayer({
	videoPath,
	currentTimeSec,
	isPlaying,
}: CursorPreviewLayerProps) {
	const { settings } = useEditorSettings();
	const { data: cursorRecordingData } = useCursorRecordingData(videoPath);
	const { samples: cursorTelemetry } = useCursorTelemetry(videoPath);

	const hasNativeCursor = useMemo(
		() => hasNativeCursorRecordingData(cursorRecordingData),
		[cursorRecordingData],
	);

	// Layer ref — the DOM <div> that hosts the Pixi canvas + native-cursor
	// <img>. Sized to the <video> via ResizeObserver; both editors mount the
	// layer as a sibling of the <video> so the measurements line up.
	const layerRef = useRef<HTMLDivElement | null>(null);
	const [size, setSize] = useState({ width: 0, height: 0 });

	// biome-ignore lint/correctness/useExhaustiveDependencies: re-run when videoPath changes so the observer re-attaches to the new <video>.
	useEffect(() => {
		const layer = layerRef.current;
		if (!layer) return;
		const video = layer.parentElement?.querySelector("video");
		if (!video) return;
		const update = () => {
			const rect = video.getBoundingClientRect();
			setSize({ width: rect.width, height: rect.height });
		};
		update();
		const ro = new ResizeObserver(update);
		ro.observe(video);
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
	const smoothingRef = useRef(settings.cursor.smoothing);
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
		smoothingRef.current = settings.cursor.smoothing;
	}, [settings.cursor.smoothing]);
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
			const samples = hasNativeRef.current ? [] : telemetryRef.current;
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
				cursorSmoothing: smoothingRef.current,
				cursorClickBounce: clickBounceRef.current,
				cursorMotionBlur: cursorMotionBlurRef.current,
				cursorTheme: cursorThemeRef.current,
				cursorClipToBounds: cursorClipToBoundsRef.current,
				showCursor: showCursorRef.current,
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
		</div>
	);
}

interface NativeCursorFrameInputs {
	hasNativeCursor: boolean;
	recordingData: ReturnType<typeof useCursorRecordingData>["data"];
	telemetry: ReturnType<typeof useCursorTelemetry>["samples"];
	timeMs: number;
	isPlaying: boolean;
	size: { width: number; height: number };
	cursorSize: number;
	cursorSmoothing: number;
	cursorClickBounce: number;
	cursorMotionBlur: number;
	cursorTheme: string;
	cursorClipToBounds: boolean;
	showCursor: boolean;
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
		cursorSmoothing,
		cursorClickBounce,
		cursorMotionBlur,
		cursorTheme,
		cursorClipToBounds,
		showCursor,
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
		const path = getSmoothedCursorPath(
			{ version: 1, provider: "none", samples: samples as never, assets: [] },
			cursorSmoothing,
		);
		const pos = path?.sampleAt(timeMs);
		if (!pos || !imageEl) {
			hide();
			return;
		}
		const radius = Math.max(4, 28 * Math.max(0, cursorSize));
		const x = pos.cx * size.width;
		const y = pos.cy * size.height;
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
	const pos = getSmoothedCursorPath(recordingData, cursorSmoothing)?.sampleAt(timeMs);
	const displaySample = pos ? { ...frame.sample, cx: pos.cx, cy: pos.cy } : frame.sample;
	const renderAsset = resolveNativeCursorRenderAsset(frame.asset, 1, displaySample, cursorTheme);
	const bounceProgress = getNativeCursorClickBounceProgress(recordingData, timeMs);
	const scale =
		Math.max(0, cursorSize) * getNativeCursorClickBounceScale(cursorClickBounce, bounceProgress);
	const x = displaySample.cx * size.width;
	const y = displaySample.cy * size.height;
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
