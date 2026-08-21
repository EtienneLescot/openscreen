// ponytail: four scenarios on the ONE piece of material the workbench did not
// write — a 66 s screencast, a French Whisper transcript with 129 words, and
// 1521 pointer samples from the capture that produced it.
//
// Everything else in the pack runs on documents `lib/fixtures.ts` generates.
// That is right for conformity: the silences are round, so an off-by-one is an
// exact number being wrong. It is useless for QUALITY, because the generator
// and the oracle were written by the same hand on the same afternoon. A model
// that learns "silences are at 10.0 and 31.0" scores perfectly here and cuts a
// word on the first real recording it meets.
//
// ─── THE GROUND TRUTH IS NOT IN THIS FILE'S OUTPUT PATH ────────────────────
//
// `ZONES` below is what the user was actually DOING, annotated by hand after
// the fact. It appears in `behaviour`/`dsl` checks and NOWHERE else: not in
// `prompt`, not in `document()`, not in a `demoScript`, not in a tool payload.
// `l0/real-screencast-truth.wb.ts` asserts that mechanically, and
// `l1/real-screencast.wb.ts` asserts it again against the bytes that actually
// left for the model. If any of it reached the model the measurement would be
// worth nothing — we would be scoring a dictation.
//
// ─── WHY THIS MATERIAL DISCRIMINATES ───────────────────────────────────────
//
// Zone C (the image) is the one that separates a model that USES the pointer
// track from one that paraphrases the transcript:
//
//   • the transcript says nothing there. The speaker talks continuously across
//     the whole zone — the nearest silence ends 1.5 s before it starts and the
//     next begins 1 s after it ends, so a silence-driven heuristic sees a
//     single uninterrupted block from 23.41 to 30.99.
//   • the pointer is not still there either. It sweeps: cx 0.32 → 0.63 at a
//     constant cy ≈ 0.50 between 24.1 and 29.2 s. A stillness detector — the
//     one the magic wand uses — is blind to it BY CONSTRUCTION, and the
//     measurement in `cursor-track.ts` says so: 8 false positives out of 16
//     dwells, and this zone fragmented into two one-second blips.
//
// So a zoom on zone C can only come from reading the trajectory. That is what
// `real-zoom-grounding` is for, and it is why its checks are about METHOD (did
// you look?) as much as about placement.
//
// One honest caveat, because it bounds what a green here proves: the
// transcript is not silent about the SUBJECT. The word "l'image." ends at
// 21.94, right before the pause that opens the zone. A model could infer
// "something visual is coming" from the words alone and land a zoom near 23
// without ever reading a sample. `dsl.zone.slow-sweep` therefore does not
// prove telemetry was used; `dsl.consults.telemetry` does, and the two are
// scored separately for exactly that reason.
//
// ─── UN CHECK MIGRÉ QUI N'A JAMAIS ÉTÉ JUGÉ SUR SA PROPRE MATIÈRE ──────────
//
// `beh.no-false-negative` était ici la dernière regex de sens du banc, et sur
// CETTE prise elle était au pire endroit possible : le transcript est français,
// la réponse le sera souvent, et le motif est anglais. Il ne pouvait donc à peu
// près que rendre « aucun signal », c'est-à-dire passage — un taux affiché sur
// une propriété que personne ne mesurait. Les trois checks concernés passent au
// juge, `NAMES_WHOSE_LIMIT`, sous l'identifiant que porte déjà la paire qui
// isole la question : la propriété est la même, donc le nom doit l'être, sans
// quoi on obtient deux taux qu'on ne peut plus mettre côte à côte.
//
// LA RÉSERVE, et elle ne doit pas être effacée par un run vert ailleurs : ces
// trois checks n'ont JAMAIS été jugés sur cette prise. Elle est gitignorée et
// absente de la machine où la bascule a été faite, donc le rubric y est câblé
// sur la foi de sa validation ailleurs — `cursor-question`, synthétique, avec un
// lecteur câblé exactement comme ici. C'est le même état de fait (sidecar
// présent et LISIBLE, donc nier la donnée est une affirmation fausse sur le
// projet et non l'aveu d'une limite), mais ce n'est pas la même matière. Qui
// possède la prise doit lancer ces trois-là et REGARDER les verdicts avant d'en
// tirer un chiffre. Ce qu'il ne faut PAS faire : y substituer un autre
// enregistrement pour fabriquer un résultat live — la vérité terrain de ce
// fichier a été annotée à la main sur CETTE prise, et une autre rendrait un
// nombre qui ressemble à une vérification sans en être une.

