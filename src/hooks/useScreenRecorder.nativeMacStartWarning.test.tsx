// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => key,
}));

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { toast } from "sonner";
import { useScreenRecorder } from "./useScreenRecorder";

type ElectronAPI = Window["electronAPI"];

const SOURCE = { id: "screen:0:0", name: "Screen 1", display_id: "1", thumbnail: "" };

let api: Record<string, ReturnType<typeof vi.fn>>;

function stubElectronAPI() {
	api = {
		getRecordingPrefs: vi.fn(async () => ({
			micEnabled: true,
			micDeviceId: "chromium-device-id",
			micDeviceName: "USB Microphone",
			camEnabled: false,
			camDeviceId: null,
			systemAudioEnabled: false,
			cursorCaptureMode: "system",
		})),
		getPlatform: vi.fn(() => "darwin"),
		getSelectedSource: vi.fn(async () => SOURCE),
		isNativeMacCaptureAvailable: vi.fn(async () => ({ success: true, available: true })),
		startNativeMacRecording: vi.fn(async () => ({
			success: true,
			recordingId: 7,
			microphoneDefaulted: true,
		})),
		stopNativeMacRecording: vi.fn(async () => ({ success: true, discarded: true })),
		showCountdownOverlay: vi.fn(async () => true),
		setCountdownOverlayValue: vi.fn(async () => true),
		hideCountdownOverlay: vi.fn(async () => true),
	};
	window.electronAPI = api as unknown as ElectronAPI;
}

async function settle(ms = 0) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	stubElectronAPI();
	vi.mocked(toast.error).mockClear();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("useScreenRecorder native macOS start warnings", () => {
	it("warns but keeps recording when the selected microphone defaults", async () => {
		const view = renderHook(() => useScreenRecorder());
		await settle();

		await act(async () => {
			view.result.current.toggleRecording();
		});
		await settle(3_500);

		expect(api.startNativeMacRecording).toHaveBeenCalledWith(
			expect.objectContaining({
				audio: {
					system: { enabled: false },
					microphone: expect.objectContaining({
						enabled: true,
						deviceId: "chromium-device-id",
						deviceName: "USB Microphone",
					}),
				},
			}),
		);
		expect(view.result.current.recording).toBe(true);
		expect(toast.error).toHaveBeenCalledWith("recording.microphoneDefaulted");
	});

	it("does not warn after the recording start is cancelled", async () => {
		let resolveStart:
			| ((result: Awaited<ReturnType<ElectronAPI["startNativeMacRecording"]>>) => void)
			| null = null;
		api.startNativeMacRecording.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveStart = resolve;
				}),
		);
		const view = renderHook(() => useScreenRecorder());
		await settle();

		await act(async () => {
			view.result.current.toggleRecording();
		});
		await settle(3_500);
		expect(api.startNativeMacRecording).toHaveBeenCalledOnce();

		view.unmount();
		await act(async () => {
			resolveStart?.({ success: true, recordingId: 8, microphoneDefaulted: true });
			await Promise.resolve();
		});

		expect(api.stopNativeMacRecording).toHaveBeenCalledWith(true);
		expect(toast.error).not.toHaveBeenCalled();
	});
});
