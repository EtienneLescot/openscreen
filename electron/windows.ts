import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BrowserWindow, ipcMain, screen } from "electron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const APP_ROOT = path.join(__dirname, "..");
const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
const RENDERER_DIST = path.join(APP_ROOT, "dist");
const HEADLESS = process.env["HEADLESS"] === "true";

// The HUD and Notes windows are excluded from every screen/window capture (WGC on Windows uses
// the same SetWindowDisplayAffinity this sets), so the recording controls never end up baked into
// the recorded video.
//
// The side effect is that they are equally invisible to an *agent's* screenshots, and the HUD is
// what opens the editor — which makes a whole slice of the app unreachable from automation. Hence
// this escape hatch, for testing only. It warns on every window it skips, because a recording made
// while it is set WILL contain the HUD.
const CONTENT_PROTECTION_DISABLED = process.env["OPENSCREEN_DISABLE_CONTENT_PROTECTION"] === "1";

function applyContentProtection(win: BrowserWindow, label: string) {
	if (CONTENT_PROTECTION_DISABLED) {
		console.warn(
			`[content-protection] OFF for the ${label} window ` +
				"(OPENSCREEN_DISABLE_CONTENT_PROTECTION=1) — it will appear in screen captures, " +
				"including recordings. Unset it for anything but automated testing.",
		);
		return;
	}
	win.setContentProtection(true);
}

// Asset base URL for renderer (wallpapers, etc.). Packaged: extraResources copies
// public/wallpapers to resources/wallpapers. Unpackaged: <appRoot>/public/.
const ASSET_BASE_DIR = process.defaultApp
	? path.join(__dirname, "..", "public")
	: process.resourcesPath;
const ASSET_BASE_URL_ARG = `--asset-base-url=${pathToFileURL(`${ASSET_BASE_DIR}${path.sep}`).toString()}`;

let hudOverlayWindow: BrowserWindow | null = null;

// Origin the current drag gesture started from. The renderer sends the pointer's
// *total* travel since pointerdown rather than per-frame deltas, so every move is
// an absolute `origin + delta` — no rounding to accumulate, and a dropped message
// self-corrects on the next one instead of leaving the window permanently offset.
let hudDragOrigin: { x: number; y: number } | null = null;

ipcMain.on("hud-overlay-hide", () => {
	if (hudOverlayWindow && !hudOverlayWindow.isDestroyed()) {
		hudOverlayWindow.minimize();
	}
});

ipcMain.on("hud-overlay-ignore-mouse-events", (_event, ignore: boolean) => {
	if (hudOverlayWindow && !hudOverlayWindow.isDestroyed()) {
		hudOverlayWindow.setIgnoreMouseEvents(ignore, { forward: true });
	}
});

ipcMain.on("hud-overlay-drag-start", () => {
	if (!hudOverlayWindow || hudOverlayWindow.isDestroyed()) {
		return;
	}

	const [x, y] = hudOverlayWindow.getPosition();
	hudDragOrigin = { x, y };
});

ipcMain.on("hud-overlay-drag-to", (_event, deltaX: number, deltaY: number) => {
	if (
		!hudOverlayWindow ||
		hudOverlayWindow.isDestroyed() ||
		!hudDragOrigin ||
		!Number.isFinite(deltaX) ||
		!Number.isFinite(deltaY)
	) {
		return;
	}

	hudOverlayWindow.setPosition(
		Math.round(hudDragOrigin.x + deltaX),
		Math.round(hudDragOrigin.y + deltaY),
		false,
	);
});

ipcMain.on("hud-overlay-drag-end", () => {
	hudDragOrigin = null;
});

