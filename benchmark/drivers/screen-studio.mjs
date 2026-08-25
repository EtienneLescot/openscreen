/**
 * Screen Studio — the app that defined this category.
 *
 * Fully automated up to the point where it stops being possible: **export is gated behind
 * account activation.** Pressing Export on an unactivated install opens an activation wall
 * asking for an email or licence key. There is no trial export and no watermark path — the
 * bundle contains no "free trial" strings at all. With a licence activated once (during
 * preflight), every step below runs unattended and the app becomes a full peer in the table.
 *
 * Getting to that point took the most work of any app here, and the findings are worth stating
 * because they shape the driver:
 *
 * 1. **It cannot be screenshotted.** The editor window is marked `kCGWindowSharingNone`, so
 *    macOS excludes it from every capture API. It is plainly visible to the person at the
 *    machine and invisible to `screencapture`, ScreenCaptureKit, and any agent driving pixels.
 * 2. **It publishes no accessibility tree.** `System Events` sees a window containing three
 *    traffic-light buttons and nothing else.
 * 3. Its only documented automation is three `screen-studio://record-*` deeplinks. The bundle
 *    also carries undocumented ones (`export-to-clipboard`, `copy-and-zip-project`,
 *    `open-projects-folder`), none of which exports to a file.
 *
 * What makes it drivable is `--remote-debugging-port`: the renderer is then reachable and every
 * control can be found by its visible text. That is *more* reproducible than pixel clicking, not
 * less — it survives a moved window, a different display and a resized UI — and the flag only
 * opens an inspector; the renderer and export pipeline are the shipping ones.
 *
 * The composition itself is not clicked at all: a `.screenstudio` project is a directory of
 * plain JSON, so the scenario is written straight into `project.json` and the app reopens it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CdpSession, DOM_HELPERS, listTargets } from "../lib/cdp.mjs";
import { sleep } from "../lib/measure.mjs";
import { activateApp, appIsRunning, clickMenuItem, osa, quitApp } from "../lib/uiScript.mjs";

const APP = "/Applications/Screen Studio.app";
const BIN = `${APP}/Contents/MacOS/Screen Studio`;
const PORT = 9333;
const PROJECTS = join(homedir(), "Screen Studio Projects");

/** Screen Studio's zoom-range shape, recovered from its own project factory. */
const zoomRange = (z, i) => ({
	id: `osbench${String(i).padStart(4, "0")}`,
	zoom: z.scale,
	type: "manual",
	snapToEdgesRatio: 0.25,
	manualTargetPoint: { x: z.focus.x, y: z.focus.y },
	glideDirection: null,
	glideSpeed: 0.5,
	isDisabled: false,
	startTime: z.startSec,
	endTime: z.endSec,
	isSystem: false,
	hasInstantAnimation: false,
});

