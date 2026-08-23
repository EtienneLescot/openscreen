// L0 — the editorial QUALITY oracles, driven on the real screencast.
//
// `l0/editorial.wb.ts` runs on documents the workbench generates, which is the
// right place to pin interval arithmetic: the silences are round, the words are
// synthetic, and an off-by-one shows up as an exact number being wrong. These
// oracles cannot be pinned that way. Their entire reason to exist is that on
// real material the silences do not announce themselves: this transcript has
// 129 words and ten gaps, of which six are silences, two are breaths of 0.22
// and 0.29 s, one is a 0.18 s tail, and one — the 2.33 s before the first word,
// the largest of the lot — is not in the transcript at all. A test on tidy
// material passes against an oracle with no floor and no edge notion, and the
// floor and the edges ARE the oracle.
//
// So the fixture here is the 66 s take, and the edits are produced by
// `executeAgentTool`, never written by hand. What is written by hand is the
// list of pauses at the top: it was derived once, from the word timings, and it
// is repeated here so that a change in the derivation fails against a claim
// about the material rather than against itself.
//
// Every describe block carries at least one case that is a BAD edit, asserted
// to be caught. An oracle whose tests only ever show it agreeing with good
// edits is a trap: it can be replaced by `() => true` and stay green.

import { describe, expect, it } from "vitest";
import { executeAgentTool } from "../../electron/ai-edition/agent-tools";
import type { AxcutDocument } from "../../src/lib/ai-edition/schema";
import { recordingWithSilences } from "../lib/fixtures";
import {
	cutPrecision,
	DEFAULT_MIN_PAUSE_SEC,
	damagedWords,
	pauses,
	scopeBreaches,
	silenceCoverage,
	speechDamageDetail,
	type TruthZone,
	zoomPlacement,
} from "../lib/quality";
import { realScreencastDocument } from "../lib/real-fixture";
import { totalSec } from "../lib/spans";

/**
 * The pauses of the real take, as an editor reads them: gaps of at least
 * 0.35 s between the end of one word and the start of the next, plus the head
 * of the recording, which no word covers. 10.20 s of the 66.15 s.
 *
 * Stated, not derived. `pauses()` derives them; a test that also derived them
 * would agree with any threshold, including no threshold at all.
 */
const REAL_PAUSES: Array<[number, number]> = [
	[0, 2.33],
	[16.02, 18.5],
	[21.94, 23.41],
	[30.99, 31.81],
	[36.86, 38.18],
	[40.85, 41.97],
	[62.9, 63.56],
];

/** Runs a tool exactly as the agent loop would. */
function apply(document: AxcutDocument, name: string, args: unknown): AxcutDocument {
	const execution = executeAgentTool(document, name, JSON.stringify(args));
	if (!execution.ok) throw new Error(`${name} refusé : ${execution.resultJson}`);
	return execution.document ?? document;
}

function trim(document: AxcutDocument, startSec: number, endSec: number): AxcutDocument {
	return apply(document, "addTrim", { startSec, endSec, reason: "silence" });
}

function zoom(document: AxcutDocument, startSec: number, endSec: number): AxcutDocument {
	return apply(document, "addZoom", { startSec, endSec, depth: 3 });
}

// ─── pauses ─────────────────────────────────────────────────────────────────

