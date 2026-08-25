/**
 * Measurement primitives.
 *
 * Three things have to be true for an export timing to mean anything:
 *   1. The clock starts at the moment the export is *committed*, not when the app launched.
 *   2. The clock stops when the output file is *complete*, not when a progress bar hits 100%.
 *   3. The output is verified to be what was asked for — an app that quietly writes 720p, or a
 *      12-second file from a 60-second source, is not faster, it is wrong.
 *
 * Everything here is app-agnostic on purpose: the same stopwatch is used for the CLI drivers
 * and the UI drivers, so a CLI app is not credited for skipping a step a GUI app must do.
 */

import { existsSync, statSync } from "node:fs";
import { probe } from "./fixture.mjs";
import { instantaneousLoadPercent, listProcesses, parseMacCpuTime } from "./platform.mjs";

export const now = () => Number(process.hrtime.bigint() / 1000n) / 1000; // ms, monotonic

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ process sampling ----- */

/**
 * Cumulative CPU seconds and peak RSS for every process whose argv starts with `matchPrefix`
 * (an app bundle path), summed across the tree. Sampling cumulative counters rather than
 * instantaneous %CPU means a helper that exits mid-export still contributes its full cost.
 */
export class ProcessTreeSampler {
	constructor(matchPrefixes, { intervalMs = 500 } = {}) {
		this.matchPrefixes = [].concat(matchPrefixes).filter(Boolean);
		this.intervalMs = intervalMs;
		this.cpuByPid = new Map(); // pid -> max cumulative cpu seconds seen
		this.peakRssBytes = 0;
		this.samples = 0;
		this.timer = null;
		// Everything *else* on the machine. A remote-desktop session, a screen recorder or a
		// build running alongside the benchmark inflates every export time without inflating any
		// app's own CPU figure — so it is sampled and reported rather than assumed to be zero.
		this.foreignCpuSamples = [];
	}

	static parseCpuTime(t) {
		// ps TIME is [[dd-]hh:]mm:ss[.ff]
		const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(t.trim());
		if (!m) return 0;
		const [, d, h, mi, s] = m;
		return Number(d || 0) * 86400 + Number(h || 0) * 3600 + Number(mi) * 60 + Number(s);
	}

	sampleOnce() {
		const procs = listProcesses();
		let rssSum = 0;
		for (const { pid, rssBytes, cpuSeconds, args } of procs) {
			if (!this.matchPrefixes.some((p) => args.includes(p))) continue;
			const prev = this.cpuByPid.get(pid) ?? 0;
			if (cpuSeconds > prev) this.cpuByPid.set(pid, cpuSeconds);
			rssSum += rssBytes;
		}
		if (rssSum > this.peakRssBytes) this.peakRssBytes = rssSum;
		this.samples++;
		this.sampleForeignLoad(procs);
	}

	/** Instantaneous %CPU of everything that is not the app under test, summed. */
	sampleForeignLoad(procs) {
		const total = instantaneousLoadPercent();
		if (total == null) return;
		// Subtract nothing: the figure is "how busy is this machine besides the measurement",
		// and the app under test is a small share of it during an export. Callers read it as
		// context, not as an exact complement.
		this.foreignCpuSamples.push(total);
	}

	start() {
		this.sampleOnce();
		this.timer = setInterval(() => this.sampleOnce(), this.intervalMs);
		this.timer.unref?.();
		return this;
	}

	stop() {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		this.sampleOnce();
		return this.result();
	}

	result() {
		let cpuSeconds = 0;
		for (const v of this.cpuByPid.values()) cpuSeconds += v;
		return {
			cpuSeconds: +cpuSeconds.toFixed(2),
			peakRssBytes: this.peakRssBytes,
			peakRssMiB: +(this.peakRssBytes / 1024 ** 2).toFixed(1),
			pidsSeen: this.cpuByPid.size,
			samples: this.samples,
			// Median rather than mean: one spike from a Spotlight index should not characterise
			// a two-minute export.
			foreignCpuPercent: this.foreignCpuSamples.length
				? +median(this.foreignCpuSamples).toFixed(1)
				: null,
		};
	}
}

/**
 * The CPU counters above are cumulative *since process start*, which for a long-lived GUI app
 * includes the idle time before the export. Snapshot before, snapshot after, subtract.
 */
export function cpuDelta(before, after) {
	return {
		cpuSeconds: +Math.max(0, after.cpuSeconds - before.cpuSeconds).toFixed(2),
		peakRssMiB: after.peakRssMiB,
	};
}

