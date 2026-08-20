import { describe, expect, it } from "vitest";
import { normalizeDeviceName, scoreDeviceNameMatch } from "./deviceNameMatching";

describe("normalizeDeviceName", () => {
	it("reduces punctuation and case to single-spaced lowercase", () => {
		expect(normalizeDeviceName("Camera (NVIDIA Broadcast)")).toBe("camera nvidia broadcast");
		expect(normalizeDeviceName("Logitech StreamCam (046d:0893)")).toBe(
			"logitech streamcam 046d 0893",
		);
	});
});

describe("scoreDeviceNameMatch", () => {
	it("scores an exact name highest", () => {
		expect(
			scoreDeviceNameMatch("Camera (NVIDIA Broadcast)", "{clsid}", "Camera (NVIDIA Broadcast)"),
		).toBe(1000);
	});

	// What Chromium hands over is the driver's name plus USB ids, so one side
	// being the other with decoration is the ordinary case, not a near miss.
	it("matches through the USB ids Chromium appends", () => {
		expect(
			scoreDeviceNameMatch("Logitech StreamCam", "{clsid}", "Logitech StreamCam (046d:0893)"),
		).toBe(900);
	});

	it("matches when the platform name is the longer of the two", () => {
		expect(
			scoreDeviceNameMatch("Logitech HD Pro Webcam C920", "{clsid}", "HD Pro Webcam C920"),
		).toBe(900);
	});

	/**
	 * The bug this module exists to end. "Logi Capture" and "Logitech StreamCam"
	 * are two different real devices sharing no word — but "logi" is inside
	 * "logitech", and the word-scoring tier took that for a match, opening the
	 * wrong camera instead of letting the caller fall through to the provider
	 * that had the right one.
	 */
	it("refuses a word that is merely inside another word", () => {
		expect(scoreDeviceNameMatch("Logitech StreamCam", "{clsid}", "Logi Capture")).toBe(0);
	});

	it("refuses the microphone form of the same mistake", () => {
		expect(scoreDeviceNameMatch("Microphone (Logitech PRO X)", "{id}", "Micro Studio")).toBe(0);
	});

	/**
	 * Sharing one distinctive word is no longer enough on its own. Two Logitech
	 * devices are still two devices, and answering "some Logitech thing" is how
	 * the wrong one got opened.
	 */
	it("refuses a partial match on a shared brand", () => {
		expect(scoreDeviceNameMatch("Logitech StreamCam", "{clsid}", "Logitech BRIO")).toBe(0);
	});

	it("scores nothing when no name was requested", () => {
		expect(scoreDeviceNameMatch("Logitech StreamCam", "{clsid}", undefined)).toBe(0);
		expect(scoreDeviceNameMatch("Logitech StreamCam", "{clsid}", "   ")).toBe(0);
	});

	/**
	 * "Micro" is inside "Microphone", "Logi" inside "Logitech" — spelled there,
	 * but not as a word. Containment used to take either for a match and resolve
	 * a device nobody asked for.
	 */
	it("refuses a request merely spelled inside a longer word", () => {
		expect(scoreDeviceNameMatch("Microphone (Logitech StreamCam)", "{id}", "Micro")).toBe(0);
		expect(scoreDeviceNameMatch("Logitech StreamCam", "{clsid}", "Logi")).toBe(0);
	});

	/**
	 * `[^a-z0-9]` stripped every non-Latin letter, so two different Japanese
	 * cameras both normalized to "a" and matched each other at 1000.
	 */
	it("keeps non-Latin names apart", () => {
		expect(scoreDeviceNameMatch("カメラ A", "{clsid}", "ウェブカメラ A")).toBe(0);
		expect(scoreDeviceNameMatch("Веб-камера 1", "{clsid}", "Веб-камера 2")).toBe(0);
	});

	it("still matches identical non-Latin names", () => {
		expect(scoreDeviceNameMatch("カメラ A", "{clsid}", "カメラ A")).toBe(1000);
		expect(scoreDeviceNameMatch("摄像头（罗技）", "{clsid}", "摄像头（罗技）")).toBe(1000);
	});

	it("falls back to the identifier when the friendly name says nothing", () => {
		expect(scoreDeviceNameMatch("", "usb elgato facecam 0fd9", "Elgato Facecam")).toBe(800);
	});
});
