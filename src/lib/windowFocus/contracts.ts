// Window-focus telemetry sidecar (`<video>.focus.json`), produced by
// `openscreen record --follow-windows` and consumed by
// `openscreen export --follow-windows`. Kept dependency-free so both the
// Electron main process and the renderer can import it.

export interface FocusSample {
	/** Milliseconds relative to the start of the recording. */
	timeMs: number;
	appName: string;
	windowTitle: string;
	/** Window bounds in screen points (macOS global display space). */
	x: number;
	y: number;
	width: number;
	height: number;
	/** CGDirectDisplayID of the display containing the window's center. */
	displayId: number;
}

export interface FocusDisplayInfo {
	/** Electron display id — on macOS this is the CGDirectDisplayID. */
	id: number;
	bounds: { x: number; y: number; width: number; height: number };
	scaleFactor: number;
	isPrimary: boolean;
}

export interface FocusRecordingData {
	version: 1;
	/** Display that was recorded. */
	recordedDisplayId: number;
	displays: FocusDisplayInfo[];
	samples: FocusSample[];
}

export const FOCUS_SIDECAR_SUFFIX = ".focus.json";
