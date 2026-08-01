import { afterEach, describe, expect, it, vi } from "vitest";
import { materializeLocalSourceFile, releaseLocalSourceFile } from "./localSourceFile";

function stubElectronAPI(api: Record<string, unknown>) {
	vi.stubGlobal("window", { ...globalThis.window, electronAPI: api } as unknown);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("materializeLocalSourceFile (small file path)", () => {
	it("reads a small file in one shot and returns a File with its bytes", async () => {
		const bytes = new Uint8Array([1, 2, 3, 4, 5]);
		stubElectronAPI({
			getReadableFileInfo: vi.fn().mockResolvedValue({
				success: true,
				size: bytes.byteLength,
				mtimeMs: 1,
				path: "/tmp/small.mp4",
			}),
			readBinaryFile: vi.fn().mockResolvedValue({
				success: true,
				data: bytes.buffer,
				path: "/tmp/small.mp4",
			}),
		});

		const file = await materializeLocalSourceFile("/tmp/small.mp4", "small.mp4");

		expect(file).toBeInstanceOf(File);
		expect(file.size).toBe(bytes.byteLength);
		expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
	});

	it("does not stream a small file through readFileChunk", async () => {
		const readFileChunk = vi.fn();
		stubElectronAPI({
			getReadableFileInfo: vi
				.fn()
				.mockResolvedValue({ success: true, size: 10, mtimeMs: 1, path: "/tmp/s.mp4" }),
			readBinaryFile: vi
				.fn()
				.mockResolvedValue({ success: true, data: new Uint8Array(10).buffer, path: "/tmp/s.mp4" }),
			readFileChunk,
		});

		await materializeLocalSourceFile("/tmp/s.mp4", "s.mp4");

		expect(readFileChunk).not.toHaveBeenCalled();
	});

	it("throws when the file cannot be stat-ed", async () => {
		stubElectronAPI({
			getReadableFileInfo: vi
				.fn()
				.mockResolvedValue({ success: false, message: "File path is not approved" }),
			readBinaryFile: vi.fn(),
		});

		await expect(materializeLocalSourceFile("/tmp/missing.mp4", "x.mp4")).rejects.toThrow(
			/not approved/,
		);
	});

	it("throws when the single-shot read fails", async () => {
		stubElectronAPI({
			getReadableFileInfo: vi
				.fn()
				.mockResolvedValue({ success: true, size: 10, mtimeMs: 1, path: "/tmp/s.mp4" }),
			readBinaryFile: vi
				.fn()
				.mockResolvedValue({ success: false, message: "Failed to read binary file" }),
		});

		await expect(materializeLocalSourceFile("/tmp/s.mp4", "s.mp4")).rejects.toThrow(
			/Failed to read binary file/,
		);
	});
});

// ---- Minimal in-memory OPFS fake for the large-file streaming path ----

class FakeWritable {
	private parts: Uint8Array[] = [];
	// The merged buffer is freshly allocated, so it is ArrayBuffer-backed (not
	// SharedArrayBuffer) — say so, or it can't be handed to `new File([...])`.
	constructor(private readonly onClose: (bytes: Uint8Array<ArrayBuffer>) => void) {}
	async write(data: ArrayBuffer | Uint8Array) {
		this.parts.push(data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data));
	}
	async close() {
		const total = this.parts.reduce((n, p) => n + p.byteLength, 0);
		const merged = new Uint8Array(total);
		let offset = 0;
		for (const p of this.parts) {
			merged.set(p, offset);
			offset += p.byteLength;
		}
		this.onClose(merged);
	}
	async abort() {
		this.parts = [];
	}
}

class FakeFileHandle {
	bytes = new Uint8Array(0);
	constructor(readonly name: string) {}
	async getFile() {
		return new File([this.bytes], this.name);
	}
	async createWritable() {
		return new FakeWritable((b) => {
			this.bytes = b;
		});
	}
}

class FakeDir {
	files = new Map<string, FakeFileHandle>();
	subdirs = new Map<string, FakeDir>();
	async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
		let dir = this.subdirs.get(name);
		if (!dir && opts?.create) {
			dir = new FakeDir();
			this.subdirs.set(name, dir);
		}
		if (!dir) throw new DOMException("NotFound", "NotFoundError");
		return dir as unknown as FileSystemDirectoryHandle;
	}
	async getFileHandle(name: string, opts?: { create?: boolean }) {
		let file = this.files.get(name);
		if (!file && opts?.create) {
			file = new FakeFileHandle(name);
			this.files.set(name, file);
		}
		if (!file) throw new DOMException("NotFound", "NotFoundError");
		return file as unknown as FileSystemFileHandle;
	}
	async *keys() {
		yield* this.files.keys();
	}
	async removeEntry(name: string) {
		this.files.delete(name);
	}
}

