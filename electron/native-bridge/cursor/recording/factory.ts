import type { Rectangle } from "electron";
import type { CursorRecordingSession } from "./session";
import { TelemetryRecordingSession } from "./telemetryRecordingSession";
import { WindowsNativeRecordingSession } from "./windowsNativeRecordingSession";

interface CreateCursorRecordingSessionOptions {
	getDisplayBounds: () => Rectangle | null;
	maxSamples: number;
	platform: NodeJS.Platform;
	sampleIntervalMs: number;
}

export function createCursorRecordingSession(
	options: CreateCursorRecordingSessionOptions,
): CursorRecordingSession {
	if (options.platform === "win32") {
		return new WindowsNativeRecordingSession({
			getDisplayBounds: options.getDisplayBounds,
			maxSamples: options.maxSamples,
			sampleIntervalMs: options.sampleIntervalMs,
		});
	}

	return new TelemetryRecordingSession({
		getDisplayBounds: options.getDisplayBounds,
		maxSamples: options.maxSamples,
		sampleIntervalMs: options.sampleIntervalMs,
	});
}
