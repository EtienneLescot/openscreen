/**
 * React hook that drives a canvas-based preview of the native D3D11
 * compositor. The compositor renders OFFSCREEN (no OS window), so this hook:
 *   1. Allocates an offscreen compositor view sized to the canvas's device-pixel
 *      rect (measured via ResizeObserver + window resize/scroll, rAF-coalesced
 *      — the exact same sync machinery as before, repurposed: it now drives
 *      the offscreen render-target resolution instead of a window position).
 *   2. Polls `readCompositorFrame` on every other rAF tick (~30fps) and paints
 *      the returned RGBA buffer into the canvas via `ctx.putImageData`. The
 *      buffer is the same size as the rect last pushed (canvas.width/height
 *      track the rect).
 *
 * Every native-bridge call is wrapped in a try/catch that swallows + warns,
 * because the renderer may run without the bridge (pure web `npm run dev`,
 * Vitest jsdom env). The hook never throws upward.
 */

import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	createCompositorView,
	destroyCompositorView,
	readCompositorFrame,
	setCompositorParam,
	setCompositorPlaying,
	setCompositorRect,
} from "../compositorViewClient";
import type { CompositorParamValue, CompositorViewRect } from "../contracts";
import { computeDeviceRect, rectsEqual } from "../nativeViewRect";

export interface UseNativeCompositorViewOptions {
	/** When false, the hook does nothing on mount and destroys nothing on
	 * unmount. Defaults to true. */
	enabled?: boolean;
	/** F3: real recording sources (screen + webcam H264 files + cursor telemetry).
	 * Omitted → the native side falls back to the POC fixture. Read once at view
	 * creation, so resolve them before enabling the hook to avoid a fixture→real
	 * re-create. */
	sources?: { screenPath?: string; webcamPath?: string; cursorPath?: string };
}

export interface UseNativeCompositorViewResult {
	/** Numeric view id once createCompositorView resolves. `null` while the
	 * call is in flight or when the bridge is unavailable. May be a negative
	 * synthetic id when the native addon is absent (see
	 * `compositorViewService`). */
	viewId: number | null;
	setParam: (key: string, value: CompositorParamValue) => void;
	setPlaying: (playing: boolean) => void;
}

/** swallow+warn wrapper for native-bridge calls. The renderer can run without
 * a preload `electronAPI` (jsdom, pure web); errors must never propagate. */
function safelyCall(label: string, call: () => Promise<unknown>) {
	try {
		call().catch((error: unknown) => {
			console.warn(`[compositor-view] ${label} failed:`, error);
		});
	} catch (error) {
		console.warn(`[compositor-view] ${label} failed:`, error);
	}
}

/** Throttle the rAF pull loop to roughly 30fps: process every other animation
 *  frame. Keeps IPC + GPU readback + putImageData cheap on high-refresh
 *  displays (120/144 Hz) without changing perceived preview smoothness. */
const PULL_LOOP_TICK_DIVISOR = 2;

