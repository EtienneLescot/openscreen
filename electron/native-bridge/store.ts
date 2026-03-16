import type {
	CursorCapabilities,
	NativePlatform,
	ProjectContext,
	SystemCapabilities,
} from "../../src/native/contracts";

export interface NativeBridgeState {
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

export class NativeBridgeStateStore {
	private state: NativeBridgeState;

	constructor(platform: NativePlatform) {
		this.state = {
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
	}

	getState() {
		return this.state;
	}

	setProjectContext(project: ProjectContext) {
		this.state = {
			...this.state,
			project,
		};
	}

	setSystemCapabilities(capabilities: SystemCapabilities) {
		this.state = {
			...this.state,
			system: {
				...this.state.system,
				capabilities,
			},
		};
	}

	setCursorCapabilities(capabilities: CursorCapabilities) {
		this.state = {
			...this.state,
			cursor: {
				...this.state.cursor,
				capabilities,
			},
		};
	}

	markCursorTelemetryLoaded(videoPath: string, sampleCount: number) {
		this.state = {
			...this.state,
			cursor: {
				...this.state.cursor,
				lastTelemetryLoad: {
					videoPath,
					sampleCount,
					loadedAt: Date.now(),
				},
			},
		};
	}
}