describe("pauses — ce qu'est un silence sur du matériel réel", () => {
	it("trouve les 7 silences de la prise, et rien d'autre", () => {
		const found = pauses(realScreencastDocument());
		expect(found.map((pause) => [round(pause.startSec), round(pause.endSec)])).toEqual(REAL_PAUSES);
		expect(round(totalSec(found))).toBeCloseTo(10.2, 2);
	});

	it("sépare la tête d'enregistrement des silences intérieurs", () => {
		// 2,33 s avant le premier mot : 23 % du silence total, et le seul que le
		// transcript ne décrit PAS — aucun segment ne le couvre, il n'existe que
		// par différence avec la durée de l'asset.
		const found = pauses(realScreencastDocument());
		const edges = found.filter((pause) => pause.kind === "edge");
		expect(edges).toHaveLength(1);
		expect(edges[0].startSec).toBe(0);
		expect(round(edges[0].durationSec)).toBe(2.33);
		expect(found.filter((pause) => pause.kind === "interior")).toHaveLength(6);
	});

	it("sans plancher, trois respirations passent pour des silences", () => {
		// LE test qui justifie le seuil. `editorial.silenceSpans` n'en a pas : il
		// rend 10 intervalles sur cette prise, dont la queue de 0,18 s et deux
		// respirations de 0,22 et 0,29 s. Aucune des trois n'est coupable — les
		// couper produit un clic — et les compter dans le dénominateur donne un
		// rappel de 7/10 à un montage parfait.
		const document = realScreencastDocument();
		const unfloored = pauses(document, { minSec: 0 });
		expect(unfloored).toHaveLength(10);
		expect(
			unfloored
				.map((pause) => round(pause.durationSec))
				.filter((duration) => duration < DEFAULT_MIN_PAUSE_SEC),
		).toEqual([0.22, 0.29, 0.18]);
		expect(pauses(document, { minSec: DEFAULT_MIN_PAUSE_SEC })).toHaveLength(7);
		// …et le seuil est un vrai paramètre, pas une constante déguisée.
		expect(pauses(document, { minSec: 1.5 }).map((p) => round(p.durationSec))).toEqual([
			2.33, 2.48,
		]);
	});

	it("retombe sur les silences déclarés quand la fixture en déclare", () => {
		// Les fixtures synthétiques posent des segments `kind:"silence"` ; l'oracle
		// ne les lit pas, il dérive — et tombe sur les mêmes bornes, parce que la
		// parole et les silences y pavent la durée.
		const document = recordingWithSilences({
			durationSec: 62,
			silences: [
				[10, 12.5],
				[31, 36.2],
			],
		});
		expect(pauses(document).map((p) => [p.startSec, p.endSec])).toEqual([
			[10, 12.5],
			[31, 36.2],
		]);
		expect(pauses(document).every((p) => p.kind === "interior")).toBe(true);
	});
});

// ─── (a) speech destroyed, word by word ─────────────────────────────────────

describe("speechDamageDetail — quels MOTS la coupe a-t-elle mangés", () => {
	it("ne touche aucun mot quand la coupe tient dans le silence", () => {
		const before = realScreencastDocument();
		const after = trim(before, 21.94, 23.41);
		const damage = speechDamageDetail(before, after);
		expect(damage.destroyedSec).toBeCloseTo(0, 6);
		expect(damage.words).toEqual([]);
		expect(damage.fromWordTimings).toBe(true);
	});

	it("nomme le mot amputé, ce qu'un total de secondes ne fait pas", () => {
		// Le silence commence à 21,94 ; partir à 21,80 rogne les 0,14 dernières
		// secondes de « l'image. » (21,59 → 21,94). « 0,14 s de parole détruite »
		// ne dit pas quel mot claque à la lecture ; « l'image. » le dit.
		const before = realScreencastDocument();
		const after = trim(before, 21.8, 23.41);
		const damage = speechDamageDetail(before, after);
		expect(damage.words).toHaveLength(1);
		expect(damage.words[0].text).toBe("l'image.");
		expect(damage.words[0].removedSec).toBeCloseTo(21.94 - 21.8, 6);
		expect(damage.words[0].whole).toBe(false);
		expect(damage.clippedWords).toBe(1);
		expect(damage.wholeWords).toBe(0);
	});

	it("distingue un mot rogné d'un mot supprimé", () => {
		// La différence s'entend : un mot rogné est un clic, un mot supprimé est
		// une phrase qui perd son sens. Un oracle qui ne rend que des secondes
		// donne le même 0,35 aux deux.
		const before = realScreencastDocument();
		const after = trim(before, 21.59, 23.41);
		const damage = speechDamageDetail(before, after);
		expect(damage.words).toHaveLength(1);
		expect(damage.words[0].text).toBe("l'image.");
		expect(damage.words[0].whole).toBe(true);
		expect(damage.wholeWords).toBe(1);
		expect(damage.clippedWords).toBe(0);
	});

	it("voit la parole perdue par un clip supprimé, pas seulement par un trim", () => {
		// `setClipRange` ne laisse aucun trim derrière lui. Un oracle qui lirait
		// `trimRanges` rendrait « aucun dégât » sur un tour qui vient de jeter les
		// 20 dernières secondes de la prise.
		const before = realScreencastDocument();
		const clipId = before.timeline.clips[0].id;
		const after = apply(before, "setClipRange", {
			clipId,
			sourceStartSec: 0,
			sourceEndSec: 46,
		});
		const damage = speechDamageDetail(before, after);
		expect(after.timeline.trimRanges).toEqual([]);
		expect(damage.destroyedSec).toBeGreaterThan(15);
		expect(damage.words.length).toBeGreaterThan(20);
		expect(damage.words.at(-1)?.text).toBe("merci.");
	});

	it("ne rend rien quand rien n'a été retiré", () => {
		const document = realScreencastDocument();
		expect(damagedWords(document, [])).toEqual([]);
		expect(speechDamageDetail(document, document).words).toEqual([]);
	});
});

