import fs from "node:fs/promises";
import { createFile } from "mp4box";

const MIN_SALVAGEABLE_MP4_BYTES = 1024;
const PARSE_CHUNK_BYTES = 1024 * 1024;

type ParsedMovie = {
	hasMoov: boolean;
	duration: number;
	timescale: number;
	videoTracks: Array<{
		codec: string;
		duration: number;
		timescale: number;
		nb_samples: number;
		video?: { width: number; height: number };
	}>;
};

type PositionedArrayBuffer = ArrayBuffer & { fileStart: number };

/**
 * Parses the MP4 incrementally, without retaining `mdat`, and requires a real
 * video sample table. Atom names alone are insufficient: a zero-filled `moov`
 * shell looks superficially complete but cannot be opened by the editor.
 */
async function hasReadableVideoStream(filePath: string): Promise<boolean> {
	let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
	try {
		handle = await fs.open(filePath, "r");
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size < MIN_SALVAGEABLE_MP4_BYTES) return false;

		const parser = createFile(false);
		let movie: ParsedMovie | null = null;
		let parseFailed = false;
		parser.onReady = (info) => {
			movie = info as ParsedMovie;
		};
		parser.onError = () => {
			parseFailed = true;
		};

		let offset = 0;
		while (offset < stat.size) {
			const bytesToRead = Math.min(PARSE_CHUNK_BYTES, stat.size - offset);
			const chunk = Buffer.allocUnsafe(bytesToRead);
			const { bytesRead } = await handle.read(chunk, 0, bytesToRead, offset);
			if (bytesRead !== bytesToRead) return false;
			const arrayBuffer = chunk.buffer.slice(
				chunk.byteOffset,
				chunk.byteOffset + bytesRead,
			) as PositionedArrayBuffer;
			arrayBuffer.fileStart = offset;
			parser.appendBuffer(arrayBuffer, offset + bytesRead === stat.size);
			offset += bytesRead;
		}
		parser.flush();

		if (parseFailed || !movie) return false;
		const parsedMovie = movie as ParsedMovie;
		return (
			parsedMovie.hasMoov &&
			parsedMovie.duration > 0 &&
			parsedMovie.timescale > 0 &&
			parsedMovie.videoTracks.some(
				(track) =>
					track.codec.length > 0 &&
					track.duration > 0 &&
					track.timescale > 0 &&
					track.nb_samples > 0 &&
					(track.video?.width ?? 0) > 0 &&
					(track.video?.height ?? 0) > 0,
			)
		);
	} catch {
		return false;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

/** A file is never inspected while the helper may still be mutating it. */
export async function isSalvageableNativeMacCapture(
	filePath: string | null,
	helperExited: boolean,
): Promise<boolean> {
	if (!filePath || !helperExited) return false;
	return hasReadableVideoStream(filePath);
}

export type NativeMacCaptureStopResolution = {
	path: string;
	recovered: boolean;
	stopError?: unknown;
};

/**
 * Keeps the normal acknowledgement path unchanged. If acknowledgement fails,
 * recovery is allowed only after helper exit and successful media parsing.
 */
export async function resolveNativeMacCaptureStop(options: {
	preferredPath: string | null;
	waitForStop: () => Promise<string>;
	waitForExit: () => Promise<boolean>;
	isSalvageable?: (filePath: string | null, helperExited: boolean) => Promise<boolean>;
}): Promise<NativeMacCaptureStopResolution> {
	try {
		return { path: await options.waitForStop(), recovered: false };
	} catch (stopError) {
		const helperExited = await options.waitForExit();
		const isSalvageable = options.isSalvageable ?? isSalvageableNativeMacCapture;
		if (
			!helperExited ||
			!(await isSalvageable(options.preferredPath, helperExited)) ||
			!options.preferredPath
		) {
			throw stopError;
		}
		return { path: options.preferredPath, recovered: true, stopError };
	}
}
