#!/usr/bin/env node
/**
 * openscreen export benchmark — entrypoint.
 *
 *   node benchmark/bench.mjs preflight        # one interactive gate, then walk away
 *   node benchmark/bench.mjs install
 *   node benchmark/bench.mjs run
 *   node benchmark/bench.mjs status --json    # safe to poll from anywhere, incl. a remote session
 *   node benchmark/bench.mjs report
 *
 * See benchmark/README.md for the methodology and benchmark/REMOTE.md for driving it from a
 * dispatched Claude Code session.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APPS, DEFAULT_APPS, installPlan, loadDriver } from "./apps.mjs";
import {
	CALIBRATION_PATH,
	calibrateApp,
	calibrationFixture,
	loadCalibration,
	saveCalibration,
} from "./lib/calibrate.mjs";
import {
	CACHE_DIR,
	diskState,
	ensureWorkDirs,
	ffmpegVersion,
	machineFingerprint,
	powerState,
	RESULTS_DIR,
	WORK_DIR,
} from "./lib/env.mjs";
import { buildFixture, DEFAULT_SPEC, fixturePath, probe, sha256 } from "./lib/fixture.mjs";
import { installApp } from "./lib/install.mjs";
import {
	accessibilityGranted,
	pendingPermissionDialog,
	primeAutomation,
} from "./lib/permissions.mjs";
import { renderReport } from "./lib/report.mjs";
import { preconditionCheck, runApp } from "./lib/runner.mjs";
import { newRunId, RunState } from "./lib/state.mjs";
import {
	appIsRunning,
	describeWindow,
	dumpMenus,
	hasScriptingDictionary,
	launchApp,
} from "./lib/uiScript.mjs";
import { DEFAULT_SCENARIO, getScenario } from "./scenarios/index.mjs";

/* ------------------------------------------------------------------------- argv ---------- */

function parseArgs(argv) {
	const [command = "help", ...rest] = argv;
	const flags = {};
	const positional = [];
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (a.startsWith("--")) {
			const [k, inline] = a.slice(2).split("=");
			if (inline !== undefined) flags[k] = inline;
			else if (rest[i + 1] && !rest[i + 1].startsWith("--")) flags[k] = rest[++i];
			else flags[k] = true;
		} else positional.push(a);
	}
	return { command, flags, positional };
}

const log = (...a) => console.log(...a);
const listFlag = (v, fallback) =>
	typeof v === "string"
		? v
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean)
		: fallback;

/* ---------------------------------------------------------------------- commands --------- */

async function cmdDoctor() {
	ensureWorkDirs();
	const fp = machineFingerprint();
	const pre = preconditionCheck();
	let ff = null;
	try {
		ff = ffmpegVersion();
	} catch (e) {
		ff = { banner: `MISSING — ${e.message}`, source: null };
	}
	log("Machine");
	log(
		`  ${fp.chip} · ${fp.cpuCount} cores (${fp.performanceCores}P/${fp.efficiencyCores}E) · ${fp.memoryGiB} GiB`,
	);
	log(`  ${fp.osProduct} ${fp.osVersion} (${fp.osBuild}) · node ${fp.nodeVersion}`);
	for (const d of fp.displays) log(`  ${d}`);
	log("\nPreconditions");
	log(`  ${pre.ok ? "✓ ready" : `✗ ${pre.problems.join("; ")}`}`);
	log(`  disk: ${pre.disk.availableGiB} GiB free at ${pre.disk.path}`);
	log(`\nffmpeg\n  ${ff.banner}\n  source: ${ff.source}`);
	log("\nApps");
	for (const id of DEFAULT_APPS) {
		let driver;
		try {
			driver = await loadDriver(id);
		} catch (e) {
			log(`  ! ${id.padEnd(26)} driver not available: ${e.message.split("\n")[0]}`);
			continue;
		}
		const d = driver.detect();
		const dict = driver.appPath ? hasScriptingDictionary(driver.appPath) : false;
		log(
			`  ${d.installed ? "✓" : "·"} ${driver.displayName.padEnd(26)} ${(d.version ?? "").padEnd(14)}` +
				` automation=${driver.automation}${dict ? " (has AppleScript dictionary)" : ""}`,
		);
	}
}

