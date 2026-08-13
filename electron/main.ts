import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	app,
	BrowserWindow,
	dialog,
	ipcMain,
	Menu,
	nativeImage,
	net,
	session,
	shell,
	systemPreferences,
	Tray,
} from "electron";
import { ShortcutBinding } from "../src/lib/shortcuts";
import {
	blockedFromInstalling,
	checkForSelfUpdate,
	downloadSelfUpdate,
	installSelfUpdate,
} from "./auto-updater";
import { parseCliArgs } from "./cli/args";
import { runCli } from "./cli/cliMain";
import { isDiagnosticModeEnabled, mainLogBuffer } from "./diagnostics/main-log-buffer";
import {
	loadAndRegisterGlobalShortcut,
	registerOpenAppShortcut,
	unregisterAllGlobalShortcuts,
} from "./globalShortcut";
import { mainT, setMainLocale } from "./i18n";
import {
	classifyInstall,
	type InstallChannel,
	platformOwnsUpdates,
	probeInstall,
} from "./install-channel";
import { getSelectedDesktopSource, registerIpcHandlers } from "./ipc/handlers";
import { installMainProcessErrorGuards } from "./main-process-errors";
import { registerSttIpc } from "./stt";
import { checkLatestRelease } from "./update-checker";
import {
	createCountdownOverlayWindow,
	createEditorWindow,
	createHudOverlayWindow,
	createNotesWindow,
	createSourceSelectorWindow,
} from "./windows";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// CLI mode: `openscreen export|record|info|help ...` runs headless without
// HUD/tray/menu. Parsed before any GUI side effects; see electron/cli/.
const cliCommand = parseCliArgs(process.argv, app.isPackaged ? 1 : 2);

// Use Screen & System Audio Recording permissions instead of the CoreAudio Tap API on macOS.
// Tap needs NSAudioCaptureUsageDescription in the parent app's Info.plist, which breaks when
// running from a terminal/IDE during dev.
if (process.platform === "darwin") {
	app.commandLine.appendSwitch("disable-features", "MacCatapLoopbackAudioForScreenShare");
}

// Wayland support for screen capture and window management on Wayland compositors.
if (process.platform === "linux") {
	const isWayland =
		process.env.XDG_SESSION_TYPE === "wayland" || process.env.WAYLAND_DISPLAY !== undefined;
	if (isWayland) {
		app.commandLine.appendSwitch("ozone-platform", "wayland");
		// Enable WebRTCPipeWireCapturer for screen capture on Wayland
		app.commandLine.appendSwitch("enable-features", "WaylandWindowDrag,WebRTCPipeWireCapturer");
		// Chromium's Wayland Ozone backend can't use Vulkan. When it tries, the WebRTC
		// PipeWire capturer fails to import DMA-BUF frames into EGL (EGL_BAD_MATCH), the
		// stream renegotiates, and screen recording yields no usable frames. Force the
		// GL/EGL path so DMA-BUF import works. (Chromium itself logs this suggestion:
		// "'--ozone-platform=wayland' is not compatible with Vulkan ... disabling Vulkan".)
		app.commandLine.appendSwitch("disable-features", "Vulkan");
	}
}

installMainProcessErrorGuards();

export const RECORDINGS_DIR = path.join(app.getPath("userData"), "recordings");

async function ensureRecordingsDir() {
	try {
		await fs.mkdir(RECORDINGS_DIR, { recursive: true });
		console.log("RECORDINGS_DIR:", RECORDINGS_DIR);
		console.log("User Data Path:", app.getPath("userData"));
	} catch (error) {
		console.error("Failed to create recordings directory:", error);
	}
}

// The built directory structure
//
// ├─┬─┬ dist
// │ │ └── index.html
// │ │
// │ ├─┬ dist-electron
// │ │ ├── main.js
// │ │ └── preload.mjs
// │
process.env.APP_ROOT = path.join(__dirname, "..");

// Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
export const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
export const MAIN_DIST = path.join(process.env.APP_ROOT, "dist-electron");
export const RENDERER_DIST = path.join(process.env.APP_ROOT, "dist");

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
	? path.join(process.env.APP_ROOT, "public")
	: RENDERER_DIST;

// Window references
let mainWindow: BrowserWindow | null = null;
let sourceSelectorWindow: BrowserWindow | null = null;
let countdownOverlayWindow: BrowserWindow | null = null;
let notesWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let selectedSourceName = "";
const isMac = process.platform === "darwin";
const trayIconSize = isMac ? 16 : 24;

// Tray Icons
const defaultTrayIcon = getTrayIcon("openscreen.png", trayIconSize);
const recordingTrayIcon = getTrayIcon("rec-button.png", trayIconSize);

function createWindow() {
	if (mainWindow && !mainWindow.isDestroyed()) {
		return;
	}

	mainWindow = createHudOverlayWindow();
}

function showMainWindow() {
	if (mainWindow && !mainWindow.isDestroyed()) {
		if (mainWindow.isMinimized()) {
			mainWindow.restore();
		}
		mainWindow.show();
		mainWindow.focus();
		return;
	}

	createWindow();
}

// CLI runs skip the single-instance lock so `openscreen export/record` works
// while the GUI app is open (they share nothing but the recordings directory).
const hasSingleInstanceLock = cliCommand ? false : app.requestSingleInstanceLock();

if (cliCommand) {
	runCli(cliCommand);
} else if (hasSingleInstanceLock) {
	app.on("second-instance", () => {
		showMainWindow();
	});
} else {
	app.quit();
}

function isEditorWindow(window: BrowserWindow) {
	return window.webContents.getURL().includes("windowType=editor");
}

function sendEditorMenuAction(
	channel: "menu-load-project" | "menu-save-project" | "menu-save-project-as" | "menu-new-project",
) {
	let targetWindow = BrowserWindow.getFocusedWindow() ?? mainWindow;

	if (!targetWindow || targetWindow.isDestroyed() || !isEditorWindow(targetWindow)) {
		createEditorWindowWrapper();
		targetWindow = mainWindow;
		if (!targetWindow || targetWindow.isDestroyed()) return;

		targetWindow.webContents.once("did-finish-load", () => {
			if (!targetWindow || targetWindow.isDestroyed()) return;
			targetWindow.webContents.send(channel);
		});
		return;
	}

	targetWindow.webContents.send(channel);
}

