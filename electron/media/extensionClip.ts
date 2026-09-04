/**
 * The media an added word is spoken over.
 *
 * A word typed into the transcript has no recording behind it. Until there is TTS and frame
 * generation, the stand-in is the last frame the recording showed, held, over faint noise —
 * a real file, with real frames and a real audio track, so everything downstream decodes it
 * like any other media instead of special-casing its absence.
 *
 * DERIVED, never authored: the word is the truth, this file is regenerable from it. The name
 * carries what it was generated from, so a stale one is simply never asked for again, and a
 * missing one is a regeneration rather than a broken edit.
 */

import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import type { AxcutWord } from "../../src/lib/ai-edition/schema";
import {
	extensionClipPath,
	extensionDurationSec,
	isAddedWord,
} from "../../src/lib/ai-edition/timeline/clip-parts";
import { resolveFfmpeg } from "./audioPeaks";

export interface ExtensionClipSpec {
	/** The recording the frozen frame is taken from. */
	sourcePath: string;
	/** Source second to freeze on — the moment the added word follows. */
	atSec: number;
	durationSec: number;
	/** Matched to the recording so the two concatenate without a re-encode downstream.
	 *  `0` when the asset was imported before the probe filled it in — see `FALLBACK_FPS`. */
	fps: number;
	width: number;
	height: number;
}

/** Noise rather than silence: a silent track is indistinguishable from a broken one, and
 *  this stands in for a voice that will be synthesized later. Quiet enough not to startle. */
const NOISE_AMPLITUDE = 0.02;
const SAMPLE_RATE = 48_000;

/** The bundled ffmpeg is LGPL, so `libx264` is not in it — `libopenh264` is the software
 *  H.264 encoder every LGPL build carries, on every platform. The hardware encoders
 *  (`h264_nvenc`, `h264_mf`, …) are faster and each needs its own hardware; for a clip of a
 *  few seconds that trade is not worth a platform branch. */
const VIDEO_ENCODER = "libopenh264";

/** Assets imported before the probe filled `video.fps` carry 0, and the live project has
 *  one. A loop filter needs a rate, so it gets a common one.
 *  ponytail: fixed 30, read the real rate off the source when the probe backfills it. */
const FALLBACK_FPS = 30;

/**
 * The ffmpeg arguments, as a pure function so the command can be asserted without running it.
 *
 * One pass, no temp file: seek to the moment, keep the single frame there, loop it for the
 * duration, and mux it against a noise source of the same length.
 */
export function extensionClipArgs(spec: ExtensionClipSpec, outPath: string): string[] {
	const dur = spec.durationSec.toFixed(3);
	const fps = spec.fps > 0 ? spec.fps : FALLBACK_FPS;
	return [
		"-y",
		"-hide_banner",
		"-loglevel",
		"error",
		// Before `-i`, so ffmpeg seeks rather than decoding up to the moment.
		"-ss",
		spec.atSec.toFixed(3),
		"-i",
		spec.sourcePath,
		"-f",
		"lavfi",
		"-t",
		dur,
		"-i",
		`anoisesrc=c=pink:a=${NOISE_AMPLITUDE}:r=${SAMPLE_RATE}`,
		"-filter_complex",
		`[0:v]trim=end_frame=1,loop=loop=-1:size=1:start=0,fps=${fps},trim=duration=${dur},setpts=PTS-STARTPTS,scale=${spec.width}:${spec.height}[v]`,
		"-map",
		"[v]",
		"-map",
		"1:a",
		"-c:v",
		VIDEO_ENCODER,
		"-pix_fmt",
		"yuv420p",
		"-c:a",
		"aac",
		"-t",
		dur,
		outPath,
	];
}

/**
 * Every extension the document's words call for, generated if it is not already there.
 *
 * Called on SAVE, which is the only moment the main process — the one that can spawn ffmpeg
 * — sees the document. Idempotent by name, so a save that adds nothing costs one `stat` per
 * added word. A failure is logged and swallowed: the edit is not lost because a derived file
 * could not be written, and the segment renders black until the next save regenerates it.
 */
export async function ensureDocumentExtensions(document: {
	assets: ReadonlyArray<{
		id: string;
		originalPath?: string;
		video?: { width: number; height: number; fps: number };
	}>;
	transcripts: ReadonlyArray<{ assetId: string; words: ReadonlyArray<AxcutWord> }>;
}): Promise<void> {
	for (const transcript of document.transcripts) {
		const asset = document.assets.find((a) => a.id === transcript.assetId);
		if (!asset?.originalPath) continue;
		for (const word of transcript.words) {
			if (!isAddedWord(word)) continue;
			const durationSec = extensionDurationSec(word.text);
			if (durationSec <= 0) continue;
			const outPath = extensionClipPath(asset.originalPath, word.id, durationSec);
			try {
				await ensureExtensionClip(
					{
						sourcePath: asset.originalPath,
						atSec: word.startSec,
						durationSec,
						fps: asset.video?.fps ?? 0,
						width: asset.video?.width ?? 0,
						height: asset.video?.height ?? 0,
					},
					outPath,
				);
			} catch (error) {
				console.error(`[extension] ${word.id}: ${(error as Error).message}`);
			}
		}
	}
}

/**
 * Generate the file if it is not already there, and return its path.
 *
 * Idempotent: the same word and duration name the same file, which is reused rather than
 * re-encoded. The path is decided by `extensionClipPath`, so the renderer names the file it
 * expects and this writes the file it named — one rule, both sides.
 */
export async function ensureExtensionClip(
	spec: ExtensionClipSpec,
	outPath: string,
): Promise<string> {
	try {
		await access(outPath);
		return outPath;
	} catch {
		// Not there yet — generate it.
	}
	const ffmpeg = resolveFfmpeg();
	if (!ffmpeg) throw new Error("no bundled ffmpeg to generate the extension clip with");
	await mkdir(path.dirname(outPath), { recursive: true });
	await run(ffmpeg, extensionClipArgs(spec, outPath));
	return outPath;
}

function run(bin: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("error", reject);
		child.on("close", (code) =>
			code === 0
				? resolve()
				: reject(new Error(`ffmpeg exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`)),
		);
	});
}
