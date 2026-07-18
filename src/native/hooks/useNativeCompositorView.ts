/**
 * React hook that mounts a native D3D11 compositor preview window on top of a
 * DOM element. On mount it allocates a compositor view (rect only — the
 * native window handle is resolved main-side), then keeps the native view in
 * sync with the DOM element's bounding rect via a single rAF-coalesced
 * ResizeObserver + window resize/scroll listener pair. Cleanup cancels the
 * observer/listeners and destroys the native view.
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

export function useNativeCompositorView(
	ref: RefObject<HTMLElement>,
	opts: UseNativeCompositorViewOptions = {},
): UseNativeCompositorViewResult {
	const enabled = opts.enabled !== false;
	const [viewId, setViewId] = useState<number | null>(null);
	// Mirror into a ref so async callbacks always see the freshest id without
	// re-subscribing the main effect.
	const viewIdRef = useRef<number | null>(null);
	viewIdRef.current = viewId;

	useEffect(() => {
		if (!enabled) {
			return;
		}
		const el = ref.current;
		if (!el) {
			return;
		}

		let rafHandle = 0;
		let lastRect: CompositorViewRect | null = null;
		let disposed = false;

		const applyRectNow = () => {
			rafHandle = 0;
			if (disposed) {
				return;
			}
			const domRect = el.getBoundingClientRect();
			const next = computeDeviceRect(domRect, window.devicePixelRatio);
			if (lastRect && rectsEqual(lastRect, next)) {
				return;
			}
			lastRect = next;
			const id = viewIdRef.current;
			if (id == null) {
				return;
			}
			safelyCall("setRect", () => setCompositorRect(id, next));
		};

		const scheduleRectUpdate = () => {
			if (rafHandle !== 0) {
				return;
			}
			rafHandle = requestAnimationFrame(applyRectNow);
		};

		// Initial mount: allocate the native view with the rect observed at
		// the moment the effect ran. The async id will be used on subsequent
		// resize/scroll updates. Without the bridge, this is a swallowed
		// warning — the rest of the hook stays inert.
		const initialRect = computeDeviceRect(el.getBoundingClientRect(), window.devicePixelRatio);
		lastRect = initialRect;
		safelyCall("createView", async () => {
			const result = await createCompositorView(initialRect);
			if (disposed) {
				// The element unmounted before the response came back; clean up.
				safelyCall("destroyView (late)", () => destroyCompositorView(result.id));
				return;
			}
			viewIdRef.current = result.id;
			setViewId(result.id);
		});

		const observer = new ResizeObserver(scheduleRectUpdate);
		observer.observe(el);
		window.addEventListener("resize", scheduleRectUpdate);
		// capture phase so we observe parent scroll containers too,
		// not just `window` — the preview pane may scroll independently.
		window.addEventListener("scroll", scheduleRectUpdate, true);

		return () => {
			disposed = true;
			if (rafHandle !== 0) {
				cancelAnimationFrame(rafHandle);
			}
			observer.disconnect();
			window.removeEventListener("resize", scheduleRectUpdate);
			window.removeEventListener("scroll", scheduleRectUpdate, true);
			const id = viewIdRef.current;
			if (id != null) {
				safelyCall("destroyView", () => destroyCompositorView(id));
			}
		};
		// `ref` is a stable RefObject; we only re-run the effect when
		// the enabled flag flips.
	}, [enabled, ref]);

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