function setupApplicationMenu() {
	const isMac = process.platform === "darwin";
	const template: Electron.MenuItemConstructorOptions[] = [];

	if (isMac) {
		template.push({
			label: app.name,
			submenu: [
				{
					role: "about",
					label: mainT("common", "actions.about") || "About OpenScreen",
				},
				{ type: "separator" },
				{
					role: "services",
					label: mainT("common", "actions.services") || "Services",
				},
				{ type: "separator" },
				{
					role: "hide",
					label: mainT("common", "actions.hide") || "Hide OpenScreen",
				},
				{
					role: "hideOthers",
					label: mainT("common", "actions.hideOthers") || "Hide Others",
				},
				{
					role: "unhide",
					label: mainT("common", "actions.unhide") || "Show All",
				},
				{ type: "separator" },
				{ role: "quit", label: mainT("common", "actions.quit") || "Quit" },
			],
		});
	}

	template.push(
		{
			label: mainT("common", "actions.file") || "File",
			submenu: [
				{
					label: mainT("dialogs", "unsavedChanges.newProject") || "New Project",
					accelerator: "CmdOrCtrl+N",
					click: () => sendEditorMenuAction("menu-new-project"),
				},
				{ type: "separator" as const },
				{
					label: mainT("dialogs", "unsavedChanges.loadProject") || "Load Project…",
					accelerator: "CmdOrCtrl+O",
					click: () => sendEditorMenuAction("menu-load-project"),
				},
				{
					label: mainT("dialogs", "unsavedChanges.saveProject") || "Save Project…",
					accelerator: "CmdOrCtrl+S",
					click: () => sendEditorMenuAction("menu-save-project"),
				},
				{
					label: mainT("dialogs", "unsavedChanges.saveProjectAs") || "Save Project As…",
					accelerator: "CmdOrCtrl+Shift+S",
					click: () => sendEditorMenuAction("menu-save-project-as"),
				},
				...(isMac
					? []
					: [
							{ type: "separator" as const },
							{
								role: "quit" as const,
								label: mainT("common", "actions.quit") || "Quit",
							},
						]),
			],
		},
		{
			label: mainT("common", "actions.edit") || "Edit",
			submenu: [
				{ role: "undo", label: mainT("common", "actions.undo") || "Undo" },
				{ role: "redo", label: mainT("common", "actions.redo") || "Redo" },
				{ type: "separator" },
				{ role: "cut", label: mainT("common", "actions.cut") || "Cut" },
				{ role: "copy", label: mainT("common", "actions.copy") || "Copy" },
				{ role: "paste", label: mainT("common", "actions.paste") || "Paste" },
				{
					role: "selectAll",
					label: mainT("common", "actions.selectAll") || "Select All",
				},
			],
		},
		{
			label: mainT("common", "actions.view") || "View",
			submenu: [
				{
					role: "reload",
					label: mainT("common", "actions.reload") || "Reload",
				},
				{
					role: "forceReload",
					label: mainT("common", "actions.forceReload") || "Force Reload",
				},
				{
					role: "toggleDevTools",
					label: mainT("common", "actions.toggleDevTools") || "Toggle Developer Tools",
				},
				{ type: "separator" },
				{
					role: "resetZoom",
					label: mainT("common", "actions.actualSize") || "Actual Size",
				},
				{
					role: "zoomIn",
					label: mainT("common", "actions.zoomIn") || "Zoom In",
				},
				{
					role: "zoomOut",
					label: mainT("common", "actions.zoomOut") || "Zoom Out",
				},
				{ type: "separator" },
				{
					role: "togglefullscreen",
					label: mainT("common", "actions.toggleFullScreen") || "Toggle Full Screen",
				},
			],
		},
		{
			label: mainT("common", "actions.window") || "Window",
			submenu: isMac
				? [
						{
							role: "minimize",
							label: mainT("common", "actions.minimize") || "Minimize",
						},
						{ role: "zoom" },
						{ type: "separator" },
						{ role: "front" },
					]
				: [
						{
							role: "minimize",
							label: mainT("common", "actions.minimize") || "Minimize",
						},
						{
							role: "close",
							label: mainT("common", "actions.close") || "Close",
						},
					],
		},
	);

	const menu = Menu.buildFromTemplate(template);
	Menu.setApplicationMenu(menu);
}

function createTray() {
	tray = new Tray(defaultTrayIcon);
	tray.on("click", () => {
		showMainWindow();
	});
	tray.on("double-click", () => {
		showMainWindow();
	});
}

function getTrayIcon(filename: string, size: number) {
	return nativeImage
		.createFromPath(path.join(process.env.VITE_PUBLIC || RENDERER_DIST, filename))
		.resize({
			width: size,
			height: size,
			quality: "best",
		});
}

let updateCheckInFlight = false;
let installChannel: InstallChannel | null = null;
/** Aborted on quit so a pending check cannot outlive the app and pop a dialog on the way out —
 *  or reject into `main-process-errors`, which re-throws and would take the process with it. */
let updateCheckAbort: AbortController | null = null;

function getInstallChannel(): InstallChannel {
	if (installChannel === null) installChannel = classifyInstall(probeInstall());
	return installChannel;
}

/** Mirrors the flag that already drives the tray icon. An update must never interrupt a take —
 *  and on Windows it physically cannot, because the capture helpers spawn from inside the
 *  install directory and NSIS cannot overwrite a running .exe. */
let isRecording = false;

