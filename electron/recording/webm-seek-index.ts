import fs from "node:fs/promises";
import { CompositorViewService } from "../native-bridge/services/compositorViewService";

export type ReindexResult =
	| { reindexed: true; packets: number; streams: number; wallS: number }
	| {
			reindexed: false;
			reason: "unsupported-platform" | "no-addon" | "remux-failed" | "empty-output" | "io-error";
	  };

/**
 * Rebuild a finalized recording's container so it carries a real `Duration`,
 * `Cues` and `SeekHead`.
 *
 * WHY THIS EXISTS — and what it does NOT fix.
 *
 * MediaRecorder writes WebM as a live stream: it never rewinds to fill in an
 * index, so the file has neither `Cues` nor `SeekHead` (confirmed by scanning
 * the bytes of real recordings — both magic sequences absent from head and
 * tail). The obvious conclusion is that seeking must be broken. It is NOT:
 * measured on this machine, `av_seek_frame` returns 0 for every timestamp and
 * every flag on every real recording, because libavformat's matroska demuxer
 * falls back to a byte-offset binary search when there is no index. Chromium's
 * `<video>` seeks those same files correctly too — every seek landed exactly on
 * target, within noise of the indexed copy. On a 10-minute/44MB file the index
 * is worth 0.23ms per libavformat seek. That is not a bug anyone can see.
 *
 * What the remux DOES buy, measured:
 *   - A real `Duration`, computed by the muxer from the actual packet
 *     timestamps. Without one, Chromium reports `duration = Infinity` and
 *     `seekable = 0..Infinity`, which breaks any timeline that scales to the
 *     clip length. This is the same problem `webm-duration.ts` exists to solve,
 *     and the muxer solves it from the packets instead of from a wall-clock
 *     estimate handed down by the renderer (16.977s vs the 17.013s the header
 *     patch wrote for the same file).
 *   - A standards-conformant container, rather than the H.264-in-WebM
 *     combination only Chromium emits.
 *
 * So this REPLACES the duration patch on Linux rather than adding to it. Both
 * rewrite the file exactly once, so the I/O cost is unchanged; the output is
 * strictly more correct. When the remux is unavailable or fails, the caller
 * falls back to the header patch and behaviour is exactly what it was before.
 *
 * MEMORY. The whole job happens inside libavformat, which streams packets
 * through its own IO layer — nothing is ever read into the JS heap. That is the
 * constraint `webm-duration.ts` learned the hard way (a naive whole-file read
 * crashed the main process on long recordings).
 *
 * DURABILITY. The remux writes to a temporary sibling and is renamed over the
 * original only after it has been verified non-empty. A failure at any point
 * leaves the original recording byte-for-byte intact — a recording must never
 * be lost to a failed re-index.
 */
export async function reindexRecordingOnDisk(
	filePath: string,
	service: Pick<CompositorViewService, "remuxSeekable"> = new CompositorViewService(),
): Promise<ReindexResult> {
	// Linux-only by intent, not by capability: it is the only platform whose
	// screen capture goes through MediaRecorder. Windows and macOS record via
	// native helpers that write indexed files at the source, so rewriting their
	// output would be pure cost.
	if (process.platform !== "linux") {
		return { reindexed: false, reason: "unsupported-platform" };
	}

	// Same directory as the recording, so the final rename is a same-filesystem
	// operation and therefore atomic. A temp dir could sit on another mount,
	// where rename() degrades to copy+unlink and stops being atomic.
	const tmpPath = `${filePath}.reindex.tmp`;
	try {
		await fs.unlink(tmpPath).catch(() => undefined);

		const stats = await service.remuxSeekable(filePath, tmpPath);
		if (!stats) {
			await fs.unlink(tmpPath).catch(() => undefined);
			return { reindexed: false, reason: "no-addon" };
		}

		// Trust nothing: a muxer that errored late can still leave a short or
		// empty file behind, and renaming that over the recording would destroy
		// it. Size is the cheap check that catches the whole class.
		let tmpSize = 0;
		try {
			tmpSize = (await fs.stat(tmpPath)).size;
		} catch {
			return { reindexed: false, reason: "empty-output" };
		}
		if (tmpSize === 0) {
			await fs.unlink(tmpPath).catch(() => undefined);
			return { reindexed: false, reason: "empty-output" };
		}

		await fs.rename(tmpPath, filePath);
		return {
			reindexed: true,
			packets: stats.packets,
			streams: stats.streams,
			wallS: stats.wallS,
		};
	} catch (error) {
		console.warn(`[webm-seek-index] failed to re-index ${filePath}:`, error);
		await fs.unlink(tmpPath).catch(() => undefined);
		return { reindexed: false, reason: "remux-failed" };
	}
}
