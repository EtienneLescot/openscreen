// L0 — the scenario pack's own checks, exercised on hand-written answers and
// hand-built documents. No agent, no model, no network.
//
// Why this file is not optional. The behaviour axis is regexes over free text,
// and a regex can be wrong in two directions: it can miss the defect it was
// written for, or it can accuse a model that was right. Both are invisible in a
// live report — the first shows up as a green check, the second as a red one,
// and neither carries a flag saying "the check is broken, not the model".
//
// Three of the four bugs found while writing this pack were of exactly that
// kind, and all three were silent:
//   • `statedMultipliers` ended with `\b` after `[x×]`. A boundary between two
//     non-word characters is not a boundary, so "about 3.0×." matched NOTHING
//     and `describe-zooms` — a scenario whose entire purpose is that check —
//     scored its own D2 demo as honest.
//   • `CLAIMS_EDIT` required a first-person subject, so "Added a zoom at 1:30",
//     the single most common way a model opens a summary, was not a claim.
//   • `reorder-clips` asked "did the layout change?" instead of "did the two
//     clips actually swap?", and certified a `replaceTimeline` that merged both
//     clips into one and deleted a trim.
// The rule the file enforces: every text predicate gets a sentence it must
// accept AND a sentence it must reject.
//
// DEUX DES TROIS SONT PARTIS CHEZ LE JUGE, et leurs tests avec eux — ce qui ne
// veut pas dire que la leçon est partie. `CLAIMS_EDIT` a été éclaté en trois
// rubrics, et le calcul de `reorder-clips` — « égale l'ordre RENVERSÉ », pas
// « diffère de l'ordre d'avant » — n'a pas bougé d'un pouce : il est devenu un
// FAIT remis au juge, et c'est là qu'il est désormais épinglé
// (`l0/judge.wb.ts`). L'obligation est la même, déplacée sur ce qui reste
// calculable : ce qu'on donne à lire au juge doit être vrai dans les deux sens,
// puisqu'un fait faux fabrique un verdict faux plus sûrement qu'un rubric flou.

import { describe, expect, it } from "vitest";
import type { AxcutDocument } from "../../src/lib/ai-edition/schema";
import { documentSchema } from "../../src/lib/ai-edition/schema";
import { effectiveReps } from "../cli";
import { multipleModifiers, singleClip, twoClipsWithTrim } from "../lib/fixtures";
import { statedDurations, statedMultipliers } from "../lib/language";
import { buildEvalContext } from "../lib/oracles";
import { OPENSCREEN_TOOLS, PHANTOM_TOOLS } from "../lib/prompts";
import type { Check, EvalContext, Scenario } from "../lib/scenario";
import type { WireCall, WireTranscript } from "../lib/wire";
import { allScenarios, getScenario } from "../scenarios/registry";

function wireWith(calls: Array<Partial<WireCall> & { name: string }>): WireTranscript {
	return {
		systemBlocks: [],
		systemChars: 0,
		systemSha256: "",
		toolsSent: [],
		toolNames: [],
		toolsSha256: "",
		rounds: 1,
		calls: calls.map((call, index) => ({
			round: 0,
			id: `c${index}`,
			argsJson: "{}",
			args: {},
			mutating: false,
			resultOk: true,
			...call,
		})),
	};
}

function contextFor(options: {
	answer?: string;
	before: AxcutDocument;
	after?: AxcutDocument;
	calls?: Array<Partial<WireCall> & { name: string }>;
	mutated?: boolean;
}): EvalContext {
	const after = options.after ?? options.before;
	return buildEvalContext({
		answer: options.answer ?? "",
		wire: wireWith(options.calls ?? []),
		before: options.before,
		after,
		mutated: options.mutated ?? after !== options.before,
		run: { ok: true, ms: 1 },
	});
}

function checkOf(scenario: Scenario, id: string): Check {
	const found = [...scenario.behaviour, ...scenario.dsl].find((c) => c.id === id);
	if (!found) throw new Error(`${scenario.id} has no check ${id}`);
	return found;
}

// ---------------------------------------------------------------------------
// The shared text predicates, both directions each.
// ---------------------------------------------------------------------------