// Resize the HUD to fit its rendered content. Anchored by its bottom-centre so it
// stays where the user dragged it while only growing/shrinking, which lets the
// vertical tray layout grow tall instead of scrolling inside a fixed window.
//
// Applied in one shot rather than tweened. The renderer now reserves space for
// everything that can float above the bar, so a resize only ever accompanies a
// discrete content change (orientation flip, recording controls appearing) that
// snaps anyway — tweening the window across 10 frames just meant 10 frames of the
// bar sitting at an offset that didn't match the content it was drawn with.
ipcMain.on("hud-overlay-set-size", (_event, width: number, height: number) => {
	if (
		!hudOverlayWindow ||
		hudOverlayWindow.isDestroyed() ||
		!Number.isFinite(width) ||
		!Number.isFinite(height)
	) {
		return;
	}

	// A resize re-anchors from the window's current bounds, which would fight the
	// position an in-flight drag is applying. The renderer re-measures on release.
	if (hudDragOrigin) {
		return;
	}

	const bounds = hudOverlayWindow.getBounds();

	// Clamp to the work area of the display the HUD sits on; on a short screen the
	// vertical layout can exceed the display, where the bar's own overflow scroll takes over.
	const { workArea } = screen.getDisplayMatching(bounds);
	const nextWidth = Math.min(workArea.width, Math.max(1, Math.round(width)));
	const nextHeight = Math.min(workArea.height, Math.max(1, Math.round(height)));

	if (bounds.width === nextWidth && bounds.height === nextHeight) {
		return;
	}

	const centerX = bounds.x + bounds.width / 2;
	const bottomY = bounds.y + bounds.height;

	// Growing height keeps the bottom edge anchored (so the vertical tray grows
	// upward from where the user left it), but that alone can push the top edge
	// above the screen — e.g. switching to the tall vertical layout while sitting
	// low/mid-screen. The drag handle lives at the tray's start (top, in vertical
	// mode), so an off-screen top edge makes the HUD both invisible and
	// undraggable back into view. Clamp both axes to the display's work area so
	// the window (and its drag handle) always stays fully reachable.
	const nextX = Math.min(
		Math.max(workArea.x, Math.round(centerX - nextWidth / 2)),
		workArea.x + workArea.width - nextWidth,
	);
	const nextY = Math.min(
		Math.max(workArea.y, Math.round(bottomY - nextHeight)),
		workArea.y + workArea.height - nextHeight,
	);

	hudOverlayWindow.setBounds({
		x: nextX,
		y: nextY,
		width: nextWidth,
		height: nextHeight,
	});
});

/**
 * Frameless transparent HUD overlay, always-on-top, centred at the bottom of the
 * primary display. Follows the user across macOS Spaces so it isn't lost on switch.
 */
export function createHudOverlayWindow(): BrowserWindow {
	const primaryDisplay = screen.getPrimaryDisplay();
	const { workArea } = primaryDisplay;

	// Close to what the renderer asks for on its very first measurement (bar plus
	// the reserved space above it), so the HUD doesn't visibly resize itself the
	// instant it becomes visible. See src/components/launch/hudGeometry.ts.
	const windowWidth = 820;
	const windowHeight = 560;

	const x = Math.floor(workArea.x + (workArea.width - windowWidth) / 2);
	const y = Math.floor(workArea.y + workArea.height - windowHeight - 5);

	const win = new BrowserWindow({
		width: windowWidth,
		height: windowHeight,
		// Min/max are intentionally loose: the renderer resizes to fit content via
		// "hud-overlay-set-size" (above), needed for the vertical tray to grow taller.
		minWidth: 120,
		minHeight: 80,
		x: x,
		y: y,
		frame: false,
		transparent: true,
		// Fully-transparent ARGB backing. Without this macOS draws the window as a
		// rounded glass panel with a border around the HUD content.
		backgroundColor: "#00000000",
		// Don't let macOS mask the window into a rounded rect; the HUD bar provides
		// its own rounding and the window itself must be invisible.
		roundedCorners: false,
		resizable: false,
		alwaysOnTop: true,
		skipTaskbar: true,
		hasShadow: false,
		show: false, // shown via ready-to-show to avoid black rectangle flash
		webPreferences: {
			preload: path.join(__dirname, "preload.mjs"),
			additionalArguments: [ASSET_BASE_URL_ARG],
			nodeIntegration: false,
			contextIsolation: true,
			backgroundThrottling: false,
		},
	});
	win.setIgnoreMouseEvents(true, { forward: true });

	// Keep the recording controls out of the recording (see applyContentProtection).
	applyContentProtection(win, "HUD");

	// Follow the user across macOS Spaces, else the HUD stays pinned to the Space
	// it was first opened on.
	if (process.platform === "darwin") {
		win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
	}

	// Show only once painted to avoid the black rectangle flash when a transparent
	// window is shown before its first paint.
	win.once("ready-to-show", () => {
		applyContentProtection(win, "HUD");
		if (!HEADLESS) win.show();
	});

	win.webContents.on("did-finish-load", () => {
		win?.webContents.send("main-process-message", new Date().toLocaleString());
	});

	hudOverlayWindow = win;

	win.on("closed", () => {
		if (hudOverlayWindow === win) {
			hudOverlayWindow = null;
			hudDragOrigin = null;
		}
	});

	if (VITE_DEV_SERVER_URL) {
		win.loadURL(VITE_DEV_SERVER_URL + "?windowType=hud-overlay");
	} else {
		win.loadFile(path.join(RENDERER_DIST, "index.html"), {
			query: { windowType: "hud-overlay" },
		});
	}

	return win;
}

