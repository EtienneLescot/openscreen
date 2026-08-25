/**
 * macOS UI automation for the apps that have no CLI.
 *
 * Three of the five apps in this benchmark expose no scriptable interface at all — Screen
 * Studio publishes only `screen-studio://record-*` deeplinks, Camtasia and Kap publish
 * nothing. Their exports therefore have to be driven through the UI, and the *way* that is
 * done decides whether the benchmark reproduces on another machine.
 *
 * Pixel coordinates do not reproduce: they depend on display size, scale factor, window
 * placement and app version. Accessibility object names largely do. So every interaction here
 * is expressed against the accessibility tree — "click the menu item called Export…" — and
 * clicking at a coordinate is the last rung of the ladder, used only where an app draws a
 * control that publishes no accessibility role.
 *
 * The ladder, best first:
 *   1. a scripting dictionary  (none of these apps has one — checked with `sdef`)
 *   2. System Events menu-bar item by name        ← where almost everything lands
 *   3. a documented keyboard shortcut
 *   4. accessibility button/pop-up by name or description
 *   5. computer-use pixel clicking (agent-assisted, recorded as reduced reproducibility)
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { sleep } from "./measure.mjs";

export class UiScriptError extends Error {
	constructor(message, { script, stderr } = {}) {
		super(message);
		this.name = "UiScriptError";
		this.script = script;
		this.stderr = stderr;
	}
}

/** Run an AppleScript source string; returns trimmed stdout. */
export function osa(script, { timeoutMs = 60_000 } = {}) {
	try {
		return execFileSync("/usr/bin/osascript", ["-"], {
			input: script,
			encoding: "utf8",
			timeout: timeoutMs,
			maxBuffer: 16 * 1024 * 1024,
		}).trim();
	} catch (e) {
		const stderr = (e.stderr?.toString() || "").trim();
		throw new UiScriptError(stderr || e.message, { script, stderr });
	}
}

/** JavaScript for Automation, for the places where AppleScript's syntax fights back. */
export function jxa(script, { timeoutMs = 60_000 } = {}) {
	try {
		return execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-"], {
			input: script,
			encoding: "utf8",
			timeout: timeoutMs,
			maxBuffer: 16 * 1024 * 1024,
		}).trim();
	} catch (e) {
		const stderr = (e.stderr?.toString() || "").trim();
		throw new UiScriptError(stderr || e.message, { script, stderr });
	}
}

const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/* ------------------------------------------------------------------- app lifecycle ------- */

export function appIsRunning(processName) {
	return (
		osa(`tell application "System Events" to return (exists process "${esc(processName)}")`) ===
		"true"
	);
}

/** Does this app ship an AppleScript dictionary? Rung 1 of the ladder. */
export function hasScriptingDictionary(appPath) {
	if (!existsSync(appPath)) return false;
	try {
		const out = execFileSync("/usr/bin/sdef", [appPath], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			maxBuffer: 8 * 1024 * 1024,
		});
		// Every app inherits the Standard Suite; a *useful* dictionary has more than that.
		const suites = [...out.matchAll(/<suite\s+name="([^"]+)"/g)].map((m) => m[1]);
		return suites.filter((s) => !/Standard Suite|Text Suite/i.test(s)).length > 0;
	} catch {
		return false;
	}
}

export async function launchApp(appPath, processName, { timeoutMs = 90_000 } = {}) {
	execFileSync("/usr/bin/open", ["-a", appPath]);
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		if (appIsRunning(processName)) return true;
		await sleep(400);
	}
	throw new UiScriptError(`"${processName}" did not start within ${timeoutMs}ms`);
}

export function activateApp(processName) {
	osa(`tell application "System Events" to set frontmost of process "${esc(processName)}" to true`);
}

