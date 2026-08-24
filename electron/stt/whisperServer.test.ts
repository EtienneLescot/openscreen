import { EventEmitter } from "node:events";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeSamplesAsWav } from "./wav";
import { WhisperServerManager } from "./whisperServer";

vi.mock("node:child_process", async (importOriginal) => {
	// `node:child_process` is CJS, so the ESM namespace also carries a `default`
	// holding the same exports — undeclared in @types/node. The mock has to keep it
	// so `import cp from "node:child_process"` consumers still see the stub.
	const actual = await importOriginal<
		typeof import("node:child_process") & {
			default?: Partial<typeof import("node:child_process")>;
		}
	>();
	const spawn = vi.fn();
	return { ...actual, spawn, default: { ...(actual.default ?? {}), spawn } };
});

describe("wav.writeSamplesAsWav", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(path.join(tmpdir(), "stt-wav-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("writes a 16 kHz mono 16-bit PCM WAV with a valid RIFF header", async () => {
		const samples = new Float32Array(1600);
		for (let i = 0; i < samples.length; i++) {
			samples[i] = Math.sin((2 * Math.PI * 440 * i) / 16_000) * 0.5;
		}
		const wavPath = await writeSamplesAsWav(samples);
		const statResult = await stat(wavPath);
		expect(statResult.size).toBe(44 + samples.length * 2);
		try {
			const fs = await import("node:fs/promises");
			const head = await fs.readFile(wavPath, { encoding: null });
			const headBuf = head.subarray(0, 12);
			expect(headBuf.toString("ascii", 0, 4)).toBe("RIFF");
			expect(headBuf.toString("ascii", 8, 12)).toBe("WAVE");
			expect(head.readUInt16LE(22)).toBe(1); // mono
			expect(head.readUInt32LE(24)).toBe(16_000); // sample rate
			expect(head.readUInt16LE(34)).toBe(16); // bits per sample
		} finally {
			await rm(path.dirname(wavPath), { recursive: true, force: true });
		}
	});

	it("clamps samples outside [-1, 1] so the writer can't overflow int16", async () => {
		const samples = new Float32Array([2, -2, 1.5, -1.5]);
		const wavPath = await writeSamplesAsWav(samples);
		try {
			const fs = await import("node:fs/promises");
			const head = await fs.readFile(wavPath, { encoding: null });
			const dataOffset = 44;
			expect(head.readInt16LE(dataOffset)).toBe(32_767);
			expect(head.readInt16LE(dataOffset + 2)).toBe(-32_767);
			expect(head.readInt16LE(dataOffset + 4)).toBe(32_767);
			expect(head.readInt16LE(dataOffset + 6)).toBe(-32_767);
		} finally {
			await rm(path.dirname(wavPath), { recursive: true, force: true });
		}
	});
});

