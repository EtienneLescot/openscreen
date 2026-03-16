import type { CursorCapabilities, CursorRecordingData } from "../../../src/native/contracts";
import type { CursorNativeAdapter, CursorTelemetryLoadResult } from "./adapter";

interface TelemetryCursorAdapterOptions {
	loadRecordingData: (videoPath: string) => Promise<CursorRecordingData>;
	resolveVideoPath: (videoPath?: string | null) => string | null;
	loadTelemetry: (videoPath: string) => Promise<CursorTelemetryLoadResult>;
}

export class TelemetryCursorAdapter implements CursorNativeAdapter {
	readonly kind = "none" as const;

	constructor(private readonly options: TelemetryCursorAdapterOptions) {}

	async getCapabilities(): Promise<CursorCapabilities> {
		return {
			telemetry: true,
			systemAssets: false,
			provider: this.kind,
		};
	}

	async getRecordingData(videoPath?: string | null): Promise<CursorRecordingData> {
		const resolvedVideoPath = this.options.resolveVideoPath(videoPath);
		if (!resolvedVideoPath) {
			return {
				version: 2,
				provider: this.kind,
				samples: [],
				assets: [],
			};
		}

		return this.options.loadRecordingData(resolvedVideoPath);
	}

	async getTelemetry(videoPath?: string | null) {
		const resolvedVideoPath = this.options.resolveVideoPath(videoPath);
		if (!resolvedVideoPath) {
			return {
				success: true,
				samples: [],
			} satisfies CursorTelemetryLoadResult;
		}

		return this.options.loadTelemetry(resolvedVideoPath);
	}
}
