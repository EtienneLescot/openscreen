/**
 * OpenScreen, through its own editor.
 *
 * The CLI leg (`openscreen-cli`) measures the render engine with no interface in the way. That
 * is the right number to compare against Cap's CLI, and the wrong one to compare against an app
 * that can only be driven by clicking — a UI leg carries the editor's own overhead, and the
 * subject of a benchmark should not be the only entrant excused from it.
 *
 * So this driver does what a person does: opens the project in the editor, opens the export
 * dialog, picks MP4 / 1080p / 60 / H.264, presses Export and answers the save panel.
 *
 * OpenScreen is Electron, so the editor is reached over CDP and every control is found by its
 * visible text. The two native surfaces on the path — the File menu and the save panel — are
 * driven through System Events.
 */
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CdpSession, DOM_HELPERS, listTargets } from "../lib/cdp.mjs";
import { sleep } from "../lib/measure.mjs";
import { buildProject } from "../lib/openscreenProject.mjs";
import {
	activateApp,
	appIsRunning,
	clickMenuItem,
	listWindows,
	osa,
	quitApp,
} from "../lib/uiScript.mjs";

const APP = "/Applications/Openscreen.app";
const BIN = `${APP}/Contents/MacOS/Openscreen`;
const PORT = 9335;

const editorTarget = async () =>
	(await listTargets(PORT)).find((t) => t.url.includes("windowType=editor"));