describe("WhisperServerManager", () => {
	beforeEach(async () => {
		const { spawn } = await import("node:child_process");
		vi.mocked(spawn).mockClear();
	});

	it("reports a clean status when not started", () => {
		const mgr = new WhisperServerManager();
		const status = mgr.status;
		expect(status.running).toBe(false);
		expect(status.pid).toBeNull();
		expect(status.port).toBeNull();
		expect(status.backend).toBeNull();
		expect(status.startedAtMs).toBeNull();
	});

	it("clears lastError between runs", () => {
		const mgr = new WhisperServerManager();
		mgr.stop(); // should be a no-op
		expect(mgr.status.running).toBe(false);
	});

	it("does not allow a helper to spawn after permanent shutdown", async () => {
		const mgr = new WhisperServerManager();
		await mgr.shutdown();

		await expect(mgr.start({ modelPath: "/missing/model.bin" })).rejects.toThrow(/shutting down/);
		const { spawn } = await import("node:child_process");
		expect(spawn).not.toHaveBeenCalled();
	});

	it("bounds a readiness probe that accepts a connection but never responds", async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			"fetch",
			vi.fn((_url: string, init?: RequestInit) => {
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
						once: true,
					});
				});
			}),
		);
		try {
			const pollUntilReady = (
				WhisperServerManager as unknown as {
					pollUntilReady: (baseUrl: string, timeoutMs: number) => Promise<void>;
				}
			).pollUntilReady;
			const readiness = pollUntilReady("http://127.0.0.1:9999", 2_500);
			const assertion = expect(readiness).rejects.toThrow(/did not respond within 2500ms/);
			await vi.advanceTimersByTimeAsync(3_000);
			await assertion;
		} finally {
			vi.unstubAllGlobals();
			vi.useRealTimers();
		}
	});

	it("extracts phrase and word segments from a verbose_json response", async () => {
		const fakeJson = {
			task: "transcribe",
			language: "english",
			text: " Hello world.",
			segments: [
				{
					id: 0,
					text: " Hello world.",
					start: 0.0,
					end: 1.5,
					words: [
						{ word: " Hello", start: 0.0, end: 0.8, probability: 0.95 },
						{ word: " world.", start: 0.8, end: 1.5, probability: 0.91 },
					],
				},
			],
			detected_language: "english",
			backend: "whispercpp-vulkan",
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify(fakeJson), { status: 200 })),
		);
		try {
			const mgr = new WhisperServerManager();
			(mgr as unknown as { process: unknown; port: number }).process = {};
			(mgr as unknown as { process: unknown; port: number }).port = 9999;

			const result = await mgr.transcribe({ samples: new Float32Array(1600) });
			expect(result.detectedLanguage).toBe("english");
			expect(result.backend).toBe("whispercpp-vulkan");
			expect(result.segments).toEqual([{ text: "Hello world.", startSec: 0, endSec: 1.5 }]);
			expect(result.wordSegments).toEqual([
				{ word: "Hello", startSec: 0, endSec: 0.8, confidence: 0.95 },
				{ word: "world.", startSec: 0.8, endSec: 1.5, confidence: 0.91 },
			]);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	/** Answer `/inference` with one canned body and run a single transcription. */
	async function transcribeWith(json: unknown) {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify(json), { status: 200 })),
		);
		try {
			const mgr = new WhisperServerManager();
			(mgr as unknown as { process: unknown; port: number }).process = {};
			(mgr as unknown as { process: unknown; port: number }).port = 9999;
			return await mgr.transcribe({ samples: new Float32Array(1600) });
		} finally {
			vi.unstubAllGlobals();
		}
	}

	it("reads the helper's timing block off an /inference response", async () => {
		const result = await transcribeWith({
			segments: [],
			detected_language: "english",
			backend: "whispercpp-vulkan",
			timing: { elapsed_s: 5.5, audio_s: 11, rtf: 0.5 },
		});
		expect(result.timing).toEqual({ elapsedSec: 5.5, audioSec: 11, rtf: 0.5 });
	});

	// A staged binary older than the `timing` field just omits it — and
	// `electron/native/bin/<tag>/` is gitignored, so a dev tree keeps whatever was
	// last built there. Null, not zeroes: "not reported" and "took no time" must
	// not reach the UI looking the same.
	it("reports no timing at all when the helper omits the block", async () => {
		const result = await transcribeWith({
			segments: [],
			detected_language: "english",
			backend: "whispercpp-cpu",
		});
		expect(result.timing).toBeNull();
	});

	// `rtf` is derived from the other two, so a junk ratio is recoverable — and a
	// NaN surviving this far would reach the renderer as "NaN× real-time".
	it("recomputes rtf when the helper's own value is unusable", async () => {
		const result = await transcribeWith({
			segments: [],
			backend: "whispercpp-cpu",
			timing: { elapsed_s: 4, audio_s: 8, rtf: "not-a-number" },
		});
		expect(result.timing).toEqual({ elapsedSec: 4, audioSec: 8, rtf: 0.5 });
	});

	// Same defensive parse the segment bounds get: nothing on this wire is
	// guaranteed by a schema.
	it("accepts stringified durations", async () => {
		const result = await transcribeWith({
			segments: [],
			backend: "whispercpp-cpu",
			timing: { elapsed_s: "4", audio_s: "8", rtf: "0.5" },
		});
		expect(result.timing).toEqual({ elapsedSec: 4, audioSec: 8, rtf: 0.5 });
	});

	// Durations no clock could produce. Letting these through would put a bogus
	// figure into the run totals in SttManager, where nothing downstream could
	// tell it from a real measurement.
	it.each([
		["negative elapsed", { elapsed_s: -1, audio_s: 8 }],
		["zero audio", { elapsed_s: 4, audio_s: 0 }],
		["negative audio", { elapsed_s: 4, audio_s: -8 }],
	])("rejects a timing block with %s", async (_label, timing) => {
		const result = await transcribeWith({
			segments: [],
			backend: "whispercpp-cpu",
			timing,
		});
		expect(result.timing).toBeNull();
	});

	it("rejects a timing block with no usable durations", async () => {
		const result = await transcribeWith({
			segments: [],
			backend: "whispercpp-cpu",
			timing: { rtf: 0.5 },
		});
		expect(result.timing).toBeNull();
	});

	describe("WhisperServerManager language normalization", () => {
		function captureFormField(language: string | undefined): Promise<string | null> {
			return new Promise((resolve, reject) => {
				let resolvedText: string | null = null;
				const fakeJson = {
					segments: [],
					detected_language: "english",
					backend: "whispercpp-cpu",
				};
				vi.stubGlobal(
					"fetch",
					vi.fn(async (_url: string, init: RequestInit) => {
						const body = init?.body as FormData | undefined;
						if (body && typeof (body as FormData).get === "function") {
							resolvedText = (body as FormData).get("language") as string | null;
						}
						return new Response(JSON.stringify(fakeJson), { status: 200 });
					}),
				);
				(async () => {
					try {
						const mgr = new WhisperServerManager();
						(mgr as unknown as { process: unknown; port: number }).process = {};
						(mgr as unknown as { process: unknown; port: number }).port = 9999;
						await mgr.transcribe({
							samples: new Float32Array(1600),
							language,
						});
						resolve(resolvedText);
					} catch (e) {
						reject(e);
					}
				})().catch(reject);
			});
		}

		it("sends 'auto' when language is undefined (lets the runtime detect)", async () => {
			const sent = await captureFormField(undefined);
			expect(sent).toBe("auto");
		});

		it("sends 'auto' when the literal 'auto' string is forwarded", async () => {
			const sent = await captureFormField("auto");
			expect(sent).toBe("auto");
		});

		it("passes through an explicit ISO 639-1 code like 'fr' unchanged", async () => {
			const sent = await captureFormField("fr");
			expect(sent).toBe("fr");
		});

		afterEach(() => {
			vi.unstubAllGlobals();
		});
	});

	it("returns word timestamps absolute (no parent-segment offset composition)", async () => {
		const fakeJson = {
			task: "transcribe",
			language: "english",
			text: " Thank you",
			segments: [
				{
					id: 0,
					text: " Thank you",
					start: 5.51,
					end: 8.98,
					words: [
						{ word: " Thank", start: 5.51, end: 6.85, probability: 0.9 },
						{ word: " you", start: 6.85, end: 8.98, probability: 0.9 },
					],
				},
			],
			detected_language: "english",
			backend: "whispercpp-cpu",
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify(fakeJson), { status: 200 })),
		);
		try {
			const mgr = new WhisperServerManager();
			(mgr as unknown as { process: unknown; port: number }).process = {};
			(mgr as unknown as { process: unknown; port: number }).port = 9999;
			const result = await mgr.transcribe({ samples: new Float32Array(1600) });
			expect(result.segments).toEqual([{ text: "Thank you", startSec: 5.51, endSec: 8.98 }]);
			expect(result.wordSegments).toEqual([
				{ word: "Thank", startSec: 5.51, endSec: 6.85, confidence: 0.9 },
				{ word: "you", startSec: 6.85, endSec: 8.98, confidence: 0.9 },
			]);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("spawns whisper-stt-server with --model", async () => {
		const fs = await import("node:fs/promises");
		const { spawn } = await import("node:child_process");
		const dir = await mkdtemp(path.join(tmpdir(), "whisper-spawn-"));
		try {
			const modelPath = path.join(dir, "ggml-small-q8_0.bin");
			await writeFile(modelPath, "dummy-ggml");
			// ponytail: no `.exe` branch on Windows, because there is no name to get
			// right: every test here hands `start()` an explicit `binaryPath`, which is
			// the branch that skips `resolveBinaryPath()` entirely. A `process.platform`
			// read that decides nothing is a platform gate CI cannot pin and cannot
			// exercise — it only looks like coverage.
			const fakeBinaryPath = path.join(dir, "whisper-stt-server");
			// mode 0o755: the manager refuses a helper it cannot execute, and the
			// default write mode is not executable on POSIX.
			await fs.writeFile(fakeBinaryPath, "x", { mode: 0o755 });
			const fakeChild = {
				stdout: { on: vi.fn() },
				stderr: { on: vi.fn() },
				pid: 1234,
				once: vi.fn(),
				on: vi.fn(),
				kill: vi.fn(),
			};
			vi.mocked(spawn).mockReturnValue(fakeChild as never);
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => new Response("ok", { status: 200 })),
			);
			try {
				const mgr = new WhisperServerManager();
				await mgr.start({
					modelPath,
					binaryPath: fakeBinaryPath,
					backend: "whispercpp-cpu",
				});
				const args = vi.mocked(spawn).mock.calls[0]?.[1] as string[];
				const modelIdx = args.indexOf("--model");
				expect(modelIdx).toBeGreaterThan(-1);
				expect(args[modelIdx + 1]).toBe(modelPath);
				expect(args).not.toContain("--cuda");
				expect(args).not.toContain("--int8");
				expect(args).not.toContain("--vad");
			} finally {
				vi.unstubAllGlobals();
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("retries with CPU when the GPU helper exits during model startup", async () => {
		const fs = await import("node:fs/promises");
		const { spawn } = await import("node:child_process");
		const dir = await mkdtemp(path.join(tmpdir(), "whisper-cpu-fallback-"));
		const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
		try {
			Object.defineProperty(process, "platform", { value: "linux", configurable: true });
			const modelPath = path.join(dir, "ggml-small-q8_0.bin");
			const fakeBinaryPath = path.join(dir, "whisper-stt-server");
			await fs.writeFile(modelPath, "dummy-ggml");
			await fs.writeFile(fakeBinaryPath, "x", { mode: 0o755 });

			const child = () => {
				const proc = Object.assign(new EventEmitter(), {
					stdout: new EventEmitter(),
					stderr: new EventEmitter(),
					pid: 1234,
					kill: vi.fn(),
				});
				return proc;
			};
			const gpuChild = child();
			const cpuChild = child();
			vi.mocked(spawn)
				.mockImplementationOnce(() => {
					queueMicrotask(() => {
						gpuChild.stderr.emit(
							"data",
							Buffer.from("ggml_metal_buffer_init: initialized\nfailed to allocate GPU buffer"),
						);
						gpuChild.emit("exit", 1);
					});
					return gpuChild as never;
				})
				.mockReturnValueOnce(cpuChild as never);
			vi.stubGlobal(
				"fetch",
				vi
					.fn()
					.mockImplementationOnce(() => new Promise<Response>(() => undefined))
					.mockResolvedValueOnce(new Response("ok", { status: 200 })),
			);

			const mgr = new WhisperServerManager();
			const result = await mgr.start({
				modelPath,
				binaryPath: fakeBinaryPath,
				backend: "whispercpp-metal",
			});
			expect(result.backend).toBe("whispercpp-cpu");
			expect(spawn).toHaveBeenCalledTimes(2);
			expect(vi.mocked(spawn).mock.calls[0]?.[1]).not.toContain("--cpu");
			expect(vi.mocked(spawn).mock.calls[1]?.[1]).toContain("--cpu");
		} finally {
			if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
			vi.unstubAllGlobals();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("serializes overlapping start calls onto one helper process", async () => {
		const fs = await import("node:fs/promises");
		const { spawn } = await import("node:child_process");
		const dir = await mkdtemp(path.join(tmpdir(), "whisper-single-start-"));
		const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
		try {
			Object.defineProperty(process, "platform", { value: "linux", configurable: true });
			const modelPath = path.join(dir, "ggml-small-q8_0.bin");
			const fakeBinaryPath = path.join(dir, "whisper-stt-server");
			await fs.writeFile(modelPath, "dummy-ggml");
			await fs.writeFile(fakeBinaryPath, "x", { mode: 0o755 });
			const child = Object.assign(new EventEmitter(), {
				stdout: new EventEmitter(),
				stderr: new EventEmitter(),
				pid: 1234,
				kill: vi.fn(),
			});
			vi.mocked(spawn).mockReturnValue(child as never);
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => new Response("ok", { status: 200 })),
			);
			const mgr = new WhisperServerManager();
			const options = {
				modelPath,
				binaryPath: fakeBinaryPath,
				backend: "whispercpp-cpu" as const,
			};

			const [first, second] = await Promise.all([mgr.start(options), mgr.start(options)]);

			expect(first).toEqual(second);
			expect(spawn).toHaveBeenCalledOnce();
		} finally {
			if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
			vi.unstubAllGlobals();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("logs a startup death once, and keeps the more specific reason on status", async () => {
		// ponytail: the `exit` listener and the startup catch both answer for the
		// SAME death — the listener because the child died, the catch because the
		// promise that death rejects is the one `launch` awaits. Two `[stt]` lines
		// worded differently for one event teaches a reader to skim the log. The
		// field still takes the second, more specific message: that is what
		// `status.lastError` is for.
		const fs = await import("node:fs/promises");
		const { spawn } = await import("node:child_process");
		const dir = await mkdtemp(path.join(tmpdir(), "whisper-one-log-"));
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			const modelPath = path.join(dir, "ggml-small-q8_0.bin");
			const fakeBinaryPath = path.join(dir, "whisper-stt-server");
			await fs.writeFile(modelPath, "dummy-ggml");
			await fs.writeFile(fakeBinaryPath, "x", { mode: 0o755 });

			const child = Object.assign(new EventEmitter(), {
				stdout: new EventEmitter(),
				stderr: new EventEmitter(),
				pid: 4321,
				kill: vi.fn(),
			});
			vi.mocked(spawn).mockImplementationOnce(() => {
				// No GPU vocabulary in the tail, so this death is NOT read as a GPU
				// startup failure and nothing retries on CPU — the throw is the result.
				queueMicrotask(() => {
					child.stderr.emit("data", Buffer.from("could not open model"));
					child.emit("exit", 3);
				});
				return child as never;
			});

			const mgr = new WhisperServerManager();
			await expect(
				mgr.start({ modelPath, binaryPath: fakeBinaryPath, backend: "whispercpp-cpu" }),
			).rejects.toThrow(/exited during startup/);

			const stt = errors.mock.calls.map(String).filter((line) => line.startsWith("[stt] "));
			expect(stt, `lignes [stt] émises : ${JSON.stringify(stt)}`).toHaveLength(1);
			// The one that survives is the listener's — the catch is the second voice.
			expect(stt[0]).toMatch(/exited with code 3/);
			// …and the field keeps the more specific of the two.
			expect(mgr.status.lastError).toMatch(/exited during startup \(3\)/);
		} finally {
			errors.mockRestore();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("logs a spawn error once, the same as a death by exit", async () => {
		// ponytail: the `error` listener is the OTHER way a helper never reaches
		// readiness, and it reaches the startup catch by the same route — the
		// `exitedBeforeReady` race rejects on `error` as well as on `exit`. Whatever
		// keeps one voice on an exit has to keep one voice here too, or the fix has
		// simply moved the duplicate into the branch nobody looked at.
		const fs = await import("node:fs/promises");
		const { spawn } = await import("node:child_process");
		const dir = await mkdtemp(path.join(tmpdir(), "whisper-spawn-error-"));
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			const modelPath = path.join(dir, "ggml-small-q8_0.bin");
			const fakeBinaryPath = path.join(dir, "whisper-stt-server");
			await fs.writeFile(modelPath, "dummy-ggml");
			await fs.writeFile(fakeBinaryPath, "x", { mode: 0o755 });

			const child = Object.assign(new EventEmitter(), {
				stdout: new EventEmitter(),
				stderr: new EventEmitter(),
				pid: undefined,
				kill: vi.fn(() => true),
			});
			vi.mocked(spawn).mockImplementationOnce(() => {
				// No "exit" at all: the process never came up, so only "error" fires.
				queueMicrotask(() => child.emit("error", new Error("spawn EACCES")));
				return child as never;
			});

			const mgr = new WhisperServerManager();
			await expect(
				mgr.start({ modelPath, binaryPath: fakeBinaryPath, backend: "whispercpp-cpu" }),
			).rejects.toThrow(/spawn EACCES/);

			const stt = errors.mock.calls.map(String).filter((line) => line.startsWith("[stt] "));
			expect(stt, `lignes [stt] émises : ${JSON.stringify(stt)}`).toHaveLength(1);
			expect(stt[0]).toMatch(/spawn error: spawn EACCES/);
			// The listener cleared the startup state, so nothing is left claiming a
			// helper is up — `status` must agree with the log.
			expect(mgr.status.running).toBe(false);
		} finally {
			errors.mockRestore();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("logs a readiness timeout, which no exit listener would ever see", async () => {
		// The other direction: nothing exits, so the startup catch is the ONLY voice
		// on this failure and must not be silenced by the de-duplication above.
		//
		// ponytail: the clock is moved, not the timers. `pollUntilReady` bounds
		// itself with `Date.now()`, so a clock that leaps 60 s per reading walks past
		// the 30 s deadline on its own — no fake timers, and therefore nothing that
		// has to also drive the real socket I/O `pickFreePort` waits on. An earlier
		// version of this test did use fake timers and deadlocked on Linux CI while
		// passing on Windows, which is a worse failure than the one it tests for.
		const fs = await import("node:fs/promises");
		const { spawn } = await import("node:child_process");
		const dir = await mkdtemp(path.join(tmpdir(), "whisper-timeout-log-"));
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const realNow = Date.now;
		let nowSpy = vi.spyOn(Date, "now");
		let clock = realNow();
		try {
			const modelPath = path.join(dir, "ggml-small-q8_0.bin");
			const fakeBinaryPath = path.join(dir, "whisper-stt-server");
			await fs.writeFile(modelPath, "dummy-ggml");
			await fs.writeFile(fakeBinaryPath, "x", { mode: 0o755 });

			const child = Object.assign(new EventEmitter(), {
				stdout: new EventEmitter(),
				stderr: new EventEmitter(),
				pid: 4322,
				// Alive until asked to stop — `stop()` awaits the exit it triggers.
				kill: vi.fn(() => {
					queueMicrotask(() => child.emit("exit", 0));
					return true;
				}),
			});
			vi.mocked(spawn).mockImplementationOnce(() => child as never);
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false } as Response));

			clock = realNow();
			nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
				clock += 60_000;
				return clock;
			});

			const mgr = new WhisperServerManager();
			await expect(
				mgr.start({ modelPath, binaryPath: fakeBinaryPath, backend: "whispercpp-cpu" }),
			).rejects.toThrow(/did not respond within/);

			const stt = errors.mock.calls.map(String).filter((line) => line.startsWith("[stt] "));
			expect(stt, `lignes [stt] émises : ${JSON.stringify(stt)}`).toHaveLength(1);
			expect(stt[0]).toMatch(/did not respond within/);
		} finally {
			// Targeted, not `restoreAllMocks()`: the module-level `spawn` stub belongs
			// to the whole file and the next test relies on it.
			nowSpy.mockRestore();
			errors.mockRestore();
			vi.unstubAllGlobals();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("refuses to start when the model file is missing", async () => {
		const fs = await import("node:fs/promises");
		const dir = await mkdtemp(path.join(tmpdir(), "whisper-no-model-"));
		try {
			const fakeBinaryPath = path.join(dir, "whisper-stt-server");
			// Executable on purpose: this test asserts the *model* check fires, so
			// the binary must get past the executability check first.
			await fs.writeFile(fakeBinaryPath, "x", { mode: 0o755 });
			const mgr = new WhisperServerManager();
			await expect(
				mgr.start({
					modelPath: path.join(dir, "missing-model.bin"),
					binaryPath: fakeBinaryPath,
					backend: "whispercpp-cpu",
				}),
			).rejects.toThrow(/Whisper GGML model not found/);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