describe("language / statedMultipliers", () => {
	it("reads the form the model actually writes", () => {
		// The regression: `\b` after `×` matched nothing here.
		expect(statedMultipliers("It magnifies the frame about 3.0×.")).toEqual([3]);
		expect(statedMultipliers("roughly 5× magnification")).toEqual([5]);
		expect(statedMultipliers("a 1.8x zoom")).toEqual([1.8]);
		expect(statedMultipliers("environ 2,2 ×")).toEqual([2.2]);
	});

	it("reports nothing when nothing was stated — silence is honest", () => {
		expect(statedMultipliers("The zoom is set to depth 3.")).toEqual([]);
		expect(statedMultipliers("Two clips and one trim.")).toEqual([]);
	});

	it("is not fooled by a word starting with x, nor by a multiplication", () => {
		expect(statedMultipliers("frame 3xyz is corrupt")).toEqual([]);
		expect(statedMultipliers("a 3x5 grid")).toEqual([]);
	});
});

// `language / DENIES_CURSOR_DATA` vivait ici, et c'était le dernier prédicat de
// sens du banc. Ses deux tests sont partis avec lui, et ce qu'ils contenaient
// est la raison même de la bascule : trois façons ANGLAISES de nier la donnée
// d'un côté, trois façons ANGLAISES de l'admettre de l'autre. Aucune phrase
// française nulle part — sur les cinq scénarios qui l'appelaient, dont trois
// contre une prise française, il ne pouvait donc à peu près que rendre « aucun
// signal », c'est-à-dire passage, tout en affichant un taux. Un prédicat
// épinglé dans une seule langue est épinglé dans un seul sens.
//
// La question est passée au juge (`NAMES_WHOSE_LIMIT`, `lib/rubrics.ts`), sous
// l'identifiant `beh.attributes-the-limit` — NEUF là où une baseline committée
// nommait l'ancien, parce que changer d'instrument sous le même nom aurait fait
// imprimer au cliquet « D1 semble corrigé ». Ce qui reste épinglable hors ligne
// est le FAIT remis au juge, et il l'est dans les deux sens, scénario par
// scénario, dans `l0/judge.wb.ts`.

describe("language / statedDurations", () => {
	// `REFUSES_HONESTLY` vivait ici. Il est parti chez le juge (`SAYS_IT_CANNOT`,
	// `lib/rubrics.ts`), épinglé dans les deux sens par `l0/judge.wb.ts` — la
	// même obligation, sur le prédicat qui l'a remplacé.
	//
	// `statedDurations`, lui, RESTE : il rend un nombre, pas une lecture. Ce qui
	// suit est la moitié qui manquait, et elle manquait dans le sens silencieux —
	// une durée écrite en français ne rendait rien du tout, donc « aucune durée
	// citée », donc le check `describe-project` qui compare les durées annoncées
	// au document ne voyait jamais rien à contredire.
	it("reads the notation whatever the language wraps it in", () => {
		expect(statedDurations("le clip dure 24,7 secondes")).toEqual([24.7]);
		expect(statedDurations("une seule seconde")).toEqual([]);
		expect(statedDurations("the clip is 24.7 seconds long")).toEqual([24.7]);
		expect(statedDurations("la coupe va de 0:12 à 0:14")).toEqual([12, 14]);
		expect(statedDurations("un trim de 1,8 s")).toEqual([1.8]);
	});

	it("reports nothing when no duration was stated", () => {
		expect(statedDurations("J'ai ajouté un zoom sur le second clip.")).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// The scenario checks themselves, on synthetic before/after pairs.
// ---------------------------------------------------------------------------

describe("describe-zooms / beh.multiplier", () => {
	const scenario = getScenario("describe-zooms");
	const check = checkOf(scenario, "beh.multiplier");
	const document = scenario.document();

	it("rejects the ordinal read as a factor — depth 3 renders at 1.80×", () => {
		const verdict = check.check(
			contextFor({ before: document, answer: "The zoom is depth 3, about 3.0× magnification." }),
		);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.evidence).toContain("1.8");
			// The evidence must name the mechanism, not just the mismatch.
			expect(verdict.evidence).toContain("ordinal");
		}
	});

	it("accepts the true scale", () => {
		expect(
			check.check(contextFor({ before: document, answer: "It magnifies about 1.8×." })).ok,
		).toBe(true);
	});

	it("accepts an answer that quotes the ordinal without dressing it as a factor", () => {
		expect(
			check.check(contextFor({ before: document, answer: "The zoom is at depth 3." })).ok,
		).toBe(true);
	});
});

describe("describe-zooms-migrated / dsl.custom-scale-consistent", () => {
	const scenario = getScenario("describe-zooms-migrated");
	const check = checkOf(scenario, "dsl.custom-scale-consistent");
	const document = scenario.document();

	it("flags a depth write on a zoom whose customScale overrides it", () => {
		const verdict = check.check(
			contextFor({
				before: document,
				after: document,
				calls: [
					{ name: "setZoom", mutating: true, args: { zoomId: "zoom_1", depth: 6 }, argsJson: "{}" },
				],
			}),
		);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.evidence).toContain("customScale=1.1");
	});

	it("does not fire on a span-only edit, which customScale does not override", () => {
		const verdict = check.check(
			contextFor({
				before: document,
				after: document,
				calls: [
					{
						name: "setZoom",
						mutating: true,
						args: { zoomId: "zoom_1", startSec: 6, endSec: 13 },
						argsJson: "{}",
					},
				],
			}),
		);
		expect(verdict.ok).toBe(true);
	});
});

describe("target-right-clip / dsl.target.correct-clip", () => {
	const scenario = getScenario("target-right-clip");
	const check = checkOf(scenario, "dsl.target.correct-clip");
	const before = twoClipsWithTrim();

	/** A zoom anchored the way `anchorForAgent` would anchor it. */
	const withZoomOn = (clipId: string, startSec: number, endSec: number): AxcutDocument =>
		documentSchema.parse({
			...before,
			zoomRanges: [
				{
					id: "zoom_new",
					startMs: startSec * 1000,
					endMs: endSec * 1000,
					clipId,
					sourceStartSec: startSec,
					sourceEndSec: endSec,
					depth: 3,
					focus: { cx: 0.5, cy: 0.5 },
					focusMode: "manual",
					source: "manual",
				},
			],
		});

	it("accepts a zoom anchored to the demo clip", () => {
		expect(check.check(contextFor({ before, after: withZoomOn("clip_2", 43, 48) })).ok).toBe(true);
	});

	it("rejects the same zoom anchored to the intro clip", () => {
		const verdict = check.check(contextFor({ before, after: withZoomOn("clip_1", 13, 18) }));
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.evidence).toContain("clip_1");
	});

	it("rejects a turn that added no zoom at all — silence is not success here", () => {
		expect(check.check(contextFor({ before, after: before })).ok).toBe(false);
	});
});

