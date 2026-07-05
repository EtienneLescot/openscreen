import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetSttManagerForTests, SttManager } from "./index";
import type { SttStatusEvent, SttTranscribeResponse } from "./transcriptionContract";

// We swap the long-lived modules for fakes so the manager's `init()` and
// `transcribe()` paths can be exercised without spawning real processes.
const fakeCt2Server = {
	start: vi.fn(),
	status: {
		backend: "ctranslate2-cpu" as const,
		port: 9000,
		running: true,
		startedAtMs: 1,
		pid: 1,
		lastError: null,
	},
	transcribe: vi.fn(),
	stop: vi.fn(),
};

vi.mock("./ctranslate2Server", () => {
	class FakeCTranslate2ServerManager {
		start = fakeCt2Server.start;
		status = fakeCt2Server.status;
		transcribe = fakeCt2Server.transcribe;
		stop = fakeCt2Server.stop;
	}
	return { CTranslate2ServerManager: FakeCTranslate2ServerManager };
});

vi.mock("./modelManager", () => ({
	ensureModels: vi.fn(async () => undefined),
	modelPaths: (base: string) => ({
		whisper: `${base}/whisper-ct2`,
	}),
}));

vi.mock("./gpuDetector", () => ({
	detectGpuBackend: vi.fn(async () => ({ backend: "ctranslate2-cpu", reason: "fake → cpu" })),
	binaryNameForBackend: (b: string) => `ctranslate2-server-${b}`,
	candidateBinaryPaths: () => [] as string[],
	resolveBinaryPath: vi.fn(async () => ({
		path: "/fake/ctranslate2",
		backend: "ctranslate2-cpu" as const,
	})),
}));

describe("SttManager", () => {
	beforeEach(() => {
		fakeCt2Server.start.mockClear();
		fakeCt2Server.transcribe.mockClear();
		fakeCt2Server.stop.mockClear();
		fakeCt2Server.start.mockResolvedValue({ port: 9000, backend: "ctranslate2-cpu" });
		fakeCt2Server.transcribe.mockResolvedValue({
			segments: [{ text: "hello", startSec: 0, endSec: 0.5 }],
			wordSegments: [{ word: "hello", startSec: 0, endSec: 0.5 }],
			detectedLanguage: "en",
		});
		_resetSttManagerForTests();
	});

	afterEach(() => {
		_resetSttManagerForTests();
	});

	it("init() forwards model + transcribe phases to the sink", async () => {
		const sink = vi.fn<(e: SttStatusEvent) => void>();
		const mgr = new SttManager();
		// Skip the app.getPath call by providing an override at init time.
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
		expect(result.backend).toBe("ctranslate2-cpu");
		expect(result.wordSegments).toHaveLength(1);
		expect(fakeCt2Server.transcribe).toHaveBeenCalledOnce();
	});

	it("shutdown() stops ctranslate2-server", async () => {
		const mgr = new SttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		await mgr.shutdown();
		expect(fakeCt2Server.stop).toHaveBeenCalledOnce();
	});

	it("setStatusSink replaces the previous sink (last call wins)", () => {
		const mgr = new SttManager();
		const a = vi.fn();
		const b = vi.fn();
		mgr.setStatusSink(a);
		mgr.setStatusSink(b);
		expect(mgr.getStatusSink()).toBe(b);
	});
});