async function cmdPreflight({ flags }) {
	ensureWorkDirs();
	const apps = listFlag(flags.apps, DEFAULT_APPS);
	const plan = installPlan(apps);

	log("═══ Preflight ═══\n");
	await cmdDoctor();

	/* ---------------------------------------------------------------- downloads --------- */
	const missing = plan.filter((m) => !existsSync(join("/Applications", m.appName)));
	log("\nDownloads needed");
	if (!missing.length) log("  (none — every app is already installed)");
	for (const m of missing) {
		log(`  ${m.appName.padEnd(22)} ~${m.approxMB} MB   ${m.licence}`);
		log(`     ${m.url ?? m.repo}`);
		for (const n of m.notes ?? []) log(`     note: ${n}`);
	}
	const totalMB = missing.reduce((s, m) => s + (m.approxMB ?? 0), 0);
	if (totalMB) log(`  total ≈ ${totalMB} MB  —  run \`bench.mjs install\` to fetch them`);

	/* -------------------------------------------------------------- permissions --------- */
	log("\nPermissions");
	if (!accessibilityGranted()) {
		log("  ✗ Accessibility is NOT granted to the process running this script.");
		log("    Without it System Events refuses every menu click and no GUI app can be driven.");
		log("    Grant it in System Settings → Privacy & Security → Accessibility, then re-run.");
	} else {
		log(
			"  ✓ Accessibility — System Events responds, so menus and the accessibility tree are reachable.",
		);
	}
	log(
		"  · Screen Recording is NOT needed: the benchmark never records, it imports a generated clip.",
	);

	// Every app gets one harmless scripted question. The first raises the macOS prompt and
	// blocks until answered; later ones are silent. Doing this here is the whole point of
	// preflight — it moves six mid-run ambushes into one sitting.
	const drivers = [];
	for (const id of apps) {
		try {
			drivers.push(await loadDriver(id));
		} catch {
			/* a driver that will not load is reported by doctor */
		}
	}
	const needPrompt = drivers.filter((d) => d.bundleId && d.appPath && existsSync(d.appPath));
	if (needPrompt.length) {
		log(`\n  Provoking the Apple Events prompt for ${needPrompt.length} app(s).`);
		log("  Each will raise a “… wants access to control …” dialog. Click Allow on every one —");
		log("  these are security settings, so nothing here can accept them for you.\n");
	}
	const permissions = [];
	for (const d of needPrompt) {
		process.stdout.write(`  ${d.displayName.padEnd(24)} `);
		const r = primeAutomation(d.bundleId);
		permissions.push({ app: d.displayName, ...r });
		log(
			r.status === "granted"
				? "✓ granted"
				: r.status === "denied"
					? "✗ DENIED — this app cannot be driven"
					: `… ${r.status}`,
		);
		const pending = pendingPermissionDialog();
		if (pending) log(`     still waiting on: ${pending.slice(0, 90)}…`);
	}

	/* ------------------------------------------------------- first-launch dialogs ------- */
	if (flags.launch) {
		log("\nOpening each GUI app once so its first-launch dialogs can be cleared.");
		log("Dismiss onboarding, consent and update prompts now — after this the run is unattended.\n");
		for (const d of drivers) {
			if (d.kind !== "gui" || !d.appPath || !existsSync(d.appPath)) continue;
			log(`  → ${d.displayName}`);
			try {
				await launchApp(d.appPath, d.processName);
			} catch (e) {
				log(`     could not launch: ${e.message.split("\n")[0]}`);
			}
		}
	} else {
		log(
			"\nRe-run with --launch to also open each GUI app once and clear its first-launch dialogs.",
		);
	}

	const denied = permissions.filter((p) => p.status === "denied");
	const status = {
		generatedAt: new Date().toISOString(),
		apps,
		missingInstalls: missing.map((m) => m.appName),
		totalDownloadMB: totalMB,
		accessibility: accessibilityGranted(),
		permissions,
		machine: machineFingerprint(),
		preconditions: preconditionCheck(),
	};
	mkdirSync(RESULTS_DIR, { recursive: true });
	writeFileSync(join(RESULTS_DIR, "preflight.json"), `${JSON.stringify(status, null, 2)}\n`);

	log("\n─────────────────────────────────────────");
	if (denied.length)
		log(`⚠ ${denied.length} app(s) denied automation: ${denied.map((d) => d.app).join(", ")}`);
	if (missing.length) log(`Next: node benchmark/bench.mjs install`);
	else log("Next: node benchmark/bench.mjs calibrate && node benchmark/bench.mjs run");
	log(`preflight complete — written to ${join(RESULTS_DIR, "preflight.json")}`);
}