// ─── (b) cut precision ──────────────────────────────────────────────────────

describe("cutPrecision — où chaque bord est tombé", () => {
	it("dit « exact » quand le modèle recopie les bornes du silence", () => {
		// Ce n'est pas une réussite en soi : c'est la signature d'un modèle qui
		// transcrit les bornes qu'on lui a données. L'oracle le NOMME au lieu de
		// le confondre avec une marge choisie.
		const before = realScreencastDocument();
		const [cut] = cutPrecision(before, trim(before, 16.02, 18.5));
		expect(cut.pause?.startSec).toBe(16.02);
		expect(cut.edges.map((edge) => edge.verdict)).toEqual(["exact", "exact"]);
		expect(cut.edges[0].deltaSec).toBeCloseTo(0, 6);
		expect(cut.speechEatenSec).toBeCloseTo(0, 6);
		expect(cut.worstBiteSec).toBeCloseTo(0, 6);
	});

	it("compte la marge en positif : couper à l'intérieur du silence est prudent", () => {
		const before = realScreencastDocument();
		const [cut] = cutPrecision(before, trim(before, 16.2, 18.3));
		expect(cut.edges.map((edge) => edge.verdict)).toEqual(["margin", "margin"]);
		expect(cut.edges[0].deltaSec).toBeCloseTo(0.18, 6);
		expect(cut.edges[1].deltaSec).toBeCloseTo(0.2, 6);
		expect(cut.speechEatenSec).toBeCloseTo(0, 6);
	});

	it("compte l'empiètement en négatif, et nomme le mot mordu", () => {
		const before = realScreencastDocument();
		const [cut] = cutPrecision(before, trim(before, 15.7, 18.5));
		expect(cut.edges[0].verdict).toBe("encroachment");
		expect(cut.edges[0].deltaSec).toBeCloseTo(15.7 - 16.02, 6);
		// Ici la distance à la borne et la morsure coïncident (0,32 s), parce que
		// Whisper rend des mots jointifs : entre 15,70 et 16,02 il n'y a QUE de la
		// parole. Les deux nombres restent distincts — l'essai suivant en montre
		// un où ils divergent d'un facteur deux — et c'est la morsure qui
		// s'entend.
		expect(cut.edges[0].speechBittenSec).toBeCloseTo(0.32, 6);
		expect(cut.words.map((word) => word.text)).toEqual(["clique", "là,"]);
		expect(cut.words.map((word) => word.whole)).toEqual([false, true]);
		expect(cut.edges[1].verdict).toBe("exact");
	});

	it("mesure quand même une distance pour un trim qui ne vise aucun silence", () => {
		// LE cas où `editorial.trimMargins` se tait (`silence: null`, deux marges
		// nulles) : une coupe posée en pleine parole. C'est précisément là qu'on
		// veut savoir de combien le modèle s'est trompé.
		const before = realScreencastDocument();
		const [cut] = cutPrecision(before, trim(before, 25, 27));
		expect(cut.pause).toBeNull();
		expect(cut.overlapWithPauseSec).toBe(0);
		// Le silence le plus proche par le DÉBUT est celui de 21,94 : la coupe a
		// commencé 3,06 s trop tard. La morsure, elle, n'est que de 1,59 s — le
		// silence 21,94–23,41 ne contient pas de parole. Les deux nombres
		// divergent, et l'oracle rend les deux.
		expect(cut.edges[0].boundarySec).toBe(21.94);
		expect(cut.edges[0].deltaSec).toBeCloseTo(25 - 21.94, 6);
		expect(cut.edges[0].speechBittenSec).toBeCloseTo(25 - 23.41, 6);
		expect(cut.edges[0].verdict).toBe("encroachment");
		expect(cut.speechEatenSec).toBeCloseTo(2, 6);
		expect(cut.words.length).toBeGreaterThan(2);
	});

	it("compare un bord de début à un DÉBUT de silence, jamais à la borne la plus proche", () => {
		// Coupe partant très tard dans le silence 16,02–18,50 : la borne la plus
		// proche, toutes polarités confondues, serait 18,50 et l'erreur
		// rapportée 0,1 s. La vraie erreur est d'avoir commencé 2,38 s trop tard.
		const before = realScreencastDocument();
		const [cut] = cutPrecision(before, trim(before, 18.4, 18.5));
		expect(cut.edges[0].boundarySec).toBe(16.02);
		expect(cut.edges[0].deltaSec).toBeCloseTo(2.38, 6);
	});

	it("n'a rien à dire des trims déjà présents avant le tour", () => {
		const before = trim(realScreencastDocument(), 16.02, 18.5);
		expect(cutPrecision(before, before)).toEqual([]);
	});

	it("rend « unmatched » quand le matériau ne porte aucun silence", () => {
		// Sans transcript il n'y a pas de silence, donc pas de borne : l'oracle
		// dit qu'il ne sait pas, au lieu de rendre 0 et de passer pour vert.
		const withoutTranscript = { ...realScreencastDocument(), transcripts: [] };
		const [cut] = cutPrecision(withoutTranscript, trim(withoutTranscript, 10, 12));
		expect(cut.pause).toBeNull();
		expect(cut.edges.map((edge) => edge.verdict)).toEqual(["unmatched", "unmatched"]);
		expect(cut.edges[0].boundarySec).toBeNull();
	});
});