async function downloadAndInstall(latestVersion: string) {
	const downloaded = await downloadSelfUpdate();
	if (downloaded.kind === "failed") {
		await dialog.showMessageBox({
			type: "error",
			title: app.name,
			// Not `updates.failed`: the CHECK succeeded — that is how we got here — and telling
			// the user we could not check for updates sends them looking in the wrong place.
			message: mainT("common", "updates.downloadFailed"),
			detail: downloaded.error.message,
		});
		return;
	}

	const blocked = blockedFromInstalling({
		recording: isRecording,
		// macOS-only API; absent elsewhere, and irrelevant there.
		inApplicationsFolder:
			process.platform === "darwin" ? (app.isInApplicationsFolder?.() ?? true) : true,
		platform: process.platform,
	});
	if (blocked) {
		await dialog.showMessageBox({
			type: "info",
			title: app.name,
			message: mainT(
				"common",
				blocked === "recording" ? "updates.blockedRecording" : "updates.blockedLocation",
			),
		});
		return;
	}

	const restart = await dialog.showMessageBox({
		type: "info",
		title: app.name,
		message: mainT("common", "updates.readyToInstall", { latestVersion }),
		buttons: [
			mainT("common", "actions.restartNow") || "Restart Now",
			mainT("common", "actions.cancel") || "Cancel",
		],
		defaultId: 0,
		cancelId: 1,
	});
	if (restart.response === 0) await installSelfUpdate();
}

async function checkForUpdates() {
	if (updateCheckInFlight) return;
	updateCheckInFlight = true;
	updateCheckAbort = new AbortController();
	const signal = AbortSignal.any([updateCheckAbort.signal, AbortSignal.timeout(10_000)]);
	try {
		const result = await checkLatestRelease({
			currentVersion: app.getVersion(),
			fetchLatest: (url, init) => net.fetch(url, init),
			signal,
		});
		if (result.kind === "current") {
			await dialog.showMessageBox({
				type: "info",
				title: app.name,
				message: mainT("common", "updates.current", {
					currentVersion: result.currentVersion,
				}),
			});
			return;
		}

		// An install we built can replace itself; everything else — dev builds, an unclassified
		// payload, and every macOS install predating Developer ID signing, which Squirrel can
		// never update — can only be pointed at the download page. Ask the updater first so the
		// buttons offered match what this install can actually do.
		const selfUpdate = await checkForSelfUpdate(getInstallChannel());
		const canSelfUpdate = selfUpdate.kind === "downloaded";
		if (selfUpdate.kind === "failed") {
			// A release published before the update feeds existed has no latest*.yml. Not worth a
			// dialog — the download page below still works — but it must not vanish silently.
			console.warn("[updates] self-update unavailable, falling back to the release page", {
				channel: getInstallChannel(),
				error: selfUpdate.error.message,
			});
		}

		const choice = await dialog.showMessageBox({
			type: "info",
			title: app.name,
			message: mainT("common", "updates.available", {
				currentVersion: result.currentVersion,
				latestVersion: result.latestVersion,
			}),
			buttons: [
				canSelfUpdate
					? mainT("common", "actions.downloadUpdate") || "Download Update"
					: mainT("common", "actions.viewRelease") || "View Release",
				mainT("common", "actions.cancel") || "Cancel",
			],
			defaultId: 0,
			cancelId: 1,
		});
		if (choice.response !== 0) return;
		if (!canSelfUpdate) {
			await shell.openExternal(result.releaseUrl);
			return;
		}
		await downloadAndInstall(result.latestVersion);
	} catch (error) {
		// Quitting is not a failure, and the app is already on its way out — there is nothing
		// left to show the dialog on.
		if (signal.aborted && updateCheckAbort?.signal.aborted) return;
		await dialog.showMessageBox({
			type: "error",
			title: app.name,
			message: mainT("common", "updates.failed"),
			detail: error instanceof Error ? error.message : String(error),
		});
	} finally {
		updateCheckInFlight = false;
		updateCheckAbort = null;
	}
}

