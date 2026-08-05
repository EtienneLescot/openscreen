import { describe, expect, it, vi } from "vitest";
import type { RecorderHandle } from "./recorderHandle";
import { finalizeWebcamAsset } from "./useScreenRecorder";

/**
 * The property under test is that a webcam track is never lost without a word.
 *
 * The native macOS/Linux paths used to buffer the whole camera clip in the
 * renderer and flatten it into one ArrayBuffer at finalize. Past ~2 GB (a take
 * of roughly 20 minutes at BITRATE_BASE) that throws, the throw was swallowed,
 * and the session was written screen-only — the editor opened normally with the
 * camera simply absent (#253). So each case below asserts one of two things:
 * that a streamed recording never gets read into memory at all, or that a
 * failure comes back with a reason the caller can put in front of the user.
 */

const FILE_NAME = "recording-1-webcam.webm";

function fakeHandle(overrides: Partial<RecorderHandle> & { state?: MediaRecorder["state"] }) {
	const { state = "recording", ...rest } = overrides;
	const stop = vi.fn();
	const handle = {
		recorder: { state, stop } as unknown as MediaRecorder,
		recordedBlobPromise: Promise.resolve(new Blob([])),
		isStreaming: () => false,
		discard: async () => undefined,
		...rest,
	} as RecorderHandle;
	return { handle, stop };
}

describe("finalizeWebcamAsset", () => {
	it("hands over the file name alone when the clip streamed to disk", async () => {
		// The bytes are already on disk, so the empty buffer is the whole point:
		// nothing multi-gigabyte is flattened here or sent across IPC.
		const { handle } = fakeHandle({
			recordedBlobPromise: Promise.resolve(new Blob([])),
			isStreaming: () => true,
		});

		const result = await finalizeWebcamAsset(handle, FILE_NAME, 1_381_500, "macOS");

		expect(result.error).toBeUndefined();
		expect(result.asset).toEqual({ fileName: FILE_NAME, videoData: new ArrayBuffer(0) });
	});

	it("does not mistake a streamed clip's empty blob for a failed recording", async () => {
		// Guards the regression the streaming fix could have introduced: the empty
		// blob is by design, and treating it as "no data" would drop the camera
		// exactly the way the original bug did.
		const { handle } = fakeHandle({
			recordedBlobPromise: Promise.resolve(new Blob([])),
			isStreaming: () => true,
		});

		await expect(finalizeWebcamAsset(handle, FILE_NAME, 1_000, "Linux")).resolves.toMatchObject({
			asset: { fileName: FILE_NAME },
		});
	});

	it("reads a buffered clip into memory and passes its bytes through", async () => {
		// Short takes still buffer, and still have to arrive as bytes.
		const { handle } = fakeHandle({
			recordedBlobPromise: Promise.resolve(new Blob(["webcam bytes"])),
		});

		const result = await finalizeWebcamAsset(handle, FILE_NAME, 6_400, "macOS");

		expect(result.error).toBeUndefined();
		expect(
			new TextDecoder().decode(new Uint8Array(result.asset?.videoData ?? new ArrayBuffer(0))),
		).toBe("webcam bytes");
	});

	it("reports a reason when a buffered clip came back empty", async () => {
		const { handle } = fakeHandle({
			recordedBlobPromise: Promise.resolve(new Blob([])),
		});

		const result = await finalizeWebcamAsset(handle, FILE_NAME, 1_000, "macOS");

		expect(result.asset).toBeUndefined();
		expect(result.error).toBeTruthy();
	});

	it("reports the reason when the recording rejects mid-stream", async () => {
		// A failed disk write rejects recordedBlobPromise. That must surface, not
		// pass for a good recording and not vanish into a console.error.
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const { handle } = fakeHandle({
			recordedBlobPromise: Promise.reject(new Error("Failed to write recording chunk to disk")),
		});

		const result = await finalizeWebcamAsset(handle, FILE_NAME, 1_000, "macOS");

		expect(result.asset).toBeUndefined();
		expect(result.error).toBe("Failed to write recording chunk to disk");
		vi.restoreAllMocks();
	});

	it("stops a still-running recorder, and leaves an already-stopped one alone", async () => {
		const running = fakeHandle({ state: "recording", isStreaming: () => true });
		await finalizeWebcamAsset(running.handle, FILE_NAME, 1_000, "macOS");
		expect(running.stop).toHaveBeenCalledTimes(1);

		const stopped = fakeHandle({ state: "inactive", isStreaming: () => true });
		await finalizeWebcamAsset(stopped.handle, FILE_NAME, 1_000, "macOS");
		expect(stopped.stop).not.toHaveBeenCalled();
	});
});
