/**
 * OpenScreen, headless.
 *
 * The subject of the benchmark, driven through its own `openscreen export` command. The
 * project is written as JSON rather than built in the editor, so the scenario is exact and
 * byte-reproducible — see lib/openscreenProject.mjs.
 *
 * Because this path skips the UI entirely it is *not* directly comparable to Screen Studio's
 * or Camtasia's numbers; `openscreen-gui` exists for that comparison, and the report keeps the
 * two rows apart.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildProject } from "../lib/openscreenProject.mjs";

const APP = "/Applications/Openscreen.app";
const BIN = `${APP}/Contents/MacOS/Openscreen`;

export default {
	id: "openscreen-cli",
	displayName: "OpenScreen (CLI)",
	vendor: "OpenScreen",
	kind: "cli",
	automation: "cli",
	processName: "Openscreen",
	appPath: APP,
	bundleId: "com.etiennelescot.openscreen",
	install: {
		method: "dmg",
		// Resolved at install time from the GitHub release feed; see lib/install.mjs.
		url: "github:getopenscreen/openscreen",
		appName: "Openscreen.app",
		approxMB: 250,
		licence: "MIT — free, no account, no watermark",
		notes: ["The CLI ships inside the normal app bundle; there is nothing extra to install."],
	},

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
			/* unreadable plist — report installed without a version */
		}
		return { installed: true, version, path: BIN };
	},

	/**
	 * OpenScreen's `padding` is 0-100 on its own scale, not a percentage of the frame. The
	 * default below is a starting point; `bench.mjs calibrate` measures the inset it actually
	 * produces and solves for the value that matches every other app.
	 */
	defaultPaddingControl(scenario) {
		return Math.round(Math.min(100, Math.max(0, scenario.effects.paddingPercent * 10)));
	},

	async prepare(ctx) {
		const outDir = join(ctx.workDir, "projects", "openscreen-cli");
		const { projectPath } = buildProject({
			sourcePath: ctx.source.path,
			scenario: ctx.scenario,
			outDir,
			title: ctx.scenario.id,
			paddingControl: ctx.paddingControl ?? this.defaultPaddingControl(ctx.scenario),
		});
		ctx.state.projectPath = projectPath;

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
				`project: ${projectPath}`,
				"MP4 export is fixed at 60 fps (MP4_EXPORT_FPS, src/cli/CliExportRunner.tsx) — which is why the pinned target is 60.",
			],
		};
	},

	outputPath(ctx) {
		return join(ctx.outDir, `${this.id}-${ctx.scenario.id}-run${ctx.run.index}.mp4`);
	},

	async runExport(ctx) {
		const out = this.outputPath(ctx);
		if (existsSync(out)) rmSync(out);

		const args = ["export", ctx.state.projectPath, "-o", out, "--quality", "good", "--json"];
		return new Promise((resolve, reject) => {
			const child = spawn(BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
			let committed = false;
			let stderrTail = "";
			let buf = "";

			child.stdout.on("data", (d) => {
				buf += d.toString();
				const lines = buf.split("\n");
				buf = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.trim()) continue;
					let ev;
					try {
						ev = JSON.parse(line);
					} catch {
						continue;
					}
					// `started` fires once the hidden renderer is up and the render begins. Taking
					// t0 here rather than at spawn keeps Electron's cold boot out of the export
					// number — the GUI apps are warm when their clock starts, so this one is too.
					// The boot cost is still recorded, as launchToCommitMs.
					if (!committed && (ev.event === "started" || ev.event === "progress")) {
						committed = true;
						ctx.commit();
					}
					if (ev.event === "progress") ctx.progress?.(ev.percentage);
					if (ev.event === "done") ctx.state.reportedOutput = ev.outputPath;
				}
			});
			child.stderr.on("data", (d) => {
				stderrTail = (stderrTail + d.toString()).slice(-2000);
			});
			child.on("error", reject);
			child.on("close", (code) => {
				if (!committed) ctx.commit(); // never leave the run without a t0
				if (code === 0) resolve();
				else
					reject(new Error(`openscreen export exited ${code}: ${stderrTail.trim().slice(0, 600)}`));
			});
		});
	},

	async cleanup() {
		// CLI exports leave the on-device STT server running; on an 8 GB machine those orphans
		// distort the next run's memory figures and the process sampler's totals.
		try {
			execFileSync("/usr/bin/pkill", ["-f", "whisper-stt-server"], { stdio: "ignore" });
		} catch {
			/* none running */
		}
	},
};
