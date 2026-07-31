// L0 — the ground truth of the real screencast must not reach the model.
//
// `real-screencast.scn.ts` scores four prompts against an annotation of what
// the user was actually doing. That annotation is only worth something as long
// as the model cannot read it: a scenario that hands over "23 → 30 s, showing
// an image" and then measures whether a zoom landed at 23 is measuring
// dictation, and it would report a rising score for a model that got worse.
//
// The leak has three plausible routes and this file closes all three:
//
//   1. the PROMPT — someone "helps" the model by naming the moments;
//   2. the DOCUMENT — someone pre-places an annotation or a marker region so
//      the fixture "carries" the truth, which `getCurrentDocument` then hands
//      over verbatim;
//   3. a future scenario added to the file and forgotten here — which is why
//      the audit walks `REAL_SCREENCAST_SCENARIOS` rather than a list of its
//      own.
//
// `l1/real-screencast.wb.ts` closes the fourth, which no static test can:
// what actually left on the wire, tool payloads included.
//
// ponytail: the audit matches WHOLE LABELS, never single words, and that is a
// deliberate limit rather than a weak test. The narration is French and it is
// about these very actions — the speaker says "pour voir l'image" at 21.6 s.
// Forbidding the word "image" would forbid the transcript, which is signal the
// model is entitled to. What must not travel is OUR reading of what those
// moments were, and a whole label is exactly that.

import { describe, expect, it } from "vitest";
import { pauses } from "../lib/quality";
import { realScreencastDocument } from "../lib/real-fixture";
import { GROUND_TRUTH, REAL_SCREENCAST_SCENARIOS } from "../scenarios/real-screencast.scn";

const LABELS = GROUND_TRUTH.zones.map((zone) => zone.label);

/** Zone bounds, minus the ones that are also bounds of the material itself.
 * The last zone runs to the end of the recording, so a clip ending at 66.154
 * "marks" it by existing — that is the fixture being one clip long, not a
 * leak. */
const ASSET_DURATION_SEC = 66.154;
const INTERIOR_BOUNDS = [
	...new Set(GROUND_TRUTH.zones.flatMap((zone) => [zone.startSec, zone.endSec])),
].filter((atSec) => atSec > 0.5 && atSec < ASSET_DURATION_SEC - 0.5);

/** How close a document boundary may sit to a zone boundary before it is
 * marking it. Half a second: below a zoom's own minimum duration, so nothing
 * legitimate needs to sit that close. */
const MARKS_IT_SEC = 0.5;

