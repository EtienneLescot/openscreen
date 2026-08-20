import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	computeFingerprint,
	findMediaLinksByFingerprint,
	findRelocatedMediaByStoredPath,
	registerMediaLinks,
	whenRegistryIdle,
} from "./mediaLinksRegistry";

async function makeTempDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "openscreen-media-links-"));
}

/**
 * `fs.rm` that is allowed to lose a race against a write landing in the directory.
 *
 * `force: true` covers ENOENT — the write lost and the path is already gone — but
 * NOT ENOTEMPTY, which is what the write WINNING looks like: it recreates an entry
 * between rm's recursive walk and its final rmdir. `fs.rm` does not retry unless
 * asked (`maxRetries` defaults to 0), so that rejection escapes and fails whichever
 * test or hook was running.
 *
 * This suite races a write against removal on purpose (see "survives the directory
 * disappearing while the refresh is queued"), and every `afterEach` inherits the
 * same exposure because a queued refresh can outlive the test that started it.
 * Losing is explicitly fine — the contract under test is that no rejection escapes
 * into the process, not that the removal succeeds. The retries are so the temp dir
 * still usually gets cleaned up; the catch is so a loss is never a red test.
 *
 * Seen twice on CI, once on a `main` push (run 31279698618), and reproduced 14
 * times in 40 locally by racing a write against `fs.rm` over a large tree.
 */
