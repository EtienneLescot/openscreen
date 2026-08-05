// @vitest-environment jsdom
// Two properties that decide whether a long recording's waveform appears
// quickly or not at all: which pipeline a file is routed to, and how many times
// it is decoded.
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAudioPeaks } from "./useAudioPeaks";

const streamingCalls = vi.fn();
const inMemoryCalls = vi.fn();

vi.mock("./streamingAudioPeaks", () => ({
	computePeaksFromFileStreaming: async () => {
		streamingCalls();
		return new Float32Array([0, 1]);
	},
}));

vi.mock("@/lib/exporter/localSourceFile", () => ({
	materializeLocalSourceFile: async (_url: string, name: string) => ({ name }),
	releaseLocalSourceFile: () => {},
}));

vi.mock("@/lib/exporter/streamingDecoder", () => ({
	loadFileAsArrayBuffer: async () => {
		inMemoryCalls();
		return { data: new ArrayBuffer(8) };
	},
}));

// A 68 MB file — comfortably under the 256 MB in-memory threshold, which is
// exactly why routing on file size sent a 32-minute recording down the
// decode-everything path.
const FILE_BYTES = 68 * 1024 * 1024;
const THIRTY_TWO_MINUTES = 1951;

beforeEach(() => {
	streamingCalls.mockClear();
	inMemoryCalls.mockClear();
	(window as unknown as { electronAPI: unknown }).electronAPI = {
		getReadableFileInfo: async () => ({ success: true, size: FILE_BYTES }),
	};
});

afterEach(cleanup);

describe("useAudioPeaks", () => {
	it("streams a long recording instead of decoding it whole", async () => {
		const { result } = renderHook(() => useAudioPeaks("/tmp/long-a.mp4", THIRTY_TWO_MINUTES));
		await waitFor(() => expect(result.current).not.toBeNull());
		expect(streamingCalls).toHaveBeenCalledOnce();
		// The whole point: 68 MB on disk is 656 MB decoded, so this must NOT be
		// the path that reads the file and hands it to decodeAudioData.
		expect(inMemoryCalls).not.toHaveBeenCalled();
	});

	it("keeps decoding short clips in memory", async () => {
		// Only the ROUTE is asserted: the in-memory path then needs a real
		// AudioContext and a Worker, neither of which jsdom has.
		renderHook(() => useAudioPeaks("/tmp/short-a.mp4", 20));
		await waitFor(() => expect(inMemoryCalls).toHaveBeenCalled());
		expect(streamingCalls).not.toHaveBeenCalled();
	});

	it("decodes a file once, however many clips mount it and however often", async () => {
		const url = "/tmp/long-b.mp4";
		// Three clips of the same asset, mounted together.
		const a = renderHook(() => useAudioPeaks(url, THIRTY_TWO_MINUTES));
		const b = renderHook(() => useAudioPeaks(url, THIRTY_TWO_MINUTES));
		const c = renderHook(() => useAudioPeaks(url, THIRTY_TWO_MINUTES));
		await waitFor(() => expect(a.result.current).not.toBeNull());
		await waitFor(() => expect(b.result.current).not.toBeNull());
		await waitFor(() => expect(c.result.current).not.toBeNull());
		expect(streamingCalls).toHaveBeenCalledOnce();

		// Unmount everything — this is a Media↔Edit tab switch — and come back.
		// With the cache scoped to a component ref, this re-decoded the whole
		// recording every single time.
		act(() => {
			a.unmount();
			b.unmount();
			c.unmount();
		});
		const again = renderHook(() => useAudioPeaks(url, THIRTY_TWO_MINUTES));
		await waitFor(() => expect(again.result.current).not.toBeNull());
		expect(streamingCalls).toHaveBeenCalledOnce();
	});
});
