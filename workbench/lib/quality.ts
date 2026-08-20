// ponytail: the six questions a human asks about a CUT, as arithmetic.
//
// `editorial.ts` answers "what did this turn do to the material": how much
// speech disappeared, what the delta is per family, whether a zoom is a flash.
// It is deliberately blind to two things, and both are where the judgement
// actually lives:
//
//   • it has no notion of a PAUSE. `silenceSpans` returns the complement of the
//     words INSIDE the transcript's own span, with no minimum duration. On the
//     synthetic fixtures that is the list a human would draw, because those
//     fixtures declare `kind:"silence"` segments with round bounds. On the real
//     66 s take it returns the eight inter-word gaps — six silences, plus a
//     0.22 s and a 0.29 s breath that must not be cut — and it cannot see the
//     2.33 s before the first word AT ALL, which is 23 % of the silence in that
//     recording and the single easiest thing to cut. An oracle built on it
//     under-reports what there was to do and credits cutting a breath.
//   • it has no notion of GROUND TRUTH for zooms beyond `InterestPoint`, which
//     is a single instant with a tolerance. A user showing an image for seven
//     seconds is not an instant, and scoring a zoom by whether it contains a
//     centre point cannot tell a 0.5 s flash on that centre from a zoom that
//     actually covers the moment.
//
// So: pauses first (with a floor and an edge/interior distinction), then the
// four oracles that need them, then placement against declared zones with
// precision AND recall — never one blended score, because the two failures they
// describe have opposite fixes. A model that emits one huge zoom has recall 1
// and precision near 0; a model that emits one perfect 1 s zoom out of six
// zones has precision 1 and recall near 0. A single number calls both "0.5".
//
// Every function here is deterministic and quotes seconds. None of them knows
// what the user was doing — the zones come in as an argument, from the
// assertion side of a scenario, and must never reach the model.

import type { AxcutDocument } from "../../src/lib/ai-edition/schema";
import {
	addedTrims,
	type EditFamily,
	type FamilyDelta,
	outOfScopeCalls,
	outOfScopeEdits,
	primaryAssetId,
	removedSourceSpans,
	type SpeechDamage,
	speechDamage,
	speechSpans,
	transcriptOf,
	zoomSpans,
} from "./editorial";
import {
	intersectSpans,
	mergeSpans,
	overlapSec,
	SPAN_EPSILON_SEC,
	type Span,
	subtractSpans,
	totalSec,
} from "./spans";

// ─── pauses: the unit every cut oracle is measured against ──────────────────

/**
 * Shortest gap that reads as a pause rather than as breathing.
 *
 * 0.35 s is where a listener stops hearing a rhythm and starts hearing a hole.
 * It is also the floor below which cutting is pointless: removing 0.2 s from
 * between two words changes the pacing by nothing and risks a clipped
 * consonant. The value is an argument everywhere it is used — a scenario whose
 * material is slower may raise it — but it is stated once, here, so that two
 * oracles can never disagree about what a silence is.
 */
export const DEFAULT_MIN_PAUSE_SEC = 0.35;

export type PauseKind = "edge" | "interior";

export interface Pause extends Span {
	/** Position in the returned list, so evidence can name "pause #3". */
	index: number;
	durationSec: number;
	/** `edge` when the pause touches the start or the end of the material. */
	kind: PauseKind;
}

export interface PauseOptions {
	minSec?: number;
	assetId?: string;
}

/**
 * The material the transcript is describing, in source seconds.
 *
 * The ASSET's duration, not the transcript's coverage — that difference is the
 * whole reason edge pauses exist. A recording where the speaker starts talking
 * at 2.33 s has 2.33 s of dead air at the head that no transcript mentions,
 * because there is nothing to transcribe there. An oracle anchored on the first
 * word cannot see it, and "cut the dead time" is very often mostly about it.
 */