function updateTrayMenu(recording: boolean = false) {
	if (!tray) return;
	const trayIcon = recording ? recordingTrayIcon : defaultTrayIcon;
	const trayToolTip = recording
		? mainT("common", "actions.recordingStatus", {
				source: selectedSourceName,
			}) || `Recording: ${selectedSourceName}`
		: "OpenScreen";
	const menuTemplate = recording
		? [
				{
					label: mainT("common", "actions.stopRecording") || "Stop Recording",
					click: () => {
						if (mainWindow && !mainWindow.isDestroyed()) {
							mainWindow.webContents.send("stop-recording-from-tray");
						}
					},
				},
			]
		: [
				{
					label: mainT("common", "actions.open") || "Open",
					click: () => {
						showMainWindow();
					},
				},
				// Omitted entirely where a package manager owns the update (Microsoft Store,
				// Flathub, Snap, Nix): there the app is already kept current, and offering a
				// GitHub download walks the user into a second, parallel installation.
				...(platformOwnsUpdates(getInstallChannel())
					? []
					: [
							{
								label: mainT("common", "actions.checkForUpdates") || "Check for Updates",
								click: () => {
									// Not `void`: an unhandled rejection here is re-thrown by
									// main-process-errors and would kill the main process.
									checkForUpdates().catch((error) => {
										console.error("[updates] check failed", error);
									});
								},
							},
						]),
				{ type: "separator" as const },
				{
					label: mainT("common", "actions.quit") || "Quit",
					click: () => {
						app.quit();
					},
				},
			];
	tray.setImage(trayIcon);
	tray.setToolTip(trayToolTip);
	tray.setContextMenu(Menu.buildFromTemplate(menuTemplate));
}

let editorHasUnsavedChanges = false;
let isForceClosing = false;
let isCloseConfirmInFlight = false;

ipcMain.on("set-has-unsaved-changes", (_, hasChanges: boolean) => {
	editorHasUnsavedChanges = hasChanges;
});

// Quit requested from the editor's in-app File menu. Mirrors the native
// menu's role:"quit" so the unsaved-changes close flow still runs.
ipcMain.on("app-quit", () => {
	app.quit();
});

function forceCloseEditorWindow(windowToClose: BrowserWindow | null) {
	if (!windowToClose || windowToClose.isDestroyed()) return;

	isForceClosing = true;
	setImmediate(() => {
		try {
			if (!windowToClose.isDestroyed()) {
				windowToClose.close();
			}
		} finally {
			isForceClosing = false;
		}
	});
}

function createEditorWindowWrapper() {
	if (mainWindow) {
		isForceClosing = true;
		mainWindow.close();
		isForceClosing = false;
		mainWindow = null;
	}
	mainWindow = createEditorWindow();
	editorHasUnsavedChanges = false;

	mainWindow.on("close", (event) => {
		if (isForceClosing || !editorHasUnsavedChanges || isCloseConfirmInFlight) return;

		event.preventDefault();
		isCloseConfirmInFlight = true;

		const windowToClose = mainWindow;
		if (!windowToClose || windowToClose.isDestroyed()) return;

		// Ask renderer to show the in-app close dialog.
		windowToClose.webContents.send("request-close-confirm");

		ipcMain.once("close-confirm-response", (event, choice: "save" | "discard" | "cancel") => {
			if (event.sender.id !== windowToClose?.webContents.id) return;
			isCloseConfirmInFlight = false;
			if (!windowToClose || windowToClose.isDestroyed()) return;

			if (choice === "save") {
				// Save first, then close when the renderer reports done.
				windowToClose.webContents.send("request-save-before-close");
				ipcMain.once("save-before-close-done", (event, shouldClose: boolean) => {
					if (event.sender.id !== windowToClose?.webContents.id) return;
					if (!shouldClose) return;
					forceCloseEditorWindow(windowToClose);
				});
			} else if (choice === "discard") {
				forceCloseEditorWindow(windowToClose);
			}
			// "cancel": flag reset, window stays open
		});
	});
}