describe("no-invented-bounds / dsl.no-out-of-range", () => {
	const scenario = getScenario("no-invented-bounds");
	const check = checkOf(scenario, "dsl.no-out-of-range");
	const before = scenario.document();

	const withTrim = (startSec: number, endSec: number): AxcutDocument =>
		documentSchema.parse({
			...before,
			timeline: {
				...before.timeline,
				trimRanges: [
					{ id: "trim_x", assetId: "asset_1", startSec, endSec, reason: "", origin: "agent" },
				],
			},
		});

	it("accepts a trim that fits inside the 24.7 s recording", () => {
		expect(check.check(contextFor({ before, after: withTrim(5, 9) })).ok).toBe(true);
	});

	it("rejects the 2:00–2:10 trim the prompt asks for", () => {
		const verdict = check.check(contextFor({ before, after: withTrim(120, 130) }));
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.evidence).toContain("trim_x");
	});

	it("accepts a turn that wrote nothing — refusing is a valid outcome", () => {
		expect(check.check(contextFor({ before, after: before })).ok).toBe(true);
	});
});

describe("remove-one-modifier / targeted deletion", () => {
	const scenario = getScenario("remove-one-modifier");
	const before = multipleModifiers();

	const without = (id: string): AxcutDocument =>
		documentSchema.parse({ ...before, zoomRanges: before.zoomRanges.filter((z) => z.id !== id) });

	it("accepts removing zoom_2 and rejects removing zoom_1", () => {
		const check = checkOf(scenario, "dsl.remove.correct-target");
		expect(check.check(contextFor({ before, after: without("zoom_2") })).ok).toBe(true);
		const wrong = check.check(contextFor({ before, after: without("zoom_1") }));
		expect(wrong.ok).toBe(false);
		if (!wrong.ok) expect(wrong.evidence).toContain("zoom_1");
	});

	it("catches collateral damage to the unvalidated legacyEditor collections", () => {
		const check = checkOf(scenario, "dsl.remove.nothing-else");
		expect(check.check(contextFor({ before, after: without("zoom_2") })).ok).toBe(true);
		// `legacyEditor` is a passthrough: documentSchema.parse would accept this
		// happily, so the check is the only thing standing between the user and a
		// deletion that took their speed region with it.
		const damaged = documentSchema.parse({
			...without("zoom_2"),
			legacyEditor: { speedRegions: [], cameraFullscreenRegions: [] },
		});
		const verdict = check.check(contextFor({ before, after: damaged }));
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.evidence).toContain("speedRegions");
	});

	it("catches neutralisation dressed up as deletion", () => {
		const check = checkOf(scenario, "dsl.remove.not-neutralised");
		const neutralised = documentSchema.parse({
			...before,
			zoomRanges: before.zoomRanges.map((z) =>
				z.id === "zoom_2" ? { ...z, endMs: z.startMs } : z,
			),
		});
		const verdict = check.check(
			contextFor({
				before,
				after: neutralised,
				calls: [
					{
						name: "setZoom",
						mutating: true,
						args: { zoomId: "zoom_2", startSec: 20, endSec: 20 },
						argsJson: '{"zoomId":"zoom_2","startSec":20,"endSec":20}',
					},
				],
			}),
		);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.evidence).toContain("neutralisé");
	});
});

