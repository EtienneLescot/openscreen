#!/usr/bin/env node
/**
 * Export bench runner: one command, real pipeline, numbers on stdout.
 *
 *   npm run bench:export -- --project=os_parity --arms=webcodecs,native --runs=3
 *
 * Drives the app's own export path (see src/bench/runBench.ts) inside a real
 * Electron window, so the GPU, the sandbox, the preload and the main-process
 * ffmpeg are all the ones we ship. It exists because driving this through the
 * UI cost ~5 minutes a run and kept injecting confounds.
 *
 * Assumes a vite dev server is already up (npm run dev with NO_ELECTRON=1).
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEV_URL = process.env.VITE_DEV_SERVER_URL ?? "http://localhost:5199/";

function parseArgs(argv) {
	const out = {};
	for (const arg of argv) {
		const m = /^--([^=]+)=(.*)$/.exec(arg);
		if (m) out[m[1]] = m[2];
	}
	return out;
}

/**
 * A leftover lock DIRECTORY is stale and safe to remove. A leftover PROCESS is
 * not: it holds the real single-instance lock, and the bench launch then exits 0
 * having done nothing — a silent no-op that looks like a bench bug. Detect it
 * and say so rather than deleting someone's running app.
 */
function checkSingleInstance() {
	const lock = path.join(os.tmpdir(), `openscreen-single-instance-${os.userInfo().username}.lock`);
	// Both names matter: the dev build runs as electron.exe, the INSTALLED app as
	// openscreen.exe, and they share one userData — so one lock. Checking only
	// electron.exe let the installed app hold it while the bench launched, exited
	// 0 and reported nothing, with no log line to say why.
	for (const image of ["electron.exe", "openscreen.exe"]) {
		const running = spawnSync("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/NH"], {
			encoding: "utf8",
		});
		if (running.stdout?.includes(image)) {
			throw new Error(
				`${image} is already running and holds the single-instance lock;\n` +
					"the bench would launch, exit 0 and report nothing. Close the app first.",
			);
		}
	}
	if (existsSync(lock)) rmSync(lock, { recursive: true, force: true });
}

/**
 * Refuse to run against a main bundle older than its sources.
 *
 * vite-plugin-electron rebuilds dist-electron asynchronously, so launching too
 * soon after an edit runs the PREVIOUS main process against the new renderer.
 * This has cost two full debugging detours already: once the export IPC was
 * "not registered" (main predated the handler), once the bench flag did nothing
 * and the app opened its normal HUD instead. Both looked like code bugs. A
 * stale bundle must be a loud error, never a silently different measurement.
 */
function assertFreshMainBundle() {
	const stub = path.join(ROOT, "dist-electron", "main.js");
	if (!existsSync(stub)) throw new Error("dist-electron/main.js missing — start the dev server.");
	const chunkName = /from "\.\/(main-[^"]+)"/.exec(readFileSync(stub, "utf8"))?.[1];
	const chunk = chunkName && path.join(ROOT, "dist-electron", chunkName);
	if (!chunk || !existsSync(chunk)) throw new Error("Cannot resolve the built main chunk.");
	const builtAt = statSync(chunk).mtimeMs;

	let newest = 0;
	let newestFile = "";
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name !== "node_modules") walk(full);
			} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
				const m = statSync(full).mtimeMs;
				if (m > newest) {
					newest = m;
					newestFile = path.relative(ROOT, full);
				}
			}
		}
	};
	walk(path.join(ROOT, "electron"));

	if (newest > builtAt) {
		const lag = Math.round((newest - builtAt) / 1000);
		throw new Error(
			`Main bundle is STALE: ${newestFile} changed ${lag}s after ${chunkName} was built.\n` +
				"The bench would measure the previous main process. Let vite finish rebuilding\n" +
				"(watch the dev-server log for 'build started' -> done), then re-run.",
		);
	}
}

/** A dead dev server yields a blank window and a bench that reports nothing. */
async function assertViteUp() {
	try {
		const res = await fetch(DEV_URL, { method: "GET" });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
	} catch (error) {
		throw new Error(
			`No vite dev server at ${DEV_URL} (${error.message}).\n` +
				"Start it with NO_ELECTRON=1 (see .claude/launch.json 'vite-dev').",
		);
	}
}

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Spread across an arm's repeats, as a fraction of the median.
 *
 * This is the gate, not a decoration: on this machine two identical runs came
 * out 26% apart while the battery charged, which was enough to invert the
 * comparison. If spread is anywhere near the gap between arms, the run says
 * nothing and must be repeated in a steadier state.
 */
function spread(values) {
	if (values.length < 2) return 0;
	const m = median(values);
	return m === 0 ? 0 : (Math.max(...values) - Math.min(...values)) / m;
}