async function rmBestEffort(dir: string): Promise<void> {
	try {
		await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw err;
	}
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
		await rmBestEffort(tempDir);
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
		it("finds a registry-known recording from a stale cross-platform path", async () => {
			const currentDir = path.join(tempDir, "current-machine");
			await fs.mkdir(currentDir, { recursive: true });
			const currentScreenPath = path.join(currentDir, "recording-42.mp4");
			const webcamPath = path.join(currentDir, "recording-42-webcam.mp4");
			await writeFileOfSize(currentScreenPath, 5_000, "s");
			await writeFileOfSize(webcamPath, 3_000, "w");
			await registerMediaLinks(tempDir, currentScreenPath, { webcamVideoPath: webcamPath });

			const resolved = await findRelocatedMediaByStoredPath(
				tempDir,
				"C:\\Users\\demo\\recording-42.mp4",
				5_000,
			);
			expect(resolved).toMatchObject({
				screenVideoPath: currentScreenPath,
				webcamVideoPath: webcamPath,
			});
		});

		it("refuses to guess when multiple existing recordings match the stored name and size", async () => {
			for (const [folder, fill] of [
				["first", "a"],
				["second", "b"],
			] as const) {
				const currentDir = path.join(tempDir, folder);
				await fs.mkdir(currentDir, { recursive: true });
				const screenPath = path.join(currentDir, "recording.mp4");
				await writeFileOfSize(screenPath, 5_000, fill);
				await registerMediaLinks(tempDir, screenPath, {
					webcamVideoPath: `${screenPath}.webcam`,
				});
			}

			await expect(
				findRelocatedMediaByStoredPath(tempDir, "C:\\Users\\demo\\recording.mp4", 5_000),
			).resolves.toBeNull();
		});

		it("rejects a registry candidate whose contents changed after registration", async () => {
			const screenPath = path.join(tempDir, "recording-changed.mp4");
			await writeFileOfSize(screenPath, 5_000, "a");
			await registerMediaLinks(tempDir, screenPath, {
				webcamVideoPath: `${screenPath}.webcam`,
			});
			await writeFileOfSize(screenPath, 5_001, "b");

			await expect(
				findRelocatedMediaByStoredPath(tempDir, "C:\\Users\\demo\\recording-changed.mp4", 5_000),
			).resolves.toBeNull();
		});

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

	// `findMediaLinksByFingerprint` is a READ that writes: when the path has
	// drifted it refreshes `lastKnownPath` in the background. Not awaiting that
	// write is the right call — a lookup should not pay for it — but it means
	// nothing is watching the promise, and a rejected promise nobody watches is a
	// process-level `unhandledRejection`. Under vitest that fails the run from
	// OUTSIDE every test, which is how this was found: 1628 passing tests, a red
	// job, and a stack pointing at a temp dir a finished suite had removed.
	//
	// Both cases below assert the same thing in two ways a real machine produces
	// it. Neither asserts that the refresh succeeds — that is precisely what is
	// allowed to fail.
	describe("the background path refresh", () => {
		/** Same bytes at a second path, so a lookup matches by fingerprint and
		 *  then tries to write the new path back. */
		async function registerThenMove(): Promise<{ original: string; moved: string }> {
			const original = path.join(tempDir, "moved.webm");
			await writeFileOfSize(original, 900, "m");
			await registerMediaLinks(tempDir, original, { webcamVideoPath: `${original}-cam.webm` });
			const moved = path.join(tempDir, "moved-elsewhere.webm");
			await fs.copyFile(original, moved);
			return { original, moved };
		}

		async function withoutUnhandledRejections(fn: () => Promise<void>): Promise<unknown[]> {
			const rejections: unknown[] = [];
			const onRejection = (reason: unknown) => rejections.push(reason);
			process.on("unhandledRejection", onRejection);
			try {
				await fn();
				// The refresh these cases are about is deliberately not awaited by the
				// lookup, so `fn` returns while it is still queued. Waiting for the
				// queue to drain is what makes "did the refresh warn / write?"
				// answerable at all — the 50 ms below used to be doing that job by
				// accident, and lost the race whenever the suite ran under load.
				await whenRegistryIdle();
				// Node decides a rejection is unhandled a tick after the microtask
				// queue drains, so the assertion needs a real timer, not a flush.
				await new Promise((resolve) => setTimeout(resolve, 50));
			} finally {
				process.off("unhandledRejection", onRejection);
			}
			return rejections;
		}

		// The failure is INJECTED, not arranged with `chmod 0o555`. A read-only
		// directory does not stop a file being created inside it on Windows, so the
		// refresh wrote fine there and this case failed on every Windows dev machine
		// while staying green in Linux CI. `skipIf(getuid() === 0)` could not see it
		// either: `process.getuid` is undefined on Windows, so the guard read as
		// "not root" and ran the test anyway. Failing the write itself asserts the
		// same thing on every platform, root or not.
		it("logs a refresh it cannot write, and still answers the lookup", async () => {
			const { original, moved } = await registerThenMove();
			const warned = vi.spyOn(console, "warn").mockImplementation(() => {
				// swallowed: the test asserts on it, the suite output does not need it
			});
			// Registry readable, the tmp-file write refused: only the write can fail.
			const write = vi
				.spyOn(fs, "writeFile")
				.mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EACCES" }));
			try {
				const rejections = await withoutUnhandledRejections(async () => {
					const resolved = await findMediaLinksByFingerprint(tempDir, moved);
					// A refresh that failed is not a lookup that failed.
					expect(resolved?.webcamVideoPath).toBe(`${original}-cam.webm`);
				});
				expect(rejections).toEqual([]);
				expect(warned).toHaveBeenCalled();
				// The refresh was really attempted: without this the case would pass
				// just as well with the whole write path deleted.
				expect(write).toHaveBeenCalled();
			} finally {
				write.mockRestore();
				warned.mockRestore();
			}
		});

		// The drain the two cases above rely on. Without it there is no way to know
		// the refresh has landed: the lookup returns while the write is still
		// queued, so a caller that removes the directory races it and a test that
		// asserts on its outcome is asserting on a coin flip. Both were real
		// intermittent failures in the full suite (this file, and cursorSidecar's
		// `afterEach` failing with ENOTEMPTY), green in isolation every time.
		it("whenRegistryIdle waits for a refresh the lookup did not await", async () => {
			const { original, moved } = await registerThenMove();
			const recorded = async () =>
				JSON.parse(await fs.readFile(path.join(tempDir, "media-links.registry.json"), "utf-8"))
					.entries[0].lastKnownPath;

			expect(await recorded()).toBe(original);
			await findMediaLinksByFingerprint(tempDir, moved);
			await whenRegistryIdle(tempDir);

			// Durably on disk, not "probably by now".
			expect(await recorded()).toBe(moved);
		});

		it("survives the directory disappearing while the refresh is queued", async () => {
			// The CI shape: a suite's `afterEach` removes its temp dir while a write
			// is still in the queue. Whoever wins the race is fine — what must not
			// happen is a rejection escaping into the process.
			const { moved } = await registerThenMove();
			const warned = vi.spyOn(console, "warn").mockImplementation(() => {
				// may or may not fire: the write is allowed to win the race
			});
			try {
				const rejections = await withoutUnhandledRejections(async () => {
					const lookup = findMediaLinksByFingerprint(tempDir, moved);
					await rmBestEffort(tempDir);
					await lookup;
				});
				expect(rejections).toEqual([]);
			} finally {
				warned.mockRestore();
				await fs.mkdir(tempDir, { recursive: true });
			}
		});
	});
});
