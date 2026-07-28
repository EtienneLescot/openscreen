import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForFirstVideoFrame } from "./waitForFirstVideoFrame";

function fakeTrack(): MediaStreamTrack {
	return {} as MediaStreamTrack;
}

describe("waitForFirstVideoFrame", () => {
	const originalRvfc = HTMLVideoElement.prototype.requestVideoFrameCallback;
	const originalPlay = HTMLVideoElement.prototype.play;

	beforeEach(() => {
		vi.useFakeTimers();
		HTMLVideoElement.prototype.play = vi.fn().mockResolvedValue(undefined);
		// jsdom doesn't implement MediaStream at all.
		vi.stubGlobal(
			"MediaStream",
			class {
				constructor(_tracks?: MediaStreamTrack[]) {
					// Fake stand-in; only needs to be constructible.
				}
			},
		);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		HTMLVideoElement.prototype.requestVideoFrameCallback = originalRvfc;
		HTMLVideoElement.prototype.play = originalPlay;
	});

	it("resolves with the callback time once requestVideoFrameCallback fires", async () => {
		let capturedCallback: VideoFrameRequestCallback | null = null;
		HTMLVideoElement.prototype.requestVideoFrameCallback = vi.fn(
			(cb: VideoFrameRequestCallback) => {
				capturedCallback = cb;
				return 1;
			},
		);

		const promise = waitForFirstVideoFrame(fakeTrack());
		await vi.advanceTimersByTimeAsync(0);

		expect(capturedCallback).not.toBeNull();
		vi.setSystemTime(12345);
		capturedCallback?.(0, {} as VideoFrameCallbackMetadata);

		await expect(promise).resolves.toBe(12345);
	});

	it("falls back to Date.now() after the timeout when no frame ever arrives", async () => {
		HTMLVideoElement.prototype.requestVideoFrameCallback = vi.fn(() => 1);

		const promise = waitForFirstVideoFrame(fakeTrack());
		await vi.advanceTimersByTimeAsync(3000);

		await expect(promise).resolves.toEqual(expect.any(Number));
	});

	it("resolves immediately when requestVideoFrameCallback is unavailable", async () => {
		// Simulates an older-Chromium API gap without an `any` cast.
		Object.defineProperty(HTMLVideoElement.prototype, "requestVideoFrameCallback", {
			value: undefined,
			configurable: true,
		});

		const promise = waitForFirstVideoFrame(fakeTrack());
		await vi.advanceTimersByTimeAsync(0);

		await expect(promise).resolves.toEqual(expect.any(Number));
	});
});
