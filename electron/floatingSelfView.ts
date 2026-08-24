import type { BrowserWindow, WebContents } from "electron";

export interface FloatingSelfViewResult {
	success: boolean;
	error?:
		| "unauthorized-sender"
		| "hud-unavailable"
		| "self-view-unavailable"
		| "camera-unavailable"
		| "request-timeout";
}

export interface FloatingSelfViewState {
	open: boolean;
}

interface PendingShow {
	resolve: (result: FloatingSelfViewResult) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface FloatingSelfViewControllerOptions {
	createWindow: () => BrowserWindow;
	getHudWindow: () => BrowserWindow | null;
	showTimeoutMs?: number;
}

function senderIsCurrentHud(sender: WebContents, currentHud: BrowserWindow | null): boolean {
	return Boolean(
		currentHud &&
			!currentHud.isDestroyed() &&
			!currentHud.webContents.isDestroyed() &&
			sender === currentHud.webContents,
	);
}

function normalizeDeviceId(deviceId: unknown): string | undefined {
	if (typeof deviceId !== "string") return undefined;
	const trimmed = deviceId.trim();
	return trimmed && trimmed.length <= 512 ? trimmed : undefined;
}

/**
 * Owns the capture-safe BrowserWindow fallback used after native macOS PiP
 * failed the recorded-file exclusion gate. The window exists (hidden) before
 * capture starts; its renderer opens a separate low-resolution camera stream
 * only after an authorized HUD asks to show it.
 */
export class FloatingSelfViewController {
	private window: BrowserWindow | null = null;
	private pendingShow: PendingShow | null = null;
	private open = false;
	private destroying = false;
	private readonly showTimeoutMs: number;

	constructor(private readonly options: FloatingSelfViewControllerOptions) {
		this.showTimeoutMs = options.showTimeoutMs ?? 10_000;
	}

	precreate(): BrowserWindow {
		if (this.window && !this.window.isDestroyed()) return this.window;

		const win = this.options.createWindow();
		this.window = win;
		this.destroying = false;

		win.on("close", (event) => {
			if (this.destroying) return;
			event.preventDefault();
			this.hideInternal();
		});
		win.on("closed", () => {
			if (this.window === win) this.window = null;
			this.open = false;
			this.finishPending({ success: false, error: "self-view-unavailable" });
			this.broadcastState();
		});
		win.webContents.on("render-process-gone", () => {
			this.open = false;
			this.finishPending({ success: false, error: "self-view-unavailable" });
			this.broadcastState();
		});

		return win;
	}

	getState(): FloatingSelfViewState {
		return { open: this.open };
	}

	ownsWindow(candidate: BrowserWindow): boolean {
		return this.window === candidate;
	}

	async show(sender: WebContents, deviceId?: unknown): Promise<FloatingSelfViewResult> {
		const hud = this.options.getHudWindow();
		if (!hud || hud.isDestroyed() || hud.webContents.isDestroyed()) {
			return { success: false, error: "hud-unavailable" };
		}
		if (!senderIsCurrentHud(sender, hud)) {
			return { success: false, error: "unauthorized-sender" };
		}

		let win: BrowserWindow;
		try {
			win = this.precreate();
		} catch {
			return { success: false, error: "self-view-unavailable" };
		}

		if (this.open && win.isVisible()) return { success: true };
		this.finishPending({ success: false, error: "self-view-unavailable" });

		return await new Promise<FloatingSelfViewResult>((resolve) => {
			const timer = setTimeout(() => {
				if (this.pendingShow?.resolve !== resolve) return;
				this.pendingShow = null;
				this.hideInternal();
				resolve({ success: false, error: "request-timeout" });
			}, this.showTimeoutMs);
			this.pendingShow = { resolve, timer };

			const requestCamera = () => {
				if (win.isDestroyed() || win.webContents.isDestroyed()) {
					this.finishPending({ success: false, error: "self-view-unavailable" });
					return;
				}
				win.webContents.send("floating-self-view-command", {
					visible: true,
					deviceId: normalizeDeviceId(deviceId),
				});
			};

			if (win.webContents.isLoading()) win.webContents.once("did-finish-load", requestCamera);
			else requestCamera();
		});
	}

	hide(sender: WebContents): FloatingSelfViewResult {
		const hud = this.options.getHudWindow();
		if (!senderIsCurrentHud(sender, hud)) {
			return {
				success: false,
				error: hud ? "unauthorized-sender" : "hud-unavailable",
			};
		}
		this.hideInternal();
		return { success: true };
	}

	hideForHudDestruction(): void {
		this.hideInternal();
	}

	handleReady(sender: WebContents): FloatingSelfViewResult {
		const win = this.window;
		if (!win || win.isDestroyed() || sender !== win.webContents) {
			return { success: false, error: "unauthorized-sender" };
		}
		this.open = true;
		win.showInactive();
		this.broadcastState();
		this.finishPending({ success: true });
		return { success: true };
	}

	handleFailure(sender: WebContents): FloatingSelfViewResult {
		const win = this.window;
		if (!win || win.isDestroyed() || sender !== win.webContents) {
			return { success: false, error: "unauthorized-sender" };
		}
		this.hideInternal({ success: false, error: "camera-unavailable" });
		return { success: true };
	}

	handleWindowClose(sender: WebContents): FloatingSelfViewResult {
		const win = this.window;
		if (!win || win.isDestroyed() || sender !== win.webContents) {
			return { success: false, error: "unauthorized-sender" };
		}
		this.hideInternal();
		return { success: true };
	}

	destroy(): void {
		const win = this.window;
		this.destroying = true;
		this.finishPending({ success: false, error: "self-view-unavailable" });
		if (win && !win.isDestroyed()) {
			if (!win.webContents.isDestroyed()) {
				win.webContents.send("floating-self-view-command", { visible: false });
			}
			win.destroy();
		}
		this.window = null;
		this.open = false;
	}

	private hideInternal(
		pendingResult: FloatingSelfViewResult = {
			success: false,
			error: "self-view-unavailable",
		},
	): void {
		const win = this.window;
		if (win && !win.isDestroyed()) {
			if (!win.webContents.isDestroyed()) {
				win.webContents.send("floating-self-view-command", { visible: false });
			}
			win.hide();
		}
		const changed = this.open;
		this.open = false;
		this.finishPending(pendingResult);
		if (changed) this.broadcastState();
	}

	private finishPending(result: FloatingSelfViewResult): void {
		const pending = this.pendingShow;
		if (!pending) return;
		this.pendingShow = null;
		clearTimeout(pending.timer);
		pending.resolve(result);
	}

	private broadcastState(): void {
		const hud = this.options.getHudWindow();
		if (!hud || hud.isDestroyed() || hud.webContents.isDestroyed()) return;
		hud.webContents.send("floating-self-view-state-changed", this.getState());
	}
}
