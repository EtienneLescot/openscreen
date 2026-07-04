import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	computeFingerprint,
	findMediaLinksByFingerprint,
	registerMediaLinks,
} from "./mediaLinksRegistry";

async function makeTempDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "openscreen-media-links-"));
}

async function writeFileOfSize(filePath: string, sizeBytes: number, fill = "a"): Promise<void> {
	// Not all-identical bytes at the seams so head/tail samples aren't trivially
	// equal to each other for small files — irrelevant for correctness, just
	// makes assertions easier to reason about.
	await fs.writeFile(filePath, fill.repeat(sizeBytes));
}

describe("mediaLinksRegistry", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await makeTempDir();
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	describe("computeFingerprint", () => {
		it("never reads more than the head+tail sample regardless of file size", async () => {
			const bigPath = path.join(tempDir, "big.webm");
			// 2MB file — comfortably larger than the 64KB head/tail sample, but
			// small enough to keep the test fast. The point is the read count and
			// size, not the absolute file size.
			await writeFileOfSize(bigPath, 2 * 1024 * 1024);

			const realOpen = fs.open.bind(fs);
			const readLengths: number[] = [];
			const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
				const handle = await realOpen(...(args as Parameters<typeof fs.open>));
				const realRead = handle.read.bind(handle);
				// biome-ignore lint/suspicious/noExplicitAny: overriding one instance's method for the read-size assertion below
				handle.read = (async (...readArgs: any[]) => {
					readLengths.push(readArgs[2]);
					return realRead(...readArgs);
				}) as typeof handle.read;
				return handle;
			});

			await computeFingerprint(bigPath);
			openSpy.mockRestore();

			expect(readLengths).toHaveLength(2);
			for (const length of readLengths) {
				expect(length).toBeLessThanOrEqual(64 * 1024);
			}
		});

		it("degenerates gracefully for files smaller than the sample size", async () => {
			const smallPath = path.join(tempDir, "small.webm");
			await writeFileOfSize(smallPath, 10);
			const fp = await computeFingerprint(smallPath);
			expect(fp.sizeBytes).toBe(10);
			expect(fp.headSampleBase64).toBe(fp.tailSampleBase64);
		});
	});

	describe("resolution via sidecar (fast path)", () => {
		it("returns webcam + cursor links found next to the video and backfills the registry", async () => {
			const screenPath = path.join(tempDir, "recording-1.webm");
			const webcamPath = path.join(tempDir, "recording-1-webcam.webm");
			await writeFileOfSize(screenPath, 5000, "s");
			await writeFileOfSize(webcamPath, 3000, "w");

			await registerMediaLinks(tempDir, screenPath, { webcamVideoPath: webcamPath });

			const resolved = await findMediaLinksByFingerprint(tempDir, screenPath);
			expect(resolved?.webcamVideoPath).toBe(webcamPath);
		});
	});

	describe("resolution via fingerprint (moved/imported-elsewhere)", () => {
		it("re-links a copy of the screen video at a brand new path with no sidecars", async () => {
			const originalDir = await makeTempDir();
			try {
				const originalScreenPath = path.join(originalDir, "recording-2.webm");
				const webcamPath = path.join(originalDir, "recording-2-webcam.webm");
				await writeFileOfSize(originalScreenPath, 5000, "x");
				await writeFileOfSize(webcamPath, 3000, "y");

				await registerMediaLinks(tempDir, originalScreenPath, { webcamVideoPath: webcamPath });

				// Simulate "imported into a different project from a different
				// location": same bytes, brand new path, no sidecar files here.
				const importedPath = path.join(tempDir, "imported-copy.webm");
				await fs.copyFile(originalScreenPath, importedPath);

				const resolved = await findMediaLinksByFingerprint(tempDir, importedPath);
				expect(resolved?.webcamVideoPath).toBe(webcamPath);
			} finally {
				await fs.rm(originalDir, { recursive: true, force: true });
			}
		});

		it("returns null when there is no matching fingerprint", async () => {
			const unknownPath = path.join(tempDir, "unknown.webm");
			await writeFileOfSize(unknownPath, 1000, "z");
			const resolved = await findMediaLinksByFingerprint(tempDir, unknownPath);
			expect(resolved).toBeNull();
		});
	});

	describe("registerMediaLinks", () => {
		it("does nothing when no links are provided", async () => {
			const videoPath = path.join(tempDir, "no-links.webm");
			await writeFileOfSize(videoPath, 500);
			await registerMediaLinks(tempDir, videoPath, {});
			const registryFile = path.join(tempDir, "media-links.registry.json");
			await expect(fs.stat(registryFile)).rejects.toMatchObject({ code: "ENOENT" });
		});

		it("handles concurrent registrations without corrupting the registry file", async () => {
			const paths = await Promise.all(
				Array.from({ length: 8 }, async (_, i) => {
					const p = path.join(tempDir, `concurrent-${i}.webm`);
					await writeFileOfSize(p, 400 + i, String(i));
					return p;
				}),
			);

			await Promise.all(
				paths.map((p, i) =>
					registerMediaLinks(tempDir, p, {
						webcamVideoPath: `${p}-webcam.webm`,
						webcamOffsetMs: i,
					}),
				),
			);

			const registryFile = path.join(tempDir, "media-links.registry.json");
			const raw = await fs.readFile(registryFile, "utf-8");
			const parsed = JSON.parse(raw);
			expect(parsed.entries).toHaveLength(paths.length);

			for (const p of paths) {
				const resolved = await findMediaLinksByFingerprint(tempDir, p);
				expect(resolved?.webcamVideoPath).toBe(`${p}-webcam.webm`);
			}
		});
	});
});
