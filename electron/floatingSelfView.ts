import type { BrowserWindow, WebContents } from "electron";

export interface AutoFloatingSelfViewResult {
	success: boolean;
	error?: "unauthorized-sender" | "hud-unavailable" | "request-failed";
}

const AUTO_PIP_RENDERER_CALL = "window.__openscreenRequestFloatingSelfView?.()";

/** Execute only a fixed renderer entry point, and only in the current HUD. */
export async function requestAutoFloatingSelfView(
	sender: WebContents,
	currentHud: BrowserWindow | null,
): Promise<AutoFloatingSelfViewResult> {
	if (!currentHud || currentHud.isDestroyed() || currentHud.webContents.isDestroyed()) {
		return { success: false, error: "hud-unavailable" };
	}
	if (sender !== currentHud.webContents) {
		return { success: false, error: "unauthorized-sender" };
	}

	try {
		const result = (await sender.executeJavaScript(AUTO_PIP_RENDERER_CALL, true)) as unknown;
		if (
			typeof result === "object" &&
			result !== null &&
			"success" in result &&
			typeof result.success === "boolean"
		) {
			return result.success ? { success: true } : { success: false, error: "request-failed" };
		}
		return { success: false, error: "request-failed" };
	} catch {
		return { success: false, error: "request-failed" };
	}
}
