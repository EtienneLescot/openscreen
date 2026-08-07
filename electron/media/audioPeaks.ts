import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";

/**
 * Waveform peaks for the timeline, computed in the main process with ffmpeg.
 *
 * WHY THIS EXISTS. The renderer had two pipelines and both decode the whole
 * audio track in Chromium, which is the entire cost. Measured head-to-head on a
 * 32-minute screen recording (68 MB):
 *
 *   decodeAudioData (whole track)      12003 ms, 714 MB resident
 *   WebCodecs chunk-by-chunk streaming 12259 ms, ~192 kB resident
 *   ffmpeg -vn -ac 1 -ar 16000          ~2000 ms, nothing resident
 *
 * The two browser paths differ only in memory; ffmpeg is ~6x faster than both
 * because a native AAC decoder is simply faster than Chromium's, and it runs
 * off the UI process entirely. The peaks then get cached on disk, so the cost
 * is paid once per recording rather than once per session.
 *
 * ponytail: the CLI, not libav bindings in the compositor addon. The addon
 * would avoid a process spawn — worth ~20 ms against a ~2000 ms decode — for a
 * new Rust surface, an N-API entry point and a build story on three platforms.
 * Revisit only if peaks ever need to share a decode with something else.
 */

/** IPC reply. `peaks: null` on success means "no native ffmpeg here" — a
 *  fallback signal, not a failure. */
export interface AudioPeaksResult {
	success: boolean;
	peaks?: Float32Array | null;
	message?: string;
}

/** PCM the peaks are computed from. Mono (ffmpeg downmixes) so channels are
 *  already averaged, and 16 kHz because peak buckets are at most 200/s: that
 *  still leaves 80 samples per bucket, far more than a min/max needs. */
const PCM_RATE = 16_000;

/** Matches `audioPeaksWorker.ts` and `streamingAudioPeaks.ts` so all three
 *  render identically — a clip must not change shape with the pipeline. */
const MAX_PEAK_BLOCKS = 24_000;
const PEAK_BLOCKS_PER_SEC = 200;

/** A recording whose audio takes longer than this to decode is not a recording,
 *  it is a wedged ffmpeg. ~30x the worst measured case. */
const DECODE_TIMEOUT_MS = 60_000;

/**
 * Where to find an ffmpeg that actually exists at runtime, in priority order.
 *
 * Note the Windows shape: `electron-builder.json5` deliberately excludes the
 * STATIC `ffmpeg.exe` (109 MB) from the installer, so resolving to it would
 * work in dev and fail in production — the exact class of bug that is invisible
 * until someone runs the packaged app. The SHARED build is 1 MB and links the
 * same `av*.dll` set the compositor already ships, so that is the one that gets
 * packaged (see the `filter` in electron-builder.json5) and the one preferred
 * here.
 */
export function ffmpegCandidates(here: string = process.cwd()): string[] {
	const tag = `${process.platform}-${process.arch}`;
	const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
	const env = process.env.OPENSCREEN_FFMPEG_PATH?.trim();
	const roots: string[] = [];
	// `app` is absent when this module is imported by a test.
	const appPath = (() => {
		try {
			return typeof app?.getAppPath === "function" ? app.getAppPath() : null;
		} catch {
			return null;
		}
	})();
	if (appPath) roots.push(appPath);
	if (process.resourcesPath) roots.push(process.resourcesPath);
	roots.push(here);

	const names =
		process.platform === "win32"
			? [
					// Staged flat by fetch-ffmpeg.mjs, beside the av*.dll set it links
					// against — the only ffmpeg the Windows installer carries.
					"ffmpeg-shared.exe",
					// The unpacked vendor tree, present in a dev checkout that has not
					// re-run the fetch script.
					path.join("ffmpeg-n8.1.2-win64-lgpl-shared", "bin", exe),
				]
			: [exe];
	return [
		...(env ? [env] : []),
		...roots.flatMap((root) =>
			names.map((n) => path.join(root, "electron", "native", "bin", tag, n)),
		),
	];
}

