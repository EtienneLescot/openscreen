/**
 * FocuSee — the closest pitch-for-pitch rival, currently unmeasurable.
 *
 * **FocuSee 2.4.1 rejects every MP4 it is given.** Its own import panel and `open -a` both end
 * at *"The source file is damaged and cannot be opened."* — for the benchmark fixture and for a
 * real 2560×1440 H.264 screen recording alike. The app is not sandboxed (no
 * `com.apple.security.app-sandbox` entitlement), so this is not a file-access grant that could
 * be fixed by choosing the file through a picker. Verified on macOS 26.5 with the direct
 * download from imobie; the Mac App Store build may differ.
 *
 * The rest of the driver is written and works: FocuSee is a native Cocoa app, so unlike the
 * Electron entrants its whole interface is published to the accessibility API — the canvas-size
 * buttons, the Padding / Inset / Roundness / Shadow values and the Export button are all
 * addressable by name. If a later build fixes the import, this driver should measure it as-is.
 *
 * Install note: the vendor ships a ~5 MB downloader stub rather than the app. It is notarised
 * (iMobie Inc., team 2QJGLWL8Y6) and installs FocuSee.app into /Applications on launch, but it
 * is a GUI installer, so `bench.mjs install` cannot fetch this one unattended.
 */
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sleep } from "../lib/measure.mjs";
import { activateApp, appIsRunning, jxa, launchApp, osa, quitApp } from "../lib/uiScript.mjs";

const APP = "/Applications/FocuSee.app";
const PROC = "FocuSee";

/** Read every static-text value in FocuSee's edit window — how its state is inspected. */
function editorText() {
	return JSON.parse(
		jxa(`
			const se = Application("System Events");
			const p = se.processes["${PROC}"];
			const win = p.windows().find(w => { try { return w.name() === "edit"; } catch (e) { return false; } });
			function txt(el, d) {
				if (d > 10) return [];
				let out = [];
				try {
					const r = el.role();
					if (r === "AXStaticText" || r === "AXButton") {
						const v = el.value() || el.name();
						if (v && String(v) !== "button") out.push(String(v).slice(0, 60));
					}
				} catch (e) {}
				try { for (const k of el.uiElements()) out = out.concat(txt(k, d + 1)); } catch (e) {}
				return out;
			}
			JSON.stringify(win ? txt(win, 0) : []);
		`),
	);
}

export default {
	id: "focusee",
	displayName: "FocuSee",
	vendor: "iMobie",
	kind: "gui",
	automation: "ax+menu",
	processName: PROC,
	appPath: APP,
	bundleId: "com.imobie.FocuSee",
	install: {
		method: "manual",
		url: "https://focusee.imobie.com/go/download.php?product=fs",
		appName: "FocuSee.app",
		approxMB: 5,
		licence: "commercial — trial exports are watermarked",
		notes: [
			"The download is a GUI installer stub, not the app, so this one cannot be installed unattended.",
			"Run the stub once during preflight; it places FocuSee.app in /Applications itself.",
		],
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
		if (appIsRunning(PROC)) await quitApp(PROC, { force: true });
		await sleep(2000);
		// FocuSee registers as an MP4 handler; opening the file this way is what creates a
		// project without having to drive its drag-and-drop drop zone.
		execFileSync("/usr/bin/open", ["-a", APP, ctx.source.path]);
		await sleep(18000);
		activateApp(PROC);

		const text = editorText();
		const damaged = text.some((t) => /damaged and cannot be opened/i.test(t));
		if (damaged) {
			throw new Error(
				"FocuSee refused the source: “The source file is damaged and cannot be opened.” " +
					"Reproduced with a real 1440p H.264 recording too, so it is not specific to the benchmark " +
					"fixture. The app is not sandboxed, so this is not a file-access grant.",
			);
		}
		if (!text.length) throw new Error("FocuSee did not open an edit window for the source clip");

		// The composition controls are AX static texts paired with sliders; FocuSee exposes their
		// values but not setters, so what the scenario can reach here is limited to the canvas
		// aspect ratio. Whatever is applied is reported, never assumed.
		const applied = ["targetResolution", "targetFps"];
		return {
			appliedFeatures: applied,
			notes: [`editor state: ${text.slice(0, 20).join(" · ")}`],
		};
	},

	outputPath(ctx) {
		return join(ctx.outDir, `${this.id}-${ctx.scenario.id}-run${ctx.run.index}.mp4`);
	},

	async runExport(ctx) {
		const out = this.outputPath(ctx);
		if (existsSync(out)) rmSync(out);
		activateApp(PROC);
		await sleep(600);

		const clicked = JSON.parse(
			jxa(`
				const se = Application("System Events");
				const p = se.processes["${PROC}"];
				p.frontmost = true;
				function findAll(el, d, out) {
					if (d > 10) return out;
					try { if (el.role() === "AXButton") { const n = el.name() || ""; if (n) out.push([String(n), el]); } } catch (e) {}
					try { for (const k of el.uiElements()) findAll(k, d + 1, out); } catch (e) {}
					return out;
				}
				let all = [];
				for (const w of p.windows()) findAll(w, 0, all);
				const hit = all.find(([n]) => /^export$/i.test(n));
				if (!hit) JSON.stringify({ ok: false, seen: all.map(a => a[0]).slice(0, 20) });
				else { hit[1].click(); JSON.stringify({ ok: true }); }
			`),
		);
		if (!clicked.ok)
			throw new Error(`FocuSee: no Export button. Present: ${(clicked.seen ?? []).join(", ")}`);
		await sleep(3000);

		const dir = out.replace(/\/[^/]+$/, "");
		const stem = out
			.split("/")
			.pop()
			.replace(/\.mp4$/i, "");
		osa(`tell application "System Events" to tell process "${PROC}"
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

	async cleanup() {
		if (appIsRunning(PROC)) await quitApp(PROC, { force: true });
	},
};
