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
import { cassetteExists, type ReplayHandle, startRecorder, startReplay } from "./lib/cassette";
import { requireLiveEnv } from "./lib/env";
import { DEFAULT_TURN_TIMEOUT_MS } from "./lib/harness";
import { askJudge, type JudgeReading } from "./lib/judge";
import type { ModelServerHandle } from "./lib/model-server";
import {
	contextFromPersistedTurn,
	listPersistedTurns,
	persistRepetition,
	RUNS_DIR,
	readPersistedTurn,
} from "./lib/persist";
import {
	buildReport,
	fingerprintOf,
	type ScenarioReport,
	summarizeScenario,
	writeReport,
} from "./lib/report";
import { type RepetitionResult, runScenarioReps } from "./lib/runner";
import { allResults, scoreRun } from "./lib/score";
import { formatPercent, minDetectableEffect } from "./lib/stats";
import { getScenario, selectScenarios } from "./scenarios/registry";

const REPORTS_DIR = "workbench/reports";
const BASELINES_DIR = "workbench/baselines";
const CASSETTES_DIR = "workbench/cassettes";

interface Options {
	command: "run" | "judge" | "compare" | "help";
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
	/** `judge` only: rejoue les cassettes du juge au lieu d'appeler le provider.
	 *  Sans clé, sans réseau sortant, et le même verdict à chaque fois. */
	replay: boolean;
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
		replay: false,
	};
	const [command, ...rest] = argv;
	if (command === "run" || command === "judge" || command === "compare") options.command = command;
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
			case "--replay":
				options.replay = true;
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
			wire: everyResult[0]?.run.wire,
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

/**
 * ponytail: la passe du juge tourne APRÈS le run, sur `workbench/runs/`, et pas
 * pendant le tour.
 *
 * Trois raisons, dans l'ordre où elles pèsent :
 *   1. Un run live coûte de l'argent et ne se rejoue pas. Juger pendant le tour
 *      lierait chaque retouche de rubric à un nouveau run payé, ce qui revient à
 *      figer le rubric le jour où on l'écrit — c'est-à-dire le pire moment.
 *   2. `wb:l0` et `wb:l1` restent sans LLM et sans réseau. Le juge n'est jamais
 *      sur leur chemin parce qu'il n'est sur le chemin d'aucun tour.
 *   3. La même passe rejugée deux fois sur les mêmes tours est comparable ; deux
 *      runs live ne le sont pas.
 *
 * Ce que ça coûte, et qui est réel : un `wb:live` seul laisse tous les checks
 * jugés en `indéterminé`. C'est exact — ils n'ont pas été mesurés — et le
 * rapport le dit à trois endroits plutôt que de l'arrondir en vert.
 */
