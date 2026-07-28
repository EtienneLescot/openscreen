import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Manages the lifetime of the on-disk model artifact used by the STT stack.
 *
 * The model is a single GGML file downloaded from HuggingFace
 * (`ggerganov/whisper.cpp` — the model-file repo predates and is separate
 * from the `ggml-org` GitHub org the engine itself now lives under;
 * `ggml-org/whisper.cpp` on HuggingFace is a different, access-gated repo
 * and returns 401 on every file including README.md — confirmed by curl).
 * whisper.cpp bakes precision into the file, so
 * there is no runtime `--int8` flag; OpenScreen ships the q8_0 quantized
 * `small` multilingual model by default.
 *
 * The file is verified by SHA-256 and written atomically (via .partial rename)
 * to prevent partial downloads from being treated as complete.
 *
 * Word timestamps come from whisper.cpp's native DTW token timestamps, so no
 * separate VAD model is required. See `docs/engineering/stt-spec.md`.
 */

export type SttModelId = "whisper";

export interface SttModelFile {
	/** Relative path within the model directory (e.g. "ggml-small-q8_0.bin"). */
	name: string;
	/** HuggingFace resolve URL for this file. */
	url: string;
	/** Expected SHA-256 hex digest; null to skip verification. */
	expectedSha256: string | null;
	/** Approximate download size in bytes (for progress reporting). */
	approximateBytes: number;
}

export interface SttModelDescriptor {
	/** Display + cache directory name. */
	cacheDir: string;
	/** HuggingFace repo identifier (e.g. "ggerganov/whisper.cpp"). */
	repoId: string;
	/** List of model files to download (currently a single GGML file). */
	files: SttModelFile[];
}

const MODEL_BASE = "https://huggingface.co";
// ponytail: this is deliberately NOT "ggml-org/whisper.cpp" — that HF repo
// (matching the GitHub org the engine now lives under) is access-gated and
// returns 401 Unauthorized on every file, confirmed by curl. whisper.cpp's
// own models/download-ggml-model.sh pulls from ggerganov/whisper.cpp, the
// long-standing public model-file repo that never moved when the engine's
// GitHub org was renamed.
const MODEL_REPO = "ggerganov/whisper.cpp";
const MODEL_FILE = "ggml-small-q8_0.bin";

export const STT_MODELS: Record<SttModelId, SttModelDescriptor> = {
	whisper: {
		cacheDir: "whisper-ggml",
		repoId: MODEL_REPO,
		files: [
			{
				name: MODEL_FILE,
				url: `${MODEL_BASE}/${MODEL_REPO}/resolve/main/${MODEL_FILE}`,
				expectedSha256: "49C8FB02B65E6049D5FA6C04F81F53B867B5EC9540406812C643F177317F779F",
				approximateBytes: 264_000_000,
			},
		],
	},
};

export function modelPaths(baseDir: string): Record<SttModelId, string> {
	return {
		whisper: path.join(baseDir, STT_MODELS.whisper.cacheDir, MODEL_FILE),
	};
}

/**
 * True when the GGML model file exists and is non-empty.
 */
export async function areModelsPresent(baseDir: string): Promise<boolean> {
	const paths = modelPaths(baseDir);
	try {
		const s = await stat(paths.whisper);
		return s.isFile() && s.size > 0;
	} catch {
		return false;
	}
}

/** Verify SHA-256 of a file in 64 KiB chunks; resolves to the lowercase hex digest. */
export async function sha256OfFile(filePath: string): Promise<string> {
	const hash = createHash("sha256");
	await pipeline(createReadStream(filePath), hash);
	return hash.digest("hex");
}

const MAX_ATTEMPTS = 6;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number, retryAfter: string | null): number {
	if (retryAfter) {
		const secs = Number(retryAfter);
		if (Number.isFinite(secs)) return Math.min(60_000, secs * 1000);
		const at = Date.parse(retryAfter);
		if (!Number.isNaN(at)) return Math.min(60_000, Math.max(0, at - Date.now()));
	}
	return Math.min(60_000, 2_000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 1000);
}