import { AI_ENHANCE_PROMPT } from "../lib/prompts";
import {
	formatBreaches,
	formatDamagedWords,
	formatPauses,
	formatZones,
	type TruthZone,
} from "../lib/quality";
import { realScreencastCursorReader, realScreencastDocument } from "../lib/real-fixture";
import { NAMES_WHOSE_LIMIT, pointerReadFacts } from "../lib/rubrics";
import { defineScenario, type EvalContext, fail, pass } from "../lib/scenario";
import { callsWithData } from "../lib/wire";

// ─── ground truth — ASSERTIONS ONLY ─────────────────────────────────────────

/**
 * A click is an instant, and a zoom is not. Half a second on each side is the
 * narrowest window a `MIN_ZOOM_SEC` zoom (0.45 s) can sit inside, so 1 s is the
 * smallest honest window: any wider and the oracle would start crediting a
 * zoom that merely happens to be nearby.
 */
const CLICK_HALF_WIDTH_SEC = 1;

const click = (atSec: number, label: string): TruthZone => ({
	startSec: atSec - CLICK_HALF_WIDTH_SEC,
	endSec: atSec + CLICK_HALF_WIDTH_SEC,
	label,
});

/**
 * What the user was doing, in source seconds. Annotated by hand from the
 * recording. NEVER reaches the model — see the module header.
 *
 * The labels are deliberately phrased so that no whole label can occur in the
 * French narration: the leak test matches whole strings, and single words like
 * "image" or "lien" DO occur in the transcript. That is not a leak — the
 * speaker saying "pour voir l'image" is signal the model is entitled to; our
 * annotation of what that meant is not.
 */
const ZONES: TruthZone[] = [
	{ startSec: 8, endSec: 13, label: "saisie clavier — première barre de recherche" },
	click(16, "clic de navigation sur un lien"),
	{ startSec: 23, endSec: 30, label: "balayage lent devant une illustration" },
	click(37, "clic de navigation vers la page des versions"),
	{ startSec: 43, endSec: 46, label: "saisie clavier — seconde barre de recherche" },
	{ startSec: 53, endSec: 66, label: "lecture d'un média embarqué" },
];

/** The zone a transcript-only reading cannot find. Indexed, not re-typed. */
const SLOW_SWEEP = ZONES[2];

/**
 * Tolerance on destroyed speech: one frame at 50 fps. Not a margin for error —
 * a margin for the float arithmetic of `30.99 - 21.94 + 21.94`. Any real cut
 * into a word is an order of magnitude above it.
 */
const FRAME_SEC = 0.02;

// ─── shared check builders ──────────────────────────────────────────────────
//
// The same property is asked of three prompts; writing it three times is three
// chances to fix two of them. Each builder takes the weight so a scenario can
// say how much the property matters to ITS request.

const speechIntact = (weight: number) => ({
	id: "dsl.speech.intact",
	weight,
	check: (c: EvalContext) => {
		const damage = c.speechDamageDetail();
		if (damage.destroyedSec <= FRAME_SEC) return pass();
		return fail(
			`${damage.destroyedSec.toFixed(2)} s de parole détruits ` +
				`(${damage.wholeWords} mot(s) supprimé(s), ${damage.clippedWords} rogné(s)) : ` +
				formatDamagedWords(damage.words),
		);
	},
});

const cutsLandInSilence = (weight: number) => ({
	id: "dsl.cut.precision",
	weight,
	check: (c: EvalContext) => {
		// ponytail: the EDGES are not enough, and the hole they leave is the
		// widest one there is. `addTrim(16.02, 23.41)` puts both edges exactly on
		// a pause boundary — verdict `exact` on each, nothing to report — and
		// removes the 3.4 s of speech that lay between the two silences. Measured:
		// this check stayed green on that cut, and on a single 16.02–63.56 trim
		// that destroyed 39 s of speech. `speechEatenSec` is the speech INSIDE the
		// trim, which is the property the check's name claims.
		const bad = c
			.cutPrecision()
			.filter(
				(cut) =>
					cut.speechEatenSec > FRAME_SEC ||
					cut.edges.some((edge) => edge.verdict === "encroachment"),
			);
		if (bad.length === 0) return pass();
		return fail(
			bad
				.map(
					(cut) =>
						`${cut.startSec.toFixed(2)}–${cut.endSec.toFixed(2)} mord ` +
						`${Math.max(cut.worstBiteSec, cut.speechEatenSec).toFixed(2)} s de parole` +
						(cut.pause ? "" : " et ne vise aucun silence"),
				)
				.join(" ; "),
		);
	},
});

