export interface WebcamDeviceIdentity {
	deviceId: string | undefined;
	deviceName: string | undefined;
}

/**
 * The camera to name in a native capture request, read off the track the browser
 * actually opened rather than off two separate pieces of React state.
 *
 * Those two used to be fed by two independent async sources — the id restored
 * from the recording prefs over IPC, the name from the HUD window's own
 * `enumerateDevices()` — and whichever settled last won on its own. A request
 * could therefore carry one camera's id next to another camera's name, and since
 * Chromium selects by id while the native Windows helper matches by NAME, the
 * preview showed the chosen camera while the recording captured a different one
 * (getopenscreen/openscreen#387).
 *
 * `track.label` and `track.getSettings().deviceId` describe the same device by
 * construction, which is what makes the pair impossible to mismatch. The
 * fallbacks cover the cases where the track cannot answer: no stream yet, or a
 * label withheld until camera permission has been granted.
 *
 * Lives in its own module rather than inside `useScreenRecorder` so it can be
 * tested without dragging in the i18n context that hook depends on.
 */
export function webcamDeviceIdentityFrom(
	stream: MediaStream | null | undefined,
	fallbackDeviceId: string | undefined,
	fallbackDeviceName: string | undefined,
): WebcamDeviceIdentity {
	const track = stream?.getVideoTracks()[0];
	if (!track) {
		return { deviceId: fallbackDeviceId, deviceName: fallbackDeviceName };
	}

	return {
		deviceId: track.getSettings?.().deviceId || fallbackDeviceId,
		deviceName: track.label || fallbackDeviceName,
	};
}
