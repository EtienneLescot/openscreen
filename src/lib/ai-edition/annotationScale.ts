/**
 * One rule for turning an annotation's authored `style.fontSize` into a real size, shared by the
 * preview overlay and the native renderer so the two cannot drift.
 *
 * Everything else about an annotation is already proportional — `position` and `size` are
 * percentages of the screen rect, so they survive any output resolution. `fontSize` was the
 * exception: the preview applied it as absolute CSS pixels against whatever size the panel
 * happened to be (`fontSize: ${style.fontSize}px`), which meant the same document showed
 * different text sizes at different window sizes, and a native render at 1080p would have shown
 * text roughly half the size the author saw in a ~960px-wide panel.
 *
 * So the authored number is defined as "pixels at `ANNOTATION_REFERENCE_HEIGHT`", and both
 * consumers scale it by the height of the box they are drawing into. The preview becomes a
 * faithful scale model of the render, which is the point.
 *
 * Consequence worth knowing: text in the preview now tracks the panel size instead of ignoring
 * it, so an existing project's captions look smaller in a small panel than they used to. What
 * they looked like before was never what the export would have produced.
 */

/**
 * The height the authored `fontSize` is expressed against. 1080 because it is the canonical
 * output height, so a project authored while previewing near full size needs no adjustment and
 * the number in the inspector keeps meaning what a user would guess it means.
 */
export const ANNOTATION_REFERENCE_HEIGHT = 1080;

/** Authored font size → fraction of the screen rect's height. Resolution-free, which is the form
 *  the native scene carries. */
export function annotationFontSizeFraction(fontSizePx: number): number {
	if (!Number.isFinite(fontSizePx) || fontSizePx <= 0) return 0;
	return fontSizePx / ANNOTATION_REFERENCE_HEIGHT;
}

/** Authored font size → pixels, for a box of `containerHeightPx`. Used by the preview overlay;
 *  the native renderer applies the same product against the screen rect in output pixels. */
export function annotationFontSizePx(fontSizePx: number, containerHeightPx: number): number {
	if (!Number.isFinite(containerHeightPx) || containerHeightPx <= 0) return 0;
	return annotationFontSizeFraction(fontSizePx) * containerHeightPx;
}