function materialWindow(document: AxcutDocument, assetId?: string): Span | null {
	const wanted = assetId ?? primaryAssetId(document);
	// ponytail: `durationSec` is optional in the schema — an asset whose probe
	// never ran carries none. Falling back on the transcript's own extent is the
	// only honest answer then, and it costs the edge pauses, which is why the
	// two branches are visibly different rather than a `?? 0`.
	const asset = document.assets.find((entry) => entry.id === wanted);
	const durationSec = asset?.durationSec;
	if (durationSec !== undefined && durationSec > 0) return { startSec: 0, endSec: durationSec };
	const speech = speechSpans(document, wanted);
	if (speech.length === 0) return null;
	return { startSec: speech[0].startSec, endSec: speech.at(-1)?.endSec ?? speech[0].endSec };
}

/**
 * Where the silences are, as an editor would list them.
 *
 * Derived from speech ALWAYS, never from `kind:"silence"` segments, which is
 * the one place this deliberately disagrees with `editorial.silenceSpans`.
 * Three reasons, in order of importance: a real transcript declares none (the
 * local Whisper helper emits speech segments only, so an oracle that prefers
 * declared silences works on our fixtures and returns nothing on real
 * material); a declared silence cannot express the head of the recording, which
 * no segment covers; and a fixture that declares its own silences is grading
 * itself — the same file writes the answer and the question.
 *
 * Gaps shorter than `minSec` are dropped rather than merged into their
 * neighbours: they are not silences, and a coverage number that counts them is
 * a coverage number that rewards cutting a breath. On this take the floor
 * removes three of ten candidates — 0.18 s, 0.22 s, 0.29 s.
 */
export function pauses(document: AxcutDocument, options: PauseOptions = {}): Pause[] {
	const minSec = options.minSec ?? DEFAULT_MIN_PAUSE_SEC;
	const wanted = options.assetId ?? primaryAssetId(document);
	const window = materialWindow(document, wanted);
	if (!window) return [];
	const speech = speechSpans(document, wanted);
	if (speech.length === 0) return [];
	return subtractSpans([window], speech)
		.filter((gap) => gap.endSec - gap.startSec >= minSec - SPAN_EPSILON_SEC)
		.map((gap, index) => ({
			startSec: gap.startSec,
			endSec: gap.endSec,
			index,
			durationSec: gap.endSec - gap.startSec,
			kind:
				gap.startSec <= window.startSec + SPAN_EPSILON_SEC ||
				gap.endSec >= window.endSec - SPAN_EPSILON_SEC
					? ("edge" as const)
					: ("interior" as const),
		}));
}

// ─── (a) speech destroyed, named word by word ───────────────────────────────

export interface DamagedWord {
	id: string;
	text: string;
	startSec: number;
	endSec: number;
	/** Seconds of THIS word the turn removed. */
	removedSec: number;
	/** The word is gone entirely; otherwise it was cut mid-syllable. */
	whole: boolean;
}

export interface SpeechDamageDetail extends SpeechDamage {
	/** Every word the removal touched, in transcript order. */
	words: DamagedWord[];
	wholeWords: number;
	/** Words the cut ran through — the audible defect. A whole word removed is
	 * a lost sentence; half a word is a click. */
	clippedWords: number;
}

/** Words overlapping `removed`, with how much of each disappeared. */
export function damagedWords(
	document: AxcutDocument,
	removed: Span[],
	assetId?: string,
): DamagedWord[] {
	const transcript = transcriptOf(document, assetId ?? primaryAssetId(document));
	if (!transcript) return [];
	const out: DamagedWord[] = [];
	for (const word of transcript.words) {
		const span: Span = { startSec: word.startSec, endSec: word.endSec };
		const removedSec = totalSec(intersectSpans([span], removed));
		if (removedSec <= SPAN_EPSILON_SEC) continue;
		out.push({
			id: word.id,
			text: word.text,
			startSec: word.startSec,
			endSec: word.endSec,
			removedSec,
			whole: removedSec >= word.endSec - word.startSec - SPAN_EPSILON_SEC,
		});
	}
	return out;
}

