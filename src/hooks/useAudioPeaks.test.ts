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
	computePeaksFromFileStreaming: async (file: { name: string }) => {
		streamingCalls();
		// A recording captured with no microphone and no system audio has no audio
		// stream at all (verified with ffprobe on real camera-less captures), so
		// every decode of it fails — the same way, every time.
		if (file.name.startsWith("silent")) throw new Error("no audio track");
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

	// Issue #348 — a project recorded with no camera AND no microphone. The
	// recorder writes an MP4 with no audio stream at all, so the decode below can
	// never succeed. Caching only successes meant this file re-read itself whole
	// on every mount, forever; a recording WITH a mic paid it once. That
	// asymmetry is the bug.
	it("gives up on a file with no audio track once, not once per mount", async () => {
		const url = "/tmp/silent-no-mic.mp4";
		const warned = vi.spyOn(console, "warn").mockImplementation(() => {
			// swallowed: it is the signal this test waits on, not suite output
		});
		const first = renderHook(() => useAudioPeaks(url, THIRTY_TWO_MINUTES));
		// The hook logs from its `.catch`, so this is the first observable AFTER the
		// rejection settles. Waiting on `streamingCalls` instead would only prove the
		// decode STARTED: the remounts below would then join the still-pending
		// in-flight promise, and the test would pass even if the failure cache broke.
		await waitFor(() => expect(warned).toHaveBeenCalled());
		expect(first.result.current).toBeNull();

		act(() => first.unmount());
		const second = renderHook(() => useAudioPeaks(url, THIRTY_TWO_MINUTES));
		await waitFor(() => expect(second.result.current).toBeNull());
		act(() => second.unmount());
		renderHook(() => useAudioPeaks(url, THIRTY_TWO_MINUTES));

		// The decode is never retried: "this file has no waveform" is a permanent
		// answer and is remembered as one. The first mount's rejection has settled
		// by now, so these mounts hit the cache — not a shared in-flight promise.
		expect(streamingCalls).toHaveBeenCalledOnce();
		expect(warned).toHaveBeenCalledTimes(1);
		warned.mockRestore();
	});

	// The other half of #348, and the expensive half: ffmpeg answers "no audio
	// track" in ~2s, and the renderer used to spend a 175 MB copy into OPFS plus
	// a full Chromium decode re-discovering it — on every project open, since a
	// module-scope cache starts empty each launch.
	it("takes ffmpeg's word for it when a recording has no audio track", async () => {
		(window as unknown as { electronAPI: unknown }).electronAPI = {
			getReadableFileInfo: async () => ({ success: true, size: FILE_BYTES }),
			getAudioPeaks: async () => ({
				success: false,
				message: "Cannot find wanted stream in the input file",
			}),
		};
		const { result } = renderHook(() =>
			useAudioPeaks("/tmp/no-mic-recording.mp4", THIRTY_TWO_MINUTES),
		);
		await waitFor(() => expect(result.current).not.toBeNull());
		// A verdict, not a gap: no browser pipeline runs at all.
		expect(streamingCalls).not.toHaveBeenCalled();
		expect(inMemoryCalls).not.toHaveBeenCalled();
		expect(result.current).toHaveLength(0);
	});

	it("still falls back to a browser pipeline when the host has no ffmpeg", async () => {
		(window as unknown as { electronAPI: unknown }).electronAPI = {
			getReadableFileInfo: async () => ({ success: true, size: FILE_BYTES }),
			// The documented "no native ffmpeg here" signal — a gap, not a verdict.
			getAudioPeaks: async () => ({ success: true, peaks: null }),
		};
		renderHook(() => useAudioPeaks("/tmp/no-ffmpeg-host.mp4", THIRTY_TWO_MINUTES));
		await waitFor(() => expect(streamingCalls).toHaveBeenCalledOnce());
	});

	it("decodes nothing until the duration is known", async () => {
		const url = "/tmp/pending-duration.mp4";
		const view = renderHook(({ d }: { d: number | undefined }) => useAudioPeaks(url, d), {
			initialProps: { d: undefined as number | undefined },
		});
		// Without a duration `computePeaksForUrl` cannot reach the cheap native
		// tier and falls through to reading the whole file into memory — for a
		// waveform `ClipWaveform` could not draw anyway, since it needs the same
		// duration to lay bars out.
		expect(streamingCalls).not.toHaveBeenCalled();
		expect(inMemoryCalls).not.toHaveBeenCalled();

		view.rerender({ d: THIRTY_TWO_MINUTES });
		await waitFor(() => expect(view.result.current).not.toBeNull());
		expect(streamingCalls).toHaveBeenCalledOnce();
	});
});
