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

/** CTranslate2 helper is stdio-shaped: stdin ignored, stdout/stderr captured. */
type Ct2Child = ChildProcessByStdio<null, Readable, Readable>;

/**
 * Owns the long-lived `ctranslate2-server` process used to recognize speech.
 *
 * Replaces the old `whisper-server` wrapper with the same shape: spawn → poll
 * `/` for 200 → POST `/inference` for each transcription. The wire JSON
 * contract (`electron/stt/transcriptionContract.ts`) is **byte-identical** to
 * the previous one, so `SttManager.transcribe()` keeps returning
 * `SttTranscribeResponse` unchanged and the renderer doesn't move.
 *
 * ponytail: the most important difference from whisper-server is that word
 * timestamps are **absolute** when they come back from CTranslate2's `.align()`
 * (real DTW against the Whisper cross-attention weights — see
 * `docs/engineering/stt-ctranslate2-migration.md`). The whisper-server wrapper
 * used to compose `word.start + parent_segment.start` to fix the VAD-relative
 * case; that whole offset-arithmetic is gone here, which is a load-bearing
 * simplification — if a future regression reintroduces it, the 5-second
 * leading-silence test from the doc's Context section is the one that would
 * catch it.
 *
 * Concurrency: simple single-flight queue — the helper handles one inference
 * at a time anyway; serializing avoids two transcriptions stepping on each
 * other's uploads.
 */

export interface CTranslate2ServerStartOptions {
	/** Absolute path to the unpacked CTranslate2 model directory. */
	modelPath: string;
	/** Externally-resolved binary path (skips gpuDetector on startup); null = auto. */
	binaryPath?: string | null;
	/** Externally-resolved backend (logs only); null = auto. */
	backend?: SttBackend | null;
	/**
	 * ponytail: pass `--int8` through to the C++ server so it picks
	 * `ComputeType::INT8` instead of `FLOAT32` at model load. The Node
	 * STT manager is the right gate — it's where the model variant
	 * (`SYSTRAN/faster-whisper-*.int8`) is selected in
	 * electron/stt/modelManager.ts, and it doesn't make sense to ask
	 * the same question twice on the wire.
	 */
	useInt8?: boolean;
}

export interface CTranslate2ServerStatus {
	running: boolean;
	pid: number | null;
	port: number | null;
	backend: SttBackend | null;
	startedAtMs: number | null;
	lastError: string | null;
}

/** Per-word entry inside a CTranslate2 server `/inference` JSON segment. */
interface Ct2JsonWord {
	word?: string;
	start?: number;
	end?: number;
}

/**
 * Phrase segment as emitted by ctranslate2-server's `/inference` JSON response.
 * `start`/`end` are the per-segment bounds (CTranslate2's runtime segment
 * emission, *not* a separate VAD pass). Word timestamps come back already
 * absolute — see the class doc comment.
 */
interface Ct2JsonSegment {
	text?: string;
	start?: number;
	end?: number;
	words?: Ct2JsonWord[];
}

interface Ct2JsonResponse {
	segments?: Ct2JsonSegment[];
	language?: string;
	detected_language?: string;
}

export class CTranslate2ServerManager {
	private process: Ct2Child | null = null;
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
		// 250ms pacing keeps the round-trip overhead under 1s while polling out to 30s.
		while (Date.now() < deadline) {
			try {
				const res = await fetch(baseUrl, { method: "GET" });
				if (res.ok) return;
			} catch {
				// not up yet
			}
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		throw new Error(`ctranslate2-server at ${baseUrl} did not respond within ${timeoutMs}ms`);
	}

	private recordError(message: string): void {
		this.lastError = message;
	}

