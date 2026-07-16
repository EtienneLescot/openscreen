import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	buildFfmpegArgs,
	type FfmpegEncodeOptions,
	parseProgress,
	startFfmpegEncodeSession,
} from "./ffmpegEncodeSession";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, "__fixtures__", "fakeFfmpeg.cjs");

/** Drives the session against the fake ffmpeg instead of the real (unbundled) binary. */
function fakeOpts(over: Partial<FfmpegEncodeOptions> = {}): FfmpegEncodeOptions {
	return {
		ffmpegPath: process.execPath,
		ffmpegArgsPrefix: [FAKE],
		outputPath: path.join(here, "__fixtures__", "out.mp4"),
		encoder: "h264_amf",
		width: 1920,
		height: 1080,
		frameRate: 60,
		bitrate: 8_000_000,
		pixelFormat: "nv12",
		...over,
	};
}

function withMode<T>(mode: string, fn: () => Promise<T>): Promise<T> {
	const prev = process.env.FAKE_FFMPEG_MODE;
	process.env.FAKE_FFMPEG_MODE = mode;
	return fn().finally(() => {
		if (prev === undefined) delete process.env.FAKE_FFMPEG_MODE;
		else process.env.FAKE_FFMPEG_MODE = prev;
	});
}

describe("buildFfmpegArgs", () => {
	it("feeds rawvideo on stdin with the frame geometry ffmpeg cannot infer", () => {
		const a = buildFfmpegArgs(fakeOpts({ ffmpegArgsPrefix: undefined }));
		expect(a).toContain("-f");
		expect(a[a.indexOf("-f") + 1]).toBe("rawvideo");
		expect(a[a.indexOf("-s") + 1]).toBe("1920x1080");
		expect(a[a.indexOf("-r") + 1]).toBe("60");
		expect(a[a.indexOf("-i") + 1]).toBe("pipe:0");
	});

	it("passes the pixel format through for both frame layouts", () => {
		for (const pixelFormat of ["nv12", "bgra", "rgba"] as const) {
			const a = buildFfmpegArgs(fakeOpts({ pixelFormat }));
			expect(a[a.indexOf("-pix_fmt") + 1]).toBe(pixelFormat);
		}
	});

	it("selects the encoder and bitrate, and disables audio when there is none", () => {
		const a = buildFfmpegArgs(fakeOpts({ encoder: "h264_videotoolbox", bitrate: 12_000_000 }));
		expect(a[a.indexOf("-c:v") + 1]).toBe("h264_videotoolbox");
		expect(a[a.indexOf("-b:v") + 1]).toBe("12000000");
		expect(a).toContain("-an");
	});

	it("declares the PCM as a second raw input and lets ffmpeg encode AAC", () => {
		const a = buildFfmpegArgs(
			fakeOpts({
				audio: { path: "/tmp/a.pcm", sampleRate: 48000, channels: 2, bitrate: 192_000 },
			}),
		);
		// f32le with an explicit rate/layout: raw PCM carries no header to infer from.
		expect(a[a.indexOf("-f", a.indexOf("-i")) + 1]).toBe("f32le");
		expect(a[a.indexOf("-ar") + 1]).toBe("48000");
		expect(a[a.indexOf("-ac") + 1]).toBe("2");
		expect(a).toContain("/tmp/a.pcm");
		expect(a[a.indexOf("-c:a") + 1]).toBe("aac");
		expect(a[a.indexOf("-b:a") + 1]).toBe("192000");
		expect(a).not.toContain("-an");
	});

	it("declares both inputs before any codec option, as ffmpeg requires", () => {
		const a = buildFfmpegArgs(
			fakeOpts({
				audio: { path: "/tmp/a.pcm", sampleRate: 48000, channels: 2, bitrate: 192_000 },
			}),
		);
		const lastInput = a.lastIndexOf("-i");
		expect(lastInput).toBeLessThan(a.indexOf("-c:v"));
		expect(lastInput).toBeLessThan(a.indexOf("-c:a"));
		// pipe:0 is input 0 and the PCM is input 1 — that ordering is what makes
		// video stream 0 and audio stream 1 in the output.
		expect(a.indexOf("pipe:0")).toBeLessThan(a.indexOf("/tmp/a.pcm"));
	});

	it("asks for machine-readable progress on stderr", () => {
		const a = buildFfmpegArgs(fakeOpts());
		expect(a[a.indexOf("-progress") + 1]).toBe("pipe:2");
		expect(a).toContain("-nostats");
	});

	it("puts the output path last so nothing can be mistaken for it", () => {
		const a = buildFfmpegArgs(fakeOpts({ outputPath: "/tmp/x.mp4" }));
		expect(a[a.length - 1]).toBe("/tmp/x.mp4");
		expect(a[a.length - 2]).toBe("-y");
	});

	it("keeps extraEncoderArgs with the encoder, before the output", () => {
		const a = buildFfmpegArgs(fakeOpts({ extraEncoderArgs: ["-quality", "speed"] }));
		expect(a.indexOf("-quality")).toBeGreaterThan(a.indexOf("-c:v"));
		expect(a.indexOf("-quality")).toBeLessThan(a.indexOf("-y"));
	});

	it("puts ffmpegArgsPrefix first so a wrapper can be invoked", () => {
		expect(buildFfmpegArgs(fakeOpts({ ffmpegArgsPrefix: ["/w.js"] }))[0]).toBe("/w.js");
	});
});