// ─── (c) coverage ───────────────────────────────────────────────────────────

describe("silenceCoverage — lesquels sont partis, lesquels sont restés", () => {
	function cutAll(document: AxcutDocument, spans: Array<[number, number]>): AxcutDocument {
		let next = document;
		for (const [startSec, endSec] of spans) next = trim(next, startSec, endSec);
		return next;
	}

	it("est complète quand les six silences intérieurs sont coupés", () => {
		const before = realScreencastDocument();
		const after = cutAll(before, REAL_PAUSES.slice(1));
		const coverage = silenceCoverage(before, after);
		expect(coverage.interior.fraction).toBeCloseTo(1, 4);
		expect(coverage.interior.missed).toEqual([]);
		// La tête n'a PAS été coupée, et ça ne dégrade pas le rappel intérieur.
		expect(coverage.edge.fraction).toBeCloseTo(0, 6);
		expect(coverage.edge.missed).toHaveLength(1);
	});

	it("ne laisse pas la tête d'enregistrement gonfler le rappel", () => {
		// LE test discriminant du bloc. Couper les 2,33 s de tête, c'est 23 % du
		// silence total pour un geste qu'un détecteur trivial trouve. Un oracle
		// global rendrait 0,23 et laisserait croire à un quart du travail fait ;
		// ici le rappel intérieur est zéro, ce qui est la vérité.
		const before = realScreencastDocument();
		const after = trim(before, 0, 2.33);
		const coverage = silenceCoverage(before, after);
		expect(coverage.edge.fraction).toBeCloseTo(1, 4);
		expect(coverage.interior.fraction).toBeCloseTo(0, 6);
		expect(coverage.interior.missed).toHaveLength(6);
	});

	it("compte un silence à moitié coupé comme manqué, et le dit en pourcentage", () => {
		const before = realScreencastDocument();
		// 16,02 → 17,2 : la moitié de 2,48 s. Le trou reste audible.
		const after = trim(before, 16.02, 17.2);
		const coverage = silenceCoverage(before, after);
		const entry = coverage.all.find((item) => item.pause.startSec === 16.02);
		expect(entry?.covered).toBe(false);
		expect(entry?.fraction).toBeCloseTo((17.2 - 16.02) / 2.48, 4);
		expect(coverage.interior.missed).toHaveLength(6);
	});

	it("tolère la marge : 90 % d'un silence retiré compte comme coupé", () => {
		const before = realScreencastDocument();
		const after = trim(before, 16.12, 18.4);
		const entry = silenceCoverage(before, after).all.find((i) => i.pause.startSec === 16.02);
		expect(entry?.covered).toBe(true);
		expect(entry?.fraction).toBeLessThan(1);
	});

	it("ne crédite pas une coupe posée à côté", () => {
		// Une coupe de la bonne DURÉE au mauvais endroit : 2,48 s retirées, zéro
		// silence couvert. Un oracle qui comparerait les durées serait vert.
		const before = realScreencastDocument();
		const after = trim(before, 25, 27.48);
		const coverage = silenceCoverage(before, after);
		expect(coverage.interior.removedSec).toBeCloseTo(0, 6);
		expect(coverage.interior.missed).toHaveLength(6);
	});
});

