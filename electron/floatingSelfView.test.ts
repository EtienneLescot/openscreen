import type { BrowserWindow, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { FloatingSelfViewController } from "./floatingSelfView";

function fixture() {
	const windowHandlers = new Map<string, (...args: unknown[]) => void>();
	const webContentsHandlers = new Map<string, (...args: unknown[]) => void>();
	const sender = {
		isDestroyed: vi.fn(() => false),
		send: vi.fn(),
	} as unknown as WebContents;
	const hud = {
		isDestroyed: vi.fn(() => false),
		webContents: sender,
	} as unknown as BrowserWindow;
	const selfViewSender = {
		isDestroyed: vi.fn(() => false),
		isLoading: vi.fn(() => false),
		send: vi.fn(),
		on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
			webContentsHandlers.set(event, callback);
		}),
		once: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
			webContentsHandlers.set(event, callback);
		}),
	} as unknown as WebContents;
	const selfViewWindow = {
		isDestroyed: vi.fn(() => false),
		isVisible: vi.fn(() => false),
		showInactive: vi.fn(),
		hide: vi.fn(),
		destroy: vi.fn(),
		webContents: selfViewSender,
		on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
			windowHandlers.set(event, callback);
		}),
	} as unknown as BrowserWindow;
	const createWindow = vi.fn(() => selfViewWindow);
	const controller = new FloatingSelfViewController({
		createWindow,
		getHudWindow: () => hud,
		showTimeoutMs: 50,
	});
	return {
		controller,
		createWindow,
		hud,
		sender,
		selfViewSender,
		selfViewWindow,
		webContentsHandlers,
		windowHandlers,
	};
}

describe("capture-safe floating self-view controller", () => {
	it("pre-creates one hidden BrowserWindow and opens it only after camera readiness", async () => {
		const { controller, createWindow, sender, selfViewSender, selfViewWindow } = fixture();
		controller.precreate();
		controller.precreate();
		expect(createWindow).toHaveBeenCalledTimes(1);

		const show = controller.show(sender, " camera-id ");
		expect(selfViewSender.send).toHaveBeenCalledWith("floating-self-view-command", {
			visible: true,
			deviceId: "camera-id",
		});
		expect(selfViewWindow.showInactive).not.toHaveBeenCalled();

		expect(controller.handleReady(selfViewSender)).toEqual({ success: true });
		await expect(show).resolves.toEqual({ success: true });
		expect(selfViewWindow.showInactive).toHaveBeenCalledTimes(1);
		expect(controller.getState()).toEqual({ open: true });
	});

	it("rejects every sender except the active HUD webContents", async () => {
		const { controller, selfViewSender } = fixture();
		const attacker = {} as WebContents;

		await expect(controller.show(attacker)).resolves.toEqual({
			success: false,
			error: "unauthorized-sender",
		});
		expect(selfViewSender.send).not.toHaveBeenCalled();
	});

	it("does not acquire a camera after the HUD is destroyed", async () => {
		const { controller, sender, hud, selfViewSender } = fixture();
		vi.mocked(hud.isDestroyed).mockReturnValue(true);

		await expect(controller.show(sender)).resolves.toEqual({
			success: false,
			error: "hud-unavailable",
		});
		expect(selfViewSender.send).not.toHaveBeenCalled();
	});

	it("contains camera failure, hides the window, and leaves the caller running", async () => {
		const { controller, sender, selfViewSender, selfViewWindow } = fixture();
		const recordingStillActive = vi.fn(() => true);
		const show = controller.show(sender);

		expect(controller.handleFailure(selfViewSender)).toEqual({ success: true });
		await expect(show).resolves.toEqual({
			success: false,
			error: "camera-unavailable",
		});
		expect(selfViewWindow.hide).toHaveBeenCalled();
		expect(recordingStillActive()).toBe(true);
	});

	it("stops the secondary stream command on manual close and HUD teardown", async () => {
		const { controller, sender, selfViewSender, selfViewWindow } = fixture();
		const firstShow = controller.show(sender);
		controller.handleReady(selfViewSender);
		await firstShow;

		expect(controller.handleWindowClose(selfViewSender)).toEqual({ success: true });
		expect(selfViewWindow.hide).toHaveBeenCalledTimes(1);
		expect(selfViewSender.send).toHaveBeenLastCalledWith("floating-self-view-command", {
			visible: false,
		});

		const secondShow = controller.show(sender);
		controller.handleReady(selfViewSender);
		await secondShow;
		controller.hideForHudDestruction();
		expect(controller.getState()).toEqual({ open: false });
		expect(selfViewWindow.hide).toHaveBeenCalledTimes(2);
	});

	it("rejects readiness and close signals from any other renderer", () => {
		const { controller } = fixture();
		controller.precreate();
		const attacker = {} as WebContents;
		expect(controller.handleReady(attacker)).toEqual({
			success: false,
			error: "unauthorized-sender",
		});
		expect(controller.handleWindowClose(attacker)).toEqual({
			success: false,
			error: "unauthorized-sender",
		});
	});
});