function createSourceSelectorWindowWrapper() {
	sourceSelectorWindow = createSourceSelectorWindow();
	sourceSelectorWindow.on("closed", () => {
		sourceSelectorWindow = null;
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send("source-selector-closed");
		}
	});
	return sourceSelectorWindow;
}

function createNotesWindowWrapper() {
	{
		notesWindow = createNotesWindow();
		notesWindow.on("closed", () => {
			notesWindow = null;
			if (mainWindow && !mainWindow.isDestroyed()) {
				mainWindow.webContents.send("notes-window-closed");
			}
		});
		return notesWindow;
	}
}

function createCountdownOverlayWindowWrapper() {
	if (countdownOverlayWindow && !countdownOverlayWindow.isDestroyed()) {
		return countdownOverlayWindow;
	}

	countdownOverlayWindow = createCountdownOverlayWindow();
	countdownOverlayWindow.on("closed", () => {
		countdownOverlayWindow = null;
	});
	return countdownOverlayWindow;
}

// Closing every window quits the app (tray goes too). The in-app "Return to Recorder"
// button covers the editor-to-HUD round-trip, so closing the last window means "I'm done".
// CLI mode owns its own lifecycle (see electron/cli/cliMain.ts).
if (!cliCommand) {
	app.on("window-all-closed", () => {
		app.quit();
	});
}

app.on("activate", () => {
	if (cliCommand) return;
	// On macOS, re-open a window when the dock icon is clicked and none are open.
	const hasVisibleWindow = BrowserWindow.getAllWindows().some((window) => {
		if (window.isDestroyed() || !window.isVisible()) {
			return false;
		}

		const url = window.webContents.getURL();
		const isCountdownOverlayWindow = url.includes("windowType=countdown-overlay");
		return !isCountdownOverlayWindow;
	});
	if (!hasVisibleWindow) {
		showMainWindow();
	}
});

app.on("before-quit", () => {
	// A check started seconds ago must not settle after the app is gone and try to open a
	// dialog on a quitting app.
	updateCheckAbort?.abort();
});

app.on("will-quit", () => {
	unregisterAllGlobalShortcuts();
});

const appReady = !cliCommand && hasSingleInstanceLock ? app.whenReady() : null;

