import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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
		await writeFile(paths.whisper, "dummy-ggml");
		let fetches = 0;
		const fetcher: typeof fetch = async () => {
			fetches++;
			return new Response("should not be reached", { status: 200 });
		};
		await ensureModels({
			baseDir: dir,
			only: ["whisper"],
			fetcher,
			onProgress: () => undefined,
		});
		expect(fetches).toBe(0);
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

		const fetcher: typeof fetch = async (url: string) => {
			fetches++;
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
