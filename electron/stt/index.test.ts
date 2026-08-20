import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import { planChunks } from "./chunking";
import { _resetSttManagerForTests, getSttManager, SttManager, shutdownStt } from "./index";
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
	shutdown: vi.fn(),
};

vi.mock("./whisperServer", () => {
	class FakeWhisperServerManager {
		start = fakeWhisperServer.start;
		status = fakeWhisperServer.status;
		transcribe = fakeWhisperServer.transcribe;
		stop = fakeWhisperServer.stop;
		shutdown = fakeWhisperServer.shutdown;
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
	let infoSpy: MockInstance<typeof console.info>;
	let warnSpy: MockInstance<typeof console.warn>;

	beforeEach(() => {
		fakeWhisperServer.start.mockClear();
		fakeWhisperServer.transcribe.mockClear();
		fakeWhisperServer.stop.mockClear();
		fakeWhisperServer.shutdown.mockClear();
		fakeWhisperServer.start.mockResolvedValue({ port: 9000, backend: "whispercpp-cpu" });
		fakeWhisperServer.transcribe.mockResolvedValue({
			segments: [{ text: "hello", startSec: 0, endSec: 0.5 }],
			wordSegments: [{ word: "hello", startSec: 0, endSec: 0.5 }],
			detectedLanguage: "en",
			backend: "whispercpp-cpu",
		});
		_resetSttManagerForTests();
		// The manager narrates every chunk (backend + timing) through `console.*`,
		// which is what puts those lines in the main-process ring buffer. Capture
		// them instead of letting a dozen lines per test onto the suite's output.
		infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	});

	afterEach(() => {
		_resetSttManagerForTests();
		infoSpy.mockRestore();
		warnSpy.mockRestore();
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

	// One per chunk of a 200s recording (90s + 90s + 20s), each with a DIFFERENT
	// ratio on purpose. Identical chunks would let a wrong implementation pass:
	// the arithmetic mean of these RTFs is 0.433, while the weighted figure the
	// run should report is 75/200 = 0.375. Only unequal chunks tell them apart.
	const CHUNK_TIMINGS = [
		{ elapsedSec: 45, audioSec: 90, rtf: 0.5 },
		{ elapsedSec: 18, audioSec: 90, rtf: 0.2 },
		{ elapsedSec: 12, audioSec: 20, rtf: 0.6 },
	];
	const TOTAL_ELAPSED = 75;
	const TOTAL_AUDIO = 200;

	/** The default fake answers without timing; this one measures every chunk. */
	function mockTimedChunks(): void {
		let call = 0;
		fakeWhisperServer.transcribe.mockImplementation(async () => ({
			segments: [],
			wordSegments: [],
			detectedLanguage: "en",
			backend: "whispercpp-cpu",
			timing: CHUNK_TIMINGS[Math.min(call++, CHUNK_TIMINGS.length - 1)],
		}));
	}

	it("sums per-chunk timing into one figure for the whole run", async () => {
		mockTimedChunks();
		const samples = new Float32Array(200 * 16000);
		const mgr = new SttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		const result = await mgr.transcribe({ samples, language: "en" });

		// Summed, not averaged: chunks differ in length, so the mean of the
		// per-chunk RTFs would not be the RTF of the run.
		expect(planChunks(samples, 16000)).toHaveLength(CHUNK_TIMINGS.length);
		expect(result.timing).toEqual({
			elapsedSec: TOTAL_ELAPSED,
			audioSec: TOTAL_AUDIO,
			rtf: TOTAL_ELAPSED / TOTAL_AUDIO,
		});
		// Nail the distinction down rather than trusting the numbers to differ.
		const mean = CHUNK_TIMINGS.reduce((sum, t) => sum + t.rtf, 0) / CHUNK_TIMINGS.length;
		expect(result.timing?.rtf).not.toBeCloseTo(mean, 3);
	});

	it("reports no run timing at all when one chunk went unmeasured", async () => {
		// A single chunk without a `timing` block is enough to spoil the totals:
		// they would describe 110s of audio for a 200s recording, under a field
		// that says it covers every chunk. The two measured chunks carry DIFFERENT
		// ratios so the running figure asserted below cannot be constant by luck.
		const MEASURED = [
			{ elapsedSec: 45, audioSec: 90, rtf: 0.5 },
			undefined,
			{ elapsedSec: 5, audioSec: 20, rtf: 0.25 },
		];
		let call = 0;
		fakeWhisperServer.transcribe.mockImplementation(async () => ({
			segments: [],
			wordSegments: [],
			detectedLanguage: "en",
			backend: "whispercpp-cpu",
			timing: MEASURED[call++],
		}));
		const sink = vi.fn<(e: SttStatusEvent) => void>();
		const mgr = new SttManager();
		await mgr.init({ statusSink: sink, modelsBaseDir: "/tmp/fake-stt-models" });
		sink.mockClear();
		const result = await mgr.transcribe({
			samples: new Float32Array(200 * 16000),
			language: "en",
		});

		expect(result.timing).toBeUndefined();
		// And it says which, rather than claiming nothing was measured at all.
		expect(
			infoSpy.mock.calls.some(([line]) =>
				String(line).includes("timing incomplete (1/3 chunks unmeasured)"),
			),
		).toBe(true);
		// The status `rtf` is held to a different rule than the response total, and
		// this is where that difference is visible: being a RATIO, it survives the
		// gap instead of blanking — it holds at the last known value across the
		// unmeasured chunk, then goes on aggregating. Killing the live speed
		// readout for the rest of a run over one bad chunk would be the opposite of
		// what the field exists for.
		const running = sink.mock.calls
			.map(([event]) => event)
			.filter((event) => event.backend !== undefined)
			.map((event) => event.rtf);
		expect(running).toEqual([45 / 90, 45 / 90, 50 / 110]);
	});

	it("logs the backend and the timing of every chunk", async () => {
		mockTimedChunks();
		const samples = new Float32Array(200 * 16000);
		const mgr = new SttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		await mgr.transcribe({ samples, language: "en" });

		const chunkLines = infoSpy.mock.calls
			.map(([line]) => String(line))
			.filter((line) => line.startsWith("[stt] chunk "));
		expect(chunkLines).toHaveLength(planChunks(samples, 16000).length);
		// Both conventions on the line, so it can be read against the POC report
		// without arithmetic.
		expect(chunkLines[0]).toContain("whispercpp-cpu");
		expect(chunkLines[0]).toContain("90.0s audio in 45.0s (0.50 rtf, 2.0x real-time)");
		// Each line carries ITS OWN chunk's cost, not the running total.
		expect(chunkLines[1]).toContain("90.0s audio in 18.0s (0.20 rtf, 5.0x real-time)");
	});

	it("says so when the helper reports no timing at all", async () => {
		// The default fake stands in for a staged binary older than the field.
		const mgr = new SttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		const result = await mgr.transcribe({ samples: new Float32Array(16000) });
		expect(result.timing).toBeUndefined();
		expect(infoSpy.mock.calls.some(([line]) => String(line).includes("no timing reported"))).toBe(
			true,
		);
	});

	it("puts the backend and a running rtf on every chunk's status event", async () => {
		mockTimedChunks();
		const samples = new Float32Array(200 * 16000);
		const sink = vi.fn<(e: SttStatusEvent) => void>();
		const mgr = new SttManager();
		await mgr.init({ statusSink: sink, modelsBaseDir: "/tmp/fake-stt-models" });
		sink.mockClear();
		await mgr.transcribe({ samples, language: "en" });

		// The response alone is too late to be a signal: it arrives once the whole
		// recording is done, and the point is to explain the wait while it happens.
		const reported = sink.mock.calls
			.map(([event]) => event)
			.filter((event) => event.backend !== undefined);
		expect(reported).toHaveLength(CHUNK_TIMINGS.length);
		for (const event of reported) expect(event.backend).toBe("whispercpp-cpu");
		// Cumulative and weighted at every step — 45/90, then 63/180, then 75/200 —
		// which is what makes the figure settle instead of bouncing per chunk.
		expect(reported.map((e) => e.rtf)).toEqual([45 / 90, 63 / 180, 75 / 200]);
	});

	it("warns once per run — not once per chunk — that it landed on CPU", async () => {
		mockTimedChunks();
		const mgr = new SttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		await mgr.transcribe({ samples: new Float32Array(200 * 16000), language: "en" });

		const cpuWarnings = warnSpy.mock.calls
			.map(([line]) => String(line))
			.filter((line) => line.includes("running on CPU"));
		expect(cpuWarnings).toHaveLength(1);
	});

	it("stays quiet about the backend when a GPU one is bound", async () => {
		fakeWhisperServer.transcribe.mockResolvedValue({
			segments: [],
			wordSegments: [],
			detectedLanguage: "en",
			backend: "whispercpp-vulkan",
			timing: { elapsedSec: 20, audioSec: 90, rtf: 20 / 90 },
		});
		const mgr = new SttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		const result = await mgr.transcribe({ samples: new Float32Array(200 * 16000) });

		expect(result.backend).toBe("whispercpp-vulkan");
		expect(warnSpy.mock.calls.some(([line]) => String(line).includes("running on CPU"))).toBe(
			false,
		);
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
		expect(fakeWhisperServer.shutdown).toHaveBeenCalledOnce();
	});

	it("shutdownStt() stops and releases the singleton exactly once", async () => {
		const mgr = getSttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });

		await shutdownStt();
		await shutdownStt();

		expect(fakeWhisperServer.shutdown).toHaveBeenCalledOnce();
		expect(() => getSttManager()).toThrowError(/cancel/i);
	});

	it("does not respawn the helper when shutdown interrupts a failed chunk", async () => {
		const mgr = getSttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		fakeWhisperServer.transcribe.mockImplementationOnce(async () => {
			await shutdownStt();
			throw new Error("connection closed during quit");
		});

		const error = await mgr
			.transcribe({ samples: new Float32Array(16000), language: "en" })
			.catch((value: unknown) => value);

		expect((error as Error).name).toBe("AbortError");
		expect(fakeWhisperServer.start).toHaveBeenCalledOnce();
		expect(fakeWhisperServer.shutdown).toHaveBeenCalledOnce();
	});

	it("cancels when shutdown starts as setup rejects", async () => {
		const mgr = new SttManager();
		fakeWhisperServer.start.mockImplementationOnce(async () => {
			await mgr.shutdown();
			throw new Error("connection closed during startup");
		});

		const error = await mgr
			.init({ modelsBaseDir: "/tmp/fake-stt-models" })
			.catch((value: unknown) => value);

		expect((error as Error).name).toBe("AbortError");
		expect(fakeWhisperServer.shutdown).toHaveBeenCalledOnce();
	});

	it("cancels when shutdown starts as the final chunk resolves", async () => {
		const mgr = getSttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		fakeWhisperServer.transcribe.mockImplementationOnce(async () => {
			await shutdownStt();
			return {
				segments: [{ text: "late", startSec: 0, endSec: 0.5 }],
				wordSegments: [{ word: "late", startSec: 0, endSec: 0.5 }],
				detectedLanguage: "en",
				backend: "whispercpp-cpu" as const,
			};
		});

		const error = await mgr
			.transcribe({ samples: new Float32Array(16_000), language: "en" })
			.catch((value: unknown) => value);

		expect((error as Error).name).toBe("AbortError");
		expect(fakeWhisperServer.transcribe).toHaveBeenCalledOnce();
	});

	it("retries setup after a failed one instead of caching the rejection", async () => {
		// First run downloads a 264 MB model. Caching a rejected `prepare()` meant
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
