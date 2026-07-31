// ponytail: the document seen as an EDIT, not as a schema.
//
// Everything the workbench measured until now was conformity: is the JSON
// valid, do the ids survive, does the tool's report match the document. All of
// it can be perfectly green on an edit that is editorially catastrophic — the
// baseline of 2026-07-31 has a turn that cut two silences, reported them
// truthfully, kept every invariant, and would have destroyed 1.4 s of speech
// had the silence boundaries been ragged. `dsl.trims.cover-silences` only ever
// asked the ONE-WAY question ("was each silence covered, ±0.4 s"); nothing
// asked the converse, which is the property that actually matters to a user:
// DID THE CUT REMOVE ANY SPEECH.
//
// These oracles are deterministic on purpose. An LLM judge would score all of
// this too, and would score it differently on Tuesday; a number computed from
// interval arithmetic can be regressed against, put in a baseline, and
// disputed. When one of them fires it can quote seconds, not an opinion.
//
// Import direction: this module knows about documents and spans and NOTHING
// about scoring, scenarios, or the wire. `oracles.ts` imports from here, never
// the reverse — `playbackSegments` and `regionFamilies` live here so that the
// import stays one-way (they were in `oracles.ts` and are re-exported from it).

import { resolvePlaybackSegments } from "../../src/lib/ai-edition/document/timeline";
import type { AxcutClip, AxcutDocument, AxcutTranscript } from "../../src/lib/ai-edition/schema";
import {
	intersectSpans,
	mergeSpans,
	overlapSec,
	SPAN_EPSILON_SEC,
	type Span,
	subtractSpans,
	totalSec,
} from "./spans";

// ─── document geometry ──────────────────────────────────────────────────────

export interface Region {
	id: string;
	startMs: number;
	endMs: number;
	clipId?: string;
	sourceStartSec?: number;
	sourceEndSec?: number;
}

export interface RegionFamily {
	kind: string;
	regions: Region[];
}

/** One of the two `legacyEditor` collections, which the schema does not
 * validate at all (`schema/index.ts:432` is a `z.object({}).passthrough()`). */
export function legacyRegions(document: AxcutDocument, key: string): Region[] {
	const legacy = document.legacyEditor as Record<string, unknown> | null;
	const list = legacy?.[key];
	return Array.isArray(list) ? (list as Region[]) : [];
}

/** Every anchored region family, including the two that live in the
 * unvalidated `legacyEditor` passthrough (`schema/index.ts:432`). */
export function regionFamilies(document: AxcutDocument): RegionFamily[] {
	return [
		{ kind: "zoom", regions: document.zoomRanges as unknown as Region[] },
		{ kind: "annotation", regions: document.annotations as unknown as Region[] },
		{ kind: "speed", regions: legacyRegions(document, "speedRegions") },
		{ kind: "cameraFullscreen", regions: legacyRegions(document, "cameraFullscreenRegions") },
	];
}

/** Playback layout: clips narrowed by every trim on the same asset. A clip cut
 * in two by a trim comes back as two segments (`timeline.ts:194-206`). */
export function playbackSegments(document: AxcutDocument): AxcutClip[] {
	return resolvePlaybackSegments(document.timeline.clips, document.timeline.trimRanges);
}

export function primaryAssetId(document: AxcutDocument): string | undefined {
	return document.project.primaryAssetId ?? document.assets[0]?.id;
}

/**
 * The SOURCE seconds that still reach the viewer, per asset.
 *
 * This is the one projection every damage oracle is built on, and it is
 * deliberately taken from the playback layout rather than from `trimRanges`:
 * material also disappears when a clip is dropped, shortened, or replaced
 * wholesale by `replaceTimeline`. A "what did the trims remove" oracle would
 * have scored the reorder-clips turn — which deleted the user's 12–17 s trim
 * and re-minted every id — as having removed nothing at all.
 */
export function keptSourceSpans(document: AxcutDocument, assetId?: string): Span[] {
	const wanted = assetId ?? primaryAssetId(document);
	return mergeSpans(
		playbackSegments(document)
			.filter((segment) => segment.assetId === wanted)
			.map((segment) => ({
				startSec: segment.sourceStartSec,
				endSec: segment.sourceEndSec ?? segment.sourceStartSec,
			})),
	);
}

