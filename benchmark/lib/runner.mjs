/**
 * The stopwatch, shared by every driver.
 *
 * Keeping this in one place is what makes the comparison defensible: the CLI apps and the GUI
 * apps are timed by the same code, completion is decided the same way, and every output is
 * verified against the same target before it is allowed to count.
 */
import { existsSync, rmSync } from "node:fs";
import { fidelity } from "../scenarios/index.mjs";
import { diskState, machineFingerprint, powerState } from "./env.mjs";
import {
	cooldown,
	cpuDelta,
	now,
	ProcessTreeSampler,
	sleep,
	verifyOutput,
	waitForStableFile,
} from "./measure.mjs";
import { instantaneousLoadPercent } from "./platform.mjs";
import { inspectExport } from "./visualCheck.mjs";

/** Refuse to measure on a machine that is already compromised — the number would be noise. */
export function preconditionCheck({ requireAC = true, minDiskGiB = 20 } = {}) {
	const power = powerState();
	const disk = diskState();
	const problems = [];
	if (requireAC && !power.onACPower) problems.push("running on battery — the SoC is power-capped");
	if (power.lowPowerMode) problems.push("Low Power Mode is on");
	if (power.cpuSpeedLimit != null && power.cpuSpeedLimit < 100) {
		problems.push(`CPU is thermally limited to ${power.cpuSpeedLimit}%`);
	}
	if (disk.availableGiB < minDiskGiB) {
		problems.push(`only ${disk.availableGiB} GiB free (need ${minDiskGiB})`);
	}
	// Competing load is the one precondition that does not announce itself: nothing throttles,
	// nothing warns, every export is simply slower. Worth naming before a run, not after.
	const foreign = instantaneousLoadPercent();
	if (foreign != null && foreign > 60) {
		problems.push(
			`${foreign}% of a core-second is already being used by other processes ` +
				"(a remote-desktop session, a screen recorder, a build) — every export will be slower",
		);
	}
	return { ok: problems.length === 0, problems, power, disk, foreignCpuPercent: foreign };
}

/**
 * One measured export.
 *
 * Timeline of a run, and what each interval is called in the results:
 *
 *   prepare()            ─ prepareMs      (warm-up: launch, import, presets — not counted)
 *   runExport() begins   ─┐
 *     ctx.commit()       ─┤ launchToCommitMs
 *   ── t0 ───────────────┘
 *     …render…            ─ exportMs      ← the headline number
 *   ── t1 = last byte written to the output file
 *     verify              ─ verifyMs
 */
export async function runOnce(driver, ctx) {
	const sampler = new ProcessTreeSampler(
		[driver.appPath, driver.processName].filter(Boolean),
	).start();
	const before = sampler.result();

	const out = driver.outputPath(ctx);
	if (existsSync(out)) rmSync(out, { force: true });

	let t0 = null;
	let driverCompletedAt = null;
	const invokedAt = now();
	ctx.commit = () => {
		if (t0 === null) t0 = now();
	};
	/**
	 * A driver may supply its own completion instant when the app knows better than the
	 * filesystem does — Camtasia flips `isExporting` to false, Kap hands back a path only once
	 * it has finished. The runner still owns the clock; this only replaces the *stop*, and only
	 * when it is earlier than the filesystem's answer, so it can never inflate a result.
	 */
	ctx.markComplete = (ts = now()) => {
		if (driverCompletedAt === null) driverCompletedAt = ts;
	};

	const record = {
		app: driver.id,
		displayName: driver.displayName,
		scenario: ctx.scenario.id,
		run: ctx.run.index,
		automation: driver.automation,
		outputPath: out,
		ok: false,
	};

	let exportError = null;
	try {
		await driver.runExport(ctx);
	} catch (e) {
		exportError = e;
	}
	if (t0 === null) t0 = invokedAt; // a driver that never committed still gets a clock

	// The app may still be muxing after runExport resolves — for GUI drivers it almost always
	// is, because the click returns immediately. The filesystem decides when it is done.
	const wait = await waitForStableFile(out, {
		timeoutMs: ctx.timeoutMs ?? 45 * 60 * 1000,
		stableMs: ctx.stableMs ?? 2500,
		onTick: ctx.onTick,
	});

	const after = sampler.stop();
	const delta = cpuDelta(before, after);

	const stopAt =
		driverCompletedAt != null && wait.ok
			? Math.min(driverCompletedAt, wait.completedAt)
			: wait.ok
				? wait.completedAt
				: null;
	record.launchToCommitMs = Math.round(t0 - invokedAt);
	record.exportMs = stopAt != null ? Math.round(stopAt - t0) : null;
	record.completionSignal = driverCompletedAt != null ? "driver" : "file-stability";
	record.waitedMs = Math.round(wait.waitedMs);
	record.cpuSeconds = delta.cpuSeconds;
	record.peakRssMiB = delta.peakRssMiB;
	record.foreignCpuPercent = after.foreignCpuPercent;
	record.outputSizeBytes = wait.sizeBytes ?? null;

	if (exportError) {
		record.error = exportError.message?.slice(0, 1200) ?? String(exportError);
	}
	if (!wait.ok) {
		record.error = record.error ?? `output never stabilised (${wait.reason})`;
		return record;
	}

	const v = verifyOutput(out, ctx.scenario.output, ctx.source.probe.durationSec);
	record.verified = v.valid;
	record.verifyReasons = v.reasons;
	record.outputProbe = v.probe;

	if (record.exportMs != null && v.probe?.durationSec) {
		const secs = record.exportMs / 1000;
		record.realtimeFactor = +(v.probe.durationSec / secs).toFixed(3);
		record.framesPerSecond = v.probe.video?.nbFrames
			? +(v.probe.video.nbFrames / secs).toFixed(1)
			: null;
		record.megapixelsPerSecond =
			v.probe.video?.nbFrames && v.probe.video.width
				? +(
						(v.probe.video.nbFrames * v.probe.video.width * v.probe.video.height) /
						1e6 /
						secs
					).toFixed(1)
				: null;
	}

	// Metadata says the file is the right shape; only pixels say the app did the work. An
	// export that skipped the compositing would otherwise be recorded as a fast, valid run.
	if (v.valid) {
		try {
			record.visual = inspectExport(out, ctx.scenario, { probe: v.probe, spec: ctx.source.spec });
		} catch (e) {
			record.visual = { error: e.message?.slice(0, 400) ?? String(e), allPassed: null };
		}
	}

	record.ok = v.valid && !exportError;
	record.effectsVerified = record.visual?.allPassed ?? null;
	// A driver says what it configured; the pixels say what happened. Where they disagree the
	// pixels win — Cap accepted a cursor track, reported `cursor.hide: false`, and rendered no
	// pointer at all, which would otherwise have counted as full fidelity.
	if (record.visual?.checks) {
		record.contradicted = Object.entries(record.visual.checks)
			.filter(([, ok]) => ok === false)
			.map(([k]) => k);
	}
	return record;
}

