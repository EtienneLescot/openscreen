// L1 — the four real-fixture scenarios, driven through the whole agent loop.
//
// Two jobs, and the second is the important one.
//
// 1. THE AUDIT NO STATIC TEST CAN DO. `l0/real-screencast-truth.wb.ts` checks
//    the prompt and the document. Neither is what the model receives: it
//    receives a system message, 19 tool definitions, and then whatever the tool
//    payloads carry back — the transcript, the snapshot, 24 kB of pointer
//    track. The ground truth could leak through any of those, and only a real
//    turn produces the bytes. So the audit here runs the scenarios and greps
//    what actually left.
//
// 2. THE CHECKS MUST BE ABLE TO FAIL. A check that has only ever been observed
//    passing is indistinguishable from `() => pass()`, and a green pack of
//    those is worse than no pack — it is a claim that nothing is wrong. Each
//    scenario is therefore run twice: once on its own `demoScript` (a clean
//    turn, which proves a green line is REACHABLE on this material) and once on
//    a deliberately bad one, asserting WHICH check goes red. If a future change
//    makes an oracle blind, the bad run turns green and this file fails.
//
// ponytail: no live run, deliberately. The offline path exercises everything
// except the model's judgement — same `runChat`, same tools, same reader, same
// scoring — so what a paid run would add here is variance, not coverage. The
// measurement is the user's to make.

import { describe, expect, it } from "vitest";
import { runRepetition } from "../lib/runner";
import type { Scenario } from "../lib/scenario";
import {
	GROUND_TRUTH,
	REAL_SCREENCAST_SCENARIOS,
	realCutSilences,
	realZoomGrounding,
	realZooms,
} from "../scenarios/real-screencast.scn";

const LABELS = GROUND_TRUTH.zones.map((zone) => zone.label);

/** Ids of the checks that failed, both axes, in report order. */
async function failedChecks(scenario: Scenario): Promise<string[]> {
	const result = await runRepetition({ scenario });
	expect(result.run.ok, result.run.error).toBe(true);
	return [...result.scored.behaviour.results, ...result.scored.dsl.results]
		.filter((check) => !check.ok)
		.map((check) => check.id);
}

/** A scenario with its scripted turn replaced — same document, same prompt,
 * same reader, a different model. */
function withScript(scenario: Scenario, demoScript: Scenario["demoScript"]): Scenario {
	return { ...scenario, demoScript };
}

describe("l'audit de fuite, sur les octets réellement partis", () => {
	it("aucune étiquette de vérité terrain ne quitte le banc", async () => {
		for (const scenario of REAL_SCREENCAST_SCENARIOS) {
			const result = await runRepetition({ scenario });
			expect(result.run.ok, `${scenario.id}: ${result.run.error}`).toBe(true);
			// TOUT : messages système, définitions d'outils, arguments, et surtout
			// les résultats d'outils — c'est par là que passent le transcript, le
			// snapshot et les 24 kB de trajectoire.
			const sent = JSON.stringify(result.run.requests.map((request) => request.raw));
			expect(sent.length).toBeGreaterThan(10_000);
			for (const label of LABELS) {
				expect(sent, `${scenario.id} a envoyé « ${label} »`).not.toContain(label);
			}
		}
	});

	it("…et l'audit verrait la fuite si elle avait lieu", async () => {
		// Le test du test, à travers la même mesure : un scénario dont le prompt
		// porte l'annotation. Si `sent` ne contenait pas les prompts, l'audit
		// ci-dessus serait vide de sens et celui-ci passerait quand même.
		const leaky = withScript(
			{
				...realZooms,
				id: "real-zooms-leaky",
				prompt: `${realZooms.prompt} Focus on this: ${LABELS[2]}.`,
			},
			[{ kind: "text", text: "ok" }],
		);
		const result = await runRepetition({ scenario: leaky });
		const sent = JSON.stringify(result.run.requests.map((request) => request.raw));
		expect(sent).toContain(LABELS[2]);
	});
});

