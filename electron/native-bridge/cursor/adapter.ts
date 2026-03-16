import type {
	CursorCapabilities,
	CursorProviderKind,
	CursorRecordingData,
	CursorTelemetryPoint,
} from "../../../src/native/contracts";

export interface CursorTelemetryLoadResult {
	success: boolean;
	samples: CursorTelemetryPoint[];
	message?: string;
	error?: string;
}

export interface CursorNativeAdapter {
	readonly kind: CursorProviderKind;
	getCapabilities(): Promise<CursorCapabilities>;
	getRecordingData(videoPath?: string | null): Promise<CursorRecordingData>;
	getTelemetry(videoPath?: string | null): Promise<CursorTelemetryLoadResult>;
}