/**
 * THE oracle for "cut the silences", with the evidence a human can act on.
 *
 * `speechDamage` already says how many seconds died. That number is the gate,
 * and it is also the least useful half of the answer: 0.31 s destroyed says
 * nothing about whether the edit is salvageable, whereas «"l'image." amputé de
 * 0,31 s sur 0,35» says exactly what the viewer will hear. The words are not a
 * nicety — they are the reason this oracle can be trusted over a threshold.
 */
export function speechDamageDetail(
	before: AxcutDocument,
	after: AxcutDocument,
	assetId?: string,
): SpeechDamageDetail {
	const damage = speechDamage(before, after, assetId);
	const words = damagedWords(before, damage.spans, assetId);
	return {
		...damage,
		words,
		wholeWords: words.filter((word) => word.whole).length,
		clippedWords: words.filter((word) => !word.whole).length,
	};
}

/** Compact evidence: `"l'image." −0.31 s, "À" −0.12 s`. */
export function formatDamagedWords(words: DamagedWord[], max = 5): string {
	const shown = words
		.slice(0, max)
		.map((word) => `${JSON.stringify(word.text)} −${word.removedSec.toFixed(2)} s`)
		.join(", ");
	return words.length > max ? `${shown}, +${words.length - max}` : shown;
}

// ─── (b) cut precision, edge by edge ────────────────────────────────────────

/** Below this, a cut edge and a pause boundary are the same instant — the
 * model transcribed the boundary it was handed. Not a tolerance for damage:
 * `speechBittenSec` is measured whatever the verdict says. */
export const EXACT_CUT_SEC = 0.01;

/**
 * - `exact` — the edge sits on a pause boundary, to the centisecond.
 * - `margin` — the edge sits inside a silence: the cut left the speech room.
 * - `encroachment` — the edge sits in speech and took some of it with it.
 * - `unmatched` — there is no pause of that polarity to compare against.
 */
export type EdgeVerdict = "exact" | "margin" | "encroachment" | "unmatched";

export interface CutEdge {
	which: "start" | "end";
	atSec: number;
	/**
	 * The nearest pause boundary OF THE SAME POLARITY — a trim's start edge is
	 * compared to pause starts, its end edge to pause ends. Comparing a start
	 * edge to the nearest boundary of any kind reports a 0.1 s error for a cut
	 * that began 2.4 s late, because the pause's own END was closer.
	 */
	boundarySec: number | null;
	/**
	 * `atSec - boundarySec` for a start edge, `boundarySec - atSec` for an end
	 * edge — so the sign means the same thing on both: positive is INWARD, the
	 * cut edge sits later than the pause opened / earlier than it closed.
	 */
	deltaSec: number | null;
	/** Speech lying between the edge and that boundary. The bite, in seconds,
	 * independent of the sign games above. */
	speechBittenSec: number;
	verdict: EdgeVerdict;
}

export interface CutPrecision {
	trimId: string;
	startSec: number;
	endSec: number;
	/** The pause this trim overlaps most; null when it targets none at all. */
	pause: Pause | null;
	overlapWithPauseSec: number;
	/** `[start, end]`, always two entries. */
	edges: CutEdge[];
	/** Total speech inside this one trim — the per-trim form of oracle (a). */
	speechEatenSec: number;
	words: DamagedWord[];
	/** The larger of the two edge bites. 0 for a clean cut. */
	worstBiteSec: number;
}

function nearestBoundary(candidates: number[], atSec: number): number | null {
	if (candidates.length === 0) return null;
	let best = candidates[0];
	for (const value of candidates) {
		if (Math.abs(value - atSec) < Math.abs(best - atSec)) best = value;
	}
	return best;
}