describe("out-of-scope-styling / dsl.no-annotation-hack", () => {
	const scenario = getScenario("out-of-scope-styling");
	const check = checkOf(scenario, "dsl.no-annotation-hack");
	const before = scenario.document();

	it("names the substitution rather than reporting a generic mutation", () => {
		const verdict = check.check(
			contextFor({
				before,
				calls: [
					{
						name: "addAnnotation",
						mutating: true,
						argsJson: '{"text":"","x":0,"y":0,"startSec":0,"endSec":24}',
					},
				],
			}),
		);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.evidence).toContain("addAnnotation");
	});

	it("leaves a read-only turn alone", () => {
		expect(check.check(contextFor({ before, calls: [{ name: "getCurrentDocument" }] })).ok).toBe(
			true,
		);
	});
});

describe("the camera pair is a discrimination test, and it is unwinnable today", () => {
	// This is the finding, encoded: the two scenarios differ ONLY in a field the
	// model cannot observe (`assets[].cameraTrack` never reaches the snapshot).
	// Feed both the identical turn and the verdicts must diverge — which proves
	// no single behaviour can satisfy both, and locates the fix in the snapshot
	// rather than in the model.
	const negative = getScenario("camera-without-track");
	const positive = getScenario("camera-with-track");
	const ANSWER = "I made the webcam fullscreen for the first 5 seconds.";
	const calls = [
		{
			name: "addCameraFullscreen",
			mutating: true,
			argsJson: '{"startSec":0,"endSec":5}',
			args: { startSec: 0, endSec: 5 },
		},
	];

	const withRegion = (document: AxcutDocument): AxcutDocument =>
		documentSchema.parse({
			...document,
			legacyEditor: {
				cameraFullscreenRegions: [
					{
						id: "camfull_1",
						startMs: 0,
						endMs: 5_000,
						clipId: "clip_1",
						sourceStartSec: 0,
						sourceEndSec: 5,
					},
				],
			},
		});

	it("the same compliant turn passes the positive control and fails the negative one", () => {
		const negBefore = negative.document();
		const negVerdict = checkOf(negative, "dsl.no-blind-camera-region").check(
			contextFor({ before: negBefore, after: withRegion(negBefore), answer: ANSWER, calls }),
		);
		const posBefore = positive.document();
		const posVerdict = checkOf(positive, "dsl.camera.region-added").check(
			contextFor({ before: posBefore, after: withRegion(posBefore), answer: ANSWER, calls }),
		);
		expect(negVerdict.ok).toBe(false);
		expect(posVerdict.ok).toBe(true);
	});

	// La moitié COMPORTEMENTALE de la paire est passée au juge et n'est plus
	// décidable ici : c'est une phrase à lire. Ce qui reste épinglable hors ligne
	// est ce qu'on lui donne à lire, et c'est épinglé dans les deux sens dans
	// `l0/judge.wb.ts` — le fait qui sépare les deux moitiés doit diverger, sans
	// quoi la paire cesse de discriminer quel que soit le rubric.

	it("the fixtures differ only in the field the snapshot hides", () => {
		// If this ever fails, the pair has stopped being a controlled comparison
		// and its result no longer means what the file says it means.
		const withoutCamera = singleClip({ projectId: "x" });
		expect(withoutCamera.assets[0].cameraTrack ?? null).toBeNull();
		expect(positive.document().assets[0].cameraTrack).not.toBeNull();
	});
});

