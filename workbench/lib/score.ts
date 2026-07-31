// ponytail: two axes, scored apart and NEVER averaged together.
//
// The user's criterion is that a good result depends on the model's behaviour
// AND on the DSL it emits. A polite lie about a perfect edit, and a silent
// correct edit the user forbade, are both failures — so the gate is
// `min(behaviour, dsl)`, not their mean.

import { documentSchema } from "../../src/lib/ai-edition/schema";
import { documentInvariants } from "./oracles";
import { type Check, type EvalContext, fail, pass, type Scenario } from "./scenario";

export interface CheckResult {
	id: string;
	weight: number;
	ok: boolean;
	evidence?: string;
	/** True when this failure is recorded in the scenario's expectedFailures. */
	expected: boolean;
}

export interface AxisScore {
	/** Σ(weight of passing checks) / Σ(weight), in [0,1]. 1 when no checks. */
	score: number;
	results: CheckResult[];
}

export interface ScoredRun {
	scenarioId: string;
	behaviour: AxisScore;
	dsl: AxisScore;
	/** The conjoint gate value: `min(behaviour, dsl)`. */
	gateScore: number;
	passed: boolean;
	failureClass: ReturnType<EvalContext["classifyFailure"]>;
	ms: number;
}

/**
 * Structural checks appended to the DSL axis of EVERY scenario. They are not a
 * scenario's business: a document that stops being schema-valid, or that breaks
 * an invariant the schema cannot express, is a failure regardless of what was
 * asked. Weight 3 each so they cannot be diluted by a long scenario.
 */
export const STRUCTURAL_CHECKS: Check[] = [
	{
		id: "struct.schema-valid",
		weight: 3,
		check: (c) => {
			const parsed = documentSchema.safeParse(c.after);
			return parsed.success
				? pass()
				: fail(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" | "));
		},
	},
	{
		id: "struct.invariants",
		weight: 3,
		check: (c) => {
			const violations = documentInvariants(c.after);
			return violations.length === 0
				? pass()
				: fail(violations.map((v) => `${v.rule}: ${v.detail}`).join(" | "));
		},
	},
];

export function runChecks(
	checks: Check[],
	context: EvalContext,
	expectedFailures: Record<string, unknown> = {},
): AxisScore {
	// ponytail: a Set, not `in` and not hasOwnProperty — `in` would report a
	// check literally named `toString` as expected-to-fail, and the target is
	// ES2020 so `Object.hasOwn` is not available.
	const known = new Set(Object.keys(expectedFailures));
	const results: CheckResult[] = checks.map((check) => {
		let verdict: ReturnType<Check["check"]>;
		try {
			verdict = check.check(context);
		} catch (error) {
			// ponytail: a check that throws is a workbench bug, and it must look
			// like one. Swallowing it into a pass would silently shrink coverage.
			verdict = fail(`check threw: ${error instanceof Error ? error.message : String(error)}`);
		}
		return {
			id: check.id,
			weight: check.weight,
			ok: verdict.ok,
			evidence: verdict.ok ? undefined : verdict.evidence,
			expected: !verdict.ok && known.has(check.id),
		};
	});
	const total = results.reduce((sum, r) => sum + r.weight, 0);
	if (total === 0) return { score: 1, results };
	const earned = results.reduce((sum, r) => sum + (r.ok ? r.weight : 0), 0);
	return { score: earned / total, results };
}

export function scoreRun(scenario: Scenario, context: EvalContext): ScoredRun {
	const expected = scenario.expectedFailures ?? {};
	const behaviour = runChecks(scenario.behaviour, context, expected);
	const dsl = runChecks([...scenario.dsl, ...STRUCTURAL_CHECKS], context, expected);
	const gateScore = Math.min(behaviour.score, dsl.score);
	return {
		scenarioId: scenario.id,
		behaviour,
		dsl,
		gateScore,
		passed: gateScore >= scenario.gate,
		failureClass: context.classifyFailure(),
		ms: context.run.ms,
	};
}

/** Flat view of every check result, for reporting and for the baseline. */
export function allResults(run: ScoredRun): CheckResult[] {
	return [...run.behaviour.results, ...run.dsl.results];
}