function report(results) {
	const arms = [...new Set(results.map((r) => r.arm))];
	const failed = results.filter((r) => !r.ok);
	for (const f of failed) console.log(`  FAILED  ${f.arm} run ${f.run}: ${f.error}`);

	const rows = [];
	for (const arm of arms) {
		const runs = results.filter((r) => r.arm === arm && r.ok);
		if (runs.length === 0) continue;
		const walls = runs.map((r) => r.wallMs);
		rows.push({
			arm,
			runs: runs.length,
			wallMs: Math.round(median(walls)),
			fps: +median(runs.map((r) => r.fps)).toFixed(1),
			spread: `${(spread(walls) * 100).toFixed(0)}%`,
			frames: runs[0].frames,
			raw: walls.map((w) => Math.round(w)).join(" / "),
		});
	}
	console.log("\n=== export bench ===");
	console.table(rows);

	const stageKeys = [...new Set(results.flatMap((r) => Object.keys(r.stages ?? {})))];
	const stageRows = stageKeys.map((stage) => {
		const row = { stage };
		for (const arm of arms) {
			const runs = results.filter((r) => r.arm === arm && r.ok && r.stages?.[stage] != null);
			if (runs.length) row[arm] = `${Math.round(median(runs.map((r) => r.stages[stage])))}ms`;
		}
		return row;
	});
	if (stageRows.length) {
		console.log("stage totals (median):");
		console.table(stageRows);
	}

	const worst = Math.max(...rows.map((r) => Number.parseFloat(r.spread)));
	if (worst >= 10) {
		console.log(
			`\n!! Same-arm spread reaches ${worst.toFixed(0)}% — larger than most effects worth\n` +
				"   measuring. Treat this run as VOID and repeat on a steady machine.",
		);
	}
	return { rows, worst };
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const query = new URLSearchParams({
		...(args.project ? { project: args.project } : {}),
		...(args.effects ? { effects: args.effects } : {}),
		arms: args.arms ?? "webcodecs,native",
		runs: args.runs ?? "2",
		fps: args.fps ?? "60",
		quality: args.quality ?? "1080p",
	}).toString();

	// Every guard here exists because its absence already produced a confident,
	// wrong answer at least once.
	checkSingleInstance();
	await assertViteUp();
	assertFreshMainBundle();

	const electron = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
	if (!existsSync(electron)) throw new Error(`Electron not found at ${electron}`);

	console.log(`bench: ${query}\nvite:  ${DEV_URL}`);
	const child = spawn(electron, [".", `--bench=${query}`], {
		cwd: ROOT,
		env: { ...process.env, VITE_DEV_SERVER_URL: DEV_URL },
		stdio: ["ignore", "pipe", "pipe"],
	});

	const results = [];
	let fatal = null;
	let buffer = "";
	// The app's own stdout/stderr, kept so a failure can show WHY. Dropping it
	// once cost a long detour: listProjects was warning that it had skipped the
	// very project being benched, and the runner threw that line away.
	const appLog = [];
	const consume = (chunk) => {
		buffer += chunk;
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			const m = /\[bench\] (\{.*\})\s*$/.exec(line);
			if (!m) {
				if (line.trim()) appLog.push(line);
				// Configuration the exporter reports about itself (which encoder, what
				// the canvas actually granted). Always shown: an arm that silently
				// no-ops must not be mistaken for an arm that was tested and lost.
				const note = /\[export perf\] (canvas .*|native encode .*|shadow .*)$/.exec(line);
				if (note) console.log(`    · ${note[1]}`);
				continue;
			}
			let event;
			try {
				event = JSON.parse(m[1]);
			} catch {
				continue; // A truncated line is not worth killing the run over.
			}
			if (event.event === "run") {
				results.push(event);
				const status = event.ok
					? `${Math.round(event.wallMs)}ms · ${event.frames}f · ${event.fps.toFixed(1)}fps`
					: `FAILED: ${event.error}`;
				console.log(`  ${event.arm} run ${event.run}: ${status}`);
			} else if (event.event === "fatal") {
				fatal = event.error;
			} else if (event.event === "start") {
				console.log(`  project: ${event.project}`);
				console.log(`  effects: ${event.effects}`);
				console.log(`  arms: ${event.arms.join(", ")} x${event.runs}\n`);
			}
		}
	};
	child.stdout.on("data", (c) => consume(String(c)));
	child.stderr.on("data", (c) => consume(String(c)));

	const code = await new Promise((resolve) => child.on("close", resolve));
	const dumpAppLog = () => {
		const noise = /Electron Security Warning|DevTools|deprecat/i;
		const interesting = appLog.filter((l) => !noise.test(l));
		if (interesting.length) {
			console.error("\n--- app output (tail) ---");
			for (const line of interesting.slice(-25)) console.error(`  ${line}`);
		}
	};
	if (fatal) {
		console.error(`\nbench failed: ${fatal}`);
		dumpAppLog();
		process.exit(1);
	}
	if (results.length === 0) {
		console.error(`\nbench produced no results (electron exited ${code}).`);
		dumpAppLog();
		process.exit(1);
	}
	report(results);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
