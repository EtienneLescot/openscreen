/**
 * One UI-driving interface over two very different platforms.
 *
 * Drivers that only need the common operations — launch, quit, is-it-running, answer a file
 * dialog — import from here and work on both. Drivers that need something a platform does not
 * have (a macOS menu bar, a Windows UIA control tree) import the platform module directly and
 * branch, because pretending those are the same thing produces a driver that is subtly wrong
 * on one side rather than honestly unsupported.
 */
import { IS_WIN } from "./platform.mjs";
import * as mac from "./uiScript.mjs";
import * as win from "./uiWindows.mjs";

const impl = IS_WIN ? win : mac;

export const appIsRunning = (proc) => impl.appIsRunning(proc);
export const activateApp = (proc) => impl.activateApp(proc);
export const launchApp = (path, proc, opts) => impl.launchApp(path, proc, opts);
export const quitApp = (proc, opts) => impl.quitApp(proc, opts);
export const listWindows = (proc) => impl.listWindows(proc);
export const waitForWindow = (proc, match, opts) => impl.waitForWindow(proc, match, opts);

/**
 * Point a Save/Open dialog at an exact path and commit it.
 *
 * The two platforms get here very differently — Windows sets the file-name field through
 * UIA ValuePattern, macOS drives ⇧⌘G and types — but the contract is the same: after this
 * resolves, the app has been told to write exactly `absolutePath`.
 *
 * macOS callers must pass the *stem*: the AppKit save panel appends the format's extension
 * itself, so a name that already carries one comes back as "file.mp4.mp4". `stemOnly` handles
 * that here rather than in every driver.
 */
export async function fileDialogTo(processName, absolutePath, { stemOnly = true } = {}) {
	if (IS_WIN) return win.fileDialogTo(processName, absolutePath);
	const dir = absolutePath.replace(/[/\\][^/\\]+$/, "");
	const name = absolutePath.split(/[/\\]/).pop();
	const typed = stemOnly ? name.replace(/\.[^.]+$/, "") : name;
	await mac.savePanelTo(processName, `${dir}/${typed}`);
	mac.commitSavePanel(processName);
	mac.dismissReplaceAlert(processName);
	return { path: absolutePath };
}

/** Everything a maintainer needs to write or repair a driver for an installed app. */
export function describeApp(processName) {
	if (IS_WIN) return win.describeApp(processName);
	return JSON.stringify(
		{ menus: mac.dumpMenus(processName), windows: mac.listWindows(processName) },
		null,
		1,
	);
}

export { IS_WIN };