let cachedFfmpeg: string | null | undefined;

/**
 * Whether a candidate is something that can actually be run.
 *
 * EXISTENCE IS NOT ENOUGH, and the difference is not academic. `existsSync` was
 * the test here, and it answers true for a DIRECTORY: on a Linux dev machine
 * `electron/native/bin/<tag>/ffmpeg` used to be a folder holding the capture
 * helper's shared libraries (`libavcodec.so.62` and friends) rather than the
 * binary, so resolution picked the folder, every later candidate was skipped,
 * and the failure surfaced much later as `spawn … EACCES` — a message that
 * blames permissions rather than saying the wrong candidate was chosen.
 *
 * Those libraries have since moved to `<tag>/helper-ffmpeg/`, so this path is
 * the executable's alone again. The check stays regardless: it costs one stat,
 * and it is the difference between a clear null and an EACCES half a subsystem
 * away.
 *
 * Every failure mode is swallowed on purpose. A candidate that is absent, not a
 * regular file, or not executable is simply not this one; throwing out of
 * resolution would let a single bad path deny a later, working one.
 *
 * `X_OK` and not `X_OK | R_OK`: executing a binary needs the execute bit, not
 * the read bit, so an install shipped `--x` is legitimate and must not be
 * refused. On Windows `X_OK` is not enforced at all — there the `isFile` check
 * is the whole guard, which is enough for the failure this exists to stop,
 * since `ffmpegCandidates` only ever proposes `.exe` names of its own.
 */