// ─── (e) zoom placement ─────────────────────────────────────────────────────

describe("zoomPlacement — précision ET rappel, jamais une note unique", () => {
	/** Zones de test, déclarées ici : l'oracle ne connaît que ce qu'on lui passe. */
	const ZONES: TruthZone[] = [
		{ startSec: 8, endSec: 13, label: "zone A" },
		{ startSec: 23, endSec: 30, label: "zone B" },
		{ startSec: 43, endSec: 46, label: "zone C" },
	];

	it("rend 1/1 pour des zooms posés sur les zones", () => {
		let document = realScreencastDocument();
		for (const zone of ZONES) document = zoom(document, zone.startSec, zone.endSec);
		const placement = zoomPlacement(document, ZONES);
		expect(placement.precision).toBeCloseTo(1, 4);
		expect(placement.recall).toBeCloseTo(1, 4);
		expect(placement.missedZones).toEqual([]);
		expect(placement.strayZoomIds).toEqual([]);
		expect(placement.hits.map((hit) => hit.zone?.label)).toEqual(["zone A", "zone B", "zone C"]);
	});

	it("démasque le zoom unique qui couvre tout : rappel haut, précision basse", () => {
		// Le geste qui bat n'importe quelle note unique. Une moyenne rendrait
		// « 0,5 » et laisserait passer un montage qui n'a rien décidé.
		const document = zoom(realScreencastDocument(), 0, 60);
		const placement = zoomPlacement(document, ZONES);
		expect(placement.recall).toBeCloseTo(1, 4);
		expect(placement.precision).toBeLessThan(0.3);
		expect(placement.strayZoomIds).toHaveLength(1);
	});

	it("démasque le flash bien placé : précision haute, rappel bas", () => {
		// L'échec symétrique. 0,5 s au centre de chaque zone : chaque zoom est
		// entièrement sur une zone (précision 1) et n'en couvre presque rien.
		let document = realScreencastDocument();
		for (const zone of ZONES) {
			const middle = (zone.startSec + zone.endSec) / 2;
			document = zoom(document, middle - 0.25, middle + 0.25);
		}
		const placement = zoomPlacement(document, ZONES);
		expect(placement.precision).toBeCloseTo(1, 4);
		expect(placement.recall).toBeLessThan(0.15);
		expect(placement.missedZones).toHaveLength(3);
		// …et le recouvrement, pas le centre : un oracle « le centre tombe-t-il
		// dans la zone ? » aurait rendu 3/3 ici.
		expect(placement.zones.every((report) => report.zoomIds.length === 1)).toBe(true);
	});

	it("nomme les zooms qui ne sont sur aucune zone", () => {
		const document = zoom(realScreencastDocument(), 50, 56);
		const placement = zoomPlacement(document, ZONES);
		expect(placement.hits[0].zone).toBeNull();
		expect(placement.strayZoomIds).toEqual([document.zoomRanges[0].id]);
		expect(placement.precision).toBeCloseTo(0, 6);
		expect(placement.recall).toBeCloseTo(0, 6);
	});

	it("ne crédite pas une zone couverte à 30 %", () => {
		// Seuil par défaut : 40 % de la zone. 2 s sur 7 ne suffisent pas.
		const document = zoom(realScreencastDocument(), 23, 25);
		const report = zoomPlacement(document, ZONES).zones.find((r) => r.zone.label === "zone B");
		expect(report?.fraction).toBeCloseTo(2 / 7, 4);
		expect(report?.covered).toBe(false);
		expect(zoomPlacement(document, ZONES, { coverFraction: 0.2 }).missedZones).toHaveLength(2);
	});

	it("ne compte pas deux fois les secondes de deux zooms empilés", () => {
		// Sur fixture synthétique, à rebours de ce fichier, et pour la raison que
		// son en-tête donne : ce qui se vérifie ici est de l'arithmétique
		// d'intervalles, pas une lecture de matériau. Rule 2 dans `timelineMap.ts`
		// interdit à deux zooms de se chevaucher, mais seul `setZoom` passe par le
		// clamp qui l'applique — `addZoom` ajoute à la suite — donc l'agent PEUT
		// empiler, et cet oracle doit être juste sur les documents fautifs qu'il
		// est là pour exposer.
		const document = zoom(
			zoom(recordingWithSilences({ durationSec: 60, silences: [[10, 12]] }), 8, 13),
			10,
			15,
		);
		expect(document.zoomRanges).toHaveLength(2);

		// Union : 8→15, soit 7 s, entièrement sur la zone 8→15. Somme : 5 + 5 = 10 s,
		// qui rendrait 0,7 — une précision abaissée par le double comptage et non par
		// un défaut de placement.
		const placement = zoomPlacement(document, [{ startSec: 8, endSec: 15, label: "zone" }]);
		expect(placement.zoomSec).toBeCloseTo(7, 4);
		// Les deux termes séparément, pas seulement leur rapport : un rapport se lit
		// juste quand numérateur ET dénominateur double-comptent de concert. Ici
		// `zoomSec` suffirait à l'attraper, mais le lecteur ne devrait pas avoir à
		// le déduire d'un ratio pour savoir ce que l'oracle compte.
		expect(placement.onZoneSec).toBeCloseTo(7, 4);
		expect(placement.precision).toBeCloseTo(1, 4);
	});

	it("rend une précision de 1 quand aucun zoom n'a été émis", () => {
		// Ne rien émettre est un échec de RAPPEL et jamais de précision : gonfler
		// la précision d'un document vide serait absurde, l'annuler aussi.
		const placement = zoomPlacement(realScreencastDocument(), ZONES);
		expect(placement.precision).toBe(1);
		expect(placement.recall).toBe(0);
		expect(placement.missedZones).toHaveLength(3);
	});
});

