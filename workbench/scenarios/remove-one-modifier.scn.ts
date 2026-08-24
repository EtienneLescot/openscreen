// ponytail: targeted deletion — four modifiers of three kinds, remove exactly
// one. It is the mirror image of `target-right-clip`: there, hit the right
// place; here, do not hit anything else.
//
// Three ways to get it wrong, and all three are scored separately because they
// call for different fixes:
//   1. wrong target — `zoom_1` instead of `zoom_2` (a grounding failure);
//   2. collateral damage — the speed region or the annotation goes too. Note
//      that `legacyEditor` is a `z.object({}).passthrough()` (schema/index.ts:
//      432), so a mangled `speedRegions` entry passes `documentSchema.parse`
//      without a murmur; `oracles.documentInvariants` hand-validates it, which
//      is the only reason this is detectable at all;
//   3. neutralisation instead of deletion — setting the span to zero or the
//      speed to 1×. The system prompt forbids it in as many words (service.ts:
//      69, and `removeModifier`'s own description at agent-tools.ts:485:
//      "never neutralise it (span 0, speed 1×): that leaves it in the
//      document"), which makes it a fair thing to measure — and a neutralised
//      region still renders in the pill row, so the user sees a deletion that
//      did not happen.
//
// The wire matters as much as the document for (3): a zero-span zoom and a
// deleted zoom look similar in a diff, and only the CALL says which was meant.

import { multipleModifiers } from "../lib/fixtures";
import { CLAIMS_ONLY_WHAT_HAPPENED, documentFacts, modifierCensus } from "../lib/rubrics";
import { defineScenario, fail, pass } from "../lib/scenario";

const TARGET_ID = "zoom_2";
const KEEP_ID = "zoom_1";

function speedRegions(document: { legacyEditor: unknown }): Array<{ id: string; speed?: number }> {
	const legacy = document.legacyEditor as Record<string, unknown> | null;
	const list = legacy?.speedRegions;
	return Array.isArray(list) ? (list as Array<{ id: string; speed?: number }>) : [];
}

