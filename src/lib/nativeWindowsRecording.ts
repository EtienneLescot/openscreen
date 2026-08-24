export type NativeWindowsSourceType = "display" | "window";

export type NativeWindowsRecordingRequest = {
	recordingId?: number;
	preferSoftwareEncoder?: boolean;
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
			deviceName?: string;
			gain: number;
		};
	};
	webcam: {
		enabled: boolean;
		deviceId?: string;
		deviceName?: string;
		directShowClsid?: string;
		width: number;
		height: number;
		fps: number;
	};
	cursor: {
		mode: import("./recordingSession").CursorCaptureMode;
	};
};

export type NativeWindowsRecordingStartResult = {
	success: boolean;
	recordingId?: number;
	path?: string;
	helperPath?: string;
	error?: string;
	/** Helper-reported encoder selection: "default", "software-preferred", or "software-fallback". */
	videoEncoderSelection?: string | null;
	/**
	 * Whether the helper actually landed on a hardware H.264 encoder MFT, as
	 * opposed to `videoEncoderSelection` above, which only says which
	 * configuration path was tried: "hardware", "software", or "unknown" when
	 * the helper could not introspect its own sink writer.
	 */
	videoEncoderRuntime?: string | null;
	/**
	 * A camera was asked for and the helper could not open it, so this take is
	 * screen and audio only. Still a success — the recording is worth keeping —
	 * but the user has to be told, or they discover it in the editor.
	 */
	webcamUnavailable?: boolean;
	/**
	 * A microphone was asked for but could not be named, so the helper captured
	 * whatever Windows calls the default input. The take is fine; the voice on it
	 * probably is not the one the user chose.
	 */
	microphoneDefaulted?: boolean;
};

export function parseWindowHandleFromSourceId(sourceId?: string | null) {
	if (!sourceId?.startsWith("window:")) {
		return null;
	}

	const handlePart = sourceId.split(":")[1];
	if (!handlePart || !/^\d+$/.test(handlePart)) {
		return null;
	}

	return handlePart;
}
