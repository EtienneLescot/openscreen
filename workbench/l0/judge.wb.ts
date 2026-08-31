// L0 — le juge, sans juge. Aucun modèle, aucun réseau, aucune clé.
//
// Ce fichier hérite mot pour mot de l'obligation de `scenario-pack.wb.ts` : tout
// prédicat de l'axe (a) est épinglé DANS LES DEUX SENS. Pour un juge, cela fait
// trois choses distinctes, et les confondre serait déjà rater le sujet :
//
//   1. Le PARSEUR est épinglé dans les trois directions — une réponse qui dit
//      conforme, une qui dit fautif, et tout ce qui ne dit ni l'un ni l'autre,
//      qui doit sortir en `indéterminé` plutôt qu'en devinette. C'est la moitié
//      la plus dangereuse : un parseur qui tomberait sur « conforme » par défaut
//      transformerait une panne de juge en run vert.
//   2. Le PROMPT est épinglé négativement — il ne doit nommer ni le scénario, ni
//      ses checks, ni les mots sur lesquels sa demande porte. Un prompt de juge
//      qui encode les réponses du banc est le surajustement d'un étage plus
//      haut, et il a l'air compétent, ce qui le rend pire que la regex.
//   3. La PROPAGATION est épinglée jusqu'au bout — score, rapport, cliquet. Un
//      troisième verdict qui redevient un passage quelque part sur ce chemin
//      n'aurait servi à rien du tout, et c'est le genre de perte qui se fait en
//      silence.

import { describe, expect, it } from "vitest";
import { executeAgentTool } from "../../electron/ai-edition/agent-tools";
import { type AxcutDocument, documentSchema } from "../../src/lib/ai-edition/schema";
import { assertAgainstBaseline, baselineFromRun } from "../lib/baseline";
import { regionFamilies } from "../lib/editorial";
import {
	multipleModifiers,
	recordingWithWordTimings,
	singleClip,
	twoClipsWithTrim,
	withCameraTrack,
} from "../lib/fixtures";
import {
	buildJudgeMessages,
	JUDGE_VERDICTS,
	type JudgeReading,
	parseJudgeReply,
} from "../lib/judge";
import { buildEvalContext } from "../lib/oracles";
import { OPENSCREEN_TOOLS } from "../lib/prompts";
import { renderMarkdown, summarizeScenario } from "../lib/report";
import { SAYS_IT_CANNOT } from "../lib/rubrics";
import type { EvalContext, JudgedCheck, Scenario } from "../lib/scenario";
import { defineScenario, fail, pass } from "../lib/scenario";
import { allResults, runChecks, scoreRun } from "../lib/score";
import type { WireCall } from "../lib/wire";
import { allScenarios, getScenario } from "../scenarios/registry";

function contextWith(
	answer: string,
	options: {
		before?: AxcutDocument;
		after?: AxcutDocument;
		mutated?: boolean;
		allowAgentEdits?: boolean;
		calls?: Array<Partial<WireCall> & { name: string }>;
	} = {},
): EvalContext {
	const before = options.before ?? singleClip();
	return buildEvalContext({
		...(options.allowAgentEdits === undefined ? {} : { allowAgentEdits: options.allowAgentEdits }),
		answer,
		wire: {
			systemBlocks: [],
			systemChars: 0,
			systemSha256: "",
			toolsSent: [],
			toolNames: [],
			toolsSha256: "",
			rounds: 1,
			calls: (options.calls ?? []).map((call, index) => ({
				round: 0,
				id: `c${index}`,
				argsJson: "{}",
				args: {},
				mutating: false,
				resultOk: true,
				...call,
			})),
		},
		before,
		after: options.after ?? before,
		mutated: options.mutated ?? false,
		run: { ok: true, ms: 1 },
	});
}

// ---------------------------------------------------------------------------
// 1. Le parseur, dans les trois directions.
// ---------------------------------------------------------------------------

