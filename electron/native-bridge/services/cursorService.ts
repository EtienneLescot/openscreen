import type {
	CursorCapabilities,
	CursorRecordingData,
	CursorTelemetryPoint,
} from "../../../src/native/contracts";
import type { CursorNativeAdapter } from "../cursor/adapter";
import type { NativeBridgeStateStore } from "../store";

interface CursorServiceOptions {
	store: NativeBridgeStateStore;
	adapter: CursorNativeAdapter;
}

export class CursorService {
	constructor(private readonly options: CursorServiceOptions) {}

	async getCapabilities(): Promise<CursorCapabilities> {
		const capabilities = await this.options.adapter.getCapabilities();
		this.options.store.setCursorCapabilities(capabilities);
		return capabilities;
	}

	async getTelemetry(videoPath?: string | null): Promise<CursorTelemetryPoint[]> {
		const result = await this.options.adapter.getTelemetry(videoPath);
		if (!result.success) {
			throw new Error(result.message || result.error || "Failed to load cursor telemetry");
		}

		const resolvedVideoPath = videoPath ?? this.options.store.getState().project.currentVideoPath;
		if (resolvedVideoPath) {
			this.options.store.markCursorTelemetryLoaded(resolvedVideoPath, result.samples.length);
		}

		return result.samples;
	}

	async getRecordingData(videoPath?: string | null): Promise<CursorRecordingData> {
		const data = await this.options.adapter.getRecordingData(videoPath);
		const resolvedVideoPath = videoPath ?? this.options.store.getState().project.currentVideoPath;
		if (resolvedVideoPath) {
			this.options.store.markCursorTelemetryLoaded(resolvedVideoPath, data.samples.length);
		}

		return data;
	}
}
