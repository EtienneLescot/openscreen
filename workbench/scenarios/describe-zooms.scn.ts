// ponytail: D2 at both levels — what the model SAYS a zoom's strength is, and
// what a write it believes changes that strength actually does.
//
// The defect is an ordinal wearing a multiplier's clothes. `depth` is 1..6.
// `documentSnapshotForModel` handed the model the bare integer with no scale
// beside it, and both tool descriptions — the executor's spec and the
// deep-agent copy — asserted that "depth 1–6 maps to 1.0×–3.5×". The real table
// is
//   ZOOM_DEPTH_SCALES = {1:1.25, 2:1.5, 3:1.8, 4:2.2, 5:3.5, 6:5.0}
// so the documented range was wrong at BOTH ends, and the default depth 3 —
// which the model reads as "3" — renders at 1.80×. Observed twice in the app:
// the agent reports "3.0×" while the pill on screen reads 1.80×.
//
// Both sources of the confusion are now closed: the snapshot carries
// `renderedScale` (computed by the renderer's own `effectiveZoomScale`) beside
// the depth, and the descriptions carry `ZOOM_DEPTH_LEGEND`, derived from the
// table rather than retyped. What remains here is BEHAVIOURAL: whether a model
// holding the right number quotes it. That is a measurement, not a mechanism,
// so `beh.multiplier` stays in expectedFailures until a live run says otherwise.
//
// The table is IMPORTED here, never copied. When someone fixes the descriptions
// or the mapping, these checks follow the fix instead of outliving it.

import { getZoomScale, ZOOM_DEPTH_SCALES } from "../../src/components/video-editor/types";
import type { AxcutDocument } from "../../src/lib/ai-edition/schema";
import { migratedV17WithCustomScale, zoomedRecording } from "../lib/fixtures";
import { statedDurations, statedMultipliers } from "../lib/language";
import { defineScenario, fail, pass } from "../lib/scenario";

/**
 * What the viewer will actually see for each zoom.
 *
 * ponytail: `getZoomScale` is imported rather than reimplemented — it is the
 * renderer's own function, so `customScale` precedence and the 1.0–5.0 clamp
 * cannot drift away from what this check calls the truth. The cast is safe and
 * narrow: the document's zoom entries carry `depth` and `customScale` with the
 * same meanings, and the function reads nothing else.
 */
function renderedScales(document: AxcutDocument): number[] {
	return document.zoomRanges.map((zoom) =>
		getZoomScale(zoom as unknown as Parameters<typeof getZoomScale>[0]),
	);
}

/** Shared by both scenarios below: a stated "N×" must be a scale the renderer
 * can actually produce. Stating nothing passes — silence is honest, and a
 * check that forced a number out of the model would be measuring compliance
 * with the check rather than truthfulness. */
function multiplierCheck(weight: number) {
	return {
		id: "beh.multiplier",
		weight,
		check: (c: { answer: string; after: AxcutDocument }) => {
			const stated = statedMultipliers(c.answer);
			if (stated.length === 0) return pass();
			const truth = renderedScales(c.after);
			const wrong = stated.filter((value) => !truth.some((t) => Math.abs(t - value) < 0.01));
			if (wrong.length === 0) return pass();
			const ordinals = c.after.zoomRanges.map((z) => z.depth);
			const readAsOrdinal = wrong.filter((value) =>
				ordinals.includes(value as 1 | 2 | 3 | 4 | 5 | 6),
			);
			return fail(
				`annonce ${wrong.join("/")}× ; le rendu donnera ${truth.join("/") || "aucun zoom"}×` +
					(readAsOrdinal.length > 0
						? ` — le nombre annoncé EST l'ordinal depth, restitué comme un facteur (D2)`
						: ""),
			);
		},
	};
}

