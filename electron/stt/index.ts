import path from "node:path";
import { app, type IpcMain } from "electron";
import { ensureModels, modelPaths } from "./modelManager";
import type {
	SttStatusEvent,
	SttTranscribeRequest,
	SttTranscribeResponse,
} from "./transcriptionContract";
import { WhisperServerManager } from "./whisperServer";

/**
 * Owner of the long-lived STT pipeline. One instance per Electron app.
 *
 * Workflow:
 *   1. `init()` spawns `whisper-stt-server` (or queues the call if it's busy).
 *   2. `transcribe()` proxies the renderer's `Float32Array` through
 *      whisper-stt-server's HTTP `/inference`, which returns both phrase- and
 *      word-level segments in one pass (see whisperServer.ts). Word
 *      timestamps come from whisper.cpp's native DTW token timestamps
 *      (`t_dtw`, SMALL aheads preset, `flash_attn = false`), see
 *      docs/engineering/stt-spec.md § Decision rationale.
 *   3. `shutdown()` tears down on app quit.
 *
 * Status events fan out via `statusSink` so the renderer can drive its
 * "loading model" / "transcribing" indicator.
 */

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
			this.initPromise = this.prepare();
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
		await this.server.start({ modelPath: paths.whisper });
		this.emit({ phase: "transcribe" });
	}

	/** Run one transcription request through whisper-stt-server. */
	async transcribe(req: SttTranscribeRequest): Promise<SttTranscribeResponse> {
		await this.init();
		this.emit({ phase: "transcribe" });
		const phrase = await this.server.transcribe({
			samples: req.samples,
			language: req.language,
		});
		const backend = phrase.backend ?? this.server.status.backend ?? "whispercpp-cpu";
		return {
			segments: phrase.segments,
			wordSegments: phrase.wordSegments,
			detectedLanguage: phrase.detectedLanguage,
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
