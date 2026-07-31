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
 *
 * `restoreToken` is the one field with no equivalent elsewhere: the portal hands
 * one back after a successful session, and passing it next time is what stops
 * the picker from appearing on every single recording.
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
	/** From a previous run's `stream-started`. Lets the portal skip its picker. */
	restoreToken?: string;
};

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
