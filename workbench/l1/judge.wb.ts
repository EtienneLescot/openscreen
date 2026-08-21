// L1 — le juge de bout en bout, sans provider et sans clé.
//
// Ce fichier est la réponse à « un juge que personne ne peut tester hors ligne
// est un juge que personne ne croira ». Il n'y a rien à simuler pour l'obtenir :
// `askJudge` parle le MÊME dialecte OpenAI-compatible en SSE que l'agent, donc
// `startScriptedModel` et `startReplay` sont des juges comme les autres. Une
// cassette de juge s'enregistre et se rejoue exactement comme une cassette
// d'agent, avec la même détection de péremption et la même barrière anti-secret.
//
// Ce qui est réellement exercé ici, et qu'aucun test L0 ne peut couvrir : le
// tour REPART DU DISQUE. `persistRepetition` écrit, `readPersistedTurn` relit,
// `contextFromPersistedTurn` reconstruit un `EvalContext`, les faits calculés en
// sortent, et le verdict entre dans `scoreRun`. C'est le chemin de `wb:judge`,
// à l'endpoint près.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { startRecorder, startReplay } from "../lib/cassette";
import { ENV_KEYS } from "../lib/env";
import { singleClip } from "../lib/fixtures";
import { askJudge, type JudgeReading, JudgeTransportError } from "../lib/judge";
import { startScriptedModel } from "../lib/model-server";
import { buildEvalContext } from "../lib/oracles";
import {
	contextFromPersistedTurn,
	listPersistedTurns,
	persistRepetition,
	readPersistedTurn,
} from "../lib/persist";
import { SAYS_IT_CANNOT } from "../lib/rubrics";
import type { RepetitionResult } from "../lib/runner";
import { scoreRun } from "../lib/score";
import { getScenario } from "../scenarios/registry";

const DIRECTORY = mkdtempSync(join(tmpdir(), "wb-judge-"));
afterAll(() => rmSync(DIRECTORY, { recursive: true, force: true }));

const SCENARIO = getScenario("out-of-scope-styling");
const ANSWER =
	"Je ne peux pas changer le fond, l'arrondi des coins ni la police des sous-titres : " +
	"aucun de mes outils n'atteint ces réglages. Ils se règlent depuis l'éditeur.";

/** Un tour persisté, écrit par le même code que le CLI live. */
function persistOneTurn(answer: string): string {
	const document = singleClip({ projectId: "wb_scope" });
	const context = buildEvalContext({
		answer,
		wire: {
			systemBlocks: [],
			systemChars: 120,
			systemSha256: "a".repeat(64),
			toolsSent: [],
			toolNames: ["getCurrentDocument"],
			toolsSha256: "b".repeat(64),
			rounds: 2,
			calls: [
				{
					round: 0,
					id: "call_0",
					name: "getCurrentDocument",
					argsJson: "{}",
					args: {},
					mutating: false,
					resultJson: '{"ok":true}',
					resultOk: true,
				},
			],
		},
		before: document,
		after: document,
		mutated: false,
		run: { ok: true, ms: 12 },
	});
	const result = {
		scenarioId: SCENARIO.id,
		rep: 0,
		projectId: "wb_scope",
		scored: scoreRun(SCENARIO, context),
		context,
		run: {
			ok: true,
			ms: 12,
			answer,
			wire: {
				systemBlocks: ["système"],
				systemChars: 120,
				systemSha256: "a".repeat(64),
				toolsSent: [],
				toolNames: ["getCurrentDocument"],
				toolsSha256: "b".repeat(64),
				rounds: 2,
				calls: context.wire.calls,
			},
			requests: [],
			projectId: "wb_scope",
		},
	} as unknown as RepetitionResult;
	const written = persistRepetition({
		label: "l1-judge",
		result,
		prompt: SCENARIO.prompt,
		allowAgentEdits: true,
		root: `${DIRECTORY}/runs`,
	});
	return written.file;
}

/** Un juge scripté : une seule réponse, verbatim, pour chaque tour du script. */
function scriptedJudge(replies: string[]) {
	return startScriptedModel(replies.map((text) => ({ kind: "text" as const, text })));
}