async function fetchWithRetry(url: string, fetcher: typeof fetch): Promise<Response> {
	let lastErr: unknown;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			const res = await fetcher(url, {
				headers: { "user-agent": "openscreen-stt" },
			});
			if (res.ok && res.body) return res;
			if (res.status >= 400 && res.status < 500 && !RETRYABLE_STATUS.has(res.status)) {
				throw new Error(`Failed to download ${url}: HTTP ${res.status} ${res.statusText}`);
			}
			if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
				await sleep(backoffMs(attempt, res.headers.get("retry-after")));
				continue;
			}
			throw new Error(`Failed to download ${url}: HTTP ${res.status} ${res.statusText}`);
		} catch (err) {
			lastErr = err;
			if (err instanceof Error && err.message.startsWith("Failed to download")) {
				throw err;
			}
			if (attempt >= MAX_ATTEMPTS) throw err;
			await sleep(backoffMs(attempt, null));
		}
	}
	throw lastErr;
}

export interface DownloadOptions {
	/** Called with cumulative bytes for progress reporting. */
	onProgress?: (bytes: number) => void;
	/** Override fetch (for tests); defaults to `globalThis.fetch`. */
	fetcher?: typeof fetch;
}

/**
 * Stream a model file to disk atomically (<filename>.partial → rename on
 * success), optionally verify the SHA-256.
 *
 * If the file already exists and is non-empty, skips the download.
 */
async function ensureFile(
	filePath: string,
	fileUrl: string,
	expectedSha256: string | null,
	options: DownloadOptions = {},
): Promise<void> {
	if (existsSync(filePath)) {
		const s = await stat(filePath);
		if (s.isFile() && s.size > 0) {
			return;
		}
	}

	await mkdir(path.dirname(filePath), { recursive: true });

	const fetcher = options.fetcher ?? fetch;
	const res = await fetchWithRetry(fileUrl, fetcher);
	const tmp = `${filePath}.partial`;
	let downloaded = 0;

	const source = Readable.fromWeb(res.body as never);
	source.on("data", (chunk: Buffer | Uint8Array) => {
		downloaded += chunk.length;
		options.onProgress?.(downloaded);
	});
	const { createWriteStream } = await import("node:fs");
	await pipeline(source, createWriteStream(tmp));
	await rename(tmp, filePath);

	if (expectedSha256) {
		const actual = await sha256OfFile(filePath);
		if (actual.toLowerCase() !== expectedSha256.toLowerCase()) {
			await rename(filePath, `${filePath}.bad`).catch(() => undefined);
			throw new Error(
				`SHA-256 mismatch for ${path.basename(filePath)}: expected ${expectedSha256}, got ${actual}`,
			);
		}
	}
}

export interface EnsureModelsOptions {
	baseDir: string;
	/** Models to ensure; defaults to all (currently just `whisper`). */
	only?: SttModelId[];
	onProgress?: (event: {
		id: SttModelId;
		file: string;
		downloadedBytes: number;
		totalBytes: number;
	}) => void;
	fetcher?: typeof fetch;
}

/** Ensure the GGML model file is present locally; downloads with progress + retry. */
export async function ensureModels(opts: EnsureModelsOptions): Promise<void> {
	const targets = (opts.only ?? (["whisper"] as SttModelId[])).map((id) => ({
		id,
		descriptor: STT_MODELS[id],
		filePath: modelPaths(opts.baseDir)[id],
	}));

	for (const { id, descriptor, filePath } of targets) {
		if (await areModelsPresent(opts.baseDir)) continue;

		await mkdir(path.dirname(filePath), { recursive: true });

		const file = descriptor.files[0];
		await ensureFile(filePath, file.url, file.expectedSha256, {
			onProgress: (bytes) =>
				opts.onProgress?.({
					id,
					file: file.name,
					downloadedBytes: bytes,
					totalBytes: file.approximateBytes,
				}),
			fetcher: opts.fetcher,
		});
	}
}