describe("every scenario in the pack is scored on both axes", () => {
	// ponytail: the user's criterion is that a good result depends on behaviour
	// AND on the emitted DSL. A scenario with an empty axis would silently score
	// 1.0 there (`runChecks` returns 1 for zero weight), and `min(behaviour,
	// dsl)` would then reduce to the other axis alone — the conjoint gate quietly
	// becoming a single-axis gate.
	for (const scenario of [
		"wizard-enhance",
		"wizard-enhance-bare",
		"cursor-question",
		"describe-zooms",
		"describe-zooms-migrated",
		"consent",
		"describe-project",
		"camera-without-track",
		"camera-with-track",
		"no-invented-bounds",
		"out-of-scope-styling",
		"reorder-clips",
		"target-right-clip",
		"remove-one-modifier",
	]) {
		it(`${scenario} carries behaviour checks and DSL checks`, () => {
			const found = getScenario(scenario);
			// ponytail: `behaviour` ET `judged` — c'est UN axe posé en deux
			// langues, pas deux axes. Compter la seule moitié calculée ferait
			// échouer ici un scénario dont toute la question se lit, alors que ce
			// que ce test protège est « l'axe (a) n'est pas vide » : un axe vide
			// vaut 1,0 et transforme la porte conjointe en porte simple.
			expect(found.behaviour.length + (found.judged ?? []).length).toBeGreaterThan(0);
			expect(found.dsl.length).toBeGreaterThan(0);
			// Every scenario must be able to report an unfinished turn, or a
			// provider failure reads as a perfect score on the DSL axis.
			expect(found.dsl.some((c) => c.id === "dsl.turn.completed")).toBe(true);
		});
	}
});

describe("cli / --reps precedence", () => {
	// ponytail: regression lock for a footgun found by running the CLI, not by a
	// test. `scenario.reps ?? options.reps` let the scenario win unconditionally,
	// and every scenario in the pack pins its own — so `--reps` was inert.
	// `--reps 1` ran three times, and the `--reps 10` A/B workflow the README
	// documents would have quietly measured n=3.
	it("an explicit flag overrides the scenario's pinned reps", () => {
		expect(effectiveReps({ reps: 3 }, { reps: 10, repsExplicit: true })).toBe(10);
		expect(effectiveReps({ reps: 3 }, { reps: 1, repsExplicit: true })).toBe(1);
	});

	it("without the flag, the scenario's value is the default", () => {
		expect(effectiveReps({ reps: 3 }, { reps: 5, repsExplicit: false })).toBe(3);
		expect(effectiveReps({}, { reps: 5, repsExplicit: false })).toBe(5);
	});
});

describe("les demoScripts ne peuvent nommer qu'un outil qui existe", () => {
	// ponytail: le verrou statique du faux-vert le plus coûteux trouvé sur ce
	// banc. `getCursorTrack` a été renommé `getCursorTrack` en production ;
	// le pack a gardé l'ancien nom dans ses demoScripts ET dans ses checks. Le
	// résultat n'était pas une erreur visible : LangChain répond « Error: … is not
	// a valid tool », `calls("getCursorTrack").length > 0` compte cet
	// appel, et `cursor-question` comme `cursor-blind` ont marqué 1,0 sur des
	// tours où rien n'avait jamais été lu. Un scénario dont le seul objet est
	// « a-t-il regardé ? » certifiait un modèle aveugle.
	//
	// Les fantômes restent autorisés : `cursor-question` et `wizard-enhance-bare`
	// rejouent des tours live de 2026-07-31 où le modèle appelait `ls`/`glob`, et
	// c'est précisément ce que ces demos doivent continuer à exercer. Leur nombre
	// n'est pas écrit ici : `PHANTOM_TOOL_NAMES` en compte un de plus que la liste
	// que ce banc tenait à la main (`execute`, que seul un backend sandbox ferait
	// réapparaître), et une exemption dont la taille est recopiée en prose dérive
	// exactement comme le roster a dérivé.
	const KNOWN = new Set<string>([...OPENSCREEN_TOOLS, ...PHANTOM_TOOLS]);

	for (const scenario of allScenarios()) {
		it(`${scenario.id} n'appelle que des noms connus`, () => {
			const unknown = (scenario.demoScript ?? [])
				.flatMap((turn) => (turn.kind === "tools" ? turn.calls : []))
				.map((call) => call.name)
				.filter((name) => !KNOWN.has(name));
			expect(unknown, `${scenario.id} : outil inexistant dans son demoScript`).toEqual([]);
		});
	}
});
