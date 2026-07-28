import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	candidateFfmpegPaths,
	parseAvailableEncoders,
	pickWorkingEncoder,
	type VideoEncoderId,
} from "./ffmpegCapabilities";
import { type FfmpegEncodeSession, startFfmpegEncodeSession } from "./ffmpegEncodeSession";

/**
 * Main-process side of the native export encoder: resolves the bundled ffmpeg,
 * proves which encoder actually works on this machine, and owns the live encode
 * sessions the renderer streams frames into.
 *
 * The renderer cannot spawn anything (it is sandboxed, and stays that way), so
 * frames cross to us over IPC and we feed ffmpeg's stdin. ffmpeg encodes, muxes
 * the audio and writes the file — there is no JS muxer and no WebCodecs path
 * behind this.
 */

export interface StartExportRequest {
	/**
	 * Omit to have main write to a temp file and return the path.
	 *
	 * The renderer is sandboxed and does not get to name a path main will write
	 * to — that would hand a compromised renderer an arbitrary file write. A
	 * user-chosen destination must come from a main-side save dialog, and the
	 * finished temp file is moved there.
	 */
	outputPath?: string;
	width: number;
	height: number;
	frameRate: number;
	bitrate: number;
	pixelFormat: "nv12" | "bgra" | "rgba";
	/** Raw interleaved float32 PCM. ffmpeg encodes AAC and muxes it. */
	audio?: { pcm: ArrayBuffer; sampleRate: number; channels: number; bitrate: number };
}

export interface StartExportResult {
	sessionId: string;
	encoder: VideoEncoderId;
	/** Where ffmpeg is actually writing — main's choice when the caller omitted one. */
	outputPath: string;
}

/** Resolved once per process: the probe costs a few spawns, the answer never changes. */
let capabilitiesPromise: Promise<{ ffmpegPath: string; encoder: VideoEncoderId }> | null = null;

async function firstExisting(paths: string[]): Promise<string | null> {
	for (const p of paths) {
		try {
			await fs.access(p);
			return p;
		} catch {
			// Expected: candidateFfmpegPaths lists every layout we might be running
			// under (dev tree, unpacked staging, packaged resources); most miss.
		}
	}
	return null;
}

function runFfmpeg(ffmpegPath: string, args: string[]): Promise<{ code: number; stdout: string }> {
	return new Promise((resolve) => {
		const child = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "ignore"] });
		let stdout = "";
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (c: string) => {
			stdout += c;
		});
		child.on("error", () => resolve({ code: -1, stdout: "" }));
		child.on("close", (code) => resolve({ code: code ?? -1, stdout }));
	});
}

/**
 * Which encoder this machine can really use. Cached: the smoke tests spawn ffmpeg
 * a few times, and hardware does not change under a running app.
 *
 * The smoke test is the whole point. `ffmpeg -encoders` reports what was compiled
 * in — our portable build lists nvenc, qsv and amf on every machine — so on an
 * AMD box nvenc is "available" and then dies with "Cannot load nvcuda.dll".
 * Presence is not capability; only a real one-frame encode settles it.
 */
export function resolveExportCapabilities(): Promise<{
	ffmpegPath: string;
	encoder: VideoEncoderId;
}> {
	capabilitiesPromise ??= (async () => {
		const ffmpegPath = await firstExisting(
			candidateFfmpegPaths({
				platform: process.platform,
				arch: process.arch,
				appPath: process.env.OPENSCREEN_APP_PATH ?? null,
				resourcesPath: process.resourcesPath ?? null,
				envOverride: process.env.OPENSCREEN_FFMPEG_EXE ?? null,
			}),
		);
		if (!ffmpegPath) {
			throw new Error(
				"Bundled ffmpeg not found. Run `npm run fetch:ffmpeg` in development; " +
					"in a packaged build this means the binary was not shipped.",
			);
		}

		const listed = await runFfmpeg(ffmpegPath, ["-hide_banner", "-encoders"]);
		const available = parseAvailableEncoders(listed.stdout);
		const encoder = await pickWorkingEncoder(
			available,
			process.platform,
			async (args) => (await runFfmpeg(ffmpegPath, args)).code === 0,
		);
		if (!encoder) {
			// libopenh264 is software and part of our build, so it should always pass.
			// Reaching here means the binary is broken, not that the machine is
			// unsupported — and there is no other path to fall back to.
			throw new Error(
				"No usable H.264 encoder in the bundled ffmpeg — not even software. " +
					"The bundled binary is broken or was replaced.",
			);
		}
		return { ffmpegPath, encoder };
	})();
	return capabilitiesPromise;
}