function isExecutableFile(candidate: string): boolean {
	try {
		if (!statSync(candidate).isFile()) {
			return false;
		}
		accessSync(candidate, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * First candidate that is an executable file, or null when none is (callers
 * fall back).
 */
export function resolveFfmpeg(here?: string): string | null {
	if (cachedFfmpeg !== undefined && here === undefined) return cachedFfmpeg;
	const found = ffmpegCandidates(here).find(isExecutableFile) ?? null;
	if (here === undefined) cachedFfmpeg = found;
	return found;
}

/** Number of min/max blocks for a clip of `durationSec`. */
export function peakBlockCount(durationSec: number): number {
	return Math.min(MAX_PEAK_BLOCKS, Math.max(1, Math.ceil(durationSec * PEAK_BLOCKS_PER_SEC)));
}

/**
 * Folds a stream of mono int16 samples into `[min0, max0, min1, max1, ...]`.
 *
 * Incremental on purpose: the PCM for a 32-minute recording is 62 MB and never
 * needs to exist all at once. Kept as a class rather than a closure so it holds
 * only the counters it needs, not an enclosing scope.
 */
class PeakFolder {
	private readonly peaks: Float32Array;
	private readonly samplesPerBlock: number;
	private sampleIndex = 0;
	/** int16 straddling a chunk boundary: its low byte arrived, its high byte did not. */
	private pendingLowByte: number | null = null;

	constructor(
		private readonly blocks: number,
		totalSamples: number,
	) {
		this.peaks = new Float32Array(blocks * 2);
		this.samplesPerBlock = Math.max(1, totalSamples / blocks);
	}

	push(chunk: Buffer): void {
		let offset = 0;
		if (this.pendingLowByte !== null && chunk.length > 0) {
			this.addSample((chunk[0] << 8) | this.pendingLowByte);
			this.pendingLowByte = null;
			offset = 1;
		}
		const end = chunk.length - ((chunk.length - offset) % 2);
		for (let i = offset; i < end; i += 2) {
			this.addSample(chunk.readInt16LE(i));
		}
		if (end < chunk.length) this.pendingLowByte = chunk[end];
	}

	private addSample(raw: number): void {
		// readInt16LE is signed; the hand-assembled straddling sample is not.
		const signed = raw > 32767 ? raw - 65536 : raw;
		const value = signed / 32768;
		const block = Math.min(this.blocks - 1, Math.floor(this.sampleIndex / this.samplesPerBlock));
		const lo = block * 2;
		if (value < this.peaks[lo]) this.peaks[lo] = value;
		if (value > this.peaks[lo + 1]) this.peaks[lo + 1] = value;
		this.sampleIndex++;
	}

	result(): Float32Array {
		return this.peaks;
	}
}

/** Runs ffmpeg and folds its PCM straight into peaks. Never buffers the audio. */
async function decodePeaks(
	ffmpeg: string,
	filePath: string,
	durationSec: number,
): Promise<Float32Array> {
	const blocks = peakBlockCount(durationSec);
	const folder = new PeakFolder(blocks, durationSec * PCM_RATE);
	const child = spawn(
		ffmpeg,
		[
			"-hide_banner",
			"-loglevel",
			"error",
			"-i",
			filePath,
			"-vn",
			"-ac",
			"1",
			"-ar",
			String(PCM_RATE),
			"-f",
			"s16le",
			"-",
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);

	return new Promise<Float32Array>((resolve, reject) => {
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`ffmpeg timed out after ${DECODE_TIMEOUT_MS}ms on ${filePath}`));
		}, DECODE_TIMEOUT_MS);

		child.stdout.on("data", (c: Buffer) => folder.push(c));
		child.stderr.on("data", (c: Buffer) => {
			stderr = (stderr + c.toString()).slice(-2048);
		});
		child.once("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			// A file with no audio track exits non-zero. That is not an error worth
			// surfacing — it is a clip that legitimately has no waveform — but it is
			// the caller's job to decide, so it still rejects, with the reason.
			if (code !== 0) {
				reject(new Error(`ffmpeg exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
				return;
			}
			resolve(folder.result());
		});
	});
}

/**
 * Cache key: path plus size plus mtime. A recording is immutable in practice,
 * but keying on identity alone would serve stale peaks for a re-encoded or
 * replaced file, and that failure is silent and confusing.
 */
async function cacheKey(filePath: string): Promise<string> {
	const info = await stat(filePath);
	return createHash("sha1")
		.update(`${filePath}:${info.size}:${info.mtimeMs}`)
		.digest("hex")
		.slice(0, 32);
}

/** Null outside Electron (tests, any headless use): decoding still works, it
 *  just is not cached, rather than the whole call failing on a missing `app`. */
function cacheDir(): string | null {
	try {
		return typeof app?.getPath === "function"
			? path.join(app.getPath("userData"), "audio-peaks")
			: null;
	} catch {
		return null;
	}
}

/**
 * Peaks for `filePath`, from disk when they have been computed before.
 *
 * The cache is what makes this feel instant: peaks for a given recording never
 * change, so the ~2s decode is paid once ever rather than once per session.
 * Returns null when no ffmpeg is available, so the renderer can fall back to
 * its own pipelines instead of losing the waveform.
 */
export async function getAudioPeaks(
	filePath: string,
	durationSec: number,
): Promise<Float32Array | null> {
	const ffmpeg = resolveFfmpeg();
	if (!ffmpeg || !durationSec || durationSec <= 0) return null;

	const dir = cacheDir();
	const cachePath = dir ? path.join(dir, `${await cacheKey(filePath)}.f32`) : null;
	if (cachePath) {
		try {
			const cached = await readFile(cachePath);
			// A Buffer's memory may not be 4-byte aligned and its byteOffset is
			// almost never 0 — copy rather than viewing it in place.
			return new Float32Array(
				cached.buffer.slice(cached.byteOffset, cached.byteOffset + cached.byteLength),
			);
		} catch {
			// Not cached yet.
		}
	}

	const peaks = await decodePeaks(ffmpeg, filePath, durationSec);
	if (cachePath && dir) {
		try {
			await mkdir(dir, { recursive: true });
			await writeFile(cachePath, Buffer.from(peaks.buffer));
		} catch {
			// A cache we cannot write is a slower next launch, not a failure.
		}
	}
	return peaks;
}