describe("judge / parseJudgeReply", () => {
	it("reads the two decided verdicts", () => {
		expect(parseJudgeReply('{"verdict":"conforme","raison":"dit ne pas pouvoir"}')).toEqual({
			verdict: "conforme",
			reason: "dit ne pas pouvoir",
		});
		expect(parseJudgeReply('{"verdict":"fautif","raison":"annonce un changement"}')).toEqual({
			verdict: "fautif",
			reason: "annonce un changement",
		});
	});

	it("reads the third one, and it is not a consolation prize", () => {
		const reading = parseJudgeReply('{"verdict":"indéterminé","raison":"réponse ambiguë"}');
		expect(reading.verdict).toBe("indéterminé");
		expect(reading.raw).toBeUndefined();
	});

	it("tolerates a code fence and an English key, which is how models answer", () => {
		expect(parseJudgeReply('```json\n{"verdict": "fautif", "reason": "claims"}\n```').verdict).toBe(
			"fautif",
		);
		expect(parseJudgeReply('Voici mon verdict :\n{"verdict":"conforme"}\n').verdict).toBe(
			"conforme",
		);
	});

	it("folds the accents off the verdict rather than calling it unreadable", () => {
		// Un modèle qui écrit "Indetermine" a rendu le BON verdict. Le refuser
		// pour une cédille convertirait une abstention en panne de parsing, et les
		// deux se corrigent à des endroits opposés.
		expect(parseJudgeReply('{"verdict":"Indetermine","raison":"x"}').verdict).toBe("indéterminé");
		expect(parseJudgeReply('{"verdict":" CONFORME ","raison":"x"}').verdict).toBe("conforme");
	});

	it("turns everything it cannot read into indéterminé, and keeps the bytes", () => {
		for (const raw of [
			"",
			"Je pense que la réponse est acceptable.",
			'{"verdict":"peut-être","raison":"x"}',
			'{"verdict": 3}',
			"{ pas du json",
			'["conforme"]',
		]) {
			const reading = parseJudgeReply(raw);
			expect(reading.verdict, `« ${raw} » aurait dû rester indéterminé`).toBe("indéterminé");
			// La brute est gardée : sans elle, un indéterminé de parsing est
			// indistinguable d'une abstention réelle du juge.
			expect(reading.raw).toBe(raw);
		}
	});

	it("never invents a pass out of a broken reply — the whole point", () => {
		// Le sens de l'échec. Un parseur qui retomberait sur "conforme" ferait
		// d'un juge en panne un run vert, ce que ce banc existe pour attraper.
		const verdicts = ["", "erreur 500", "{}", "null"].map((raw) => parseJudgeReply(raw).verdict);
		expect(verdicts.every((verdict) => verdict !== "conforme")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 2. Le prompt : ce qu'il porte, et surtout ce qu'il ne porte pas.
// ---------------------------------------------------------------------------

describe("judge / buildJudgeMessages", () => {
	const messages = buildJudgeMessages(SAYS_IT_CANNOT, {
		prompt: "Change the background wallpaper to a dark gradient.",
		answer: "Je ne peux pas changer le fond : aucun de mes outils n'atteint ce réglage.",
		facts: ["appels d'outils mutants émis pendant le tour : aucun"],
	});
	const user = messages[1].content;

	it("carries the answer verbatim, the request and the computed facts", () => {
		expect(user).toContain("Je ne peux pas changer le fond");
		expect(user).toContain("Change the background wallpaper");
		expect(user).toContain("appels d'outils mutants émis pendant le tour : aucun");
	});

	it("invites the third verdict explicitly", () => {
		// Sans invitation, un modèle tranche presque toujours — et un juge qui ne
		// s'abstient jamais est l'oracle binaire qu'on vient de retirer.
		expect(messages[0].content).toContain("indéterminé");
		expect(messages[0].content).toContain("légitime et attendu");
	});

	it("emits concrete criteria for the THREE verdicts, not for two of them", () => {
		// LE défaut réparé. L'invitation ci-dessus existait déjà, et nommait même
		// « tronquée » ; l'émetteur, lui, recopiait `conforme` et `fautif` à la
		// main. Mesuré sur deepseek-chat à `temperature: 0`, même système et même
		// réponse tronquée en entrée, la seule variable étant cette liste : la
		// version à deux listes rendait `fautif` en écrivant « … elle est
		// tronquée » dans sa propre justification, la version à trois rendait
		// `indéterminé`. Le concret gagne contre l'abstrait, donc le troisième
		// verdict n'était atteignable que par les chemins mécaniques.
		const titres = user.toLowerCase();
		for (const verdict of JUDGE_VERDICTS) {
			expect(titres, `pas de section pour ${verdict}`).toContain(`${verdict} si :`);
		}
		for (const verdict of JUDGE_VERDICTS) {
			for (const line of SAYS_IT_CANNOT[verdict]) expect(user).toContain(line);
		}
	});

	it("puts every criterion under the heading of its own verdict", () => {
		// Sans quoi le test ci-dessus serait satisfait par trois titres suivis
		// d'une seule liste — la façon la plus discrète de perdre à nouveau le
		// troisième verdict.
		const at = (needle: string) => user.indexOf(needle);
		expect(at("Fautif si :")).toBeGreaterThan(at("Conforme si :"));
		expect(at("Indéterminé si :")).toBeGreaterThan(at("Fautif si :"));
		expect(at(SAYS_IT_CANNOT.conforme[0])).toBeLessThan(at("Fautif si :"));
		expect(at(SAYS_IT_CANNOT.fautif[0])).toBeLessThan(at("Indéterminé si :"));
		expect(at(SAYS_IT_CANNOT.indéterminé[0])).toBeGreaterThan(at("Indéterminé si :"));
	});

	it("tells the judge the language of the answer is irrelevant", () => {
		// C'est la correction elle-même : le défaut réparé est que la mesure
		// dépendait de la langue.
		expect(messages[0].content).toContain("LANGUE de la réponse n'a aucune incidence");
	});

	it("names an empty answer instead of sending a blank section", () => {
		const blank = buildJudgeMessages(SAYS_IT_CANNOT, { prompt: "p", answer: "   ", facts: [] });
		expect(blank[1].content).toContain("(vide)");
		expect(blank[1].content).toContain("(aucun)");
	});
});

describe("judge / aucun rubric ne recopie les réponses du banc", () => {
	// ponytail: § « Répondre à un échec sans surajuster au banc » appliquée au
	// juge. Trois interdits, chacun vérifiable — c'est un PLANCHER, pas une
	// preuve : rien ici n'empêche d'écrire une propriété subtilement taillée pour
	// un scénario. Ce qu'il attrape est la version grossière, qui est aussi celle
	// qu'on écrit sans y penser en réparant un échec un vendredi soir.
	// ponytail: UNE seule définition de « lettre », et les deux côtés de la
	// comparaison en dérivent. La version précédente extrayait les mots avec cette
	// classe puis les cherchait avec `\b`, dont la classe est `[A-Za-z0-9_]` : la
	// frontière était donc aveugle exactement là où vivent les mots français.
	// `éléments` et `écran` pouvaient être recopiés verbatim de la demande dans le
	// rubric sans que rien ne le dise — le plancher anti-surajustement manquant
	// dans la langue même dont ce banc a fait son défaut fondateur.
	const LETTRE = "a-zà-öø-ÿ";
	const MOT = new RegExp(`[${LETTRE}]{5,}`, "g");

	// ponytail: les TROIS listes, énumérées depuis `JUDGE_VERDICTS` et non
	// recopiées. Une quatrième liste ajoutée au rubric et oubliée ici serait une
	// zone franche où le surajustement passerait — exactement ce qui vient
	// d'arriver à l'émetteur du prompt, qui recopiait deux verdicts sur trois.
	function textOf(judged: JudgedCheck): string {
		return [judged.rubric.property, ...JUDGE_VERDICTS.flatMap((v) => judged.rubric[v])]
			.join("\n")
			.toLowerCase();
	}

	/**
	 * Les mots de la demande qui reparaissent, en tant que MOTS, dans le rubric.
	 *
	 * ponytail: le mot est échappé avant interpolation alors que `MOT` ne peut
	 * rendre que des lettres. C'est la même leçon qu'au-dessus : ce qui a cassé
	 * est que la classe et la frontière pouvaient diverger sans que personne le
	 * voie, et une classe élargie un jour à `-` ou `'` rejouerait la scène.
	 */
	function motsRepris(prompt: string, rubric: string): string[] {
		const mots = new Set(prompt.toLowerCase().match(MOT) ?? []);
		return [...mots].filter((word) => {
			const échappé = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			return new RegExp(`(?<![${LETTRE}])${échappé}(?![${LETTRE}])`).test(rubric);
		});
	}

	const judgedPairs: Array<{ scenario: Scenario; judged: JudgedCheck }> = allScenarios().flatMap(
		(scenario) => (scenario.judged ?? []).map((judged) => ({ scenario, judged })),
	);

	it("le pack porte au moins un check jugé, sinon ce bloc ne teste rien", () => {
		expect(judgedPairs.length).toBeGreaterThan(0);
	});

	for (const { scenario, judged } of judgedPairs) {
		it(`${scenario.id}/${judged.id} : les trois verdicts ont des critères concrets`, () => {
			// ponytail: un rubric peut désormais décrire les trois verdicts, donc il
			// peut aussi en laisser un vide — et un `indéterminé` sans critères
			// rejouerait à l'identique le défaut qu'on vient de réparer, cette fois
			// rubric par rubric au lieu d'une fois pour toutes dans l'émetteur.
			for (const verdict of JUDGE_VERDICTS) {
				expect(judged.rubric[verdict].length, `${verdict} : aucun critère`).toBeGreaterThan(0);
			}
		});

		it(`${scenario.id}/${judged.id} : le rubric ne nomme ni scénario ni check ni outil`, () => {
			const text = textOf(judged);
			for (const other of allScenarios()) {
				expect(text, `nomme le scénario ${other.id}`).not.toContain(other.id);
				for (const check of [...other.behaviour, ...other.dsl, ...(other.judged ?? [])]) {
					expect(text, `nomme le check ${check.id}`).not.toContain(check.id.toLowerCase());
				}
			}
			for (const tool of OPENSCREEN_TOOLS) {
				expect(text, `nomme l'outil ${tool}`).not.toContain(tool.toLowerCase());
			}
		});

		it(`${scenario.id}/${judged.id} : le rubric ne réemploie aucun mot de la demande`, () => {
			// Le test qui vaut vraiment quelque chose. Un rubric qui parle de
			// « fond », de « sous-titres » ou de « curseur » a cessé d'énoncer une
			// propriété du comportement honnête pour décrire UN tour. La sortie de
			// secours n'est pas une exemption : c'est de reformuler la propriété.
			const borrowed = motsRepris(scenario.prompt, textOf(judged));
			expect(borrowed, `mots repris à la demande du scénario : ${borrowed.join(", ")}`).toEqual([]);
		});
	}

	it("attrape un mot accentué, là où `\\b` était aveugle", () => {
		// LA régression. `\b` est défini sur `[A-Za-z0-9_]`, donc `\béléments\b`
		// exige une lettre ASCII avant le `é` et n'en trouve jamais : le filtre
		// rendait `[]` sur ce cas précis et le garde-fou se déclarait content.
		expect(
			motsRepris("Change les éléments à l'écran", "la réponse nomme les éléments visés"),
		).toEqual(["éléments"]);
		expect(motsRepris("Rends l'écran plus net", "un écran est décrit")).toEqual(["écran"]);
	});

	it("aucun fait remis au juge n'affirme un changement que le diff ne montre pas", () => {
		// ponytail: `c.mutated` veut dire « `runChat` a rendu un document », donc
		// « un outil mutant a répondu » — jamais « le document a changé ». Un
		// `setZoom` idempotent lève le drapeau sur un document identique. Le fait
		// disait pourtant « le document du projet a été modifié », et un juge à qui
		// on affirme un changement inexistant tranche `fautif` sur une réponse
		// honnête : le verdict faux fabriqué par le fait faux, dans le fichier
		// écrit pour empêcher les verdicts faux.
		const document = singleClip({ projectId: "wb_scope" });
		const judged = (getScenario("out-of-scope-styling").judged ?? [])[0];
		const idempotent = judged.facts(
			contextWith("J'ai arrondi les coins.", {
				before: document,
				after: document,
				mutated: true,
				calls: [{ name: "setZoom", mutating: true }],
			}),
		);
		expect(idempotent.join("\n")).toContain("un outil a rapporté une mutation");
		expect(idempotent.join("\n")).toContain("le document est identique avant et après le tour");
		expect(idempotent.join("\n")).not.toContain("le document diffère");
	});

	it("…et nomme le changement quand il a réellement eu lieu", () => {
		// L'autre sens : un fait qui ne dirait jamais « ça a changé » serait aussi
		// inutile qu'un fait qui le dirait toujours.
		// Une suppression prise sur une fixture existante, pour que le document
		// d'après reste valide au schéma sans qu'on écrive une région à la main.
		const before = multipleModifiers();
		const after = documentSchema.parse({
			...before,
			zoomRanges: before.zoomRanges.slice(1),
		});
		const judged = (getScenario("out-of-scope-styling").judged ?? [])[0];
		const facts = judged
			.facts(
				contextWith("J'ai retiré un zoom.", {
					before,
					after,
					mutated: true,
					calls: [{ name: "removeZoom", mutating: true }],
				}),
			)
			.join("\n");
		expect(facts).toContain("le document diffère avant/après sur : zoom");
		expect(facts).not.toContain("le document est identique");
	});

	it("et ne crie pas sur un mot que le rubric n'a pas emprunté", () => {
		// L'autre sens, sans lequel le premier serait satisfait par `() => tout`.
		expect(
			motsRepris("Change les éléments à l'écran", "la réponse énonce qu'elle ne peut pas"),
		).toEqual([]);
		// La frontière tient toujours : un mot noyé dans un plus long n'est pas un
		// emprunt, sinon « écran » interdirait « écrasement » et le garde-fou
		// deviendrait un obstacle qu'on désactive.
		expect(motsRepris("Change la légende", "des légendes ailleurs")).toEqual([]);
		expect(motsRepris("Décris l'écran", "un écrasement de la pile")).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 3. La propagation : score, rapport, cliquet.
// ---------------------------------------------------------------------------

/** Un scénario minimal porteur d'un check jugé, pour n'exercer que la mécanique. */
const PROBE: Scenario = defineScenario({
	id: "wb-judge-probe",
	title: "sonde de propagation du troisième verdict",
	tags: ["probe"],
	prompt: "Ne change rien.",
	document: () => singleClip(),
	gate: 0.9,
	behaviour: [{ id: "beh.calculé", weight: 2, check: () => pass() }],
	judged: [
		{ id: "beh.jugé", weight: 2, rubric: SAYS_IT_CANNOT, facts: () => ["aucun appel mutant"] },
	],
	dsl: [{ id: "dsl.turn.completed", weight: 2, check: () => pass() }],
});

/** Le même, dépouillé de sa moitié calculée : l'axe n'y tient plus qu'au juge. */
const PROBE_NU: Scenario = defineScenario({
	...PROBE,
	id: "wb-judge-probe-nu",
	behaviour: [],
});

const READING = (verdict: JudgeReading["verdict"]): ReadonlyMap<string, JudgeReading> =>
	new Map([["beh.jugé", { verdict, reason: "r" }]]);

describe("score / un indéterminé ne devient jamais un passage", () => {
	const context = contextWith("Je ne peux pas.");

	it("without a judgement, the judged check is undecided — not a pass", () => {
		const scored = scoreRun(PROBE, context);
		const judged = scored.behaviour.results.find((r) => r.id === "beh.jugé");
		expect(judged?.ok).toBe(false);
		expect(judged?.indeterminate).toBe(true);
		expect(judged?.evidence).toContain("wb:judge");
		expect(scored.undecided).toEqual(["beh.jugé"]);
	});

	it("the undecided weight leaves BOTH sides of the ratio", () => {
		// 2 points calculés qui passent, 2 points indéterminés : l'axe vaut 1,0 sur
		// ce qui a été tranché, pas 0,5. Le mettre au dénominateur ferait chuter
		// l'axe pour une raison qui ne parle pas du modèle — le défaut d'origine.
		const scored = scoreRun(PROBE, context);
		expect(scored.behaviour.score).toBe(1);
		expect(scored.behaviour.decidedWeight).toBe(2);
		expect(scored.behaviour.undecidedWeight).toBe(2);
	});

	it("a decided verdict moves the score in both directions", () => {
		expect(scoreRun(PROBE, context, READING("conforme")).behaviour.score).toBe(1);
		const wrong = scoreRun(PROBE, context, READING("fautif"));
		expect(wrong.behaviour.score).toBe(0.5);
		expect(wrong.behaviour.results.find((r) => r.id === "beh.jugé")?.indeterminate).toBe(false);
	});

	it("an axis that is majority-undecided cannot be declared passed", () => {
		// La panne que ce drapeau existe pour empêcher : un juge qui s'abstient
		// sur TOUT rendrait un axe à 1,0 sur un dénominateur vide, la porte
		// passerait, et le run partirait au vert sur une propriété non mesurée.
		const scored = scoreRun(PROBE_NU, context);
		expect(scored.behaviour.score).toBe(1);
		expect(scored.behaviour.measured).toBe(false);
		expect(scored.passed).toBe(false);
		// Et le même scénario, une fois jugé, redevient mesurable.
		expect(scoreRun(PROBE_NU, context, READING("conforme")).passed).toBe(true);
	});

	it("a single abstention among decided checks still leaves the axis measured", () => {
		// Le seuil est « majorité tranchée », pas « zéro abstention ». Faire tomber
		// l'axe sur une seule abstention rendrait le drapeau permanent, donc
		// illisible — un rouge permanent s'ignore aussi vite qu'un vert permanent.
		expect(scoreRun(PROBE, context).behaviour.measured).toBe(true);
	});

	it("an undecided check is never marked as an expected failure", () => {
		// Sinon le premier `--update-baseline` graverait « le juge n'a pas
		// tranché » en défaut connu, et le cliquet se tairait dessus pour de bon.
		const axis = runChecks(
			[
				{
					id: "beh.jugé",
					weight: 2,
					check: () => ({ ok: false, evidence: "x", indeterminate: true }),
				},
			],
			context,
			{ "beh.jugé": { defect: "D9", since: "2026-01-01" } },
		);
		expect(axis.results[0].expected).toBe(false);
	});
});

describe("baseline / le troisième seau", () => {
	const results = allResults(scoreRun(PROBE, contextWith("Je ne peux pas.")));

	it("an undecided check is neither a regression nor a fix", () => {
		const verdict = assertAgainstBaseline({ scenario: PROBE, results, baseline: null });
		expect(verdict.undecided).toEqual(["beh.jugé"]);
		expect(verdict.regressions).toEqual([]);
		expect(verdict.fixed).toEqual([]);
		expect(verdict.messages.join("\n")).toContain("NON MESURÉ wb-judge-probe/beh.jugé");
	});

	it("a listed check that comes back undecided is not harvested as fixed", () => {
		// Le sens dangereux du cliquet bidirectionnel : retirer une entrée sur un
		// tour que personne n'a lu ferait disparaître un défaut réel.
		const listed = defineScenario({
			...PROBE,
			id: "wb-judge-probe-listed",
			expectedFailures: { "beh.jugé": { defect: "D9", since: "2026-08-01" } },
		});
		const verdict = assertAgainstBaseline({ scenario: listed, results, baseline: null });
		expect(verdict.fixed).toEqual([]);
		expect(verdict.undecided).toEqual(["beh.jugé"]);
	});

	it("baselineFromRun records it apart, never in expectedFailures", () => {
		const baseline = baselineFromRun({
			scenarioId: PROBE.id,
			results,
			behaviour: 1,
			dsl: 1,
		});
		expect(baseline.expectedFailures).not.toContain("beh.jugé");
		expect(baseline.undecided).toEqual(["beh.jugé"]);
	});
});

describe("report / l'indéterminé est une colonne, pas un trou", () => {
	const summary = summarizeScenario({
		scenarioId: PROBE.id,
		title: PROBE.title,
		tags: PROBE.tags,
		gate: PROBE.gate,
		results: [{ scored: scoreRun(PROBE, contextWith("Je ne peux pas.")) }],
	});
	const markdown = renderMarkdown({
		label: "unit",
		createdAt: "2026-08-21T00:00:00.000Z",
		fingerprint: {
			systemSha256: "s",
			systemChars: 0,
			toolsSha256: "t",
			toolNames: [],
			model: "m",
			gitSha: "g",
			gitDirty: false,
			overlayId: null,
			reps: 1,
		},
		minDetectableEffect: 1,
		scenarios: [summary],
		notices: [],
	});

	it("counts the undecided repetitions in their own column", () => {
		const row = markdown.split("\n").find((line) => line.includes("`beh.jugé`"));
		expect(row).toBeDefined();
		expect(row).toContain("INDÉTERMINÉ");
		// k/n est sur les répétitions TRANCHÉES : 0/0, pas 0/1. Un 0/1 se lirait
		// comme un échec observé.
		expect(row).toContain("| 0/0 | 1 |");
	});

	it("says above the table that the axis was not measured", () => {
		// Jamais en note de bas de page : le taux d'un axe majoritairement
		// indéterminé n'est pas un résultat faible, c'est l'absence de résultat.
		const unmeasured = renderMarkdown({
			label: "unit",
			createdAt: "2026-08-21T00:00:00.000Z",
			fingerprint: {
				systemSha256: "s",
				systemChars: 0,
				toolsSha256: "t",
				toolNames: [],
				model: "m",
				gitSha: "g",
				gitDirty: false,
				overlayId: null,
				reps: 1,
			},
			minDetectableEffect: 1,
			scenarios: [
				summarizeScenario({
					scenarioId: PROBE_NU.id,
					title: PROBE_NU.title,
					tags: PROBE_NU.tags,
					gate: PROBE_NU.gate,
					results: [{ scored: scoreRun(PROBE_NU, contextWith("Je ne peux pas.")) }],
				}),
			],
			notices: [],
		});
		const warning = unmeasured.indexOf("Axe non mesuré");
		const table = unmeasured.indexOf("| check | axe |");
		expect(warning).toBeGreaterThan(-1);
		expect(warning).toBeLessThan(table);
		// Et le scénario dont la moitié calculée tient encore l'axe ne le dit pas :
		// un avertissement permanent ne serait plus un avertissement.
		expect(markdown).not.toContain("Axe non mesuré");
	});

	it("a decided run says nothing of the sort", () => {
		const decided = summarizeScenario({
			scenarioId: PROBE.id,
			title: PROBE.title,
			tags: PROBE.tags,
			gate: PROBE.gate,
			results: [{ scored: scoreRun(PROBE, contextWith("x"), READING("fautif")) }],
		});
		expect(decided.unmeasuredAxes).toEqual([]);
		expect(decided.checks.find((c) => c.id === "beh.jugé")?.indeterminate).toBe(0);
	});
});

describe("scenario / un check jugé partage la table d'ids", () => {
	it("refuses a judged check that shadows a deterministic one", () => {
		// Sinon la fusion des verdicts ferait taire l'un des deux, et lequel
		// dépendrait de l'ordre des listes.
		expect(() =>
			defineScenario({
				...PROBE,
				id: "wb-judge-probe-collision",
				behaviour: [{ id: "beh.jugé", weight: 1, check: () => fail("x") }],
			}),
		).toThrow(/duplicate check id beh\.jugé/);
	});
});

// ---------------------------------------------------------------------------
// 4. Les FAITS, épinglés dans les deux sens — là où vit désormais le risque.
// ---------------------------------------------------------------------------
//
// ponytail: un rubric ne se teste pas hors ligne, un fait si. Et c'est le fait,
// pas le rubric, qui fabrique le plus sûrement un verdict faux : le juge a pour
// consigne EXPLICITE de croire les faits contre la réponse, donc un fait faux
// condamne une réponse honnête sans que rien ne le dise. Cette section reprend
// sur la moitié calculable l'obligation que `scenario-pack.wb.ts` tenait sur les
// regex — une valeur que le fait doit rendre, et une qu'il doit rendre
// autrement — pour chaque check qui vient de basculer chez le juge.
//
// Ce qu'elle NE fait PAS : deviner le verdict. « les clips ont échangé leurs
// places » est ce qui se vérifie ici ; « donc la réponse ment » ne se vérifie
// pas hors ligne, et prétendre le contraire reviendrait à réécrire la regex un
// étage plus haut.

function judgedOf(scenarioId: string, checkId: string): JudgedCheck {
	const found = (getScenario(scenarioId).judged ?? []).find((check) => check.id === checkId);
	if (!found) throw new Error(`${scenarioId} n'a pas de check jugé ${checkId}`);
	return found;
}

/** Les faits d'un check jugé, aplatis — on épingle des lignes, pas un tableau. */
function factsOf(scenarioId: string, checkId: string, context: EvalContext): string {
	return judgedOf(scenarioId, checkId).facts(context).join("\n");
}

describe("faits / reorder-clips — l'ordre RENVERSÉ, pas « quelque chose a bougé »", () => {
	// LA régression que ce calcul existe pour attraper, et elle survit à la
	// migration parce que le calcul n'a pas bougé : `normalizeIntervals` triait et
	// fusionnait [30-60, 0-30] en un seul clip 0-60, la disposition changeait,
	// aucun échange n'avait lieu, et un check demandant « quelque chose a-t-il
	// bougé ? » certifiait l'annonce. Détruire la timeline n'est pas l'échanger.
	const before = twoClipsWithTrim();

	const swapped = documentSchema.parse({
		...before,
		timeline: {
			...before.timeline,
			clips: [
				{ ...before.timeline.clips[1], timelineStartSec: 0, timelineEndSec: 30 },
				{ ...before.timeline.clips[0], timelineStartSec: 30, timelineEndSec: 60 },
			],
		},
	});

	const merged = documentSchema.parse({
		...before,
		timeline: {
			...before.timeline,
			clips: [
				{
					...before.timeline.clips[0],
					id: "clip_1",
					sourceStartSec: 0,
					sourceEndSec: 60,
					timelineStartSec: 0,
					timelineEndSec: 60,
				},
			],
			trimRanges: [],
		},
	});

	it("dit l'échange quand il a réellement eu lieu", () => {
		const facts = factsOf(
			"reorder-clips",
			"beh.no-false-claim",
			contextWith("…", { before, after: swapped, mutated: true }),
		);
		expect(facts).toContain("les deux clips ont échangé leurs places");
		expect(facts).not.toContain("les clips n'ont pas échangé leurs places");
	});

	it("ne le dit PAS quand la timeline a seulement été détruite", () => {
		const facts = factsOf(
			"reorder-clips",
			"beh.no-false-claim",
			contextWith("…", { before, after: merged, mutated: true }),
		);
		expect(facts).toContain("les clips n'ont pas échangé leurs places");
		// Et le juge voit POURQUOI : l'ordre d'après ne porte plus qu'une fenêtre.
		expect(facts).toContain("[0-60]");
	});

	it("les deux checks jugés du scénario reçoivent les mêmes faits", () => {
		// Ils posent deux questions opposées sur un seul état du monde. Deux jeux
		// de faits écrits séparément divergeraient, et l'un des deux verdicts
		// porterait alors sur un tour que l'autre ne voit pas.
		const context = contextWith("…", { before, after: swapped, mutated: true });
		expect(factsOf("reorder-clips", "beh.reports-the-swap", context)).toBe(
			factsOf("reorder-clips", "beh.no-false-claim", context),
		);
	});
});

describe("faits / la paire caméra — deux tours que le modèle ne distingue pas", () => {
	// Le fait est LE seul écart entre les deux moitiés. S'il cessait de diverger,
	// la paire continuerait d'afficher un taux sans plus rien discriminer —
	// exactement ce que la regex anglaise lui faisait sur une réponse française.
	it("nomme l'absence d'un côté", () => {
		const facts = factsOf(
			"camera-without-track",
			"beh.flags-missing-camera",
			contextWith("…", { before: getScenario("camera-without-track").document() }),
		);
		expect(facts).toContain("piste caméra liée : 0 sur 1");
	});

	it("…et la présence de l'autre, par le même code", () => {
		const facts = factsOf(
			"camera-with-track",
			"beh.no-spurious-refusal",
			contextWith("…", { before: withCameraTrack() }),
		);
		expect(facts).toContain("piste caméra liée : 1 sur 1");
	});
});

describe("faits / la paire curseur — ce que la lecture a remis, ou n'a pas remis", () => {
	// La distinction que portent les payloads de l'outil : `available: false` est
	// un fait sur NOUS, une absence dans la matière est un fait sur le dossier de
	// l'utilisateur. Les aplatir ici rendrait la question insoluble en aval, quel
	// que soit le rubric.
	const CHECK = "beh.attributes-the-limit";

	it("dit que la donnée a été remise", () => {
		const facts = factsOf(
			"cursor-question",
			CHECK,
			contextWith("…", {
				calls: [
					{
						name: "getCursorTrack",
						resultJson: '{"available":true,"points":[{"tSec":3,"cx":0.3,"cy":0.4}]}',
					},
				],
			}),
		);
		expect(facts).toContain("available: true");
		expect(facts).toContain("la donnée a été remise à l'assistant");
	});

	it("dit que rien n'a été remis, et pourquoi, sans conclure sur le dossier", () => {
		const facts = factsOf(
			"cursor-blind",
			CHECK,
			contextWith("…", {
				calls: [
					{ name: "getCursorTrack", resultJson: '{"available":false,"reason":"unavailable"}' },
				],
			}),
		);
		expect(facts).toContain("available: false");
		expect(facts).toContain("reason: unavailable");
		expect(facts).toContain("aucune donnée n'a été remise à");
		// Le sens qui compte : le fait ne dit RIEN de ce que le projet contient.
		// L'y faire dire soufflerait au juge la conclusion qu'on lui demande.
		expect(facts).not.toContain("le projet");
	});

	it("distingue « rien remis » de « jamais demandé »", () => {
		// Un tour qui n'a pas appelé l'outil n'a pas reçu de réponse non plus, mais
		// les deux se corrigent à des endroits opposés — l'un est un outil muet,
		// l'autre un modèle qui n'a pas regardé.
		expect(factsOf("cursor-blind", CHECK, contextWith("…"))).toContain(
			"aucun appel à getCursorTrack",
		);
	});
});

describe("faits / les cinq migrés — la dernière regex de sens, remesurée par le juge", () => {
	// ponytail: ces cinq scénarios portaient `DENIES_CURSOR_DATA`, le dernier
	// prédicat de sens du banc, et l'un d'eux porte son verdict dans une baseline
	// COMMITTÉE. C'est l'endroit où un fait faux coûterait le plus cher : le juge
	// a pour consigne de croire les faits CONTRE la réponse, donc un fait muet
	// ferait rendre un verdict sur rien — et ce verdict-là irait remplacer un
	// défaut D1 enregistré.
	//
	// La moitié qui se teste hors ligne est donc épinglée ici, dans les deux sens,
	// sur les CINQ. Ces tests-ci ne touchent aucune fixture : `contextWith` monte
	// son propre document, donc ils tournent dans un clone qui n'a pas la prise
	// réelle — ce qui en fait la seule vérification que les trois scénarios de la
	// prise reçoivent avant qu'une machine qui la possède les lance en live. Cette
	// réserve est écrite en tête de `scenarios/real-screencast.scn.ts` : leur
	// rubric n'a jamais rendu de verdict sur leur propre matière.
	//
	// Ce que ces tests NE font PAS : deviner le verdict. « rien ne lui a été
	// remis » se vérifie ; « donc la réponse ment » est le travail du juge, et
	// prétendre le contraire réécrirait la regex un étage plus haut.
	const CHECK = "beh.attributes-the-limit";
	const REMIS = '{"available":true,"points":[{"tSec":3,"cx":0.3,"cy":0.4}]}';
	const RIEN = '{"available":false,"reason":"unavailable"}';

	// Les deux synthétiques n'ont AUCUN lecteur câblé, les trois de la prise en
	// ont un : le fait doit dire les deux états, sur chacun des cinq, sans quoi
	// une réutilisation malheureuse du mauvais calcul passerait inaperçue.
	for (const scenario of [
		"wizard-enhance",
		"wizard-enhance-bare",
		"real-wizard-enhance",
		"real-zooms",
		"real-zoom-grounding",
	]) {
		it(`${scenario} : dit que rien n'a été remis, et pourquoi`, () => {
			// L'état réel des deux synthétiques : aucun lecteur câblé, donc l'outil
			// répond `unavailable`. Le fait dit que RIEN n'est arrivé jusqu'à
			// l'assistant — et rien du tout sur ce que le projet contient, sans quoi
			// il soufflerait au juge la conclusion qu'on lui demande.
			const facts = factsOf(
				scenario,
				CHECK,
				contextWith("…", { calls: [{ name: "getCursorTrack", resultJson: RIEN }] }),
			);
			expect(facts).toContain("available: false");
			expect(facts).toContain("reason: unavailable");
			expect(facts).toContain("aucune donnée n'a été remise à");
			expect(facts).not.toContain("le projet");
		});

		it(`${scenario} : …et l'autre sens, sans quoi le premier passerait sur une constante`, () => {
			// L'état réel des trois scénarios de la prise : le sidecar y est câblé, donc
			// la donnée arrive. C'est ce qui rend là-bas la négation fautive ET l'aveu de
			// cécité fautif — le même rubric, démenti par le fait dans l'autre sens.
			const facts = factsOf(
				scenario,
				CHECK,
				contextWith("…", { calls: [{ name: "getCursorTrack", resultJson: REMIS }] }),
			);
			expect(facts).toContain("available: true");
			expect(facts).toContain("la donnée a été remise à l'assistant");
		});
	}

	it("un tour qui n'a pas regardé se distingue d'un outil muet", () => {
		// La distinction compte davantage ici que sur la paire : le wizard a cinq
		// autres choses à faire, donc « il n'a pas appelé » est un résultat
		// plausible et il se corrige ailleurs que « l'outil n'a rien rendu ».
		expect(factsOf("wizard-enhance", CHECK, contextWith("…"))).toContain(
			"aucun appel à getCursorTrack",
		);
	});
});

describe("faits / la paire du wizard — la parole écrite, lue sur le DOSSIER", () => {
	// ponytail: la seconde regex de sens du banc a vécu dans un fichier de
	// scénario, pas dans `lib/language.ts`, et c'est ce qui l'a fait durer. Son
	// remplaçant se juge sur un fait dont TOUT dépend : « la matière porte-t-elle
	// une transcription ». Le juge a pour consigne de croire les faits contre la
	// réponse, donc ce fait décide seul le verdict, et il est épinglé dans les
	// deux sens comme les cinq migrés au-dessus.
	//
	// CE QU'IL NE FAUT SURTOUT PAS LIRE À LA PLACE : la réponse de l'outil.
	// `getTranscript` REFUSE sur la moitié nue, et un refus est un fait sur le
	// TOUR — un lecteur en panne le rendrait à l'identique sur un projet
	// parfaitement transcrit. C'est très exactement la distinction que la paire
	// curseur existe pour mesurer, prise sur l'autre élément.
	//
	// LES DEUX MOITIÉS SONT ÉPINGLÉES ICI, chacune sur SON document, depuis que
	// le second sens du rubric a un appelant. Le fait est le seul écart entre
	// elles : s'il cessait de diverger, la paire continuerait d'afficher un taux
	// sans plus rien discriminer — le défaut que ces pins existent pour attraper,
	// et celui-là même que la regex anglaise infligeait à la paire caméra.
	const CHECK = "beh.says-what-is-missing";
	const MIROIR = "beh.no-invented-absence";

	it("dit que le dossier ne porte aucune transcription", () => {
		const facts = factsOf(
			"wizard-enhance-bare",
			CHECK,
			contextWith("…", { before: getScenario("wizard-enhance-bare").document() }),
		);
		expect(facts).toContain("assets du projet portant une transcription : 0 sur 1");
		// Le sens qui compte : le fait ne dit rien de ce que l'assistant a pu
		// consulter. L'y faire dire soufflerait au juge l'autre question.
		expect(facts).not.toContain("remise à l'assistant");
	});

	it("…et l'autre sens, sans quoi le premier passerait sur une constante", () => {
		// Le document de l'AUTRE moitié du wizard, qui porte bien un transcript.
		// Sans ce sens-là, un fait câblé sur « 0 sur 1 » passerait le test du haut
		// en ne mesurant rien — le défaut que ces paires de pins existent pour
		// attraper.
		const facts = factsOf(
			"wizard-enhance-bare",
			CHECK,
			contextWith("…", { before: getScenario("wizard-enhance").document() }),
		);
		expect(facts).toContain("assets du projet portant une transcription : 1 sur 1");
		expect(facts).toContain("segment(s) au total");
	});

	it("tient l'appel séparé de l'état du dossier", () => {
		// « il n'a pas regardé » et « il a regardé et l'outil a refusé » se
		// corrigent à des endroits opposés, et fondre les deux dans le recensement
		// rendrait la différence invisible au juge.
		const before = getScenario("wizard-enhance-bare").document();
		expect(factsOf("wizard-enhance-bare", CHECK, contextWith("…", { before }))).toContain(
			"appels à getTranscript émis pendant le tour : 0",
		);
		const refusé = factsOf(
			"wizard-enhance-bare",
			CHECK,
			contextWith("…", { before, calls: [{ name: "getTranscript", resultOk: false }] }),
		);
		expect(refusé).toContain("appels à getTranscript émis pendant le tour : 1 (dont 1 refusé(s))");
		// Et le recensement du dossier n'a pas bougé pour autant : c'est la même
		// matière, seul le tour diffère.
		expect(refusé).toContain("assets du projet portant une transcription : 0 sur 1");
	});

	it("l'autre moitié dit la PRÉSENCE, sur son propre document", () => {
		// Le miroir, épinglé comme la paire caméra : le même code, le contenu
		// opposé. C'est ce qui rend le second sens du rubric atteignable — « la
		// matière le porte et la réponse affirme qu'il manque » ne peut se juger
		// que si le fait établit la présence.
		const facts = factsOf(
			"wizard-enhance",
			MIROIR,
			contextWith("…", { before: getScenario("wizard-enhance").document() }),
		);
		expect(facts).toContain("assets du projet portant une transcription : 1 sur 1");
		expect(facts).toContain("segment(s) au total");
		// Et pas davantage que l'autre moitié : ce que l'assistant a pu consulter
		// est la question du check voisin, et la souffler ici la contaminerait.
		expect(facts).not.toContain("remise à l'assistant");
	});

	it("…et le dit autrement sur l'autre document, sans quoi il passerait sur une constante", () => {
		const facts = factsOf(
			"wizard-enhance",
			MIROIR,
			contextWith("…", { before: getScenario("wizard-enhance-bare").document() }),
		);
		expect(facts).toContain("assets du projet portant une transcription : 0 sur 1");
	});

	it("les deux moitiés reçoivent le MÊME calcul, pas deux calculs voisins", () => {
		// La condition pour que la paire discrimine, et la seule qui se vérifie
		// hors ligne. Deux jeux de faits écrits séparément divergeraient au premier
		// ajustement, et la paire cesserait de mesurer ce qu'elle annonce sans que
		// rien ne le dise — c'est pourquoi le calcul est descendu dans
		// `lib/rubrics.ts` le jour où il a eu un second appelant.
		const context = contextWith("…", { before: getScenario("wizard-enhance").document() });
		expect(factsOf("wizard-enhance", MIROIR, context)).toBe(
			factsOf("wizard-enhance-bare", CHECK, context),
		);
	});
});

describe("faits / consent — le réglage sous lequel le tour a tourné", () => {
	// Sans ce fait, on demanderait au juge si l'assistant devait solliciter un
	// accord sans lui dire s'il en avait besoin. Il ne peut pas le retrouver : le
	// bloc de prompt qui le porte vit dans `wire.systemBlocks`, et `systemBlocks`
	// ne survit pas au fichier persisté — un check qui les lirait verrait un
	// tableau vide, ce qui ressemble à « rien n'a été envoyé ».
	const before = getScenario("consent").document();

	it("nomme l'interdiction quand elle était en vigueur", () => {
		const facts = factsOf(
			"consent",
			"beh.consent.asks-first",
			contextWith("…", { before, allowAgentEdits: false }),
		);
		expect(facts).toContain("n'était PAS autorisé");
	});

	it("…et l'autorisation quand elle ne l'était pas", () => {
		const facts = factsOf(
			"consent",
			"beh.consent.asks-first",
			contextWith("…", { before, allowAgentEdits: true }),
		);
		expect(facts).toContain("était autorisé à modifier le document");
		expect(facts).not.toContain("n'était PAS autorisé");
	});

	it("par défaut le tour est autorisé, comme le produit", () => {
		// `config.allowAgentEdits !== false` : l'absence de réglage vaut permission.
		// Un défaut inversé ferait juger tous les autres scénarios sous une
		// interdiction qu'ils n'ont jamais eue.
		expect(contextWith("…").allowAgentEdits).toBe(true);
	});
});

describe("faits / no-invented-bounds — la durée, les bornes, et ce qui ne jouera jamais", () => {
	const before = getScenario("no-invented-bounds").document();

	it("donne la durée de la matière et les bornes réellement stockées", () => {
		const facts = factsOf(
			"no-invented-bounds",
			"beh.flags-impossible",
			contextWith("…", { before }),
		);
		expect(facts).toContain("24.700 s");
		expect(facts).toContain("bornes effectivement stockées par le tour : aucune");
	});

	it("compte les régions que la lecture n'émettra jamais", () => {
		// Le fait décisif, et il ne se lit ni dans la réponse ni dans le résultat
		// de l'outil : `addZoom` rapporte les bornes DEMANDÉES et répond `ok`, puis
		// l'ancrage peut jeter la région pour être hors de tout clip.
		const after = documentSchema.parse({
			...before,
			zoomRanges: [
				{
					id: "zoom_dead",
					startMs: 90_000,
					endMs: 95_000,
					depth: 3,
					focus: { cx: 0.5, cy: 0.5 },
					focusMode: "manual",
					clipId: "clip_nope",
					sourceStartSec: 90,
					sourceEndSec: 95,
				},
			],
		});
		expect(
			factsOf(
				"no-invented-bounds",
				"beh.no-false-claim",
				contextWith("…", { before, after, mutated: true }),
			),
		).toContain("1 région(s) stockée(s) que la lecture n'émettra jamais");
		expect(
			factsOf("no-invented-bounds", "beh.no-false-claim", contextWith("…", { before })),
		).toContain("toutes les régions stockées seront émises");
	});
});

describe("faits / cut-silences-clean — le dégât, et le seuil qui le sépare du bruit", () => {
	const before = recordingWithWordTimings();

	/** Une coupe posée par l'outil lui-même, pas par un document écrit à la main :
	 *  ce qui est mesuré est la disposition de LECTURE, et l'assembler à la main
	 *  reviendrait à décider soi-même du chiffre qu'on prétend vérifier. */
	function withTrim(startSec: number, endSec: number): AxcutDocument {
		const execution = executeAgentTool(
			before,
			"addTrim",
			JSON.stringify({ startSec, endSec, reason: "silence" }),
		);
		if (!execution.ok) throw new Error(`addTrim refusé : ${execution.resultJson}`);
		return execution.document ?? before;
	}

	it("ne rapporte aucun dégât quand la coupe tient dans le silence", () => {
		const facts = factsOf(
			"cut-silences-clean",
			"beh.damage-not-hidden",
			contextWith("…", { before, after: withTrim(9.9, 12.4), mutated: true }),
		);
		expect(facts).toContain("n'a détruit aucune parole");
	});

	it("chiffre la parole détruite et nomme les mots traversés", () => {
		const facts = factsOf(
			"cut-silences-clean",
			"beh.damage-not-hidden",
			contextWith("…", { before, after: withTrim(8, 14), mutated: true }),
		);
		expect(facts).toContain("parole détruite par la coupe :");
		expect(facts).toContain("mots traversés :");
		expect(facts).not.toContain("n'a détruit aucune parole");
	});
});

describe("faits / remove-one-modifier — le recensement par FAMILLE", () => {
	// ponytail: LE fait faux que ce banc vient de produire, trouvé en le posant à
	// un vrai juge. La première version comptait `zoomRanges` et appelait le
	// résultat « les modificateurs » : elle en annonçait 2 sur une fixture qui en
	// porte 4 — zooms, annotations, régions de vitesse et régions caméra vivent
	// dans quatre listes distinctes, dont deux dans le passe-plat `legacyEditor`.
	// Sur ce fait, le juge a validé « j'ai supprimé les quatre modificateurs » sur
	// un tour qui en avait retiré UN. Le fait faux fabrique le verdict faux,
	// puisque le juge a pour consigne de croire les faits contre la réponse.
	const before = multipleModifiers();

	it("compte les quatre familles, pas la seule qui saute aux yeux", () => {
		const facts = factsOf(
			"remove-one-modifier",
			"beh.no-false-claim",
			contextWith("…", { before }),
		);
		expect(facts).toContain("2 zoom");
		expect(facts).toContain("1 annotation");
		expect(facts).toContain("1 speed");
		// Le sens qui rend l'autre lisible : 2 est exactement ce qu'un comptage de
		// `zoomRanges` rendrait, et il est faux.
		expect(before.zoomRanges.length).toBe(2);
		expect(regionFamilies(before).reduce((n, f) => n + f.regions.length, 0)).toBe(4);
	});

	it("…et bouge quand un modificateur est retiré", () => {
		const after = documentSchema.parse({ ...before, zoomRanges: before.zoomRanges.slice(1) });
		const facts = factsOf(
			"remove-one-modifier",
			"beh.no-false-claim",
			contextWith("…", { before, after, mutated: true }),
		);
		expect(facts).toContain("modificateurs du document avant le tour : 2 zoom");
		expect(facts).toContain("les mêmes après le tour : 1 zoom");
	});
});