describe("la vérité terrain ne voyage pas", () => {
	it("n'apparaît dans aucun des quatre prompts", () => {
		for (const scenario of REAL_SCREENCAST_SCENARIOS) {
			for (const label of LABELS) {
				expect(scenario.prompt, scenario.id).not.toContain(label);
			}
		}
	});

	it("n'apparaît pas non plus en chiffres dans les prompts", () => {
		// Un prompt qui nomme une seconde de la fenêtre annotée donne la réponse
		// même sans le mot. `AI_ENHANCE_PROMPT` porte « (1) » et « (2) », qui sont
		// une énumération et tombent hors de la plage du matériau.
		for (const scenario of REAL_SCREENCAST_SCENARIOS) {
			const numbers = (scenario.prompt.match(/\d+(?:[.,]\d+)?/g) ?? []).map(Number);
			const inside = numbers.filter((value) => value >= 6 && value <= ASSET_DURATION_SEC + 2);
			expect(inside, `${scenario.id} cite ${inside.join(", ")}`).toEqual([]);
		}
	});

	it("n'apparaît nulle part dans le document remis au modèle", () => {
		// Le document part en entier : `getCurrentDocument` en rend un instantané
		// et `getTranscript` le texte. Une seule chaîne suffit donc à l'audit.
		const json = JSON.stringify(realScreencastDocument());
		for (const label of LABELS) {
			expect(json).not.toContain(label);
		}
	});

	it("n'est marquée par aucune région du document", () => {
		// La route la plus tentante : « poser » les zones dans la fixture sous
		// forme d'annotations ou de zooms de départ, pour que le modèle « ait de
		// quoi travailler ». Il n'aurait plus rien à trouver.
		const document = realScreencastDocument();
		expect(document.zoomRanges).toEqual([]);
		expect(document.annotations).toEqual([]);
		// `legacyEditor` est `null` sur cette fixture, pas `{}` — donc ni régions
		// de vitesse ni régions caméra plein écran, les deux familles que le
		// schéma ne valide pas et par lesquelles une annotation passerait sans
		// bruit.
		expect(document.legacyEditor).toBeNull();
		expect(document.timeline.trimRanges).toEqual([]);
	});

	it("n'est marquée par aucune borne de clip ou de coupe", () => {
		// Et la variante plus subtile : une fixture découpée en clips dont les
		// jointures tombent sur les zones. Un modèle n'aurait qu'à zoomer sur
		// chaque clip.
		const document = realScreencastDocument();
		const bounds = [
			...document.timeline.clips.flatMap((clip) => [
				clip.sourceStartSec,
				clip.sourceEndSec ?? clip.sourceStartSec,
			]),
			...document.timeline.trimRanges.flatMap((trim) => [trim.startSec, trim.endSec]),
		];
		const marking = bounds.filter((atSec) =>
			INTERIOR_BOUNDS.some((zoneBound) => Math.abs(atSec - zoneBound) < MARKS_IT_SEC),
		);
		expect(marking).toEqual([]);
	});

	it("l'audit couvre bien les quatre scénarios, et échouerait sur un cinquième oublié", () => {
		// Le test du test. Si quelqu'un ajoute un scénario au fichier sans
		// l'ajouter à `REAL_SCREENCAST_SCENARIOS`, son prompt n'est audité par
		// personne — donc cette liste est la seule source, et sa longueur est
		// épinglée pour que l'oubli se voie ici.
		expect(REAL_SCREENCAST_SCENARIOS.map((scenario) => scenario.id)).toEqual([
			"real-wizard-enhance",
			"real-cut-silences",
			"real-zooms",
			"real-zoom-grounding",
		]);
		// …et l'audit lui-même sait détecter une fuite : la preuve, sur une
		// chaîne construite exprès.
		const leaked = `Zoom on the moment at 23 s: ${LABELS[2]}.`;
		expect(LABELS.some((label) => leaked.includes(label))).toBe(true);
	});
});

describe("la zone discriminante est bien discriminante", () => {
	it("ne contient aucun silence — le transcript seul ne la signale pas", () => {
		// Si un silence tombait dans 23–30, un modèle qui ne lit que le
		// transcript pourrait y arriver par hasard, et `dsl.zone.slow-sweep`
		// cesserait de mesurer ce qu'il prétend mesurer.
		const document = realScreencastDocument();
		const sweep = GROUND_TRUTH.slowSweep;
		// Aucun des sept silences de la prise ne tient dans la zone…
		expect(
			pauses(document).filter(
				(pause) => pause.startSec >= sweep.startSec && pause.endSec <= sweep.endSec,
			),
		).toEqual([]);

		// …et la parole y est continue d'un mot à l'autre. La zone commence
		// 0,41 s avant le premier mot, parce qu'elle recouvre la queue du silence
		// 21,94–23,41 : c'est le seul « trou » qu'elle contient, et il est
		// antérieur à ce que la zone décrit.
		const inside = document.transcripts[0].words.filter(
			(word) => word.endSec > sweep.startSec && word.startSec < sweep.endSec,
		);
		expect(inside.length).toBeGreaterThan(5);
		let previous = inside[0].endSec;
		let longestGapSec = 0;
		for (const word of inside.slice(1)) {
			longestGapSec = Math.max(longestGapSec, word.startSec - previous);
			previous = Math.max(previous, word.endSec);
		}
		expect(longestGapSec).toBeLessThan(0.35);
	});
});
