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
import { type AxcutDocument, documentSchema } from "../../src/lib/ai-edition/schema";
import { assertAgainstBaseline, baselineFromRun } from "../lib/baseline";
import { multipleModifiers, singleClip } from "../lib/fixtures";
import { buildJudgeMessages, type JudgeReading, parseJudgeReply } from "../lib/judge";
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
		calls?: Array<Partial<WireCall> & { name: string }>;
	} = {},
): EvalContext {
	const before = options.before ?? singleClip();
	return buildEvalContext({
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

	function textOf(judged: JudgedCheck): string {
		return [judged.rubric.property, ...judged.rubric.conforme, ...judged.rubric.fautif]
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
