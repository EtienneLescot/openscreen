// ponytail: the live layer is stochastic, so a single repetition is an
// anecdote. Everything here exists to stop the workbench from reporting noise
// as a result.
//
// Wald intervals are useless at the edges — and our checks live at the edges,
// mostly 0/n or n/n. Wilson behaves there, so Wilson it is.

/** 1.959964 — the two-sided 95 % normal quantile. */
const Z = 1.959964;

export interface Interval {
	low: number;
	high: number;
}

export interface Proportion extends Interval {
	k: number;
	n: number;
	rate: number;
}

/** Wilson score interval at 95 %. `n === 0` yields the whole [0,1] range. */
export function wilson95(k: number, n: number): Proportion {
	if (n <= 0) return { k, n, rate: 0, low: 0, high: 1 };
	const p = k / n;
	const denominator = 1 + (Z * Z) / n;
	const centre = p + (Z * Z) / (2 * n);
	const spread = Z * Math.sqrt((p * (1 - p)) / n + (Z * Z) / (4 * n * n));
	return {
		k,
		n,
		rate: p,
		low: Math.max(0, (centre - spread) / denominator),
		high: Math.min(1, (centre + spread) / denominator),
	};
}

export interface Delta extends Interval {
	/** after − before. */
	point: number;
	/** True only when the interval excludes 0. */
	significant: boolean;
	direction: "improved" | "regressed" | "inconclusive";
}

/**
 * Newcombe's hybrid-score interval for the difference of two proportions: it is
 * built from the two Wilson intervals, so it inherits their behaviour near 0
 * and 1. A check is called improved or regressed ONLY when this interval
 * excludes zero.
 */
export function newcombeDelta(
	before: { k: number; n: number },
	after: { k: number; n: number },
): Delta {
	const a = wilson95(before.k, before.n);
	const b = wilson95(after.k, after.n);
	const point = b.rate - a.rate;
	const low = point - Math.sqrt((a.high - a.rate) ** 2 + (b.rate - b.low) ** 2);
	const high = point + Math.sqrt((a.rate - a.low) ** 2 + (b.high - b.rate) ** 2);
	const significant = low > 0 || high < 0;
	return {
		point,
		low: Math.max(-1, low),
		high: Math.min(1, high),
		significant,
		direction: significant ? (point > 0 ? "improved" : "regressed") : "inconclusive",
	};
}

/**
 * Roughly the smallest change in a rate that `n` repetitions per arm could
 * distinguish from noise, worst case (p ≈ 0.5), at 95 % / 80 % power.
 *
 * The number is deliberately blunt and deliberately printed at the TOP of every
 * report: at the sober default of n=3 it is about 55 points, which means going
 * from 40 % to 80 % on a check is indistinguishable from luck. Reading a
 * report without reading this line is how A/B theatre starts.
 */
export function minDetectableEffect(n: number): number {
	if (n <= 0) return 1;
	return Math.min(1, 2.8 * Math.sqrt((0.5 * 0.5) / n));
}

export function formatPercent(value: number, digits = 0): string {
	return `${(value * 100).toFixed(digits)}%`;
}

export function formatInterval(interval: Interval, digits = 0): string {
	return `[${formatPercent(interval.low, digits)}, ${formatPercent(interval.high, digits)}]`;
}
