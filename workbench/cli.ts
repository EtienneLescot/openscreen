// ponytail: the L2 orchestrator. Live, stochastic, and the only executor that
// talks to the network.
//
// It is a CLI rather than a Vitest suite for one reason: a live run is a
// measurement, not an assertion. Vitest wants a pass/fail per repetition; a
// stochastic check needs k/n with an interval, and a repetition that failed for
// TRANSPORT reasons has to be replayed rather than counted.
//
// Key handling: `runner.liveStore()` reads it from `env.ts`, which reads it
// from process.env, populated by `node --env-file=.env.workbench`. It is never
// printed, never written, and `report.ts` refuses any payload that carries it.
// The app itself only ever talks to the local proxy — see runner.ts.

import {
	assertAgainstBaseline,
	baselineFromRun,
	readBaseline,
	writeBaseline,
} from "./lib/baseline";
import { requireLiveEnv } from "./lib/env";
import { DEFAULT_TURN_TIMEOUT_MS } from "./lib/harness";
import { persistRepetition, RUNS_DIR } from "./lib/persist";
import {
	buildReport,
	fingerprintOf,
	type ScenarioReport,
	summarizeScenario,
	writeReport,
} from "./lib/report";
import { type RepetitionResult, runScenarioReps } from "./lib/runner";
import { allResults } from "./lib/score";
import { formatPercent, minDetectableEffect } from "./lib/stats";
import { selectScenarios } from "./scenarios/registry";

const REPORTS_DIR = "workbench/reports";
const BASELINES_DIR = "workbench/baselines";
const CASSETTES_DIR = "workbench/cassettes";

interface Options {
	command: "run" | "compare" | "help";
	scenarios: string[];
	tags: string[];
	reps: number;
	/** True when `--reps` was passed. An explicit flag OVERRIDES a scenario's
	 * own `reps`; without the flag, the scenario's value is a default. */
	repsExplicit: boolean;
	label: string;
	timeoutMs: number;
	updateBaseline: boolean;
	record: boolean;
	/** Write every raw turn under `workbench/runs/<label>/`. On by default: a
	 * live run costs money and cannot be replayed, so throwing the turns away
	 * has to be the deliberate choice, not the default one. */
	persist: boolean;
}

/**
 * ponytail: `scenario.reps ?? options.reps` let the scenario win unconditionally,
 * and since every scenario in the pack pins its own, `--reps` did nothing at
 * all — `--reps 1` still ran three times, and the `--reps 10` A/B workflow the
 * README describes would silently have measured n=3. Found while wiring the
 * pack, not by a test, because nothing asserted on the flag.
 *
 * The precedence is now the one the field was documented with: a scenario's
 * `reps` is a DEFAULT, an explicit flag is an instruction.
 */
export function effectiveReps(
	scenario: { reps?: number },
	options: { reps: number; repsExplicit: boolean },
): number {
	return options.repsExplicit ? options.reps : (scenario.reps ?? options.reps);
}

function parseArgs(argv: string[]): Options {
	const options: Options = {
		command: "help",
		scenarios: [],
		tags: [],
		// Sober by default: 10 scenarios × 3 reps × ~25 s is already 6-7 minutes
		// and a hundred model turns. Raise it deliberately, and read the minimum
		// detectable effect the report prints before concluding anything.
		reps: 3,
		repsExplicit: false,
		label: "run",
		timeoutMs: DEFAULT_TURN_TIMEOUT_MS,
		updateBaseline: false,
		record: false,
		persist: true,
	};
	const [command, ...rest] = argv;
	if (command === "run" || command === "compare") options.command = command;
	for (let i = 0; i < rest.length; i += 1) {
		const flag = rest[i];
		const value = rest[i + 1];
		switch (flag) {
			case "--scenario":
				options.scenarios.push(value);
				i += 1;
				break;
			case "--tag":
				options.tags.push(value);
				i += 1;
				break;
			case "--reps":
				options.reps = Number(value);
				options.repsExplicit = true;
				i += 1;
				break;
			case "--label":
				options.label = value;
				i += 1;
				break;
			case "--timeout":
				options.timeoutMs = Number(value);
				i += 1;
				break;
			case "--update-baseline":
				options.updateBaseline = true;
				break;
			case "--record":
				options.record = true;
				break;
			case "--no-persist":
				options.persist = false;
				break;
			default:
				break;
		}
	}
	if (!Number.isInteger(options.reps) || options.reps < 1) {
		throw new Error(`--reps doit être un entier positif, reçu ${options.reps}`);
	}
	return options;
}

function log(line: string): void {
	process.stdout.write(`${line}\n`);
}

