import path from "node:path";
import { app, type IpcMain } from "electron";
import { planChunks } from "./chunking";
import { ensureModels, modelPaths } from "./modelManager";
import type {
	SttPhraseSegment,
	SttStatusEvent,
	SttTiming,
	SttTranscribeRequest,
	SttTranscribeResponse,
	SttWordSegment,
} from "./transcriptionContract";
import { WhisperServerManager } from "./whisperServer";

/**
 * Owner of the long-lived STT pipeline. One instance per Electron app.
 *
 * Workflow:
 *   1. `init()` spawns `whisper-stt-server` (or queues the call if it's busy).
 *   2. `transcribe()` splits the renderer's `Float32Array` into chunks
 *      (`chunking.ts`) and runs each through whisper-stt-server's HTTP
 *      `/inference`, which returns both phrase- and word-level segments in one
 *      pass (see whisperServer.ts). Word timestamps come from whisper.cpp's
 *      native DTW token timestamps (`t_dtw`, SMALL aheads preset,
 *      `flash_attn = false`), see
 *      technical-documentation/architecture/transcription-and-captions.md § Decision rationale.
 *   3. `shutdown()` tears down on app quit.
 *
 * Status events fan out to every attached sink so the renderer can drive its
 * "loading model" / "transcribing" indicator.
 *
 * Why chunked rather than one request: a 30-minute recording took ~10 minutes
 * in a single `/inference` call — no progress to show, no way to recover from a
 * transient failure without redoing everything, and long enough that the HTTP
 * client's own header timeout killed it before whisper ever answered. Chunks
 * turn that into a progress signal, a retry unit, and — via `cancel()` — the
 * only point where a run in flight can be stopped at all.
 *
 * Chunks run SEQUENTIALLY, and that is a measured choice, not an omission:
 * whisper-stt-server holds a single model context, so concurrent `/inference`
 * calls don't just serialize — they get SLOWER. Two 120s chunks took 76.9s one
 * after the other and 144.1s fired together (0.53x, i.e. ~1.9x slower) on this
 * Vulkan backend. A client-side worker pool is therefore a pessimisation. Real
 * parallelism would need several server processes, each with its own copy of
 * the model resident on the GPU; that trade (VRAM + spawn cost per worker) is
 * worth revisiting only if a much smaller model ever becomes the default.
 */

/** The renderer always sends mono 16 kHz (see `extractMono16kFromVideoUrl`). */
const SAMPLE_RATE = 16_000;

/** Attempts per chunk before the whole transcription fails. */
const CHUNK_ATTEMPTS = 3;

/**
 * `AbortError` by name so the renderer's `isAbortError` recognizes it as "the
 * user asked for this" rather than an engine failure worth a toast.
 */
function cancelledError(): Error {
	const error = new Error("Transcription cancelled");
	error.name = "AbortError";
	return error;
}

/**
 * One transcription's cost, in both of the conventions this repo uses.
 *
 * whisper.cpp and the POC report measure RTF — wall-clock divided by audio, so
 * LOWER is faster — while the figure that means something to a reader is its
 * reciprocal ("2.1x real-time"). Printing both lets a log line be compared
 * against tools/stt-eval/whispercpp-dtw-poc/REPORT.md 5 without arithmetic.
 *
 * ASCII "x" rather than the report's "×" glyph: these lines are read in a
 * Windows console and in the diagnostics dump, neither of which is reliably
 * UTF-8.
 */
function formatTiming(timing: SttTiming): string {
	const speed = timing.rtf > 0 ? 1 / timing.rtf : 0;
	return (
		`${timing.audioSec.toFixed(1)}s audio in ${timing.elapsedSec.toFixed(1)}s ` +
		`(${timing.rtf.toFixed(2)} rtf, ${speed.toFixed(1)}x real-time)`
	);
}

export interface SttManagerInitOptions {
	statusSink?: (event: SttStatusEvent) => void;
	/** Override the models cache directory; defaults to `app.getPath("userData") + "/stt-models"`. */
	modelsBaseDir?: string;
}

export class SttManager {
	private readonly server = new WhisperServerManager();
	private shuttingDown = false;
	private modelsBaseDir: string | null = null;
	private readonly statusSinks = new Set<(event: SttStatusEvent) => void>();
	private initPromise: Promise<void> | null = null;
	/** Kept from `prepare()` so a chunk retry can respawn a helper that died mid-run. */
	private modelPath: string | null = null;
	/**
	 * Bumped by `cancel()`. The chunk loop compares it against the value it
	 * captured on entry, so a cancel that lands after a new run started cannot
	 * kill that new run.
	 */
	private cancelEpoch = 0;

