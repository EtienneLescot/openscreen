export type NativeWindowsSourceType = "display" | "window";

export type NativeWindowsRecordingRequest = {
	recordingId?: number;
	source: {
		type: NativeWindowsSourceType;
		sourceId: string;
		displayId?: number;
		windowHandle?: string;
	};
	video: {
		fps: number;
		width: number;
		height: number;
	};
	audio: {
		system: {
			enabled: boolean;
		};
		microphone: {
			enabled: boolean;
			deviceId?: string;
			gain: number;
		};
	};
	webcam: {
		enabled: boolean;
		deviceId?: string;
		width: number;
		height: number;
		fps: number;
	};
};

export type NativeWindowsRecordingStartResult = {
	success: boolean;
	recordingId?: number;
	path?: string;
	helperPath?: string;
	error?: string;
};