function stubOpfs(root: FakeDir) {
	vi.stubGlobal("navigator", { storage: { getDirectory: async () => root } } as unknown);
}

function cacheDir(root: FakeDir): FakeDir | undefined {
	return root.subdirs.get("openscreen-source-cache");
}

/**
 * The real `electronAPI.readFileChunk` contract (electron/electron-env.d.ts):
 * a read can fail, and then carries a message instead of data. Spelled out so
 * tests can substitute a failing implementation.
 */
type ReadFileChunk = (
	filePath: string,
	offset: number,
	length: number,
) => Promise<{
	success: boolean;
	data?: ArrayBuffer;
	bytesRead?: number;
	message?: string;
}>;

/** electronAPI whose readFileChunk serves slices of `source`. */
function largeSourceApi(url: string, source: Uint8Array, mtimeMs = 1) {
	return {
		getReadableFileInfo: vi
			.fn()
			.mockResolvedValue({ success: true, size: source.byteLength, mtimeMs, path: url }),
		readBinaryFile: vi.fn(),
		readFileChunk: vi.fn<ReadFileChunk>(async (_url: string, offset: number, length: number) => ({
			success: true,
			data: source.slice(offset, offset + length).buffer,
			bytesRead: Math.min(length, source.byteLength - offset),
		})),
	};
}

