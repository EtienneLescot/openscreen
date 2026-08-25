/**
 * Camtasia — the traditional screencast editor.
 *
 * A different generation of tool from the rest of the set: Camtasia is a general video editor
 * that happens to record screens, rather than a demo-maker. That shows up in what can be
 * automated and in what the row means.
 *
 * **Fidelity is partial, and deliberately so.** Camtasia can express every effect in the
 * scenario, but not through any scripted interface:
 *
 *   · background   — a colour clip on a lower track, or the canvas colour in Properties
 *   · padding      — Visual Properties → Scale on the selected media
 *   · corner radius— Visual Effects → Border
 *   · shadow       — Visual Effects → Drop Shadow
 *   · zooms        — Edit → Zoom-n-Pan, a panel with no scripting surface
 *
 * Its AppleScript dictionary exposes `add file`, `addAction` (transitions only) and a readable
 * `isExporting`, and nothing that reaches Visual Properties or Zoom-n-Pan. Driving those means
 * clicking through the inspector, which is the least reproducible rung of the ladder and would
 * make this row depend on Camtasia's panel layout not moving between releases.
 *
 * So this driver measures Camtasia rendering the *same source to the same output target*, with
 * no compositing, and the report marks it partial. That is a real and useful number — it is the
 * cost of Camtasia's render pipeline on this machine — but it is not comparable to a full-demo
 * row, and the report does not rank it against one.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { now, sleep } from "../lib/measure.mjs";
import {
	activateApp,
	appIsRunning,
	clickMenuItem,
	jxa,
	launchApp,
	osa,
	quitApp,
} from "../lib/uiScript.mjs";

const APP = "/Applications/Camtasia.app";
const PROC = "Camtasia";

/** Click the first AXButton/AXRadioButton/AXCheckBox anywhere in the app whose name matches. */
function clickByName(pattern, { roles = ["AXButton"], required = true } = {}) {
	const res = jxa(`
		const se = Application("System Events");
		const p = se.processes["${PROC}"];
		p.frontmost = true;
		const roles = ${JSON.stringify(roles)};
		function findAll(el, d, out) {
			if (d > 9) return out;
			try {
				if (roles.includes(el.role())) {
					let n = ""; try { n = el.name() || ""; } catch (e) {}
					if (n) out.push([String(n), el]);
				}
			} catch (e) {}
			try { for (const k of el.uiElements()) findAll(k, d + 1, out); } catch (e) {}
			return out;
		}
		let all = [];
		for (const w of p.windows()) {
			findAll(w, 0, all);
			try { for (const s of w.sheets()) findAll(s, 0, all); } catch (e) {}
		}
		const re = new RegExp(${JSON.stringify(pattern)}, "i");
		const hit = all.find(([n]) => re.test(n));
		if (!hit) JSON.stringify({ ok: false, seen: all.map(a => a[0]).slice(0, 20) });
		else { hit[1].click(); JSON.stringify({ ok: true, matched: hit[0] }); }
	`);
	const parsed = JSON.parse(res);
	if (!parsed.ok && required) {
		throw new Error(
			`Camtasia: no control matching /${pattern}/. Present: ${(parsed.seen ?? []).join(", ")}`,
		);
	}
	return parsed;
}

/** Is a modal sheet — the save panel — actually up? */
async function sheetPresent() {
	try {
		return (
			jxa(`
				const se = Application("System Events");
				const p = se.processes["${PROC}"];
				let n = 0;
				for (const w of p.windows()) { try { n += w.sheets().length; } catch (e) {} }
				String(n > 0);
			`) === "true"
		);
	} catch {
		return false;
	}
}