/** ponytail: exported for `quality.ts`, which needs the WORDS themselves and
 * not just their spans — a damaged word is named, a damaged span is a number. */
export function transcriptOf(document: AxcutDocument, assetId?: string): AxcutTranscript | null {
	const wanted = assetId ?? primaryAssetId(document);
	return document.transcripts.find((t) => t.assetId === wanted) ?? null;
}

/**
 * Where speech is, in source seconds.
 *
 * Word timings win when the transcript carries them: they are the only source
 * whose boundaries were not authored by the same file that declares the answer
 * (see `lib/transcript.ts`). `kind: "speech"` segments are the fallback, and
 * they are coarser — a segment spans the pauses between its own words.
 */
export function speechSpans(document: AxcutDocument, assetId?: string): Span[] {
	const transcript = transcriptOf(document, assetId);
	if (!transcript) return [];
	if (transcript.words.length > 0) {
		return mergeSpans(
			transcript.words.map((word) => ({ startSec: word.startSec, endSec: word.endSec })),
		);
	}
	return mergeSpans(
		transcript.segments
			.filter((segment) => segment.kind === "speech")
			.map((segment) => ({ startSec: segment.startSec, endSec: segment.endSec })),
	);
}

/**
 * Where the silences are.
 *
 * Explicit `kind: "silence"` segments win, because that is precisely what
 * `getTranscript` shows the model and therefore what it was asked to cut.
 * Absent those — a real Whisper transcript has none, it only emits speech —
 * silence is the complement of the words inside the transcript's own span.
 */
export function silenceSpans(document: AxcutDocument, assetId?: string): Span[] {
	const transcript = transcriptOf(document, assetId);
	if (!transcript) return [];
	const explicit = transcript.segments.filter((segment) => segment.kind === "silence");
	if (explicit.length > 0) {
		return mergeSpans(explicit.map((s) => ({ startSec: s.startSec, endSec: s.endSec })));
	}
	const speech = speechSpans(document, assetId);
	if (speech.length === 0) return [];
	const covered = {
		startSec: Math.min(...transcript.segments.map((s) => s.startSec), speech[0].startSec),
		endSec: Math.max(
			...transcript.segments.map((s) => s.endSec),
			speech.at(-1)?.endSec ?? speech[0].endSec,
		),
	};
	return subtractSpans([covered], speech);
}

/** Source material that played in `before` and no longer plays in `after`. */
export function removedSourceSpans(
	before: AxcutDocument,
	after: AxcutDocument,
	assetId?: string,
): Span[] {
	const wanted = assetId ?? primaryAssetId(before);
	return subtractSpans(keptSourceSpans(before, wanted), keptSourceSpans(after, wanted));
}

// ─── 1. speech destroyed ────────────────────────────────────────────────────

export interface SpeechDamage {
	/** Seconds of SPEECH the turn removed. The headline number: it must be 0. */
	destroyedSec: number;
	/** Where, so the evidence names timecodes rather than a total. */
	spans: Span[];
	/** Total source seconds removed, speech or not. */
	removedSec: number;
	/** Speech that was playing before the turn — the denominator. */
	speechBeforeSec: number;
	/** True when the numbers rest on real per-word timestamps rather than on
	 * segment boundaries a fixture authored. */
	fromWordTimings: boolean;
}

/**
 * THE oracle for "cut the silences": how much speech did the edit destroy?
 *
 * `dsl.trims.cover-silences` asks whether each declared silence was covered,
 * with a ±0.4 s tolerance — which is to say it explicitly TOLERATES a cut
 * running 0.4 s into the speech on either side, and reports nothing when it
 * does. On a 2.5 s pause between two sentences, 0.4 s is the first word of the
 * next one. This is the converse question, and it has no tolerance: a cut that
 * removes speech removed speech.
 */
