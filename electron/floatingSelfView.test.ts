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
			requestId: 1,
			deviceId: "camera-id",
		});
		expect(selfViewWindow.showInactive).not.toHaveBeenCalled();

		expect(controller.handleReady(selfViewSender, 1)).toEqual({ success: true });
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

		expect(controller.handleFailure(selfViewSender, 1)).toEqual({ success: true });
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
		controller.handleReady(selfViewSender, 1);
		await firstShow;

		expect(controller.handleWindowClose(selfViewSender)).toEqual({ success: true });
		expect(selfViewWindow.hide).toHaveBeenCalledTimes(1);
		expect(selfViewSender.send).toHaveBeenLastCalledWith("floating-self-view-command", {
			visible: false,
			requestId: 2,
		});

		const secondShow = controller.show(sender);
		controller.handleReady(selfViewSender, 3);
		await secondShow;
		controller.hideForHudDestruction();
		expect(controller.getState()).toEqual({ open: false });
		expect(selfViewWindow.hide).toHaveBeenCalledTimes(2);
	});

	it("rejects readiness and close signals from any other renderer", () => {
		const { controller } = fixture();
		controller.precreate();
		const attacker = {} as WebContents;
		expect(controller.handleReady(attacker, 1)).toEqual({
			success: false,
			error: "unauthorized-sender",
		});
		expect(controller.handleWindowClose(attacker)).toEqual({
			success: false,
			error: "unauthorized-sender",
		});
	});

	it("does not accept a null request ID when no show request is active", () => {
		const { controller, selfViewSender, selfViewWindow } = fixture();
		controller.precreate();

		expect(controller.handleReady(selfViewSender, null)).toEqual({ success: true });
		expect(selfViewWindow.showInactive).not.toHaveBeenCalled();
		expect(selfViewWindow.hide).toHaveBeenCalledTimes(1);
		expect(controller.getState()).toEqual({ open: false });
	});

	it("ignores readiness that arrives after the show request times out", async () => {
		vi.useFakeTimers();
		try {
			const { controller, sender, selfViewSender, selfViewWindow } = fixture();
			const show = controller.show(sender);

			await vi.advanceTimersByTimeAsync(50);
			await expect(show).resolves.toEqual({
				success: false,
				error: "request-timeout",
			});
			expect(controller.handleReady(selfViewSender, 1)).toEqual({ success: true });
			expect(selfViewWindow.showInactive).not.toHaveBeenCalled();
			expect(selfViewWindow.hide).toHaveBeenCalled();
			expect(controller.getState()).toEqual({ open: false });
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps a replacement request pending when stale readiness arrives", async () => {
		const { controller, sender, selfViewSender, selfViewWindow } = fixture();
		const firstShow = controller.show(sender);
		const replacementShow = controller.show(sender);

		await expect(firstShow).resolves.toEqual({
			success: false,
			error: "self-view-unavailable",
		});
		expect(controller.handleReady(selfViewSender, 1)).toEqual({ success: true });
		expect(selfViewWindow.showInactive).not.toHaveBeenCalled();
		expect(controller.getState()).toEqual({ open: false });

		expect(controller.handleReady(selfViewSender, 2)).toEqual({ success: true });
		await expect(replacementShow).resolves.toEqual({ success: true });
		expect(selfViewWindow.showInactive).toHaveBeenCalledTimes(1);
		expect(controller.getState()).toEqual({ open: true });
	});

	it("does not fail a replacement request when stale camera failure arrives", async () => {
		const { controller, sender, selfViewSender, selfViewWindow } = fixture();
		const firstShow = controller.show(sender);
		const replacementShow = controller.show(sender);

		await expect(firstShow).resolves.toEqual({
			success: false,
			error: "self-view-unavailable",
		});
		expect(controller.handleFailure(selfViewSender, 1)).toEqual({ success: true });
		expect(controller.getState()).toEqual({ open: false });

		controller.handleReady(selfViewSender, 2);
		await expect(replacementShow).resolves.toEqual({ success: true });
		expect(selfViewWindow.showInactive).toHaveBeenCalledTimes(1);
	});
});
