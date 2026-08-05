// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import { transcribeMono16kToSegments } from "./transcribe";

/**
 * The renderer-side `transcribeMono16kToSegments` is a thin adapter on top of
 * `electronAPI.stt.transcribe`. It must:
 *  - emit each word from `wordSegments` as a single-token `CaptionSegment`,
 *  - tag the run `granularity: "word"`,
 *  - fall back to phrase segments with `granularity: "phrase"` when the
 *    decoder returned no words (e.g. OOV-heavy speech),
 *  - drop the temporary `stt:status` listener as soon as IPC settles,
 *  - tolerate `window.electronAPI.stt` being absent (browser-only tests/dev).
 *
 * Word timestamps come back absolute from whisper.cpp (its built-in Silero
 * VAD, started in `electron/stt/whisperServer.ts`, offsets each speech
 * region's timestamps to its position in the original audio), so this
 * adapter does *not* apply any leading-silence trim + offset arithmetic.
 * That pathway was deleted because the peak detector had false positives on
 * quiet music intros / room tone.
 *
 * These tests mock the global API directly; they don't exercise the renderer
 * worker that the previous Web-Worker pipeline owned, so they run in any env.
 */

// Mirrors `SttRendererStatus` — the mock must accept the progress fields, since
// carrying them across the IPC hop is exactly what this file asserts.
type Listener = (event: {
	phase: "model" | "transcribe";
	completedSec?: number;
	totalSec?: number;
}) => void;

type RendererSttApi = {
	transcribe: (request: { samples: Float32Array; language?: string }) => Promise<{
		segments: Array<{ text: string; startSec: number; endSec: number }>;
		wordSegments: Array<{
			word: string;
			startSec: number;
			endSec: number;
			confidence?: number;
		}>;
		detectedLanguage: string;
		backend: string;
	}>;
	onStatus?: (cb: Listener) => () => void;
};

/** Same shape as the real API, but with the mock control surface on `transcribe`. */
type MockedSttApi = RendererSttApi & {
	transcribe: Mock<RendererSttApi["transcribe"]>;
};

let mockApi: MockedSttApi;
let lastStatusCb: Listener | null = null;

const installMockApi = () => {
	mockApi = {
		transcribe: vi.fn<RendererSttApi["transcribe"]>(),
		onStatus: vi.fn((cb: Listener) => {
			lastStatusCb = cb;
			return () => {
				lastStatusCb = null;
			};
		}),
	};
	(globalThis as { electronAPI?: { stt?: RendererSttApi } }).electronAPI = {
		stt: mockApi,
	};
};

const removeMockApi = () => {
	delete (globalThis as { electronAPI?: unknown }).electronAPI;
	lastStatusCb = null;
};

describe("transcribeMono16kToSegments", () => {
	beforeEach(() => {
		installMockApi();
	});

	afterEach(() => {
		removeMockApi();
	});

	it("maps wordSegments to per-word CaptionSegments with granularity 'word'", async () => {
		mockApi.transcribe.mockResolvedValueOnce({
			segments: [],
			wordSegments: [
				{ word: "hello", startSec: 0, endSec: 0.3 },
				{ word: "world", startSec: 0.31, endSec: 0.65 },
			],
			detectedLanguage: "en",
			backend: "whisper-cpu",
		});

		const samples = new Float32Array(1600);
		const result = await transcribeMono16kToSegments(samples);

		expect(result.granularity).toBe("word");
		expect(result.segments).toEqual([
			{ text: "hello", startSec: 0, endSec: 0.3 },
			{ text: "world", startSec: 0.31, endSec: 0.65 },
		]);
		expect(mockApi.transcribe).toHaveBeenCalledWith({
			samples,
			language: undefined,
		});
	});

	it("falls back to phrase segments with granularity 'phrase' when alignment returns no words", async () => {
		mockApi.transcribe.mockResolvedValueOnce({
			segments: [{ text: "hello world", startSec: 0, endSec: 0.65 }],
			wordSegments: [],
			detectedLanguage: "en",
			backend: "whisper-cpu",
		});

		const result = await transcribeMono16kToSegments(new Float32Array(1600));
		expect(result.granularity).toBe("phrase");
		expect(result.segments).toEqual([{ text: "hello world", startSec: 0, endSec: 0.65 }]);
	});

	it("forwards the whole status event to onStatus and tears the listener down", async () => {
		const onStatus = vi.fn();
		mockApi.transcribe.mockImplementationOnce(async () => {
			// Simulate the IPC handler emitting a status event mid-flight.
			lastStatusCb?.({ phase: "model" });
			lastStatusCb?.({ phase: "transcribe", completedSec: 90, totalSec: 300 });
			return {
				segments: [],
				wordSegments: [{ word: "ok", startSec: 0, endSec: 0.1 }],
				detectedLanguage: "en",
				backend: "whisper-cpu",
			};
		});

		await transcribeMono16kToSegments(new Float32Array(1600), { onStatus });
		expect(onStatus).toHaveBeenCalledWith({ phase: "model" });
		// The chunk progress must survive the hop, not just the phase — it is what
		// drives the progress bar.
		expect(onStatus).toHaveBeenCalledWith({
			phase: "transcribe",
			completedSec: 90,
			totalSec: 300,
		});
		// onStatus listener is detached once the promise settles.
		expect(lastStatusCb).toBeNull();
	});

	it("returns empty results when running outside Electron (browser tests)", async () => {
		removeMockApi();
		const result = await transcribeMono16kToSegments(new Float32Array(1600));
		expect(result.granularity).toBe("word");
		expect(result.segments).toEqual([]);
	});

	it("rejects with AbortError when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			transcribeMono16kToSegments(new Float32Array(1600), { signal: controller.signal }),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(mockApi.transcribe).not.toHaveBeenCalled();
	});
});
