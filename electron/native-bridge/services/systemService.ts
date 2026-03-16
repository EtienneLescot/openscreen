import type {
	CursorCapabilities,
	NativePlatform,
	SystemCapabilities,
} from "../../../src/native/contracts";
import { NATIVE_BRIDGE_VERSION } from "../../../src/native/contracts";
import type { NativeBridgeStateStore } from "../store";

interface SystemServiceOptions {
	store: NativeBridgeStateStore;
	getPlatform: () => NativePlatform;
	getAssetBasePath: () => string | null;
	getCursorCapabilities: () => Promise<CursorCapabilities>;
}

export class SystemService {
	constructor(private readonly options: SystemServiceOptions) {}

	getPlatform() {
		return this.options.getPlatform();
	}

	getAssetBasePath() {
		return this.options.getAssetBasePath();
	}

	async getCapabilities(): Promise<SystemCapabilities> {
		const platform = this.getPlatform();
		const cursorCapabilities = await this.options.getCursorCapabilities();

		const capabilities: SystemCapabilities = {
			bridgeVersion: NATIVE_BRIDGE_VERSION,
			platform,
			cursor: cursorCapabilities,
			project: {
				currentContext: true,
			},
		};

		this.options.store.setSystemCapabilities(capabilities);
		return capabilities;
	}
}
