import type { ChildProcessByStdio } from "node:child_process";
import { spawn } from "node:child_process";
import { once } from "node:events";
import type { Readable, Writable } from "node:stream";

/** We pipe stdin and stderr and discard stdout — ffmpeg writes the file itself. */
type FfmpegChild = ChildProcessByStdio<Writable, null, Readable>;

/**
 * Streams raw frames from the export pipeline into a bundled native ffmpeg,
 * which encodes with the platform's hardware encoder and writes the file
 * itself. Replaces WebCodecs + the JS muxer on the export path: WebCodecs
 * reaches the same silicon but measures ~8 fps @1080p against ffmpeg's ~165.
 *
 * Runs in the main process. Deliberately free of Electron imports so it stays
 * unit-testable outside Electron. Binary path and encoder come from
 * {@link ../media/ffmpegCapabilities}; this module never resolves them itself.
 */

export interface FfmpegEncodeOptions {
	ffmpegPath: string;
	/**
	 * argv inserted before ours. Tests use it to point `ffmpegPath` at
	 * `process.execPath` and run a fake-ffmpeg script instead of the real binary.
	 */
	ffmpegArgsPrefix?: string[];
	outputPath: string;
	/** e.g. "h264_amf" — chosen by selectVideoEncoder(). */
	encoder: string;
	width: number;
	height: number;
	frameRate: number;
	/** bits per second */
	bitrate: number;
	/**
	 * `nv12` is the fast path (3.0 MB/frame @1080p, produced by a GPU packing
	 * step). `bgra` is what a canvas VideoFrame gives us directly (7.9 MB) —
	 * Chromium refuses to convert to NV12, so ffmpeg's swscale does it instead.
	 */
	pixelFormat: "nv12" | "bgra" | "rgba";
	extraEncoderArgs?: string[];
	/**
	 * Optional second input: the export's assembled PCM, already laid out at the
	 * concat plan's offsets. Given this, ffmpeg encodes AAC and muxes the final
	 * file itself — which is the whole point of routing audio through here rather
	 * than muxing in JS.
	 *
	 * Raw f32le rather than WAV: it is what we already hold in memory, it needs no
	 * header, and it skips the int16 round-trip a WAV would impose.
	 */
	audio?: {
		/** Path to raw interleaved float32 PCM. */
		path: string;
		sampleRate: number;
		channels: number;
		/** bits per second */
		bitrate: number;
	};
}

export interface FfmpegEncodeSession {
	/** Resolves once ffmpeg has accepted the frame; awaits `drain` under backpressure. */
	writeFrame(frame: Uint8Array): Promise<void>;
	/** Closes stdin; resolves on a clean exit, rejects with the stderr tail otherwise. */
	finish(): Promise<{ outputPath: string }>;
	/** Kills the process tree. `finish()` must not hang afterwards. */
	cancel(): Promise<void>;
	readonly framesEncoded: number;
}

/** Keep the last of ffmpeg's stderr: on failure it is the only diagnostic anyone gets. */
const STDERR_TAIL_BYTES = 4096;

/**
 * The argv we hand ffmpeg. Split out from the process handling so the shape can
 * be asserted without spawning anything.
 *
 * `-progress pipe:2` asks for machine-readable `key=value` progress on stderr,
 * which is what {@link parseProgress} reads; `-nostats` silences the human
 * progress line that would otherwise interleave with it.
 *
 * All inputs must precede the output options, so audio (input 1) is declared
 * right after the video pipe (input 0) and its codec is chosen further down.
 */
export function buildFfmpegArgs(opts: FfmpegEncodeOptions): string[] {
	return [
		...(opts.ffmpegArgsPrefix ?? []),
		"-hide_banner",
		"-v",
		"error",
		// input 0: raw frames on stdin. rawvideo carries no geometry, so ffmpeg
		// cannot infer any of this — it must be told.
		"-f",
		"rawvideo",
		"-pix_fmt",
		opts.pixelFormat,
		"-s",
		`${opts.width}x${opts.height}`,
		"-r",
		String(opts.frameRate),
		"-i",
		"pipe:0",
		// input 1: the assembled PCM, when there is audio.
		...(opts.audio
			? [
					"-f",
					"f32le",
					"-ar",
					String(opts.audio.sampleRate),
					"-ac",
					String(opts.audio.channels),
					"-i",
					opts.audio.path,
				]
			: []),
		"-c:v",
		opts.encoder,
		"-b:v",
		String(opts.bitrate),
		...(opts.extraEncoderArgs ?? []),
		...(opts.audio ? ["-c:a", "aac", "-b:a", String(opts.audio.bitrate)] : ["-an"]),
		// Video is exactly as long as the frames we push; audio is sized from the
		// same per-segment frame counts, so a mismatch means an upstream bug we
		// want to see rather than have ffmpeg quietly pad or truncate.
		"-progress",
		"pipe:2",
		"-nostats",
		"-y",
		opts.outputPath,
	];
}