export function speechDamage(
	before: AxcutDocument,
	after: AxcutDocument,
	assetId?: string,
): SpeechDamage {
	const wanted = assetId ?? primaryAssetId(before);
	const transcript = transcriptOf(before, wanted);
	const speech = speechSpans(before, wanted);
	const playing = intersectSpans(speech, keptSourceSpans(before, wanted));
	const removed = removedSourceSpans(before, after, wanted);
	const destroyed = intersectSpans(playing, removed);
	return {
		destroyedSec: totalSec(destroyed),
		spans: destroyed,
		removedSec: totalSec(removed),
		speechBeforeSec: totalSec(playing),
		fromWordTimings: (transcript?.words.length ?? 0) > 0,
	};
}

// ─── 2. orphan fragments ────────────────────────────────────────────────────

export interface Fragment {
	id: string;
	startSec: number;
	endSec: number;
	durationSec: number;
}

/**
 * Default below which a surviving piece of material is a stutter rather than a
 * shot. Half a second is roughly one word; anything shorter reads as a glitch
 * whatever it contains, which is why the threshold is not conditioned on
 * whether the fragment holds speech.
 */
export const ORPHAN_MAX_SEC = 0.5;

/** Playback segments shorter than `maxSec` — islands left between two cuts. */
export function shortFragments(document: AxcutDocument, maxSec = ORPHAN_MAX_SEC): Fragment[] {
	return playbackSegments(document)
		.map((segment) => ({
			id: segment.id,
			startSec: segment.sourceStartSec,
			endSec: segment.sourceEndSec ?? segment.sourceStartSec,
			durationSec: segment.timelineEndSec - segment.timelineStartSec,
		}))
		.filter(
			(fragment) =>
				fragment.durationSec > SPAN_EPSILON_SEC && fragment.durationSec < maxSec - SPAN_EPSILON_SEC,
		);
}

/**
 * Short fragments the TURN created. A fixture is allowed to contain a short
 * clip on purpose; charging the model for one it inherited would make the
 * oracle a property of the fixture instead of a property of the edit.
 */
export function orphanFragments(
	before: AxcutDocument,
	after: AxcutDocument,
	maxSec = ORPHAN_MAX_SEC,
): Fragment[] {
	const inherited = new Set(
		shortFragments(before, maxSec).map((f) => `${f.startSec.toFixed(3)}-${f.endSec.toFixed(3)}`),
	);
	return shortFragments(after, maxSec).filter(
		(fragment) => !inherited.has(`${fragment.startSec.toFixed(3)}-${fragment.endSec.toFixed(3)}`),
	);
}

// ─── 3. margins around the cut ──────────────────────────────────────────────

export interface TrimMargin {
	trimId: string;
	startSec: number;
	endSec: number;
	/** The silence this trim was aiming at — the one it overlaps most. */
	silence: Span | null;
	/**
	 * `trim.start - silence.start`. Positive: the cut began INSIDE the silence
	 * and left that much of it in, i.e. it let the speech breathe. Negative: the
	 * cut began before the silence did, inside the preceding speech.
	 */
	leadMarginSec: number | null;
	/** `silence.end - trim.end`, same convention on the other edge. */
	tailMarginSec: number | null;
	/** Seconds of speech this single trim removed. */
	speechEatenSec: number;
}

const SAME_TRIM_SEC = 0.01;

/** Trims present in `after` that were not in `before`, matched on BOUNDS, not
 * ids. `replaceTimeline` used to re-mint every trim id (DSL-8); it now carries
 * them through, but a trim can still be narrowed to the kept intervals under
 * the same id, so bounds remain the only reliable identity here. */
export function addedTrims(before: AxcutDocument, after: AxcutDocument) {
	return after.timeline.trimRanges.filter(
		(trim) =>
			!before.timeline.trimRanges.some(
				(old) =>
					Math.abs(old.startSec - trim.startSec) < SAME_TRIM_SEC &&
					Math.abs(old.endSec - trim.endSec) < SAME_TRIM_SEC,
			),
	);
}