describe("le juge tourne sur un tour relu du disque", () => {
	const file = persistOneTurn(ANSWER);

	it("rebuilds an EvalContext from the file and feeds the judge its computed facts", async () => {
		const turn = readPersistedTurn(file);
		expect(turn.schema).toBe(2);
		const context = contextFromPersistedTurn(turn);
		// Le fichier a bien rendu ce que les faits lisent : le texte, les appels,
		// et le fait qu'aucun outil n'ait muté.
		expect(context.answer).toBe(ANSWER);
		expect(context.mutated).toBe(false);
		expect(context.calls("getCurrentDocument")).toHaveLength(1);

		const judged = (SCENARIO.judged ?? [])[0];
		expect(judged).toBeDefined();
		const facts = judged.facts(context);
		expect(facts.join(" ")).toContain("aucun");

		const model = await scriptedJudge([
			'{"verdict":"conforme","raison":"dit explicitement ne pas pouvoir"}',
		]);
		let reading: JudgeReading;
		try {
			reading = await askJudge({
				endpoint: { baseUrl: model.url, model: "scripted" },
				rubric: judged.rubric,
				input: { prompt: turn.prompt, answer: turn.answer, facts },
			});
		} finally {
			model.close();
		}
		expect(reading.verdict).toBe("conforme");

		// …et le verdict entre dans le score comme n'importe quel check.
		const scored = scoreRun(SCENARIO, context, new Map([[judged.id, reading]]));
		const result = scored.behaviour.results.find((r) => r.id === judged.id);
		expect(result?.ok).toBe(true);
		expect(result?.indeterminate).toBe(false);
		expect(scored.behaviour.undecidedWeight).toBe(0);
	});

	it("the same turn judged fautif fails the check and names the judge", async () => {
		const turn = readPersistedTurn(file);
		const context = contextFromPersistedTurn(turn);
		const judged = (SCENARIO.judged ?? [])[0];
		const model = await scriptedJudge(['{"verdict":"fautif","raison":"annonce un changement"}']);
		let reading: JudgeReading;
		try {
			reading = await askJudge({
				endpoint: { baseUrl: model.url, model: "scripted" },
				rubric: judged.rubric,
				input: { prompt: turn.prompt, answer: turn.answer, facts: judged.facts(context) },
			});
		} finally {
			model.close();
		}
		const scored = scoreRun(SCENARIO, context, new Map([[judged.id, reading]]));
		const result = scored.behaviour.results.find((r) => r.id === judged.id);
		expect(result?.ok).toBe(false);
		expect(result?.indeterminate).toBe(false);
		expect(result?.evidence).toContain("juge : annonce un changement");
	});

	it("a judge that answers prose leaves the check undecided rather than guessing", async () => {
		const turn = readPersistedTurn(file);
		const context = contextFromPersistedTurn(turn);
		const judged = (SCENARIO.judged ?? [])[0];
		const model = await scriptedJudge(["Je dirais que c'est plutôt correct, dans l'ensemble."]);
		let reading: JudgeReading;
		try {
			reading = await askJudge({
				endpoint: { baseUrl: model.url, model: "scripted" },
				rubric: judged.rubric,
				input: { prompt: turn.prompt, answer: turn.answer, facts: judged.facts(context) },
			});
		} finally {
			model.close();
		}
		expect(reading.verdict).toBe("indéterminé");
		const scored = scoreRun(SCENARIO, context, new Map([[judged.id, reading]]));
		expect(scored.behaviour.results.find((r) => r.id === judged.id)?.indeterminate).toBe(true);
		// Et il ne compte NI pour NI contre : l'axe garde le score des tranchés.
		expect(scored.behaviour.undecidedWeight).toBe(judged.weight);
	});

	it("lists the persisted turns the way `wb:judge` walks them", () => {
		const groups = listPersistedTurns({ label: "l1-judge", root: `${DIRECTORY}/runs` });
		expect(groups.map((g) => g.scenarioId)).toEqual([SCENARIO.id]);
		expect(groups[0].files).toHaveLength(1);
	});
});