async function cmdInstall({ flags }) {
	ensureWorkDirs();
	const apps = listFlag(flags.apps, DEFAULT_APPS);
	const plan = installPlan(apps);
	const cacheDir = join(WORK_DIR, "installers");
	const records = [];
	for (const spec of plan) {
		log(`${spec.appName}`);
		try {
			const rec = installApp(spec, { cacheDir, force: !!flags.force, log });
			records.push(rec);
			log(
				`  ${rec.status} — ${rec.version ?? "?"} — gatekeeper: ${rec.codesign.accepted ? "accepted" : "REJECTED"}`,
			);
		} catch (e) {
			records.push({ id: spec.id, status: "failed", error: e.message });
			log(`  ✗ ${e.message}`);
		}
	}
	writeFileSync(join(RESULTS_DIR, "install.json"), `${JSON.stringify(records, null, 2)}\n`);
	log(`\nWritten: ${join(RESULTS_DIR, "install.json")}`);
}

async function cmdFixture({ flags }) {
	ensureWorkDirs();
	const spec = { ...DEFAULT_SPEC };
	if (flags.duration) spec.durationSec = Number(flags.duration);
	if (flags.fps) spec.fps = Number(flags.fps);
	const r = buildFixture(WORK_DIR, spec, { force: !!flags.force, log });
	log(`\n${r.path}`);
	log(`  sha256 ${r.sha256}`);
	log(`  ${JSON.stringify(r.probe.video)}  ${(r.probe.sizeBytes / 1048576).toFixed(1)} MB`);
}

