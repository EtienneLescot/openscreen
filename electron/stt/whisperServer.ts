import { type ChildProcessByStdio, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, constants as fsConstants, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";

import { resolveBinaryPath } from "./gpuDetector";
import type { SttBackend, SttPhraseSegment, SttWordSegment } from "./transcriptionContract";
import { cleanupWav, writeSamplesAsWav } from "./wav";

/** whisper.cpp helper is stdio-shaped: stdin ignored, stdout/stderr captured. */
type WhisperChild = ChildProcessByStdio<null, Readable, Readable>;

/**
 * Owns the long-lived `whisper-stt-server` process used to recognize speech.
 *
 * Replaces the previous native STT helper with the same shape: spawn → poll
 * `/` for 200 → POST `/inference` for each transcription. The wire JSON
 * contract (`electron/stt/transcriptionContract.ts`) is **preserved**, so
 * `SttManager.transcribe()` keeps returning `SttTranscribeResponse` unchanged
 * and the renderer doesn't move.
 *
 * Word timestamps come from whisper.cpp's native DTW token timestamps
 * (`t_dtw`, SMALL aheads preset, `flash_attn = false` so DTW is actually
 * computed). The helper returns them already absolute, so no segment-offset
 * arithmetic is required.
 *
 * Concurrency: simple single-flight queue — the helper handles one inference
 * at a time anyway; serializing avoids two transcriptions stepping on each
 * other's uploads.
 */

export interface WhisperServerStartOptions {
	/** Absolute path to the GGML model file (e.g. ggml-small-q8_0.bin). */
	modelPath: string;
	/** Externally-resolved binary path (skips gpuDetector on startup); null = auto. */
	binaryPath?: string | null;
	/** Externally-resolved backend (logs only); null = auto. */
	backend?: SttBackend | null;
}

export interface WhisperServerStatus {
	running: boolean;
	pid: number | null;
	port: number | null;
	backend: SttBackend | null;
	startedAtMs: number | null;
	lastError: string | null;
}

/** Per-word entry inside a whisper-stt-server `/inference` JSON segment. */
interface WhisperJsonWord {
	word?: string;
	start?: number;
	end?: number;
	probability?: number;
}

/**
 * Phrase segment as emitted by whisper-stt-server's `/inference` JSON response.
 * `start`/`end` are the per-segment bounds from whisper.cpp's greedy decoding.
 */
interface WhisperJsonSegment {
	text?: string;
	start?: number;
	end?: number;
	words?: WhisperJsonWord[];
}

interface WhisperJsonResponse {
	segments?: WhisperJsonSegment[];
	language?: string;
	detected_language?: string;
	backend?: string;
}

export class WhisperServerManager {
	private process: WhisperChild | null = null;
	private port: number | null = null;
	private backend: SttBackend | null = null;
	private lastError: string | null = null;
	private startedAtMs: number | null = null;
	private inFlight: Promise<unknown> = Promise.resolve();

	/** Buffered stderr from the helper; surfaced on shutdown + poll failures. */
	private stderrTail = "";
	private readonly stderrTailMax = 64 * 1024;

	/** Allocate a free TCP port on the loopback interface; resolves to the picked port. */
	private static async pickFreePort(): Promise<number> {
		return new Promise((resolve, reject) => {
			const server = createServer();
			server.unref();
			server.on("error", reject);
			server.listen(0, "127.0.0.1", () => {
				const addr = server.address();
				if (!addr || typeof addr === "string") {
					server.close();
					reject(new Error("Could not allocate port"));
					return;
				}
				const port = addr.port;
				server.close(() => resolve(port));
			});
		});
	}

	/** Check the server's HTTP root for a 200; resolves once responsive. */
	private static async pollUntilReady(baseUrl: string, timeoutMs = 30_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			try {
				const res = await fetch(baseUrl, { method: "GET" });
				if (res.ok) return;
			} catch {
				// not up yet
			}
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		throw new Error(`whisper-stt-server at ${baseUrl} did not respond within ${timeoutMs}ms`);
	}

	private recordError(message: string): void {
		this.lastError = message;
	}

	/** True when a process is alive and a model is loaded. */
	get status(): WhisperServerStatus {
		return {
			running: this.process !== null && this.port !== null,
			pid: this.process?.pid ?? null,
			port: this.port,
			backend: this.backend,
			startedAtMs: this.startedAtMs,
			lastError: this.lastError,
		};
	}

	/**
	 * Spawn the helper if not running and return once `/` returns 200. Idempotent —
	 * if a server is already up we just return its port so the caller never pays
	 * the cold-start cost twice.
	 */
	async start(options: WhisperServerStartOptions): Promise<{ port: number; backend: SttBackend }> {
		if (this.process && this.port) {
			return { port: this.port, backend: this.backend ?? options.backend ?? "whispercpp-cpu" };
		}

		const resolved = options.binaryPath
			? { path: options.binaryPath, backend: options.backend ?? "whispercpp-cpu" }
			: await resolveBinaryPath();
		if (!resolved.path) {
			const message =
				"whisper-stt-server binary not found; build it via scripts/build-whisper-stt.sh";
			this.recordError(message);
			throw new Error(message);
		}
		try {
			if (process.platform !== "win32") {
				await access(resolved.path, fsConstants.X_OK);
			} else if (!existsSync(resolved.path)) {
				throw new Error("not found");
			}
		} catch {
			const message = `whisper-stt-server binary at ${resolved.path} is not executable`;
			this.recordError(message);
			throw new Error(message);
		}
		if (!existsSync(options.modelPath)) {
			throw new Error(`Whisper GGML model not found at ${options.modelPath}`);
		}

		const port = await WhisperServerManager.pickFreePort();
		const child = spawn(
			resolved.path,
			[
				"--model",
				options.modelPath,
				"--port",
				String(port),
				"--host",
				"127.0.0.1",
				"--threads",
				String(Math.max(1, os.cpus().length)),
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);

		this.process = child;
		this.port = port;
		this.backend = resolved.backend;
		this.startedAtMs = Date.now();
		this.stderrTail = "";
		this.lastError = null;

		child.stdout?.on("data", (chunk: Buffer) => {
			process.stdout.write(`[whisper-stt-server] ${chunk.toString()}`);
		});

		child.stderr.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			process.stderr.write(`[whisper-stt-server] ${text}`);
			this.stderrTail = (this.stderrTail + text).slice(-this.stderrTailMax);
		});
		child.once("exit", (code) => {
			if (this.process === child) {
				const reason =
					code === null
						? "exited without code"
						: `exited with code ${code}; stderr=${this.stderrTail.slice(-512)}`;
				this.recordError(reason);
				this.process = null;
				this.port = null;
				this.startedAtMs = null;
			}
		});
		child.once("error", (err) => {
			this.recordError(`spawn error: ${err.message}`);
		});

		const baseUrl = `http://127.0.0.1:${port}`;
		try {
			await WhisperServerManager.pollUntilReady(baseUrl);
		} catch (err) {
			await this.stop();
			throw err instanceof Error ? err : new Error(String(err));
		}
		return { port, backend: resolved.backend };
	}

	/** Send SIGTERM and wait for the helper to exit. Resolves even if it was already down. */
	async stop(): Promise<void> {
		if (!this.process) {
			this.port = null;
			this.startedAtMs = null;
			return;
		}
		const child = this.process;
		this.process = null;
		this.port = null;
		this.startedAtMs = null;
		const exited = new Promise<void>((resolve) => {
			child.once("exit", () => resolve());
		});
		child.kill("SIGTERM");
		try {
			await Promise.race([
				exited,
				new Promise<void>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5_000)),
			]);
		} catch {
			child.kill("SIGKILL");
		}
	}

	private baseUrl(): string {
		if (!this.port) throw new Error("whisper-stt-server not started");
		return `http://127.0.0.1:${this.port}`;
	}

	private async ensureReady(): Promise<void> {
		if (!this.process || !this.port) {
			throw new Error("whisper-stt-server not started; call start() first");
		}
	}

	private toBackend(value: string | undefined): SttBackend {
		switch (value) {
			case "whispercpp-metal":
			case "whispercpp-vulkan":
			case "whispercpp-cuda":
			case "whispercpp-cpu":
				return value;
			default:
				return "whispercpp-cpu";
		}
	}

	private async runMultipartInfer(opts: {
		wavPath: string;
		language?: string;
	}): Promise<WhisperJsonResponse> {
		await this.ensureReady();
		const url = `${this.baseUrl()}/inference`;
		const form = new FormData();
		const fileBuffer = await readFile(opts.wavPath);
		const blob = new Blob([fileBuffer], { type: "audio/wav" });
		form.set("file", blob, path.basename(opts.wavPath));
		form.set("response_format", "verbose_json");
		form.set("language", opts.language && opts.language !== "auto" ? opts.language : "auto");
		const res = await fetch(url, { method: "POST", body: form });
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`whisper-stt-server /inference HTTP ${res.status}: ${text.slice(0, 512)}`);
		}
		return (await res.json()) as WhisperJsonResponse;
	}

	/** Defensive number parse for `verbose_json` values that may arrive as strings. */
	private toSec(value: string | number | undefined, fallback: number): number {
		if (value === undefined) return fallback;
		const n = typeof value === "string" ? Number(value) : value;
		return Number.isFinite(n) ? n : fallback;
	}

	/** Run one transcription; serializes concurrent callers. */
	async transcribe(opts: { samples: Float32Array; language?: string }): Promise<{
		segments: SttPhraseSegment[];
		wordSegments: SttWordSegment[];
		detectedLanguage: string;
		backend: SttBackend;
	}> {
		const task = this.inFlight.then(() => this.transcribeImpl(opts));
		this.inFlight = task.catch(() => undefined);
		return task;
	}

	private async transcribeImpl(opts: { samples: Float32Array; language?: string }): Promise<{
		segments: SttPhraseSegment[];
		wordSegments: SttWordSegment[];
		detectedLanguage: string;
		backend: SttBackend;
	}> {
		const wavPath = await writeSamplesAsWav(opts.samples);
		try {
			const json = await this.runMultipartInfer({ wavPath, language: opts.language });
			const raw = json.segments ?? [];
			const segments: SttPhraseSegment[] = raw
				.map((seg) => {
					const text = (seg.text ?? "").trim();
					const startSec = this.toSec(seg.start, 0);
					const endSec = this.toSec(seg.end, startSec + 0.5);
					return { text, startSec, endSec: Math.max(endSec, startSec + 0.05) };
				})
				.filter((s) => s.text.length > 0);
			const wordSegments: SttWordSegment[] = raw
				.flatMap((seg) =>
					(seg.words ?? []).map((w) => {
						const word = (w.word ?? "").trim();
						const startSec = this.toSec(w.start, 0);
						const endSec = this.toSec(w.end, startSec + 0.05);
						const confidence = typeof w.probability === "number" ? w.probability : undefined;
						return { word, startSec, endSec: Math.max(startSec + 0.02, endSec), confidence };
					}),
				)
				.filter((w) => w.word.length > 0);
			const detectedLanguage = json.detected_language ?? json.language ?? "auto";
			const backend = this.toBackend(json.backend);
			return { segments, wordSegments, detectedLanguage, backend };
		} finally {
			await cleanupWav(wavPath);
		}
	}
}