describe("materializeLocalSourceFile (large file OPFS path)", () => {
	const OPTS = { thresholdBytes: 4, chunkBytes: 3 };

	it("streams a large file into OPFS in chunks and returns the exact bytes", async () => {
		const source = new Uint8Array([10, 20, 30, 40, 50, 60, 70]);
		const api = largeSourceApi("/rec/a.mp4", source);
		stubElectronAPI(api);
		stubOpfs(new FakeDir());

		const file = await materializeLocalSourceFile("/rec/a.mp4", "a.mp4", OPTS);

		expect(file.size).toBe(source.byteLength);
		expect(new Uint8Array(await file.arrayBuffer())).toEqual(source);
		// 7 bytes / 3-byte chunks => 3 reads.
		expect(api.readFileChunk).toHaveBeenCalledTimes(3);
		expect(api.readBinaryFile).not.toHaveBeenCalled();

		releaseLocalSourceFile(file.name);
	});

	it("reuses the cached copy on a second call without re-streaming", async () => {
		const source = new Uint8Array([1, 2, 3, 4, 5, 6]);
		const api = largeSourceApi("/rec/b.mp4", source);
		stubElectronAPI(api);
		stubOpfs(new FakeDir());

		const first = await materializeLocalSourceFile("/rec/b.mp4", "b.mp4", OPTS);
		const firstReads = api.readFileChunk.mock.calls.length;
		const second = await materializeLocalSourceFile("/rec/b.mp4", "b.mp4", OPTS);

		expect(api.readFileChunk.mock.calls.length).toBe(firstReads); // no new reads
		expect(second.name).toBe(first.name);

		releaseLocalSourceFile(first.name);
		releaseLocalSourceFile(second.name);
	});

	it("keeps a cache entry that is still referenced by another active source", async () => {
		const root = new FakeDir();
		stubOpfs(root);

		stubElectronAPI(largeSourceApi("/rec/a.mp4", new Uint8Array([1, 2, 3, 4, 5])));
		const a = await materializeLocalSourceFile("/rec/a.mp4", "a.mp4", OPTS); // A retained

		stubElectronAPI(largeSourceApi("/rec/b.mp4", new Uint8Array([6, 7, 8, 9, 10])));
		const b = await materializeLocalSourceFile("/rec/b.mp4", "b.mp4", OPTS); // prunes, A active

		// A must NOT have been pruned while still in use.
		expect(cacheDir(root)?.files.size).toBe(2);

		releaseLocalSourceFile(a.name);
		releaseLocalSourceFile(b.name);
	});

	it("prunes a cache entry once it has been released", async () => {
		const root = new FakeDir();
		stubOpfs(root);

		stubElectronAPI(largeSourceApi("/rec/a.mp4", new Uint8Array([1, 2, 3, 4, 5])));
		const a = await materializeLocalSourceFile("/rec/a.mp4", "a.mp4", OPTS); // A retained

		stubElectronAPI(largeSourceApi("/rec/b.mp4", new Uint8Array([6, 7, 8, 9, 10])));
		const b = await materializeLocalSourceFile("/rec/b.mp4", "b.mp4", OPTS); // B retained

		releaseLocalSourceFile(a.name); // A no longer in use

		stubElectronAPI(largeSourceApi("/rec/c.mp4", new Uint8Array([11, 12, 13, 14, 15])));
		const c = await materializeLocalSourceFile("/rec/c.mp4", "c.mp4", OPTS); // prunes A, keeps B+C

		// A pruned; B (still active) and C remain.
		expect(cacheDir(root)?.files.size).toBe(2);

		releaseLocalSourceFile(b.name);
		releaseLocalSourceFile(c.name);
	});

	it("removes the partial cache entry when a chunk read fails mid-copy", async () => {
		const root = new FakeDir();
		stubOpfs(root);

		const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
		const api = largeSourceApi("/rec/err.mp4", source);
		let reads = 0;
		api.readFileChunk = vi.fn(async (_url: string, offset: number, length: number) => {
			reads += 1;
			if (reads === 2) return { success: false, message: "disk read failed" };
			return {
				success: true,
				data: source.slice(offset, offset + length).buffer,
				bytesRead: Math.min(length, source.byteLength - offset),
			};
		});
		stubElectronAPI(api);

		await expect(materializeLocalSourceFile("/rec/err.mp4", "err.mp4", OPTS)).rejects.toThrow(
			/disk read failed/,
		);

		// The partial copy is cleaned up and holds no live reference.
		expect(cacheDir(root)?.files.size ?? 0).toBe(0);
	});

	it("does not prune an entry that is still being written by a concurrent copy", async () => {
		const root = new FakeDir();
		stubOpfs(root);

		const sourceA = new Uint8Array([1, 2, 3, 4, 5, 6]);
		const sourceB = new Uint8Array([7, 8, 9, 10, 11]);
		let releaseFirstChunk!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseFirstChunk = resolve;
		});
		const sources: Record<string, Uint8Array> = {
			"/rec/a.mp4": sourceA,
			"/rec/b.mp4": sourceB,
		};
		// One shared API serving both URLs; A's first chunk read blocks on the gate
		// so A sits mid-copy while B runs to completion (including B's prune pass).
		const api = {
			getReadableFileInfo: vi.fn(async (url: string) => ({
				success: true,
				size: sources[url].byteLength,
				mtimeMs: 1,
				path: url,
			})),
			readBinaryFile: vi.fn(),
			readFileChunk: vi.fn(async (url: string, offset: number, length: number) => {
				if (url === "/rec/a.mp4" && offset === 0) await gate;
				const bytes = sources[url];
				return {
					success: true,
					data: bytes.slice(offset, offset + length).buffer,
					bytesRead: Math.min(length, bytes.byteLength - offset),
				};
			}),
		};
		stubElectronAPI(api);

		const aPromise = materializeLocalSourceFile("/rec/a.mp4", "a.mp4", OPTS);
		// Wait until A is inside its gated first chunk read (past retain + prune).
		while (!api.readFileChunk.mock.calls.some(([url]) => url === "/rec/a.mp4")) {
			await new Promise((r) => setTimeout(r, 0));
		}

		const b = await materializeLocalSourceFile("/rec/b.mp4", "b.mp4", OPTS);
		// B's prune must have kept A's in-progress entry alive.
		expect(cacheDir(root)?.files.size).toBe(2);

		releaseFirstChunk();
		const a = await aPromise;
		expect(new Uint8Array(await a.arrayBuffer())).toEqual(sourceA);

		releaseLocalSourceFile(a.name);
		releaseLocalSourceFile(b.name);
	});
});

