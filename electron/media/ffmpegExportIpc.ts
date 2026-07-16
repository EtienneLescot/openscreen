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
 * sandboxed and stays that way (see docs/architecture/native-core-tauri-spec.md
 * §3.2: dropping the sandbox buys ~2x and costs the lock that guards
 * user-supplied media). So frames cross here and main feeds ffmpeg's stdin.
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
