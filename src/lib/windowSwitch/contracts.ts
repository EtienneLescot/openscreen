// Multi-window capture manifest (`<primary video>.multiwindow.json`), produced
// by `openscreen record --windows` and consumed by the export step's
// window-switch compositor. Every listed window was captured continuously for
// the whole recording; the focus timeline decides which one is on screen.

import type { FocusRecordingData } from "../windowFocus/contracts";

export interface CapturedWindow {
	/** CGWindowID — matches FocusSample.windowNumber. */
	windowId: number;
	appName: string;
	title: string;
	videoPath: string;
	/** Window bounds in screen points at recording start. */
	bounds: { x: number; y: number; width: number; height: number };
}

export interface MultiWindowManifest {
	version: 1;
	windows: CapturedWindow[];
	focus: FocusRecordingData;
	/** Total capture duration reported by the recorder, in milliseconds. */
	durationMs: number;
}

export const MULTIWINDOW_SIDECAR_SUFFIX = ".multiwindow.json";