/**
 * Did the model cut to the millimetre, or did it leave the silence some room?
 *
 * Both extremes are worth seeing. A negative margin means the cut ate into
 * speech (the damage oracle will already be red). A margin of exactly 0 on both
 * edges, repeated over every trim, means the model transcribed the silence
 * boundaries it was handed instead of editing — which is what happens when the
 * transcript's silences are the tidy `[10, 12.5]` a fixture wrote, and which
 * would fall apart on a real transcript.
 */
export function trimMargins(before: AxcutDocument, after: AxcutDocument): TrimMargin[] {
	const silences = silenceSpans(before);
	const speech = speechSpans(before);
	return addedTrims(before, after).map((trim) => {
		const span: Span = { startSec: trim.startSec, endSec: trim.endSec };
		let best: Span | null = null;
		let bestOverlap = 0;
		for (const silence of silences) {
			const overlap = overlapSec(span, silence);
			if (overlap > bestOverlap) {
				best = silence;
				bestOverlap = overlap;
			}
		}
		return {
			trimId: trim.id,
			startSec: trim.startSec,
			endSec: trim.endSec,
			silence: best,
			leadMarginSec: best ? trim.startSec - best.startSec : null,
			tailMarginSec: best ? best.endSec - trim.endSec : null,
			speechEatenSec: totalSec(intersectSpans(speech, [span])),
		};
	});
}

// ─── 4. over-cut / under-cut ────────────────────────────────────────────────

export interface CutBalance {
	/** Silence that was playing before the turn. */
	silenceBeforeSec: number;
	/** …of which the turn removed. */
	silenceRemovedSec: number;
	/** …and left in. The under-cut. */
	silenceLeftSec: number;
	/** Removed material that was NOT silence. The over-cut. */
	overcutSec: number;
	removedSec: number;
	/** `silenceRemoved / silenceBefore`, 1 when there was no silence to cut. */
	coverage: number;
	/** `overcut / removed`, 0 when nothing was removed. The fraction of the
	 * scissors' work that landed on something other than a silence. */
	overcutRatio: number;
	/** `silenceLeft / silenceBefore`, 0 when there was no silence. */
	undercutRatio: number;
}

export function cutBalance(
	before: AxcutDocument,
	after: AxcutDocument,
	assetId?: string,
): CutBalance {
	const wanted = assetId ?? primaryAssetId(before);
	const kept = keptSourceSpans(before, wanted);
	const silence = intersectSpans(silenceSpans(before, wanted), kept);
	const removed = removedSourceSpans(before, after, wanted);
	const silenceRemovedSec = totalSec(intersectSpans(silence, removed));
	const silenceLeftSec = totalSec(subtractSpans(silence, removed));
	const removedSec = totalSec(removed);
	const overcutSec = totalSec(subtractSpans(removed, silence));
	const silenceBeforeSec = totalSec(silence);
	return {
		silenceBeforeSec,
		silenceRemovedSec,
		silenceLeftSec,
		overcutSec,
		removedSec,
		coverage: silenceBeforeSec > 0 ? silenceRemovedSec / silenceBeforeSec : 1,
		overcutRatio: removedSec > 0 ? overcutSec / removedSec : 0,
		undercutRatio: silenceBeforeSec > 0 ? silenceLeftSec / silenceBeforeSec : 0,
	};
}

// ─── 5. zoom hygiene and placement ──────────────────────────────────────────

/** A moment the edit is supposed to draw attention to, in source seconds.
 * Declared by a fixture; see `fixtures.fixtureTruth`. */
export interface InterestPoint {
	atSec: number;
	label: string;
	/** How far a zoom may sit from the point and still count as covering it. */
	toleranceSec?: number;
}

export type ZoomIssueKind =
	| "overlap"
	| "too-short"
	| "too-long"
	| "unmotivated"
	| "missed-interest";

export interface ZoomIssue {
	kind: ZoomIssueKind;
	ids: string[];
	detail: string;
}

/**
 * Shortest zoom that is not a flash: the app's own floor for a cursor dwell
 * worth zooming on (`zoom-suggestions.ts:11`, 450 ms). Below it the transition
 * has not finished before the region ends.
 */
export const MIN_ZOOM_SEC = 0.45;

