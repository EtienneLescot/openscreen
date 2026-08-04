/**
 * The request the Linux capture helper takes as argv[1].
 *
 * Deliberately narrower than its Windows and macOS counterparts, because on
 * Wayland the app knows less:
 *
 *   * There is no `source`. The ScreenCast portal raises its own picker and the
 *     compositor decides what it hands over; `desktopCapturer` on Wayland
 *     returns a single placeholder entry and no usable id. Passing one would be
 *     passing a guess. The helper reports back what was actually picked.
 *   * There is no `webcam`. Like macOS, the camera stays with the renderer's
 *     MediaRecorder — V4L2 in the helper would buy nothing and cost a second
 *     exclusive claim on the device.
 *   * There is no `restoreToken`. One used to be replayed here so the portal
 *     would stop raising its picker, and that is exactly how picking a window
 *     produced a recording of the whole screen: a token is bound to the source
 *     it was minted for, so an approved monitor came back forever and the picker
 *     — the only source chooser Wayland offers — never reappeared.
 */
export type NativeLinuxRecordingRequest = {
	recordingId?: number;
	video: {
		fps: number;
		bitrate?: number;
	};
	audio: {
		system: {
			enabled: boolean;
		};
		microphone: {
			enabled: boolean;
			/**
			 * A PipeWire `node.name`, NOT the browser device id the UI carries.
			 * The two namespaces are unrelated and there is no mapping between
			 * them, so this is left empty until the picker learns to enumerate
			 * PipeWire nodes; empty means the session's default source.
			 */
			deviceName?: string;
			gain: number;
		};
	};
	cursor: {
		mode: import("./recordingSession").CursorCaptureMode;
	};
};

/** The slice of `window.electronAPI` the check below needs. */
type SourceSelectionProbe = {
	getPlatform: () => string;
	isNativeLinuxCaptureAvailable: () => Promise<{ success: boolean; available: boolean }>;
};

/**
 * Whether the ScreenCast portal — not the app — chooses what gets recorded.
 *
 * True only on Linux WITH the PipeWire helper. `SelectSources` has no parameter
 * naming a source, so there is nothing for the app to have selected and every
 * `selectedSource` gate must stand down. Everywhere else those gates are
 * load-bearing: both other native paths, and Linux's own browser fallback,
 * genuinely consume a source id.
 *
 * Lives here rather than inline in `useScreenRecorder` because the recorder asks
 * this question in TWO places — once before the countdown and once before
 * capture — and fixing only the second left the countdown refusing to start at
 * all, with an alert about a source the HUD no longer offers any way to pick.
 */
export async function portalOwnsSourceSelection(api: SourceSelectionProbe): Promise<boolean> {
	if (api.getPlatform() !== "linux") {
		return false;
	}
	try {
		const availability = await api.isNativeLinuxCaptureAvailable();
		return Boolean(availability?.success && availability.available);
	} catch (error) {
		// Keep the gate rather than drop it: without the helper a source id is
		// still needed, and a missing source is a better failure than a capture
		// that cannot start.
		console.warn("Failed to check native Linux capture availability:", error);
		return false;
	}
}

export type NativeLinuxRecordingStartResult = {
	success: boolean;
	recordingId?: number;
	path?: string;
	helperPath?: string;
	error?: string;
	/** "vaapi", "vulkan" or "software" — which rung of the encoder ladder won. */
	videoEncoder?: string | null;
};

/**
 * The portal's cursor modes, as the helper's `cursorMode` field spells them.
 *
 * METADATA is what makes the editable cursor possible: the compositor keeps the
 * pointer out of the captured pixels and describes its position separately, so
 * the editor can draw its own without the real one showing through underneath.
 * EMBEDDED is the opposite and matches the HUD's "system cursor" setting.
 */
export function portalCursorMode(
	mode: import("./recordingSession").CursorCaptureMode,
): "metadata" | "embedded" {
	return mode === "system" ? "embedded" : "metadata";
}
