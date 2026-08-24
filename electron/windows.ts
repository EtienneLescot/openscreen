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

// Forces protection back on where it is auto-disabled below, so the macOS
// regression can be re-tested against a future Electron without editing code.
const CONTENT_PROTECTION_FORCED = process.env["OPENSCREEN_FORCE_CONTENT_PROTECTION"] === "1";

/**
 * macOS 26 (Darwin 25) never displays a window that has had
 * `setContentProtection(true)` applied to it.
 *
 * Not "excludes it from captures" — which is the documented behaviour and the
 * whole point — but never paints it for the user either. Confirmed on Darwin
 * 25.5 / Electron 41.2.1 with the HUD: tray icon present, renderer alive and
 * painting (React mounted, no console errors), `ready-to-show` fired, `show()`
 * called, window at valid on-screen coordinates on the main display — and
 * nothing on screen. `showMainWindow()` from the tray and the global shortcut
 * were equally inert, because the window was already "visible" as far as
 * Electron was concerned. Unsetting protection makes it appear instantly; the
 * ordering of protect-vs-show makes no difference, so it is the call itself.
 *
 * `setContentProtection` maps to `NSWindow.sharingType = NSWindowSharingNone`,
 * a path Electron has repeatedly churned on (electron/electron#45990, and
 * PR #46886 reverting a macOS content-protection refactor).
 *
 * Gated on the Darwin major version rather than `darwin` wholesale: the
 * breakage is only *confirmed* on 25.x, and silently dropping protection on
 * older macOS — where it may well work — would be a privacy regression made on
 * no evidence.
 *
 * NOTE: this leaves the HUD capturable on macOS 26. Apple already made that
 * partly true regardless — ScreenCaptureKit ignores `sharingType`, so any
 * SCK-based recorder (including *ours*, see
 * `electron/native/screencapturekit/`) captures these windows anyway. The
 * durable fix is to exclude our own windows via `SCContentFilter`'s
 * `excludingWindows:`, which that helper currently passes as `[]`.
 */
const CONTENT_PROTECTION_BREAKS_DISPLAY = (() => {
	if (process.platform !== "darwin") return false;
	// getSystemVersion() reports the *macOS* version on darwin, not the Darwin
	// kernel version: measured "26.5.0" here where `os.release()` is "25.5.0".
	// So the affected major is 26, and the check must not be fed os.release().
	const macOSMajor = Number.parseInt(process.getSystemVersion().split(".")[0] ?? "", 10);
	return Number.isFinite(macOSMajor) && macOSMajor >= 26;
})();