	/**
	 * Attach a sink for the renderer status channel; returns its detach function.
	 *
	 * A SET rather than one slot: this used to be a single field that each IPC
	 * invocation saved and restored, so with two overlapping transcriptions the
	 * first to finish restored the sink captured at ITS start and left the other
	 * one emitting into nothing — no progress for the rest of its run, which
	 * reads as a hang.
	 */
	addStatusSink(sink: (event: SttStatusEvent) => void): () => void {
		this.statusSinks.add(sink);
		return () => {
			this.statusSinks.delete(sink);
		};
	}

	private emit(event: SttStatusEvent): void {
		for (const sink of this.statusSinks) sink(event);
	}

	/**
	 * Stop the in-flight transcription at the next chunk boundary.
	 *
	 * ponytail: one epoch for the whole manager, not a handle per request. The
	 * pipeline runs one transcription at a time by construction (the renderer's
	 * queue serializes, and `WhisperServerManager` single-flights on top), so
	 * "cancel what is running" is the only question anyone can ask. Per-request
	 * tokens the day two recordings can transcribe at once.
	 */
	cancel(): void {
		this.cancelEpoch++;
	}

	/**
	 * Run all one-time setup; cheap to call repeatedly — the `initPromise`
	 * means the second caller just awaits the same completion.
	 */
	init(options: SttManagerInitOptions = {}): Promise<void> {
		if (this.shuttingDown) return Promise.reject(cancelledError());
		if (options.statusSink) this.addStatusSink(options.statusSink);
		if (options.modelsBaseDir) this.modelsBaseDir = options.modelsBaseDir;
		if (!this.initPromise) {
			// A REJECTED init must not be cached. `prepare()` downloads a 264 MB
			// model on first run, and caching its rejection meant one dropped
			// connection poisoned the whole app session: every later transcription
			// — including the retry the UI offers, and every remaining asset in the
			// auto-transcription queue — awaited the same stale rejection and failed
			// in milliseconds, with no way back short of quitting the app.
			// Reconnecting the network changed nothing. Clearing the slot on failure
			// makes the next attempt a real attempt.
			this.initPromise = this.prepare().catch((error) => {
				this.initPromise = null;
				throw error;
			});
		}
		return this.initPromise;
	}

	private getModelsDir(): string {
		if (this.modelsBaseDir) return this.modelsBaseDir;
		this.modelsBaseDir = path.join(app.getPath("userData"), "stt-models");
		return this.modelsBaseDir;
	}

	private async prepare(): Promise<void> {
		const modelsDir = this.getModelsDir();
		this.emit({ phase: "model", model: "whisper", downloadedBytes: 0, totalBytes: 0 });
		await ensureModels({
			baseDir: modelsDir,
			onProgress: (event) => {
				this.emit({
					phase: "model",
					model: event.id,
					downloadedBytes: event.downloadedBytes,
					totalBytes: event.totalBytes,
				});
			},
		});
		if (this.shuttingDown) throw cancelledError();

		const paths = modelPaths(modelsDir);
		this.modelPath = paths.whisper;
		try {
			await this.server.start({ modelPath: paths.whisper });
		} catch (error) {
			if (this.shuttingDown) throw cancelledError();
			throw error;
		}
		if (this.shuttingDown) {
			await this.server.shutdown();
			throw cancelledError();
		}
		this.emit({ phase: "transcribe" });
	}

	/**
	 * Run one chunk, retrying a few times before giving up on the whole request.
	 *
	 * A failure here is usually the helper process dying (OOM, driver reset)
	 * rather than a bad chunk, so each retry first re-runs `server.start()` —
	 * idempotent when the helper is alive, a respawn when it isn't. That is what
	 * makes a 30-minute transcription survive a helper that dies once mid-run.
	 *
	 * What it does NOT do is salvage a chunk that fails all three attempts: the
	 * request fails whole and the chunks that already succeeded go with it. A
	 * transcript silently missing 90 seconds in the middle is worse than no
	 * transcript, since nothing downstream (captions, trims, the transcript
	 * editor) could tell the gap from a silence. The caller is told how far it
	 * got instead — see the wrapper in `transcribe()`.
	 */
	private async transcribeChunk(
		samples: Float32Array,
		language: string | undefined,
	): Promise<Awaited<ReturnType<WhisperServerManager["transcribe"]>>> {
		let lastError: unknown;
		for (let attempt = 1; attempt <= CHUNK_ATTEMPTS; attempt++) {
			if (this.shuttingDown) throw cancelledError();
			try {
				return await this.server.transcribe({ samples, language });
			} catch (error) {
				lastError = error;
				if (this.shuttingDown) throw cancelledError();
				if (attempt === CHUNK_ATTEMPTS) break;
				if (this.modelPath) {
					await this.server.start({ modelPath: this.modelPath }).catch(() => undefined);
				}
				if (this.shuttingDown) throw cancelledError();
				await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
			}
		}
		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	}