export function useNativeCompositorView(
	canvasRef: RefObject<HTMLCanvasElement>,
	opts: UseNativeCompositorViewOptions = {},
): UseNativeCompositorViewResult {
	const enabled = opts.enabled !== false;
	// Re-create the native view when the screen source changes (e.g. loading a different
	// project) so it never keeps showing a stale clip.
	const screenPath = opts.sources?.screenPath;
	const [viewId, setViewId] = useState<number | null>(null);
	// Mirror into a ref so async callbacks always see the freshest id without
	// re-subscribing the main effect.
	const viewIdRef = useRef<number | null>(null);
	viewIdRef.current = viewId;

	useEffect(() => {
		if (!enabled) {
			return;
		}
		const canvas = canvasRef.current;
		if (!canvas) {
			return;
		}

		let rectRafHandle = 0;
		let pullRafHandle = 0;
		let pullTick = 0;
		let lastRect: CompositorViewRect | null = null;
		let disposed = false;

		/** Resize the canvas's DRAWING BUFFER to match the offscreen render
		 *  target's pixel dimensions. Setting `canvas.width` / `canvas.height`
		 *  is destructive (clears the bitmap), so we only do it on genuine
		 *  rect changes — handled together with the setRect push below. */
		const syncCanvasSize = (rect: CompositorViewRect) => {
			if (canvas.width !== rect.width) {
				canvas.width = rect.width;
			}
			if (canvas.height !== rect.height) {
				canvas.height = rect.height;
			}
		};

		const applyRectNow = () => {
			rectRafHandle = 0;
			if (disposed) {
				return;
			}
			// `getBoundingClientRect` on the canvas reflects its CSS layout box;
			// scaled to device pixels for the native offscreen target.
			const domRect = canvas.getBoundingClientRect();
			const next = computeDeviceRect(domRect, window.devicePixelRatio);
			// `x` / `y` are vestigial in the new contract (ignored native-side),
			// but `rectsEqual` still compares them — harmless: scrolling will just
			// re-push the rect, and the native side ignores x/y.
			if (lastRect && rectsEqual(lastRect, next)) {
				return;
			}
			lastRect = next;
			const id = viewIdRef.current;
			if (id == null) {
				return;
			}
			syncCanvasSize(next);
			safelyCall("setRect", () => setCompositorRect(id, next));
		};

		const scheduleRectUpdate = () => {
			if (rectRafHandle !== 0) {
				return;
			}
			rectRafHandle = requestAnimationFrame(applyRectNow);
		};

		let reusablePixels: Uint8ClampedArray | null = null;
		let reusableImageData: ImageData | null = null;

		/** rAF pull loop: throttle to ~30fps and paint the returned buffer
		 *  into the canvas via createImageBitmap + drawImage (hardware GPU blitting).
		 *  Runs decoding off the main thread so UI interactions stay at 60/120fps. */
		const pullLoop = () => {
			pullRafHandle = requestAnimationFrame(pullLoop);
			if (disposed) {
				return;
			}
			pullTick = (pullTick + 1) % PULL_LOOP_TICK_DIVISOR;
			if (pullTick !== 0) {
				return;
			}
			const id = viewIdRef.current;
			if (id == null) {
				return;
			}
			const ctx = canvas.getContext("2d");
			if (!ctx) {
				return;
			}
			readCompositorFrame(id)
				.then((buffer) => {
					if (disposed || !buffer) {
						return;
					}
					// Sanity check: the buffer must be exactly
					// canvas.width * canvas.height * 4 bytes (RGBA). Mismatches
					// would corrupt the image silently via putImageData — bail.
					const expected = canvas.width * canvas.height * 4;
					if (buffer.byteLength !== expected || canvas.width === 0 || canvas.height === 0) {
						return;
					}
					if (!reusablePixels || reusablePixels.byteLength !== buffer.byteLength) {
						reusablePixels = new Uint8ClampedArray(buffer.byteLength);
						reusableImageData = new ImageData(reusablePixels, canvas.width, canvas.height);
					}
					reusablePixels.set(buffer);
					if (reusableImageData) {
						createImageBitmap(reusableImageData)
							.then((bitmap) => {
								if (!disposed && ctx) {
									ctx.drawImage(bitmap, 0, 0);
								}
								bitmap.close();
							})
							.catch(() => {
								if (!disposed && reusableImageData && ctx) {
									ctx.putImageData(reusableImageData, 0, 0);
								}
							});
					}
				})
				.catch((error: unknown) => {
					console.warn("[compositor-view] readFrame failed:", error);
				});
		};

		// Initial mount: allocate the native view with the rect observed at
		// the moment the effect ran. The async id will be used on subsequent
		// resize/scroll updates. Without the bridge, this is a swallowed
		// warning — the rest of the hook stays inert.
		const initialRect = computeDeviceRect(canvas.getBoundingClientRect(), window.devicePixelRatio);
		lastRect = initialRect;
		// Prime the canvas drawing buffer to the resolution we expect the
		// first pulled frame to have; avoids a 300x150 flash before the
		// first readFrame resolves.
		syncCanvasSize(initialRect);

		safelyCall("createView", async () => {
			const result = await createCompositorView(initialRect, opts.sources);
			if (disposed) {
				// The element unmounted before the response came back; clean up.
				safelyCall("destroyView (late)", () => destroyCompositorView(result.id));
				return;
			}
			viewIdRef.current = result.id;
			setViewId(result.id);
		});

		const observer = new ResizeObserver(scheduleRectUpdate);
		observer.observe(canvas);
		window.addEventListener("resize", scheduleRectUpdate);
		// capture phase so we observe parent scroll containers too,
		// not just `window` — the preview pane may scroll independently.
		window.addEventListener("scroll", scheduleRectUpdate, true);

		// Start the pull loop only after the view id is published — otherwise
		// every early tick would just hit `id == null` and no-op. Id is set
		// in the safelyCall above; we also pull here defensively for the
		// common case (addon absent → synthetic negative id, pull returns null,
		// no draw happens). The pull loop self-cancels in cleanup.
		pullRafHandle = requestAnimationFrame(pullLoop);

		return () => {
			disposed = true;
			if (rectRafHandle !== 0) {
				cancelAnimationFrame(rectRafHandle);
			}
			if (pullRafHandle !== 0) {
				cancelAnimationFrame(pullRafHandle);
			}
			observer.disconnect();
			window.removeEventListener("resize", scheduleRectUpdate);
			window.removeEventListener("scroll", scheduleRectUpdate, true);
			const id = viewIdRef.current;
			if (id != null) {
				safelyCall("destroyView", () => destroyCompositorView(id));
			}
		};
		// `canvasRef` is a stable RefObject; we re-run (destroy + re-create the view) when the
		// enabled flag flips or the screen source changes.
	}, [enabled, canvasRef, screenPath]);

	const setParam = useCallback((key: string, value: CompositorParamValue) => {
		const id = viewIdRef.current;
		if (id == null) {
			return;
		}
		safelyCall("setParam", () => setCompositorParam(id, key, value));
	}, []);

	const setPlaying = useCallback((playing: boolean) => {
		const id = viewIdRef.current;
		if (id == null) {
			return;
		}
		safelyCall("setPlaying", () => setCompositorPlaying(id, playing));
	}, []);

	return { viewId, setParam, setPlaying };
}