/** Every repetition for one app, with the guards and cooldowns in between. */
export async function runApp(
	driver,
	baseCtx,
	{ repetitions = 3, discardFirst = true, cooldownSec = 45, log = () => undefined } = {},
) {
	const detected = driver.detect();
	if (!detected.installed) {
		return {
			app: driver.id,
			displayName: driver.displayName,
			skipped: true,
			reason: `not installed${detected.error ? `: ${detected.error}` : ""}`,
			runs: [],
		};
	}

	log(`${driver.displayName}: preparing (${detected.version ?? "unknown version"})`);
	const state = {};
	const prepCtx = { ...baseCtx, state, run: { index: 0 }, commit: () => undefined };
	const tPrep = now();
	let prep;
	try {
		prep = await driver.prepare(prepCtx);
	} catch (e) {
		return {
			app: driver.id,
			displayName: driver.displayName,
			version: detected.version,
			skipped: true,
			reason: `prepare failed: ${e.message?.slice(0, 600)}`,
			runs: [],
		};
	}
	const prepareMs = Math.round(now() - tPrep);

	const runs = [];
	// Run 0 is a warm-up: caches are cold, shaders are uncompiled, and the app may still be
	// finishing its own first-launch work. It is measured and kept, but excluded from the
	// headline statistics unless the caller says otherwise.
	const total = repetitions + (discardFirst ? 1 : 0);
	for (let i = 0; i < total; i++) {
		const isWarmup = discardFirst && i === 0;
		log(`${driver.displayName}: run ${i + 1}/${total}${isWarmup ? " (warm-up)" : ""}`);
		const pre = preconditionCheck();
		if (!pre.ok) log(`  ⚠ ${pre.problems.join("; ")}`);

		const ctx = { ...baseCtx, state, run: { index: i }, commit: () => undefined };
		const rec = await runOnce(driver, ctx);
		rec.warmup = isWarmup;
		rec.precondition = pre.problems;
		runs.push(rec);
		log(
			`  ${rec.ok ? "✓" : "✗"} ${rec.exportMs != null ? `${(rec.exportMs / 1000).toFixed(2)}s` : "failed"}` +
				`${rec.realtimeFactor ? ` (${rec.realtimeFactor}× realtime)` : ""}` +
				`${rec.error ? ` — ${rec.error.split("\n")[0].slice(0, 160)}` : ""}` +
				`${rec.verifyReasons?.length ? ` — output mismatch: ${rec.verifyReasons.join("; ")}` : ""}`,
		);

		if (i < total - 1) await cooldown({ seconds: cooldownSec, log: () => undefined });
	}

	try {
		await driver.cleanup({ ...baseCtx, state });
	} catch (e) {
		log(`  cleanup warning: ${e.message}`);
	}

	// Fidelity is settled after the runs, not before: a feature the driver configured but the
	// verifier could not see in the output is not a feature this app applied.
	const contradicted = new Set(runs.flatMap((r) => r.contradicted ?? []));
	const claimed = (prep.appliedFeatures ?? []).filter((f) => !contradicted.has(f));
	const fid = fidelity(baseCtx.scenario, claimed);
	if (contradicted.size) {
		fid.contradicted = [...contradicted];
		log(`  ⚠ configured but not rendered: ${[...contradicted].join(", ")}`);
	}

	return {
		app: driver.id,
		displayName: driver.displayName,
		vendor: driver.vendor,
		kind: driver.kind,
		automation: driver.automation,
		version: detected.version,
		path: detected.path,
		prepareMs,
		fidelity: fid,
		notes: prep.notes ?? [],
		skipped: false,
		runs,
	};
}

export { machineFingerprint, sleep };