describe("une ligne verte est atteignable sur cette matière", () => {
	it("les quatre démos passent tous leurs checks", async () => {
		for (const scenario of REAL_SCREENCAST_SCENARIOS) {
			const result = await runRepetition({ scenario });
			const failures = [...result.scored.behaviour.results, ...result.scored.dsl.results].filter(
				(check) => !check.ok,
			);
			expect(
				failures.map((check) => `${check.id}: ${check.evidence}`),
				scenario.id,
			).toEqual([]);
			expect(result.scored.gateScore, scenario.id).toBe(1);
		}
	});
});

describe("…et rouge quand le montage est mauvais", () => {
	it("une coupe posée sur les nombres ronds détruit de la parole, et ça se voit", async () => {
		// Le geste le plus courant : arrondir. Les silences sont à 16,02–18,50 et
		// 21,94–23,41 ; couper 16→18,5 et 21,5→23,5 semble équivalent et mange
		// deux mots. Toute la conformité reste verte — document valide, trims
		// honnêtes, silences « couverts » à ±0,4 s.
		const failures = await failedChecks(
			withScript(realCutSilences, [
				{ kind: "tools", calls: [{ name: "getTranscript", args: {} }] },
				{
					kind: "tools",
					calls: [
						{ name: "addTrim", args: { startSec: 15.5, endSec: 18.5, reason: "silence" } },
						{ name: "addTrim", args: { startSec: 21.5, endSec: 23.5, reason: "silence" } },
						{ name: "addTrim", args: { startSec: 36.5, endSec: 38.5, reason: "silence" } },
					],
				},
				{ kind: "text", text: "I cut 3 silences. Clean cuts, nothing else touched." },
			]),
		);
		expect(failures).toContain("dsl.speech.intact");
		expect(failures).toContain("dsl.cut.precision");
		expect(failures).toContain("beh.damage-not-hidden");
		// …et la couverture reste rouge aussi : trois silences sur six.
		expect(failures).toContain("dsl.cut.coverage");
	});

	it("une coupe pile sur deux bornes de silence avale tout ce qu'il y a entre elles", async () => {
		// LE trou que `dsl.cut.precision` avait, et le seul qu'un check sur les
		// BORDS ne peut pas voir : 16,02 et 23,41 sont l'ouverture d'un silence et
		// la fermeture du suivant, donc les deux bords sont « exact » au centième
		// et le rapport n'a rien à signaler — pendant que les 3,4 s de parole
		// posées entre les deux disparaissent. Mesuré vert avant correction.
		const failures = await failedChecks(
			withScript(realCutSilences, [
				{ kind: "tools", calls: [{ name: "getTranscript", args: {} }] },
				{
					kind: "tools",
					calls: [{ name: "addTrim", args: { startSec: 16.02, endSec: 23.41, reason: "silence" } }],
				},
				{ kind: "text", text: "I made 1 cut." },
			]),
		);
		expect(failures).toContain("dsl.cut.precision");
		// …et l'oracle du dégât le voit par son propre chemin. Les deux doivent
		// être rouges : si seul `speech.intact` l'était, « la coupe tombe dans le
		// silence » resterait une affirmation fausse dans le rapport.
		expect(failures).toContain("dsl.speech.intact");
	});

	it("couper la seule tête d'enregistrement ne compte pas comme du travail", async () => {
		// LE cas que la séparation bord/intérieur existe pour attraper. 2,33 s
		// retirées, soit 23 % du silence de la prise, et zéro décision prise.
		const failures = await failedChecks(
			withScript(realCutSilences, [
				{ kind: "tools", calls: [{ name: "getTranscript", args: {} }] },
				{
					kind: "tools",
					calls: [{ name: "addTrim", args: { startSec: 0, endSec: 2.33, reason: "silence" } }],
				},
				{ kind: "text", text: "Tightened the opening." },
			]),
		);
		expect(failures).toContain("dsl.cut.coverage");
		// La parole est intacte : l'échec est bien un défaut de RAPPEL, pas un
		// dégât. Les deux oracles ne se recouvrent pas.
		expect(failures).not.toContain("dsl.speech.intact");
		expect(failures).not.toContain("dsl.cut.precision");
	});

	it("deux respirations coupées d'affilée laissent un fragment orphelin", async () => {
		// Les écarts de 0,22 s et 0,29 s sont sous le plancher : `pauses()` ne les
		// voit pas, donc les couper est déjà hors sujet. Le défaut audible, lui,
		// est ailleurs — l'îlot de parole resté entre deux coupes.
		const failures = await failedChecks(
			withScript(realCutSilences, [
				{ kind: "tools", calls: [{ name: "getTranscript", args: {} }] },
				{
					kind: "tools",
					calls: [
						{ name: "addTrim", args: { startSec: 16.02, endSec: 18.5, reason: "silence" } },
						{ name: "addTrim", args: { startSec: 18.66, endSec: 21.59, reason: "silence" } },
					],
				},
				{ kind: "text", text: "Two cuts." },
			]),
		);
		expect(failures).toContain("dsl.cut.no-orphans");
	});

	it("un zoom unique sur toute la prise a un rappel parfait et une précision nulle", async () => {
		// Le montage qui bat n'importe quelle note unique : il « couvre » les six
		// zones et n'a rien décidé. `dsl.zoom.recall` passe, `dsl.zoom.precision`
		// tombe — c'est exactement pour ça qu'ils sont deux checks.
		const failures = await failedChecks(
			withScript(realZooms, [
				{ kind: "tools", calls: [{ name: "getCurrentDocument", args: {} }] },
				{
					kind: "tools",
					calls: [{ name: "addZoom", args: { startSec: 0, endSec: 66, depth: 3 } }],
				},
				{ kind: "text", text: "Added 1 zoom over the whole recording." },
			]),
		);
		expect(failures).toContain("dsl.zoom.precision");
		expect(failures).not.toContain("dsl.zoom.recall");
		// L'hygiène le voit aussi, par un autre chemin : un zoom qui couvre le
		// montage EST le cadrage du montage.
		expect(failures).toContain("dsl.zoom.hygiene");
	});

	it("trois flashs bien centrés ont une précision parfaite et un rappel nul", async () => {
		// L'échec symétrique, et celui qu'un oracle « le centre tombe-t-il dans la
		// zone ? » aurait déclaré parfait.
		const failures = await failedChecks(
			withScript(realZooms, [
				{ kind: "tools", calls: [{ name: "getCursorTrack", args: {} }] },
				{
					kind: "tools",
					calls: [
						{ name: "addZoom", args: { startSec: 10.2, endSec: 10.7, depth: 3 } },
						{ name: "addZoom", args: { startSec: 26.2, endSec: 26.7, depth: 3 } },
						{ name: "addZoom", args: { startSec: 44.2, endSec: 44.7, depth: 3 } },
					],
				},
				{ kind: "text", text: "Added 3 zooms." },
			]),
		);
		expect(failures).toContain("dsl.zoom.recall");
		expect(failures).not.toContain("dsl.zoom.precision");
	});

	it("un zoom hors périmètre est vu même quand il est bien placé", async () => {
		// « Do not change the timing of anything » : la coupe est parfaite et
		// n'était pas demandée.
		const failures = await failedChecks(
			withScript(realZooms, [
				{ kind: "tools", calls: [{ name: "getCursorTrack", args: {} }] },
				{
					kind: "tools",
					calls: [
						{ name: "addZoom", args: { startSec: 8.5, endSec: 12.8, depth: 3 } },
						{ name: "addZoom", args: { startSec: 23.8, endSec: 29.4, depth: 3 } },
						{ name: "addTrim", args: { startSec: 16.02, endSec: 18.5, reason: "silence" } },
					],
				},
				{ kind: "text", text: "Added 2 zooms." },
			]),
		);
		expect(failures).toEqual(["dsl.scope"]);
	});

	it("répondre sans lire la trajectoire est vu, même avec un zoom au bon endroit", async () => {
		// LA discrimination du quatrième scénario. Le zoom tombe pile sur la
		// traversée lente — un modèle peut y arriver depuis le transcript, qui dit
		// « pour voir l'image. » à 21,94 — mais il n'a rien lu, et l'ordre des
		// appels sur le fil est la seule preuve disponible.
		const failures = await failedChecks(
			withScript(realZoomGrounding, [
				{ kind: "tools", calls: [{ name: "getTranscript", args: {} }] },
				{
					kind: "tools",
					calls: [{ name: "addZoom", args: { startSec: 24, endSec: 29.5, depth: 3 } }],
				},
				{ kind: "text", text: "Zoomed on the passage around 24.0 s where the image is shown." },
			]),
		);
		expect(failures).toContain("dsl.consults.telemetry");
		expect(failures).toContain("dsl.consults.before-editing");
		// …et le placement, lui, est bon. Les deux axes ne se recouvrent pas :
		// c'est ce qui permet de dire « bonne réponse, mauvaise méthode ».
		expect(failures).not.toContain("dsl.zone.slow-sweep");
	});

	it("lire la trajectoire APRÈS avoir décidé n'est pas la lire", async () => {
		const failures = await failedChecks(
			withScript(realZoomGrounding, [
				{
					kind: "tools",
					calls: [{ name: "addZoom", args: { startSec: 24, endSec: 29.5, depth: 3 } }],
				},
				{ kind: "tools", calls: [{ name: "getCursorTrack", args: {} }] },
				{ kind: "text", text: "Zoomed at 24.0 s; the pointer track confirms it." },
			]),
		);
		expect(failures).toEqual(["dsl.consults.before-editing"]);
	});

	it("un getCursorTrack qui échoue n'est pas une lecture", async () => {
		// Un appel qui porte le bon NOM et ne ramène rien : l'assetId n'existe pas,
		// l'exécuteur répond `{"error":…}`, le modèle n'a pas un échantillon — et
		// les deux checks de méthode étaient verts, sur le scénario dont c'est le
		// seul objet. Le nom d'un outil n'est pas une preuve d'observation.
		const failures = await failedChecks(
			withScript(realZoomGrounding, [
				{ kind: "tools", calls: [{ name: "getCursorTrack", args: { assetId: "asset_absent" } }] },
				{
					kind: "tools",
					calls: [{ name: "addZoom", args: { startSec: 24, endSec: 29.5, depth: 3 } }],
				},
				{ kind: "text", text: "Zoomed at 24.0 s." },
			]),
		);
		expect(failures).toContain("dsl.consults.telemetry");
		expect(failures).toContain("dsl.consults.before-editing");
		// Le placement, lui, reste bon : les deux axes ne se recouvrent toujours pas.
		expect(failures).not.toContain("dsl.zone.slow-sweep");
	});

	it("la zone que seul le curseur signale reste manquée par un montage transcript-only", async () => {
		// Un modèle qui suit les silences place ses zooms là où le transcript
		// respire — et la traversée lente n'est signalée par aucun d'eux.
		const failures = await failedChecks(
			withScript(realZoomGrounding, [
				{ kind: "tools", calls: [{ name: "getCursorTrack", args: {} }] },
				{
					kind: "tools",
					calls: [
						{ name: "addZoom", args: { startSec: 18.6, endSec: 21.5, depth: 3 } },
						{ name: "addZoom", args: { startSec: 38.3, endSec: 40.8, depth: 3 } },
					],
				},
				{ kind: "text", text: "Zoomed after each pause, at 18.6 s and 38.3 s." },
			]),
		);
		expect(failures).toEqual(["dsl.zone.slow-sweep"]);
	});
});
