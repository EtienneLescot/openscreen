/**
 * Not a competitor — the floor.
 *
 * A straight re-encode of the source at the target settings, with no compositing at all. It
 * answers the question the app-to-app numbers cannot: how much of an export is unavoidable
 * encoding work on this machine, and how much is the app's own pipeline. Every app's time
 * should be read as a multiple of this.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { resolveFfmpeg } from "../lib/env.mjs";

export default {
	id: "ffmpeg-baseline",
	displayName: "ffmpeg (re-encode floor)",
	vendor: "reference",
	kind: "reference",
	automation: "cli",
	processName: null,
	appPath: null,
	bundleId: null,
	install: null,

	detect() {
		try {
			const { ffmpeg, source } = resolveFfmpeg();
			return { installed: true, version: source, path: ffmpeg };
		} catch (e) {
			return { installed: false, version: null, path: null, error: e.message };
		}
	},

	async prepare() {
		return {
			// The floor deliberately applies nothing. Listing the two output features it *does*
			// honour keeps the fidelity score honest rather than showing a bare zero.
			appliedFeatures: ["targetResolution", "targetFps"],
			notes: ["No compositing: this row is the encode-only reference, not a product."],
		};
	},

	outputPath(ctx) {
		return join(ctx.outDir, `${this.id}-${ctx.scenario.id}-run${ctx.run.index}.mp4`);
	},

	async runExport(ctx) {
		const { ffmpeg } = resolveFfmpeg();
		const out = this.outputPath(ctx);
		const t = ctx.scenario.output;

		const args = [
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-i",
			ctx.source.path,
			"-vf",
			`scale=${t.width}:${t.height}:flags=bicubic,format=yuv420p`,
			"-r",
			String(t.fps),
			"-c:v",
			"h264_videotoolbox",
			"-b:v",
			"20M",
			"-profile:v",
			"high",
			"-c:a",
			"aac",
			"-b:a",
			"128k",
			"-movflags",
			"+faststart",
			out,
		];

		return new Promise((resolve, reject) => {
			const child = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
			let stderr = "";
			child.stderr.on("data", (d) => {
				stderr += d.toString();
			});
			// The process is the export: commit the instant it is live.
			ctx.commit();
			child.on("error", reject);
			child.on("close", (code) => {
				if (code === 0) resolve();
				else reject(new Error(`ffmpeg exited ${code}: ${stderr.trim().slice(0, 500)}`));
			});
		});
	},

	async cleanup() {
		// Nothing to tear down: the floor spawns one ffmpeg and it exits.
	},
};
