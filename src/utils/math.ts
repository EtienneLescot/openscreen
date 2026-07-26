// Numeric helpers shared by the renderer, the electron main process and the
// native glue. `clamp` had 16 identical private copies before this file existed.

/** Constrains `value` to [min, max]. */
export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/** `clamp(value, 0, 1)` — the normalized-fraction case, common enough to name. */
export function clamp01(value: number): number {
	return clamp(value, 0, 1);
}
