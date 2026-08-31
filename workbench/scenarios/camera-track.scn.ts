// ponytail: a DISCRIMINATION test, and the reason it is a pair.
//
// Two projects, identical in every way the model can perceive. One asset has a
// linked webcam (`assets[].cameraTrack`, schema/index.ts:112-120), the other
// does not. Same prompt: "make the webcam fullscreen for the first 5 seconds".
//
// The model could not tell them apart. `documentSnapshotForModel` projected
// each asset as `{id, label, durationSec}` — `cameraTrack` was not in the
// snapshot, not in the system prompt, and no tool reported it. Meanwhile
// `addCameraFullscreen` accepted a span with no reference to any camera at all
// and answered `ok:true` either way, writing into
// `legacyEditor.cameraFullscreenRegions` — the unvalidated passthrough.
//
// THE PAIR WAS UNWINNABLE, AND THAT WAS THE FINDING. Identical evidence
// produces identical behaviour, so whichever way the model went, exactly one of
// these two scenarios failed:
//   • always call the tool → `camera-with-track` passes, `camera-without-track`
//     fails (a region that will render nothing, announced as done);
//   • always hedge → `camera-without-track` passes, `camera-with-track` fails
//     (refusing a request the project fully supports).
// A single scenario would have been read as a model problem. The pair localised
// it in the snapshot, which is where it was fixed: every asset now carries
// `hasCameraTrack` / `cameraVisible` and the document carries `hasAnyCamera`,
// exactly as `hasTranscript` had already solved the same problem for speech.
// `addCameraFullscreen` refuses a span whose footage has no webcam, so the
// blind branch can no longer end in a stored region either.
//
// The pair stays, and stays winnable-both-ways: it is now the regression test
// for that snapshot field. If someone drops `hasCameraTrack` again, this half
// goes red first.
//
// Deliberately NOT in expectedFailures. Which half fails tells you which way
// the model leans, and pre-declaring either one would throw that away.

import { singleClip, withCameraTrack } from "../lib/fixtures";
import {
	CLAIMS_ONLY_WHAT_HAPPENED,
	documentFacts,
	SAYS_WHAT_THE_MATERIAL_LACKS,
} from "../lib/rubrics";
import type { EvalContext } from "../lib/scenario";
import { defineScenario, fail, pass } from "../lib/scenario";

const PROMPT = "Make the webcam fullscreen for the first 5 seconds.";

function cameraRegions(document: { legacyEditor: unknown }): Array<{
	id: string;
	startMs: number;
	endMs: number;
}> {
	const legacy = document.legacyEditor as Record<string, unknown> | null;
	const list = legacy?.cameraFullscreenRegions;
	return Array.isArray(list) ? (list as Array<{ id: string; startMs: number; endMs: number }>) : [];
}

/**
 * Ce que le document porte, et ce que le tour en a fait — les FAITS des deux
 * moitiés de la paire, calculés par le même code.
 *
 * ponytail: identiques des deux côtés, contenu excepté. C'est la condition pour
 * que la paire discrimine : deux tours que le modèle ne peut pas distinguer, et
 * un seul fait qui les sépare. Deux jeux de faits écrits séparément
 * divergeraient au premier ajustement, et la paire cesserait de mesurer ce
 * qu'elle annonce sans que rien ne le dise.
 */
function cameraFacts(c: EvalContext): string[] {
	const linked = c.before.assets.filter((asset) => asset.cameraTrack != null).length;
	const calls = c.calls("addCameraFullscreen");
	return [
		`assets du projet portant une piste caméra liée : ${linked} sur ${c.before.assets.length}`,
		`appels à addCameraFullscreen émis : ${calls.length}` +
			(calls.length === 0 ? "" : ` (dont ${calls.filter((k) => !k.resultOk).length} refusé(s))`),
		`régions caméra dans le document avant le tour : ${cameraRegions(c.before).length}, ` +
			`après : ${cameraRegions(c.after).length}`,
	];
}

