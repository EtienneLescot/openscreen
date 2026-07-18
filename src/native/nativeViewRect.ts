/**
 * Pure helpers for translating a DOM `getBoundingClientRect()` into device-pixel
 * coordinates the native D3D11 compositor addon expects. Kept side-effect free
 * so it's trivially unit-testable and shareable between the React hook and any
 * non-React caller (e.g. a future render-loop chip in Pixi).
 */
import type { CompositorViewRect } from "./contracts";

/**
 * Convert a CSS-pixel rect (as returned by `Element.getBoundingClientRect()`)
 * to the device-pixel rect the compositor addon expects. All four values are
 * rounded via `Math.round` because the addon returns either truncated or
 * off-by-one windows when handed non-integer values.
 */
export function computeDeviceRect(
	domRect: { left: number; top: number; width: number; height: number },
	devicePixelRatio: number,
): CompositorViewRect {
	const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
	return {
		x: Math.round(domRect.left * ratio),
		y: Math.round(domRect.top * ratio),
		width: Math.round(domRect.width * ratio),
		height: Math.round(domRect.height * ratio),
	};
}

/**
 * Cheap structural equality check for two device rects. Used by the React
 * hook to skip re-sending `setRect` when nothing has changed (which would
 * otherwise churn the native window needlessly).
 */
export function rectsEqual(a: CompositorViewRect, b: CompositorViewRect): boolean {
	return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
