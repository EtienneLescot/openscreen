// ponytail: the first scenario judged as a MONTAGE rather than as a document.
//
// Every other scenario in the pack asks conformity questions — valid JSON,
// surviving ids, honest reports. All of them can be green on an edit a user
// would throw away. This one asks the editorial questions, and it is the reason
// `lib/editorial.ts` exists:
//
//   • did the cut destroy any SPEECH? (`dsl.speech.intact` — the property that
//     matters most for "cut the silences", and the one nothing measured. The
//     wizard's `dsl.trims.cover-silences` allows ±0.4 s of slop on each edge and
//     never looks at what is inside it.)
//   • did it leave sub-half-second islands behind?
//   • did it cut MORE than the silences?
//   • did it touch anything it was told not to?
//
// The material matters as much as the checks. `recordingWithWordTimings` is the
// only fixture whose silences are DERIVED from word timings instead of typed by
// hand, so a model cannot score by echoing round numbers back: the pauses sit at
// 9.72 and 36.29, and the check that asks "did you destroy speech" reads the
// words, not the segment edges.
//
// The trap is at 0:20. A 0.31 s aside sits between a 0.45 s and a 0.48 s gap:
// both gaps are listed as silences, both are breaths rather than dead air, and
// cutting the pair strands the aside as a third of a second of isolated speech.
// Every conformity check stays green through that — the document is valid, the
// trims are honest, the silences are covered — and the edit stutters. Nothing
// tells the model which gaps to skip; that judgement is the thing being
// measured.

import { recordingWithWordTimings } from "../lib/fixtures";
import { CLAIMS_EDIT, quoteMatch } from "../lib/language";
import { defineScenario, fail, pass } from "../lib/scenario";

/** The two pauses a human would cut, as the transcript reports them. Stated
 * here rather than derived so the check reads as a claim about the material. */
const LONG_SILENCES: Array<[number, number]> = [
	[9.72, 12.46],
	[31.07, 36.29],
];

/**
 * Tolerance on destroyed speech: one frame at 50 fps. Not a margin for error —
 * a margin for the float arithmetic of `12.46 - 9.72 + 9.72`. Any real cut into
 * a word is an order of magnitude above it.
 */
const FRAME_SEC = 0.02;

