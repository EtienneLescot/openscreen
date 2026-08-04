import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { areModelsPresent, ensureModels, modelPaths, STT_MODELS } from "./modelManager";

describe("modelManager", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(path.join(tmpdir(), "stt-models-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("exposes the whisper model descriptor with a single GGML file", () => {
		expect(STT_MODELS.whisper.cacheDir).toBe("whisper-ggml");
		expect(STT_MODELS.whisper.repoId).toBe("ggerganov/whisper.cpp");
		expect(STT_MODELS.whisper.files.length).toBe(1);
		expect(STT_MODELS.whisper.files[0].name).toBe("ggml-small-q8_0.bin");
		expect(STT_MODELS.whisper.files[0].expectedSha256).not.toBeNull();
		for (const f of STT_MODELS.whisper.files) {
			expect(f.approximateBytes).toBeGreaterThan(0);
			expect(f.url).toContain("huggingface.co");
			// Pinned to an immutable commit: resolving through `main` would let a
			// re-upload invalidate every cached model in the field at once.
			expect(f.url).toMatch(/\/resolve\/[0-9a-f]{40}\//);
		}
	});

	it("modelPaths places the GGML file under the cache directory", () => {
		const paths = modelPaths(dir);
		expect(paths.whisper).toBe(path.join(dir, "whisper-ggml", "ggml-small-q8_0.bin"));
	});

	it("areModelsPresent returns false when the model file is missing", async () => {
		expect(await areModelsPresent(dir)).toBe(false);
	});

	it("areModelsPresent returns true once the GGML file is present", async () => {
		const paths = modelPaths(dir);
		await mkdir(path.dirname(paths.whisper), { recursive: true });
		expect(await areModelsPresent(dir)).toBe(false);
		await writeFile(paths.whisper, "dummy-ggml");
		expect(await areModelsPresent(dir)).toBe(true);
	});

	it("ensureModels succeeds when the file is already present (cache hit)", async () => {
		const paths = modelPaths(dir);
		await mkdir(path.dirname(paths.whisper), { recursive: true });
		const cached = Buffer.from("dummy-ggml");
		await writeFile(paths.whisper, cached);
		const originalSha = STT_MODELS.whisper.files[0].expectedSha256;
		STT_MODELS.whisper.files[0].expectedSha256 = createHash("sha256").update(cached).digest("hex");
		let fetches = 0;
		const fetcher: typeof fetch = async () => {
			fetches++;
			return new Response("should not be reached", { status: 200 });
		};
		try {
			await ensureModels({
				baseDir: dir,
				only: ["whisper"],
				fetcher,
				onProgress: () => undefined,
			});
			expect(fetches).toBe(0);
		} finally {
			STT_MODELS.whisper.files[0].expectedSha256 = originalSha;
		}
	});

	it("re-downloads a non-empty cached model when its checksum is wrong", async () => {
		const paths = modelPaths(dir);
		await mkdir(path.dirname(paths.whisper), { recursive: true });
		await writeFile(paths.whisper, "corrupt-cache");
		const replacement = Buffer.from("verified-ggml-weights");
		const originalSha = STT_MODELS.whisper.files[0].expectedSha256;
		STT_MODELS.whisper.files[0].expectedSha256 = createHash("sha256")
			.update(replacement)
			.digest("hex");
		let fetches = 0;
		const fetcher: typeof fetch = async () => {
			fetches++;
			return new Response(replacement, { status: 200 });
		};

		try {
			await ensureModels({ baseDir: dir, only: ["whisper"], fetcher });
			expect(fetches).toBe(1);
			expect(await readFile(paths.whisper)).toEqual(replacement);
			// The stale copy is displaced by the atomic rename, not quarantined
			// beside it: a `.bad` sibling would strand 264 MB nothing ever reaps.
			expect(existsSync(`${paths.whisper}.bad`)).toBe(false);
			expect(existsSync(`${paths.whisper}.partial`)).toBe(false);
		} finally {
			STT_MODELS.whisper.files[0].expectedSha256 = originalSha;
		}
	});

	it("never lets a mismatching download occupy the live model path", async () => {
		const paths = modelPaths(dir);
		const originalSha = STT_MODELS.whisper.files[0].expectedSha256;
		STT_MODELS.whisper.files[0].expectedSha256 = createHash("sha256")
			.update("the-weights-we-asked-for")
			.digest("hex");
		const served = Buffer.from("truncated-or-tampered-weights");
		const fetcher: typeof fetch = async () => new Response(served, { status: 200 });

		try {
			await expect(ensureModels({ baseDir: dir, only: ["whisper"], fetcher })).rejects.toThrow(
				/SHA-256 mismatch/,
			);
			expect(existsSync(paths.whisper)).toBe(false);
			expect(existsSync(`${paths.whisper}.partial`)).toBe(false);
		} finally {
			STT_MODELS.whisper.files[0].expectedSha256 = originalSha;
		}
	});

	it("keeps the cached model when the replacement download also mismatches", async () => {
		const paths = modelPaths(dir);
		await mkdir(path.dirname(paths.whisper), { recursive: true });
		await writeFile(paths.whisper, "the-only-copy-the-user-has");
		const originalSha = STT_MODELS.whisper.files[0].expectedSha256;
		STT_MODELS.whisper.files[0].expectedSha256 = createHash("sha256")
			.update("the-weights-we-asked-for")
			.digest("hex");
		const fetcher: typeof fetch = async () =>
			new Response(Buffer.from("also-wrong"), { status: 200 });

		try {
			await expect(ensureModels({ baseDir: dir, only: ["whisper"], fetcher })).rejects.toThrow(
				/SHA-256 mismatch/,
			);
			expect(await readFile(paths.whisper, "utf8")).toBe("the-only-copy-the-user-has");
		} finally {
			STT_MODELS.whisper.files[0].expectedSha256 = originalSha;
		}
	});

	it("ensureModels downloads the missing GGML file with progress", async () => {
		const paths = modelPaths(dir);
		const originalSha = STT_MODELS.whisper.files[0].expectedSha256;
		STT_MODELS.whisper.files[0].expectedSha256 = null;

		const progressCalls: Array<{
			id: string;
			file: string;
			bytes: number;
		}> = [];
		let fetches = 0;

		const fetcher: typeof fetch = async (input) => {
			fetches++;
			// ensureModels passes a plain string URL, but a `typeof fetch` stub has to
			// honour the whole signature (string | URL | Request).
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const content = Buffer.from(`content-for-${url.split("/").pop()}`);
			return new Response(content, { status: 200 });
		};

		try {
			await ensureModels({
				baseDir: dir,
				only: ["whisper"],
				fetcher,
				onProgress: (ev) => {
					progressCalls.push({
						id: ev.id,
						file: ev.file,
						bytes: ev.downloadedBytes,
					});
				},
			});

			expect(fetches).toBe(1);
			const s = await stat(paths.whisper);
			expect(s.size).toBeGreaterThan(0);
			expect(progressCalls.length).toBeGreaterThanOrEqual(1);
			expect(progressCalls[0].file).toBe("ggml-small-q8_0.bin");
		} finally {
			STT_MODELS.whisper.files[0].expectedSha256 = originalSha;
		}
	});

	it("ensureModels surfaces 4xx errors immediately instead of retrying", async () => {
		let fetches = 0;
		const fetcher: typeof fetch = async () => {
			fetches++;
			return new Response("auth required", {
				status: 401,
				statusText: "Unauthorized",
			});
		};

		await expect(
			ensureModels({
				baseDir: dir,
				only: ["whisper"],
				fetcher,
				onProgress: () => undefined,
			}),
		).rejects.toThrow(/HTTP 401/);

		expect(fetches).toBe(1);
	});

	it("ensureModels retries transient 5xx errors with bounded backoff", async () => {
		const originalSha = STT_MODELS.whisper.files[0].expectedSha256;
		STT_MODELS.whisper.files[0].expectedSha256 = null;
		const attempts: number[] = [];
		const fetcher: typeof fetch = async () => {
			attempts.push(attempts.length + 1);
			if (attempts.length <= 1) {
				return new Response("busy", {
					status: 503,
					statusText: "Service Unavailable",
				});
			}
			return new Response(Buffer.from("ggml weights"), { status: 200 });
		};

		try {
			await ensureModels({
				baseDir: dir,
				only: ["whisper"],
				fetcher,
				onProgress: () => undefined,
			});
			expect(attempts).toHaveLength(2);
		} finally {
			STT_MODELS.whisper.files[0].expectedSha256 = originalSha;
		}
	});
});