export async function quitApp(processName, { force = false, timeoutMs = 25_000 } = {}) {
	try {
		osa(`tell application "${esc(processName)}" to quit`, { timeoutMs: 15_000 });
	} catch {
		/* app may not be scriptable enough to answer `quit`; fall through to the wait */
	}
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		if (!appIsRunning(processName)) return true;
		await sleep(400);
	}
	if (force) {
		try {
			execFileSync("/usr/bin/pkill", ["-f", processName]);
		} catch {
			/* nothing left to kill */
		}
	}
	return !appIsRunning(processName);
}

/* ------------------------------------------------------------------------- menus --------- */

export function listMenus(processName) {
	const raw = osa(
		`tell application "System Events" to tell process "${esc(processName)}" to return name of every menu of menu bar 1`,
	);
	return raw.split(", ").filter(Boolean);
}

export function listMenuItems(processName, menuName) {
	const raw = osa(
		`tell application "System Events" to tell process "${esc(processName)}" to return name of every menu item of menu "${esc(menuName)}" of menu bar 1`,
	);
	return raw.split(", ").filter(Boolean);
}

/**
 * Dump every menu and item. This is the discovery step a maintainer runs once per app version
 * to write (or repair) a driver — export labels drift between releases, and guessing them
 * produces a driver that fails silently on somebody else's machine.
 */
export function dumpMenus(processName) {
	const out = {};
	for (const menu of listMenus(processName)) {
		try {
			out[menu] = listMenuItems(processName, menu);
		} catch (e) {
			out[menu] = [`<error: ${e.message}>`];
		}
	}
	return out;
}

/**
 * Click a menu item, tolerating the label drift that makes naive UI scripts brittle:
 * an ellipsis may be U+2026 or three periods, and a verb may have gained a noun
 * ("Export" → "Export As…" → "Export Media…"). Patterns are tried in order.
 */
export function clickMenuItem(processName, menuName, patterns, { submenu = null } = {}) {
	const items = submenu
		? osa(
				`tell application "System Events" to tell process "${esc(processName)}" to return name of every menu item of menu 1 of menu item "${esc(submenu)}" of menu "${esc(menuName)}" of menu bar 1`,
			)
				.split(", ")
				.filter(Boolean)
		: listMenuItems(processName, menuName);

	const norm = (s) =>
		s
			.replace(/[.…]+$/, "")
			.trim()
			.toLowerCase();
	let matched = null;
	for (const pat of [].concat(patterns)) {
		const re = pat instanceof RegExp ? pat : new RegExp(`^${norm(pat)}$`, "i");
		matched = items.find((i) => (pat instanceof RegExp ? re.test(i) : re.test(norm(i))));
		if (matched) break;
	}
	if (!matched) {
		throw new UiScriptError(
			`no menu item in ${processName} → ${menuName}${submenu ? ` → ${submenu}` : ""} matched ${JSON.stringify(patterns)}. Present: ${JSON.stringify(items)}`,
		);
	}

	const target = submenu
		? `menu item "${esc(matched)}" of menu 1 of menu item "${esc(submenu)}" of menu "${esc(menuName)}" of menu bar 1`
		: `menu item "${esc(matched)}" of menu "${esc(menuName)}" of menu bar 1`;
	osa(
		`tell application "System Events" to tell process "${esc(processName)}"\n set frontmost to true\n click ${target}\nend tell`,
	);
	return matched;
}

/* ------------------------------------------------------------------------ windows -------- */

export function listWindows(processName) {
	try {
		return osa(
			`tell application "System Events" to tell process "${esc(processName)}" to return name of every window`,
		)
			.split(", ")
			.filter(Boolean);
	} catch {
		return [];
	}
}

export async function waitForWindow(processName, match, { timeoutMs = 60_000, pollMs = 400 } = {}) {
	const re = match instanceof RegExp ? match : new RegExp(match, "i");
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		const found = listWindows(processName).find((w) => re.test(w));
		if (found) return found;
		await sleep(pollMs);
	}
	throw new UiScriptError(
		`no window in ${processName} matched ${re} within ${timeoutMs}ms. Present: ${JSON.stringify(listWindows(processName))}`,
	);
}

