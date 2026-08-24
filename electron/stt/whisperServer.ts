import { type ChildProcessByStdio, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, constants as fsConstants, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";

import { resolveBinaryPath } from "./gpuDetector";
import { snapWordBoundariesToAudio } from "./snapWordBoundaries";
import type {
	SttBackend,
	SttPhraseSegment,
	SttTiming,
	SttWordSegment,
} from "./transcriptionContract";
import { cleanupWav, writeSamplesAsWav } from "./wav";

/** whisper.cpp helper is stdio-shaped: stdin ignored, stdout/stderr captured. */
type WhisperChild = ChildProcessByStdio<null, Readable, Readable>;

/**
 * Per-request ceiling. whisper answers `/inference` only once the WHOLE upload
 * is transcribed, so this bounds one chunk, not one recording.
 *
 * ponytail: 280s because Node's global fetch (undici) applies its own
 * undocumented 300s `headersTimeout` that we cannot configure without taking a
 * direct dependency on `undici` — going over it produces an opaque
 * "TypeError: fetch failed" instead of anything actionable (this is exactly how
 * a single 30-minute request died: killed at 300s while whisper needed 574s).
 * Aborting at 280s keeps the failure OURS: named, logged with the helper's
 * stderr, and retried by SttManager. The real ceiling this leaves is a machine
 * so slow that one 90s chunk needs more than 280s (~0.3x realtime); the upgrade
 * path is a direct `undici` dependency and
 * `new Agent({ headersTimeout: 0, bodyTimeout: 0 })` as the fetch dispatcher,
 * which removes the cliff entirely.
 */
const REQUEST_TIMEOUT_MS = 280_000;

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

/**
 * The helper's `timing` block, in its own snake_case wire spelling. Every field
 * is optional and may arrive as a string for the same reason the segment bounds
 * may (see `toSec`): nothing on the wire is guaranteed by a schema.
 */
interface WhisperJsonTiming {
	elapsed_s?: number | string;
	audio_s?: number | string;
	rtf?: number | string;
}

interface WhisperJsonResponse {
	segments?: WhisperJsonSegment[];
	language?: string;
	detected_language?: string;
	backend?: string;
	timing?: WhisperJsonTiming;
}

export class WhisperServerManager {
	private process: WhisperChild | null = null;
	private shuttingDown = false;
	private port: number | null = null;
	private backend: SttBackend | null = null;
	private lastError: string | null = null;
	private startedAtMs: number | null = null;
	private inFlight: Promise<unknown> = Promise.resolve();
	private starting: Promise<{ port: number; backend: SttBackend }> | null = null;

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
	private static async pollUntilReady(
		baseUrl: string,
		timeoutMs = 30_000,
		shouldContinue: () => boolean = () => true,
	): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (!shouldContinue()) throw new Error("whisper-stt-server exited before readiness");
			const controller = new AbortController();
			const probeTimeout = setTimeout(
				() => controller.abort(),
				Math.min(2_000, Math.max(1, deadline - Date.now())),
			);
			try {
				const res = await fetch(baseUrl, { method: "GET", signal: controller.signal });
				if (res.ok) return;
			} catch {
				// not up yet
			} finally {
				clearTimeout(probeTimeout);
			}
			if (!shouldContinue()) throw new Error("whisper-stt-server exited before readiness");
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		throw new Error(`whisper-stt-server at ${baseUrl} did not respond within ${timeoutMs}ms`);
	}

	/**
	 * Record a failure on `lastError`, and — unless `log` says otherwise — put it
	 * in the main-process log.
	 *
	 * ponytail: to the log, not only to the field. `lastError` is read by the
	 * `status` getter, which nothing on the transcribe path calls, so a missing or
	 * non-executable helper used to leave no trace anywhere in the main process
	 * and the only way to find out was to instrument the code. The renderer does
	 * toast the failure; a packaged build still needs a line someone can point at
	 * in a bug report.
	 *
	 * `log: false` exists because a death during startup reaches this method
	 * TWICE — once from the `exit` listener, once from the startup catch that the
	 * same exit rejects. Both writes are wanted (the second message is the more
	 * specific of the two, and it is what `status` should end up holding), but two
	 * differently-worded lines for one event is the kind of noise that makes a
	 * reader doubt the log rather than trust it.
	 */
	private recordError(message: string, { log = true }: { log?: boolean } = {}): void {
		this.lastError = message;
		if (log) console.error(`[stt] ${message}`);
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
		if (this.starting) return this.starting;
		this.starting = this.startImpl(options).finally(() => {
			this.starting = null;
		});
		return this.starting;
	}

	private async startImpl(
		options: WhisperServerStartOptions,
	): Promise<{ port: number; backend: SttBackend }> {
		if (this.shuttingDown) {
			throw new Error("whisper-stt-server manager is shutting down");
		}
		if (this.process && this.port) {
			return { port: this.port, backend: this.backend ?? options.backend ?? "whispercpp-cpu" };
		}

		const resolved = options.binaryPath
			? { path: options.binaryPath, backend: options.backend ?? "whispercpp-cpu" }
			: await resolveBinaryPath();
		const binaryPath = resolved.path;
		if (!binaryPath) {
			const message =
				"whisper-stt-server binary not found; build it via scripts/build-whisper-stt.sh";
			this.recordError(message);
			throw new Error(message);
		}
		try {
			if (process.platform !== "win32") {
				await access(binaryPath, fsConstants.X_OK);
			} else if (!existsSync(binaryPath)) {
				throw new Error("not found");
			}
		} catch {
			const message = `whisper-stt-server binary at ${binaryPath} is not executable`;
			this.recordError(message);
			throw new Error(message);
		}
		if (!existsSync(options.modelPath)) {
			throw new Error(`Whisper GGML model not found at ${options.modelPath}`);
		}

		const launch = async (forceCpu: boolean): Promise<{ port: number; backend: SttBackend }> => {
			const port = await WhisperServerManager.pickFreePort();
			if (this.shuttingDown) {
				throw new Error("whisper-stt-server manager is shutting down");
			}
			const args = [
				"--model",
				options.modelPath,
				"--port",
				String(port),
				"--host",
				"127.0.0.1",
				"--threads",
				String(Math.max(1, os.cpus().length)),
			];
			if (forceCpu) args.push("--cpu");
			const child = spawn(binaryPath, args, { stdio: ["ignore", "pipe", "pipe"] });
			const activeBackend: SttBackend = forceCpu ? "whispercpp-cpu" : resolved.backend;

			this.process = child;
			this.port = port;
			this.backend = activeBackend;
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
				// ponytail: the same shape as the `exit` listener above, and for the same
				// reason. A spawn error reaches the startup catch by the same route — the
				// `exitedBeforeReady` race rejects on `error` too — so without clearing
				// the startup state here, that catch cannot tell this failure has already
				// been reported and logs it a second time in different words. Clearing is
				// also just true: a child that never spawned is not a helper that is up,
				// and `status` said it was.
				if (this.process === child) {
					this.recordError(`spawn error: ${err.message}`);
					this.process = null;
					this.port = null;
					this.startedAtMs = null;
				}
			});

			const exitedBeforeReady = new Promise<never>((_, reject) => {
				child.once("exit", (code) => {
					reject(
						new Error(
							`whisper-stt-server exited during startup (${code ?? "no code"}); ` +
								`stderr=${this.stderrTail.slice(-512)}`,
						),
					);
				});
				child.once("error", reject);
			});
			try {
				await Promise.race([
					WhisperServerManager.pollUntilReady(
						`http://127.0.0.1:${port}`,
						30_000,
						() => this.process === child,
					),
					exitedBeforeReady,
				]);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				// ponytail: read BEFORE `stop()`, which nulls it either way. The `exit`
				// listener clears `this.process` as it records, so `!== child` here means
				// the death has already been logged and this catch is the second voice on
				// it. A readiness TIMEOUT leaves the child in place and is logged from
				// here, which is the only place that sees it at all.
				const alreadyLogged = this.process !== child;
				await this.stop();
				this.recordError(message, { log: !alreadyLogged });
				throw new Error(message);
			}
			return { port, backend: activeBackend };
		};

		try {
			return await launch(false);
		} catch (err) {
			const startupLog = `${err instanceof Error ? err.message : String(err)} ${this.stderrTail}`;
			const startupLines = startupLog.split(/\r?\n/);
			const mentionsGpuBackend = startupLines.some((line) =>
				/(?:ggml_(?:metal|vulkan|cuda)|gpu)/i.test(line),
			);
			const mentionsStartupFailure = startupLines.some((line) =>
				/(?:fail|error|allocat)/i.test(line),
			);
			const gpuStartupFailed =
				resolved.backend !== "whispercpp-cpu" && mentionsGpuBackend && mentionsStartupFailure;
			if (!gpuStartupFailed) throw err;
			process.stderr.write(
				"[whisper-stt-server] GPU startup failed; retrying with CPU inference\n",
			);
			return launch(true);
		}
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

	/** Permanently prevent respawn, then stop the currently owned helper. */
	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		await this.stop();
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
		let res: Response;
		try {
			res = await fetch(url, {
				method: "POST",
				body: form,
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch (error) {
			// Name the failure. Node's global fetch reports BOTH a real transport
			// error and its own header timeout as a bare "fetch failed", which is
			// how a too-long request used to reach the user as an unactionable
			// "Transcription failed" toast.
			//
			// The timeout wording is reserved for an ACTUAL timeout: a helper that
			// died a moment ago rejects in a millisecond, and telling the reader it
			// spent 280s on an over-long chunk sends them to the wrong problem
			// entirely. Everything else carries its own message, plus `cause` so the
			// errno survives.
			// `Object.assign` rather than the `{ cause }` constructor option: the
			// project targets ES2020, where that overload does not exist.
			throw Object.assign(
				new Error(
					error instanceof Error && error.name === "TimeoutError"
						? `whisper-stt-server /inference timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s ` +
								`(audio chunk too long for this machine, or the helper is wedged); ` +
								`stderr=${this.stderrTail.slice(-256)}`
						: `whisper-stt-server /inference failed: ` +
								`${error instanceof Error ? error.message : String(error)}; ` +
								`stderr=${this.stderrTail.slice(-256)}`,
				),
				{ cause: error },
			);
		}
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`whisper-stt-server /inference HTTP ${res.status}: ${text.slice(0, 512)}`);
		}
		// The same timeout still covers the body: it can fire between the headers
		// and the last byte, and an unnamed `AbortError` here would read exactly
		// like the "fetch failed" this whole block exists to replace.
		return (await res.json().catch((error: unknown) => {
			throw Object.assign(
				new Error(
					`whisper-stt-server /inference response was unreadable: ` +
						`${error instanceof Error ? error.message : String(error)}`,
				),
				{ cause: error },
			);
		})) as WhisperJsonResponse;
	}

	/** Defensive number parse for `verbose_json` values that may arrive as strings. */
	private toSec(value: string | number | undefined, fallback: number): number {
		if (value === undefined) return fallback;
		const n = typeof value === "string" ? Number(value) : value;
		return Number.isFinite(n) ? n : fallback;
	}

	/**
	 * Read the helper's `timing` block, or null when it is missing or unusable.
	 *
	 * Null rather than zeroes: a helper binary built before the field existed
	 * simply omits it, and callers have to be able to tell that apart from a
	 * transcription that genuinely took no time — one is "we don't know", the
	 * other would be a bug worth showing.
	 *
	 * `rtf` is recomputed from the two durations whenever the helper didn't send
	 * a usable one. It is derived data, and a NaN surviving this far would reach
	 * the UI as "NaN x real-time".
	 *
	 * Durations no clock could have produced are treated as a junk block, not as
	 * a slow one: `steady_clock` cannot run backwards, and a chunk holding no
	 * audio has nothing to measure. Rejecting them here is what keeps a bad value
	 * out of `SttManager`'s run totals, where it would quietly distort the figure
	 * the whole recording is reported against.
	 */
	private toTiming(raw: WhisperJsonTiming | undefined): SttTiming | null {
		if (!raw || typeof raw !== "object") return null;
		const elapsedSec = this.toSec(raw.elapsed_s, Number.NaN);
		const audioSec = this.toSec(raw.audio_s, Number.NaN);
		if (!Number.isFinite(elapsedSec) || elapsedSec < 0) return null;
		// Also the divisor below, so this doubles as the divide-by-zero guard.
		if (!Number.isFinite(audioSec) || audioSec <= 0) return null;
		const reported = this.toSec(raw.rtf, Number.NaN);
		const rtf = Number.isFinite(reported) && reported > 0 ? reported : elapsedSec / audioSec;
		return { elapsedSec, audioSec, rtf };
	}

	/** Run one transcription; serializes concurrent callers. */
	async transcribe(opts: { samples: Float32Array; language?: string }): Promise<{
		segments: SttPhraseSegment[];
		wordSegments: SttWordSegment[];
		detectedLanguage: string;
		backend: SttBackend;
		/** Null when the helper reported no usable `timing` block. */
		timing: SttTiming | null;
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
		timing: SttTiming | null;
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
			// whisper.cpp's DTW boundaries run ~80–150 ms behind the audio, which the
			// transcript editor turns into imprecise trims (see snapWordBoundaries.ts).
			// Re-anchor them on the same samples whisper was given.
			const wordSegments: SttWordSegment[] = snapWordBoundariesToAudio(
				raw
					.flatMap((seg) =>
						(seg.words ?? []).map((w) => {
							const word = (w.word ?? "").trim();
							const startSec = this.toSec(w.start, 0);
							const endSec = this.toSec(w.end, startSec + 0.05);
							const confidence = typeof w.probability === "number" ? w.probability : undefined;
							return { word, startSec, endSec: Math.max(startSec + 0.02, endSec), confidence };
						}),
					)
					.filter((w) => w.word.length > 0),
				opts.samples,
			);
			const detectedLanguage = json.detected_language ?? json.language ?? "auto";
			const backend = this.toBackend(json.backend);
			const timing = this.toTiming(json.timing);
			return { segments, wordSegments, detectedLanguage, backend, timing };
		} finally {
			await cleanupWav(wavPath);
		}
	}
}
