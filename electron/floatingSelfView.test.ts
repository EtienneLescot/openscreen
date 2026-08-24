import type { BrowserWindow, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { requestAutoFloatingSelfView } from "./floatingSelfView";

function fixture() {
	const sender = {
		isDestroyed: vi.fn(() => false),
		executeJavaScript: vi.fn(async () => ({ success: true })),
	} as unknown as WebContents;
	const hud = {
		isDestroyed: vi.fn(() => false),
		webContents: sender,
	} as unknown as BrowserWindow;
	return { sender, hud };
}

describe("automatic floating self-view IPC", () => {
	it("executes the fixed renderer entry point with a synthetic user gesture", async () => {
		const { sender, hud } = fixture();

		await expect(requestAutoFloatingSelfView(sender, hud)).resolves.toEqual({ success: true });
		expect(sender.executeJavaScript).toHaveBeenCalledWith(
			"window.__openscreenRequestFloatingSelfView?.()",
			true,
		);
	});

	it("rejects every sender except the active HUD webContents", async () => {
		const { sender, hud } = fixture();
		const attacker = { executeJavaScript: vi.fn() } as unknown as WebContents;

		await expect(requestAutoFloatingSelfView(attacker, hud)).resolves.toEqual({
			success: false,
			error: "unauthorized-sender",
		});
		expect(sender.executeJavaScript).not.toHaveBeenCalled();
		expect(attacker.executeJavaScript).not.toHaveBeenCalled();
	});

	it("does not execute code after the HUD is destroyed", async () => {
		const { sender, hud } = fixture();
		vi.mocked(hud.isDestroyed).mockReturnValue(true);

		await expect(requestAutoFloatingSelfView(sender, hud)).resolves.toEqual({
			success: false,
			error: "hud-unavailable",
		});
		expect(sender.executeJavaScript).not.toHaveBeenCalled();
	});

	it("contains renderer rejection without disturbing recording state", async () => {
		const { sender, hud } = fixture();
		vi.mocked(sender.executeJavaScript).mockRejectedValue(new Error("PiP denied"));

		await expect(requestAutoFloatingSelfView(sender, hud)).resolves.toEqual({
			success: false,
			error: "request-failed",
		});
	});
});