/** Full accessibility dump of a window — the discovery tool for writing a driver. */
export function describeWindow(processName, windowIndex = 1, depth = 4) {
	return jxa(`
		const se = Application("System Events");
		const proc = se.processes["${esc(processName)}"];
		function walk(el, d) {
			if (d > ${depth}) return null;
			let role = "", name = "", desc = "", value = "";
			try { role = el.role(); } catch (e) {}
			try { name = el.name() || ""; } catch (e) {}
			try { desc = el.description() || ""; } catch (e) {}
			try { const v = el.value(); value = (v === null || v === undefined) ? "" : String(v).slice(0, 60); } catch (e) {}
			let kids = [];
			try { kids = el.uiElements().map(k => walk(k, d + 1)).filter(Boolean); } catch (e) {}
			return { role, name, desc, value, children: kids };
		}
		JSON.stringify(walk(proc.windows[${windowIndex - 1}], 0), null, 1);
	`);
}

/** Click a button/checkbox/pop-up anywhere in a window, found by name or description. */
export function clickControl(processName, { name, description, role = "button", windowIndex = 1 }) {
	const needle = esc(name ?? description ?? "");
	const attr = name ? "name" : "description";
	return jxa(`
		const se = Application("System Events");
		const proc = se.processes["${esc(processName)}"];
		proc.frontmost = true;
		function find(el, d) {
			if (d > 6) return null;
			try {
				if (el.role() === "AX${role[0].toUpperCase()}${role.slice(1)}") {
					let v = "";
					try { v = el.${attr}() || ""; } catch (e) {}
					if (v.toLowerCase().indexOf("${needle.toLowerCase()}") >= 0) return el;
				}
			} catch (e) {}
			let kids = [];
			try { kids = el.uiElements(); } catch (e) { return null; }
			for (const k of kids) { const hit = find(k, d + 1); if (hit) return hit; }
			return null;
		}
		const win = proc.windows[${windowIndex - 1}];
		const target = find(win, 0);
		if (!target) throw new Error("no ${role} matching ${needle}");
		target.click();
		"clicked";
	`);
}

/* -------------------------------------------------------------------- save panels -------- */

/**
 * Drive the standard AppKit save sheet to an exact path.
 *
 * ⇧⌘G opens "Go to folder", which accepts a full path and is the one interaction that behaves
 * the same in every app that uses the system panel. Typing into the name field alone is not
 * enough — the panel remembers its last directory, so two runs would write to two places.
 */
export async function savePanelTo(processName, absolutePath, { timeoutMs = 30_000 } = {}) {
	const dir = absolutePath.replace(/\/[^/]+$/, "");
	const file = absolutePath.split("/").pop();

	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		const hasSheet = osa(
			`tell application "System Events" to tell process "${esc(processName)}" to return (exists sheet 1 of window 1) or (exists window "Save")`,
		);
		if (hasSheet === "true") break;
		await sleep(300);
	}

	osa(`
		tell application "System Events"
			tell process "${esc(processName)}"
				set frontmost to true
				keystroke "g" using {command down, shift down}
				delay 0.5
				keystroke "${esc(dir)}"
				delay 0.4
				key code 36
				delay 0.8
				keystroke "a" using {command down}
				keystroke "${esc(file)}"
				delay 0.3
			end tell
		end tell
	`);
	return { dir, file };
}

/** Press Return in the frontmost sheet — the commit for most save panels. */
export function commitSavePanel(processName) {
	osa(
		`tell application "System Events" to tell process "${esc(processName)}"\n set frontmost to true\n key code 36\nend tell`,
	);
}

/** Answer a "replace the existing file?" alert, which otherwise stalls an unattended run. */
export function dismissReplaceAlert(processName) {
	try {
		osa(`
			tell application "System Events" to tell process "${esc(processName)}"
				if exists sheet 1 of sheet 1 of window 1 then
					click button "Replace" of sheet 1 of sheet 1 of window 1
				end if
			end tell
		`);
	} catch {
		/* no alert — the common case */
	}
}

export { esc as escapeAppleScript };
