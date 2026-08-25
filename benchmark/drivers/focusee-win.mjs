/**
 * FocuSee on Windows.
 *
 * The closest pitch-for-pitch rival to OpenScreen, and on Windows it is a first-class entrant:
 * the vendor's download *is* the Windows application (`focusee-en-v2-setup.exe`), where the Mac
 * side ships only a downloader stub, and the macOS build refused every MP4 it was handed with
 * "The source file is damaged and cannot be opened." That failure is specific to the Mac build
 * and there is a fair chance this one imports normally.
 *
 * FocuSee is a native app on both platforms, so unlike the Electron entrants its whole
 * interface is published to the automation API — canvas size, Padding / Inset / Roundness /
 * Shadow, and the Export button are all addressable by name.
 *
 * NOT YET RUN ON WINDOWS. `bench.mjs discover focusee` dumps the real control names; every
 * lookup here fails loudly with what it did find.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sleep } from "../lib/measure.mjs";
import { appVersion, resolveAppPath } from "../lib/platform.mjs";
import { activateApp, appIsRunning, launchApp, quitApp } from "../lib/ui.mjs";
import { clickControl, describeApp, fileDialogTo, setControlValue } from "../lib/uiWindows.mjs";

export const FOCUSEE = {
	macPath: "/Applications/FocuSee.app",
	winPaths: [
		"%ProgramFiles%\\Gemoo\\FocuSee\\FocuSee.exe",
		"%ProgramFiles(x86)%\\Gemoo\\FocuSee\\FocuSee.exe",
		"%LOCALAPPDATA%\\Programs\\FocuSee\\FocuSee.exe",
		"%ProgramFiles%\\FocuSee\\FocuSee.exe",
	],
};

const PROC = "FocuSee";

export default {
	id: "focusee",
	displayName: "FocuSee",
	vendor: "iMobie / Gemoo",
	kind: "gui",
	automation: "uia",
	processName: PROC,
	get appPath() {
		return resolveAppPath(FOCUSEE);
	},
	bundleId: null,
	install: {
		method: "installer",
		// The link the vendor's download button resolves to on Windows.
		url: "https://focusee.imobie-resource.com/product/focusee-en-v2-setup.exe",
		appName: "FocuSee",
		approxMB: 120,
		licence: "commercial — trial exports are watermarked",
		silentArgs: ["/S"],
		notes: [
			"On Windows the vendor serves the real application, not the downloader stub the Mac side gets.",
			"If /S is rejected the installer is not NSIS; run it once by hand during preflight.",
		],
	},

	detect() {
		const path = resolveAppPath(FOCUSEE);
		if (!path) return { installed: false, version: null, path: null };
		return { installed: true, version: appVersion(path), path };
	},

	async prepare(ctx) {
		const exe = resolveAppPath(FOCUSEE);
		if (!exe) throw new Error("FocuSee is not installed");

		if (appIsRunning(PROC)) await quitApp(PROC, { force: true });
		await sleep(2000);
		// Opening the clip through the shell creates a project without having to drive the
		// drag-and-drop drop zone, which no automation API can perform.
		await launchApp(exe, PROC, { args: [ctx.source.path], timeoutMs: 180_000 });
		await sleep(20_000);
		activateApp(PROC);

		const tree = describeApp(PROC, { max: 600 });
		if (/damaged and cannot be opened/i.test(tree)) {
			throw new Error(
				"FocuSee refused the source: “The source file is damaged and cannot be opened.” " +
					"This is the same failure the macOS build showed; if it reproduces here, the app cannot be benchmarked.",
			);
		}

		// FocuSee's composition controls are sliders with a readable numeric label. Where a
		// ValuePattern exists the scenario is applied; where it does not, the feature is simply
		// not claimed — the pixel verifier is what decides, not this list.
		const e = ctx.scenario.effects;
		const applied = ["targetResolution", "targetFps"];
		if (clickControl(PROC, "16:9", { controlType: "Button" }).ok) applied.push("targetResolution");
		if (setControlValue(PROC, "Padding", String(ctx.paddingControl ?? e.paddingPercent)))
			applied.push("padding");
		if (setControlValue(PROC, "Roundness", String(e.cornerRadiusPx))) applied.push("cornerRadius");
		if (
			e.shadow?.enabled &&
			setControlValue(PROC, "Shadow", String(Math.round(e.shadow.intensity * 100)))
		) {
			applied.push("shadow");
		}

		return {
			appliedFeatures: [...new Set(applied)],
			notes: [
				"Zooms are not applied: FocuSee generates them from its own cursor telemetry, which a file import has none of, and its manual zoom editor is not addressable.",
				`controls reached: ${[...new Set(applied)].join(", ")}`,
			],
		};
	},

	/** FocuSee's padding control is 0-100 on its own scale; `bench.mjs calibrate` solves it. */
	defaultPaddingControl(scenario) {
		return scenario.effects.paddingPercent;
	},

	outputPath(ctx) {
		return join(ctx.outDir, `${this.id}-${ctx.scenario.id}-run${ctx.run.index}.mp4`);
	},

	async runExport(ctx) {
		const out = this.outputPath(ctx);
		if (existsSync(out)) rmSync(out);
		mkdirSync(ctx.outDir, { recursive: true });

		activateApp(PROC);
		await sleep(600);
		const r = clickControl(PROC, "Export", { controlType: "Button" });
		if (!r.ok) {
			throw new Error(
				`FocuSee: no Export button. Present: ${(r.seen ?? []).slice(0, 20).join(" | ")}. ` +
					"Run `node benchmark/bench.mjs discover focusee`.",
			);
		}
		await sleep(3000);

		// The export sheet offers format and resolution before the file dialog.
		clickControl(PROC, "MP4", { controlType: "Button" });
		clickControl(PROC, "1080", { controlType: "Button" });
		await sleep(800);
		clickControl(PROC, "Export", { controlType: "Button" });

		await fileDialogTo(PROC, out);
		ctx.commit();
	},

	async cleanup() {
		if (appIsRunning(PROC)) await quitApp(PROC, { force: true });
	},
};
