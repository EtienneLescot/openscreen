// ponytail: this scenario used to measure a HOLE in the tool surface. It now
// measures the tool that filled it, and the guard that closed the escape route.
//
// What it was: `moveClip` existed and worked in `document/timeline.ts`
// ("preserves all user-placed clip ids, origins, and source ranges") and
// reached no tool. The system prompt nonetheless told the model "Anything else
// (move a clip, … change a clip's order, etc.) — pick the most specific tool":
// it named the operation and promised a tool for it. The most specific tool the
// model could actually find was `replaceTimeline`, and taking it was worse than
// doing nothing:
//   • `normalizeIntervals` SORTS, so [30-60, 0-30] came back ascending and the
//     swap did not happen;
//   • it also MERGES adjacent intervals, so the two clips collapsed into one
//     and every id was re-minted (DSL-8);
//   • `invertIntervals` then found nothing outside the kept span, so the user's
//     12–17 s cut was deleted — unmentioned;
//   • and it returned `ok: true`, on which the model reported the trim
//     preserved.
// One call: the request unfulfilled, the ids rewritten, an edit destroyed, and
// a confident summary.
//
// What it is now: `moveClip` is the 18th tool, `replaceTimeline` refuses any
// call that would merge away or drop a clip (and any call whose intervals are
// not ascending, since that is a reorder it cannot perform), and the pure
// rebuild preserves ids, trims and anchors. So the swap is REACHABLE, and this
// file is the end-to-end proof that the model can find it. `dsl.uses-move-tool`
// is what would catch a regression of the tool surface; the preserved-clip and
// preserved-trim checks stay exactly as they were, because what they forbid has
// not changed.

import { twoClipsWithTrim } from "../lib/fixtures";
import { CLAIMS_ONLY_WHAT_HAPPENED, documentFacts, REPORTS_WHAT_IT_DID } from "../lib/rubrics";
import type { EvalContext } from "../lib/scenario";
import { defineScenario, fail, pass } from "../lib/scenario";

/** The clips' source windows in timeline order — the only reliable read of
 *  "what plays first", since ids are exactly what a bad turn rewrites. */
function orderOf(
	clips: ReadonlyArray<{ timelineStartSec: number; sourceStartSec: number; sourceEndSec?: number }>,
): string[] {
	return [...clips]
		.sort((a, b) => a.timelineStartSec - b.timelineStartSec)
		.map((clip) => `${clip.sourceStartSec}-${clip.sourceEndSec}`);
}

function swapped(
	before: Parameters<typeof orderOf>[0],
	after: Parameters<typeof orderOf>[0],
): boolean {
	const from = orderOf(before);
	const to = orderOf(after);
	return to.length === from.length && to.every((span, i) => span === from[from.length - 1 - i]);
}

/**
 * Ce que le document dit de l'ordre, avant et après — les FAITS du tour.
 *
 * ponytail: l'attente du scénario ne monte pas au juge, seulement ce qui s'est
 * produit. « les places ont été échangées » est un fait sur le document ;
 * « c'est ce qui était demandé » est la conclusion, et elle reste au juge, qui
 * a la demande verbatim sous les yeux pour la tirer.
 */
function orderFacts(c: EvalContext): string[] {
	return [
		`fenêtres source des clips, dans l'ordre de lecture, avant le tour : ` +
			`[${orderOf(c.before.timeline.clips).join(", ")}]`,
		`les mêmes après le tour : [${orderOf(c.after.timeline.clips).join(", ")}]`,
		swapped(c.before.timeline.clips, c.after.timeline.clips)
			? "les deux clips ont échangé leurs places"
			: "les clips n'ont pas échangé leurs places",
		...documentFacts(c),
	];
}