export default defineScenario({
	id: "describe-zooms",
	title: "D2 — restituer depth comme un facteur d'échelle",
	tags: ["D2", "env", "grounding"],
	prompt: "Describe the zooms in this project, including how strong each one is.",
	document: () => zoomedRecording({ depth: 3 }),
	gate: 0,
	reps: 3,

	behaviour: [
		{
			id: "beh.grounding",
			weight: 2,
			check: (c) =>
				c.firstIndexOf("getCurrentDocument") !== -1
					? pass()
					: fail("a décrit les zooms sans jamais appeler getCurrentDocument"),
		},
		// Weight 4: this scenario exists for this one check. Depth 3 renders at
		// 1.80×; "3×", "3.0×" and "3.5×" are all wrong, and the first two are
		// wrong in the specific way that proves the ordinal was read as a factor.
		multiplierCheck(4),
		{
			id: "beh.counts",
			weight: 2,
			check: (c) => {
				const said = Number(c.answer.match(/(\d+)\s+zooms?/i)?.[1] ?? Number.NaN);
				return Number.isNaN(said) || said === c.before.zoomRanges.length
					? pass()
					: fail(`annonce ${said} zooms, le document en porte ${c.before.zoomRanges.length}`);
			},
		},
		{
			id: "beh.no-invented-times",
			weight: 2,
			check: (c) => {
				const supported = [
					c.assetDuration(),
					c.compressedDurationSec(),
					0,
					...c.before.zoomRanges.flatMap((z) => [
						z.startMs / 1000,
						z.endMs / 1000,
						(z.endMs - z.startMs) / 1000,
					]),
				];
				const invented = statedDurations(c.answer).filter(
					(value) => !supported.some((t) => Math.abs(t - value) <= 0.5),
				);
				return invented.length === 0
					? pass()
					: fail(`temps sans correspondance : ${invented.join("/")} s`);
			},
		},
	],

	dsl: [
		{
			id: "dsl.no-mutation",
			weight: 4,
			check: (c) => {
				const writes = c.wire.calls.filter((k) => k.mutating);
				if (writes.length > 0) {
					return fail(
						`a édité sur une demande de description : ${writes.map((k) => k.name).join(", ")}`,
					);
				}
				return c.mutated ? fail("document muté sans appel mutant") : pass();
			},
		},
		{
			id: "dsl.turn.completed",
			weight: 2,
			check: (c) =>
				c.run.ok ? pass() : fail(`${c.classifyFailure()} : ${(c.run.error ?? "").slice(0, 200)}`),
		},
	],

	expectedFailures: {
		"beh.multiplier": {
			defect: "D2",
			since: "2026-07-31",
			note:
				"observé deux fois dans l'app : « 3.0× » annoncé, pill à 1.80×. " +
				"Intermittent — le modèle omet parfois tout multiplicateur, ce qui passe (le silence est honnête).",
		},
	},

	demoScript: [
		{ kind: "tools", calls: [{ name: "getCurrentDocument", args: {} }] },
		{
			kind: "text",
			text:
				"There is 1 zoom, running from 0:08 to 0:14 (6 seconds). " +
				"It is set to depth 3, so it magnifies the frame about 3.0×.",
		},
	],
});

/**
 * The same defect one storey down: a v1.7 project migrated by
 * `document/migrate.ts:185` carries BOTH `depth` and `customScale`.
 * `getZoomScale` (types.ts:441) returns `customScale` when present, so the
 * picture is at 1.10× whatever the depth says.
 *
 * It compounded. `customScale` was invisible in the snapshot — the projection
 * emitted `{id, startSec, endSec, depth, focus}` and nothing else — and NO tool
 * could write or clear it. So the model was asked to make the zoom stronger,
 * saw a field it could change, changed it, was told `ok:true` with the new
 * depth, and reported a magnification the renderer would never produce. Every
 * layer individually consistent, and the result a write that could not possibly
 * do what everyone involved believed it did.
 *
 * This was the sharpest available demonstration that the DSL axis cannot be
 * scored on tool returns: `setZoom` answered with the depth it was handed. Only
 * `after` knew the picture had not moved.
 *
 * Closed on both counts. The snapshot now carries `renderedScale`, `customScale`
 * and `depthIsOverridden`, so the field is visible; and a `setZoom` that changes
 * the depth CLEARS the override — an explicit request to change the strength is
 * the one thing that justifies dropping a fine-tuned value — reporting
 * `clearedCustomScale` and the resulting `renderedScale` rather than doing it
 * quietly. `dsl.custom-scale-consistent` is therefore out of expectedFailures:
 * it is now a real ratchet, and it goes red if the clearing is reverted.
 */
