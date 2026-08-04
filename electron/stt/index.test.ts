import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { planChunks } from "./chunking";
import { _resetSttManagerForTests, SttManager } from "./index";
import type { SttStatusEvent, SttTranscribeResponse } from "./transcriptionContract";

// We swap the long-lived modules for fakes so the manager's `init()` and
// `transcribe()` paths can be exercised without spawning real processes.
const fakeWhisperServer = {
	start: vi.fn(),
	status: {
		backend: "whispercpp-cpu" as const,
		port: 9000,
		running: true,
		startedAtMs: 1,
		pid: 1,
		lastError: null,
	},
	transcribe: vi.fn(),
	stop: vi.fn(),
};

vi.mock("./whisperServer", () => {
	class FakeWhisperServerManager {
		start = fakeWhisperServer.start;
		status = fakeWhisperServer.status;
		transcribe = fakeWhisperServer.transcribe;
		stop = fakeWhisperServer.stop;
	}
	return { WhisperServerManager: FakeWhisperServerManager };
});

vi.mock("./modelManager", () => ({
	ensureModels: vi.fn(async () => undefined),
	modelPaths: (base: string) => ({
		whisper: `${base}/whisper-ggml/ggml-small-q8_0.bin`,
	}),
}));

vi.mock("./gpuDetector", () => ({
	detectGpuBackend: vi.fn(async () => ({ backend: "whispercpp-cpu", reason: "fake → cpu" })),
	binaryNameForBackend: () => "whisper-stt-server",
	candidateBinaryPaths: () => [] as string[],
	resolveBinaryPath: vi.fn(async () => ({
		path: "/fake/whisper-stt-server",
		backend: "whispercpp-cpu" as const,
	})),
}));

