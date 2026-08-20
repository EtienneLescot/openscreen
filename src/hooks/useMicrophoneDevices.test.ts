// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMicrophoneDevices } from "./useMicrophoneDevices";

const DEVICES = [
	{ kind: "audioinput", deviceId: "mic-a", label: "Realtek Array Microphone", groupId: "g1" },
	{ kind: "audioinput", deviceId: "mic-b", label: "Microphone (Logitech PRO X)", groupId: "g2" },
	{ kind: "videoinput", deviceId: "cam", label: "Webcam", groupId: "g3" },
];

const enumerateDevices = vi.fn(async () => DEVICES);

Object.defineProperty(global.navigator, "mediaDevices", {
	value: {
		enumerateDevices,
		getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })),
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
	},
	configurable: true,
});

describe("useMicrophoneDevices", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		enumerateDevices.mockResolvedValue(DEVICES);
	});

	it("falls back to the first input when nothing is remembered", async () => {
		const { result } = renderHook(() => useMicrophoneDevices(true));
		await waitFor(() => expect(result.current.selectedDeviceId).toBe("mic-a"));
	});

	it("prefers the remembered microphone over the first input", async () => {
		const { result } = renderHook(() => useMicrophoneDevices(true, "mic-b"));
		await waitFor(() => expect(result.current.selectedDeviceId).toBe("mic-b"));
	});

	/**
	 * Chromium's device ids are per-origin salted, so the id one window persisted
	 * can name nothing in the next while the microphone itself is right there in
	 * the list. Falling through to the first input would silently swap the user's
	 * microphone — which is the bug, one layer down.
	 */
	it("finds the remembered microphone by label when its id no longer matches", async () => {
		const { result } = renderHook(() =>
			useMicrophoneDevices(true, "stale-id", "Microphone (Logitech PRO X)"),
		);
		await waitFor(() => expect(result.current.selectedDeviceId).toBe("mic-b"));
	});

	it("still falls back to the first input when neither id nor label matches", async () => {
		const { result } = renderHook(() =>
			useMicrophoneDevices(true, "stale-id", "A microphone that left"),
		);
		await waitFor(() => expect(result.current.selectedDeviceId).toBe("mic-a"));
	});
});