const noOrphans = (weight: number) => ({
	id: "dsl.cut.no-orphans",
	weight,
	check: (c: EvalContext) => {
		const orphans = c.orphanFragments();
		return orphans.length === 0
			? pass()
			: fail(
					`${orphans.length} fragment(s) isolé(s) sous 0,5 s : ${orphans
						.map((f) => `${f.startSec.toFixed(2)}–${f.endSec.toFixed(2)}`)
						.join(", ")}`,
				);
	},
});

/**
 * Recall on the INTERIOR silences only.
 *
 * The head of this recording is 2.33 s of dead air, 23 % of the 10.2 s of
 * silence in the take, and cutting it takes no judgement at all. Folded into a
 * single number it would let a model that trimmed the head and nothing else
 * report a quarter of the job done.
 */
const cutsTheSilences = (weight: number, minCovered: number) => ({
	id: "dsl.cut.coverage",
	weight,
	check: (c: EvalContext) => {
		const coverage = c.silenceCoverage();
		const covered = coverage.interior.pauses.filter((entry) => entry.covered);
		if (covered.length >= minCovered) return pass();
		return fail(
			`${covered.length}/${coverage.interior.pauses.length} silences intérieurs coupés ` +
				`(${coverage.interior.removedSec.toFixed(2)} s sur ${coverage.interior.totalSec.toFixed(2)}) ; ` +
				`manqués : ${formatPauses(coverage.interior.missed)}`,
		);
	},
});

// ─── 1. the wizard, verbatim, on real material ──────────────────────────────