/**
 * Main editor window. Starts maximised with a hidden title bar on macOS; not
 * always-on-top and appears in the taskbar/dock.
 *
 * `query` overrides the renderer's routing params. The export bench passes
 * windowType=bench so it runs under THIS window's webPreferences — same
 * preload, same sandbox, same backgroundThrottling:false — because a bench that
 * configures its own window measures a different app than the one we ship.
 */
export function createEditorWindow(query: Record<string, string> = {}): BrowserWindow {
	const isMac = process.platform === "darwin";

	const win = new BrowserWindow({
		width: 1200,
		height: 800,
		minWidth: 800,
		minHeight: 600,
		...(isMac && {
			titleBarStyle: "hiddenInset",
			trafficLightPosition: { x: 12, y: 12 },
		}),
		transparent: false,
		resizable: true,
		alwaysOnTop: false,
		skipTaskbar: false,
		title: "OpenScreen",
		backgroundColor: "#09090b",
		show: false, // shown via ready-to-show to avoid white flash on first load
		webPreferences: {
			preload: path.join(__dirname, "preload.mjs"),
			additionalArguments: [ASSET_BASE_URL_ARG],
			nodeIntegration: false,
			contextIsolation: true,
			webSecurity: false,
			backgroundThrottling: false,
		},
	});

	win.maximize();

	// The editor renders its own File/Edit/View menu bar in the custom titlebar,
	// so hide the native OS menu bar on Windows/Linux (it stays reachable via Alt).
	// macOS keeps its global menu bar.
	if (process.platform !== "darwin") {
		win.setAutoHideMenuBar(true);
	}

	// Show only once painted to avoid a white flash on cold Vite start.
	win.once("ready-to-show", () => {
		if (!HEADLESS) win.show();
	});

	// Inject dark background before any React paint so the sub-titlebar area never
	// flashes white on a cold Vite load.
	win.webContents.on("dom-ready", () => {
		win.webContents.insertCSS("html, body, #root { background: #09090b !important; }").catch(() => {
			// Best-effort cosmetic; ignore if the page is mid-teardown.
		});
	});

	win.webContents.on("did-finish-load", () => {
		win?.webContents.send("main-process-message", new Date().toLocaleString());
	});

	const routing = { windowType: "editor", ...query };
	if (VITE_DEV_SERVER_URL) {
		win.loadURL(`${VITE_DEV_SERVER_URL}?${new URLSearchParams(routing).toString()}`);
	} else {
		win.loadFile(path.join(RENDERER_DIST, "index.html"), { query: routing });
	}

	return win;
}

/**
 * Floating source-selector window for picking a screen or window to record.
 * Frameless, transparent, and follows the user across macOS Spaces.
 */
