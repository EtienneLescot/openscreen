// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { FloatingSelfViewWindow } from "./FloatingSelfViewWindow";

describe("FloatingSelfViewWindow", () => {
	let command:
		| ((value: { visible: boolean; requestId: number; deviceId?: string }) => void)
		| undefined;
	let getUserMedia: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		command = undefined;
		getUserMedia = vi.fn();
		Object.defineProperty(navigator, "mediaDevices", {
			configurable: true,
			value: { getUserMedia },
		});
		Object.defineProperty(HTMLMediaElement.prototype, "play", {
			configurable: true,
			value: vi.fn(async () => undefined),
		});
		window.electronAPI = {
			onFloatingSelfViewCommand: vi.fn((callback) => {
				command = callback;
				return () => {
					command = undefined;
				};
			}),
			reportFloatingSelfViewReady: vi.fn(async () => ({ success: true })),
			reportFloatingSelfViewFailed: vi.fn(async () => ({ success: true })),
			closeFloatingSelfViewWindow: vi.fn(async () => ({ success: true })),
		} as unknown as Window["electronAPI"];
	});

	afterEach(() => {
		cleanup();
	});

	it("opens a low-resolution secondary stream only on show and stops it on hide", async () => {
		const stop = vi.fn();
		const track = { stop, addEventListener: vi.fn() } as unknown as MediaStreamTrack;
		getUserMedia.mockResolvedValue({
			getTracks: () => [track],
			getVideoTracks: () => [track],
		});
		render(
			<I18nProvider>
				<FloatingSelfViewWindow />
			</I18nProvider>,
		);

		expect(getUserMedia).not.toHaveBeenCalled();
		await act(async () => command?.({ visible: true, requestId: 17, deviceId: "camera-2" }));
		await waitFor(() =>
			expect(window.electronAPI.reportFloatingSelfViewReady).toHaveBeenCalledWith(17),
		);
		expect(getUserMedia).toHaveBeenCalledWith({
			audio: false,
			video: {
				deviceId: { exact: "camera-2" },
				width: { ideal: 640, max: 640 },
				height: { ideal: 360, max: 480 },
				frameRate: { ideal: 24, max: 30 },
			},
		});

		act(() => command?.({ visible: false, requestId: 18 }));
		expect(stop).toHaveBeenCalledTimes(1);
	});

	it("reports camera acquisition failure without surfacing an exception", async () => {
		getUserMedia.mockRejectedValue(new Error("camera busy"));
		render(
			<I18nProvider>
				<FloatingSelfViewWindow />
			</I18nProvider>,
		);

		await act(async () => command?.({ visible: true, requestId: 22 }));
		await waitFor(() =>
			expect(window.electronAPI.reportFloatingSelfViewFailed).toHaveBeenCalledWith(22),
		);
		expect(window.electronAPI.reportFloatingSelfViewReady).not.toHaveBeenCalled();
	});
});