	/** True when a process is alive and a model is loaded. */
	get status(): CTranslate2ServerStatus {
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
	async start(
		options: CTranslate2ServerStartOptions,
	): Promise<{ port: number; backend: SttBackend }> {
		if (this.process && this.port) {
			return { port: this.port, backend: this.backend ?? options.backend ?? "ctranslate2-cpu" };
		}

		const resolved = options.binaryPath
			? { path: options.binaryPath, backend: options.backend ?? "ctranslate2-cpu" }
			: await resolveBinaryPath();
		if (!resolved.path) {
			const message =
				"ctranslate2-server binary not found; build it via scripts/build-ctranslate2-server.sh";
			this.recordError(message);
			throw new Error(message);
		}
		try {
			// ponytail: on Windows, `fs.access(X_OK)` is a no-op that always rejects
			// because Windows doesn't expose POSIX execute bits. Trust the .exe
			// extension + `existsSync` and let `spawn` raise a real error if
			// something's wrong. On POSIX, the X_OK check still catches chmod
			// mistakes.
			if (process.platform !== "win32") {
				await access(resolved.path, fsConstants.X_OK);
			} else if (!existsSync(resolved.path)) {
				throw new Error("not found");
			}
		} catch {
			const message = `ctranslate2-server binary at ${resolved.path} is not executable`;
			this.recordError(message);
			throw new Error(message);
		}
		if (!existsSync(options.modelPath)) {
			throw new Error(`CTranslate2 model not found at ${options.modelPath}`);
		}

		const port = await CTranslate2ServerManager.pickFreePort();
		const child = spawn(
			resolved.path,
			[
				"--model",
				options.modelPath,
				"--port",
				String(port),
				"--host",
				"127.0.0.1",
				// ponytail: CTranslate2's default thread count ignores the host's
				// real core count, the same trap whisper.cpp's hardcoded 4 had.
				// Raising it to logical core count is a free ~30% on an 8-core
				// CPU, no quality tradeoff.
				"--threads",
				String(Math.max(1, os.cpus().length)),
				...(resolved.backend === "ctranslate2-cuda" ? ["--cuda"] : []),
				...(options.useInt8 ? ["--int8"] : []),
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);

		this.process = child;
		this.port = port;
		this.backend = resolved.backend;
		this.startedAtMs = Date.now();
		this.stderrTail = "";
		this.lastError = null;

		// ponytail: ctranslate2-server's stdout is currently quiet (it logs
		// only to stderr) but mirror both streams anyway — a future patch
		// pushing progress to stdout would otherwise be invisible. The
		// stderr hook above keeps the existing ring-buffer for crash
		// diagnostics untouched.
		child.stdout?.on("data", (chunk: Buffer) => {
			process.stdout.write(`[ct2-server] ${chunk.toString()}`);
		});

		child.stderr.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			// ponytail: also mirror to the main-process stderr so a stuck
			// "stt:transcribe" task is at least diagnosable from
			// `npm run dev` output, instead of being a silent ring buffer.
			// Without this the user sees a hung spinner with no signal of
			// whether the server is still loading the model, hung on a
			// GEMM that won't return, or actually computing the way
			// through a 30 s clip with Ruy/fp32.
			process.stderr.write(`[ct2-server] ${text}`);
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
			await CTranslate2ServerManager.pollUntilReady(baseUrl);
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
		if (!this.port) throw new Error("ctranslate2-server not started");
		return `http://127.0.0.1:${this.port}`;
	}

	private async ensureReady(): Promise<void> {
		if (!this.process || !this.port) {
			throw new Error("ctranslate2-server not started; call start() first");
		}
	}

	private async runMultipartInfer(opts: {
		wavPath: string;
		language?: string;
	}): Promise<Ct2JsonResponse> {
		await this.ensureReady();
		const url = `${this.baseUrl()}/inference`;
		const form = new FormData();
		const fileBuffer = await readFile(opts.wavPath);
		const blob = new Blob([fileBuffer], { type: "audio/wav" });
		form.set("file", blob, path.basename(opts.wavPath));
		// ponytail: ctranslate2-server follows whisper.cpp's "verbose_json"
		// convention here (segments + words), which is what we already parse.
		form.set("response_format", "verbose_json");
		// ponytail: per-language default is `auto` for the CTranslate2 runtime
		// (matches faster-whisper's Python default). Honour the IPC contract's
		// "Omit / `auto` → Whisper detects" by sending `auto` when the caller
		// did not specify a code, and pass any forced ISO 639-1 through.
		form.set("language", opts.language && opts.language !== "auto" ? opts.language : "auto");
		const res = await fetch(url, { method: "POST", body: form });
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`ctranslate2-server /inference HTTP ${res.status}: ${text.slice(0, 512)}`);
		}
		return (await res.json()) as Ct2JsonResponse;
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
	}> {
		const task = this.inFlight.then(() => this.transcribeImpl(opts));
		// swallow rejection so the chain stays alive; callers await via `task` directly
		this.inFlight = task.catch(() => undefined);
		return task;
	}

	private async transcribeImpl(opts: { samples: Float32Array; language?: string }): Promise<{
		segments: SttPhraseSegment[];
		wordSegments: SttWordSegment[];
		detectedLanguage: string;
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
			// ponytail: CTranslate2's `.align()` emits absolute word timestamps
			// already (real DTW against the Whisper cross-attention weights,
			// not the VAD-relative ones whisper-server used to ship). No
			// `word.start + parent_segment.start` composition is required —
			// that was load-bearing for whisper-server only because Silero
			// VAD cropped each region first.
			const wordSegments: SttWordSegment[] = raw
				.flatMap((seg) =>
					(seg.words ?? []).map((w) => {
						const word = (w.word ?? "").trim();
						const startSec = this.toSec(w.start, 0);
						const endSec = this.toSec(w.end, startSec + 0.05);
						return { word, startSec, endSec: Math.max(startSec + 0.02, endSec) };
					}),
				)
				.filter((w) => w.word.length > 0);
			const detectedLanguage = json.detected_language ?? json.language ?? "auto";
			return { segments, wordSegments, detectedLanguage };
		} finally {
			await cleanupWav(wavPath);
		}
	}
}