interface LiveSession {
	session: FfmpegEncodeSession;
	/** Temp PCM handed to ffmpeg as its second input; ours to delete. */
	audioPath: string | null;
	tmpDir: string | null;
}

const sessions = new Map<string, LiveSession>();
let nextId = 1;

export async function startExport(req: StartExportRequest): Promise<StartExportResult> {
	const { ffmpegPath, encoder } = await resolveExportCapabilities();

	const sessionId = `export-${nextId++}`;

	let audioPath: string | null = null;
	let tmpDir: string | null = null;
	if (req.audio && req.audio.pcm.byteLength > 0) {
		// ffmpeg reads raw f32le straight from disk. Writing the PCM out beats a
		// second pipe: it is small (a few MB), and stdin is already carrying video.
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openscreen-export-"));
		audioPath = path.join(tmpDir, "audio.f32le");
		await fs.writeFile(audioPath, Buffer.from(req.audio.pcm));
	}

	// Deliberately NOT inside tmpDir: dispose() wipes that, and the output has to
	// outlive the session so it can be moved to the user's destination.
	const outputPath = req.outputPath ?? path.join(os.tmpdir(), `openscreen-${sessionId}.mp4`);

	const session = startFfmpegEncodeSession({
		ffmpegPath,
		encoder,
		outputPath,
		width: req.width,
		height: req.height,
		frameRate: req.frameRate,
		bitrate: req.bitrate,
		pixelFormat: req.pixelFormat,
		audio:
			audioPath && req.audio
				? {
						path: audioPath,
						sampleRate: req.audio.sampleRate,
						channels: req.audio.channels,
						bitrate: req.audio.bitrate,
					}
				: undefined,
	});

	sessions.set(sessionId, { session, audioPath, tmpDir });
	return { sessionId, encoder, outputPath };
}

function requireSession(sessionId: string): LiveSession {
	const live = sessions.get(sessionId);
	if (!live) throw new Error(`Unknown export session: ${sessionId}`);
	return live;
}

export async function writeExportFrame(sessionId: string, frame: ArrayBuffer): Promise<void> {
	// Buffer.from(arrayBuffer) wraps rather than copies — the +31% we measured
	// depends on not duplicating a multi-MB frame here.
	await requireSession(sessionId).session.writeFrame(new Uint8Array(frame));
}

async function dispose(sessionId: string, live: LiveSession): Promise<void> {
	sessions.delete(sessionId);
	if (live.tmpDir) await fs.rm(live.tmpDir, { recursive: true, force: true });
}

export async function finishExport(sessionId: string): Promise<{ outputPath: string }> {
	const live = requireSession(sessionId);
	try {
		return await live.session.finish();
	} finally {
		await dispose(sessionId, live);
	}
}

export async function cancelExport(sessionId: string): Promise<void> {
	const live = sessions.get(sessionId);
	if (!live) return; // Already finished or never started: cancelling is idempotent.
	try {
		await live.session.cancel();
	} finally {
		await dispose(sessionId, live);
	}
}

/** Kill every live session — called when the app quits so no ffmpeg is orphaned. */
export async function cancelAllExports(): Promise<void> {
	await Promise.all([...sessions.keys()].map((id) => cancelExport(id)));
}
