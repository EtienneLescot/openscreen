/**
 * The media an added word is spoken over.
 *
 * A word typed into the transcript has no recording behind it. Until there is TTS and frame
 * generation the stand-in is a TEST PATTERN over noise — a real file, with real frames and a
 * real audio track, so everything downstream decodes it like any other media instead of
 * special-casing its absence.
 *
 * ponytail: a mire, on purpose, and not the recording's last frame held. A held frame is
 * indistinguishable on screen from a decoder stuck at the end of a clip, which is exactly
 * the bug it hid. The mire says "this is generated media, and it is playing HERE" at a
 * glance. Swap it for synthesized frames the day there are any.
 *
 * DERIVED, never authored: the word is the truth, this file is regenerable from it. The name
 * carries what it was generated from, so a stale one is simply never asked for again, and a
 * missing one is a regeneration rather than a broken edit.
 */

import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { isGeneratedAssetId } from "../../src/lib/ai-edition/document/insertion";
import { resolveFfmpeg } from "./audioPeaks";

export interface ExtensionClipSpec {
	durationSec: number;
	/** Matched to the recording so the two concatenate without a re-encode downstream.
	 *  `0` when the asset was imported before the probe filled it in — see the fallbacks. */
	fps: number;
	width: number;
	height: number;
}

/** Noise rather than silence: a silent track is indistinguishable from a broken one, and
 *  this stands in for a voice that will be synthesized later. Loud enough to be unmistakable
 *  while the generated stretch is the thing being debugged. */
const NOISE_AMPLITUDE = 0.2;
const SAMPLE_RATE = 48_000;

/** The bundled ffmpeg is LGPL, so `libx264` is not in it — `libopenh264` is the software
 *  H.264 encoder every LGPL build carries, on every platform. */
const VIDEO_ENCODER = "libopenh264";

/** Assets imported before the probe filled `video` carry zeroes, and the live project does.
 *  ponytail: fixed, read the real geometry off the source when the probe backfills it. */
const FALLBACK_FPS = 30;
const FALLBACK_WIDTH = 1920;
const FALLBACK_HEIGHT = 1080;

/**
 * The ffmpeg arguments, as a pure function so the command can be asserted without running it.
 *
 * Two synthetic inputs and nothing else: the recording is not read at all, which is what
 * makes this fast, independent of what the source codec is, and impossible to confuse with
 * the recording once it is on screen.
 */
export function extensionClipArgs(spec: ExtensionClipSpec, outPath: string): string[] {
	const dur = spec.durationSec.toFixed(3);
	const fps = spec.fps > 0 ? spec.fps : FALLBACK_FPS;
	const width = spec.width > 0 ? spec.width : FALLBACK_WIDTH;
	const height = spec.height > 0 ? spec.height : FALLBACK_HEIGHT;
	return [
		"-y",
		"-hide_banner",
		"-loglevel",
		"error",
		"-f",
		"lavfi",
		"-i",
		`testsrc2=size=${width}x${height}:rate=${fps}:duration=${dur}`,
		"-f",
		"lavfi",
		"-i",
		`anoisesrc=c=pink:a=${NOISE_AMPLITUDE}:r=${SAMPLE_RATE}:d=${dur}`,
		"-map",
		"0:v",
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
 * Every insertion's media, generated if it is not already there.
 *
 * Read off the ASSETS, not the words: an insertion is a clip on an asset that already knows
 * its own path, its own length and its own geometry. There is nothing to derive here and
 * nothing to agree with the renderer about beyond the path it stored.
 *
 * Called on SAVE, the only moment the main process — the one that can spawn ffmpeg — sees
 * the document. Idempotent by name, so a save that adds nothing costs one `stat` per
 * insertion. A failure is logged and swallowed: an edit is not lost because a derived file
 * could not be written, and the clip renders black until the next save regenerates it.
 */
export async function ensureDocumentExtensions(document: {
	assets: ReadonlyArray<{
		id: string;
		originalPath?: string;
		durationSec?: number;
		video?: { width: number; height: number; fps: number };
	}>;
}): Promise<void> {
	for (const asset of document.assets) {
		if (!isGeneratedAssetId(asset.id) || !asset.originalPath || !asset.durationSec) continue;
		try {
			await ensureExtensionClip(
				{
					durationSec: asset.durationSec,
					fps: asset.video?.fps ?? 0,
					width: asset.video?.width ?? 0,
					height: asset.video?.height ?? 0,
				},
				asset.originalPath,
			);
		} catch (error) {
			console.error(`[insertion] ${asset.id}: ${(error as Error).message}`);
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