function buildEdge(
	which: "start" | "end",
	atSec: number,
	boundaries: number[],
	speech: Span[],
): CutEdge {
	const boundarySec = nearestBoundary(boundaries, atSec);
	if (boundarySec === null) {
		return {
			which,
			atSec,
			boundarySec: null,
			deltaSec: null,
			speechBittenSec: 0,
			verdict: "unmatched",
		};
	}
	const deltaSec = which === "start" ? atSec - boundarySec : boundarySec - atSec;
	const between: Span = {
		startSec: Math.min(atSec, boundarySec),
		endSec: Math.max(atSec, boundarySec),
	};
	const speechBittenSec = totalSec(intersectSpans(speech, [between]));
	let verdict: EdgeVerdict;
	if (Math.abs(deltaSec) <= EXACT_CUT_SEC) verdict = "exact";
	else if (speechBittenSec > EXACT_CUT_SEC) verdict = "encroachment";
	else verdict = "margin";
	return { which, atSec, boundarySec, deltaSec, speechBittenSec, verdict };
}

/**
 * Where each cut edge landed relative to the silence it was aiming at.
 *
 * `editorial.trimMargins` answers a neighbouring question — how much of the
 * matched silence survived on each side — and answers it only when a silence
 * overlaps the trim at all. This one always answers, because the interesting
 * trims are precisely the ones that overlap no silence: a trim placed on speech
 * gets `pause: null` here AND a measured distance to the nearest boundary of
 * each polarity, which is what tells you whether the model missed by 80 ms or
 * cut somewhere else entirely.
 */
export function cutPrecision(
	before: AxcutDocument,
	after: AxcutDocument,
	options: PauseOptions = {},
): CutPrecision[] {
	const wanted = options.assetId ?? primaryAssetId(before);
	const silences = pauses(before, options);
	const speech = speechSpans(before, wanted);
	const starts = silences.map((pause) => pause.startSec);
	const ends = silences.map((pause) => pause.endSec);
	return addedTrims(before, after).map((trim) => {
		const span: Span = { startSec: trim.startSec, endSec: trim.endSec };
		let pause: Pause | null = null;
		let overlapWithPauseSec = 0;
		for (const candidate of silences) {
			const shared = overlapSec(span, candidate);
			if (shared > overlapWithPauseSec) {
				pause = candidate;
				overlapWithPauseSec = shared;
			}
		}
		const edges = [
			buildEdge("start", trim.startSec, starts, speech),
			buildEdge("end", trim.endSec, ends, speech),
		];
		const eaten = intersectSpans(speech, [span]);
		return {
			trimId: trim.id,
			startSec: trim.startSec,
			endSec: trim.endSec,
			pause,
			overlapWithPauseSec,
			edges,
			speechEatenSec: totalSec(eaten),
			words: damagedWords(before, eaten, wanted),
			worstBiteSec: Math.max(...edges.map((edge) => edge.speechBittenSec)),
		};
	});
}

// ─── (c) coverage, with the edges kept apart ────────────────────────────────

/**
 * Fraction of a pause that must disappear before it counts as cut.
 *
 * Not 1: a cut that leaves 100 ms of air at each end of a 2.5 s pause did the
 * job, and a coverage oracle that calls that a miss would push every model
 * toward the flush cuts that oracle (b) exists to discourage. Not 0.5 either —
 * removing half a pause is audible as a pause.
 */
export const DEFAULT_COVER_FRACTION = 0.6;

export interface PauseCoverage {
	pause: Pause;
	removedSec: number;
	/** `removedSec / pause.durationSec`. */
	fraction: number;
	covered: boolean;
}

export interface CoverageSide {
	pauses: PauseCoverage[];
	totalSec: number;
	removedSec: number;
	/** Seconds removed over seconds available — NOT the count of pauses cut. */
	fraction: number;
	missed: PauseCoverage[];
}

