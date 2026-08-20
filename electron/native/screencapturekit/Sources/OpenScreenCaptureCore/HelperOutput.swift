import Foundation

/// The helper's whole protocol with the app: one JSON object per line on stdout.
///
/// Lives in the core library rather than beside the recorder because `AudioTrackMixer`
/// reports through it too, and the mixer is what `swift test` builds against.
public func emit(_ fields: [String: Any]) {
	if let data = try? JSONSerialization.data(withJSONObject: fields, options: []),
		let line = String(data: data, encoding: .utf8)
	{
		print(line)
		fflush(stdout)
	}
}

public func emitError(code: String, message: String) {
	emit([
		"event": "error",
		"code": code,
		"message": message,
	])
}
