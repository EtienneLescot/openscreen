// Vendored for the CLI: clampFocusToDepth was deleted from
// @/components/video-editor/types in the 1.8 line with no successor, and
// hasNativeCursorRecordingData left with @/lib/cursor/nativeCursor. Both are
// tiny pure predicates the CLI export runner still needs.

import type { CursorRecordingData } from "@/native/contracts";

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

export function hasNativeCursorRecordingData(
	recordingData: CursorRecordingData | null | undefined,
): recordingData is CursorRecordingData {
	return Boolean(
		recordingData &&
			recordingData.samples.length > 0 &&
			(recordingData.assets.length > 0 || recordingData.provider === "none"),
	);
}