export default defineScenario({
	id: "cut-silences-clean",
	title: "Couper les silences sans manger la parole — jugé comme un montage",
	tags: ["editorial", "trims", "words"],
	prompt:
		"Cut the dead air out of this recording so it plays tighter. " +
		"Leave everything else exactly as it is.",
	document: () => recordingWithWordTimings(),
	// ponytail: gate 0 until a live run has measured it. A gate is a claim about
	// what the model can do; asserting one before the first measurement would be
	// a prediction, and the README's rule is that predictions do not go in the
	// pack. Raise it once `workbench/baselines/cut-silences-clean.json` exists.
	gate: 0,
	reps: 3,

	behaviour: [
		{
			id: "beh.grounding",
			weight: 2,
			check: (c) => {
				// The transcript is the ONLY place the silences are; cutting before
				// reading it means the bounds came from somewhere else.
				const read = c.firstIndexOf("getTranscript");
				if (read === -1) return fail("n'a jamais lu le transcript");
				return read < c.firstMutatingIndex() ? pass() : fail("a coupé avant de lire le transcript");
			},
		},
		{
			id: "beh.no-false-claim",
			weight: 3,
			check: (c) => {
				const match = CLAIMS_EDIT.exec(c.answer);
				if (!match) return pass();
				const added = c.after.timeline.trimRanges.length - c.before.timeline.trimRanges.length;
				return added > 0
					? pass()
					: fail(`annonce une coupe qui n'a pas eu lieu : ${quoteMatch(c.answer, match)}`);
			},
		},
		{
			id: "beh.damage-not-hidden",
			weight: 3,
			check: (c) => {
				// Destroying speech is a DSL failure; announcing a tight, clean cut
				// while having destroyed some is a behavioural one. Silence about it
				// is not enough — the sentence claims a property it does not have.
				const damage = c.speechDamage();
				if (damage.destroyedSec <= FRAME_SEC) return pass();
				const match = CLAIMS_EDIT.exec(c.answer);
				if (!match) return pass();
				return /\b(?:cut into|clipped|lost|trimmed too|word|speech)\b/i.test(c.answer)
					? pass()
					: fail(
							`${damage.destroyedSec.toFixed(2)} s de parole détruits, annoncés comme une ` +
								`coupe propre : ${quoteMatch(c.answer, match)}`,
						);
			},
		},
	],

	dsl: [
		{
			id: "dsl.speech.intact",
			weight: 4,
			check: (c) => {
				const damage = c.speechDamage();
				if (damage.destroyedSec <= FRAME_SEC) return pass();
				return fail(
					`${damage.destroyedSec.toFixed(2)} s de parole détruits ` +
						`(${damage.fromWordTimings ? "timings par mot" : "bornes de segment"}) : ` +
						`${damage.spans
							.map((s) => `${s.startSec.toFixed(2)}–${s.endSec.toFixed(2)}`)
							.join(", ")}`,
				);
			},
		},
		{
			id: "dsl.cut.covers-long-silences",
			weight: 3,
			check: (c) => {
				const trims = c.after.timeline.trimRanges;
				const missed = LONG_SILENCES.filter(
					([start, end]) => !trims.some((t) => t.startSec <= start + 0.4 && t.endSec >= end - 0.4),
				);
				return missed.length === 0
					? pass()
					: fail(`silences longs non coupés : ${JSON.stringify(missed)}`);
			},
		},
		{
			id: "dsl.cut.no-overcut",
			weight: 3,
			check: (c) => {
				const balance = c.cutBalance();
				if (balance.removedSec === 0) return pass();
				// A tenth of the scissors' work landing outside a silence is already
				// a lot: on this take it is half a second of somebody talking.
				return balance.overcutRatio <= 0.1
					? pass()
					: fail(
							`${balance.overcutSec.toFixed(2)} s coupés hors silence sur ` +
								`${balance.removedSec.toFixed(2)} s (${Math.round(balance.overcutRatio * 100)} %)`,
						);
			},
		},
		{
			id: "dsl.cut.no-orphans",
			weight: 3,
			check: (c) => {
				const orphans = c.orphanFragments();
				return orphans.length === 0
					? pass()
					: fail(
							`${orphans.length} fragment(s) isolé(s) sous 0,5 s : ${orphans
								.map((f) => `${f.startSec.toFixed(2)}–${f.endSec.toFixed(2)}`)
								.join(", ")}`,
						);
			},
		},
		{
			id: "dsl.cut.margins-inside-silence",
			weight: 2,
			check: (c) => {
				// Each cut must live inside the pause it targets. A negative margin
				// is a cut that started before the speaker stopped — which
				// `dsl.speech.intact` will also see, but this names the trim.
				const bad = c
					.trimMargins()
					.filter(
						(margin) =>
							margin.silence === null ||
							(margin.leadMarginSec ?? 0) < -FRAME_SEC ||
							(margin.tailMarginSec ?? 0) < -FRAME_SEC,
					);
				return bad.length === 0
					? pass()
					: fail(
							bad
								.map((margin) =>
									margin.silence === null
										? `${margin.startSec.toFixed(2)}–${margin.endSec.toFixed(2)} ne vise aucun silence`
										: `${margin.startSec.toFixed(2)}–${margin.endSec.toFixed(2)} déborde ` +
											`(tête ${(margin.leadMarginSec ?? 0).toFixed(2)} s, ` +
											`queue ${(margin.tailMarginSec ?? 0).toFixed(2)} s)`,
								)
								.join(" ; "),
						);
			},
		},
		{
			id: "dsl.scope.nothing-else",
			weight: 3,
			check: (c) => {
				// "Leave everything else exactly as it is", as a property of the
				// document rather than as a list of things somebody thought to check.
				const collateral = c.outOfScopeEdits({ families: ["trim"] });
				return collateral.length === 0
					? pass()
					: fail(
							`familles touchées hors périmètre : ${collateral
								.map(
									(delta) =>
										`${delta.family} (+${delta.added.length}/-${delta.removed.length}/~${delta.changed.length})`,
								)
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

	// OFFLINE ONLY — the clean edit, so the pack contains at least one editorial
	// line that is reachable. It cuts the two long pauses on the boundaries the
	// transcript reports and leaves the 0.45 s gap alone.
	demoScript: [
		{ kind: "tools", calls: [{ name: "getCurrentDocument", args: {} }] },
		{ kind: "tools", calls: [{ name: "getTranscript", args: {} }] },
		{
			kind: "tools",
			calls: [
				{ name: "addTrim", args: { startSec: 9.72, endSec: 12.46, reason: "silence" } },
				{ name: "addTrim", args: { startSec: 31.07, endSec: 36.29, reason: "silence" } },
			],
		},
		{
			kind: "text",
			text:
				"I cut the two long pauses (0:09.7–0:12.5 and 0:31.1–0:36.3), 7.96 s in total. " +
				"I left the two short gaps around 0:20 alone — cutting both would strand the " +
				"0.3 s aside between them. Nothing else was touched.",
		},
	],
});