/**
 * Longest zoom that is still emphasis. No app constant exists — this is a
 * workbench convention, and it is stated here rather than buried in a check so
 * a scenario can override it in one place. A zoom held past this stops being a
 * highlight and becomes the framing of the shot, which is a different edit than
 * the one the user asked for.
 */
export const MAX_ZOOM_SEC = 15;

/** …and the same idea in relative terms: a zoom covering most of the edit is
 * the edit. */
export const MAX_ZOOM_SHARE = 0.6;

export interface ZoomHygieneOptions {
	minSec?: number;
	maxSec?: number;
	maxShare?: number;
	interest?: InterestPoint[];
	/** Default tolerance for interest points that declare none. */
	toleranceSec?: number;
}

/** A zoom's span in SOURCE seconds — the anchor when it has one, the derived
 * RAW ms otherwise (`timelineMap.ts` treats the anchor as the truth and the ms
 * as a cache, so preferring the anchor is not a preference, it is the model). */
export function zoomSpans(document: AxcutDocument): Array<{ id: string; span: Span }> {
	return document.zoomRanges.map((zoom) => ({
		id: zoom.id,
		span: {
			startSec: zoom.sourceStartSec ?? zoom.startMs / 1000,
			endSec: zoom.sourceEndSec ?? zoom.endMs / 1000,
		},
	}));
}

export function zoomIssues(document: AxcutDocument, options: ZoomHygieneOptions = {}): ZoomIssue[] {
	const minSec = options.minSec ?? MIN_ZOOM_SEC;
	const maxSec = options.maxSec ?? MAX_ZOOM_SEC;
	const maxShare = options.maxShare ?? MAX_ZOOM_SHARE;
	const defaultTolerance = options.toleranceSec ?? 1;
	const issues: ZoomIssue[] = [];
	const spans = zoomSpans(document).sort((a, b) => a.span.startSec - b.span.startSec);

	// Overlap. This is not a taste call: `timelineMap.ts:113-115` states that two
	// regions of the same kind with different identities MAY NOT overlap, and an
	// edit clamps to its neighbour. Two overlapping zooms in a stored document
	// mean one of them is about to be silently clamped away.
	for (let i = 1; i < spans.length; i += 1) {
		const previous = spans[i - 1];
		const current = spans[i];
		const shared = overlapSec(previous.span, current.span);
		if (shared > SPAN_EPSILON_SEC) {
			issues.push({
				kind: "overlap",
				ids: [previous.id, current.id],
				detail: `${shared.toFixed(2)} s de chevauchement`,
			});
		}
	}

	const playedSec = totalSec(keptSourceSpans(document));
	for (const { id, span } of spans) {
		const durationSec = span.endSec - span.startSec;
		if (durationSec < minSec - SPAN_EPSILON_SEC) {
			issues.push({
				kind: "too-short",
				ids: [id],
				detail: `${durationSec.toFixed(2)} s < ${minSec} s`,
			});
		}
		const share = playedSec > 0 ? durationSec / playedSec : 0;
		if (durationSec > maxSec + SPAN_EPSILON_SEC) {
			issues.push({
				kind: "too-long",
				ids: [id],
				detail: `${durationSec.toFixed(2)} s > ${maxSec} s`,
			});
		} else if (share > maxShare) {
			issues.push({
				kind: "too-long",
				ids: [id],
				detail: `couvre ${(share * 100).toFixed(0)} % du montage`,
			});
		}
	}

	// Placement is only judgeable when the fixture says what matters. With no
	// declared interest points the oracle stays silent rather than inventing a
	// preference — the workbench has no opinion on where a zoom "should" go.
	const interest = options.interest ?? [];
	if (interest.length > 0) {
		for (const point of interest) {
			const tolerance = point.toleranceSec ?? defaultTolerance;
			const covered = spans.some(
				({ span }) =>
					point.atSec >= span.startSec - tolerance && point.atSec <= span.endSec + tolerance,
			);
			if (!covered) {
				issues.push({
					kind: "missed-interest",
					ids: [],
					detail: `${point.label} à ${point.atSec.toFixed(2)} s couvert par aucun zoom`,
				});
			}
		}
		for (const { id, span } of spans) {
			const motivated = interest.some((point) => {
				const tolerance = point.toleranceSec ?? defaultTolerance;
				return point.atSec >= span.startSec - tolerance && point.atSec <= span.endSec + tolerance;
			});
			if (!motivated) {
				issues.push({
					kind: "unmotivated",
					ids: [id],
					detail: `${span.startSec.toFixed(2)}–${span.endSec.toFixed(2)} s ne couvre aucun point d'intérêt`,
				});
			}
		}
	}
	return issues;
}

