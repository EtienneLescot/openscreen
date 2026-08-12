import { type Rectangle, screen } from "electron";

/**
 * Converts a rect from Electron's coordinate space into the one OpenScreen's
 * native capture and cursor helpers speak. This is the single place that knows
 * the difference; every rect crossing into a helper goes through it.
 *
 * Electron's `screen` module reports display geometry in **DIPs**. The Windows
 * helpers (`wgc-capture.exe`, `cursor-sampler.exe`) opt into per-monitor-v2 DPI
 * awareness — see `electron/native/wgc-capture/src/dpi_awareness.h` — so Win32
 * hands them unvirtualized **physical pixels**. The two spaces are equal at 100%
 * scaling and only there, which is how both bugs of this class shipped: #272
 * (cursor drawn short of its real position) and #346 (`findMonitorForCapture`
 * comparing DIP bounds against virtualized monitor rects, and silently recording
 * the primary display instead of the chosen one).
 *
 * macOS and Linux need no conversion. The ScreenCaptureKit helper reports its
 * capture frame in points, the same space Electron's `screen` uses, and the
 * PipeWire helper normalizes the cursor against its own stream dimensions and is
 * never handed a rect at all. The platform check is not cosmetic: Electron marks
 * `dipToScreenRect` `@platform win32`, so it is simply absent from `screen`
 * elsewhere.
 *
 * @param dipBounds a rect in Electron DIPs, e.g. `Display.bounds`.
 */
export function toHelperRect(dipBounds: Rectangle): Rectangle {
	if (process.platform !== "win32") {
		return dipBounds;
	}

	// Not `x * scaleFactor`: that misplaces the origin of every non-primary
	// display. `dipToScreenRect(null, rect)` scales relative to the display
	// nearest the rect, which is what makes it correct on mixed-DPI desktops —
	// the arrangement #346 is about.
	return screen.dipToScreenRect(null, dipBounds);
}
