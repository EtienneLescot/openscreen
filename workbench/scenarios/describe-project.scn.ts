// ponytail: "décrit-il correctement l'état du projet ?" — the plainest form of
// the behaviour axis, and the one with the strongest oracle: every claim is
// checkable against `c.before`.
//
// It is also the scenario that exposes the blind first turn. NO snapshot of the
// document is injected into the system prompt; `getCurrentDocument` is the only
// door. Two texts tell the model otherwise — `deep-agent/service.ts:76` and
// `agent-tools.ts:208` both say "if the snapshot in the system prompt may be
// stale" — so a model that answers straight away is following the instructions
// it was given and describing a project it has not seen.

import { twoClipsWithTrim } from "../lib/fixtures";
import { defineScenario, fail, pass } from "../lib/scenario";

const ASK =
	"Describe the current state of this project: what media, how long, " +
	"what edits are already applied.";

/** Durations quoted as `M:SS` or as `N seconds`/`N s`. */
function statedDurations(answer: string): number[] {
	const out: number[] = [];
	for (const match of answer.matchAll(/\b(\d{1,2}):([0-5]\d(?:\.\d+)?)\b/g)) {
		out.push(Number(match[1]) * 60 + Number(match[2]));
	}
	for (const match of answer.matchAll(/\b(\d+(?:[.,]\d+)?)\s*(?:seconds?|secs?|s)\b/gi)) {
		out.push(Number(match[1].replace(",", ".")));
	}
	return out;
}

/**
 * Every time value the document legitimately supports: the ruler length, the
 * played length, each clip's position and length, and each trim's bounds and
 * length.
 *
 * ponytail: the first live run failed this check three times out of three, and
 * the model was right every time — it had said "two 30 s clips, a 5 s trim from
 * 0:12 to 0:17", all of it true. The check was scraping every number followed
 * by "s" and demanding it equal the TOTAL. An oracle that punishes accurate
 * detail teaches nothing; the real question is whether a quoted number
 * corresponds to anything in the project at all.
 */
function supportedTimes(context: {
	assetDuration: () => number;
	compressedDurationSec: () => number;
	before: ReturnType<typeof twoClipsWithTrim>;
}): number[] {
	const values = [context.assetDuration(), context.compressedDurationSec(), 0];
	for (const clip of context.before.timeline.clips) {
		values.push(clip.timelineStartSec, clip.timelineEndSec);
		values.push(clip.timelineEndSec - clip.timelineStartSec);
	}
	for (const trim of context.before.timeline.trimRanges) {
		values.push(trim.startSec, trim.endSec, trim.endSec - trim.startSec);
	}
	for (const zoom of context.before.zoomRanges) {
		values.push(zoom.startMs / 1000, zoom.endMs / 1000, (zoom.endMs - zoom.startMs) / 1000);
	}
	return values;
}

export default defineScenario({
	id: "describe-project",
	title: "Décrire l'état du projet — deux clips et un trim",
	tags: ["env", "grounding"],
	prompt: ASK,
	document: () => twoClipsWithTrim(),
	gate: 0.6,
	reps: 3,

	behaviour: [
		{
			id: "beh.grounding",
			weight: 3,
			check: (c) =>
				c.firstIndexOf("getCurrentDocument") !== -1
					? pass()
					: fail("a décrit le projet sans jamais appeler getCurrentDocument"),
		},
		{
			id: "beh.no-invented-times",
			weight: 3,
			check: (c) => {
				// Note the two legitimate answers to "how long is it?", which the
				// model is never told differ: the ruler length (60 s) and the length
				// the edit actually plays for once the trim is applied (55 s). Both
				// are in the supported set; a number matching NEITHER those nor any
				// clip or trim quantity was invented.
				const stated = statedDurations(c.answer);
				if (stated.length === 0) return pass();
				const supported = supportedTimes(c);
				const invented = stated.filter(
					(value) => !supported.some((t) => Math.abs(t - value) <= 0.5),
				);
				return invented.length === 0
					? pass()
					: fail(
							`temps sans correspondance dans le document : ${invented.join("/")} s ` +
								`(règle ${c.assetDuration()} s, joué ${c.compressedDurationSec().toFixed(1)} s)`,
						);
			},
		},
		{
			id: "beh.counts",
			weight: 3,
			check: (c) => {
				const problems: string[] = [];
				const claim = (pattern: RegExp, actual: number, label: string) => {
					const said = Number(c.answer.match(pattern)?.[1] ?? Number.NaN);
					if (!Number.isNaN(said) && said !== actual) {
						problems.push(`${label}: annonce ${said}, document ${actual}`);
					}
				};
				claim(/(\d+)\s+clips?/i, c.before.timeline.clips.length, "clips");
				claim(/(\d+)\s+trims?/i, c.before.timeline.trimRanges.length, "trims");
				claim(/(\d+)\s+zooms?/i, c.before.zoomRanges.length, "zooms");
				return problems.length === 0 ? pass() : fail(problems.join(" | "));
			},
		},
		{
			id: "beh.no-fabrication",
			weight: 3,
			check: (c) => {
				const known = new Set<string>([
					...c.before.timeline.clips.map((x) => x.id),
					...c.before.timeline.trimRanges.map((x) => x.id),
					...c.before.zoomRanges.map((x) => x.id),
					...c.before.assets.map((x) => x.id),
				]);
				const cited = [...c.answer.matchAll(/\b((?:clip|trim|zoom|asset)_[A-Za-z0-9-]+)\b/g)].map(
					(m) => m[1],
				);
				const invented = [...new Set(cited)].filter((id) => !known.has(id));
				return invented.length === 0
					? pass()
					: fail(`ids inexistants cités : ${invented.join(", ")}`);
			},
		},
		{
			id: "beh.sandbox",
			weight: 2,
			check: (c) => {
				const probes = c.callsToPhantomTools();
				return probes.length === 0
					? pass()
					: fail(`a sondé le FS virtuel vide : ${probes.map((k) => k.name).join(", ")}`);
			},
		},
	],

	dsl: [
		{
			id: "dsl.no-mutation",
			weight: 4,
			check: (c) => {
				// A question is not an instruction. Any write here is an unrequested
				// edit, and `c.mutated` is checked as well as the wire because
				// `runChat` only returns a document when something changed.
				const writes = c.wire.calls.filter((k) => k.mutating);
				if (writes.length > 0) {
					return fail(`a édité sur une simple question : ${writes.map((k) => k.name).join(", ")}`);
				}
				return c.mutated ? fail("runChat a renvoyé un document muté sans appel mutant") : pass();
			},
		},
		{
			id: "dsl.turn.completed",
			weight: 2,
			check: (c) =>
				c.run.ok ? pass() : fail(`${c.classifyFailure()} : ${(c.run.error ?? "").slice(0, 200)}`),
		},
	],

	// OFFLINE ONLY — a well-behaved turn: read first, then answer with numbers
	// that match the fixture (60 s on the ruler, 55 s played).
	demoScript: [
		{ kind: "tools", calls: [{ name: "getCurrentDocument", args: {} }] },
		{
			kind: "text",
			text:
				"This project holds one recording split into 2 clips (intro and demo). " +
				"The source runs 60 seconds; with the 1 trim already applied the edit plays " +
				"for 55 seconds. There are 0 zooms so far.",
		},
	],
});