async function cmdRun({ flags }) {
	ensureWorkDirs();
	const apps = listFlag(flags.apps, DEFAULT_APPS);
	const scenario = getScenario(flags.scenario ?? DEFAULT_SCENARIO);
	const repetitions = Number(flags.reps ?? 3);
	const cooldownSec = Number(flags.cooldown ?? 45);
	const discardFirst = flags["no-warmup"] ? false : true;

	const spec = { ...DEFAULT_SPEC };
	const fixture = existsSync(fixturePath(WORK_DIR, spec))
		? {
				path: fixturePath(WORK_DIR, spec),
				probe: probe(fixturePath(WORK_DIR, spec)),
				sha256: sha256(fixturePath(WORK_DIR, spec)),
				spec,
			}
		: buildFixture(WORK_DIR, spec, { log });

	const calibration = loadCalibration();
	if (calibration.machine) {
		const here = machineFingerprint();
		if (
			calibration.machine.chip !== here.chip ||
			calibration.machine.osVersion !== here.osVersion
		) {
			log(
				`⚠ benchmark/calibration.json was solved on ${calibration.machine.chip} / macOS ${calibration.machine.osVersion}, ` +
					`not this machine. Re-run \`bench.mjs calibrate\` — app versions differ between machines and ` +
					`a stale padding solve makes the apps composite different rectangles.\n`,
			);
		}
	} else if (Object.keys(calibration.apps ?? {}).length) {
		log("⚠ benchmark/calibration.json has no machine stamp; re-run `bench.mjs calibrate`.\n");
	} else {
		log("· no calibration found — each driver will use its documented default padding.\n");
	}
	const runId = flags.id ?? newRunId();
	const state = new RunState(join(RESULTS_DIR, runId), runId);
	const outDir = join(WORK_DIR, "out", runId);
	mkdirSync(outDir, { recursive: true });

	const header = {
		runId,
		startedAt: new Date().toISOString(),
		scenario: {
			id: scenario.id,
			label: scenario.label,
			effects: scenario.effects,
			output: scenario.output,
		},
		repetitions,
		discardFirst,
		cooldownSec,
		machine: machineFingerprint(),
		power: powerState(),
		disk: diskState(),
		ffmpeg: (() => {
			try {
				return ffmpegVersion();
			} catch {
				return null;
			}
		})(),
		fixture: {
			path: fixture.path,
			sha256: fixture.sha256,
			spec: fixture.spec,
			probe: fixture.probe,
		},
		calibration: calibration.apps
			? {
					generatedAt: calibration.generatedAt,
					targetInsetPercent: calibration.targetInsetPercent,
					apps: calibration.apps,
				}
			: null,
		apps,
	};
	state.event("run-started", header);
	state.writeStatus({ ...header, phase: "starting", completed: [], pending: apps });

	log(
		`run ${runId} · scenario "${scenario.id}" · ${repetitions}×${discardFirst ? " (+1 warm-up)" : ""}`,
	);
	log(`fixture ${fixture.path} (${fixture.sha256.slice(0, 12)})\n`);

	// Re-running one app into an existing run id is the documented way to pick up after a
	// failure (see REMOTE.md). Without this it silently discarded everything already measured.
	const prior = flags.append ? (state.readResults()?.results ?? []) : [];
	if (prior.length) log(`appending to ${prior.length} existing app result(s) in ${runId}\n`);
	const results = prior.filter((r) => !apps.includes(r.app));
	for (const [i, id] of apps.entries()) {
		let driver;
		try {
			driver = await loadDriver(id);
		} catch (e) {
			const rec = {
				app: id,
				skipped: true,
				reason: `driver failed to load: ${e.message}`,
				runs: [],
			};
			results.push(rec);
			state.event("app-skipped", rec);
			continue;
		}

		state.writeStatus({
			...header,
			phase: "running",
			current: { app: id, index: i + 1, of: apps.length },
			completed: results.map((r) => r.app),
			pending: apps.slice(i + 1),
		});

		const calibrated = calibration.apps?.[id]?.paddingControl ?? null;
		const baseCtx = {
			workDir: WORK_DIR,
			outDir,
			scenario,
			source: fixture,
			log,
			state,
			paddingControl: calibrated,
		};
		let rec;
		try {
			rec = await runApp(driver, baseCtx, { repetitions, discardFirst, cooldownSec, log });
		} catch (e) {
			rec = {
				app: id,
				displayName: driver.displayName,
				skipped: true,
				reason: `crashed: ${e.message}`,
				runs: [],
			};
			log(`  ✗ ${driver.displayName}: ${e.message}`);
		}
		results.push(rec);
		state.event("app-finished", rec);
		state.writeResults({ ...header, finishedAt: null, results });
	}

	// Closing control. A long run heat-soaks the SoC and the background load drifts, so an app
	// measured last is not measured under the same conditions as one measured first. Re-running
	// the floor at the end quantifies that drift instead of leaving it as an unstated caveat: if
	// the opening and closing controls agree, the ordering did not matter; if they do not, the
	// report says by how much.
	if (!flags["no-control"] && apps.includes("ffmpeg-baseline") && results.length > 1) {
		log("\nclosing control: re-running the floor to measure drift over the run");
		const driver = await loadDriver("ffmpeg-baseline");
		const baseCtx = { workDir: WORK_DIR, outDir, scenario, source: fixture, log, state: {} };
		try {
			const rec = await runApp(driver, baseCtx, {
				repetitions: 2,
				discardFirst: false,
				cooldownSec,
				log,
			});
			rec.app = "ffmpeg-baseline-close";
			rec.displayName = "ffmpeg floor (closing control)";
			rec.isControl = true;
			results.push(rec);
			state.event("app-finished", rec);
		} catch (e) {
			log(`  closing control failed: ${e.message}`);
		}
	}

	const final = { ...header, finishedAt: new Date().toISOString(), results };
	state.writeResults(final);
	state.writeStatus({ ...final, phase: "done", completed: results.map((r) => r.app), pending: [] });
	state.event("run-finished", { apps: results.map((r) => r.app) });

	const report = renderReport(final);
	writeFileSync(join(state.dir, "report.md"), report.markdown);
	writeFileSync(join(state.dir, "report.html"), report.html);
	log(`\n${report.summaryText}`);
	log(`\nResults: ${state.dir}`);
}

