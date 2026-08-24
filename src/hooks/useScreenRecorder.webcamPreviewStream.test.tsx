// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/contexts/I18nContext", () => {
	const translate = (key: string) => key;
	return { useScopedT: () => translate };
});

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { useScreenRecorder } from "./useScreenRecorder";

function fakeStream() {
	const track = {
		readyState: "live" as MediaStreamTrackState,
		onended: null as (() => void) | null,
		stop: vi.fn(),
		getSettings: vi.fn(() => ({})),
	};
	const stream = {
		getTracks: () => [track as unknown as MediaStreamTrack],
		getVideoTracks: () => [track as unknown as MediaStreamTrack],
	} as MediaStream;
	return { stream, track };
}

describe("useScreenRecorder webcamPreviewStream", () => {
	beforeEach(() => {
		window.electronAPI = {
			getRecordingPrefs: vi.fn(async () => null),
			hideCountdownOverlay: vi.fn(async () => true),
			requestCameraAccess: vi.fn(async () => ({
				success: true,
				granted: true,
				status: "granted",
			})),
		} as unknown as Window["electronAPI"];
	});

	it("tracks acquisition, device changes, disable, and camera loss without exposing ownership", async () => {
		const first = fakeStream();
		const second = fakeStream();
		const getUserMedia = vi
			.fn()
			.mockResolvedValueOnce(first.stream)
			.mockResolvedValueOnce(second.stream);
		Object.defineProperty(navigator, "mediaDevices", {
			value: { getUserMedia },
			configurable: true,
		});

		const view = renderHook(() => useScreenRecorder());
		await act(async () => {
			await view.result.current.setWebcamEnabled(true);
		});
		await waitFor(() => expect(view.result.current.webcamPreviewStream).toBe(first.stream));

		act(() => view.result.current.setWebcamDeviceId("camera-two"));
		await waitFor(() => expect(view.result.current.webcamPreviewStream).toBe(second.stream));
		expect(first.track.stop).toHaveBeenCalledTimes(1);

		act(() => second.track.onended?.());
		await waitFor(() => expect(view.result.current.webcamPreviewStream).toBeNull());
		expect(view.result.current.webcamEnabled).toBe(false);

		// Re-enable once more to prove disabling tears down the recorder-owned stream.
		const third = fakeStream();
		getUserMedia.mockResolvedValueOnce(third.stream);
		await act(async () => {
			await view.result.current.setWebcamEnabled(true);
		});
		await waitFor(() => expect(view.result.current.webcamPreviewStream).toBe(third.stream));
		await act(async () => {
			await view.result.current.setWebcamEnabled(false);
		});
		await waitFor(() => expect(view.result.current.webcamPreviewStream).toBeNull());
		expect(third.track.stop).toHaveBeenCalledTimes(1);
	});
});