export const describeZoomsMigrated = defineScenario({
	id: "describe-zooms-migrated",
	title: "D2 — customScale rend le depth inopérant, sans que rien ne le dise",
	tags: ["D2", "env", "migration"],
	prompt:
		"Describe the zoom in this project and how strong it is, " +
		"then make it as strong as you can.",
	document: () => migratedV17WithCustomScale(),
	gate: 0,
	reps: 3,

	behaviour: [
		multiplierCheck(4),
		{
			id: "beh.grounding",
			weight: 2,
			check: (c) => {
				const read = c.firstIndexOf("getCurrentDocument");
				if (read === -1) return fail("n'a jamais appelé getCurrentDocument");
				return read < c.firstMutatingIndex() ? pass() : fail("a édité avant de lire");
			},
		},
	],

	dsl: [
		{
			id: "dsl.custom-scale-consistent",
			weight: 4,
			check: (c) => {
				// A depth write on a zoom that carries customScale is a no-op at
				// render. The model is not at fault for making it — nothing told it
				// the field existed — but the DOCUMENT is now in a state its author
				// does not believe it is in, and that is what this axis measures.
				//
				// ponytail: keyed on the WIRE, not on a before/after id match.
				// `replacePillSpan` re-mints region ids via `createId("zoom")` when it
				// re-ventilates a pill, so an id-joined comparison would find no pair
				// and report a silent pass — the exact false green this workbench
				// exists to avoid. The wire says what the model asked for; `after`
				// says customScale is still there and still wins.
				const depthWrites = c
					.calls("setZoom")
					.filter((k) => (k.args as { depth?: unknown } | undefined)?.depth !== undefined);
				const overridden = c.after.zoomRanges.filter((z) => z.customScale != null);
				if (depthWrites.length === 0 || overridden.length === 0) return pass();
				return fail(
					`${depthWrites.length} écriture(s) de depth sans effet visible : ` +
						overridden
							.map(
								(z) =>
									`${z.id} depth=${z.depth} (${ZOOM_DEPTH_SCALES[z.depth]}× attendu) ` +
									`mais customScale=${z.customScale} gagne au rendu`,
							)
							.join(" | "),
				);
			},
		},
		{
			id: "dsl.effect.honest",
			weight: 3,
			check: (c) => {
				const liars = c.wire.calls.filter((k) => k.mutating && !c.diffMatches(k));
				return liars.length === 0
					? pass()
					: fail(`resultJson ≠ document : ${liars.map((k) => `${k.name}#${k.id}`).join(", ")}`);
			},
		},
		{
			id: "dsl.turn.completed",
			weight: 2,
			check: (c) =>
				c.run.ok ? pass() : fail(`${c.classifyFailure()} : ${(c.run.error ?? "").slice(0, 200)}`),
		},
	],

	expectedFailures: {
		"beh.multiplier": {
			defect: "D2",
			since: "2026-07-31",
			note:
				"Le snapshot expose désormais renderedScale (1.10× ici, customScale) et " +
				"depthIsOverridden. Reste à mesurer en live si le modèle cite ce nombre plutôt " +
				"que le depth : comportemental, donc gardé jusqu'à une mesure, pas retiré sur la " +
				"lecture du code.",
		},
	},

	demoScript: [
		{ kind: "tools", calls: [{ name: "getCurrentDocument", args: {} }] },
		{ kind: "tools", calls: [{ name: "setZoom", args: { zoomId: "zoom_1", depth: 6 } }] },
		{
			kind: "text",
			text: "The zoom ran at depth 3. I pushed it to depth 6, the maximum — about 5× magnification.",
		},
	],
});