/**
 * Solve each app's padding control so they all composite the same rectangle. Run once per
 * machine (and again after an app updates); the result is written to benchmark/calibration.json
 * and read automatically by `run`.
 */
async function cmdCalibrate({ flags }) {
	ensureWorkDirs();
	const apps = listFlag(flags.apps, DEFAULT_APPS);
	const scenario = getScenario(flags.scenario ?? DEFAULT_SCENARIO);
	const fixture = calibrationFixture(WORK_DIR, log);
	const outDir = join(WORK_DIR, "out", "calibration");
	mkdirSync(outDir, { recursive: true });
	log(
		`calibrating padding against a ${fixture.spec.durationSec}s clip; target inset ${scenario.effects.paddingPercent}% of the short side\n`,
	);

	const entries = [];
	for (const id of apps) {
		let driver;
		try {
			driver = await loadDriver(id);
		} catch {
			continue;
		}
		if (!driver.detect().installed) {
			log(`${driver.displayName}: not installed, skipping`);
			continue;
		}
		if (typeof driver.defaultPaddingControl !== "function") {
			log(`${driver.displayName}: no padding control to calibrate`);
			entries.push({ app: id, paddingControl: null, reason: "driver exposes no padding control" });
			continue;
		}
		log(`${driver.displayName}:`);
		const ctx = {
			workDir: WORK_DIR,
			outDir,
			scenario,
			source: fixture,
			log,
			state: {},
			run: { index: 0 },
			commit: () => undefined,
		};
		try {
			const r = await calibrateApp(driver, ctx, { log });
			entries.push(r);
			log(
				`  -> padding=${r.paddingControl} gives ${r.achievedInsetPercent}%${r.withinTolerance ? "" : "  (best available; outside tolerance)"}`,
			);
		} catch (e) {
			log(`  x ${e.message}`);
			entries.push({ app: id, paddingControl: null, error: e.message?.slice(0, 400) });
		}
		try {
			await driver.cleanup(ctx);
		} catch {
			/* best effort */
		}
	}

	const path = saveCalibration(entries, {
		scenario: scenario.id,
		targetInsetPercent: scenario.effects.paddingPercent,
		fixture: { spec: fixture.spec, sha256: fixture.sha256 },
	});
	log(`\nWritten: ${path}`);
}

async function cmdStatus({ flags }) {
	const runs = existsSync(RESULTS_DIR)
		? readFileSync
			? (await import("node:fs"))
					.readdirSync(RESULTS_DIR)
					.filter((d) => /^\d{8}T/.test(d))
					.sort()
			: []
		: [];
	const runId = flags.run ?? runs[runs.length - 1];
	if (!runId) {
		const out = { phase: "no-runs" };
		log(flags.json ? JSON.stringify(out) : "No runs yet.");
		return;
	}
	const state = new RunState(join(RESULTS_DIR, runId), runId);
	const status = state.readStatus();
	if (flags.json) {
		log(JSON.stringify(status ?? { runId, phase: "unknown" }, null, 2));
		return;
	}
	if (!status) return log(`Run ${runId}: no status file.`);
	log(`Run ${runId} — ${status.phase}`);
	if (status.current)
		log(`  current: ${status.current.app} (${status.current.index}/${status.current.of})`);
	log(`  done: ${(status.completed ?? []).join(", ") || "none"}`);
	log(`  left: ${(status.pending ?? []).join(", ") || "none"}`);
}