describe("SttManager", () => {
	beforeEach(() => {
		fakeWhisperServer.start.mockClear();
		fakeWhisperServer.transcribe.mockClear();
		fakeWhisperServer.stop.mockClear();
		fakeWhisperServer.start.mockResolvedValue({ port: 9000, backend: "whispercpp-cpu" });
		fakeWhisperServer.transcribe.mockResolvedValue({
			segments: [{ text: "hello", startSec: 0, endSec: 0.5 }],
			wordSegments: [{ word: "hello", startSec: 0, endSec: 0.5 }],
			detectedLanguage: "en",
			backend: "whispercpp-cpu",
		});
		_resetSttManagerForTests();
	});

	afterEach(() => {
		_resetSttManagerForTests();
	});

	it("init() forwards model + transcribe phases to the sink", async () => {
		const sink = vi.fn<(e: SttStatusEvent) => void>();
		const mgr = new SttManager();
		await mgr.init({ statusSink: sink, modelsBaseDir: "/tmp/fake-stt-models" });
		const phases = sink.mock.calls.map(([event]) => event.phase);
		expect(phases[0]).toBe("model");
		expect(phases).toContain("transcribe");
	});

	it("transcribe() returns the server's phrase + word segments", async () => {
		const mgr = new SttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		const result: SttTranscribeResponse = await mgr.transcribe({
			samples: new Float32Array(16000),
			language: "en",
		});
		expect(result.detectedLanguage).toBe("en");
		expect(result.backend).toBe("whispercpp-cpu");
		expect(result.wordSegments).toHaveLength(1);
		expect(fakeWhisperServer.transcribe).toHaveBeenCalledOnce();
	});

	it("splits a long recording and shifts each chunk's timestamps to absolute time", async () => {
		// Every chunk reports the same relative segment at 1.0s; correct merging
		// turns those into one absolute timestamp per chunk start.
		fakeWhisperServer.transcribe.mockResolvedValue({
			segments: [{ text: "hello", startSec: 1, endSec: 1.5 }],
			wordSegments: [{ word: "hello", startSec: 1, endSec: 1.5 }],
			detectedLanguage: "en",
			backend: "whispercpp-cpu",
		});
		const samples = new Float32Array(200 * 16000);
		const mgr = new SttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		const result = await mgr.transcribe({ samples, language: "en" });

		const expectedOffsets = planChunks(samples, 16000).map((c) => c.startSample / 16000);
		expect(expectedOffsets.length).toBeGreaterThan(1);
		expect(fakeWhisperServer.transcribe).toHaveBeenCalledTimes(expectedOffsets.length);
		expect(result.segments.map((s) => s.startSec)).toEqual(expectedOffsets.map((o) => o + 1));
		expect(result.wordSegments.map((w) => w.startSec)).toEqual(expectedOffsets.map((o) => o + 1));
	});

	it("reports monotonic progress that ends on the full duration", async () => {
		const sink = vi.fn<(e: SttStatusEvent) => void>();
		const samples = new Float32Array(200 * 16000);
		const mgr = new SttManager();
		await mgr.init({ statusSink: sink, modelsBaseDir: "/tmp/fake-stt-models" });
		sink.mockClear();
		await mgr.transcribe({ samples, language: "en" });

		const progress = sink.mock.calls
			.map(([event]) => event)
			.filter((event) => event.completedSec !== undefined);
		expect(progress[0].completedSec).toBe(0);
		expect(progress[progress.length - 1].completedSec).toBe(200);
		for (const event of progress) expect(event.totalSec).toBe(200);
		for (let i = 1; i < progress.length; i++) {
			expect(progress[i].completedSec).toBeGreaterThan(progress[i - 1].completedSec ?? -1);
		}
	});

	// Both spellings of "detect it for me". `"auto"` is the one the request
	// contract documents, and it is truthy — which is exactly how it used to slip
	// past the pin and let every chunk detect its own language.
	it.each([
		["omitted", undefined] as const,
		["auto", "auto"] as const,
	])("pins later chunks to the language detected on the first one (%s)", async (_label, language) => {
		const mgr = new SttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		await mgr.transcribe({ samples: new Float32Array(200 * 16000), language });
		const languages = fakeWhisperServer.transcribe.mock.calls.map(([req]) => req.language);
		expect(languages[0]).toBeUndefined();
		expect(languages.slice(1).every((l) => l === "en")).toBe(true);
	});

	it("retries a failed chunk instead of losing the whole transcription", async () => {
		fakeWhisperServer.transcribe.mockRejectedValueOnce(new Error("helper died")).mockResolvedValue({
			segments: [{ text: "hello", startSec: 0, endSec: 0.5 }],
			wordSegments: [{ word: "hello", startSec: 0, endSec: 0.5 }],
			detectedLanguage: "en",
			backend: "whispercpp-cpu",
		});
		const mgr = new SttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		const result = await mgr.transcribe({ samples: new Float32Array(16000), language: "en" });
		expect(result.segments).toHaveLength(1);
		// start() again on the retry — the usual cause is a dead helper.
		expect(fakeWhisperServer.start.mock.calls.length).toBeGreaterThan(1);
	});

	it("fails the request when a chunk never succeeds, saying how far it got", async () => {
		fakeWhisperServer.transcribe.mockRejectedValue(new Error("helper wedged"));
		const mgr = new SttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		// 200s in, the failure is on chunk 2 of 3 — "Transcription failed" alone
		// tells the user nothing about a recording this long.
		await expect(mgr.transcribe({ samples: new Float32Array(200 * 16000) })).rejects.toThrow(
			/transcription failed \d+s into a 200s recording \(chunk 1\/3\).*helper wedged/,
		);
	});

	it("stops at the next chunk boundary when cancelled", async () => {
		const mgr = new SttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		// Cancel lands while the first chunk is in flight — the loop must not go on
		// to the remaining ones, which is what left "regenerate" waiting on a run
		// nobody wanted any more.
		fakeWhisperServer.transcribe.mockImplementation(async () => {
			mgr.cancel();
			return {
				segments: [],
				wordSegments: [],
				detectedLanguage: "en",
				backend: "whispercpp-cpu" as const,
			};
		});
		const samples = new Float32Array(300 * 16000);
		expect(planChunks(samples, 16000).length).toBeGreaterThan(1);

		const error = await mgr.transcribe({ samples }).catch((e: unknown) => e);
		// `AbortError` by name, so the renderer treats it as "the user asked" and
		// drops the job silently instead of toasting an engine failure.
		expect((error as Error).name).toBe("AbortError");
		expect(fakeWhisperServer.transcribe).toHaveBeenCalledOnce();
	});

	it("shutdown() stops whisper-stt-server", async () => {
		const mgr = new SttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		await mgr.shutdown();
		expect(fakeWhisperServer.stop).toHaveBeenCalledOnce();
	});

	it("retries setup after a failed one instead of caching the rejection", async () => {
		// First run downloads a 253 MB model. Caching a rejected `prepare()` meant
		// one dropped connection failed every later transcription in the session —
		// including the retry the editor offers — until the app was restarted.
		const { ensureModels } = await import("./modelManager");
		const mocked = vi.mocked(ensureModels);
		mocked.mockClear();
		mocked.mockRejectedValueOnce(new Error("Failed to download: network unreachable"));
		const mgr = new SttManager();

		await expect(mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" })).rejects.toThrow(
			"network unreachable",
		);
		// The network came back: the next attempt must actually attempt.
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });

		expect(mocked).toHaveBeenCalledTimes(2);
		expect(fakeWhisperServer.start).toHaveBeenCalledOnce();
	});

	it("fans status out to every sink, and detaching one leaves the others", async () => {
		const mgr = new SttManager();
		const a = vi.fn<(e: SttStatusEvent) => void>();
		const b = vi.fn<(e: SttStatusEvent) => void>();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		const detachA = mgr.addStatusSink(a);
		mgr.addStatusSink(b);
		await mgr.transcribe({ samples: new Float32Array(16000), language: "en" });
		expect(a).toHaveBeenCalled();
		expect(b).toHaveBeenCalled();

		// The whole point of the Set. Two overlapping IPC requests each attach a
		// sink; when the first finishes and detaches, the second must keep getting
		// its own progress instead of falling silent for the rest of its run.
		detachA();
		a.mockClear();
		b.mockClear();
		await mgr.transcribe({ samples: new Float32Array(16000), language: "en" });
		expect(a).not.toHaveBeenCalled();
		expect(b).toHaveBeenCalled();
	});
});
