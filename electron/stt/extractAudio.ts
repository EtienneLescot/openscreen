// Native mono-16k extraction for transcription, in the main process.
//
// The renderer used to do this: `extractMono16kFromVideoUrl` read the whole media
// into a `File`, took an `arrayBuffer()`, handed a `slice(0)` copy to
// `decodeAudioData`, and resampled the result to mono 16k — all of it on the UI
// thread, all of it before whisper ever saw a sample. On a four-minute bed that is
// ~86 MB of decoded float32 plus two copies of the encoded bytes, and it froze the
// editor at open. The inference itself was never the problem: it runs in
// `whisper-stt-server`, in its own process, on the GPU.
//
// So this is the same remedy `useAudioPeaks` already got (see
// `electron/media/audioPeaks.ts`, and the note there about WHICH ffmpeg is packaged
// on Windows): let ffmpeg do it, in the main process, streaming. It costs
// `durationSec * 16000 * 4` bytes — 15.7 MB for that same four-minute bed — and the
// renderer never allocates any of it.
//
// It is deliberately NOT cached on disk, unlike peaks. Peaks are re-read on every
// project open; extraction feeds one transcription, whose RESULT is what gets
// persisted (`document.transcripts[]`). Caching the PCM would trade disk for work
// that is already never repeated.

import { spawn } from "node:child_process";
import { resolveFfmpeg } from "../media/audioPeaks";
import { STT_NATIVE_EXTRACTION_UNAVAILABLE } from "./transcriptionContract";

/** What whisper.cpp wants, and what `decodePeaks` already asks ffmpeg for. */
const SAMPLE_RATE = 16_000;

/** Past this, it is not a recording — it is a wedged ffmpeg. Matches the peaks path. */
const EXTRACT_TIMEOUT_MS = 60_000;

/**
 * Thrown when no ffmpeg can be resolved, so the caller can fall back to the
 * renderer pipeline rather than failing the transcription outright. A distinct type
 * because "there is no ffmpeg here" and "this file has no audio" want opposite
 * responses: fall back, versus report a permanent failure for this asset.
 */
export class FfmpegUnavailableError extends Error {
	constructor() {
		super(`${STT_NATIVE_EXTRACTION_UNAVAILABLE}: no ffmpeg binary for native audio extraction`);
		this.name = "FfmpegUnavailableError";
	}
}

/** A media with no decodable audio track. Permanent for that file. */
export class NoAudioTrackError extends Error {
	constructor(filePath: string, detail: string) {
		super(`No decodable audio in ${filePath}${detail ? `: ${detail}` : ""}`);
		this.name = "NoAudioTrackError";
	}
}

/**
 * Decode `filePath` to mono 16 kHz float samples.
 *
 * Streams `f32le` straight off ffmpeg's stdout, so the only full-size allocation is
 * the result itself. Chunk boundaries do not respect sample boundaries — a 4-byte
 * float can straddle two `data` events — so a partial tail is carried into the next
 * chunk rather than dropped, which would shift every following sample and detune the
 * whole track.
 */
export async function extractMono16kPcm(
	filePath: string,
	options: { signal?: AbortSignal } = {},
): Promise<Float32Array> {
	const ffmpeg = resolveFfmpeg();
	if (!ffmpeg) throw new FfmpegUnavailableError();
	if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");

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
			String(SAMPLE_RATE),
			"-f",
			"f32le",
			"-",
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);

	return new Promise<Float32Array>((resolve, reject) => {
		const chunks: Float32Array[] = [];
		let total = 0;
		/** Bytes of a float that arrived split across two chunks. */
		let carry: Buffer | null = null;
		let stderr = "";
		let settled = false;

		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			fn();
		};

		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(() =>
				reject(new Error(`ffmpeg timed out after ${EXTRACT_TIMEOUT_MS}ms on ${filePath}`)),
			);
		}, EXTRACT_TIMEOUT_MS);

		const onAbort = () => {
			child.kill("SIGKILL");
			finish(() => reject(new DOMException("Aborted", "AbortError")));
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout.on("data", (c: Buffer) => {
			const buf = carry ? Buffer.concat([carry, c]) : c;
			const usable = buf.length - (buf.length % 4);
			if (usable > 0) {
				// Copy rather than view: a Buffer's memory is rarely 4-byte aligned, and
				// `byteOffset` is almost never 0.
				const view = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + usable));
				chunks.push(view);
				total += view.length;
			}
			carry = usable < buf.length ? Buffer.from(buf.subarray(usable)) : null;
		});
		child.stderr.on("data", (c: Buffer) => {
			stderr = (stderr + c.toString()).slice(-2048);
		});
		child.once("error", (err) => finish(() => reject(err)));
		child.once("close", (code) => {
			// A file with no audio track exits non-zero, and so does a corrupt one. The
			// caller treats both the same way — this asset will not transcribe — so they
			// share an error type; `stderr` carries which it was.
			if (code !== 0 && total === 0) {
				finish(() => reject(new NoAudioTrackError(filePath, stderr.trim())));
				return;
			}
			const out = new Float32Array(total);
			let at = 0;
			for (const part of chunks) {
				out.set(part, at);
				at += part.length;
			}
			finish(() => resolve(out));
		});
	});
}
