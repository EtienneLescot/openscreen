// StageTimings: pure-logic per-stage timing accumulation for the v2 export
// performance harness. Callers provide measured durations or wrap work with an
// injected clock; this module does not time export work or touch browser APIs.

export interface StageStat {
	totalMs: number; // summed elapsed across all record()/stop() calls for this stage
	count: number; // number of samples
	avgMs: number; // totalMs / count (0 when count === 0)
	pct: number; // totalMs / grandTotalMs * 100 (0 when grandTotal === 0)
}

export interface PerfSnapshot {
	stages: Record<string, StageStat>; // keyed by stage name, in FIRST-SEEN order
	totalMs: number; // sum of every stage's totalMs
}

interface MutableStageStat {
	totalMs: number;
	count: number;
}

const defaultNow =
	typeof performance !== "undefined" && typeof performance.now === "function"
		? () => performance.now()
		: () => Date.now();

export class StageTimings {
	private readonly now: () => number;

	private readonly stats = new Map<string, MutableStageStat>();

	constructor(now: () => number = defaultNow) {
		this.now = now;
	}

	record(stage: string, ms: number): void {
		if (!Number.isFinite(ms) || ms < 0) {
			// Invalid durations are skipped so they do not create a misleading sample.
			return;
		}

		const stat = this.stats.get(stage);
		if (stat) {
			stat.totalMs += ms;
			stat.count += 1;
			return;
		}

		this.stats.set(stage, { totalMs: ms, count: 1 });
	}

	start(stage: string): () => void {
		const startedAt = this.now();
		let stopped = false;

		return () => {
			if (stopped) {
				return;
			}
			stopped = true;
			this.record(stage, Math.max(0, this.now() - startedAt));
		};
	}

	time<T>(stage: string, fn: () => T): T {
		const stop = this.start(stage);
		try {
			return fn();
		} finally {
			stop();
		}
	}

	async timeAsync<T>(stage: string, fn: () => Promise<T>): Promise<T> {
		const stop = this.start(stage);
		try {
			return await fn();
		} finally {
			stop();
		}
	}

	snapshot(): PerfSnapshot {
		let totalMs = 0;
		for (const stat of this.stats.values()) {
			totalMs += stat.totalMs;
		}

		const stages: Record<string, StageStat> = {};
		for (const [stage, stat] of this.stats) {
			stages[stage] = {
				totalMs: stat.totalMs,
				count: stat.count,
				avgMs: stat.count === 0 ? 0 : stat.totalMs / stat.count,
				pct: totalMs === 0 ? 0 : (stat.totalMs / totalMs) * 100,
			};
		}

		return { stages, totalMs };
	}

	formatSummary(opts: { frames?: number; hardwareAcceleration?: string } = {}): string {
		const snapshot = this.snapshot();
		const lines = ["stage      totalMs    pct    avgMs  count"];

		for (const [stage, stat] of Object.entries(snapshot.stages)) {
			lines.push(
				`${stage}  ${stat.totalMs.toFixed(1).padStart(9)}  ${stat.pct
					.toFixed(1)
					.padStart(5)}%  ${stat.avgMs.toFixed(2).padStart(7)}  n=${stat.count}`,
			);
		}

		const totalCount = Object.values(snapshot.stages).reduce((sum, stat) => sum + stat.count, 0);
		const totalAvgMs = totalCount === 0 ? 0 : snapshot.totalMs / totalCount;
		const totalPct = snapshot.totalMs === 0 ? 0 : 100;
		lines.push(
			`TOTAL      ${snapshot.totalMs.toFixed(1).padStart(9)}  ${totalPct
				.toFixed(1)
				.padStart(5)}%  ${totalAvgMs.toFixed(2).padStart(7)}  n=${totalCount}`,
		);

		if (opts.frames !== undefined) {
			const fps =
				snapshot.totalMs === 0 ? "n/a" : (opts.frames / (snapshot.totalMs / 1000)).toFixed(1);
			lines.push(`fps: ${fps}`);
		}
		if (opts.hardwareAcceleration !== undefined) {
			lines.push(`hwAccel: ${opts.hardwareAcceleration}`);
		}

		return lines.join("\n");
	}

	reset(): void {
		this.stats.clear();
	}
}
