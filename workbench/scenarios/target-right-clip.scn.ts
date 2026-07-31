// ponytail: can the model put an effect where it was asked to, when there is
// more than one candidate? Two clips, a named target, one zoom.
//
// The oracle is the ANCHOR, not the numbers the model sent. Every agent write
// goes through `anchorForAgent` (agent-tools.ts:86), which resolves the virtual
// span against the clip layout and stores `clipId` + the source window. So the
// question "did it hit the demo clip?" has an exact answer in the document,
// and it survives the model expressing itself in whatever time-base it likes.
//
// That matters here because the fixture carries a trim (12–17 s), so the two
// plausible readings of "the middle of the second clip" differ:
//   • RAW virtual (what the code means): clip_2 sits at 30–60, middle 45.
//   • compressed (what the written contract says — `agent-tools.ts:536` and
//     `service.ts:61` both describe "after clips + trims are applied"): the
//     5 s cut shifts clip_2 to 25–55 on the played ruler, middle 40.
// Both land inside clip_2, so this scenario measures TARGETING and nothing
// else. The time-base ambiguity is deliberately left un-scored here — it is
// `wizard-enhance`'s problem, where a cumulative trim offset moves every
// subsequent effect — and mixing the two would make a failure unreadable.

import { twoClipsWithTrim } from "../lib/fixtures";
import { defineScenario, fail, pass } from "../lib/scenario";

const TARGET_CLIP_ID = "clip_2";
const TARGET_START_SEC = 30;
const TARGET_END_SEC = 60;

export default defineScenario({
	id: "target-right-clip",
	title: "Ciblage — un zoom sur le SECOND clip parmi deux",
	tags: ["targeting", "dsl"],
	prompt: "Add a zoom in the middle of the second clip, the demo one.",
	document: () => twoClipsWithTrim(),
	// A healthy scenario, not a known-broken one: the gate is real so a
	// regression in targeting fails the run rather than being noted.
	gate: 0.6,
	reps: 3,

	behaviour: [
		{
			id: "beh.grounding",
			weight: 3,
			check: (c) => {
				// It cannot know which clip is "the demo one" without reading —
				// the label lives in the document, not in the prompt.
				const read = c.firstIndexOf("getCurrentDocument");
				if (read === -1) return fail("a ciblé un clip sans jamais lire le document");
				return read < c.firstMutatingIndex()
					? pass()
					: fail("a édité avant tout appel à getCurrentDocument");
			},
		},
		{
			id: "beh.no-fabrication",
			weight: 2,
			check: (c) => {
				const known = new Set<string>([
					...c.after.timeline.clips.map((x) => x.id),
					...c.after.timeline.trimRanges.map((x) => x.id),
					...c.after.zoomRanges.map((x) => x.id),
				]);
				const invented = [
					...new Set(
						[...c.answer.matchAll(/\b((?:clip|trim|zoom)_[A-Za-z0-9-]+)\b/g)].map((m) => m[1]),
					),
				].filter((id) => !known.has(id));
				return invented.length === 0
					? pass()
					: fail(`ids inexistants cités : ${invented.join(", ")}`);
			},
		},
	],

	dsl: [
		{
			id: "dsl.target.correct-clip",
			weight: 4,
			check: (c) => {
				const before = new Set(c.before.zoomRanges.map((z) => z.id));
				const added = c.after.zoomRanges.filter((z) => !before.has(z.id));
				if (added.length === 0) return fail("aucun zoom ajouté");
				const wrong = added.filter((z) => z.clipId !== TARGET_CLIP_ID);
				return wrong.length === 0
					? pass()
					: fail(
							`zoom ancré au mauvais clip : ${wrong
								.map((z) => `${z.id} → ${z.clipId ?? "(non ancré)"}`)
								.join(", ")} ; attendu ${TARGET_CLIP_ID} (« demo », 30–60 s)`,
						);
			},
		},
		{
			id: "dsl.bounds.in-clip",
			weight: 3,
			check: (c) => {
				const before = new Set(c.before.zoomRanges.map((z) => z.id));
				const added = c.after.zoomRanges.filter((z) => !before.has(z.id));
				if (added.length === 0) return fail("aucun zoom ajouté");
				const outside = added.filter(
					(z) => z.startMs / 1000 < TARGET_START_SEC - 0.5 || z.endMs / 1000 > TARGET_END_SEC + 0.5,
				);
				return outside.length === 0
					? pass()
					: fail(
							`hors de la fenêtre ${TARGET_START_SEC}–${TARGET_END_SEC} s : ${outside
								.map((z) => `${z.startMs / 1000}–${z.endMs / 1000}`)
								.join(", ")}`,
						);
			},
		},
		{
			id: "dsl.single-zoom",
			weight: 2,
			check: (c) => {
				const added = c.after.zoomRanges.length - c.before.zoomRanges.length;
				// A region straddling a clip boundary is stored as several anchored
				// fragments that read as ONE pill, so >1 is only wrong when the
				// fragments do not share a clip — which `dsl.target.correct-clip`
				// already catches. Here the ask is one zoom inside one clip.
				return added === 1 ? pass() : fail(`${added} zoom(s) ajoutés pour une demande d'un seul`);
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
			id: "dsl.effect.honest",
			weight: 2,
			check: (c) => {
				const liars = c.wire.calls.filter((k) => k.mutating && !c.diffMatches(k));
				return liars.length === 0
					? pass()
					: fail(`resultJson ≠ document : ${liars.map((k) => `${k.name}#${k.id}`).join(", ")}`);
			},
		},
		{
			id: "dsl.timeline.untouched",
			weight: 2,
			check: (c) => {
				// Adding an effect must not disturb the cut. `replaceTimeline` and
				// `setClipRange` both re-lay the clips, and a model reaching for one
				// of them to "make room" would pass the targeting checks while
				// quietly rebuilding the user's edit.
				const sameClips =
					c.after.timeline.clips.length === c.before.timeline.clips.length &&
					c.after.timeline.clips.every(
						(clip, i) =>
							clip.id === c.before.timeline.clips[i].id &&
							clip.sourceStartSec === c.before.timeline.clips[i].sourceStartSec &&
							clip.sourceEndSec === c.before.timeline.clips[i].sourceEndSec,
					);
				const sameTrims =
					c.after.timeline.trimRanges.length === c.before.timeline.trimRanges.length;
				return sameClips && sameTrims
					? pass()
					: fail(
							`la timeline a bougé : ${c.before.timeline.clips.length} clips / ` +
								`${c.before.timeline.trimRanges.length} trims → ${c.after.timeline.clips.length} / ` +
								`${c.after.timeline.trimRanges.length}`,
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

	// OFFLINE ONLY — a correct turn: read, then one zoom in the middle of the
	// demo clip. This scenario's demo is the well-behaved one on purpose; it is
	// the control that proves a green result is reachable at all.
	demoScript: [
		{ kind: "tools", calls: [{ name: "getCurrentDocument", args: {} }] },
		{ kind: "tools", calls: [{ name: "addZoom", args: { startSec: 43, endSec: 48, depth: 3 } }] },
		{ kind: "text", text: "Added one zoom from 0:43 to 0:48, in the middle of the demo clip." },
	],
});