export default {
	id: "camtasia",
	displayName: "Camtasia",
	vendor: "TechSmith",
	kind: "gui",
	automation: "applescript+ax",
	processName: PROC,
	appPath: APP,
	bundleId: "com.techsmith.camtasia",
	install: {
		method: "dmg",
		url: "https://download.techsmith.com/camtasiamac/releases/Camtasia.dmg",
		appName: "Camtasia.app",
		approxMB: 412,
		licence:
			"commercial — 30-day trial; exports carry a watermark, which does not change render time",
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

	async prepare(ctx) {
		if (!appIsRunning(PROC)) await launchApp(APP, PROC);
		await sleep(6000);
		activateApp(PROC);
		await sleep(800);

		// A run that was interrupted mid-export leaves Camtasia offering to recover the project
		// on next launch. That dialog is modal, so everything after it silently misfires —
		// keystrokes meant for a save panel end up naming markers in the timeline instead.
		clickByName("^Delete$", { required: false });
		await sleep(1500);

		clickMenuItem(PROC, "File", ["New Project"]);
		await sleep(5000);

		// `add file` needs a real file reference, not a POSIX path string.
		osa(`tell application "Camtasia" to add file (POSIX file "${ctx.source.path}") at time 0`, {
			timeoutMs: 180_000,
		});

		// Importing a minute of 1080p60 takes Camtasia a while, and `add file` returns before it
		// has finished. Wait for the media bin to actually show the clip rather than guessing at
		// a delay — a driver that proceeds to Export with an empty timeline exports nothing and
		// looks like a timeout.
		const stem = ctx.source.path
			.split("/")
			.pop()
			.replace(/\.[^.]+$/, "");
		let imported = false;
		for (let i = 0; i < 60 && !imported; i++) {
			await sleep(2000);
			try {
				imported =
					jxa(`
					const se = Application("System Events");
					const p = se.processes["${PROC}"];
					function has(el, d) {
						if (d > 9) return false;
						try {
							const n = (el.name() || "") + " " + (el.value() || "");
							if (n.includes(${JSON.stringify(stem)})) return true;
						} catch (e) {}
						try { for (const k of el.uiElements()) if (has(k, d + 1)) return true; } catch (e) {}
						return false;
					}
					String(p.windows().some(w => has(w, 0)));
				`) === "true";
			} catch {
				/* the window may be mid-layout */
			}
		}
		if (!imported) {
			throw new Error(`Camtasia never showed "${stem}" on the timeline after the import`);
		}

		// A 60 fps import raises "High Frame Rate Media Detected". Taking the 30 fps default
		// would halve the frames Camtasia renders and quietly make it look twice as fast, so the
		// answer is forced here and the choice is remembered for later runs.
		const converted = clickByName("Convert the entire project to 60", {
			roles: ["AXRadioButton"],
			required: false,
		});
		if (converted.ok) {
			clickByName("Remember my selection", { roles: ["AXCheckBox"], required: false });
			clickByName("^Continue$", { required: false });
			await sleep(2500);
		}

		return {
			appliedFeatures: ["targetResolution", "targetFps"],
			notes: [
				converted.ok
					? "project frame rate converted to 60 fps on import"
					: "no frame-rate prompt (already remembered from an earlier run)",
				"Effects are NOT applied: background, padding, corner radius, shadow and zooms live in Visual Properties and Zoom-n-Pan, neither of which Camtasia exposes to scripting. This row measures its render pipeline at the same output target, not the full-demo composition.",
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
		clickMenuItem(PROC, "Export", ["Local File"]);
		await sleep(4000);

		// The trial offers watermarked export or a licence key. A watermark is a cheap overlay
		// and does not change render time, so the trial path is a valid measurement.
		clickByName("Export with Watermark", { required: false });
		await sleep(3000);

		// Never type blind. If the export sheet did not open, ⇧⌘G and the filename would land in
		// the editor — which is exactly how an interrupted run once created timeline markers
		// named after the output file.
		if (!(await sheetPresent())) {
			throw new Error(
				"Camtasia: Export → Local File did not raise a save sheet. Something modal is in the " +
					"way (a recovery prompt, an upsell, or an unfinished export).",
			);
		}

		// Camtasia's export sheet is a standard save panel: ⇧⌘G reaches it.
		const dir = out.replace(/\/[^/]+$/, "");
		const stem = out
			.split("/")
			.pop()
			.replace(/\.mp4$/i, "");
		osa(`tell application "System Events" to tell process "${PROC}"
			set frontmost to true
			keystroke "g" using {command down, shift down}
			delay 0.9
			keystroke "${dir}"
			delay 0.6
			key code 36
			delay 1.2
			keystroke "a" using {command down}
			keystroke "${stem}"
			delay 0.5
		end tell`);
		await sleep(1200);

		clickByName("^Export$");
		ctx.commit();

		// Camtasia publishes its own progress; `isExporting` going false is a cleaner stop than
		// the filesystem, which sees the file appear before the muxer is finished with it.
		const deadline = now() + 30 * 60 * 1000;
		let sawExporting = false;
		while (now() < deadline) {
			await sleep(1000);
			let exporting = null;
			try {
				exporting = osa(`tell application "Camtasia" to return isExporting of front project`, {
					timeoutMs: 8000,
				});
			} catch {
				exporting = null; // the property is not always readable; the file watcher covers it
			}
			if (exporting === "true") sawExporting = true;
			if (sawExporting && exporting === "false") {
				ctx.markComplete();
				return;
			}
			if (existsSync(out) && !sawExporting) {
				// isExporting was never readable on this build — let the runner's watcher decide.
				return;
			}
		}
	},

	async cleanup() {
		if (appIsRunning(PROC)) await quitApp(PROC, { force: true });
	},
};