async function commandRun(options: Options): Promise<number> {
	// Fails here, loudly and by name, rather than letting a missing baseUrl
	// silently retarget api.openai.com with the user's Deepseek key.
	const env = requireLiveEnv();
	log(`modèle ${env.model} · endpoint ${env.baseUrl} · clé présente (${env.apiKey.length} car.)`);

	const scenarios = selectScenarios({ ids: options.scenarios, tags: options.tags });
	// ponytail: a scenario may pin its own `reps`, so the headline figure must
	// be the SMALLEST n actually run — quoting the flag would understate the
	// noise floor for exactly the scenarios that were run least.
	const perScenarioReps = scenarios.map((s) => effectiveReps(s, options));
	const smallestN = perScenarioReps.length === 0 ? options.reps : Math.min(...perScenarioReps);
	log(
		`n=${smallestN} → effet minimal détectable ≈ ` +
			`${formatPercent(minDetectableEffect(smallestN))}. ` +
			"Toute différence plus petite est du bruit.",
	);

	const summaries: ScenarioReport[] = [];
	const notices: string[] = [];
	const everyResult: RepetitionResult[] = [];
	let failed = false;

	for (const scenario of scenarios) {
		const reps = effectiveReps(scenario, options);
		log(`\n▸ ${scenario.id} — ${scenario.title} (n=${reps})`);
		const { results, discarded } = await runScenarioReps({
			scenario,
			reps,
			live: {
				record: (rep) =>
					options.record ? `${CASSETTES_DIR}/${scenario.id}-rep${rep}.json` : undefined,
			},
			timeoutMs: options.timeoutMs,
			onRepetition: (result) => {
				log(
					`  rep ${result.rep}: comportement ${formatPercent(result.scored.behaviour.score)} · ` +
						`DSL ${formatPercent(result.scored.dsl.score)} · ` +
						`porte ${formatPercent(result.scored.gateScore)} · ` +
						`${result.scored.failureClass} · ${Math.round(result.scored.ms)} ms`,
				);
				if (!options.persist) return;
				// ponytail: persisted from `onRepetition`, i.e. as each turn lands.
				// Waiting for the end of the scenario would lose every turn of a run
				// that crashes on repetition 7 — the runs that most need reading.
				const written = persistRepetition({
					label: options.label,
					result,
					prompt: scenario.prompt,
					allowAgentEdits: scenario.allowAgentEdits ?? true,
				});
				if (result.rep === 0) log(`  tours bruts : ${written.file}`);
			},
		});
		if (discarded.length > 0) {
			log(`  ${discarded.length} répétition(s) rejouée(s) pour cause d'infrastructure`);
		}
		everyResult.push(...results);

		const summary = summarizeScenario({
			scenarioId: scenario.id,
			title: scenario.title,
			tags: scenario.tags,
			gate: scenario.gate,
			results,
		});
		summaries.push(summary);

		// The ratchet is fed by the union of the repetitions: a check that failed
		// at least once is a failure for baseline purposes.
		const merged = new Map<string, ReturnType<typeof allResults>[number]>();
		for (const result of results) {
			for (const check of allResults(result.scored)) {
				const previous = merged.get(check.id);
				if (!previous || (previous.ok && !check.ok)) merged.set(check.id, check);
			}
		}
		const mergedResults = [...merged.values()];
		const baselineFile = `${BASELINES_DIR}/${scenario.id}.json`;
		const verdict = assertAgainstBaseline({
			scenario,
			results: mergedResults,
			baseline: readBaseline(baselineFile),
		});
		for (const message of verdict.messages) {
			notices.push(message);
			log(`  ! ${message}`);
		}
		if (!verdict.ok) failed = true;

		if (options.updateBaseline) {
			writeBaseline(
				baselineFile,
				baselineFromRun({
					scenarioId: scenario.id,
					results: mergedResults,
					behaviour: summary.behaviour.rate,
					dsl: summary.dsl.rate,
				}),
			);
			log(`  baseline écrite : ${baselineFile}`);
		}

		// ponytail: fail on the UPPER Wilson bound, not on the point estimate.
		// At n=3 a point estimate below the gate is routinely luck; only a gate
		// the interval cannot reach is evidence of a real shortfall.
		if (summary.passRate.high < scenario.gate) {
			log(
				`  ÉCHEC porte : taux de passage ${formatPercent(summary.passRate.rate)} ` +
					`(borne haute ${formatPercent(summary.passRate.high)}) < gate ${formatPercent(scenario.gate)}`,
			);
			failed = true;
		}
	}

	const report = buildReport({
		label: options.label,
		fingerprint: fingerprintOf({
			results: everyResult,
			model: env.model,
			reps: smallestN,
		}),
		scenarios: summaries,
		notices,
	});
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const written = writeReport({
		directory: REPORTS_DIR,
		basename: `${options.label}-${stamp}`,
		report,
	});
	log(`\nrapport : ${written.markdown}`);
	return failed ? 1 : 0;
}

function commandHelp(): number {
	log(
		[
			"workbench — banc d'essai de l'agent d'édition",
			"",
			"  wb:live   [--scenario <id>] [--tag <tag>] [--reps <n>] [--label <nom>]",
			"            [--timeout <ms>] [--update-baseline] [--record] [--no-persist]",
			"  wb:compare <rapport-a.json> <rapport-b.json>",
			"",
			`Chaque tour est écrit dans ${RUNS_DIR}/<label>/<scénario>/rep-N.json`,
			"(appels, document avant/après, texte final) — --no-persist pour s'en passer.",
			"",
			"La clé vient exclusivement de .env.workbench, via `node --env-file`.",
		].join("\n"),
	);
	return 0;
}

/**
 * ponytail: exported, and NOT invoked here.
 *
 * This module used to call `main()` at import time. That made importing it for
 * a unit test print the help block and — much worse — set `process.exitCode = 0`
 * asynchronously, which can overwrite a failing Vitest run's non-zero code and
 * turn a red suite green. A workbench built to catch false greens must not
 * manufacture one. The executable lives in `cli-entry.ts`; this file is a
 * side-effect-free module.
 */
export async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	let code = 0;
	switch (options.command) {
		case "run":
			code = await commandRun(options);
			break;
		case "compare":
			log("comparaison : à implémenter avec les rapports produits par `wb:live`.");
			code = 0;
			break;
		default:
			code = commandHelp();
			break;
	}
	process.exitCode = code;
}