/* ------------------------------------------------------------------- output watching ----- */

/**
 * Resolve when `path` exists and has stopped growing for `stableMs`.
 *
 * Size stability is the only completion signal that works identically for a CLI that writes
 * once and a GUI that muxes at the end. `stableMs` has to clear the longest plausible stall
 * inside an export (a slow keyframe, a GC pause) without inflating the measurement — so the
 * stable window is *subtracted back off* the reported time, and the last-growth timestamp is
 * what the stopwatch actually reads.
 */
export async function waitForStableFile(
	path,
	{
		timeoutMs = 45 * 60 * 1000,
		// A render that started will put *something* on disk quickly. Nothing after this long
		// means the export never began — a click that missed, a dialog that did not open — and
		// waiting out the full render timeout turns one broken run into a lost hour.
		appearTimeoutMs = 4 * 60 * 1000,
		stableMs = 2500,
		pollMs = 100,
		minBytes = 4096,
		onTick,
	} = {},
) {
	const t0 = now();
	let lastSize = -1;
	let lastGrowthAt = null;
	let appearedAt = null;

	while (now() - t0 < timeoutMs) {
		let size = -1;
		try {
			if (existsSync(path)) size = statSync(path).size;
		} catch {
			size = -1;
		}

		if (size >= 0 && appearedAt === null) appearedAt = now();
		if (size > lastSize) {
			lastSize = size;
			lastGrowthAt = now();
		}
		onTick?.({ size, elapsedMs: now() - t0 });

		if (appearedAt === null && now() - t0 > appearTimeoutMs) {
			return {
				ok: false,
				reason: "output never appeared",
				appearedAt: null,
				sizeBytes: -1,
				waitedMs: now() - t0,
			};
		}
		if (lastSize >= minBytes && lastGrowthAt !== null && now() - lastGrowthAt >= stableMs) {
			return {
				ok: true,
				appearedAt,
				completedAt: lastGrowthAt, // the honest moment the last byte landed
				sizeBytes: lastSize,
				waitedMs: now() - t0,
			};
		}
		await sleep(pollMs);
	}
	return { ok: false, reason: "timeout", appearedAt, sizeBytes: lastSize, waitedMs: now() - t0 };
}

/* -------------------------------------------------------------------- verification ------- */

/** Does the produced file actually match what the scenario asked for? */
export function verifyOutput(path, target, sourceDurationSec) {
	if (!existsSync(path)) return { valid: false, reasons: ["output file missing"], probe: null };
	let p;
	try {
		p = probe(path);
	} catch (e) {
		return { valid: false, reasons: [`ffprobe failed: ${e.message}`], probe: null };
	}

	const reasons = [];
	if (!p.video) reasons.push("no video stream");
	if (p.video && p.video.width !== target.width) {
		reasons.push(`width ${p.video.width} != ${target.width}`);
	}
	if (p.video && p.video.height !== target.height) {
		reasons.push(`height ${p.video.height} != ${target.height}`);
	}
	if (p.video?.codec && target.videoCodec && p.video.codec !== target.videoCodec) {
		reasons.push(`codec ${p.video.codec} != ${target.videoCodec}`);
	}
	if (p.video?.fps != null) {
		const drift = (Math.abs(p.video.fps - target.fps) / target.fps) * 100;
		if (drift > target.tolerance.fpsPercent) reasons.push(`fps ${p.video.fps} != ${target.fps}`);
	}
	if (sourceDurationSec != null && p.durationSec != null) {
		const d = Math.abs(p.durationSec - sourceDurationSec);
		if (d > target.tolerance.durationSec) {
			reasons.push(
				`duration ${p.durationSec?.toFixed(2)}s vs source ${sourceDurationSec}s (Δ${d.toFixed(2)}s)`,
			);
		}
	}
	return { valid: reasons.length === 0, reasons, probe: p };
}

/* ---------------------------------------------------------------------- run guards ------- */

/**
 * Between repetitions the machine has to come back to the same state, or run 3 measures a
 * hotter SoC than run 1 and the spread is thermal, not architectural.
 */
export async function cooldown({ seconds = 45, log = () => undefined } = {}) {
	log(`cooldown: ${seconds}s`);
	await sleep(seconds * 1000);
}

/** Percentile helpers used by the report. Small n, so exact rather than interpolated. */
export function median(xs) {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Median absolute deviation — robust spread for n=3, where a stdev is mostly noise. */
export function mad(xs) {
	const m = median(xs);
	if (m == null) return null;
	return median(xs.map((x) => Math.abs(x - m)));
}
