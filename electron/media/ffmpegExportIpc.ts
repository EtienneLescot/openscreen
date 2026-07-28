import { ipcMain } from "electron";
import {
	cancelExport,
	finishExport,
	resolveExportCapabilities,
	type StartExportRequest,
	startExport,
	writeExportFrame,
} from "./ffmpegExportService";

/**
 * IPC surface for the native export encoder.
 *
 * The renderer composites and extracts frames but cannot spawn ffmpeg — it is
 * sandboxed and stays that way. Dropping the sandbox (option A') was measured
 * and buys nothing: with the crossing at exactly zero the pipeline still loses
 * to WebCodecs, because the wall is the compositor, not this path. See
 * docs/architecture/export-pipeline.md §5.
 *
 * This whole path is REFUTED (§5): feeding native ffmpeg from the renderer is
 * 2.1x SLOWER than what we ship. It survives as bench scaffolding, not as a
 * plan.
 *
 * Frames are `send`, not `invoke`: they are one-way and there is nothing to
 * return. Flow control is the renderer's credit window (8 frames in flight),
 * acknowledged by `EXPORT_FRAME_ACK` — measured worth +56% over stop-and-wait.
 */

export const EXPORT_CAPABILITIES = "export:capabilities";
export const EXPORT_START = "export:start";
export const EXPORT_FRAME = "export:frame";
export const EXPORT_FRAME_ACK = "export:frame-ack";
export const EXPORT_FINISH = "export:finish";
export const EXPORT_CANCEL = "export:cancel";

export function registerFfmpegExportIpc(): void {
	ipcMain.handle(EXPORT_CAPABILITIES, async () => {
		const { encoder } = await resolveExportCapabilities();
		return { encoder };
	});

	ipcMain.handle(EXPORT_START, async (_e, req: StartExportRequest) => startExport(req));

	ipcMain.on(EXPORT_FRAME, async (e, sessionId: string, frame: ArrayBuffer) => {
		try {
			await writeExportFrame(sessionId, frame);
			// Ack even on the last frame: the renderer's window must refill or it
			// will stall short of the end.
			if (!e.sender.isDestroyed()) e.sender.send(EXPORT_FRAME_ACK, sessionId, null);
		} catch (err) {
			// A write failure means ffmpeg died mid-export. Report it on the ack
			// channel rather than throwing into an ipcMain.on handler, where the
			// rejection would be unhandled and the renderer would wait forever.
			if (!e.sender.isDestroyed()) {
				e.sender.send(EXPORT_FRAME_ACK, sessionId, (err as Error).message);
			}
		}
	});

	ipcMain.handle(EXPORT_FINISH, async (_e, sessionId: string) => finishExport(sessionId));
	ipcMain.handle(EXPORT_CANCEL, async (_e, sessionId: string) => cancelExport(sessionId));
}