describe("materializeLocalSourceFile (in-flight dedup & abort)", () => {
	const OPTS = { thresholdBytes: 4, chunkBytes: 3 };

	it("deduplicates concurrent copies of the same entry into one stream", async () => {
		const root = new FakeDir();
		stubOpfs(root);
		const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
		const api = largeSourceApi("/rec/dup.mp4", source);
		stubElectronAPI(api);

		const [a, b] = await Promise.all([
			materializeLocalSourceFile("/rec/dup.mp4", "dup.mp4", OPTS),
			materializeLocalSourceFile("/rec/dup.mp4", "dup.mp4", OPTS),
		]);

		// One shared copy: 7 bytes / 3-byte chunks => exactly 3 reads, not 6.
		expect(api.readFileChunk).toHaveBeenCalledTimes(3);
		expect(new Uint8Array(await a.arrayBuffer())).toEqual(source);
		expect(new Uint8Array(await b.arrayBuffer())).toEqual(source);
		expect(a.name).toBe(b.name);

		// Each caller took one reference; after both release, a later
		// materialization of another entry prunes it.
		releaseLocalSourceFile(a.name);
		releaseLocalSourceFile(b.name);
		stubElectronAPI(largeSourceApi("/rec/other.mp4", new Uint8Array([9, 9, 9, 9, 9])));
		const other = await materializeLocalSourceFile("/rec/other.mp4", "other.mp4", OPTS);
		expect(cacheDir(root)?.files.size).toBe(1);
		releaseLocalSourceFile(other.name);
	});

	it("aborts the copy via the AbortSignal and cleans up the partial entry", async () => {
		const root = new FakeDir();
		stubOpfs(root);
		const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
		const api = largeSourceApi("/rec/ab.mp4", source);
		let releaseFirstChunk!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseFirstChunk = resolve;
		});
		api.readFileChunk = vi.fn(async (_url: string, offset: number, length: number) => {
			if (offset === 0) await gate;
			return {
				success: true,
				data: source.slice(offset, offset + length).buffer,
				bytesRead: Math.min(length, source.byteLength - offset),
			};
		});
		stubElectronAPI(api);

		const controller = new AbortController();
		const promise = materializeLocalSourceFile("/rec/ab.mp4", "ab.mp4", {
			...OPTS,
			signal: controller.signal,
		});
		// Let the copy enter its gated first chunk, then abort mid-copy.
		while (api.readFileChunk.mock.calls.length === 0) {
			await new Promise((r) => setTimeout(r, 0));
		}
		controller.abort();
		releaseFirstChunk();

		await expect(promise).rejects.toThrow(/abort/i);
		// Give the shared flight's cleanup a tick to settle.
		await new Promise((r) => setTimeout(r, 0));
		expect(cacheDir(root)?.files.size ?? 0).toBe(0);

		// A retry after abort works from scratch.
		const retry = await materializeLocalSourceFile("/rec/ab.mp4", "ab.mp4", OPTS);
		expect(new Uint8Array(await retry.arrayBuffer())).toEqual(source);
		releaseLocalSourceFile(retry.name);
	});

	it("keeps the shared copy alive while another joined caller is still interested", async () => {
		const root = new FakeDir();
		stubOpfs(root);
		const source = new Uint8Array([1, 2, 3, 4, 5, 6]);
		const api = largeSourceApi("/rec/share.mp4", source);
		let releaseFirstChunk!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseFirstChunk = resolve;
		});
		api.readFileChunk = vi.fn(async (_url: string, offset: number, length: number) => {
			if (offset === 0) await gate;
			return {
				success: true,
				data: source.slice(offset, offset + length).buffer,
				bytesRead: Math.min(length, source.byteLength - offset),
			};
		});
		stubElectronAPI(api);

		const controller = new AbortController();
		const abortable = materializeLocalSourceFile("/rec/share.mp4", "share.mp4", {
			...OPTS,
			signal: controller.signal,
		});
		const steady = materializeLocalSourceFile("/rec/share.mp4", "share.mp4", OPTS);
		while (api.readFileChunk.mock.calls.length === 0) {
			await new Promise((r) => setTimeout(r, 0));
		}
		// One of two joined callers aborts: the shared copy must keep going.
		controller.abort();
		releaseFirstChunk();

		await expect(abortable).rejects.toThrow(/abort/i);
		const file = await steady;
		expect(new Uint8Array(await file.arrayBuffer())).toEqual(source);
		releaseLocalSourceFile(file.name);
	});
});

describe("materializeLocalSourceFile (MIME inference)", () => {
	it.each([
		["/tmp/clip.webm", "video/webm"],
		["/tmp/clip.mp4", "video/mp4"],
		["/tmp/clip.mov", "video/quicktime"],
		["/tmp/clip.bin", "application/octet-stream"],
	])("infers the MIME type of %s as %s", async (path, expected) => {
		stubElectronAPI({
			getReadableFileInfo: vi.fn().mockResolvedValue({ success: true, size: 4, mtimeMs: 1, path }),
			readBinaryFile: vi
				.fn()
				.mockResolvedValue({ success: true, data: new Uint8Array(4).buffer, path }),
		});

		const file = await materializeLocalSourceFile(path, "clip");

		expect(file.type).toBe(expected);
	});
});
