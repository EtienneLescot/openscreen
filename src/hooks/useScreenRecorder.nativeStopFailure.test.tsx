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

/**
 * Only what the native-Windows record/stop round trip touches. Anything the
 * hook reaches for that is not stubbed will throw loudly, which is the point.
 */
function stubElectronAPI(overrides: Record<string, unknown> = {}) {
	api = {
		getRecordingPrefs: vi.fn(async () => null),
		getPlatform: vi.fn(() => "win32"),
		getSelectedSource: vi.fn(async () => SOURCE),
		isNativeWindowsCaptureAvailable: vi.fn(async () => ({ success: true, available: true })),
		startNativeWindowsRecording: vi.fn(async () => ({ success: true, recordingId: 7 })),
		stopNativeWindowsRecording: vi.fn(async () => ({ success: true })),
		showCountdownOverlay: vi.fn(async () => true),
		setCountdownOverlayValue: vi.fn(async () => true),
		hideCountdownOverlay: vi.fn(async () => true),
		setCurrentRecordingSession: vi.fn(async () => undefined),
		setCurrentVideoPath: vi.fn(async () => undefined),
		switchToEditor: vi.fn(async () => undefined),
	};
	window.electronAPI = { ...api, ...overrides } as unknown as ElectronAPI;
}

type RecorderView = { result: { current: ReturnType<typeof useScreenRecorder> } };

/**
 * Runs every pending timer and microtask. `waitFor` is unusable here: it polls
 * on the same timers this suite fakes, so it can only ever time out.
 */
async function settle(ms = 0) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

/** Drives the hook through the 3s countdown into an active native recording. */
async function startNativeRecording(view: RecorderView) {
	await act(async () => {
		view.result.current.toggleRecording();
	});
	await settle(3_500);
	expect(view.result.current.recording).toBe(true);
}

async function pressStop(view: RecorderView) {
	await act(async () => {
		view.result.current.toggleRecording();
	});
	await settle();
}

beforeEach(() => {
	vi.useFakeTimers();
	stubElectronAPI();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("useScreenRecorder native Windows stop failure", () => {
	/**
	 * Issue #252's second symptom. When the helper wedges, the main process
	 * releases its handle in a `finally` regardless, so a renderer that kept its
	 * own handle left the HUD showing a stop button that could only ever send a
	 * second stop -- answered with "Native Windows capture is not running."
	 */
	it("leaves the recorder able to start again after a failed stop", async () => {
		api.stopNativeWindowsRecording.mockResolvedValue({
			success: false,
			reason: "stop-timeout",
			error: "Timed out waiting for native Windows capture to stop.",
		});

		const view = renderHook(() => useScreenRecorder());
		await startNativeRecording(view);
		await pressStop(view);

		expect(view.result.current.recording).toBe(false);
		expect(toast.error).toHaveBeenCalledWith(
			"Timed out waiting for native Windows capture to stop.",
		);
		expect(view.result.current.saving).toBe(false);
		// The failure must not be mistaken for a successful recording.
		expect(api.switchToEditor).not.toHaveBeenCalled();

		// The next press starts a NEW recording instead of re-sending a stop.
		api.stopNativeWindowsRecording.mockClear();
		await startNativeRecording(view);

		expect(api.startNativeWindowsRecording).toHaveBeenCalledTimes(2);
		expect(api.stopNativeWindowsRecording).not.toHaveBeenCalled();
	});

	it("leaves the recorder able to start again when the stop IPC throws", async () => {
		api.stopNativeWindowsRecording.mockRejectedValue(new Error("IPC channel closed"));

		const view = renderHook(() => useScreenRecorder());
		await startNativeRecording(view);
		await pressStop(view);

		expect(view.result.current.recording).toBe(false);
		expect(toast.error).toHaveBeenCalledWith("IPC channel closed");
	});

	it("still opens the editor when the stop succeeds", async () => {
		api.stopNativeWindowsRecording.mockResolvedValue({
			success: true,
			path: "C:\\rec\\a.mp4",
		});

		const view = renderHook(() => useScreenRecorder());
		await startNativeRecording(view);
		await pressStop(view);

		expect(api.switchToEditor).toHaveBeenCalled();
		expect(view.result.current.recording).toBe(false);
	});
});
