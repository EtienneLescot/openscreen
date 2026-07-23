/**
 * React hook that drives a canvas-based preview of the native D3D11
 * compositor. The compositor renders OFFSCREEN (no OS window), so this hook:
 *   1. Allocates an offscreen compositor view sized to the canvas's device-pixel
 *      rect (measured via ResizeObserver + window resize/scroll, rAF-coalesced
 *      — the exact same sync machinery as before, repurposed: it now drives
 *      the offscreen render-target resolution instead of a window position).
 *   2. Polls `readCompositorFrame` on every other rAF tick (~30fps), passing the
 *      generation it last painted. Native returns a self-describing packet
 *      (`{ gen, width, height, data }`) ONLY when a newer frame exists — otherwise
 *      `null`, and the canvas is left untouched. So while the preview sits still
 *      (paused editing) nothing is cloned, sent over IPC, or repainted. The canvas
 *      drawing buffer is sized from the packet's own dims, so pixels and canvas
 *      can never drift apart.
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

		// Generation of the last frame we painted. The native side only publishes a
		// NEW generation when it actually composed a new frame (it never republishes
		// an identical one), so passing this back as `sinceGen` means an unchanged
		// frame is never re-delivered: no clone, no IPC, no canvas copy while the
		// preview sits still (paused editing — the dominant case). `0` = "painted
		// nothing yet", which forces delivery of the first frame.
		let lastGen = 0;
		// Only one readFrame in flight at a time. Skipping while pending both avoids
		// redundant IPC and removes any chance of two responses landing out of order
		// and rewinding `lastGen` (which would re-deliver an already-painted frame).
		let inFlight = false;

		/** rAF pull loop: throttle to ~30fps and repaint ONLY when native reports a
		 *  newer generation. The returned packet is self-describing (`gen` + dims +
		 *  pixels), so the canvas is sized from the packet — pixels and canvas can
		 *  never drift out of sync. Runs off the main thread so UI stays at 60/120fps. */
		const pullLoop = () => {
			pullRafHandle = requestAnimationFrame(pullLoop);
			if (disposed || inFlight) {
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
			inFlight = true;
			readCompositorFrame(id, lastGen)
				.then((frame) => {
					inFlight = false;
					// `null` = nothing newer than `lastGen` (idle path — no pixels
					// crossed IPC) OR no frame yet. Either way, leave the canvas as-is.
					if (disposed || !frame) {
						return;
					}
					const { gen, width, height, data } = frame;
					// Defensive: the packet's byte count must match its own declared
					// dimensions. A mismatch would corrupt the image silently — bail.
					if (data.byteLength !== width * height * 4 || width === 0 || height === 0) {
						return;
					}
					// Size the drawing buffer to the packet (destructive, but we repaint
					// the whole frame right after). CSS scales it to the canvas box.
					if (canvas.width !== width) {
						canvas.width = width;
					}
					if (canvas.height !== height) {
						canvas.height = height;
					}
					// Wrap the received buffer DIRECTLY — no intermediate copy. `data` is a
					// fresh per-frame Buffer from IPC (never pooled or reused across frames),
					// so a view over it is valid for the lifetime of this paint, and nothing
					// mutates it. Cast to `ArrayBuffer` because `ImageData` rejects
					// `SharedArrayBuffer`-backed arrays (IPC binary is never shared).
					const pixels = new Uint8ClampedArray(
						data.buffer as ArrayBuffer,
						data.byteOffset,
						data.byteLength,
					);
					const image = new ImageData(pixels, width, height);
					// `createImageBitmap` decodes off the main thread (keeps UI at 60/120fps)
					// and snapshots `image`, so the view can be released after; `putImageData`
					// is the synchronous fallback if bitmap creation is unavailable.
					createImageBitmap(image)
						.then((bitmap) => {
							if (!disposed && ctx) {
								ctx.drawImage(bitmap, 0, 0);
							}
							bitmap.close();
						})
						.catch(() => {
							if (!disposed && ctx) {
								ctx.putImageData(image, 0, 0);
							}
						});
					// Advance only after a successful, validated frame — so a dropped/
					// malformed packet is retried rather than silently skipped.
					lastGen = gen;
				})
				.catch((error: unknown) => {
					inFlight = false;
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