function applyContentProtection(win: BrowserWindow, label: string) {
	if (CONTENT_PROTECTION_DISABLED) {
		console.warn(
			`[content-protection] OFF for the ${label} window ` +
				"(OPENSCREEN_DISABLE_CONTENT_PROTECTION=1) — it will appear in screen captures, " +
				"including recordings. Unset it for anything but automated testing.",
		);
		return;
	}
	if (CONTENT_PROTECTION_BREAKS_DISPLAY && !CONTENT_PROTECTION_FORCED) {
		console.warn(
			`[content-protection] OFF for the ${label} window — macOS ` +
				`${process.getSystemVersion()} never displays a content-protected window, so ` +
				"enabling it would make this window permanently invisible. It may therefore appear " +
				"in screen captures. Set OPENSCREEN_FORCE_CONTENT_PROTECTION=1 to re-test.",
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
export const ASSET_BASE_URL_ARG = `--asset-base-url=${pathToFileURL(`${ASSET_BASE_DIR}${path.sep}`).toString()}`;

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

// The cursor, sampled here and pushed to the renderer, because while the HUD is
// click-through nothing else can tell it where the pointer is.
//
// Chromium delivers no pointer event of any kind to a window it has made
// input-transparent — including the pointermove the renderer needs to ask for input
// back. Electron's `{ forward: true }` covered that with a global WH_MOUSE_LL hook
// that re-posts WM_MOUSEMOVE, and that hook was the ONLY route out: its install is
// unchecked (SetWindowsHookEx's return value is discarded), latched behind Electron's
// `forwarding_mouse_messages_` so it re-arms only after a setIgnoreMouseEvents(false)
// the renderer can no longer request, and Windows silently revokes any low-level hook
// whose callback overruns LowLevelHooksTimeout — "there is no way for the application
// to know whether the hook is removed". One hook that never installs or quietly dies
// and the HUD is painted, inert, forever, with the tray icon as the only way to quit
// the app. That is issue #266, and issue #385 after it: #266 was closed by moving
// *when* the hook is installed, which left the trapdoor exactly where it was.
//
// So the escape no longer runs on anything Windows can take away. getCursorScreenPoint
// is a plain positional read the main process can always make, the poll exists only
// while the window is click-through — the state it is there to escape — and the
// renderer re-derives the answer from scratch on every tick, so no dropped message,
// dead hook or stale flag can strand it.
const HUD_CURSOR_POLL_MS = 32;
let hudCursorPoll: ReturnType<typeof setInterval> | null = null;
let hudLastPoint: { x: number; y: number } | null = null;

function stopHudCursorPoll() {
	if (hudCursorPoll) clearInterval(hudCursorPoll);
	hudCursorPoll = null;
	hudLastPoint = null;
}

function pollHudCursor() {
	const win = hudOverlayWindow;
	if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return;

	// getBounds() and getCursorScreenPoint() are both in DIP, and so is a renderer CSS
	// pixel (the HUD is frameless, so the client area is the whole window).
	const bounds = win.getBounds();
	const cursor = screen.getCursorScreenPoint();
	const x = cursor.x - bounds.x;
	const y = cursor.y - bounds.y;
	if (x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) return;

	// Deduped on the WINDOW-RELATIVE point, not the cursor: "hud-overlay-set-size"
	// re-anchors the window on every content change, so the bar can arrive under a
	// cursor that never moved — and that changes the answer just as much.
	if (hudLastPoint && hudLastPoint.x === x && hudLastPoint.y === y) return;
	hudLastPoint = { x, y };

	win.webContents.send("hud-overlay-cursor", x, y);
}

ipcMain.on("hud-overlay-ignore-mouse-events", (_event, ignore: boolean) => {
	if (!hudOverlayWindow || hudOverlayWindow.isDestroyed()) {
		return;
	}

	// No `forward`: the poll above replaces it, and leaving it on would keep the app
	// depending on a hook it cannot check for a transition it no longer needs.
	hudOverlayWindow.setIgnoreMouseEvents(ignore);

	if (!ignore) {
		// Input is live again; the document's own pointer events are cheaper and
		// finer-grained than anything sampled at 32 ms.
		stopHudCursorPoll();
		return;
	}
	if (!hudCursorPoll) {
		hudCursorPoll = setInterval(pollHudCursor, HUD_CURSOR_POLL_MS);
	}
});

ipcMain.on("hud-overlay-drag-start", () => {
	if (!hudOverlayWindow || hudOverlayWindow.isDestroyed()) {
		return;
	}

	// Under Wayland this origin is a lie: Electron documents getPosition() as returning
	// [0, 0] there, because the protocol prohibits a client from introspecting or
	// setting its own global coordinates. The origin+delta scheme below therefore
	// resolves against 0 rather than the window's real position, and setPosition() is
	// itself a no-op — so dragging cannot work on Wayland by this route at all. The
	// finiteness check only keeps a garbage origin from reaching a native setter.
	const [x, y] = hudOverlayWindow.getPosition();
	hudDragOrigin = Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
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

	// `| 0` is load-bearing, not defensive noise. Math.round returns NEGATIVE ZERO for
	// any delta in [-0.5, 0) — routine under fractional scaling, where screenY deltas
	// are fractional. V8's IsInt32() rejects -0, so gin refuses to convert it and the
	// main process dies with "Error processing argument at index 1, conversion failure
	// from". `Number.isFinite(-0)` is true, so a finiteness check does NOT catch this;
	// `| 0` collapses -0 to 0 and pins the value to int32. (`+ 0` would not: -0 + 0 is
	// still -0, and Math.trunc preserves it too.)
	const x = Math.round(hudDragOrigin.x + deltaX) | 0;
	const y = Math.round(hudDragOrigin.y + deltaY) | 0;

	hudOverlayWindow.setPosition(x, y, false);
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

	// Deliberately NOT born click-through: the renderer asks for it on mount, over
	// "hud-overlay-ignore-mouse-events" (`show: false` holds this window back until
	// ready-to-show, so the two are ~85 ms apart — measured, not assumed). What that
	// leaves open is an invisible rectangle that can swallow one desktop click in
	// those 85 ms, right after the user launched the app — against what doing it here
	// cost them: the whole app (issue #266). A window nothing ever asks for — a
	// renderer that dies before mount — then stays clickable instead of becoming a
	// ghost. See the "hud-overlay-cursor" poll above for the way back out.

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
			stopHudCursorPoll();
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
		// Seamless titlebar on every platform: the app's own topbar IS the titlebar
		// (it already carries the logo, the title and a drag region). macOS keeps its
		// traffic lights, Windows/Linux get the native Window Controls Overlay — which
		// preserves Snap Layouts and the system close/maximise semantics instead of
		// re-implementing them as HTML buttons. Its colours follow the app theme via
		// the "set-titlebar-overlay" IPC (see handlers.ts).
		titleBarStyle: "hidden",
		...(isMac
			? { trafficLightPosition: { x: 18, y: 21 } }
			: { titleBarOverlay: { color: "#09090b", symbolColor: "#a1a1aa", height: 58 } }),
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
		// `--titlebar-inset-left` reserves room for the macOS traffic lights; on
		// Windows/Linux the topbar uses the `titlebar-area-*` env vars instead.
		win.webContents
			.insertCSS(
				`html, body, #root { background: #09090b !important; }
				 :root { --titlebar-inset-left: ${isMac ? "68px" : "0px"}; }`,
			)
			.catch(() => {
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
