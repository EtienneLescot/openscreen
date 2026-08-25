/**
 * Camtasia on Windows.
 *
 * A different automation story from the Mac build. Camtasia for Windows has no AppleScript
 * equivalent — TechSmith's documented command line drives the *recorder*, not the renderer —
 * but it does expose a real UI Automation tree, and it has a **Batch Export** that renders a
 * queue of `.tscproj` projects against one preset. Batch Export is what makes this measurable
 * without clicking through the inspector.
 *
 * Fidelity is partial, for the same reason as on macOS: background, padding, corner radius,
 * shadow and zooms live in Visual Properties and Zoom-n-Pan, and neither is scriptable. This
 * row measures Camtasia rendering the same source to the same output target with no
 * compositing — a real number for its render pipeline, not a full-demo comparison.
 *
 * NOT YET RUN ON WINDOWS. Written against the UIA surface and TechSmith's documented layout;
 * `bench.mjs discover camtasia` dumps the real control names on the target machine, and the
 * driver fails loudly with those names attached when a lookup misses.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { now, sleep } from "../lib/measure.mjs";
import { appVersion, resolveAppPath } from "../lib/platform.mjs";
import { activateApp, appIsRunning, launchApp, quitApp } from "../lib/ui.mjs";
import {
	clickControl,
	describeApp,
	fileDialogTo,
	listWindows,
	setControlValue,
} from "../lib/uiWindows.mjs";

export const CAMTASIA = {
	macPath: "/Applications/Camtasia.app",
	winPaths: [
		"%ProgramFiles%\\TechSmith\\Camtasia 2026\\CamtasiaStudio.exe",
		"%ProgramFiles%\\TechSmith\\Camtasia 2025\\CamtasiaStudio.exe",
		"%ProgramFiles%\\TechSmith\\Camtasia\\CamtasiaStudio.exe",
		"%ProgramFiles(x86)%\\TechSmith\\Camtasia 2026\\CamtasiaStudio.exe",
	],
};

const PROC = "CamtasiaStudio";

/** Click a control, or fail with the names that *were* present — the only useful error here. */
function mustClick(needle, opts = {}) {
	const r = clickControl(PROC, needle, opts);
	if (!r.ok) {
		throw new Error(
			`Camtasia: no control matching "${needle}". Present: ${(r.seen ?? []).slice(0, 20).join(" | ")}. ` +
				"Run `node benchmark/bench.mjs discover camtasia` for the full tree.",
		);
	}
	return r;
}

export default {
	id: "camtasia",
	displayName: "Camtasia",
	vendor: "TechSmith",
	kind: "gui",
	automation: "uia",
	processName: PROC,
	get appPath() {
		return resolveAppPath(CAMTASIA);
	},
	bundleId: null,
	install: {
		method: "installer",
		url: "https://download.techsmith.com/camtasia/releases/Camtasia.exe",
		appName: "Camtasia",
		approxMB: 500,
		licence:
			"commercial — 30-day trial; exports carry a watermark, which does not change render time",
		silentArgs: ["/S"],
		notes: [
			"TechSmith's Windows installer is an NSIS package; /S runs it unattended.",
			"No render CLI exists on Windows — the documented command line drives the recorder only.",
		],
	},

	detect() {
		const path = resolveAppPath(CAMTASIA);
		if (!path) return { installed: false, version: null, path: null };
		return { installed: true, version: appVersion(path), path };
	},

	async prepare(ctx) {
		const exe = resolveAppPath(CAMTASIA);
		if (!exe) throw new Error("Camtasia is not installed");

		if (!appIsRunning(PROC)) {
			// Opening the clip directly is what creates a project with the media on track 1,
			// which is otherwise a drag-and-drop that UIA cannot perform.
			await launchApp(exe, PROC, { args: [ctx.source.path], timeoutMs: 180_000 });
		} else {
			execFileSync("cmd.exe", ["/c", "start", "", exe, ctx.source.path], { stdio: "ignore" });
		}
		await sleep(20_000);
		activateApp(PROC);

		// A run killed mid-export leaves Camtasia offering to recover the project, and that
		// dialog is modal — everything after it silently misfires.
		clickControl(PROC, "Delete", { controlType: "Button" });
		await sleep(1500);

		// A 60 fps import raises "High Frame Rate Media Detected". Taking the 30 fps default
		// would halve the frames Camtasia renders and quietly make it look twice as fast.
		const converted = clickControl(PROC, "60 FPS", { controlType: "RadioButton" });
		if (converted.ok) {
			clickControl(PROC, "Remember my selection", { controlType: "CheckBox" });
			clickControl(PROC, "Continue", { controlType: "Button" });
			await sleep(2500);
		}

		// Do not proceed to Export with an empty timeline: that exports nothing and reads as an
		// instant, wildly fast render.
		const stem = ctx.source.path
			.split(/[/\\]/)
			.pop()
			.replace(/\.[^.]+$/, "");
		let imported = false;
		for (let i = 0; i < 60 && !imported; i++) {
			await sleep(2000);
			imported = describeApp(PROC, { max: 600 }).includes(stem);
		}
		if (!imported)
			throw new Error(`Camtasia never showed "${stem}" on the timeline after the import`);

		return {
			appliedFeatures: ["targetResolution", "targetFps"],
			notes: [
				converted.ok ? "project frame rate converted to 60 fps on import" : "no frame-rate prompt",
				"Effects are NOT applied: background, padding, corner radius, shadow and zooms live in Visual Properties and Zoom-n-Pan, neither of which Camtasia exposes to scripting on Windows either. This row measures its render pipeline at the same output target, not the full-demo composition.",
			],
		};
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
		mustClick("Export", { controlType: "Button" });
		await sleep(2500);
		// The Export menu offers Local File / Screencast / YouTube …
		clickControl(PROC, "Local File", { controlType: "MenuItem" });
		await sleep(3000);

		// The trial offers watermarked export or a licence key. A watermark is a cheap overlay
		// and does not change render time, so the trial path is a valid measurement.
		clickControl(PROC, "Export with Watermark", { controlType: "Button" });
		await sleep(2500);

		// Windows' file dialog takes a full path in its name field — no ⇧⌘G equivalent needed.
		await fileDialogTo(PROC, out);
		ctx.commit();

		// Camtasia shows a render progress dialog; its disappearance is the completion signal.
		const deadline = now() + 30 * 60 * 1000;
		let sawProgress = false;
		while (now() < deadline) {
			await sleep(1000);
			const wins = listWindows(PROC).join(" | ");
			const rendering = /render|produc|export/i.test(wins);
			if (rendering) sawProgress = true;
			if (sawProgress && !rendering) {
				ctx.markComplete();
				return;
			}
			// If the progress window was never observable, let the file watcher decide.
			if (!sawProgress && existsSync(out)) return;
		}
	},

	async cleanup() {
		if (appIsRunning(PROC)) await quitApp(PROC, { force: true });
	},
};
