import { describe, expect, it } from "vitest";
import { webcamDeviceIdentityFrom } from "./webcamDeviceIdentity";

function streamWith(track: Partial<MediaStreamTrack> | null): MediaStream {
	return { getVideoTracks: () => (track ? [track] : []) } as unknown as MediaStream;
}

describe("webcamDeviceIdentityFrom", () => {
	it("takes both halves from the track the browser opened", () => {
		const stream = streamWith({
			label: "Camera (NVIDIA Broadcast)",
			getSettings: () => ({ deviceId: "nvidia-id" }),
		} as Partial<MediaStreamTrack>);

		expect(webcamDeviceIdentityFrom(stream, "stale-id", "VCam Camera")).toEqual({
			deviceId: "nvidia-id",
			deviceName: "Camera (NVIDIA Broadcast)",
		});
	});

	/**
	 * The bug this exists to prevent. The HUD's own enumeration defaulted the NAME
	 * to the first device — a virtual camera that emits nothing — while the prefs
	 * restored the ID of the camera the user actually picked. Chromium honoured
	 * the id and previewed the right camera; the native helper matched on the name
	 * and recorded the wrong one, producing a zero-byte webcam file.
	 */
	it("never pairs one camera's id with another camera's name", () => {
		const stream = streamWith({
			label: "Logitech StreamCam (046d:0893)",
			getSettings: () => ({ deviceId: "logitech-id" }),
		} as Partial<MediaStreamTrack>);

		const identity = webcamDeviceIdentityFrom(stream, "vcam-id", "VCam Camera");

		expect(identity.deviceId).toBe("logitech-id");
		expect(identity.deviceName).toBe("Logitech StreamCam (046d:0893)");
	});

	it("falls back to the known selection when there is no stream", () => {
		expect(webcamDeviceIdentityFrom(null, "picked-id", "Picked Camera")).toEqual({
			deviceId: "picked-id",
			deviceName: "Picked Camera",
		});
	});

	it("falls back to the known selection when there is no video track", () => {
		expect(webcamDeviceIdentityFrom(streamWith(null), "picked-id", "Picked Camera")).toEqual({
			deviceId: "picked-id",
			deviceName: "Picked Camera",
		});
	});

	// Chromium withholds labels until camera permission has been granted, and
	// reports an empty deviceId under some constraint combinations. Neither is a
	// reason to send an empty name to a helper that matches devices by name.
	it("keeps the known values when the track answers with empty strings", () => {
		const stream = streamWith({
			label: "",
			getSettings: () => ({ deviceId: "" }),
		} as Partial<MediaStreamTrack>);

		expect(webcamDeviceIdentityFrom(stream, "picked-id", "Picked Camera")).toEqual({
			deviceId: "picked-id",
			deviceName: "Picked Camera",
		});
	});
});