const realWizardEnhance = defineScenario({
	id: "real-wizard-enhance",
	title: "Auto-enhance sur la vraie prise — jugé comme un montage",
	tags: ["real", "wizard", "editorial"],
	prompt: AI_ENHANCE_PROMPT,
	document: () => realScreencastDocument(),
	cursorReader: () => realScreencastCursorReader(),
	// ponytail: gate 0. A gate is a claim about what the model can do, and no
	// live run has ever touched this fixture. Raise it once a baseline exists.
	gate: 0,
	reps: 3,

	behaviour: [
		{
			id: "beh.grounding",
			weight: 2,
			check: (c) => {
				const read = c.firstIndexOf("getCurrentDocument");
				if (read === -1) return fail("n'a jamais appelé getCurrentDocument");
				return read < c.firstMutatingIndex()
					? pass()
					: fail("a édité avant tout appel à getCurrentDocument");
			},
		},
		{
			id: "beh.counts",
			weight: 2,
			check: (c) => {
				const said = Number(c.answer.match(/(\d+)\s+zoom/i)?.[1] ?? Number.NaN);
				if (Number.isNaN(said)) return pass();
				return said === c.after.zoomRanges.length
					? pass()
					: fail(`annonce ${said} zooms, le document en porte ${c.after.zoomRanges.length}`);
			},
		},
		{
			id: "beh.damage-not-hidden",
			weight: 3,
			check: (c) => {
				// Détruire de la parole est un échec DSL ; annoncer un montage propre
				// en l'ayant fait en est un comportemental.
				const damage = c.speechDamageDetail();
				if (damage.destroyedSec <= FRAME_SEC) return pass();
				return /\b(?:cut into|clipped|lost|trimmed too|word|speech)\b/i.test(c.answer)
					? pass()
					: fail(
							`${damage.destroyedSec.toFixed(2)} s de parole détruits sans le dire : ` +
								formatDamagedWords(damage.words),
						);
			},
		},
	],

	// ponytail: la moitié de l'axe (a) qui demande de LIRE. Même rubric et mêmes
	// faits que partout où la question de la limite est posée — le lecteur est
	// câblé ici, donc les faits diront `available: true` et nier la donnée est
	// une affirmation fausse sur le projet, pas l'aveu d'une limite. Voir la
	// réserve en tête de fichier : ce verdict n'a jamais été rendu sur cette
	// matière.
	judged: [
		{
			id: "beh.attributes-the-limit",
			weight: 3,
			rubric: NAMES_WHOSE_LIMIT,
			facts: pointerReadFacts,
		},
	],

	dsl: [
		speechIntact(4),
		cutsLandInSilence(3),
		cutsTheSilences(3, 4),
		noOrphans(2),
		{
			id: "dsl.zoom.placement",
			weight: 3,
			check: (c) => {
				// Précision ET rappel, jamais une moyenne : un zoom unique sur toute
				// la prise a un rappel de 1, et six flashs bien centrés une précision
				// de 1. Les deux échecs ont des correctifs opposés.
				const placement = c.zoomPlacement(ZONES);
				if (placement.hits.length === 0) return fail("aucun zoom émis");
				const problems: string[] = [];
				if (placement.precision < 0.5) {
					problems.push(
						`précision ${placement.precision.toFixed(2)} ` +
							`(${placement.onZoneSec.toFixed(1)} s sur ${placement.zoomSec.toFixed(1)} s de zoom)`,
					);
				}
				if (placement.recall < 0.34) {
					problems.push(
						`rappel ${placement.recall.toFixed(2)} ; zones manquées : ` +
							formatZones(placement.missedZones),
					);
				}
				return problems.length === 0 ? pass() : fail(problems.join(" — "));
			},
		},
		{
			id: "dsl.zoom.hygiene",
			weight: 2,
			check: (c) => {
				const issues = c.zoomIssues();
				return issues.length === 0
					? pass()
					: fail(issues.map((issue) => `${issue.kind} : ${issue.detail}`).join(" ; "));
			},
		},
		{
			id: "dsl.bounds.in-range",
			weight: 2,
			check: (c) => {
				const limit = c.assetDuration() + 0.001;
				const over = [
					...c.after.zoomRanges.map((z) => ({ id: z.id, end: z.endMs / 1000 })),
					...c.after.timeline.trimRanges.map((t) => ({ id: t.id, end: t.endSec })),
				].filter((entry) => entry.end > limit);
				return over.length === 0
					? pass()
					: fail(`bornes au-delà de ${limit.toFixed(2)} s : ${JSON.stringify(over)}`);
			},
		},
		{
			id: "dsl.scope",
			weight: 2,
			check: (c) => {
				// Le wizard licencie zooms ET coupes, et rien d'autre.
				const breaches = c.scopeBreaches({
					families: ["zoom", "trim"],
					tools: ["addZoom", "setZoom", "addTrim", "setTrim", "removeTrim", "removeModifier"],
				});
				return breaches.length === 0 ? pass() : fail(formatBreaches(breaches));
			},
		},
		{
			id: "dsl.turn.completed",
			weight: 2,
			check: (c) =>
				c.run.ok ? pass() : fail(`${c.classifyFailure()} : ${(c.run.error ?? "").slice(0, 200)}`),
		},
	],

	// OFFLINE ONLY — un tour propre, pour prouver qu'une ligne verte est
	// atteignable sur cette matière. Zooms d'abord, coupes ensuite : `addZoom`
	// prend des secondes VIRTUELLES, qui n'égalent les secondes source qu'avant
	// la première coupe. Un modèle qui coupe puis zoome doit décaler ses bornes,
	// et c'est un piège que ce script ne prétend pas mesurer.
	demoScript: [
		{ kind: "tools", calls: [{ name: "getCurrentDocument", args: {} }] },
		{ kind: "tools", calls: [{ name: "getTranscript", args: {} }] },
		{ kind: "tools", calls: [{ name: "getCursorTrack", args: {} }] },
		{
			kind: "tools",
			calls: [
				{
					name: "addZoom",
					args: { startSec: 8, endSec: 13, depth: 3, focus: { cx: 0.29, cy: 0.09 } },
				},
				{
					name: "addZoom",
					args: { startSec: 23.6, endSec: 29.6, depth: 3, focus: { cx: 0.47, cy: 0.5 } },
				},
				{
					name: "addZoom",
					args: { startSec: 43, endSec: 46, depth: 3, focus: { cx: 0.35, cy: 0.12 } },
				},
			],
		},
		{
			kind: "tools",
			calls: [
				{ name: "addTrim", args: { startSec: 0, endSec: 2.33, reason: "silence" } },
				{ name: "addTrim", args: { startSec: 16.02, endSec: 18.5, reason: "silence" } },
				{ name: "addTrim", args: { startSec: 21.94, endSec: 23.41, reason: "silence" } },
				{ name: "addTrim", args: { startSec: 36.86, endSec: 38.18, reason: "silence" } },
				{ name: "addTrim", args: { startSec: 40.85, endSec: 41.97, reason: "silence" } },
			],
		},
		{
			kind: "text",
			text:
				"I added 3 zooms and cut 5 dead stretches (8.7 s in total), including the 2.3 s " +
				"before you start speaking. The pointer track shows a slow traverse in the " +
				"middle of the recording, so that zoom follows it rather than sitting still.",
		},
	],
});