export function createSourceSelectorWindow(): BrowserWindow {
	const { width, height } = screen.getPrimaryDisplay().workAreaSize;

	const win = new BrowserWindow({
		width: 680,
		height: 580,
		minHeight: 420,
		maxHeight: 680,
		x: Math.round((width - 680) / 2),
		y: Math.round((height - 580) / 2),
		frame: false,
		resizable: false,
		alwaysOnTop: true,
		transparent: true,
		backgroundColor: "#00000000",
		webPreferences: {
			preload: path.join(__dirname, "preload.mjs"),
			additionalArguments: [ASSET_BASE_URL_ARG],
			nodeIntegration: false,
			contextIsolation: true,
		},
	});

	// Follow the user across macOS Spaces so the selector appears on the active
	// desktop regardless of where the HUD was opened.
	if (process.platform === "darwin") {
		win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
	}

	if (VITE_DEV_SERVER_URL) {
		win.loadURL(VITE_DEV_SERVER_URL + "?windowType=source-selector");
	} else {
		win.loadFile(path.join(RENDERER_DIST, "index.html"), {
			query: { windowType: "source-selector" },
		});
	}

	return win;
}

/**
 * Centered transparent countdown overlay that sits above the HUD during
 * recording pre-roll.
 */
export function createCountdownOverlayWindow(): BrowserWindow {
	const { workArea } = screen.getPrimaryDisplay();
	const overlayWidth = 420;
	const overlayHeight = 260;

	const win = new BrowserWindow({
		width: overlayWidth,
		height: overlayHeight,
		minWidth: overlayWidth,
		maxWidth: overlayWidth,
		minHeight: overlayHeight,
		maxHeight: overlayHeight,
		x: Math.round(workArea.x + (workArea.width - overlayWidth) / 2),
		y: Math.round(workArea.y + (workArea.height - overlayHeight) / 2),
		frame: false,
		resizable: false,
		alwaysOnTop: true,
		skipTaskbar: true,
		focusable: false,
		transparent: true,
		backgroundColor: "#00000000",
		hasShadow: false,
		show: false,
		webPreferences: {
			preload: path.join(__dirname, "preload.mjs"),
			additionalArguments: [ASSET_BASE_URL_ARG],
			nodeIntegration: false,
			contextIsolation: true,
			backgroundThrottling: false,
		},
	});

	win.setIgnoreMouseEvents(true);

	if (process.platform === "darwin") {
		win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
	}

	if (VITE_DEV_SERVER_URL) {
		win.loadURL(VITE_DEV_SERVER_URL + "?windowType=countdown-overlay");
	} else {
		win.loadFile(path.join(RENDERER_DIST, "index.html"), {
			query: { windowType: "countdown-overlay" },
		});
	}

	return win;
}

// Frameless Notes Window for taking notes during a recording.
export function createNotesWindow(): BrowserWindow {
	const win = new BrowserWindow({
		width: 400,
		height: 540,
		minWidth: 360,
		minHeight: 400,
		maxWidth: 640,
		maxHeight: 720,
		title: "OpenScreen - Notes",
		backgroundColor: "#09090b",
		resizable: true,
		alwaysOnTop: true,
		skipTaskbar: false,
		show: false,
		webPreferences: {
			preload: path.join(__dirname, "preload.mjs"),
			additionalArguments: [ASSET_BASE_URL_ARG],
			nodeIntegration: false,
			contextIsolation: true,
			backgroundThrottling: false,
		},
	});

	// Match the editor: no native OS menu bar on Windows/Linux (reachable via Alt).
	if (process.platform !== "darwin") {
		win.setAutoHideMenuBar(true);
	}

	applyContentProtection(win, "Notes");
	win.once("ready-to-show", () => {
		applyContentProtection(win, "Notes");
		win.show();
	});

	if (VITE_DEV_SERVER_URL) {
		win.loadURL(VITE_DEV_SERVER_URL + "?showNotes=true");
	} else {
		win.loadFile(path.join(RENDERER_DIST, "index.html"), {
			query: { showNotes: "true" },
		});
	}

	return win;
}