// ─── 6. did it do THAT, and nothing else ────────────────────────────────────

export type EditFamily = "clip" | "trim" | "zoom" | "annotation" | "speed" | "cameraFullscreen";

export interface FamilyDelta {
	family: EditFamily;
	added: string[];
	removed: string[];
	/** Same id, different content — a moved clip, a re-timed zoom. */
	changed: string[];
}

function stableJson(value: unknown): string {
	return JSON.stringify(value, (_key, item: unknown) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return item;
		const record = item as Record<string, unknown>;
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(record).sort()) sorted[key] = record[key];
		return sorted;
	});
}

function entitiesByFamily(document: AxcutDocument): Map<EditFamily, Map<string, string>> {
	const out = new Map<EditFamily, Map<string, string>>();
	const put = (family: EditFamily, items: Array<{ id: string } & object>) => {
		const map = new Map<string, string>();
		for (const item of items) map.set(item.id, stableJson(item));
		out.set(family, map);
	};
	put("clip", document.timeline.clips);
	put("trim", document.timeline.trimRanges);
	for (const family of regionFamilies(document)) {
		put(family.kind as EditFamily, family.regions);
	}
	return out;
}

/** What changed between two documents, per family. Families with no change are
 * omitted, so an empty array means "the turn touched nothing". */
export function documentDelta(before: AxcutDocument, after: AxcutDocument): FamilyDelta[] {
	const left = entitiesByFamily(before);
	const right = entitiesByFamily(after);
	const deltas: FamilyDelta[] = [];
	for (const [family, beforeMap] of left) {
		const afterMap = right.get(family) ?? new Map<string, string>();
		const added = [...afterMap.keys()].filter((id) => !beforeMap.has(id));
		const removed = [...beforeMap.keys()].filter((id) => !afterMap.has(id));
		const changed = [...beforeMap.entries()]
			.filter(([id, json]) => afterMap.has(id) && afterMap.get(id) !== json)
			.map(([id]) => id);
		if (added.length + removed.length + changed.length > 0) {
			deltas.push({ family, added, removed, changed });
		}
	}
	return deltas;
}

export interface EditScope {
	/** Families the request licenses the agent to touch. */
	families: EditFamily[];
}

/**
 * "Did it do what was asked AND NOTHING MORE."
 *
 * The scenario states which families its prompt licenses; anything else the
 * document gained, lost or changed is collateral. This is the deterministic
 * form of the failure that cost the most in the baseline: asked to swap two
 * clips, the model destroyed a trim the user had placed and announced it as
 * preserved. `dsl.trims.preserved` catches that one case because someone
 * thought to write it; this catches the whole class, including the families
 * nobody thought to write a check for (the two `legacyEditor` collections that
 * the SCHEMA does not validate either).
 */
export function outOfScopeEdits(
	before: AxcutDocument,
	after: AxcutDocument,
	scope: EditScope,
): FamilyDelta[] {
	const allowed = new Set(scope.families);
	return documentDelta(before, after).filter((delta) => !allowed.has(delta.family));
}

/** Mutating calls to tools outside the ones the request licenses. Complements
 * `outOfScopeEdits`: a destructive call whose effect happens to be invisible in
 * the document is still an operation nobody asked for. */
export function outOfScopeCalls<T extends { name: string; mutating: boolean }>(
	calls: T[],
	allowedTools: string[],
): T[] {
	const allowed = new Set(allowedTools);
	return calls.filter((call) => call.mutating && !allowed.has(call.name));
}