export interface SilenceCoverage {
	/** Pauses between two words. The recall a "cut the silences" turn is about. */
	interior: CoverageSide;
	/**
	 * The head and the tail. Kept apart on purpose: cutting them is nearly
	 * always right and nearly always easy, and on this material the head alone
	 * is 2.33 s of the 10.2 s of silence — 23 % of a global recall number handed
	 * out for trimming the moment before the speaker started. A model that cuts
	 * the head and nothing else would score 0.23 on a blended metric and 0 on
	 * the thing that was asked.
	 */
	edge: CoverageSide;
	all: PauseCoverage[];
	minPauseSec: number;
	coverFraction: number;
}

export interface CoverageOptions extends PauseOptions {
	coverFraction?: number;
}

function side(entries: PauseCoverage[]): CoverageSide {
	const totalSec = entries.reduce((sum, entry) => sum + entry.pause.durationSec, 0);
	const removedSec = entries.reduce((sum, entry) => sum + entry.removedSec, 0);
	return {
		pauses: entries,
		totalSec,
		removedSec,
		fraction: totalSec > 0 ? removedSec / totalSec : 1,
		missed: entries.filter((entry) => !entry.covered),
	};
}

export function silenceCoverage(
	before: AxcutDocument,
	after: AxcutDocument,
	options: CoverageOptions = {},
): SilenceCoverage {
	const wanted = options.assetId ?? primaryAssetId(before);
	const coverFraction = options.coverFraction ?? DEFAULT_COVER_FRACTION;
	const removed = removedSourceSpans(before, after, wanted);
	const all = pauses(before, options).map((pause) => {
		const removedSec = totalSec(intersectSpans([pause], removed));
		const fraction = pause.durationSec > 0 ? removedSec / pause.durationSec : 0;
		return { pause, removedSec, fraction, covered: fraction >= coverFraction };
	});
	return {
		interior: side(all.filter((entry) => entry.pause.kind === "interior")),
		edge: side(all.filter((entry) => entry.pause.kind === "edge")),
		all,
		minPauseSec: options.minSec ?? DEFAULT_MIN_PAUSE_SEC,
		coverFraction,
	};
}

/** `16.02–18.50 (2.48 s)` for each missed pause. */
export function formatPauses(entries: PauseCoverage[], max = 6): string {
	const shown = entries
		.slice(0, max)
		.map(
			(entry) =>
				`${entry.pause.startSec.toFixed(2)}–${entry.pause.endSec.toFixed(2)} ` +
				`(${entry.pause.durationSec.toFixed(2)} s, ${Math.round(entry.fraction * 100)} % retiré)`,
		)
		.join(" ; ");
	return entries.length > max ? `${shown}, +${entries.length - max}` : shown;
}

// ─── (e) zoom placement against declared zones ──────────────────────────────

/**
 * A stretch of the recording where something worth showing happened.
 *
 * A ZONE, not a point: `editorial.InterestPoint` is an instant with a
 * tolerance, which cannot distinguish a 0.5 s flash on the right second from a
 * zoom that actually holds through the moment. The label is free text and is
 * evidence only — it exists so a failure reads as «zone "…" jamais couverte»
 * rather than as two numbers, and it must never travel toward the model.
 */
export interface TruthZone {
	startSec: number;
	endSec: number;
	label: string;
}

export interface ZoomHit {
	zoomId: string;
	span: Span;
	durationSec: number;
	/** The zone it overlaps most, null when it overlaps none. */
	zone: TruthZone | null;
	overlapSec: number;
	/** `overlapSec / durationSec` — how much of this zoom is on a zone. */
	onZoneFraction: number;
}

export interface ZoneCoverage {
	zone: TruthZone;
	durationSec: number;
	/** Union of every zoom's overlap with this zone — zooms may not overlap
	 * each other, but the union is the honest operation regardless. */
	coveredSec: number;
	fraction: number;
	zoomIds: string[];
	covered: boolean;
}

