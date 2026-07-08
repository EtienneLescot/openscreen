import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeSamplesAsWav } from "./wav";
import { WhisperServerManager } from "./whisperServer";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
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
			const fakeBinaryPath = path.join(
				dir,
				process.platform === "win32" ? "whisper-stt-server.exe" : "whisper-stt-server",
			);
			await fs.writeFile(fakeBinaryPath, "x");
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

	it("refuses to start when the model file is missing", async () => {
		const fs = await import("node:fs/promises");
		const dir = await mkdtemp(path.join(tmpdir(), "whisper-no-model-"));
		try {
			const fakeBinaryPath = path.join(
				dir,
				process.platform === "win32" ? "whisper-stt-server.exe" : "whisper-stt-server",
			);
			await fs.writeFile(fakeBinaryPath, "x");
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