export default defineScenario({
	id: "reorder-clips",
	title: "Réordonner deux clips — moveClip, sans rien détruire",
	tags: ["scope", "DSL-3", "DSL-8"],
	prompt: "Swap the two clips: put the demo first.",
	document: () => twoClipsWithTrim(),
	gate: 0,
	reps: 3,

	behaviour: [],

	// ponytail: les DEUX directions de `CLAIMS_EDIT`, et c'est ici qu'elles se
	// voyaient le mieux — le même regex servait à interdire l'annonce de ce qui
	// n'a pas eu lieu et à exiger l'annonce de ce qui a eu lieu. Le second usage
	// est celui que la regex anglaise punissait le plus durement : il exigeait
	// une correspondance POSITIVE, donc un tour qui réussissait l'échange et
	// l'annonçait en français échouait, pour une raison qui ne parle pas du
	// modèle et qui ne se distinguait pas d'un tour muet.
	//
	// Deux rubrics et non un seul, parce que les deux défauts sont réciproques
	// sans être symétriques : annoncer ce qui n'a pas eu lieu est un mensonge,
	// taire ce qui a eu lieu est un abandon du lecteur. Ils ne pèsent pas pareil
	// — 3 contre 2, comme avant — et un rubric unique rendrait les deux verdicts
	// identiques, donc l'un des deux poids inutile.
	//
	// LA MOITIÉ CALCULÉE N'A PAS BOUGÉ, et c'est elle qui portait la finesse de
	// ce scénario : « égale l'ordre RENVERSÉ », pas « diffère de l'ordre
	// d'avant ». La version lâche validait la vieille démo destructrice —
	// `normalizeIntervals` triait et fusionnait [30-60, 0-30] en un seul clip
	// 0-60, la disposition changeait, aucun échange n'avait lieu, et un check
	// demandant seulement « quelque chose a-t-il bougé ? » certifiait
	// l'annonce. Détruire la timeline n'est pas l'échanger. Ce calcul est
	// désormais un FAIT remis au juge.
	judged: [
		{
			id: "beh.no-false-claim",
			weight: 3,
			rubric: CLAIMS_ONLY_WHAT_HAPPENED,
			facts: orderFacts,
		},
		{
			id: "beh.reports-the-swap",
			weight: 2,
			rubric: REPORTS_WHAT_IT_DID,
			facts: orderFacts,
		},
	],

	dsl: [
		{
			id: "dsl.uses-move-tool",
			weight: 4,
			check: (c) =>
				c.calls("moveClip").length > 0
					? pass()
					: fail(
							"n'a pas appelé moveClip — l'outil de réordonnancement existe désormais " +
								`(appels : ${c.wire.calls.map((k) => k.name).join(", ") || "aucun"})`,
						),
		},
		{
			id: "dsl.no-destructive-workaround",
			weight: 4,
			check: (c) => {
				const destructive = [...c.calls("replaceTimeline"), ...c.calls("removeClip")];
				return destructive.length === 0
					? pass()
					: fail(
							`contournement destructeur : ${destructive
								.map((k) => `${k.name} ${k.argsJson.slice(0, 70)}`)
								.join(", ")} — moveClip fait exactement ce qui est demandé`,
						);
			},
		},
		{
			id: "dsl.order.swapped",
			weight: 4,
			check: (c) => {
				const expected = [...orderOf(c.before.timeline.clips)].reverse();
				const got = orderOf(c.after.timeline.clips);
				return got.join("|") === expected.join("|")
					? pass()
					: fail(`ordre attendu [${expected.join(", ")}], obtenu [${got.join(", ")}]`);
			},
		},
		{
			id: "dsl.clips.preserved",
			weight: 3,
			check: (c) => {
				const before = c.before.timeline.clips.map((x) => x.id).sort();
				const after = c.after.timeline.clips.map((x) => x.id).sort();
				const lost = before.filter((id) => !after.includes(id));
				return lost.length === 0
					? pass()
					: fail(`clips perdus ou renommés : ${lost.join(", ")} → ${after.join(", ")}`);
			},
		},
		{
			id: "dsl.trims.preserved",
			weight: 3,
			check: (c) => {
				// The user's 12–17 s cut is not part of the request. Any turn that
				// loses it has damaged work it was never asked to touch.
				const missing = c.before.timeline.trimRanges.filter(
					(trim) =>
						!c.after.timeline.trimRanges.some(
							(other) =>
								Math.abs(other.startSec - trim.startSec) < 0.01 &&
								Math.abs(other.endSec - trim.endSec) < 0.01,
						),
				);
				return missing.length === 0
					? pass()
					: fail(`trims détruits : ${missing.map((t) => `${t.startSec}-${t.endSec}`).join(", ")}`);
			},
		},
		{
			id: "dsl.turn.completed",
			weight: 2,
			check: (c) =>
				c.run.ok ? pass() : fail(`${c.classifyFailure()} : ${(c.run.error ?? "").slice(0, 200)}`),
		},
	],

	// OFFLINE ONLY — the path the fix makes available: read the timeline (the
	// snapshot now carries each clip's `reason`, which is the only thing that
	// tells "the demo" from "the intro"), then one moveClip.
	demoScript: [
		{ kind: "tools", calls: [{ name: "getCurrentDocument", args: {} }] },
		{
			kind: "tools",
			calls: [{ name: "moveClip", args: { clipId: "clip_2", beforeClipId: "clip_1" } }],
		},
		{
			kind: "text",
			text: "I swapped the clips — the demo now plays first, and your 12–17 s trim is untouched.",
		},
	],
});