export default realWizardEnhance;

// ─── 2. the cuts, alone ─────────────────────────────────────────────────────

/**
 * "Cut the silences" and nothing else, so a failure has one reading.
 *
 * `real-wizard-enhance` also cuts, but it cuts while placing zooms; when its
 * cut checks go red you cannot tell a model that cut badly from a model that
 * ran out of attention halfway through a five-part instruction.
 */
export const realCutSilences = defineScenario({
	id: "real-cut-silences",
	title: "Couper les silences d'une vraie prise, et rien d'autre",
	tags: ["real", "editorial", "trims"],
	prompt:
		"Cut the silences out of this recording so it plays tighter. " +
		"Leave everything else exactly as it is.",
	document: () => realScreencastDocument(),
	cursorReader: () => realScreencastCursorReader(),
	gate: 0,
	reps: 3,

	behaviour: [
		{
			id: "beh.grounding",
			weight: 2,
			check: (c) => {
				// Le transcript est le SEUL endroit où sont les silences ; couper
				// avant de l'avoir lu, c'est que les bornes viennent d'ailleurs.
				const read = c.firstIndexOf("getTranscript");
				if (read === -1) return fail("n'a jamais lu le transcript");
				return read < c.firstMutatingIndex() ? pass() : fail("a coupé avant de lire le transcript");
			},
		},
		{
			id: "beh.no-false-claim",
			weight: 3,
			check: (c) => {
				const said = Number(
					c.answer.match(/(\d+)\s+(?:cuts?|silences?|pauses?)/i)?.[1] ?? Number.NaN,
				);
				if (Number.isNaN(said)) return pass();
				const added = c.after.timeline.trimRanges.length - c.before.timeline.trimRanges.length;
				return said === added
					? pass()
					: fail(`annonce ${said} coupes, le document en porte ${added}`);
			},
		},
		{
			id: "beh.damage-not-hidden",
			weight: 3,
			check: (c) => {
				const damage = c.speechDamageDetail();
				if (damage.destroyedSec <= FRAME_SEC) return pass();
				return /\b(?:cut into|clipped|lost|trimmed too|word|speech)\b/i.test(c.answer)
					? pass()
					: fail(
							`${damage.destroyedSec.toFixed(2)} s de parole détruits sans le dire : ` +
								formatDamagedWords(damage.words),
						);
			},
		},
	],

	dsl: [
		speechIntact(4),
		cutsLandInSilence(4),
		// Cinq des six : le silence de 0,82 s à 30,99 est à la limite du seuil, et
		// le laisser est une décision défendable. En exiger six ferait de ce check
		// une question de goût.
		cutsTheSilences(3, 5),
		noOrphans(3),
		{
			id: "dsl.cut.not-flush",
			weight: 1,
			check: (c) => {
				// INFORMATIF, poids 1. Des bords tous « exact » ne sont pas une faute
				// — c'est la signature d'un modèle qui recopie les bornes qu'on lui a
				// données plutôt qu'il ne monte. Sur cette matière les bornes SONT
				// dans le transcript, donc les recopier est légitime ; ce check
				// existe pour que le rapport le dise, pas pour punir.
				const cuts = c.cutPrecision();
				if (cuts.length === 0) return pass();
				const flush = cuts.filter((cut) =>
					cut.edges.every((edge) => edge.verdict === "exact"),
				).length;
				return flush < cuts.length
					? pass()
					: fail(`${flush}/${cuts.length} coupes au centième près sur les bornes du transcript`);
			},
		},
		{
			id: "dsl.scope",
			weight: 3,
			check: (c) => {
				// « Leave everything else exactly as it is », comme propriété du
				// document ET de la liste d'appels.
				const breaches = c.scopeBreaches({
					families: ["trim"],
					tools: ["addTrim", "setTrim", "removeTrim"],
				});
				return breaches.length === 0 ? pass() : fail(formatBreaches(breaches));
			},
		},
		{
			id: "dsl.turn.completed",
			weight: 2,
			check: (c) =>
				c.run.ok ? pass() : fail(`${c.classifyFailure()} : ${(c.run.error ?? "").slice(0, 200)}`),
		},
	],

	demoScript: [
		{ kind: "tools", calls: [{ name: "getTranscript", args: {} }] },
		{
			kind: "tools",
			calls: [
				{ name: "addTrim", args: { startSec: 0, endSec: 2.2, reason: "silence" } },
				{ name: "addTrim", args: { startSec: 16.1, endSec: 18.44, reason: "silence" } },
				{ name: "addTrim", args: { startSec: 22.0, endSec: 23.35, reason: "silence" } },
				{ name: "addTrim", args: { startSec: 36.95, endSec: 38.1, reason: "silence" } },
				{ name: "addTrim", args: { startSec: 40.95, endSec: 41.9, reason: "silence" } },
				{ name: "addTrim", args: { startSec: 62.95, endSec: 63.5, reason: "silence" } },
			],
		},
		{
			kind: "text",
			text:
				"I made 6 cuts, 9.0 s in total. Each one sits inside the pause it targets with a " +
				"few hundredths of a second left on either side, so no word is clipped. I left " +
				"the 0.8 s breath at 0:31 alone — it reads as punctuation rather than dead air.",
		},
	],
});

