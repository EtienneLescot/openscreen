// Numeric helpers shared by the renderer, the electron main process and the
// native glue. `clamp` had 16 near-identical private copies before this file
// existed — two of them (blurEffects, video-editor/types) guarded non-finite
// input, so the shared one has to as well or those callers regress.

/**
 * Constrains `value` to [min, max]. NaN and ±Infinity fall to `min`: callers
 * clamp persisted document values and drag deltas, and a NaN flowing on into a
 * transform or a canvas op is always worse than the floor.
 */
export function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, value));
}

/** `clamp(value, 0, 1)` — the normalized-fraction case, common enough to name. */
export function clamp01(value: number): number {
	return clamp(value, 0, 1);
}