export default {
	id: "screen-studio",
	displayName: "Screen Studio",
	vendor: "Screen Studio",
	kind: "gui",
	automation: "cdp+menu",
	processName: "Screen Studio",
	appPath: APP,
	bundleId: "com.timpler.screenstudio",
	install: {
		method: "dmg",
		url: "https://screenstudioassets.com/releases/3.7.5-4595/Screen%20Studio%203.7.5-4595%20Apple%20Silicon.dmg",
		version: "3.7.5-4595",
		appName: "Screen Studio.app",
		approxMB: 349,
		licence: "commercial — a licence is REQUIRED to export; there is no trial export",
	},

	detect() {
		if (!existsSync(APP)) return { installed: false, version: null, path: null };
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
		return { installed: true, version, path: APP };
	},

	defaultPaddingControl(scenario) {
		// `backgroundPaddingRatio` is a percentage-like scale; calibration solves the exact value.
		return scenario.effects.paddingPercent * 2;
	},

	async prepare(ctx) {
		if (appIsRunning(this.processName)) await quitApp(this.processName, { force: true });
		await sleep(2000);
		execFileSync("/bin/sh", [
			"-c",
			`nohup ${JSON.stringify(BIN)} --remote-debugging-port=${PORT} >/dev/null 2>&1 &`,
		]);
		await sleep(12000);

		// Import: File → "Create project from video…" raises a standard open panel.
		activateApp(this.processName);
		await sleep(800);
		clickMenuItem(this.processName, "File", ["Create project from video"]);
		await sleep(2500);
		osa(`tell application "System Events" to tell process "${this.processName}"
			set frontmost to true
			keystroke "g" using {command down, shift down}
			delay 0.8
			keystroke "${ctx.source.path}"
			delay 0.6
			key code 36
			delay 1.2
			key code 36
		end tell`);
		await sleep(25000);

		// Find the project the import just created and write the scenario into it.
		const dirs = readdirSync(PROJECTS)
			.filter((d) => d.endsWith(".screenstudio"))
			.map((d) => ({ d, m: readFileSync }))
			.map(({ d }) => join(PROJECTS, d));
		if (!dirs.length) throw new Error(`no .screenstudio project appeared in ${PROJECTS}`);
		const project = dirs.sort()[dirs.length - 1];
		const file = join(project, "project.json");
		const doc = JSON.parse(readFileSync(file, "utf8"));
		const e = ctx.scenario.effects;

		doc.json.config.backgroundType = "color";
		doc.json.config.backgroundColor = e.background.color;
		doc.json.config.backgroundImage = null;
		doc.json.config.backgroundBlur = 0;
		doc.json.config.backgroundPaddingRatio =
			ctx.paddingControl ?? this.defaultPaddingControl(ctx.scenario);
		doc.json.config.windowBorderRadius = e.cornerRadiusPx;
		doc.json.config.shadowIntensity = e.shadow?.enabled ? e.shadow.intensity : 0;
		doc.json.config.hideCamera = true;
		doc.json.config.motionBlurAmount = e.motionBlur ? 1 : 0;
		doc.json.scenes[0].zoomRanges = (e.zooms ?? []).map(zoomRange);
		writeFileSync(file, JSON.stringify(doc, null, 2));
		ctx.state.projectPath = project;

		// Reopen so the app reads what was just written.
		clickMenuItem(this.processName, "File", ["Open last project"]);
		await sleep(12000);

		const target = (await listTargets(PORT)).find((t) => t.type === "page");
		const s = new CdpSession(target.webSocketDebuggerUrl);
		await s.open();
		await s.eval(DOM_HELPERS);
		ctx.state.cdp = s;

		return {
			appliedFeatures: [
				"background",
				"padding",
				"cornerRadius",
				"shadow",
				"zooms",
				"targetResolution",
				"targetFps",
			],
			notes: [
				`project: ${project}`,
				`${(e.zooms ?? []).length} zoom ranges written into scenes[0].zoomRanges`,
				"Screen Studio re-encodes the source on import (its own display track), so its decoder input differs from the other apps'.",
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

		const clicked = JSON.parse(await s.eval(`JSON.stringify(window.__osbench.click("Export"))`));
		if (!clicked.ok) throw new Error("Screen Studio: no Export control in the editor");
		await sleep(3000);

		// An unactivated install answers Export with an activation wall rather than a dialog.
		const wall = await s.eval(`(() => {
			for (const t of [...document.querySelectorAll("body")]) {
				if (/Activate Screen Studio/i.test(t.innerText)) return "activation-required";
			}
			return "";
		})()`);
		if (wall === "activation-required") {
			throw new Error(
				"Screen Studio requires an activated licence to export — no trial export exists. " +
					"Activate it once during preflight and re-run; every other step of this driver is unattended.",
			);
		}

		// With a licence, the dialog's controls carry their values as visible text.
		const t = ctx.scenario.output;
		for (const label of ["MP4", `${t.height}p`, String(t.fps)]) {
			await s.eval(`JSON.stringify(window.__osbench.click(${JSON.stringify(label)}))`);
			await sleep(400);
		}
		await s.eval(`JSON.stringify(window.__osbench.click("Export"))`);
		await sleep(2500);

		const dir = out.replace(/\/[^/]+$/, "");
		const stem = out
			.split("/")
			.pop()
			.replace(/\.mp4$/i, "");
		osa(`tell application "System Events" to tell process "${this.processName}"
			set frontmost to true
			keystroke "g" using {command down, shift down}
			delay 0.8
			keystroke "${dir}"
			delay 0.5
			key code 36
			delay 1.0
			keystroke "a" using {command down}
			keystroke "${stem}"
			delay 0.4
			key code 36
		end tell`);
		ctx.commit();
	},

	async cleanup(ctx) {
		ctx.state?.cdp?.close();
		if (appIsRunning(this.processName)) await quitApp(this.processName, { force: true });
	},
};