export default {
	id: "openscreen-gui",
	displayName: "OpenScreen (GUI)",
	vendor: "OpenScreen",
	kind: "gui",
	automation: "cdp+menu",
	processName: "Openscreen",
	appPath: APP,
	bundleId: "com.etiennelescot.openscreen",
	install: null, // shares the install with openscreen-cli

	detect() {
		if (!existsSync(BIN)) return { installed: false, version: null, path: null };
		let version = null;
		try {
			version = execFileSync(
				"/usr/bin/defaults",
				["read", `${APP}/Contents/Info.plist`, "CFBundleShortVersionString"],
				{ encoding: "utf8" },
			).trim();
		} catch {
			/* keep null */
		}
		return { installed: true, version, path: BIN };
	},

	defaultPaddingControl(scenario) {
		return Math.round(Math.min(100, Math.max(0, scenario.effects.paddingPercent * 10)));
	},

	async prepare(ctx) {
		const outDir = join(ctx.workDir, "projects", "openscreen-gui");
		const { projectPath } = buildProject({
			sourcePath: ctx.source.path,
			scenario: ctx.scenario,
			outDir,
			title: ctx.scenario.id,
			paddingControl: ctx.paddingControl ?? this.defaultPaddingControl(ctx.scenario),
		});
		ctx.state.projectPath = projectPath;

		// A single-instance lock keys on the userData path, so a stale instance must go before
		// the debugging port can be opened on a fresh one.
		if (appIsRunning(this.processName)) await quitApp(this.processName, { force: true });
		try {
			execFileSync("/usr/bin/pkill", ["-f", "whisper-stt-server"], { stdio: "ignore" });
		} catch {
			/* none running */
		}
		await sleep(2000);
		execFileSync("/bin/sh", [
			"-c",
			`nohup ${JSON.stringify(BIN)} --remote-debugging-port=${PORT} >/dev/null 2>&1 &`,
		]);
		await sleep(12000);

		// The launcher opens on the HUD; the editor is a separate window. switchToEditor never
		// resolves its promise, so it is fired and then waited for by polling the target list.
		const hud = (await listTargets(PORT)).find((t) => t.url.includes("hud-overlay"));
		if (hud) {
			const h = new CdpSession(hud.webSocketDebuggerUrl);
			await h.open();
			// switchToEditor tears the HUD renderer down, so the CDP reply for this evaluate may
			// never arrive. Fire it, give it a moment, move on.
			try {
				await h.send(
					"Runtime.evaluate",
					{ expression: "window.electronAPI.switchToEditor()", awaitPromise: false },
					{ timeoutMs: 5000 },
				);
			} catch {
				/* expected when the page goes away mid-call */
			}
			h.close();
		}
		let ed = null;
		for (let i = 0; i < 30 && !ed; i++) {
			await sleep(1000);
			ed = await editorTarget();
		}
		if (!ed) throw new Error("the OpenScreen editor window never appeared");

		const s = new CdpSession(ed.webSocketDebuggerUrl);
		await s.open();
		await s.eval(DOM_HELPERS);
		ctx.state.cdp = s;

		// File → Load Project… raises an in-app picker whose "Browse files…" button is what
		// opens the real panel. Both steps are needed; the in-app list ignores ⇧⌘G.
		activateApp(this.processName);
		await sleep(700);
		clickMenuItem(this.processName, "File", ["Load Project"]);
		await sleep(2000);
		await s.eval(`JSON.stringify(window.__osbench.click("Browse files"))`);
		await sleep(2000);
		osa(`tell application "System Events" to tell process "${this.processName}"
			set frontmost to true
			keystroke "g" using {command down, shift down}
			delay 0.8
			keystroke "${projectPath}"
			delay 0.6
			key code 36
			delay 1.4
			key code 36
		end tell`);
		await sleep(10000);

		// Ask the app which project it has open rather than scraping the panel for a duration
		// string. This is a gate, not a formality: an editor with no project loaded exports
		// happily and writes an empty container, which reads as an instant, wildly fast render.
		let loadedPath = null;
		for (let i = 0; i < 25 && loadedPath !== projectPath; i++) {
			await sleep(1500);
			try {
				const raw = await s.eval(
					`(async () => { try { const r = await window.electronAPI.loadCurrentProjectFile(); return JSON.stringify(r ?? null); } catch (e) { return null; } })()`,
					{ timeoutMs: 15_000 },
				);
				const cur = raw ? JSON.parse(raw) : null;
				if (cur?.path) loadedPath = cur.path;
			} catch {
				/* the renderer may be mid-load */
			}
		}
		const panel = await s.eval("document.body.innerText.slice(0, 600)");
		if (loadedPath !== projectPath) {
			throw new Error(
				`OpenScreen has "${loadedPath ?? "no project"}" open, not the benchmark project ` +
					`(${projectPath}). Panel read: ${panel.replace(/\n+/g, " | ").slice(0, 200)}`,
			);
		}

		const applied = ["targetResolution", "targetFps"];
		const e = ctx.scenario.effects;
		if (panel.includes(e.background.color)) applied.push("background");
		if (/Padding/.test(panel)) applied.push("padding");
		if (new RegExp(`Roundness\\s*\\|?\\s*${e.cornerRadiusPx}`).test(panel.replace(/\n/g, " "))) {
			applied.push("cornerRadius");
		}
		if (/Shadow\s*\|?\s*(?!0%)\d+%/.test(panel.replace(/\n/g, " "))) applied.push("shadow");
		// Zooms live on the timeline rather than the composition panel; the project was written
		// with them and the pixel verifier is what confirms they rendered.
		if (e.zooms?.length) applied.push("zooms");

		return {
			appliedFeatures: applied,
			notes: [
				`project: ${projectPath}`,
				`composition panel after load: ${panel.replace(/\n+/g, " | ").slice(0, 220)}`,
			],
		};
	},

	outputPath(ctx) {
		return join(ctx.outDir, `${this.id}-${ctx.scenario.id}-run${ctx.run.index}.mp4`);
	},

	async runExport(ctx) {
		const s = ctx.state.cdp;
		const out = this.outputPath(ctx);
		if (existsSync(out)) rmSync(out);
		const t = ctx.scenario.output;

		await s.eval(`JSON.stringify(window.__osbench.click("Export", { exact: true }))`);
		await sleep(2000);

		// Confirm the dialog is actually up. On a repeat run the editor can still be showing the
		// previous export's completion state, and clicking through a dialog that never opened
		// leaves the run waiting on a file no one is writing.
		let dialogUp = false;
		for (let i = 0; i < 15 && !dialogUp; i++) {
			const txt = await s.eval("document.body.innerText");
			dialogUp = /Render the timeline to a file/i.test(txt) && /Export MP4/i.test(txt);
			if (!dialogUp) {
				await sleep(1000);
				// Dismiss whatever is in the way, then ask again.
				await s.eval(`JSON.stringify(window.__osbench.click("Close"))`).catch(() => undefined);
				await s.eval(`JSON.stringify(window.__osbench.click("Export", { exact: true }))`);
			}
		}
		if (!dialogUp) throw new Error("OpenScreen: the export dialog never opened");

		// The dialog's controls are plain buttons labelled with their value.
		for (const label of ["MP4", `${t.height}p`, String(t.fps), "H.264"]) {
			const r = JSON.parse(
				await s.eval(
					`JSON.stringify(window.__osbench.click(${JSON.stringify(label)}, { exact: true }))`,
				),
			);
			if (!r.ok) throw new Error(`OpenScreen export dialog: no control labelled "${label}"`);
			await sleep(350);
		}

		const go = JSON.parse(await s.eval(`JSON.stringify(window.__osbench.click("Export MP4"))`));
		if (!go.ok) throw new Error("OpenScreen export dialog: no “Export MP4” button");

		// Pressing Export raises the system save panel; the render starts when it is answered.
		await sleep(2500);
		const dir = out.replace(/\/[^/]+$/, "");
		// The save panel appends the format's extension itself, so a name that already carries
		// one comes back as "…run0.mp4.mp4" and the watcher waits forever on a path that will
		// never exist. Type the stem only.
		const file = out
			.split("/")
			.pop()
			.replace(/\.mp4$/i, "");
		osa(`tell application "System Events" to tell process "${this.processName}"
			set frontmost to true
			keystroke "g" using {command down, shift down}
			delay 0.7
			keystroke "${dir}"
			delay 0.5
			key code 36
			delay 1.0
			keystroke "a" using {command down}
			keystroke "${file}"
			delay 0.4
			key code 36
			delay 0.8
		end tell`);
		ctx.commit();

		// Answer a replace-confirmation if one appears, then let the runner's file watcher decide
		// when the render is done.
		await sleep(1200);
		try {
			osa(`tell application "System Events" to tell process "${this.processName}"
				repeat with w in windows
					try
						if exists (button "Replace" of sheet 1 of w) then click button "Replace" of sheet 1 of w
					end try
				end repeat
			end tell`);
		} catch {
			/* the common case: no alert */
		}
	},

	async cleanup(ctx) {
		ctx.state?.cdp?.close();
		if (appIsRunning(this.processName)) await quitApp(this.processName, { force: true });
		try {
			execFileSync("/usr/bin/pkill", ["-f", "whisper-stt-server"], { stdio: "ignore" });
		} catch {
			/* none running */
		}
	},
};
