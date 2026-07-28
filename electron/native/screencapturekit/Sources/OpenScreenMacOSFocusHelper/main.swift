// openscreen-macos-focus-helper
//
// Samples the frontmost application's focused window (owner, title, bounds)
// and emits newline-delimited JSON on stdout. Used by the CLI's
// `record --follow-windows` to build a window-focus timeline that the export
// step turns into automatic pan/zoom regions.
//
// Protocol (mirrors the cursor helper):
//   argv[1]  optional JSON: {"sampleIntervalMs": 200}
//   stdout   {"type":"ready","timestampMs":...}
//            {"type":"sample","timestampMs":...,"appName":"...","windowTitle":"...",
//             "x":...,"y":...,"width":...,"height":...,"displayId":...}
//   Samples are emitted when the focused window changes (app, window, or
//   bounds beyond a small delta) plus a 1 s heartbeat.
//   Stop with SIGTERM/SIGINT; EOF is ignored (parent may close stdin).
//
// Window enumeration uses CGWindowListCopyWindowInfo, which reports other
// apps' window names/bounds only when Screen Recording permission is granted —
// the same permission the capture pipeline already requires.

import AppKit
import CoreGraphics
import Foundation

struct FocusSample: Equatable {
	var pid: pid_t
	var appName: String
	var windowNumber: Int
	var windowTitle: String
	var bounds: CGRect
	var displayId: UInt32
}

func nowEpochMs() -> Int64 {
	Int64(Date().timeIntervalSince1970 * 1000)
}

func emit(_ object: [String: Any]) {
	guard let data = try? JSONSerialization.data(withJSONObject: object),
		let line = String(data: data, encoding: .utf8)
	else { return }
	print(line)
	fflush(stdout)
}

func displayId(for rect: CGRect) -> UInt32 {
	var count: UInt32 = 0
	var ids = [CGDirectDisplayID](repeating: 0, count: 16)
	guard CGGetDisplaysWithRect(rect, 16, &ids, &count) == .success, count > 0 else {
		return CGMainDisplayID()
	}
	// Prefer the display containing the window's center.
	let center = CGPoint(x: rect.midX, y: rect.midY)
	for index in 0..<Int(count) {
		if CGDisplayBounds(ids[index]).contains(center) {
			return ids[index]
		}
	}
	return ids[0]
}

/// Frontmost app's topmost on-screen, layer-0 window.
func currentFocusSample() -> FocusSample? {
	guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
	let pid = app.processIdentifier

	guard
		let windowInfos = CGWindowListCopyWindowInfo(
			[.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
	else { return nil }

	// CGWindowList returns windows in front-to-back order; the first layer-0
	// window owned by the frontmost app is its focused window.
	for info in windowInfos {
		guard let ownerPid = info[kCGWindowOwnerPID as String] as? pid_t, ownerPid == pid,
			let layer = info[kCGWindowLayer as String] as? Int, layer == 0,
			let boundsDict = info[kCGWindowBounds as String] as? [String: CGFloat]
		else { continue }

		let bounds = CGRect(
			x: boundsDict["X"] ?? 0,
			y: boundsDict["Y"] ?? 0,
			width: boundsDict["Width"] ?? 0,
			height: boundsDict["Height"] ?? 0
		)
		// Skip tiny utility windows (tooltips, status items).
		if bounds.width < 120 || bounds.height < 90 { continue }

		let windowNumber = info[kCGWindowNumber as String] as? Int ?? 0
		let title = info[kCGWindowName as String] as? String ?? ""
		return FocusSample(
			pid: pid,
			appName: app.localizedName ?? "",
			windowNumber: windowNumber,
			windowTitle: title,
			bounds: bounds,
			displayId: displayId(for: bounds)
		)
	}
	return nil
}

func boundsRoughlyEqual(_ a: CGRect, _ b: CGRect) -> Bool {
	let delta: CGFloat = 8
	return abs(a.origin.x - b.origin.x) < delta && abs(a.origin.y - b.origin.y) < delta
		&& abs(a.width - b.width) < delta && abs(a.height - b.height) < delta
}

// --- Entry point ---

var sampleIntervalMs = 200
if CommandLine.arguments.count > 1,
	let data = CommandLine.arguments[1].data(using: .utf8),
	let config = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
	let interval = config["sampleIntervalMs"] as? Int, interval >= 50
{
	sampleIntervalMs = interval
}

signal(SIGINT) { _ in exit(0) }
signal(SIGTERM) { _ in exit(0) }

emit(["type": "ready", "timestampMs": nowEpochMs()])

var lastEmitted: FocusSample?
var lastEmitTimeMs: Int64 = 0
let heartbeatMs: Int64 = 1000

let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.main)
timer.schedule(
	deadline: .now(), repeating: .milliseconds(sampleIntervalMs), leeway: .milliseconds(20))
timer.setEventHandler {
	guard let sample = currentFocusSample() else { return }
	let now = nowEpochMs()
	let changed =
		lastEmitted.map { previous in
			previous.pid != sample.pid || previous.windowNumber != sample.windowNumber
				|| !boundsRoughlyEqual(previous.bounds, sample.bounds)
		} ?? true
	if !changed && now - lastEmitTimeMs < heartbeatMs { return }
	lastEmitted = sample
	lastEmitTimeMs = now
	emit([
		"type": "sample",
		"timestampMs": now,
		"appName": sample.appName,
		"windowTitle": sample.windowTitle,
		"x": Int(sample.bounds.origin.x),
		"y": Int(sample.bounds.origin.y),
		"width": Int(sample.bounds.width),
		"height": Int(sample.bounds.height),
		"displayId": Int(sample.displayId),
	])
}
timer.resume()

// Drain the main dispatch queue; RunLoop.main.run() does not reliably service
// dispatch timers in a bare command-line process.
dispatchMain()
