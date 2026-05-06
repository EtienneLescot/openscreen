import type { Rectangle } from "electron";
import type { CursorRecordingData } from "../../../../src/native/contracts";
import type { CursorRecordingSession } from "./session";
import { WindowsNativeRecordingSession } from "./windowsNativeRecordingSession";

interface CreateCursorRecordingSessionOptions {
	getDisplayBounds: () => Rectangle | null;
	maxSamples: number;
	platform: NodeJS.Platform;
	sampleIntervalMs: number;
	sourceId?: string | null;
	startTimeMs?: number;
}

class NoopCursorRecordingSession implements CursorRecordingSession {
	async start(): Promise<void> {
		// Native cursor capture is currently Windows-only.
	}

	async stop(): Promise<CursorRecordingData> {
		return {
			version: 2,
			provider: "none",
			assets: [],
			samples: [],
		};
	}
}

export function createCursorRecordingSession(
	options: CreateCursorRecordingSessionOptions,
): CursorRecordingSession {
	if (options.platform === "win32") {
		return new WindowsNativeRecordingSession({
			getDisplayBounds: options.getDisplayBounds,
			maxSamples: options.maxSamples,
			sampleIntervalMs: options.sampleIntervalMs,
			sourceId: options.sourceId,
			startTimeMs: options.startTimeMs,
		});
	}

	return new NoopCursorRecordingSession();
}
