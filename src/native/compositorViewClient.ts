/**
 * Renderer-side client for the native D3D11 compositor view. Each function
 * sends a `compositor` domain `NativeBridgeRequest` over the existing
 * `native-bridge:invoke` channel. The compositor renders OFFSCREEN now —
 * there's no native OS window to embed, so no HWND crosses the IPC boundary
 * in either direction. The renderer instead pulls rendered frames via
 * `readCompositorFrame` and paints them into a `<canvas>`.
 */

import { requireNativeBridgeData } from "./client";
import type {
	CompositorClipInput,
	CompositorExportParams,
	CompositorExportResult,
	CompositorFramePacket,
	CompositorParamValue,
	CompositorViewRect,
	CompositorViewResult,
} from "./contracts";

export function createCompositorView(
	rect: CompositorViewRect,
	sources?: { screenPath?: string; webcamPath?: string; cursorPath?: string },
): Promise<CompositorViewResult> {
	return requireNativeBridgeData<CompositorViewResult>({
		domain: "compositor",
		action: "createView",
		payload: { rect, ...sources },
	});
}

export function setCompositorRect(id: number, rect: CompositorViewRect): Promise<{ ok: true }> {
	return requireNativeBridgeData<{ ok: true }>({
		domain: "compositor",
		action: "setRect",
		payload: { id, rect },
	});
}

/** Polls the most recently rendered frame for `id`, but only if its generation is
 *  newer than `sinceGen` (the generation the caller last painted). Returns a
 *  {@link CompositorFramePacket} on a new frame, or `null` when the addon is absent,
 *  no frame is ready yet, OR the caller already holds the current generation — the
 *  idle path, where `null` returns without any buffer crossing IPC. Pass `sinceGen = 0`
 *  to force delivery of the current frame. */
export function readCompositorFrame(
	id: number,
	sinceGen: number,
): Promise<CompositorFramePacket | null> {
	return requireNativeBridgeData<CompositorFramePacket | null>({
		domain: "compositor",
		action: "readFrame",
		payload: { id, sinceGen },
	});
}

export function setCompositorParam(
	id: number,
	key: string,
	value: CompositorParamValue,
): Promise<{ ok: true }> {
	return requireNativeBridgeData<{ ok: true }>({
		domain: "compositor",
		action: "setParam",
		payload: { id, key, value },
	});
}

export function setCompositorPlaying(id: number, playing: boolean): Promise<{ ok: true }> {
	return requireNativeBridgeData<{ ok: true }>({
		domain: "compositor",
		action: "setPlaying",
		payload: { id, playing },
	});
}

export function setCompositorTime(id: number, seconds: number): Promise<{ ok: true }> {
	return requireNativeBridgeData<{ ok: true }>({
		domain: "compositor",
		action: "presentTime",
		payload: { id, seconds },
	});
}

export function setCompositorScene(id: number, sceneJson: string): Promise<{ ok: true }> {
	return requireNativeBridgeData<{ ok: true }>({
		domain: "compositor",
		action: "setScene",
		payload: { id, sceneJson },
	});
}

export function setActiveClip(
	id: number,
	screenPath: string,
	webcamPath: string,
	webcamOffsetSec: number,
	clipIndex: number,
	sourceTimeSec: number,
): Promise<{ ok: true }> {
	return requireNativeBridgeData<{ ok: true }>({
		domain: "compositor",
		action: "setActiveClip",
		payload: { id, screenPath, webcamPath, webcamOffsetSec, clipIndex, sourceTimeSec },
	});
}

export function destroyCompositorView(id: number): Promise<{ ok: true }> {
	return requireNativeBridgeData<{ ok: true }>({
		domain: "compositor",
		action: "destroyView",
		payload: { id },
	});
}

export function exportNative(outPath?: string): Promise<CompositorExportResult> {
	return requireNativeBridgeData<CompositorExportResult>({
		domain: "compositor",
		action: "export",
		payload: { outPath },
	});
}

export function exportMultiNative(
	clips: CompositorClipInput[],
	outPath?: string,
	sceneJson?: string,
	params?: CompositorExportParams,
): Promise<CompositorExportResult> {
	return requireNativeBridgeData<CompositorExportResult>({
		domain: "compositor",
		action: "exportMulti",
		payload: { clips, outPath, sceneJson, params },
	});
}
