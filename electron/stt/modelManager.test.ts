import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
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

	it("exposes the whisper model descriptor with HF files", () => {
		expect(STT_MODELS.whisper.cacheDir).toBe("whisper-ct2");
		expect(STT_MODELS.whisper.repoId).toBe("SYSTRAN/faster-whisper-small.int8");
		expect(STT_MODELS.whisper.files.length).toBeGreaterThanOrEqual(4);
		const names = STT_MODELS.whisper.files.map((f) => f.name);
		expect(names).toContain("model.bin");
		expect(names).toContain("config.json");
		expect(names).toContain("tokenizer.json");
		expect(names).toContain("vocabulary.txt");
		for (const f of STT_MODELS.whisper.files) {
			expect(f.approximateBytes).toBeGreaterThan(0);
			expect(f.url).toContain("huggingface.co");
		}
	});

	it("modelPaths places the whisper dir under the cache directory", () => {
		const paths = modelPaths(dir);
		expect(paths.whisper).toBe(path.join(dir, "whisper-ct2"));
	});

	it("areModelsPresent returns false when no model directory exists", async () => {
		expect(await areModelsPresent(dir)).toBe(false);
	});

	it("areModelsPresent returns true once all model files are present", async () => {
		const paths = modelPaths(dir);
		await mkdir(paths.whisper, { recursive: true });
		// Empty dir — should still be false
		expect(await areModelsPresent(dir)).toBe(false);
		// One file — still incomplete
		await writeFile(path.join(paths.whisper, "config.json"), "{}");
		expect(await areModelsPresent(dir)).toBe(false);
		// All files present
		for (const f of STT_MODELS.whisper.files) {
			await writeFile(path.join(paths.whisper, f.name), "dummy");
		}
		expect(await areModelsPresent(dir)).toBe(true);
	});

	it("ensureModels succeeds when all files are already present (cache hit)", async () => {
		const paths = modelPaths(dir);
		await mkdir(paths.whisper, { recursive: true });
		for (const f of STT_MODELS.whisper.files) {
			await writeFile(path.join(paths.whisper, f.name), "dummy");
		}
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

	it("ensureModels downloads missing files individually with progress", async () => {
		const paths = modelPaths(dir);
		// Create model dir with nothing in it
		await mkdir(paths.whisper, { recursive: true });

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

		// Should have downloaded each file
		expect(fetches).toBe(STT_MODELS.whisper.files.length);
		// All files should exist now
		for (const f of STT_MODELS.whisper.files) {
			const fpath = path.join(paths.whisper, f.name);
			const s = await stat(fpath);
			expect(s.size).toBeGreaterThan(0);
		}
		// Progress was reported
		expect(progressCalls.length).toBeGreaterThanOrEqual(STT_MODELS.whisper.files.length);
	});

	it("ensureModels surfaces 4xx errors immediately instead of retrying", async () => {
		const paths = modelPaths(dir);
		await mkdir(paths.whisper, { recursive: true });

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

		// Should fail on the first file attempt
		expect(fetches).toBe(1);
	});

	it("ensureModels retries transient 5xx errors on individual files with bounded backoff", async () => {
		const paths = modelPaths(dir);
		await mkdir(paths.whisper, { recursive: true });

		const modelBinAttempts: number[] = [];
		const configJsonAttempts: number[] = [];
		const fetcher: typeof fetch = async (url: string) => {
			if (url.endsWith("model.bin")) {
				modelBinAttempts.push(modelBinAttempts.length + 1);
				// model.bin gets 503 first time, 200 second time
				if (modelBinAttempts.length <= 1) {
					return new Response("busy", {
						status: 503,
						statusText: "Service Unavailable",
					});
				}
				return new Response(Buffer.from("model weights"), { status: 200 });
			}
			configJsonAttempts.push(configJsonAttempts.length + 1);
			return new Response(Buffer.from("config"), { status: 200 });
		};

		await ensureModels({
			baseDir: dir,
			only: ["whisper"],
			fetcher,
			onProgress: () => undefined,
		});
		// model.bin was fetched twice (one retry after 503)
		expect(modelBinAttempts).toHaveLength(2);
		// Other files (config.json, tokenizer.json, vocabulary.txt) fetched once each
		expect(configJsonAttempts.length).toBeGreaterThanOrEqual(3);
	});
});
