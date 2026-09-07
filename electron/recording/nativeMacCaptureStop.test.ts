import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isSalvageableNativeMacCapture, resolveNativeMacCaptureStop } from "./nativeMacCaptureStop";

let dir: string;
const validVideoFixture = path.resolve("website/static/video/webcam.mp4");

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "native-mac-stop-"));
});

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

function atom(type: string, payloadBytes: number) {
	const result = Buffer.alloc(8 + payloadBytes);
	result.writeUInt32BE(result.length, 0);
	result.write(type, 4, 4, "ascii");
	return result;
}

async function writeMp4(name: string, atoms: Buffer[]): Promise<string> {
	const filePath = path.join(dir, name);
	await fs.writeFile(filePath, Buffer.concat(atoms));
	return filePath;
}

describe("isSalvageableNativeMacCapture", () => {
	it("accepts an MP4 with a parseable video stream after helper exit", async () => {
		await expect(isSalvageableNativeMacCapture(validVideoFixture, true)).resolves.toBe(true);
	});

	it("rejects the former false positive with atom names but no video stream", async () => {
		const filePath = await writeMp4("empty-shell.mp4", [
			atom("ftyp", 24),
			atom("mdat", 2048),
			atom("moov", 256),
		]);
		await expect(isSalvageableNativeMacCapture(filePath, true)).resolves.toBe(false);
	});

	it("does not inspect or admit a file while the helper may still be writing", async () => {
		await expect(isSalvageableNativeMacCapture(validVideoFixture, false)).resolves.toBe(false);
	});

	it("returns false when the expected output is missing", async () => {
		await expect(isSalvageableNativeMacCapture(path.join(dir, "missing.mp4"), true)).resolves.toBe(
			false,
		);
	});
});

describe("resolveNativeMacCaptureStop", () => {
	it("keeps the acknowledged stop path unchanged", async () => {
		const waitForExit = vi.fn(async () => true);
		const isSalvageable = vi.fn(async () => true);
		await expect(
			resolveNativeMacCaptureStop({
				preferredPath: "/recordings/preferred.mp4",
				waitForStop: async () => "/recordings/acknowledged.mp4",
				waitForExit,
				isSalvageable,
			}),
		).resolves.toEqual({ path: "/recordings/acknowledged.mp4", recovered: false });
		expect(waitForExit).not.toHaveBeenCalled();
		expect(isSalvageable).not.toHaveBeenCalled();
	});

	it("returns the preferred path when failed stop output is safely recoverable", async () => {
		const stopError = new Error("helper closed before stopped event");
		await expect(
			resolveNativeMacCaptureStop({
				preferredPath: validVideoFixture,
				waitForStop: async () => {
					throw stopError;
				},
				waitForExit: async () => true,
			}),
		).resolves.toEqual({ path: validVideoFixture, recovered: true, stopError });
	});

	it.each([
		["helper is still alive", false, true],
		["output is invalid", true, false],
	])("preserves the original stop failure when %s", async (_label, helperExited, valid) => {
		const stopError = new Error("stop failed");
		await expect(
			resolveNativeMacCaptureStop({
				preferredPath: "/recordings/incomplete.mp4",
				waitForStop: async () => {
					throw stopError;
				},
				waitForExit: async () => helperExited,
				isSalvageable: async () => valid,
			}),
		).rejects.toBe(stopError);
	});
});