// ─── (f) scope ──────────────────────────────────────────────────────────────

describe("scopeBreaches — « et rien d'autre », document et appels", () => {
	const CUT_ONLY = { families: ["trim" as const], tools: ["addTrim", "setTrim", "removeTrim"] };

	it("se tait sur un tour qui n'a fait que ce qui était demandé", () => {
		const before = realScreencastDocument();
		const after = trim(before, 16.02, 18.5);
		const calls = [
			{ name: "getTranscript", mutating: false },
			{ name: "addTrim", mutating: true },
		];
		expect(scopeBreaches(before, after, calls, CUT_ONLY)).toEqual([]);
	});

	it("nomme la famille que la demande ne couvrait pas", () => {
		const before = realScreencastDocument();
		const after = zoom(trim(before, 16.02, 18.5), 23, 30);
		const breaches = scopeBreaches(before, after, [], CUT_ONLY);
		expect(breaches).toHaveLength(1);
		expect(breaches[0]).toMatchObject({ source: "document", what: "zoom" });
		expect(breaches[0].detail).toContain("+1");
	});

	it("attrape l'appel mutant qui n'a laissé aucune trace dans le document", () => {
		// La moitié que `outOfScopeEdits` ne peut pas voir : un `replaceTimeline`
		// qui reproduit la timeline à l'identique. Zéro delta, et une habitude
		// destructrice qu'on veut nommer quand même.
		const document = realScreencastDocument();
		const calls = [
			{ name: "addTrim", mutating: true },
			{ name: "replaceTimeline", mutating: true },
		];
		const breaches = scopeBreaches(document, document, calls, CUT_ONLY);
		expect(breaches).toEqual([
			{ source: "call", what: "replaceTimeline", detail: "appel mutant hors périmètre" },
		]);
	});
});

function round(value: number): number {
	return Math.round(value * 100) / 100;
}
