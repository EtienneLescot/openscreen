// ponytail: two axes, scored apart and NEVER averaged together.
//
// The user's criterion is that a good result depends on the model's behaviour
// AND on the DSL it emits. A polite lie about a perfect edit, and a silent
// correct edit the user forbade, are both failures — so the gate is
// `min(behaviour, dsl)`, not their mean.

import { documentSchema } from "../../src/lib/ai-edition/schema";
import type { JudgeReading } from "./judge";
import { documentInvariants } from "./oracles";
import {
	type Check,
	type EvalContext,
	fail,
	type JudgedCheck,
	pass,
	type Scenario,
	undecided,
} from "./scenario";

export interface CheckResult {
	id: string;
	weight: number;
	ok: boolean;
	evidence?: string;
	/** True when this failure is recorded in the scenario's expectedFailures. */
	expected: boolean;
	/** True when the check did not decide — `indéterminé`. Implies `!ok`, and
	 *  every consumer that ignores this field therefore reads it as a failure
	 *  rather than as a pass. See `Verdict` in `scenario.ts`. */
	indeterminate: boolean;
}

export interface AxisScore {
	/**
	 * Σ(weight of passing checks) / Σ(weight of DECIDED checks), in [0,1].
	 *
	 * ponytail: le poids indéterminé sort des deux termes. Le mettre au
	 * dénominateur ferait chuter l'axe pour une raison qui ne parle pas du
	 * comportement du modèle — le défaut même qu'on répare. Le mettre au
	 * numérateur le convertirait en passage, ce que la consigne interdit. Une
	 * abstention ne déplace donc pas l'estimation ; elle rétrécit `n`, et
	 * c'est l'intervalle de Wilson du rapport qui s'élargit à sa place.
	 */
	score: number;
	/** Somme des poids tranchés (conforme ou fautif). */
	decidedWeight: number;
	/** Somme des poids indéterminés. */
	undecidedWeight: number;
	/**
	 * Faux quand l'axe n'a pas été mesuré : il porte des checks, et le poids
	 * indéterminé y dépasse le poids tranché.
	 *
	 * ponytail: sans ce drapeau, un juge qui s'abstiendrait sur TOUT rendrait un
	 * axe à 1,0 sur un dénominateur vide, la porte `min()` passerait, et le run
	 * partirait au vert sur une propriété que personne n'a mesurée. C'est mot
	 * pour mot la panne que ce banc existe pour attraper, remontée d'un étage.
	 */
	measured: boolean;
	results: CheckResult[];
}

export interface ScoredRun {
	scenarioId: string;
	behaviour: AxisScore;
	dsl: AxisScore;
	/** The conjoint gate value: `min(behaviour, dsl)`. */
	gateScore: number;
	passed: boolean;
	/** Ids des checks restés indéterminés, pour que le rapport puisse les nommer
	 *  au lieu d'afficher un trou. */
	undecided: string[];
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
		const indeterminate = !verdict.ok && verdict.indeterminate === true;
		return {
			id: check.id,
			weight: check.weight,
			ok: verdict.ok,
			evidence: verdict.ok ? undefined : verdict.evidence,
			// ponytail: un check indéterminé n'est pas « attendu en échec ». Le
			// marquer ainsi inscrirait l'abstention du juge dans expectedFailures au
			// premier `--update-baseline`, c'est-à-dire blanchirait en défaut connu
			// ce qui n'a simplement pas été mesuré.
			expected: !verdict.ok && !indeterminate && known.has(check.id),
			indeterminate,
		};
	});
	const decidedWeight = results.reduce((sum, r) => sum + (r.indeterminate ? 0 : r.weight), 0);
	const undecidedWeight = results.reduce((sum, r) => sum + (r.indeterminate ? r.weight : 0), 0);
	const measured = results.length === 0 || decidedWeight >= undecidedWeight;
	if (decidedWeight === 0) return { score: 1, decidedWeight, undecidedWeight, measured, results };
	const earned = results.reduce((sum, r) => sum + (r.ok ? r.weight : 0), 0);
	return { score: earned / decidedWeight, decidedWeight, undecidedWeight, measured, results };
}

/**
 * Les checks jugés, vus comme des checks ordinaires.
 *
 * `readings` porte le verdict du juge par id de check. Un id absent n'est PAS
 * un passage : c'est un tour que le juge n'a pas encore lu, et le check le dit.
 */
export function judgedChecks(
	judged: JudgedCheck[],
	readings?: ReadonlyMap<string, JudgeReading>,
): Check[] {
	return judged.map((entry) => ({
		id: entry.id,
		weight: entry.weight,
		check: (): ReturnType<Check["check"]> => {
			const reading = readings?.get(entry.id);
			if (!reading) {
				return undecided(
					`non jugé — les tours sont sur disque, lancez \`npm run wb:judge -- --label <label>\` ` +
						`(rubric ${entry.rubric.id})`,
				);
			}
			if (reading.verdict === "conforme") return pass();
			const detail =
				reading.raw === undefined
					? reading.reason
					: `${reading.reason} · ${reading.raw.slice(0, 200)}`;
			return reading.verdict === "fautif"
				? fail(`juge : ${detail}`)
				: undecided(`juge indéterminé : ${detail}`);
		},
	}));
}

export function scoreRun(
	scenario: Scenario,
	context: EvalContext,
	readings?: ReadonlyMap<string, JudgeReading>,
): ScoredRun {
	const expected = scenario.expectedFailures ?? {};
	const behaviour = runChecks(
		[...scenario.behaviour, ...judgedChecks(scenario.judged ?? [], readings)],
		context,
		expected,
	);
	const dsl = runChecks([...scenario.dsl, ...STRUCTURAL_CHECKS], context, expected);
	const gateScore = Math.min(behaviour.score, dsl.score);
	return {
		scenarioId: scenario.id,
		behaviour,
		dsl,
		gateScore,
		// ponytail: `measured` est une CONDITION de passage, pas une décoration.
		// Un axe majoritairement indéterminé n'a pas de score à comparer à la
		// porte ; déclarer « passé » dessus serait convertir l'abstention en
		// succès par la porte de derrière, là même où la consigne l'interdit.
		passed: gateScore >= scenario.gate && behaviour.measured && dsl.measured,
		undecided: [...behaviour.results, ...dsl.results]
			.filter((result) => result.indeterminate)
			.map((result) => result.id),
		failureClass: context.classifyFailure(),
		ms: context.run.ms,
	};
}

/** Flat view of every check result, for reporting and for the baseline. */
export function allResults(run: ScoredRun): CheckResult[] {
	return [...run.behaviour.results, ...run.dsl.results];
}