	/** Transcribe a whole recording, chunk by chunk, reporting progress as it goes. */
	async transcribe(req: SttTranscribeRequest): Promise<SttTranscribeResponse> {
		await this.init();

		const epoch = this.cancelEpoch;
		const totalSec = req.samples.length / SAMPLE_RATE;
		const chunks = planChunks(req.samples, SAMPLE_RATE);
		this.emit({ phase: "transcribe", completedSec: 0, totalSec });

		const segments: SttPhraseSegment[] = [];
		const wordSegments: SttWordSegment[] = [];
		let detectedLanguage: string | null = null;
		let backend = this.server.status.backend ?? "whispercpp-cpu";
		// Summed, not averaged: chunks differ in length, so the mean of the
		// per-chunk RTFs is not the RTF of the run.
		let elapsedSec = 0;
		let audioSec = 0;
		let timedChunks = 0;
		let untimedChunks = 0;
		// The CPU verdict is worth saying once per run, not once per chunk.
		let warnedCpu = false;
		// Only the first chunk auto-detects; every later chunk is forced onto the
		// language it resolved, so whisper cannot flip mid-recording on a chunk
		// that opens with a proper noun or a silence and "transcribe" the rest as
		// another language.
		//
		// `"auto"` must collapse to `undefined` here rather than merely falsy
		// values: `SttTranscribeRequest` documents it as the explicit way to ask
		// for detection, and it is TRUTHY — left in place it makes the pin below
		// unreachable for every caller that spells its intent out.
		//
		// This depends on the helper reporting what it RESOLVED rather than
		// echoing the request, which it only does since cc781806 (30/07/2026,
		// `whisper_full_lang_id()` in electron/native/whisper-stt/src/main.cpp).
		// A stale `electron/native/bin/<tag>/whisper-stt-server` — the directory
		// is gitignored, so a dev tree keeps whatever was last staged there —
		// silently reverts this to "every chunk detects on its own": the echo
		// comes back as the literal "auto", the guard below rejects it, and
		// nothing anywhere says why. `scripts/stage-whisper-stt.sh` refuses to
		// overwrite a local binary by design, so it will not rescue you either.
		// Verified end-to-end on 352s of real speech: `[undefined,"en","en","en"]`.
		let language = req.language && req.language !== "auto" ? req.language : undefined;

		for (const [index, chunk] of chunks.entries()) {
			// Between chunks is the only place this loop can be interrupted, and it
			// is enough: a chunk is bounded by `whisperServer`'s own request ceiling.
			if (this.cancelEpoch !== epoch) throw cancelledError();
			const offsetSec = chunk.startSample / SAMPLE_RATE;
			const result = await this.transcribeChunk(
				req.samples.subarray(chunk.startSample, chunk.endSample),
				language,
			).catch((error) => {
				if (error instanceof Error && error.name === "AbortError") throw error;
				// Say where it died. Without this the user gets "Transcription
				// failed" for a 30-minute recording with no hint that 18 of those
				// minutes were fine and the helper fell over at one specific spot.
				// `Object.assign` rather than the `{ cause }` constructor option: the
				// project targets ES2020, where that overload does not exist (see
				// `BackgroundLoadError` in src/lib/wallpaper.ts for the same dance).
				throw Object.assign(
					new Error(
						`transcription failed ${Math.round(offsetSec)}s into a ${Math.round(totalSec)}s ` +
							`recording (chunk ${index + 1}/${chunks.length}): ` +
							`${error instanceof Error ? error.message : String(error)}`,
					),
					{ cause: error },
				);
			});
			if (this.shuttingDown || this.cancelEpoch !== epoch) throw cancelledError();
			// Chunk-relative timestamps → absolute, the only thing every consumer
			// (captions, transcript editor, trims) reads.
			for (const segment of result.segments) {
				segments.push({
					text: segment.text,
					startSec: segment.startSec + offsetSec,
					endSec: segment.endSec + offsetSec,
				});
			}
			for (const word of result.wordSegments) {
				wordSegments.push({
					word: word.word,
					startSec: word.startSec + offsetSec,
					endSec: word.endSec + offsetSec,
					confidence: word.confidence,
				});
			}
			if (!detectedLanguage && result.detectedLanguage && result.detectedLanguage !== "auto") {
				detectedLanguage = result.detectedLanguage;
				if (!language) language = detectedLanguage;
			}
			backend = result.backend ?? backend;
			if (result.timing) {
				elapsedSec += result.timing.elapsedSec;
				audioSec += result.timing.audioSec;
				timedChunks++;
			} else {
				untimedChunks++;
			}
			const runRtf = audioSec > 0 ? elapsedSec / audioSec : undefined;
			// Through `console.*` on purpose: that is what the main-process ring
			// buffer wraps (electron/diagnostics/main-log-buffer.ts), so these lines
			// reach "Save Diagnostics". The helper's own stderr is forwarded with
			// `process.stderr.write` in whisperServer.ts and never lands there.
			console.info(
				`[stt] chunk ${index + 1}/${chunks.length} on ${backend}: ` +
					(result.timing
						? formatTiming(result.timing)
						: "no timing reported (staged helper binary pre-dates the field)"),
			);
			// Falling back to CPU is silent on both sides — the helper retries
			// without GPU when init returns null, and this process can relaunch the
			// helper with `--cpu` — and it costs about half the throughput. A user
			// staring at a transcription that takes twice as long has, without this,
			// nothing anywhere telling them why.
			if (!warnedCpu && backend === "whispercpp-cpu") {
				warnedCpu = true;
				console.warn(
					"[stt] running on CPU - no GPU backend was bound. Expect roughly half " +
						"the throughput of the Vulkan/Metal path (median 2.07x on the reference " +
						"machine, tools/stt-eval/whispercpp-dtw-poc/REPORT.md 5.3).",
				);
			}
			this.emit({
				phase: "transcribe",
				completedSec: chunk.endSample / SAMPLE_RATE,
				totalSec,
				backend,
				rtf: runRtf,
			});
		}

		// A total has to cover everything it claims to total. Let one chunk go
		// unmeasured and these sums describe a SHORTER recording than the one that
		// was actually transcribed — under a field documented as covering every
		// chunk. So an incomplete run reports no timing rather than partial timing.
		//
		// The per-chunk `rtf` emitted above is deliberately not held to this: it is
		// a RATIO, not a total, and stays honest over whatever subset reported.
		const timing: SttTiming | undefined =
			timedChunks > 0 && untimedChunks === 0 && audioSec > 0
				? { elapsedSec, audioSec, rtf: elapsedSec / audioSec }
				: undefined;
		console.info(
			`[stt] done on ${backend}: ${chunks.length} chunk(s), ` +
				(timing
					? formatTiming(timing)
					: untimedChunks === chunks.length
						? "no timing reported"
						: `timing incomplete (${untimedChunks}/${chunks.length} chunks unmeasured)`),
		);
		return {
			segments,
			wordSegments,
			detectedLanguage: detectedLanguage ?? language ?? "auto",
			backend,
			timing,
		};
	}

