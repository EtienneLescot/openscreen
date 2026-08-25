/**
 * Cap (cap.so) — the other open-source entrant in this category.
 *
 * The only competitor here with a real command line: `Cap.app/Contents/MacOS/cap-cli export`
 * renders a `.cap` project with the app's full compositor, and takes `--fps`, `--resolution`
 * and `--quality`, so it can be pinned to the same output as everything else.
 *
 * A `.cap` project is a directory — `recording-meta.json` plus the media — and the editor
 * state lives beside it in `project-config.json`. Both are written directly, for the same
 * reason OpenScreen's project is: an edit typed into a UI is not reproducible.
 */
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const APP = "/Applications/Cap.app";
const CLI = `${APP}/Contents/MacOS/cap-cli`;

/** #RRGGBB → the [r,g,b] triple Cap's colour background expects. */
const rgb = (hex) => {
	const h = hex.replace("#", "");
	return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
};

export default {
	id: "cap",
	displayName: "Cap",
	vendor: "Cap Software",
	kind: "cli",
	automation: "cli",
	processName: "Cap",
	appPath: APP,
	bundleId: "so.cap.desktop",
	install: {
		method: "dmg",
		url: "https://cap.so/download/apple-silicon",
		appName: "Cap.app",
		approxMB: 123,
		licence: "AGPL-3.0 — free",
	},

	detect() {
		if (!existsSync(CLI)) return { installed: false, version: null, path: null };
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
		return { installed: true, version, path: CLI };
	},

	/** Cap's `background.padding` is 0-100 on its own scale; see `bench.mjs calibrate`. */
	defaultPaddingControl(scenario) {
		return scenario.effects.paddingPercent;
	},

	async prepare(ctx) {
		const e = ctx.scenario.effects;
		const dir = join(ctx.workDir, "projects", "cap");
		const project = join(dir, `${ctx.scenario.id}.cap`);
		rmSync(project, { recursive: true, force: true });
		mkdirSync(join(project, "content"), { recursive: true });
		copyFileSync(ctx.source.path, join(project, "content", "display.mp4"));

		// A single-segment studio recording: the smallest shape `cap project validate` accepts,
		// and the one an import would produce.
		writeFileSync(
			join(project, "recording-meta.json"),
			`${JSON.stringify(
				{
					platform: "MacOS",
					pretty_name: `openscreen-benchmark-${ctx.scenario.id}`,
					display: { path: "content/display.mp4", fps: ctx.source.probe.video.fps },
				},
				null,
				2,
			)}\n`,
		);

		// Start from Cap's own defaults so nothing unset drifts between versions, then apply
		// only what the scenario names.
		const base = JSON.parse(
			execFileSync(CLI, ["project", "config", "get", project], { encoding: "utf8" }),
		);
		const duration = ctx.source.probe.durationSec;

		base.background.source = {
			type: "color",
			value: rgb(e.background?.color ?? "#000000"),
			alpha: 255,
		};
		base.background.blur = 0;
		base.background.padding = ctx.paddingControl ?? this.defaultPaddingControl(ctx.scenario);
		base.background.rounding = e.cornerRadiusPx;
		// Cap's `shadow` is 0-100; the scenario's intensity is 0-1.
		base.background.shadow = e.shadow?.enabled ? Math.round(e.shadow.intensity * 100) : 0;
		base.camera.hide = true;
		base.cursor.hide = !e.cursorEffects;
		base.screenMotionBlur = e.motionBlur ? 1 : 0;

		base.timeline = {
			segments: [{ recordingSegment: 0, timescale: 1, start: 0, end: duration }],
			zoomSegments: (e.zooms ?? []).map((z) => ({
				start: z.startSec,
				end: z.endSec,
				amount: z.scale,
				mode: { manual: { x: z.focus.x, y: z.focus.y } },
			})),
			sceneSegments: [],
			maskSegments: [],
			textSegments: [],
			captionSegments: [],
			keyboardSegments: [],
			audioSegments: [],
			camera3dSegments: [],
		};

		// `config set` takes the whole document as one argv string and resets anything omitted,
		// which is why the defaults were read first rather than a partial patch being sent.
		execFileSync(
			CLI,
			["project", "config", "set", project, "--settings-json", JSON.stringify(base)],
			{
				encoding: "utf8",
				maxBuffer: 16 * 1024 * 1024,
			},
		);
		// Keep a copy beside the project so a run is auditable after the fact.
		writeFileSync(
			join(dir, `${ctx.scenario.id}-config.json`),
			`${JSON.stringify(base, null, 2)}\n`,
		);

		const verify = JSON.parse(
			execFileSync(CLI, ["project", "config", "get", project], { encoding: "utf8" }),
		);
		const applied = ["targetResolution", "targetFps"];
		if (verify.background?.source?.type === "color") applied.push("background");
		if (verify.background?.padding > 0) applied.push("padding");
		if (verify.background?.rounding > 0) applied.push("cornerRadius");
		if (verify.background?.shadow > 0) applied.push("shadow");
		if (
			(verify.timeline?.zoomSegments ?? []).length === (e.zooms ?? []).length &&
			e.zooms?.length
		) {
			applied.push("zooms");
		}

		ctx.state.projectPath = project;
		return {
			appliedFeatures: applied,
			notes: [
				`project: ${project}`,
				`zoom segments written: ${(verify.timeline?.zoomSegments ?? []).length}`,
			],
		};
	},

	outputPath(ctx) {
		return join(ctx.outDir, `${this.id}-${ctx.scenario.id}-run${ctx.run.index}.mp4`);
	},

	async runExport(ctx) {
		const out = this.outputPath(ctx);
		if (existsSync(out)) rmSync(out);
		const t = ctx.scenario.output;

		const args = [
			"export",
			ctx.state.projectPath,
			"--output",
			out,
			"--format",
			"mp4",
			"--fps",
			String(t.fps),
			"--resolution",
			`${t.width}x${t.height}`,
			"--quality",
			"maximum",
			"--progress-json",
		];

		return new Promise((resolve, reject) => {
			const child = spawn(CLI, args, { stdio: ["ignore", "pipe", "pipe"] });
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
					// First Progress event = the renderer is live. Same rule as the OpenScreen
					// driver: process start-up is warm-up, rendering is the measurement.
					if (!committed && (ev.type === "Progress" || ev.type === "Completed")) {
						committed = true;
						ctx.commit();
					}
					if (ev.type === "Error") stderrTail += `\n${ev.error}`;
				}
			});
			child.stderr.on("data", (d) => {
				stderrTail = (stderrTail + d.toString()).slice(-2000);
			});
			child.on("error", reject);
			child.on("close", (code) => {
				if (!committed) ctx.commit();
				if (code === 0) resolve();
				else reject(new Error(`cap export exited ${code}: ${stderrTail.trim().slice(0, 600)}`));
			});
		});
	},

	async cleanup() {
		// Nothing to tear down: `cap export` is a one-shot process.
	},
};