// ─── 3. the zooms, alone ────────────────────────────────────────────────────

const ZOOM_PROMPT =
	"Add zoom-ins to this recording on the moments that actually matter to a viewer. " +
	"Do not change the timing of anything.";

/** Zoom placement, isolated from every cut so the numbers mean one thing. */
export const realZooms = defineScenario({
	id: "real-zooms",
	title: "Placer des zooms sur la vraie prise — précision et rappel",
	tags: ["real", "editorial", "zooms"],
	prompt: ZOOM_PROMPT,
	document: () => realScreencastDocument(),
	cursorReader: () => realScreencastCursorReader(),
	gate: 0,
	reps: 3,

	behaviour: [
		{
			id: "beh.counts",
			weight: 2,
			check: (c) => {
				const said = Number(c.answer.match(/(\d+)\s+zoom/i)?.[1] ?? Number.NaN);
				if (Number.isNaN(said)) return pass();
				return said === c.after.zoomRanges.length
					? pass()
					: fail(`annonce ${said} zooms, le document en porte ${c.after.zoomRanges.length}`);
			},
		},
	],

	// ponytail: la moitié de l'axe (a) qui demande de LIRE. Même rubric et mêmes
	// faits que partout où la question de la limite est posée — le lecteur est
	// câblé ici, donc les faits diront `available: true` et nier la donnée est
	// une affirmation fausse sur le projet, pas l'aveu d'une limite. Voir la
	// réserve en tête de fichier : ce verdict n'a jamais été rendu sur cette
	// matière.
	judged: [
		{
			id: "beh.attributes-the-limit",
			weight: 3,
			rubric: NAMES_WHOSE_LIMIT,
			facts: pointerReadFacts,
		},
	],

	dsl: [
		{
			id: "dsl.zoom.precision",
			weight: 4,
			check: (c) => {
				const placement = c.zoomPlacement(ZONES);
				if (placement.hits.length === 0) return fail("aucun zoom émis");
				if (placement.precision >= 0.5) return pass();
				return fail(
					`précision ${placement.precision.toFixed(2)} : ${placement.onZoneSec.toFixed(1)} s ` +
						`de zoom sur une zone, ${placement.zoomSec.toFixed(1)} s de zoom en tout` +
						(placement.strayZoomIds.length > 0
							? ` ; ${placement.strayZoomIds.length} zoom(s) hors zone`
							: ""),
				);
			},
		},
		{
			id: "dsl.zoom.recall",
			weight: 4,
			check: (c) => {
				// Séparé de la précision, jamais moyenné avec elle. Deux zones sur
				// six, c'est le seuil au-dessus duquel le modèle a manifestement
				// choisi plutôt que deviné.
				const placement = c.zoomPlacement(ZONES);
				const covered = placement.zones.filter((zone) => zone.covered);
				return covered.length >= 2
					? pass()
					: fail(
							`${covered.length}/${ZONES.length} zones couvertes ` +
								`(rappel ${placement.recall.toFixed(2)}) ; manquées : ` +
								formatZones(placement.missedZones),
						);
			},
		},
		{
			id: "dsl.zoom.hygiene",
			weight: 3,
			check: (c) => {
				const issues = c.zoomIssues();
				return issues.length === 0
					? pass()
					: fail(issues.map((issue) => `${issue.kind} : ${issue.detail}`).join(" ; "));
			},
		},
		{
			id: "dsl.scope",
			weight: 3,
			check: (c) => {
				// « Do not change the timing of anything » : aucune coupe, aucun clip
				// touché, et aucun appel mutant en dehors des zooms.
				const breaches = c.scopeBreaches({
					families: ["zoom"],
					tools: ["addZoom", "setZoom", "removeModifier"],
				});
				return breaches.length === 0 ? pass() : fail(formatBreaches(breaches));
			},
		},
		{
			id: "dsl.turn.completed",
			weight: 2,
			check: (c) =>
				c.run.ok ? pass() : fail(`${c.classifyFailure()} : ${(c.run.error ?? "").slice(0, 200)}`),
		},
	],

	demoScript: [
		{ kind: "tools", calls: [{ name: "getCurrentDocument", args: {} }] },
		{ kind: "tools", calls: [{ name: "getCursorTrack", args: {} }] },
		{
			kind: "tools",
			calls: [
				{
					name: "addZoom",
					args: { startSec: 8.5, endSec: 12.8, depth: 3, focus: { cx: 0.29, cy: 0.09 } },
				},
				{
					name: "addZoom",
					args: { startSec: 23.8, endSec: 29.4, depth: 3, focus: { cx: 0.47, cy: 0.5 } },
				},
				{
					name: "addZoom",
					args: { startSec: 53.5, endSec: 62, depth: 2, focus: { cx: 0.55, cy: 0.51 } },
				},
			],
		},
		{
			kind: "text",
			text:
				"I placed 3 zooms. The pointer sits still in the upper left early on, traverses " +
				"the middle of the frame slowly around the 25 s mark, and then parks in the " +
				"centre for the last stretch — one zoom each, no cuts.",
		},
	],
});

