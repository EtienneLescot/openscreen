import path from "node:path";
import { app, type IpcMain } from "electron";
import { planChunks } from "./chunking";
import { ensureModels, modelPaths } from "./modelManager";
import type {
	SttPhraseSegment,
	SttStatusEvent,
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
 * Status events fan out via `statusSink` so the renderer can drive its
 * "loading model" / "transcribing" indicator.
 *
 * Why chunked rather than one request: a 30-minute recording took ~10 minutes
 * in a single `/inference` call — no progress to show, no way to recover from a
 * transient failure without redoing everything, and long enough that the HTTP
 * client's own header timeout killed it before whisper ever answered. Chunks
 * turn that into a progress signal and a retry unit.
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

export interface SttManagerInitOptions {
	statusSink?: (event: SttStatusEvent) => void;
	/** Override the models cache directory; defaults to `app.getPath("userData") + "/stt-models"`. */
	modelsBaseDir?: string;
}

export class SttManager {
	private readonly server = new WhisperServerManager();
	private modelsBaseDir: string | null = null;
	private statusSink: ((event: SttStatusEvent) => void) | null = null;
	private initPromise: Promise<void> | null = null;
	/** Kept from `prepare()` so a chunk retry can respawn a helper that died mid-run. */
	private modelPath: string | null = null;

	/** Wire a sink for the renderer status channel. */
	setStatusSink(sink: ((event: SttStatusEvent) => void) | null): void {
		this.statusSink = sink;
	}

	/** Read the currently-installed status sink (mostly for tests). */
	getStatusSink(): ((event: SttStatusEvent) => void) | null {
		return this.statusSink;
	}

	private emit(event: SttStatusEvent): void {
		this.statusSink?.(event);
	}

	/**
	 * Run all one-time setup; cheap to call repeatedly — the `initPromise`
	 * means the second caller just awaits the same completion.
	 */
	init(options: SttManagerInitOptions = {}): Promise<void> {
		if (options.statusSink) this.statusSink = options.statusSink;
		if (options.modelsBaseDir) this.modelsBaseDir = options.modelsBaseDir;
		if (!this.initPromise) {
			// A REJECTED init must not be cached. `prepare()` downloads a 253 MB
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

		const paths = modelPaths(modelsDir);
		this.modelPath = paths.whisper;
		await this.server.start({ modelPath: paths.whisper });
		this.emit({ phase: "transcribe" });
	}

	/**
	 * Run one chunk, retrying a few times before giving up on the whole request.
	 *
	 * A failure here is usually the helper process dying (OOM, driver reset)
	 * rather than a bad chunk, so each retry first re-runs `server.start()` —
	 * idempotent when the helper is alive, a respawn when it isn't. That is what
	 * makes a 30-minute transcription survive one bad minute instead of losing
	 * the twenty that already succeeded.
	 */
	private async transcribeChunk(
		samples: Float32Array,
		language: string | undefined,
	): Promise<Awaited<ReturnType<WhisperServerManager["transcribe"]>>> {
		let lastError: unknown;
		for (let attempt = 1; attempt <= CHUNK_ATTEMPTS; attempt++) {
			try {
				return await this.server.transcribe({ samples, language });
			} catch (error) {
				lastError = error;
				if (attempt === CHUNK_ATTEMPTS) break;
				if (this.modelPath) {
					await this.server.start({ modelPath: this.modelPath }).catch(() => undefined);
				}
				await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
			}
		}
		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	}

	/** Transcribe a whole recording, chunk by chunk, reporting progress as it goes. */
	async transcribe(req: SttTranscribeRequest): Promise<SttTranscribeResponse> {
		await this.init();

		const totalSec = req.samples.length / SAMPLE_RATE;
		const chunks = planChunks(req.samples, SAMPLE_RATE);
		this.emit({ phase: "transcribe", completedSec: 0, totalSec });

		const segments: SttPhraseSegment[] = [];
		const wordSegments: SttWordSegment[] = [];
		let detectedLanguage: string | null = null;
		let backend = this.server.status.backend ?? "whispercpp-cpu";
		// Only the first chunk auto-detects. Every later chunk is forced onto that
		// language: whisper can otherwise flip mid-recording on a chunk that opens
		// with a proper noun or a silence, and "transcribe" the rest as another
		// language entirely.
		let language = req.language;

		for (const chunk of chunks) {
			const offsetSec = chunk.startSample / SAMPLE_RATE;
			const result = await this.transcribeChunk(
				req.samples.subarray(chunk.startSample, chunk.endSample),
				language,
			);
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
			this.emit({
				phase: "transcribe",
				completedSec: chunk.endSample / SAMPLE_RATE,
				totalSec,
			});
		}

		return {
			segments,
			wordSegments,
			detectedLanguage: detectedLanguage ?? req.language ?? "auto",
			backend,
		};
	}

	/** Best-effort shutdown; safe to call from `before-quit` hooks. */
	async shutdown(): Promise<void> {
		await this.server.stop();
	}
}

let singleton: SttManager | null = null;

/** Lazy singleton for the IPC layer; processes one transcription at a time. */
export function getSttManager(): SttManager {
	if (!singleton) singleton = new SttManager();
	return singleton;
}

/** Reset the singleton — for tests. */
export function _resetSttManagerForTests(): void {
	singleton = null;
}

/**
 * Wire the IPC channel. Call this from `registerIpcHandlers` so the renderer
 * can `invoke("stt:transcribe", request)` and receive `SttTranscribeResponse`.
 * Status events fan out on `"stt:status"` (main → renderer push), scoped to
 * the calling `webContents` so two windows don't cross-talk.
 */
export function registerSttIpc(ipcMain: IpcMain): void {
	const manager = getSttManager();
	ipcMain.handle(
		"stt:transcribe",
		async (event, req: SttTranscribeRequest): Promise<SttTranscribeResponse> => {
			const senderId = event.sender.id;
			const previous = manager.getStatusSink();
			manager.setStatusSink((statusEvent) => {
				if (event.sender.id === senderId && !event.sender.isDestroyed()) {
					event.sender.send("stt:status", statusEvent);
				}
			});
			try {
				return await manager.transcribe(req);
			} finally {
				manager.setStatusSink(previous);
			}
		},
	);
}
