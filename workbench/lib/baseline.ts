// ponytail: the ratchet turns BOTH ways, and that is the whole point.
//
// A workbench whose baseline only records "this is broken, don't tell me again"
// degrades into a green rubber stamp: three known defects go in, nothing ever
// comes out, and a fix goes unnoticed. So a listed check that starts PASSING is
// reported as loudly as a new failure — it means the defect is gone and the
// entry must be deleted.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Scenario } from "./scenario";
import type { CheckResult } from "./score";

export interface Baseline {
	scenario: string;
	/** Check ids known to fail when the baseline was recorded. */
	expectedFailures: string[];
	behaviour: number;
	dsl: number;
	recordedAt: string;
}

/** An expectedFailures entry older than this is printed for review. */
export const STALE_AFTER_DAYS = 90;

export interface BaselineVerdict {
	ok: boolean;
	/** Checks that failed and were not expected to. */
	regressions: string[];
	/** Checks listed as known-broken that now pass — delete them. */
	fixed: string[];
	/** expectedFailures entries older than STALE_AFTER_DAYS. */
	stale: Array<{ id: string; defect: string; since: string; ageDays: number }>;
	messages: string[];
}

export function readBaseline(file: string): Baseline | null {
	if (!existsSync(file)) return null;
	return JSON.parse(readFileSync(file, "utf8")) as Baseline;
}

export function writeBaseline(file: string, baseline: Baseline): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(baseline, null, "\t")}\n`, "utf8");
}

function ageInDays(since: string, now: Date): number {
	const then = Date.parse(since);
	if (Number.isNaN(then)) return Number.POSITIVE_INFINITY;
	return Math.floor((now.getTime() - then) / 86_400_000);
}

/**
 * Compares one run's check results against the recorded baseline.
 *
 * `baseline` may be null — a scenario without one is not an error, it simply
 * has nothing to ratchet against yet, and every failure is reported so the
 * first run can be turned into a baseline deliberately.
 */
export function assertAgainstBaseline(options: {
	scenario: Scenario;
	results: CheckResult[];
	baseline: Baseline | null;
	now?: Date;
}): BaselineVerdict {
	const now = options.now ?? new Date();
	const expectedFromScenario = new Set(Object.keys(options.scenario.expectedFailures ?? {}));
	const expectedFromBaseline = new Set(options.baseline?.expectedFailures ?? []);
	const known = new Set([...expectedFromScenario, ...expectedFromBaseline]);

	const regressions: string[] = [];
	const fixed: string[] = [];
	for (const result of options.results) {
		if (!result.ok && !known.has(result.id)) regressions.push(result.id);
		if (result.ok && known.has(result.id)) fixed.push(result.id);
	}

	const stale: BaselineVerdict["stale"] = [];
	for (const [id, entry] of Object.entries(options.scenario.expectedFailures ?? {})) {
		const ageDays = ageInDays(entry.since, now);
		if (ageDays > STALE_AFTER_DAYS) {
			stale.push({ id, defect: entry.defect, since: entry.since, ageDays });
		}
	}

	const messages: string[] = [];
	for (const id of regressions) {
		messages.push(`RÉGRESSION ${options.scenario.id}/${id} : échec inattendu.`);
	}
	for (const id of fixed) {
		const defect = options.scenario.expectedFailures?.[id]?.defect ?? "défaut connu";
		// ponytail: "seems fixed", never "is fixed". At the sober default of n=3
		// a check that fails a third of the time passes a whole run about 30 % of
		// the time — `dsl.focus.not-fabricated` did exactly that between two live
		// runs an hour apart. Deleting an entry on one green run would erase a
		// real defect and, worse, make its return look like a fresh regression.
		messages.push(
			`${defect} semble corrigé sur ${options.scenario.id}/${id} : ` +
				"confirmez à n plus élevé (l'intermittence passe un run entier assez souvent), " +
				"puis retirez-le de expectedFailures et de la baseline.",
		);
	}
	for (const entry of stale) {
		messages.push(
			`REVUE ${options.scenario.id}/${entry.id} : ${entry.defect} accepté depuis ` +
				`${entry.ageDays} jours (${entry.since}).`,
		);
	}

	return {
		ok: regressions.length === 0 && fixed.length === 0,
		regressions,
		fixed,
		stale,
		messages,
	};
}

/** Builds the baseline a passing run would record. */
export function baselineFromRun(options: {
	scenarioId: string;
	results: CheckResult[];
	behaviour: number;
	dsl: number;
	now?: Date;
}): Baseline {
	return {
		scenario: options.scenarioId,
		expectedFailures: options.results
			.filter((r) => !r.ok)
			.map((r) => r.id)
			.sort(),
		behaviour: Number(options.behaviour.toFixed(4)),
		dsl: Number(options.dsl.toFixed(4)),
		recordedAt: (options.now ?? new Date()).toISOString().slice(0, 10),
	};
}