	/** Best-effort shutdown; safe to call from `before-quit` hooks. */
	async shutdown(): Promise<void> {
		if (this.shuttingDown) return;
		this.shuttingDown = true;
		this.cancelEpoch++;
		await this.server.shutdown();
	}
}

let singleton: SttManager | null = null;
let sttShuttingDown = false;

/** Lazy singleton for the IPC layer; processes one transcription at a time. */
export function getSttManager(): SttManager {
	if (sttShuttingDown) throw cancelledError();
	if (!singleton) singleton = new SttManager();
	return singleton;
}

/**
 * Stop and release the lazy singleton without creating one just to quit.
 *
 * Electron's GUI lifecycle awaits this from a guarded `before-quit` handler;
 * clearing the slot first also makes repeated quit events idempotent.
 */
export async function shutdownStt(): Promise<void> {
	sttShuttingDown = true;
	const manager = singleton;
	await manager?.shutdown();
	singleton = null;
}

/** Reset the singleton — for tests. */
export function _resetSttManagerForTests(): void {
	singleton = null;
	sttShuttingDown = false;
}

/**
 * Wire the IPC channels. Call this from `registerIpcHandlers` so the renderer
 * can `invoke("stt:transcribe", request)` and receive `SttTranscribeResponse`,
 * and `invoke("stt:cancel")` to stop a run it no longer wants. Status events
 * fan out on `"stt:status"` (main → renderer push), scoped to the calling
 * `webContents` so two windows don't cross-talk.
 */
export function registerSttIpc(ipcMain: IpcMain): void {
	const manager = getSttManager();
	ipcMain.handle(
		"stt:transcribe",
		async (event, req: SttTranscribeRequest): Promise<SttTranscribeResponse> => {
			const senderId = event.sender.id;
			// Attach for the life of THIS request only. Overlapping requests each
			// own their own sink, so neither can silence the other on the way out.
			const detach = manager.addStatusSink((statusEvent) => {
				if (event.sender.id === senderId && !event.sender.isDestroyed()) {
					event.sender.send("stt:status", statusEvent);
				}
			});
			try {
				return await manager.transcribe(req);
			} finally {
				detach();
			}
		},
	);
	ipcMain.handle("stt:cancel", () => {
		manager.cancel();
	});
}
