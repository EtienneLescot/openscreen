// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCameraDevices } from "./useCameraDevices";

// Mock navigator.mediaDevices
const mockDevices = [
	{ kind: "videoinput", deviceId: "cam1", label: "Camera 1", groupId: "group1" },
	{ kind: "videoinput", deviceId: "cam2", label: "Camera 2", groupId: "group1" },
	{ kind: "audioinput", deviceId: "mic1", label: "Mic 1", groupId: "group2" },
];

const mockGetUserMedia = vi.fn().mockResolvedValue({
	getTracks: () => [{ stop: vi.fn() }],
});

const mockEnumerateDevices = vi.fn().mockResolvedValue(mockDevices);

Object.defineProperty(global.navigator, "mediaDevices", {
	value: {
		enumerateDevices: mockEnumerateDevices,
		getUserMedia: mockGetUserMedia,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
	},
	configurable: true,
});

describe("useCameraDevices", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockEnumerateDevices.mockResolvedValue(mockDevices);
		mockGetUserMedia.mockResolvedValue({
			getTracks: () => [{ stop: vi.fn() }],
		});
	});

	afterEach(() => {
		vi.resetAllMocks();
	});

	it("should list video input devices", async () => {
		const { result } = renderHook(() => useCameraDevices(true));

		await waitFor(() => {
			expect(result.current.devices).toHaveLength(2);
		});

		expect(result.current.devices[0].label).toBe("Camera 1");
		expect(result.current.devices[1].deviceId).toBe("cam2");
	});

	it("should set first device as default", async () => {
		const { result } = renderHook(() => useCameraDevices(true));

		await waitFor(() => {
			expect(result.current.selectedDeviceId).toBe("cam1");
		});
	});

	it("should use device ID as fallback label when label is missing", async () => {
		mockEnumerateDevices.mockResolvedValueOnce([
			{ kind: "videoinput", deviceId: "cam1abc123456", label: "", groupId: "group1" },
		]);

		const { result } = renderHook(() => useCameraDevices(true));

		await waitFor(() => {
			expect(result.current.devices[0]?.label).toBe("Camera cam1abc1");
		});

		expect(mockGetUserMedia).not.toHaveBeenCalled();
	});

	it("should set error state when enumeration fails", async () => {
		mockEnumerateDevices.mockRejectedValueOnce(new Error("Permission denied"));

		const { result } = renderHook(() => useCameraDevices(true));

		await waitFor(() => {
			expect(result.current.error).toBe("Permission denied");
		});

		expect(result.current.devices).toHaveLength(0);
		expect(result.current.isLoading).toBe(false);
	});

	it("should prefer the restored device over the first enumerated one", async () => {
		const { result } = renderHook(() => useCameraDevices(true, "cam2"));

		await waitFor(() => {
			expect(result.current.selectedDeviceId).toBe("cam2");
		});
	});

	// The prefs arrive over IPC and routinely land after enumeration has already
	// settled on the first device. Losing the user's camera at that point is what
	// made a HUD rebuilt for a new recording revert to a virtual camera that emits
	// nothing, while the native helper was told to capture it by name.
	it("should adopt the restored device when it arrives after enumeration", async () => {
		const { result, rerender } = renderHook(
			({ preferred }: { preferred?: string }) => useCameraDevices(true, preferred),
			{ initialProps: { preferred: undefined as string | undefined } },
		);

		await waitFor(() => {
			expect(result.current.selectedDeviceId).toBe("cam1");
		});

		rerender({ preferred: "cam2" });

		await waitFor(() => {
			expect(result.current.selectedDeviceId).toBe("cam2");
		});
	});

	it("should ignore a restored device that is no longer plugged in", async () => {
		const { result } = renderHook(() => useCameraDevices(true, "cam-that-left"));

		await waitFor(() => {
			expect(result.current.selectedDeviceId).toBe("cam1");
		});
	});

	/**
	 * The HUD feeds this hook's own output back in: `LaunchWindow` writes
	 * `selectedDeviceId` into the recorder's `webcamDeviceId`, and hands that same
	 * value back as `preferredDeviceId`. A rule that re-asserts the preference on
	 * every render would ping-pong with that write-back forever, so the loop this
	 * closes has to settle. Counts renders rather than asserting a value: a
	 * converging hook renders a handful of times, one that oscillates renders
	 * without end.
	 */
	it("settles instead of oscillating when its own selection is fed back as the preference", async () => {
		let renders = 0;
		const { result, rerender } = renderHook(
			({ preferred }: { preferred?: string }) => {
				renders += 1;
				return useCameraDevices(true, preferred);
			},
			{ initialProps: { preferred: undefined as string | undefined } },
		);

		await waitFor(() => {
			expect(result.current.selectedDeviceId).toBe("cam1");
		});

		// The HUD hands back whatever this hook just selected, then the late prefs
		// name a different camera, which the hook adopts and hands back in turn.
		rerender({ preferred: result.current.selectedDeviceId });
		rerender({ preferred: "cam2" });

		await waitFor(() => {
			expect(result.current.selectedDeviceId).toBe("cam2");
		});

		const settled = renders;
		rerender({ preferred: result.current.selectedDeviceId });
		await new Promise((resolve) => setTimeout(resolve, 50));

		// Only the render this test asked for; the effect no longer has anything to say.
		expect(renders - settled).toBeLessThanOrEqual(2);
		expect(result.current.selectedDeviceId).toBe("cam2");
	});

	it("should fall back to first available device when selected device is unplugged", async () => {
		const { result } = renderHook(() => useCameraDevices(true));

		await waitFor(() => {
			expect(result.current.selectedDeviceId).toBe("cam1");
		});

		// Simulate cam1 being unplugged, only cam2 remains
		const cam2Only = [
			{ kind: "videoinput", deviceId: "cam2", label: "Camera 2", groupId: "group1" },
		];
		mockEnumerateDevices.mockResolvedValueOnce(cam2Only);

		// Trigger devicechange event via the registered handler
		const devicechangeHandler = (
			navigator.mediaDevices.addEventListener as ReturnType<typeof vi.fn>
		).mock.calls[0]?.[1] as (() => void) | undefined;

		await act(async () => {
			devicechangeHandler?.();
		});

		await waitFor(() => {
			expect(result.current.selectedDeviceId).toBe("cam2");
		});
	});
});
