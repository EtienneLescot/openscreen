import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
const resolveFfmpegMock = vi.fn<() => string | null>();

vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));
vi.mock("../media/audioPeaks", () => ({ resolveFfmpeg: () => resolveFfmpegMock() }));

const { extractMono16kPcm, FfmpegUnavailableError, NoAudioTrackError } = await import(
	"./extractAudio"
);
const { STT_NATIVE_EXTRACTION_UNAVAILABLE } = await import("./transcriptionContract");

/** A stand-in for the ffmpeg child: two pipes and a close event, nothing more. */
function fakeChild() {
	const child = new EventEmitter() as EventEmitter & {
		stdout: PassThrough;
		stderr: PassThrough;
		kill: ReturnType<typeof vi.fn>;
	};
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.kill = vi.fn();
	return child;
}

/** The little-endian float32 bytes ffmpeg would emit for `values`. */
function f32le(values: number[]): Buffer {
	const buf = Buffer.alloc(values.length * 4);
	values.forEach((v, i) => buf.writeFloatLE(v, i * 4));
	return buf;
}

beforeEach(() => {
	vi.clearAllMocks();
	resolveFfmpegMock.mockReturnValue("/usr/bin/ffmpeg");
});

describe("extractMono16kPcm", () => {
	it("asks ffmpeg for exactly what whisper wants", async () => {
		const child = fakeChild();
		spawnMock.mockReturnValue(child);
		const promise = extractMono16kPcm("/tmp/a.mp3");
		child.stdout.end(f32le([0.5]));
		child.emit("close", 0);
		await promise;

		const args = spawnMock.mock.calls[0][1] as string[];
		// Mono, 16 kHz, float32 little-endian, no video. Anything else and whisper is
		// reading the samples wrong rather than failing loudly.
		expect(args).toContain("-vn");
		expect(args.join(" ")).toContain("-ac 1");
		expect(args.join(" ")).toContain("-ar 16000");
		expect(args.join(" ")).toContain("-f f32le");
	});

	it("decodes the samples ffmpeg writes", async () => {
		const child = fakeChild();
		spawnMock.mockReturnValue(child);
		const promise = extractMono16kPcm("/tmp/a.mp3");
		child.stdout.end(f32le([0, 0.5, -0.25]));
		child.emit("close", 0);

		const out = await promise;
		expect(Array.from(out)).toEqual([0, 0.5, -0.25]);
	});

	it("carries a float split across two chunks instead of dropping it", async () => {
		// THE defect worth a test here: stdout chunk boundaries do not respect sample
		// boundaries. Dropping the partial tail would shift every following sample and
		// detune the whole track — audible, and invisible in a length check.
		const child = fakeChild();
		spawnMock.mockReturnValue(child);
		const promise = extractMono16kPcm("/tmp/a.mp3");
		const bytes = f32le([0.25, -0.75, 1]);
		child.stdout.write(bytes.subarray(0, 6)); // one whole float + half of the next
		child.stdout.write(bytes.subarray(6));
		child.stdout.end();
		child.emit("close", 0);

		const out = await promise;
		expect(Array.from(out)).toEqual([0.25, -0.75, 1]);
	});

	it("reports a file with no audio track", async () => {
		const child = fakeChild();
		spawnMock.mockReturnValue(child);
		const promise = extractMono16kPcm("/tmp/silent.mp4");
		child.stderr.end("Stream map '0:a' matches no streams");
		child.stdout.end();
		child.emit("close", 1);

		await expect(promise).rejects.toBeInstanceOf(NoAudioTrackError);
	});

	it("keeps the samples when ffmpeg exits non-zero AFTER writing audio", async () => {
		// A truncated file still yields usable audio; throwing it away would lose a
		// transcript over a trailing byte.
		const child = fakeChild();
		spawnMock.mockReturnValue(child);
		const promise = extractMono16kPcm("/tmp/truncated.mp3");
		child.stdout.end(f32le([0.1, 0.2]));
		child.emit("close", 1);

		expect(Array.from(await promise)).toEqual([expect.closeTo(0.1, 6), expect.closeTo(0.2, 6)]);
	});

	it("refuses with the marker the renderer falls back on when ffmpeg is missing", async () => {
		// The string is the contract across the IPC boundary, which drops the class.
		resolveFfmpegMock.mockReturnValue(null);
		await expect(extractMono16kPcm("/tmp/a.mp3")).rejects.toBeInstanceOf(FfmpegUnavailableError);
		await expect(extractMono16kPcm("/tmp/a.mp3")).rejects.toThrow(
			STT_NATIVE_EXTRACTION_UNAVAILABLE,
		);
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("kills the child when the caller aborts", async () => {
		const child = fakeChild();
		spawnMock.mockReturnValue(child);
		const controller = new AbortController();
		const promise = extractMono16kPcm("/tmp/a.mp3", { signal: controller.signal });
		controller.abort();

		await expect(promise).rejects.toMatchObject({ name: "AbortError" });
		// Not merely stopping to await: ffmpeg would keep decoding a long file for
		// minutes, which is the same leak the STT cancel path exists to prevent.
		expect(child.kill).toHaveBeenCalled();
	});

	it("does not spawn at all when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			extractMono16kPcm("/tmp/a.mp3", { signal: controller.signal }),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(spawnMock).not.toHaveBeenCalled();
	});
});
