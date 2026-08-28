/// Resolves native window IDs against the same ScreenCaptureKit snapshot used to
/// construct the stream filter. The order is stable for useful diagnostics, and
/// duplicate requests cannot produce duplicate filter entries.
public func resolveCaptureExcludedWindowIDs(
	requestedWindowIDs: [UInt32],
	availableWindowIDs: [UInt32]
) -> [UInt32] {
	let available = Set(availableWindowIDs)
	var seen = Set<UInt32>()
	return requestedWindowIDs.filter { windowID in
		available.contains(windowID) && seen.insert(windowID).inserted
	}
}