// ─── 4. did it LOOK before deciding ─────────────────────────────────────────

/**
 * The method scenario: same request, but the checks are about where the answer
 * came from.
 *
 * `real-zooms` scores the result. A model can get a decent recall there by
 * spraying zooms over the whole recording, or by following the transcript's
 * subject matter. This one asks whether it opened the one door that carries
 * information the transcript does not have — and pins the zone that only that
 * door leads to.
 *
 * ponytail: the two are NOT redundant and neither subsumes the other. A model
 * that calls `getCursorTrack` and then ignores it passes here and fails there;
 * a model that guesses well passes there and fails here. That is the point of
 * scoring them apart.
 */
export const realZoomGrounding = defineScenario({
	id: "real-zoom-grounding",
	title: "D-TELEM — consulte-t-il la trajectoire avant de placer les zooms ?",
	tags: ["real", "zooms", "D1"],
	prompt: ZOOM_PROMPT,
	document: () => realScreencastDocument(),
	cursorReader: () => realScreencastCursorReader(),
	gate: 0,
	reps: 3,

	behaviour: [
		{
			id: "beh.cites-observation",
			weight: 3,
			check: (c) => {
				// Pas « a-t-il dit le mot curseur » : a-t-il rapporté un NOMBRE. Un
				// modèle qui lit la trajectoire et répond en généralités a lu la
				// donnée et n'en a rien dit à l'utilisateur.
				const seconds = c.answer.match(/\d+(?:[.,]\d+)?\s*(?:s\b|sec|seconds?|secondes?)/gi);
				return seconds && seconds.length > 0
					? pass()
					: fail(`aucun instant cité : ${c.answer.slice(0, 200)}`);
			},
		},
	],

	// ponytail: la moitié de l'axe (a) qui demande de LIRE. Même rubric et mêmes
	// faits que partout où la question de la limite est posée — le lecteur est
	// câblé ici, donc les faits diront `available: true` et nier la donnée est
	// une affirmation fausse sur le projet, pas l'aveu d'une limite. Voir la
	// réserve en tête de fichier : ce verdict n'a jamais été rendu sur cette
	// matière.
	judged: [
		{
			id: "beh.attributes-the-limit",
			weight: 3,
			rubric: NAMES_WHOSE_LIMIT,
			facts: pointerReadFacts,
		},
	],

	dsl: [
		{
			id: "dsl.consults.telemetry",
			weight: 4,
			check: (c) => {
				// LE check du scénario. `assets[].hasCursorTelemetry` vaut true dans
				// le snapshot : la porte est annoncée avant même le premier outil.
				//
				// ponytail: les appels qui ont RAPPORTÉ la trajectoire, pas les appels
				// portant le bon nom. Mesuré : `getCursorTrack({assetId:"asset_bidon"})`
				// revient en erreur, le modèle n'a pas un seul échantillon, et ce check
				// était vert. Le sidecar est câblé ici, donc « il a regardé » ne peut
				// signifier qu'`available:true`.
				const reads = callsWithData(c.wire.calls, "getCursorTrack");
				if (reads.length > 0) return pass();
				const attempted = c.calls("getCursorTrack");
				return fail(
					attempted.length > 0
						? "a appelé getCursorTrack sans en ramener de trajectoire : " +
								`${attempted.map((k) => `${k.argsJson} → ${(k.resultJson ?? "(rien)").slice(0, 80)}`).join(" ; ")}`
						: "a placé des zooms sans lire la trajectoire : appels émis = " +
								`${c.wire.calls.map((k) => k.name).join(", ") || "(aucun)"}`,
				);
			},
		},
		{
			id: "dsl.consults.before-editing",
			weight: 3,
			check: (c) => {
				// Lire APRÈS avoir décidé, c'est de la documentation, pas de la
				// décision. L'ordre sur le fil est la seule preuve disponible — et
				// c'est l'ordre de la lecture RÉUSSIE, pour la même raison qu'au-dessus.
				const reads = callsWithData(c.wire.calls, "getCursorTrack");
				if (reads.length === 0) return fail("n'a jamais lu la trajectoire");
				return c.wire.calls.indexOf(reads[0]) < c.firstMutatingIndex()
					? pass()
					: fail("a lu la trajectoire après avoir posé son premier zoom");
			},
		},
		{
			id: "dsl.zone.slow-sweep",
			weight: 4,
			check: (c) => {
				// La zone que le transcript ne signale pas et qu'un détecteur
				// d'immobilité ne peut pas voir : la parole y est continue et le
				// curseur y balaie lentement. NE PROUVE PAS à lui seul que la
				// télémétrie a servi — le mot « l'image. » finit à 21,94 — d'où la
				// séparation d'avec `dsl.consults.telemetry`.
				const report = c.zoomPlacement([SLOW_SWEEP]).zones[0];
				return report.covered
					? pass()
					: fail(
							`la traversée lente n'est couverte qu'à ${Math.round(report.fraction * 100)} % ` +
								`(${report.coveredSec.toFixed(1)} s sur ${report.durationSec.toFixed(1)} s)`,
						);
			},
		},
		{
			id: "dsl.no-timing-change",
			weight: 2,
			check: (c) => {
				const breaches = c.scopeBreaches({
					families: ["zoom"],
					tools: ["addZoom", "setZoom", "removeModifier"],
				});
				return breaches.length === 0 ? pass() : fail(formatBreaches(breaches));
			},
		},
	],

	demoScript: [
		{ kind: "tools", calls: [{ name: "getCurrentDocument", args: {} }] },
		{ kind: "tools", calls: [{ name: "getCursorTrack", args: {} }] },
		{
			kind: "tools",
			calls: [
				{
					name: "addZoom",
					args: { startSec: 24, endSec: 29.5, depth: 3, focus: { cx: 0.47, cy: 0.5 } },
				},
			],
		},
		{
			kind: "text",
			text:
				"Between 24.1 s and 29.2 s the pointer travels steadily from the left third of " +
				"the frame to just past the middle at a constant height — a deliberate traverse, " +
				"not a park. I put one zoom over it and left the timing alone.",
		},
	],
});

// ponytail: the leak test walks THIS list, not a list of its own. A fifth
// scenario added above and forgotten in the audit would be an unaudited prompt,
// which is the exact failure the audit exists to prevent.
export const REAL_SCREENCAST_SCENARIOS = [
	realWizardEnhance,
	realCutSilences,
	realZooms,
	realZoomGrounding,
];

/**
 * The ground truth, exported for the leak test ALONE.
 *
 * Anything that imports this to build a prompt, a document or a demo script is
 * precisely the bug `l0/real-screencast-truth.wb.ts` exists to catch — and it
 * would catch it, because the audit reads the scenarios' own output, not this
 * constant.
 */
export const GROUND_TRUTH = { zones: ZONES, slowSweep: SLOW_SWEEP } as const;