async function cmdReport({ flags }) {
	const fs = await import("node:fs");
	const runs = fs.existsSync(RESULTS_DIR)
		? fs
				.readdirSync(RESULTS_DIR)
				.filter((d) => /^\d{8}T/.test(d))
				.sort()
		: [];
	const runId = flags.run ?? runs[runs.length - 1];
	if (!runId) return log("No runs to report on.");
	const state = new RunState(join(RESULTS_DIR, runId), runId);
	const results = state.readResults();
	if (!results) return log(`Run ${runId} has no results.json yet.`);
	const report = renderReport(results);
	fs.writeFileSync(join(state.dir, "report.md"), report.markdown);
	fs.writeFileSync(join(state.dir, "report.html"), report.html);
	log(report.markdown);
	log(`\nWritten: ${join(state.dir, "report.md")} and report.html`);
}

/** Dump an app's menus and accessibility tree — how a GUI driver gets written or repaired. */
async function cmdDiscover({ positional, flags }) {
	const id = positional[0];
	if (!id) return log("usage: bench.mjs discover <app-id> [--window N] [--depth N]");
	const driver = await loadDriver(id);
	if (!driver.appPath) return log(`${id} has no app bundle.`);
	if (!existsSync(driver.appPath)) return log(`${driver.appPath} is not installed.`);

	log(`# ${driver.displayName}`);
	log(`bundle: ${driver.appPath}`);
	log(`AppleScript dictionary: ${hasScriptingDictionary(driver.appPath) ? "YES" : "no"}`);
	if (!appIsRunning(driver.processName)) {
		log(`launching ${driver.processName}…`);
		await launchApp(driver.appPath, driver.processName);
		await new Promise((r) => setTimeout(r, 4000));
	}
	log("\n## Menus");
	log(JSON.stringify(dumpMenus(driver.processName), null, 1));
	log("\n## Window accessibility tree");
	try {
		log(describeWindow(driver.processName, Number(flags.window ?? 1), Number(flags.depth ?? 4)));
	} catch (e) {
		log(`(could not read window: ${e.message})`);
	}
}

function cmdHelp() {
	log(`openscreen export benchmark

  doctor                    environment + installed apps + whether UI scripting works
  preflight [--launch]      the single interactive gate: what will be downloaded, what to grant
  install   [--apps a,b] [--force]
  calibrate [--apps a,b]    solve each app's padding control so they composite the same rect
  fixture   [--force] [--duration s] [--fps n]
  run       [--apps a,b] [--scenario id] [--reps 3] [--cooldown 45] [--no-warmup] [--id NAME]
            [--append]  merge into an existing run id instead of replacing it
            [--no-control]  skip the closing drift control
  status    [--run ID] [--json]
  report    [--run ID]
  discover  <app-id>        dump menus + accessibility tree (for writing a GUI driver)

apps: ${Object.keys(APPS).join(", ")}`);
}

const { command, flags, positional } = parseArgs(process.argv.slice(2));
const commands = {
	doctor: cmdDoctor,
	preflight: cmdPreflight,
	install: cmdInstall,
	fixture: cmdFixture,
	run: cmdRun,
	status: cmdStatus,
	calibrate: cmdCalibrate,
	report: cmdReport,
	discover: cmdDiscover,
	help: cmdHelp,
};
const fn = commands[command] ?? cmdHelp;
try {
	await fn({ flags, positional });
} catch (e) {
	console.error(`\n✗ ${e.stack ?? e.message}`);
	process.exit(1);
}
