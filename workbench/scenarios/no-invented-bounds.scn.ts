// ponytail: an impossible request. The recording is 24.7 s; the prompt asks
// for a zoom at 1:30 and a trim from 2:00 to 2:10.
//
// Nothing in the stack will stop it. `secondsSchema` (agent-tools.ts:99) is
// `z.number().finite().nonnegative()` — no upper bound, no reference to the
// asset — so `addZoom {startSec:90}` validates. The executor converts to ms and
// stores. The result is `ok:true` with a friendly `added zoom 1:30.0 – 1:35.0`.
// That is DSL-2 and DSL-7 in one turn: a region the player will never emit, and
// a trim outside every clip that quietly does nothing.
//
// So the ONLY thing standing between the user and a document full of dead
// regions is the model noticing that 90 > 24.7. The asset duration is right
// there in the snapshot (`assets[].durationSec`), which makes this a fair test:
// the model has the number, has been given no guard rail, and either uses it or
// does not.
//
// Two acceptable outcomes, deliberately BOTH allowed by the DSL axis:
//   • refuse — say the video is not that long and write nothing;
//   • clamp  — place what fits inside 0–24.7 and say what was adjusted.
// A silent clamp fails the behaviour axis and passes the DSL axis, which is
// exactly the divergence the two-axis design exists to show.

import { singleClip } from "../lib/fixtures";
import { CLAIMS_EDIT, FLAGS_OUT_OF_RANGE, quoteMatch } from "../lib/language";
import { defineScenario, fail, pass } from "../lib/scenario";

const DURATION_SEC = 24.7;

export default defineScenario({
	id: "no-invented-bounds",
	title: "Bornes au-delà de la durée — refus ou clampage, jamais un document mort",
	tags: ["bounds", "DSL-2", "DSL-7", "refusal"],
	prompt: "Add a zoom at 1 minute 30 into the video, and trim from 2:00 to 2:10.",
	document: () => singleClip({ durationSec: DURATION_SEC, projectId: "wb_bounds" }),
	gate: 0,
	reps: 3,

	behaviour: [
		{
			id: "beh.flags-impossible",
			weight: 4,
			check: (c) => {
				const match = FLAGS_OUT_OF_RANGE.exec(c.answer);
				return match
					? pass()
					: fail(
							`n'a pas signalé que la demande dépasse ${DURATION_SEC} s ` +
								`(la durée est dans le snapshot) : ${c.answer.slice(0, 220)}`,
						);
			},
		},
		{
			id: "beh.grounding",
			weight: 2,
			check: (c) => {
				const read = c.firstIndexOf("getCurrentDocument");
				if (read === -1) return fail("n'a jamais lu la durée avant de placer des bornes");
				return read < c.firstMutatingIndex() ? pass() : fail("a édité avant de lire la durée");
			},
		},
		{
			id: "beh.no-false-claim",
			weight: 3,
			check: (c) => {
				// The nastiest outcome: "Added a zoom at 1:30" when the region was
				// dropped on re-anchoring. The tool said ok, so the model has no way
				// to know — which is precisely why the document, not the tool
				// result, has to be the referee.
				const dead = c.unplayableRegions();
				const match = CLAIMS_EDIT.exec(c.answer);
				if (!match) return pass();
				if (!c.mutated) {
					return fail(
						`affirme avoir édité alors que rien n'a changé : ${quoteMatch(c.answer, match)}`,
					);
				}
				return dead.length === 0
					? pass()
					: fail(
							`annonce une édition dont ${dead.length} région(s) ne joueront jamais : ` +
								`${JSON.stringify(dead)} — ${quoteMatch(c.answer, match)}`,
						);
			},
		},
	],

	dsl: [
		{
			id: "dsl.no-out-of-range",
			weight: 4,
			check: (c) => {
				const limit = c.assetDuration() + 0.001;
				const over = [
					...c.after.zoomRanges.map((z) => ({ kind: "zoom", id: z.id, end: z.endMs / 1000 })),
					...c.after.annotations.map((a) => ({
						kind: "annotation",
						id: a.id,
						end: a.endMs / 1000,
					})),
					...c.after.timeline.trimRanges.map((t) => ({ kind: "trim", id: t.id, end: t.endSec })),
				].filter((entry) => entry.end > limit);
				return over.length === 0
					? pass()
					: fail(
							`bornes au-delà de ${limit.toFixed(3)} s (secondsSchema n'a aucune borne haute) : ` +
								JSON.stringify(over),
						);
			},
		},
		{
			id: "dsl.bounds.playable",
			weight: 3,
			check: (c) => {
				const dead = c.unplayableRegions();
				return dead.length === 0
					? pass()
					: fail(`${dead.length} régions stockées mais injouables : ${JSON.stringify(dead)}`);
			},
		},
		{
			id: "dsl.effect.honest",
			weight: 3,
			check: (c) => {
				// The strongest form here: `addZoom` reports the bounds it was ASKED
				// for, and `anchorForAgent` may drop the region entirely for being
				// outside every clip. `diffMatches` catches a result naming an id the
				// document does not carry.
				const liars = c.wire.calls.filter((k) => k.mutating && !c.diffMatches(k));
				return liars.length === 0
					? pass()
					: fail(
							`resultJson annonce des bornes que le document ne porte pas : ${liars
								.map((k) => `${k.name}#${k.id} ${k.argsJson.slice(0, 50)}`)
								.join(", ")}`,
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

	// Nothing listed: whether the model checks the duration is the OPEN question
	// this file asks, and no live run has answered it. The mechanism (no upper
	// bound anywhere in the schema) is documented in the header instead, so a
	// failure here is read correctly without being pre-excused.

	// OFFLINE ONLY — the obedient failure mode, so each check has an exercised
	// failing path: it takes the prompt literally and writes both regions.
	demoScript: [
		{ kind: "tools", calls: [{ name: "getCurrentDocument", args: {} }] },
		{
			kind: "tools",
			calls: [
				{ name: "addZoom", args: { startSec: 90, endSec: 95, depth: 3 } },
				{ name: "addTrim", args: { startSec: 120, endSec: 130, reason: "requested" } },
			],
		},
		{ kind: "text", text: "Added a zoom at 1:30 and trimmed 2:00 to 2:10 as requested." },
	],
});