appReady?.then(async () => {
	if (isDiagnosticModeEnabled()) {
		mainLogBuffer.install();
		console.info("[diagnostic] OPENSCREEN_DIAGNOSTIC=1, capturing console.* into ring buffer");
	}

	// Force "regular" activation policy so the Dock icon appears. The HUD overlay
	// (transparent, frameless, skipTaskbar) is the first window, and AppKit would
	// otherwise classify us as an accessory app.
	if (process.platform === "darwin") {
		app.dock?.show();
	}

	session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
		const allowed = [
			"media",
			"audioCapture",
			"microphone",
			"videoCapture",
			"camera",
			"screen",
			"display-capture",
		];
		return allowed.includes(permission);
	});

	session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
		const allowed = [
			"media",
			"audioCapture",
			"microphone",
			"videoCapture",
			"camera",
			"screen",
			"display-capture",
		];
		callback(allowed.includes(permission));
	});

	session.defaultSession.setDisplayMediaRequestHandler(
		(request, callback) => {
			const source = getSelectedDesktopSource();
			// ponytail: diagnostic for the 0-byte screen-recording bug. Log what
			// we're handing to the renderer so we can see if the source is stale
			// or the handler is returning an empty payload.
			console.info(
				`[display-media] videoRequested=${request.videoRequested} ` +
					`audioRequested=${request.audioRequested} ` +
					`source=${source ? `${source.id} (${source.name})` : "(none)"}`,
			);
			if (!request.videoRequested || !source) {
				callback({});
				return;
			}

			callback({
				video: source,
				...(request.audioRequested && process.platform === "win32" ? { audio: "loopback" } : {}),
			});
		},
		{ useSystemPicker: false },
	);

	// ponytail: forward renderer console.warn/error to main-process stdout so
	// recorder diagnostics (which fire in the renderer) show up next to the
	// main-process logs in `npm run dev` output. Without this, the
	// `[recorder:...]` lines from recorderHandle.ts are only visible in
	// DevTools. One-time wire; no per-message cost beyond a single IPC hop.
	const logChannels = ["log", "warn", "error"] as const;
	for (const channel of logChannels) {
		ipcMain.on(`renderer-console-${channel}`, (_event, ...args) => {
			const text = args
				.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
				.join(" ");
			const stream = channel === "error" ? process.stderr : process.stdout;
			stream.write(`[renderer:${channel}] ${text}\n`);
		});
	}

	// Request mic permission now. Screen Recording is requested lazily from the
	// source-picker action so its prompt isn't hidden behind the selector window.
	//
	// NOT awaited, on purpose. `askForMediaAccess` resolves only once the user
	// answers the modal TCC prompt, and `createWindow()` is 70 lines below this in
	// the same async block — so on a Mac where the microphone is still
	// `not-determined` (every first run, and every fresh dev machine) the app
	// showed a permission dialog with NO window behind it and created the HUD only
	// after it was dismissed. Nothing between here and `createWindow()` needs the
	// answer: the recorder re-checks the status when the user actually arms the mic.
	if (process.platform === "darwin") {
		const micStatus = systemPreferences.getMediaAccessStatus("microphone");
		if (micStatus !== "granted") {
			systemPreferences
				.askForMediaAccess("microphone")
				.then((granted) => console.info(`[permissions] microphone granted=${granted}`))
				.catch((error) => console.warn("[permissions] microphone request failed:", error));
		}
	}

	ipcMain.on("hud-overlay-close", () => {
		app.quit();
	});
	ipcMain.handle("set-locale", (_, locale: string) => {
		setMainLocale(locale);
		setupApplicationMenu();
		updateTrayMenu();
	});

	ipcMain.handle("update-global-shortcut", (_, binding: ShortcutBinding) => {
		const success = registerOpenAppShortcut(binding, showMainWindow);
		return { success };
	});

	createTray();
	updateTrayMenu();
	setupApplicationMenu();
	await ensureRecordingsDir();

	function switchToHudWrapper() {
		if (mainWindow) {
			isForceClosing = true;
			mainWindow.close();
			isForceClosing = false;
			mainWindow = null;
		}
		showMainWindow();
	}

	registerIpcHandlers(
		createEditorWindowWrapper,
		createSourceSelectorWindowWrapper,
		createCountdownOverlayWindowWrapper,
		createNotesWindowWrapper,
		() => mainWindow,
		() => sourceSelectorWindow,
		() => notesWindow,
		() => countdownOverlayWindow,
		(recording: boolean, sourceName: string) => {
			selectedSourceName = sourceName;
			isRecording = recording;
			if (!tray) createTray();
			updateTrayMenu(recording);
			if (!recording) {
				showMainWindow();
			}
		},
		switchToHudWrapper,
	);

	// Native STT (whisper.cpp + forced alignment) — single instance per app.
	registerSttIpc(ipcMain);

	await loadAndRegisterGlobalShortcut(showMainWindow);

	// --bench=<query>: run the export bench instead of the app. Opens the real
	// editor window (same webPreferences, same preload) pointed at the bench
	// entry, and quits when it reports back. See src/bench/runBench.ts.
	const benchArg = process.argv.find((a) => a.startsWith("--bench="));
	if (benchArg) {
		ipcMain.handle("bench:finished", () => {
			// Let the reply reach the renderer before the process goes away.
			setTimeout(() => app.exit(0), 100);
		});
		const query = Object.fromEntries(new URLSearchParams(benchArg.slice("--bench=".length)));
		mainWindow = createEditorWindow({ ...query, windowType: "bench" });
		return;
	}

	createWindow();
});