export interface ZoomPlacement {
	hits: ZoomHit[];
	zones: ZoneCoverage[];
	/** Zooms that overlap no zone at all. */
	strayZoomIds: string[];
	missedZones: ZoneCoverage[];
	/** Zoom seconds spent on a zone over total zoom seconds. 1 with no zooms —
	 * emitting nothing is a recall failure, never a precision one. */
	precision: number;
	/** Zone seconds covered over total zone seconds. */
	recall: number;
	zoomSec: number;
	onZoneSec: number;
	zoneSec: number;
	coveredZoneSec: number;
}

export interface ZoomPlacementOptions {
	/** Fraction of a ZONE that must be under a zoom for it to count as covered. */
	coverFraction?: number;
	/** Fraction of a ZOOM that must sit on a zone before it stops being stray. */
	onZoneFraction?: number;
}

export const DEFAULT_ZONE_COVER_FRACTION = 0.4;
export const DEFAULT_ON_ZONE_FRACTION = 0.5;

/**
 * Precision and recall of the zooms against what the user was actually doing.
 *
 * Two numbers, never one. They fail in opposite directions and have opposite
 * fixes: low recall is a model that did not look (or looked only at the
 * transcript), low precision is a model that sprayed zooms to cover itself.
 * Both are computed on temporal OVERLAP, not on whether a centre falls in a
 * window — a 0.4 s zoom in the middle of a 7 s zone is not coverage of that
 * zone, and a 30 s zoom containing three zones is not three good calls.
 */
export function zoomPlacement(
	document: AxcutDocument,
	zones: TruthZone[],
	options: ZoomPlacementOptions = {},
): ZoomPlacement {
	const coverFraction = options.coverFraction ?? DEFAULT_ZONE_COVER_FRACTION;
	const onZoneFraction = options.onZoneFraction ?? DEFAULT_ON_ZONE_FRACTION;
	const spans = zoomSpans(document);

	const hits: ZoomHit[] = spans.map(({ id, span }) => {
		const durationSec = Math.max(0, span.endSec - span.startSec);
		let zone: TruthZone | null = null;
		let best = 0;
		for (const candidate of zones) {
			const shared = sharedSec(span, candidate);
			if (shared > best) {
				zone = candidate;
				best = shared;
			}
		}
		return {
			zoomId: id,
			span,
			durationSec,
			zone,
			overlapSec: best,
			onZoneFraction: durationSec > 0 ? best / durationSec : 0,
		};
	});

	const zoneReports: ZoneCoverage[] = zones.map((zone) => {
		const durationSec = Math.max(0, zone.endSec - zone.startSec);
		const covering = spans.filter((entry) => sharedSec(entry.span, zone) > SPAN_EPSILON_SEC);
		const coveredSec = totalSec(
			intersectSpans(
				covering.map((entry) => entry.span),
				[{ startSec: zone.startSec, endSec: zone.endSec }],
			),
		);
		const fraction = durationSec > 0 ? coveredSec / durationSec : 0;
		return {
			zone,
			durationSec,
			coveredSec,
			fraction,
			zoomIds: covering.map((entry) => entry.id),
			covered: fraction >= coverFraction,
		};
	});

	// ponytail: BOTH totals are unions, and `zoomSec` was a sum until it wasn't.
	// Rule 2 in `timelineMap.ts` forbids two zooms from overlapping, but only
	// `setZoom` goes through the clamp that enforces it (`replacePillSpan`,
	// `agent-tools.ts:1395`) — `addZoom` appends (`agent-tools.ts:1349`), so an
	// agent CAN stack zooms, and `editorial.ts` carries an `overlap` check
	// precisely because it happens. On such a document a summed denominator
	// counts the shared seconds twice while the intersected numerator counts them
	// once, and `precision` reads low for a reason that has nothing to do with
	// placement. Union on both sides or the ratio is not a ratio of the same thing.
	const zoomSec = totalSec(mergeSpans(spans.map((entry) => entry.span)));
	const onZoneSec = totalSec(
		intersectSpans(
			spans.map((entry) => entry.span),
			zones.map((zone) => ({ startSec: zone.startSec, endSec: zone.endSec })),
		),
	);
	const zoneSec = zoneReports.reduce((sum, report) => sum + report.durationSec, 0);
	const coveredZoneSec = zoneReports.reduce((sum, report) => sum + report.coveredSec, 0);

	return {
		hits,
		zones: zoneReports,
		strayZoomIds: hits
			.filter((hit) => hit.onZoneFraction < onZoneFraction)
			.map((hit) => hit.zoomId),
		missedZones: zoneReports.filter((report) => !report.covered),
		precision: zoomSec > 0 ? onZoneSec / zoomSec : 1,
		recall: zoneSec > 0 ? coveredZoneSec / zoneSec : 1,
		zoomSec,
		onZoneSec,
		zoneSec,
		coveredZoneSec,
	};
}