export default defineScenario({
	id: "remove-one-modifier",
	title: "Suppression ciblée — retirer un modificateur précis parmi quatre",
	tags: ["targeting", "removal", "dsl"],
	prompt:
		"Remove the second zoom — the one around 0:20 — and leave everything else exactly as it is.",
	document: () => multipleModifiers(),
	gate: 0.6,
	reps: 3,

	behaviour: [
		{
			id: "beh.grounding",
			weight: 3,
			check: (c) => {
				// `removeModifier` takes an id and nothing else, so the model cannot
				// even name its target without reading first. A mutating call before
				// any read means the id was guessed.
				const read = c.firstIndexOf("getCurrentDocument");
				if (read === -1) return fail("a supprimé sans jamais lire les ids");
				return read < c.firstMutatingIndex() ? pass() : fail("a supprimé avant de lire les ids");
			},
		},
	],

	// ponytail: `CLAIMS_EDIT` cherchait une liste fermée de verbes anglais au
	// passé. Ce que le check veut savoir est resté le même — la réponse annonce-
	// t-elle une suppression que le document ne montre pas — mais la moitié
	// calculable est passée dans les faits, où elle était de toute façon plus
	// juste : le compte des modificateurs avant et après, plutôt qu'un booléen.
	judged: [
		{
			id: "beh.no-false-claim",
			weight: 2,
			rubric: CLAIMS_ONLY_WHAT_HAPPENED,
			// ponytail: le recensement porte sur TOUTES les familles, pas sur les
			// seuls zooms. La première version de ce fait comptait `zoomRanges` et
			// appelait le résultat « modificateurs » — il en annonçait donc 2 sur un
			// document qui en porte 4, et un juge à qui on affirme un faux compte
			// prononce un faux verdict : mesuré, il a validé « j'ai supprimé les
			// quatre modificateurs » sur un tour qui en avait retiré un. Le fait
			// faux est la façon la plus sûre de fabriquer un verdict faux, puisque
			// le juge a pour consigne de croire les faits contre la réponse.
			facts: (c) => [...documentFacts(c), ...modifierCensus(c)],
		},
	],

	dsl: [
		{
			id: "dsl.remove.correct-target",
			weight: 4,
			check: (c) => {
				const ids = new Set(c.after.zoomRanges.map((z) => z.id));
				const problems: string[] = [];
				if (ids.has(TARGET_ID)) problems.push(`${TARGET_ID} (0:20–0:25) est toujours là`);
				if (!ids.has(KEEP_ID)) problems.push(`${KEEP_ID} (0:05–0:09) a été supprimé à tort`);
				return problems.length === 0 ? pass() : fail(problems.join(" | "));
			},
		},
		{
			id: "dsl.remove.nothing-else",
			weight: 3,
			check: (c) => {
				const problems: string[] = [];
				const beforeSpeed = speedRegions(c.before);
				const afterSpeed = speedRegions(c.after);
				if (afterSpeed.length !== beforeSpeed.length) {
					problems.push(`speedRegions ${beforeSpeed.length} → ${afterSpeed.length}`);
				} else if (afterSpeed.some((s, i) => s.speed !== beforeSpeed[i].speed)) {
					problems.push("le multiplicateur d'une speed region a changé");
				}
				if (c.after.annotations.length !== c.before.annotations.length) {
					problems.push(
						`annotations ${c.before.annotations.length} → ${c.after.annotations.length}`,
					);
				}
				if (c.after.timeline.clips.length !== c.before.timeline.clips.length) {
					problems.push(
						`clips ${c.before.timeline.clips.length} → ${c.after.timeline.clips.length}`,
					);
				}
				if (c.after.timeline.trimRanges.length !== c.before.timeline.trimRanges.length) {
					problems.push("des trims ont bougé");
				}
				return problems.length === 0 ? pass() : fail(`dégâts collatéraux : ${problems.join(", ")}`);
			},
		},
		{
			id: "dsl.remove.not-neutralised",
			weight: 3,
			check: (c) => {
				// A `setZoom` that leaves the count unchanged is the forbidden
				// workaround. Zero-span regions are reported too, because the pill
				// stays in the row either way and the user reads that as "not
				// deleted".
				const setCalls = [
					...c.calls("setZoom"),
					...c.calls("setSpeed"),
					...c.calls("setAnnotation"),
				];
				const removedAny =
					c.after.zoomRanges.length < c.before.zoomRanges.length ||
					c.after.annotations.length < c.before.annotations.length ||
					speedRegions(c.after).length < speedRegions(c.before).length;
				if (setCalls.length > 0 && !removedAny) {
					return fail(
						`a neutralisé au lieu de supprimer (interdit explicitement par la description de ` +
							`removeModifier) : ${setCalls.map((k) => `${k.name} ${k.argsJson.slice(0, 60)}`).join(", ")}`,
					);
				}
				const zeroSpan = c.after.zoomRanges.filter((z) => z.endMs <= z.startMs);
				return zeroSpan.length === 0
					? pass()
					: fail(
							`zooms réduits à une durée nulle, toujours présents : ${zeroSpan.map((z) => z.id).join(", ")}`,
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

	// OFFLINE ONLY — the correct turn. Like `target-right-clip`, this demo is
	// the well-behaved one: the pack needs controls that can go green, or a
	// systematically red report stops carrying information.
	demoScript: [
		{ kind: "tools", calls: [{ name: "getCurrentDocument", args: {} }] },
		{ kind: "tools", calls: [{ name: "removeModifier", args: { id: TARGET_ID } }] },
		{
			kind: "text",
			text:
				"I removed the second zoom (0:20–0:25). The first zoom, the speed region " +
				"and the annotation are untouched.",
		},
	],
});
