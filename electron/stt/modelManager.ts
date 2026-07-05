import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Manages the lifetime of the on-disk model artifacts used by the STT stack.
 *
 * The model is downloaded as individual files from HuggingFace (SYSTRAN's
 * CTranslate2-format export of whisper-small). The files are placed in a
 * directory that CTranslate2's runtime loads directly.
 *
 * Each file is downloaded individually from HuggingFace's CDN, verified by
 * SHA-256, and written to the model directory atomically (via .partial rename)
 * to prevent partial downloads from being treated as complete.
 *
 * VAD is gone: word timestamps come from CTranslate2's `.align()` (real DTW
 * over Whisper's cross-attention weights), which makes Silero VAD unnecessary
 * for correctness. See `docs/engineering/stt-ctranslate2-migration.md`.
 *
 * SHA-256 verification stays — a tampered or partially-downloaded file is
 * surfaced as a "hash mismatch", not silently-wrong output.
 */

export type SttModelId = "whisper";

export interface SttModelFile {
	/** Relative path within the model directory (e.g. "model.bin"). */
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
	/** HuggingFace repo identifier (e.g. "SYSTRAN/faster-whisper-small"). */
	repoId: string;
	/** List of individual model files to download. */
	files: SttModelFile[];
}

const MODEL_BASE = "https://huggingface.co";
// ponytail: SYSTRAN/faster-whisper-small was fp16 (~470 MB on disk,
// CTranslate2 dequantizes to fp32 at load + runs Ruy/fp32 in our previous
// build → ~0.15× RTF, i.e. 3 min for a 30 s clip on the dev's Ryzen).
// The matching `.int8` variant ships weights already quantized to int8
// (~150 MB) and CTranslate2's INT8 compute path produces equivalent WER
// at ~5–10× the throughput on a real GEMM backend (oneDNN / OpenBLAS).
// File layout (model.bin + config.json + tokenizer.json + vocabulary.txt)
// matches the fp16 release.
const MODEL_REPO = "SYSTRAN/faster-whisper-small.int8";

export const STT_MODELS: Record<SttModelId, SttModelDescriptor> = {
	whisper: {
		cacheDir: "whisper-ct2",
		repoId: MODEL_REPO,
		files: [
			{
				name: "model.bin",
				url: `${MODEL_BASE}/${MODEL_REPO}/resolve/main/model.bin`,
				// ponytail: SHA-256 of the model.bin file from the SYSTRAN
				// faster-whisper-small int8 release on HuggingFace. Verify
				// against your own download before shipping a release, then
				// pin the actual digest here and remove the null.
				expectedSha256: null,
				approximateBytes: 150_000_000,
			},
			{
				name: "config.json",
				url: `${MODEL_BASE}/${MODEL_REPO}/resolve/main/config.json`,
				expectedSha256: null,
				approximateBytes: 1_000,
			},
			{
				name: "tokenizer.json",
				url: `${MODEL_BASE}/${MODEL_REPO}/resolve/main/tokenizer.json`,
				expectedSha256: null,
				approximateBytes: 5_000_000,
			},
			{
				name: "vocabulary.txt",
				url: `${MODEL_BASE}/${MODEL_REPO}/resolve/main/vocabulary.txt`,
				expectedSha256: null,
				approximateBytes: 900_000,
			},
		],
	},
};

export function modelPaths(baseDir: string): Record<SttModelId, string> {
	return {
		whisper: path.join(baseDir, STT_MODELS.whisper.cacheDir),
	};
}

/**
 * True when the unpacked CTranslate2 model directory exists and contains all
 * expected files (not just a partial download).
 */
export async function areModelsPresent(baseDir: string): Promise<boolean> {
	const paths = modelPaths(baseDir);
	const descriptor = STT_MODELS.whisper;
	try {
		const s = await stat(paths.whisper);
		if (!s.isDirectory()) return false;
		const entries = await readdir(paths.whisper);
		const expectedNames = new Set(descriptor.files.map((f) => f.name));
		const found = entries.filter((e) => expectedNames.has(e));
		return found.length === descriptor.files.length;
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
	// Skip if file already exists
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

/** Ensure every required model file is present locally; downloads with progress + retry. */
export async function ensureModels(opts: EnsureModelsOptions): Promise<void> {
	const targets = (opts.only ?? (["whisper"] as SttModelId[])).map((id) => ({
		id,
		descriptor: STT_MODELS[id],
		dir: modelPaths(opts.baseDir)[id],
	}));

	for (const { id, descriptor, dir } of targets) {
		if (await areModelsPresent(opts.baseDir)) continue;

		await mkdir(dir, { recursive: true });

		for (const file of descriptor.files) {
			const filePath = path.join(dir, file.name);
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
}
