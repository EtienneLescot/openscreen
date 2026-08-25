/**
 * Making the apps composite the same rectangle.
 *
 * Every app in this set has a "padding" control, and no two of them are on the same scale:
 * asking each for "5" produced a 1.85% inset in Cap and a 10% inset in OpenScreen — a 44%
 * difference in the number of source pixels being sampled per frame. That is a confound, not a
 * result, so before the real run each app's control is solved for the value that yields the
 * scenario's inset.
 *
 * The solve is a secant search on a deliberately short clip: two probes to establish the app's
 * (usually near-linear) mapping, then up to two refinements. Everything is measured from the
 * rendered pixels, never from what the app claims, and the outcome is written to
 * benchmark/calibration.json so a run is reproducible without repeating it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BENCH_ROOT, machineFingerprint } from "./env.mjs";
import { buildFixture, DEFAULT_SPEC, probe } from "./fixture.mjs";
import { waitForStableFile } from "./measure.mjs";
import { inspectExport } from "./visualCheck.mjs";

export const CALIBRATION_PATH = join(BENCH_ROOT, "calibration.json");

export function loadCalibration() {
	if (!existsSync(CALIBRATION_PATH)) return {};
	try {
		return JSON.parse(readFileSync(CALIBRATION_PATH, "utf8"));
	} catch {
		return {};
	}
}

/** A short clip: the geometry of the composition does not depend on how long the clip is. */
export function calibrationFixture(workDir, log = () => undefined) {
	const spec = { ...DEFAULT_SPEC, name: "calib-1080p60-4s", durationSec: 4 };
	return buildFixture(workDir, spec, { log });
}

async function measureInset(driver, ctx, paddingControl) {
	await driver.prepare({ ...ctx, paddingControl });
	const out = driver.outputPath(ctx);
	let committed = false;
	await driver.runExport({
		...ctx,
		paddingControl,
		commit: () => {
			committed = true;
		},
	});
	const wait = await waitForStableFile(out, { timeoutMs: 10 * 60 * 1000, stableMs: 1200 });
	if (!wait.ok) throw new Error(`calibration export produced nothing (${wait.reason})`);
	const p = probe(out);
	const v = inspectExport(out, ctx.scenario, { probe: p });
	const inset = v.measured?.insetPercentShortSide;
	if (inset == null) throw new Error("could not measure the content box");
	return { inset, box: v.measured.contentBox, checks: v.checks, committed };
}

/**
 * Solve one app's padding control for the scenario's target inset.
 * Returns the chosen control value plus every probe, so the calibration file shows its work.
 */
export async function calibrateApp(
	driver,
	ctx,
	{ tolerancePercent = 0.4, maxProbes = 4, log = () => undefined } = {},
) {
	const target = ctx.scenario.effects.paddingPercent;
	if (!target)
		return {
			app: driver.id,
			paddingControl: 0,
			target,
			probes: [],
			reason: "no padding requested",
		};
	if (typeof driver.defaultPaddingControl !== "function") {
		return {
			app: driver.id,
			paddingControl: null,
			target,
			probes: [],
			reason: "driver exposes no padding control",
		};
	}

	const probes = [];
	const seed = driver.defaultPaddingControl(ctx.scenario);
	// Two points far enough apart to establish the slope without leaving the control's range.
	let x0 = Math.max(0, seed * 0.5);
	let x1 = seed;

	const run = async (x) => {
		const m = await measureInset(driver, ctx, x);
		probes.push({ control: +x.toFixed(2), inset: m.inset, box: m.box });
		log(
			`  ${driver.id}: padding=${x.toFixed(2)} → inset ${m.inset}% (${m.box.width}×${m.box.height})`,
		);
		return m.inset;
	};

	let y0 = await run(x0);
	let y1 = await run(x1);

	for (let i = 0; i < maxProbes - 2; i++) {
		const best = probes.reduce((a, b) =>
			Math.abs(a.inset - target) <= Math.abs(b.inset - target) ? a : b,
		);
		if (Math.abs(best.inset - target) <= tolerancePercent) break;
		if (y1 === y0) break; // control has no effect in this range; stop rather than divide by zero
		// Secant step, clamped to a sane control range.
		let x2 = x1 + ((target - y1) * (x1 - x0)) / (y1 - y0);
		x2 = Math.max(0, Math.min(100, x2));
		if (!Number.isFinite(x2) || probes.some((p) => Math.abs(p.control - x2) < 0.05)) break;
		const y2 = await run(x2);
		x0 = x1;
		y0 = y1;
		x1 = x2;
		y1 = y2;
	}

	const best = probes.reduce((a, b) =>
		Math.abs(a.inset - target) <= Math.abs(b.inset - target) ? a : b,
	);
	return {
		app: driver.id,
		target,
		paddingControl: best.control,
		achievedInsetPercent: best.inset,
		achievedBox: best.box,
		withinTolerance: Math.abs(best.inset - target) <= tolerancePercent,
		probes,
	};
}

export function saveCalibration(entries, meta) {
	mkdirSync(BENCH_ROOT, { recursive: true });
	const m = machineFingerprint();
	const doc = {
		generatedAt: new Date().toISOString(),
		// Stamped so `run` can tell a calibration made here from one that travelled with the
		// repo. The padding a control produces is a property of the app, not the machine, but
		// app versions differ between machines and a silently stale solve is worse than none.
		machine: { chip: m.chip, osVersion: m.osVersion, model: m.model },
		...meta,
		apps: Object.fromEntries(entries.map((e) => [e.app, e])),
	};
	writeFileSync(CALIBRATION_PATH, `${JSON.stringify(doc, null, 2)}\n`);
	return CALIBRATION_PATH;
}