async function commandJudge(options: Options): Promise<number> {
	const groups = listPersistedTurns({ label: options.label, scenarioIds: options.scenarios });
	if (groups.length === 0) {
		log(
			`aucun tour sous ${RUNS_DIR}/${options.label}/ — lancez d'abord ` +
				"`npm run wb:live -- --label <label>` (les tours sont écrits par défaut).",
		);
		return 1;
	}
	// En replay la clé n'est pas lue du tout : le proxy ne sort pas de 127.0.0.1.
	const env = options.replay ? null : requireLiveEnv();
	if (env) log(`juge : modèle ${env.model} · endpoint ${env.baseUrl}`);
	else log("juge : replay de cassettes, aucun appel sortant");

	const summaries: ScenarioReport[] = [];
	const notices: string[] = [];
	let firstWire: ReturnType<typeof readPersistedTurn>["wire"] | undefined;
	let failed = false;

	for (const group of groups) {
		// ponytail: `runs/` est un répertoire, pas un registre. Un scénario renommé
		// y laisse son ancien dossier, et `getScenario` lève dessus — ce qui, non
		// rattrapé, faisait perdre les verdicts de tous les scénarios suivants pour
		// un dossier périmé que personne ne relisait.
		let scenario: ReturnType<typeof getScenario>;
		try {
			scenario = getScenario(group.scenarioId);
		} catch {
			log(`  dossier sans scénario connu : ${group.scenarioId} — ignoré.`);
			continue;
		}
		if ((scenario.judged ?? []).length === 0) continue;
		log(`\n▸ ${scenario.id} — ${(scenario.judged ?? []).length} check(s) jugé(s)`);

		const cassetteFile = `${CASSETTES_DIR}/judge-${options.label}-${scenario.id}.json`;
		if (env === null && !cassetteExists(cassetteFile)) {
			// Nommé, comme `env.ts` nomme la variable manquante : sans cette ligne
			// le replay ressort en ENOENT sur un chemin que personne n'a tapé.
			log(`  cassette absente (${cassetteFile}) — enregistrez-la avec --record. Ignoré.`);
			continue;
		}
		let replayHandle: ReplayHandle | null = null;
		let endpoint: ModelServerHandle;
		try {
			if (env === null) {
				replayHandle = await startReplay({ file: cassetteFile });
				endpoint = replayHandle;
			} else {
				endpoint = await startRecorder({
					// Le proxy, pas le provider en direct — même règle que `runner.ts` :
					// c'est le seul endroit d'où une cassette peut sortir, et le seul
					// qui transmette l'en-tête d'autorisation sans le lire.
					upstream: env.baseUrl,
					file: options.record ? cassetteFile : undefined,
					scenario: `judge-${scenario.id}`,
					provider: "openai-compatible",
					model: env.model,
				});
			}
		} catch (error) {
			// Même portée que la boucle ci-dessous : une cassette illisible ou un
			// port qui ne s'ouvre pas ne concernent qu'un scénario, et remonter
			// jetterait les verdicts des précédents.
			const message = `JUGE INTERROMPU ${scenario.id} : ${error instanceof Error ? error.message : String(error)}`;
			notices.push(message);
			log(`  ! ${message}`);
			failed = true;
			continue;
		}
		const scored: Array<{ scored: ReturnType<typeof scoreRun> }> = [];
		// ponytail: une panne reste une ERREUR — `askJudge` lève toujours sur un
		// transport mort, et c'est voulu : « le juge n'a pas répondu » n'est pas
		// « la réponse ne tranche pas ». Ce qui change est sa PORTÉE. Non bornée,
		// elle quittait `commandJudge` : aucun rapport écrit, `process.exitCode`
		// jamais posé, et tous les verdicts déjà obtenus — déjà facturés, sur une
		// passe live — perdus parce que le dernier tour a pris un 429.
		let interrompu: string | null = null;
		try {
			for (const file of group.files) {
				const turn = readPersistedTurn(file);
				firstWire ??= turn.wire;
				const context = contextFromPersistedTurn(turn);
				const readings = new Map<string, JudgeReading>();
				for (const judged of scenario.judged ?? []) {
					const reading = await askJudge({
						endpoint: {
							baseUrl: endpoint.url,
							model: env?.model ?? "cassette",
							...(env ? { apiKey: env.apiKey } : {}),
						},
						rubric: judged.rubric,
						input: { prompt: turn.prompt, answer: turn.answer, facts: judged.facts(context) },
						timeoutMs: options.timeoutMs,
					});
					readings.set(judged.id, reading);
					log(`  rep ${turn.rep} ${judged.id} : ${reading.verdict} — ${reading.reason}`);
				}
				scored.push({ scored: scoreRun(scenario, context, readings) });
			}
		} catch (error) {
			interrompu = error instanceof Error ? error.message : String(error);
		} finally {
			// ponytail: lu AVANT `close()`. Le nom affiché au lancement est celui de
			// la config ; le provider est libre de résoudre l'alias vers autre chose,
			// et il le fait. Sans cette ligne une passe entière s'attribue au modèle
			// demandé — c'est exactement l'erreur qui s'est écrite dans une PR, où
			// des verdicts rendus par `deepseek-v4-flash` ont été présentés comme
			// venant de `deepseek-chat`. Une divergence est une NOTICE, pas un
			// échec : elle n'invalide rien, elle nomme ce qui a répondu.
			const servi = endpoint.resolvedModel;
			if (env && servi && servi !== env.model) {
				const message = `MODÈLE RÉSOLU ${scenario.id} : demandé ${env.model}, a répondu ${servi}`;
				notices.push(message);
				log(`  ~ ${message}`);
			}
			endpoint.close();
		}
		try {
			// Une cassette périmée répond à une question qu'on ne pose plus : un
			// rubric retouché change le hash de la requête, et rejouer l'ancien
			// verdict serait bien pire qu'un `indéterminé`, puisqu'il tranche.
			replayHandle?.assertFresh();
		} catch (error) {
			interrompu ??= error instanceof Error ? error.message : String(error);
		}
		if (interrompu !== null) {
			const message = `JUGE INTERROMPU ${scenario.id} : ${interrompu}`;
			notices.push(message);
			log(`  ! ${message}`);
			failed = true;
		}
		if (scored.length === 0) continue;

		const summary = summarizeScenario({
			scenarioId: scenario.id,
			title: scenario.title,
			tags: scenario.tags,
			gate: scenario.gate,
			results: scored,
		});
		summaries.push(summary);

		// ponytail: une passe interrompue est LUE mais pas RATCHETÉE. Le résumé
		// entre au rapport — c'est tout l'intérêt de ne plus tout jeter — mais le
		// cliquet, lui, tirerait ses conclusions d'un `n` amputé sans le savoir :
		// « D2 semble corrigé » sur la seule répétition qui a eu le temps de
		// passer, et `--update-baseline` graverait cette moitié de mesure. Le
		// README dit déjà de ne pas retirer une entrée sur un run vert isolé ; un
		// run tronqué est pire, parce qu'il ne se voit pas.
		if (interrompu !== null) {
			log("  cliquet et baseline ignorés : la passe est incomplète sur ce scénario.");
			continue;
		}

		// Même fusion que `commandRun` : un check qui a échoué au moins une fois
		// est un échec pour le cliquet. Un indéterminé ne « gagne » sur rien — il
		// n'est retenu que si aucune répétition n'a tranché.
		const merged = new Map<string, ReturnType<typeof allResults>[number]>();
		for (const entry of scored) {
			for (const check of allResults(entry.scored)) {
				const previous = merged.get(check.id);
				if (!previous) merged.set(check.id, check);
				else if (previous.indeterminate && !check.indeterminate) merged.set(check.id, check);
				else if (previous.ok && !check.ok && !check.indeterminate) merged.set(check.id, check);
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
	}

	if (summaries.length === 0) {
		// ponytail: `failed`, pas `0`. Depuis que les pannes sont bornées au
		// scénario, on atteint cette ligne avec des scénarios TOUS interrompus —
		// et rendre 0 là-dessus annoncerait « rien à faire » sur une passe qui n'a
		// fait que tomber. C'est le vert silencieux, dans l'outil écrit contre lui.
		log(
			failed
				? "aucun scénario n'a pu être jugé : toutes les tentatives ont échoué ci-dessus."
				: "aucun scénario jugé dans cette sélection — rien à faire.",
		);
		return failed ? 1 : 0;
	}
	const report = buildReport({
		label: `${options.label}-judge`,
		fingerprint: fingerprintOf({
			// L'empreinte des TOURS relus, pas celle d'aujourd'hui : c'est elle qui
			// dit contre quel prompt système et quelle surface d'outils le verdict
			// a été rendu.
			wire: firstWire,
			model: env?.model ?? "cassette",
			reps: Math.min(...summaries.map((s) => s.reps)),
		}),
		scenarios: summaries,
		notices,
	});
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const written = writeReport({
		directory: REPORTS_DIR,
		basename: `${options.label}-judge-${stamp}`,
		report,
	});
	log(`\nrapport du juge : ${written.markdown}`);
	return failed ? 1 : 0;
}

function commandHelp(): number {
	log(
		[
			"workbench — banc d'essai de l'agent d'édition",
			"",
			"  wb:live   [--scenario <id>] [--tag <tag>] [--reps <n>] [--label <nom>]",
			"            [--timeout <ms>] [--update-baseline] [--record] [--no-persist]",
			"  wb:judge  --label <nom> [--scenario <id>] [--record] [--replay]",
			"            [--update-baseline]",
			"  wb:compare <rapport-a.json> <rapport-b.json>",
			"",
			`Chaque tour est écrit dans ${RUNS_DIR}/<label>/<scénario>/rep-N.json`,
			"(appels, document avant/après, texte final) — --no-persist pour s'en passer.",
			"",
			"`judge` relit ces tours et fait trancher les checks jugés : conforme,",
			"fautif, ou indéterminé. Sans cette passe ils restent indéterminés, ce qui",
			"est exact — ils n'ont pas été mesurés — et jamais compté comme un passage.",
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
		case "judge":
			code = await commandJudge(options);
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