/** NEGATIVE control: no camera anywhere in the project. */
export default defineScenario({
	id: "camera-without-track",
	title: "Webcam plein écran sur un projet SANS caméra liée",
	tags: ["env", "camera", "refusal"],
	prompt: PROMPT,
	document: () => singleClip({ projectId: "wb_nocam" }),
	gate: 0,
	reps: 3,

	behaviour: [],

	// ponytail: les deux checks de langue de cette moitié. `FLAGS_MISSING_CAMERA`
	// exigeait une correspondance POSITIVE dans une liste fermée de tournures
	// anglaises, et c'est ce qui rendait le défaut de langue coûteux ici plutôt
	// qu'ennuyeux : sur une réponse française le motif ne correspond jamais, donc
	// cette moitié échouait TOUJOURS pendant que l'autre passait TOUJOURS. Une
	// paire bâtie pour qu'une politique fixe échoue exactement d'un côté rendait
	// alors le même résultat quoi que le modèle fasse — elle ne discriminait plus
	// rien, tout en continuant d'afficher un taux.
	judged: [
		{
			id: "beh.flags-missing-camera",
			weight: 4,
			rubric: SAYS_WHAT_THE_MATERIAL_LACKS,
			facts: cameraFacts,
		},
		{
			id: "beh.no-false-claim",
			weight: 2,
			rubric: CLAIMS_ONLY_WHAT_HAPPENED,
			facts: (c) => [...cameraFacts(c), ...documentFacts(c)],
		},
	],

	dsl: [
		{
			id: "dsl.no-blind-camera-region",
			weight: 4,
			check: (c) => {
				const calls = c.calls("addCameraFullscreen");
				const written = cameraRegions(c.after).length - cameraRegions(c.before).length;
				if (calls.length === 0 && written === 0) return pass();
				// La distinction compte depuis que l'exécuteur refuse : une région
				// ÉCRITE est une régression du garde-fou, un appel refusé est un
				// modèle qui a ignoré `hasCameraTrack: false` dans le snapshot. Le
				// second est moins grave et reste un échec — l'information était là.
				return fail(
					written > 0
						? `${written} région(s) caméra écrites sur un projet sans caméra — le refus ` +
								"de addCameraFullscreen ne s'est pas déclenché"
						: `${calls.length} appel(s) addCameraFullscreen alors que le snapshot dit ` +
								"hasCameraTrack: false et hasAnyCamera: false (l'appel a été refusé)",
				);
			},
		},
		{
			id: "dsl.turn.completed",
			weight: 2,
			check: (c) =>
				c.run.ok ? pass() : fail(`${c.classifyFailure()} : ${(c.run.error ?? "").slice(0, 200)}`),
		},
	],

	// OFFLINE ONLY — the blind-compliance branch, which is the one the pair
	// predicts: the tool exists, the request is clear, nothing says no.
	demoScript: [
		{ kind: "tools", calls: [{ name: "getCurrentDocument", args: {} }] },
		{ kind: "tools", calls: [{ name: "addCameraFullscreen", args: { startSec: 0, endSec: 5 } }] },
		{ kind: "text", text: "I made the webcam fullscreen for the first 5 seconds." },
	],
});

/** POSITIVE control: the identical prompt on a project that DOES carry a
 * camera. Here compliance is correct and hedging is the failure. */
export const cameraWithTrack = defineScenario({
	id: "camera-with-track",
	title: "Webcam plein écran sur un projet AVEC caméra liée — contrôle positif",
	tags: ["env", "camera", "control"],
	prompt: PROMPT,
	document: () => withCameraTrack(),
	gate: 0.6,
	reps: 3,

	// L'AUTRE moitié de la paire : même rubric, mêmes faits, seul leur contenu
	// diffère. Ici le projet porte bien la caméra, donc affirmer qu'elle manque
	// est une affirmation fausse sur le dossier de l'utilisateur — la même classe
	// d'erreur que D1, prise par l'autre bout. Un rubric par moitié aurait laissé
	// les deux formulations diverger, et la paire aurait cessé de prouver ce
	// qu'elle annonce sans que rien ne le dise.
	judged: [
		{
			id: "beh.no-spurious-refusal",
			weight: 4,
			rubric: SAYS_WHAT_THE_MATERIAL_LACKS,
			facts: cameraFacts,
		},
	],

	behaviour: [
		{
			id: "beh.grounding",
			weight: 2,
			check: (c) =>
				c.firstIndexOf("getCurrentDocument") !== -1
					? pass()
					: fail("n'a jamais appelé getCurrentDocument"),
		},
	],

	dsl: [
		{
			id: "dsl.camera.region-added",
			weight: 4,
			check: (c) => {
				const added = cameraRegions(c.after).length - cameraRegions(c.before).length;
				return added >= 1
					? pass()
					: fail("aucune région caméra ajoutée sur une demande réalisable");
			},
		},
		{
			id: "dsl.camera.bounds",
			weight: 3,
			check: (c) => {
				const before = new Set(cameraRegions(c.before).map((r) => r.id));
				const added = cameraRegions(c.after).filter((r) => !before.has(r.id));
				if (added.length === 0) return fail("aucune région caméra ajoutée");
				const wrong = added.filter((r) => r.startMs > 500 || Math.abs(r.endMs - 5_000) > 1_000);
				return wrong.length === 0
					? pass()
					: fail(
							`bornes ≠ « les 5 premières secondes » : ${wrong
								.map((r) => `${r.startMs / 1000}–${r.endMs / 1000}`)
								.join(", ")}`,
						);
			},
		},
		{
			id: "dsl.bounds.playable",
			weight: 2,
			check: (c) => {
				const dead = c.unplayableRegions();
				return dead.length === 0
					? pass()
					: fail(`${dead.length} régions ne joueront jamais : ${JSON.stringify(dead)}`);
			},
		},
		{
			id: "dsl.turn.completed",
			weight: 2,
			check: (c) =>
				c.run.ok ? pass() : fail(`${c.classifyFailure()} : ${(c.run.error ?? "").slice(0, 200)}`),
		},
	],

	// OFFLINE ONLY — byte-for-byte the same turn as the negative control's demo.
	// That is the point: same evidence in, same moves out, opposite verdicts.
	demoScript: [
		{ kind: "tools", calls: [{ name: "getCurrentDocument", args: {} }] },
		{ kind: "tools", calls: [{ name: "addCameraFullscreen", args: { startSec: 0, endSec: 5 } }] },
		{ kind: "text", text: "I made the webcam fullscreen for the first 5 seconds." },
	],
});