/** `overlapSec` takes two `Span`s; a `TruthZone` is one plus a label. */
function sharedSec(span: Span, zone: TruthZone | Span): number {
	return overlapSec(span, { startSec: zone.startSec, endSec: zone.endSec });
}

/** `"montre une image" 0 % (aucun zoom)` for each zone. */
export function formatZones(reports: ZoneCoverage[], max = 6): string {
	const shown = reports
		.slice(0, max)
		.map(
			(report) =>
				`${JSON.stringify(report.zone.label)} ${report.zone.startSec.toFixed(1)}–` +
				`${report.zone.endSec.toFixed(1)} s : ${Math.round(report.fraction * 100)} %` +
				(report.zoomIds.length === 0 ? " (aucun zoom)" : ""),
		)
		.join(" ; ");
	return reports.length > max ? `${shown}, +${reports.length - max}` : shown;
}

// ─── (f) scope, documents and calls in one list ─────────────────────────────

export interface ScopeRequest {
	/** Families the prompt licenses the agent to change. */
	families: EditFamily[];
	/** Mutating tools the prompt licenses it to call. */
	tools: string[];
}

export interface ScopeBreach {
	/** `document` — something changed that nobody asked to change.
	 *  `call` — a mutating tool ran that the request did not license. */
	source: "document" | "call";
	what: string;
	detail: string;
}

/**
 * Both halves of "and nothing else", in the order a reader wants them.
 *
 * They are genuinely different failures and neither implies the other. A
 * `replaceTimeline` that reproduces the timeline exactly is an unlicensed call
 * with no document delta — invisible to `outOfScopeEdits`, and a destructive
 * habit worth naming. A zoom that appears because the model called a LICENSED
 * tool with the wrong arguments is a document breach with no call breach.
 */
export function scopeBreaches<T extends { name: string; mutating: boolean }>(
	before: AxcutDocument,
	after: AxcutDocument,
	calls: T[],
	scope: ScopeRequest,
): ScopeBreach[] {
	const breaches: ScopeBreach[] = [];
	for (const delta of outOfScopeEdits(before, after, { families: scope.families })) {
		breaches.push({
			source: "document",
			what: delta.family,
			detail: describeDelta(delta),
		});
	}
	for (const call of outOfScopeCalls(calls, scope.tools)) {
		breaches.push({
			source: "call",
			what: call.name,
			detail: "appel mutant hors périmètre",
		});
	}
	return breaches;
}

function describeDelta(delta: FamilyDelta): string {
	return `+${delta.added.length} / -${delta.removed.length} / ~${delta.changed.length}`;
}

export function formatBreaches(breaches: ScopeBreach[], max = 6): string {
	const shown = breaches
		.slice(0, max)
		.map((breach) => `${breach.what} (${breach.detail})`)
		.join(", ");
	return breaches.length > max ? `${shown}, +${breaches.length - max}` : shown;
}