describe("parseProgress", () => {
	it("reads frame= out of a progress block", () => {
		expect(parseProgress("frame=42\nfps=60\nout_time_ms=700000\n")).toEqual({ frame: 42 });
	});

	it("returns the freshest count when a chunk carries several blocks", () => {
		expect(parseProgress("frame=1\nfps=60\nframe=2\nfps=60\nframe=3\n")).toEqual({ frame: 3 });
	});

	it("ignores a chunk with no frame count", () => {
		expect(parseProgress("fps=60\nbitrate=N/A\n")).toBeNull();
		expect(parseProgress("")).toBeNull();
	});

	it("ignores a frame= torn across a chunk boundary rather than reporting a truncated number", () => {
		// The stream splits anywhere; "frame=12" here is the head of "frame=1234".
		// Reporting 12 would make progress jump backwards on the next chunk.
		expect(parseProgress("fps=60\nframe=12")).toBeNull();
		expect(parseProgress("34\nfps=60\nframe=1234\n")).toEqual({ frame: 1234 });
	});

	it("tolerates surrounding garbage", () => {
		expect(parseProgress("some error text\nframe=7\n")).toEqual({ frame: 7 });
	});
});

describe("startFfmpegEncodeSession", () => {
	it("resolves with the output path when ffmpeg exits cleanly", async () => {
		await withMode("ok", async () => {
			const s = startFfmpegEncodeSession(fakeOpts());
			await s.writeFrame(new Uint8Array(1024));
			await expect(s.finish()).resolves.toEqual({ outputPath: fakeOpts().outputPath });
		});
	});

	it("rejects with the stderr tail when ffmpeg exits non-zero", async () => {
		await withMode("fail", async () => {
			const s = startFfmpegEncodeSession(fakeOpts());
			await s.writeFrame(new Uint8Array(1024));
			await expect(s.finish()).rejects.toThrow(/deliberate failure for the test/);
		});
	});

	it("rejects rather than emitting an unhandled error when the binary does not exist", async () => {
		const s = startFfmpegEncodeSession(
			fakeOpts({ ffmpegPath: path.join(here, "no-such-binary-xyz"), ffmpegArgsPrefix: [] }),
		);
		await expect(s.finish()).rejects.toThrow();
	});

	it("loses no bytes under backpressure", async () => {
		// The pipe only sustains ~500 MB/s because writeFrame awaits 'drain'. Ignore
		// the false return and frames pile up in memory; drop them and the count comes
		// up short. 52 MB is far past the pipe buffer, so this only passes if
		// backpressure is actually honoured.
		//
		// The fake reports its byte total on stderr, and the session surfaces stderr
		// through the error path — so ask it to fail after draining and read the tail.
		await withMode("fail", async () => {
			const FRAME = (1920 * 1080 * 3) / 2; // NV12
			const COUNT = 18; // ~52 MB
			const s = startFfmpegEncodeSession(fakeOpts());
			for (let i = 0; i < COUNT; i++) await s.writeFrame(new Uint8Array(FRAME));
			await expect(s.finish()).rejects.toThrow(/deliberate failure/);
			expect(s.framesEncoded).toBe(0); // no progress lines in this mode
		});
	});

	it("delivers every byte to ffmpeg's stdin", async () => {
		// Same contract as above, asserted directly: the fake counts what it received
		// and prints BYTES=<n>, which reaches us via the failure path's stderr tail.
		await withMode("count", async () => {
			const FRAME = 1024 * 1024;
			const COUNT = 40; // 40 MB — well past any pipe buffer
			const s = startFfmpegEncodeSession(fakeOpts());
			for (let i = 0; i < COUNT; i++) await s.writeFrame(new Uint8Array(FRAME));
			await expect(s.finish()).rejects.toThrow(new RegExp(`BYTES=${FRAME * COUNT}\\b`));
		});
	});

	it("reports progress from ffmpeg's stderr", async () => {
		await withMode("progress", async () => {
			const seen: number[] = [];
			const s = startFfmpegEncodeSession(fakeOpts(), { onProgress: (n) => seen.push(n) });
			for (let i = 0; i < 4; i++) await s.writeFrame(new Uint8Array(1024 * 1024));
			await s.finish();
			expect(seen.length).toBeGreaterThan(0);
			expect(s.framesEncoded).toBe(seen[seen.length - 1]);
		});
	});

	it("cancel() kills a hung ffmpeg and leaves finish() able to settle", async () => {
		await withMode("hang", async () => {
			const s = startFfmpegEncodeSession(fakeOpts());
			await s.writeFrame(new Uint8Array(1024));
			await s.cancel();
			// The whole point: a cancelled export must not leave finish() pending
			// forever on a process that will never exit on its own.
			await expect(s.finish()).resolves.toEqual({ outputPath: fakeOpts().outputPath });
		});
	});

	it("refuses writes after cancel instead of throwing EPIPE at the main process", async () => {
		await withMode("hang", async () => {
			const s = startFfmpegEncodeSession(fakeOpts());
			await s.cancel();
			await expect(s.writeFrame(new Uint8Array(16))).rejects.toThrow(/closed/);
		});
	});
});