describe("le juge s'enregistre et se rejoue comme le reste du banc", () => {
	const CASSETTE = join(DIRECTORY, "judge-out-of-scope-styling.json");
	const REPLY = '{"verdict":"conforme","raison":"refus explicite"}';

	async function ask(endpointUrl: string): Promise<JudgeReading> {
		return askJudge({
			endpoint: { baseUrl: endpointUrl, model: "scripted" },
			rubric: SAYS_IT_CANNOT,
			input: { prompt: SCENARIO.prompt, answer: ANSWER, facts: ["aucun appel mutant"] },
		});
	}

	it("records through the proxy, then replays the same verdict offline", async () => {
		// Le provider, tenu par un modèle scripté : en live c'est `env.baseUrl`,
		// et le proxy transmet l'en-tête d'autorisation sans le lire ni l'écrire.
		const upstream = await scriptedJudge([REPLY]);
		const recorder = await startRecorder({
			upstream: upstream.url,
			file: CASSETTE,
			scenario: "judge-out-of-scope-styling",
			provider: "openai-compatible",
			model: "scripted",
		});
		let recorded: JudgeReading;
		try {
			recorded = await ask(recorder.url);
		} finally {
			recorder.close();
			upstream.close();
		}
		expect(recorded.verdict).toBe("conforme");

		const replay = await startReplay({ file: CASSETTE });
		let replayed: JudgeReading;
		try {
			replayed = await ask(replay.url);
		} finally {
			replay.close();
		}
		expect(replayed).toEqual(recorded);
		expect(replay.staleRounds).toEqual([]);
	});

	it("marks the cassette stale when the rubric changes — a verdict on the old question", async () => {
		// Exactement le danger d'une cassette d'agent périmée : elle répond à une
		// question qu'on ne pose plus. Un rubric retouché DOIT être ré-enregistré,
		// sans quoi la passe du juge rejoue le verdict de la version précédente.
		const replay = await startReplay({ file: CASSETTE, onStale: "throw" });
		try {
			await askJudge({
				endpoint: { baseUrl: replay.url, model: "scripted" },
				rubric: { ...SAYS_IT_CANNOT, property: "une propriété entièrement différente" },
				input: { prompt: SCENARIO.prompt, answer: ANSWER, facts: ["aucun appel mutant"] },
			});
		} finally {
			replay.close();
		}
		expect(replay.staleRounds.length).toBeGreaterThan(0);
		expect(() => replay.assertFresh()).toThrow(/périmée aux rounds/);
	});

	it("never writes an authorization header into the judge cassette", () => {
		const blob = JSON.stringify(readPersistedTurn(persistOneTurn(ANSWER)));
		expect(blob).not.toContain("Bearer");
	});
});

describe("le juge refuse d'expédier un secret", () => {
	it("refuses to send a payload carrying the key, instead of scrubbing it", async () => {
		// `report.ts` refuse d'ÉCRIRE un payload qui porte la clé. Ici il PART chez
		// un tiers, ce qui est strictement plus exposé, donc la même barrière
		// s'applique à l'émission — et elle refuse plutôt que nettoie, parce qu'un
		// payload nettoyé cacherait que le tour en portait un.
		const saved = process.env[ENV_KEYS.apiKey];
		process.env[ENV_KEYS.apiKey] = "wb-not-a-real-key-0123456789";
		try {
			await expect(
				askJudge({
					endpoint: { baseUrl: "http://127.0.0.1:1/v1", model: "scripted" },
					rubric: SAYS_IT_CANNOT,
					input: {
						prompt: "p",
						answer: "la trace a capté wb-not-a-real-key-0123456789",
						facts: [],
					},
				}),
			).rejects.toThrow(/refus d'envoyer le tour au juge/);
		} finally {
			if (saved === undefined) delete process.env[ENV_KEYS.apiKey];
			else process.env[ENV_KEYS.apiKey] = saved;
		}
	});

	it("a dead endpoint is a transport failure, never an `indéterminé`", async () => {
		// Confondre « le juge n'a pas répondu » avec « la réponse ne tranche pas »
		// rendrait un provider muet indistinguable d'une réponse ambiguë. Seul le
		// second est une mesure.
		await expect(
			askJudge({
				endpoint: { baseUrl: "http://127.0.0.1:1/v1", model: "scripted" },
				rubric: SAYS_IT_CANNOT,
				input: { prompt: "p", answer: "a", facts: [] },
				timeoutMs: 2_000,
			}),
		).rejects.toBeInstanceOf(JudgeTransportError);
	});
});
