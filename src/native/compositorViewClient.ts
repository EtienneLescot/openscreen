/**
 * Renderer-side client for the native D3D11 compositor view. Each function
 * sends a `compositor` domain `NativeBridgeRequest` over the existing
 * `native-bridge:invoke` channel. The parent window handle is supplied
 * main-side (it never crosses the IPC boundary), so the renderer's
 * `createCompositorView` only takes the rect.
 */

import { requireNativeBridgeData } from "./client";
import type { CompositorParamValue, CompositorViewRect, CompositorViewResult } from "./contracts";

export function createCompositorView(rect: CompositorViewRect): Promise<CompositorViewResult> {
	return requireNativeBridgeData<CompositorViewResult>({
		domain: "compositor",
		action: "createView",
		payload: { rect },
	});
}

export function setCompositorRect(id: number, rect: CompositorViewRect): Promise<{ ok: true }> {
	return requireNativeBridgeData<{ ok: true }>({
		domain: "compositor",
		action: "setRect",
		payload: { id, rect },
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

export function destroyCompositorView(id: number): Promise<{ ok: true }> {
	return requireNativeBridgeData<{ ok: true }>({
		domain: "compositor",
		action: "destroyView",
		payload: { id },
	});
}
