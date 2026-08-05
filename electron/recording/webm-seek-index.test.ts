import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reindexRecordingOnDisk } from "./webm-seek-index";

/** The platforms whose native helpers already write an indexed file. */
const NON_LINUX = ["darwin", "win32"] as const;

/**
 * The property under test is not "does libavformat work" — the Rust side owns
 * that, and `crates/compositor/tests/remux_seek_index.rs` proves it. It is the
 * far more expensive-to-get-wrong half: a failed re-index must never cost the
 * user a recording. So the addon is stubbed and every way it can fail is driven
 * through the wrapper, asserting each time that the original bytes survive.
 */
describe("recording re-index", () => {
	let dir: string;
	const ORIGINAL = "original recording bytes";
	const REAL_PLATFORM = process.platform;

	const setPlatform = (value: NodeJS.Platform) =>
		Object.defineProperty(process, "platform", { value, configurable: true });

	/**
	 * Pin the platform, because the wrapper is Linux-gated and returns
	 * `unsupported-platform` before it touches anything else. Left to the real
	 * platform, every case below stops at that guard and asserts nothing on a
	 * macOS or Windows checkout — where this suite read as six red tests that
	 * were neither the contributor's fault nor a real regression.
	 */
	beforeEach(async () => {
		setPlatform("linux");
		dir = await mkdtemp(path.join(tmpdir(), "openscreen-reindex-"));
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
	});

	afterEach(async () => {
		setPlatform(REAL_PLATFORM);
		await rm(dir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	async function makeRecording(name = "recording-1.webm"): Promise<string> {
		const filePath = path.join(dir, name);
		await writeFile(filePath, ORIGINAL);
		return filePath;
	}

	/** Stands in for the napi addon: writes `output` then reports success. */
	const fakeRemux = (payload: string) => ({
		remuxSeekable: vi.fn(async (_input: string, output: string) => {
			await writeFile(output, payload);
			return { packets: 42, streams: 2, wallS: 0.05 };
		}),
	});

	it("replaces the file with the remuxed output on success", async () => {
		const filePath = await makeRecording();
		const service = fakeRemux("remuxed bytes");

		const result = await reindexRecordingOnDisk(filePath, service);

		expect(result).toEqual({ reindexed: true, packets: 42, streams: 2, wallS: 0.05 });
		expect(await readFile(filePath, "utf8")).toBe("remuxed bytes");
	});

	it("writes to a temporary sibling and leaves none behind", async () => {
		const filePath = await makeRecording();
		const service = fakeRemux("remuxed bytes");

		await reindexRecordingOnDisk(filePath, service);

		// Same directory as the recording, so the rename is same-filesystem and
		// therefore atomic — a temp dir could be another mount.
		const outputArg = service.remuxSeekable.mock.calls[0][1];
		expect(path.dirname(outputArg)).toBe(path.dirname(filePath));
		expect(outputArg).not.toBe(filePath);
		await expect(stat(outputArg)).rejects.toThrow();
	});

	it("keeps the original when the remux throws", async () => {
		const filePath = await makeRecording();
		const service = {
			remuxSeekable: vi.fn(async () => {
				throw new Error("avformat_open_input a échoué (ret=-2)");
			}),
		};

		const result = await reindexRecordingOnDisk(filePath, service);

		expect(result).toEqual({ reindexed: false, reason: "remux-failed" });
		expect(await readFile(filePath, "utf8")).toBe(ORIGINAL);
	});

	it("keeps the original when the remux leaves a truncated 0-byte file", async () => {
		// A muxer that errors after opening its output still leaves a file behind.
		// Renaming that over the recording would destroy it.
		const filePath = await makeRecording();
		const service = {
			remuxSeekable: vi.fn(async (_input: string, output: string) => {
				await writeFile(output, "");
				return { packets: 0, streams: 0, wallS: 0.01 };
			}),
		};

		const result = await reindexRecordingOnDisk(filePath, service);

		expect(result).toEqual({ reindexed: false, reason: "empty-output" });
		expect(await readFile(filePath, "utf8")).toBe(ORIGINAL);
	});

	it("keeps the original when the addon is absent", async () => {
		const filePath = await makeRecording();
		const service = { remuxSeekable: vi.fn(async () => null) };

		const result = await reindexRecordingOnDisk(filePath, service);

		expect(result).toEqual({ reindexed: false, reason: "no-addon" });
		expect(await readFile(filePath, "utf8")).toBe(ORIGINAL);
	});

	it("clears a stale temporary file left by an earlier interrupted run", async () => {
		const filePath = await makeRecording();
		const stalePath = `${filePath}.reindex.tmp`;
		await writeFile(stalePath, "leftover from a crashed save");
		const service = fakeRemux("remuxed bytes");

		const result = await reindexRecordingOnDisk(filePath, service);

		expect(result).toMatchObject({ reindexed: true });
		expect(await readFile(filePath, "utf8")).toBe("remuxed bytes");
	});

	// Both platforms the guard is there for, so the Linux pin above can never
	// quietly become the only thing this suite ever exercises.
	it.each(NON_LINUX)("does nothing on %s, which captures an index already", async (platform) => {
		const filePath = await makeRecording();
		const service = fakeRemux("remuxed bytes");
		setPlatform(platform);

		const result = await reindexRecordingOnDisk(filePath, service);

		expect(result).toEqual({ reindexed: false, reason: "unsupported-platform" });
		expect(service.remuxSeekable).not.toHaveBeenCalled();
		expect(await readFile(filePath, "utf8")).toBe(ORIGINAL);
	});
});
