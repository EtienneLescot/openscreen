// Vendored for the CLI: clampFocusToDepth was deleted from
// @/components/video-editor/types in the 1.8 line with no successor. It is a
// tiny pure predicate the CLI export runner still needs.

export interface ZoomFocusPoint {
	cx: number;
	cy: number;
}

function clamp(value: number, min: number, max: number): number {
	if (Number.isNaN(value)) return (min + max) / 2;
	return Math.min(max, Math.max(min, value));
}

export function clampZoomFocus(focus: ZoomFocusPoint): ZoomFocusPoint {
	return { cx: clamp(focus.cx, 0, 1), cy: clamp(focus.cy, 0, 1) };
}