/**
 * Pulls `frame=N` out of a chunk of ffmpeg's `-progress` output, or null when
 * the chunk carries no frame count.
 *
 * Callers feed raw stream chunks, which split anywhere — including mid-line and
 * mid-number. Matching only on a `frame=` followed by digits AND a terminator
 * means a torn `frame=12` at a chunk boundary is ignored rather than reported as
 * frame 12; the next chunk carries the whole line anyway. Progress is monotonic,
 * so taking the LAST match in a chunk gives the freshest count.
 */
export function parseProgress(chunk: string): { frame: number } | null {
	let last: number | null = null;
	// Require real trailing whitespace, NOT end-of-string: a chunk ending in
	// "frame=12" is the head of "frame=1234", and end-of-string in the lookahead
	// would happily report 12. ffmpeg's -progress always terminates each
	// key=value with a newline, so a complete line always has its terminator.
	for (const m of chunk.matchAll(/(?:^|\s)frame=\s*(\d+)(?=\s)/g)) {
		const n = Number.parseInt(m[1], 10);
		if (Number.isFinite(n)) last = n;
	}
	return last === null ? null : { frame: last };
}

/** Windows leaves orphans behind a bare kill() — ffmpeg would keep holding the output file. */
function killTree(child: FfmpegChild): void {
	if (child.exitCode !== null || child.signalCode !== null) return;
	if (process.platform === "win32" && child.pid !== undefined) {
		spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }).on(
			"error",
			() => {
				// taskkill missing (unlikely) — fall back to the best we have.
				child.kill("SIGKILL");
			},
		);
	} else {
		child.kill("SIGKILL");
	}
}

export function startFfmpegEncodeSession(
	opts: FfmpegEncodeOptions,
	hooks?: { onProgress?: (framesEncoded: number) => void },
): FfmpegEncodeSession {
	const child: FfmpegChild = spawn(opts.ffmpegPath, buildFfmpegArgs(opts), {
		stdio: ["pipe", "ignore", "pipe"],
	});

	let framesEncoded = 0;
	let stderrTail = "";
	let cancelled = false;
	let closed = false;
	let spawnError: Error | null = null;

	// Attached before the first write so a spawn failure surfaces through
	// finish() instead of as an unhandled 'error' event.
	const exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> = new Promise(
		(resolve) => {
			child.on("error", (err) => {
				spawnError = err instanceof Error ? err : new Error(String(err));
				resolve({ code: null, signal: null });
			});
			child.on("close", (code, signal) => {
				closed = true;
				resolve({ code, signal });
			});
		},
	);

	child.stdin.on("error", () => {
		// A killed ffmpeg closes the pipe under us mid-write. EPIPE here is
		// expected and must never reach the main process as an unhandled error.
	});

	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
		const p = parseProgress(chunk);
		if (p) {
			framesEncoded = p.frame;
			hooks?.onProgress?.(framesEncoded);
		}
	});

	return {
		get framesEncoded() {
			return framesEncoded;
		},

		async writeFrame(frame: Uint8Array): Promise<void> {
			if (cancelled || closed) throw new Error("ffmpeg encode session is closed");
			if (spawnError) throw spawnError;
			// Buffer.from(typedArray) COPIES. Wrapping the caller's memory instead
			// measured +31% end-to-end (26 -> 34 fps): at 3-8 MB a frame, a stray
			// copy per frame is gigabytes of pure memcpy across an export.
			const view = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
			// The pipe sustains ~500 MB/s ONLY if we respect backpressure. Ignoring
			// the false return buffers frames in memory without going any faster.
			if (!child.stdin.write(view)) {
				await once(child.stdin, "drain");
			}
		},

		async finish(): Promise<{ outputPath: string }> {
			if (!cancelled && !closed) child.stdin.end();
			const { code, signal } = await exited;
			if (spawnError) throw spawnError;
			if (cancelled) return { outputPath: opts.outputPath };
			if (code !== 0) {
				const how = signal ? `signal ${signal}` : `exit code ${code}`;
				throw new Error(`ffmpeg failed (${how})${stderrTail ? `: ${stderrTail.trim()}` : ""}`);
			}
			return { outputPath: opts.outputPath };
		},

		async cancel(): Promise<void> {
			if (cancelled || closed) return;
			cancelled = true;
			// End stdin first so ffmpeg is not blocked writing into a full pipe
			// while we wait on the kill.
			child.stdin.destroy();
			killTree(child);
			await exited;
		},
	};
}
