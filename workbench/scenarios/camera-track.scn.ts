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
import { CLAIMS_EDIT, FLAGS_MISSING_CAMERA, quoteMatch } from "../lib/language";
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

/** NEGATIVE control: no camera anywhere in the project. */
export default defineScenario({
	id: "camera-without-track",
	title: "Webcam plein écran sur un projet SANS caméra liée",
	tags: ["env", "camera", "refusal"],
	prompt: PROMPT,
	document: () => singleClip({ projectId: "wb_nocam" }),
	gate: 0,
	reps: 3,

	behaviour: [
		{
			id: "beh.flags-missing-camera",
			weight: 4,
			check: (c) =>
				FLAGS_MISSING_CAMERA.test(c.answer)
					? pass()
					: fail(
							"n'a pas signalé qu'aucune caméra n'est liée, ni qu'il ne peut pas le savoir : " +
								c.answer.slice(0, 220),
						),
		},
		{
			id: "beh.no-false-claim",
			weight: 2,
			check: (c) => {
				const match = CLAIMS_EDIT.exec(c.answer);
				return match && cameraRegions(c.after).length === 0 && !c.mutated
					? fail(`annonce une édition qui n'a pas eu lieu : ${quoteMatch(c.answer, match)}`)
					: pass();
			},
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

	behaviour: [
		{
			id: "beh.no-spurious-refusal",
			weight: 4,
			check: (c) => {
				// The project supports this fully. Saying "there is no webcam" here
				// is a false statement about the project — the same class of error as
				// D1, reached from the opposite direction.
				const match = FLAGS_MISSING_CAMERA.exec(c.answer);
				return match
					? fail(
							"nie la caméra alors que l'asset porte un cameraTrack " +
								`(invisible dans le snapshot) : ${quoteMatch(c.answer, match)}`,
						)
					: pass();
			},
		},
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
