import type {
	CursorCapabilities,
	NativePlatform,
	ProjectContext,
	SystemCapabilities,
} from "../../src/native/contracts";

interface NativeBridgeStateData {
	system: {
		platform: NativePlatform;
		capabilities: SystemCapabilities | null;
	};
	project: ProjectContext;
	cursor: {
		capabilities: CursorCapabilities | null;
		lastTelemetryLoad: {
			videoPath: string;
			sampleCount: number;
			loadedAt: number;
		} | null;
	};
}

export interface NativeBridgeState {
	getState(): NativeBridgeStateData;
	setProjectContext(project: ProjectContext): void;
	setSystemCapabilities(capabilities: SystemCapabilities): void;
	setCursorCapabilities(capabilities: CursorCapabilities): void;
	markCursorTelemetryLoaded(videoPath: string, sampleCount: number): void;
}

export function createNativeBridgeState(platform: NativePlatform): NativeBridgeState {
	const state: NativeBridgeStateData = {
		system: {
			platform,
			capabilities: null,
		},
		project: {
			currentProjectPath: null,
			currentVideoPath: null,
		},
		cursor: {
			capabilities: null,
			lastTelemetryLoad: null,
		},
	};

	return {
		getState: () => state,
		setProjectContext: (project) => {
			state.project = project;
		},
		setSystemCapabilities: (capabilities) => {
			state.system = { ...state.system, capabilities };
		},
		setCursorCapabilities: (capabilities) => {
			state.cursor = { ...state.cursor, capabilities };
		},
		markCursorTelemetryLoaded: (videoPath, sampleCount) => {
			state.cursor = {
				...state.cursor,
				lastTelemetryLoad: {
					videoPath,
					sampleCount,
					loadedAt: Date.now(),
				},
			};
		},
	};
}
