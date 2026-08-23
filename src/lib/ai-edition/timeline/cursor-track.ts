// The recorded cursor track the agent reads: where the pointer was, when, and
// what shape it had. Pure — no fs, no IPC. The caller supplies the samples.
//
// ponytail: this is an OBSERVATION, not an interpretation, and the distinction
// is the whole point of the module. Its predecessor handed the model a list of
// "dwell moments" computed by the same stillness detector that drives the magic
// wand. That reads as helpful and is not: it caps the model at the detector's
// recall. Measured on a real 66s screencast, the detector reports 6 of 6
// annotated interest zones but 8 false positives out of 16 — and it is blind by
// construction to the one zone where the user traced slowly across an image
// while narrating, because the cursor genuinely travelled 30% of the frame. A
// model fed that digest can never zoom there, however good it is. So the wand
// keeps its detector, the model gets the track, and the bench compares them.
//
// Downsampling is resolution, not interpretation: every kept point is a real
// sample, nothing is summarised, and every pointer-shape change survives the
// reduction because a shape change is an observed event, not a verdict about it.

import type { AxcutClip, AxcutTrimRange } from "../schema";
import { locateSourcePosition } from "./virtual-preview";

/**
 * Structurally compatible with `CursorRecordingSample` (src/native/contracts).
 * Declared locally so this module — which the Electron main process imports over
 * a relative path — never depends on the `@/` alias it cannot resolve.
 */
export interface CursorTrackSample {
	timeMs: number;
	cx: number;
	cy: number;
	/** The cursor BITMAP's id, not a media asset: the sidecar stores one entry per
	 *  distinct pointer image (arrow, hand, text caret, resize…). A change means the
	 *  pointer shape changed, which is why these points are never dropped. */
	assetId?: string | null;
	interactionType?: string | null;
}

export interface CursorTrackPoint {
	/** SOURCE seconds of the asset — the recording's own clock. */
	atSec: number;
	/** The same instant on the edited timeline, the coordinate addZoom takes. Null
	 *  when no clip carries it. ABSENT when it equals `atSec` on every point — the
	 *  envelope's `virtualEqualsSource` says so once instead of per row. */
	virtualSec?: number | null;
	cx: number;
	cy: number;
	/** Small stable index per distinct pointer shape within THIS track. Absent when
	 *  the recording carries no shape information. */
	shape?: number;
	/** Present only when the sample is not a plain move. */
	kind?: string;
	/** Present only when a trim cuts this instant out of playback. */
	trimmed?: true;
}

export interface CursorTrack {
	assetId: string;
	/** Samples in the recording, before downsampling. */
	sampleCount: number;
	/** Points actually returned. */
	pointCount: number;
	/** Resolution of what is returned, in samples per second. */
	hz: number;
	coveredSec: number;
	/** How many distinct pointer shapes the recording used. */
	shapeCount: number;
	/** True when maxPoints forced a coarser rate than `hz` would give. */
	truncated: boolean;
	/** Present ONLY when the ceiling did not hold. `maxPoints` budgets the rate and
	 *  the gap floor; the MANDATORY points are exempt and stack on top — the first
	 *  and last sample, a pointer-shape change, a non-move event, the ends of a run
	 *  longer than the max gap — so a capture rich in them lands above the ceiling.
	 *  Absent means the budget held. It is a separate field from `truncated` on
	 *  purpose: that one says "you are seeing less than you asked for", this one
	 *  says the opposite. */
	overBudget?: string;
	/** When true, every point's virtual-timeline position equals its `atSec`, and
	 *  `virtualSec` is omitted from the points. Goes false as soon as a clip is
	 *  moved, cut or reordered and the two axes diverge. */
	virtualEqualsSource: boolean;
	timeBase: string;
	points: CursorTrackPoint[];
}

/** 5 Hz keeps a slow traverse legible (a 5s sweep is 25 points) while a minute
 *  of capture stays around 300 points. Shape changes are added on top. */
export const DEFAULT_TRACK_HZ = 5;
/** A ceiling, not a target: long recordings drop to a coarser rate rather than
 *  returning a list nobody can read. */
export const DEFAULT_MAX_TRACK_POINTS = 400;
/** Movement, in frame fractions, below which a sample says nothing the previous one
 *  did not. 2% of the frame is under a finger's width on a 1080p capture. */
export const DEFAULT_TRACK_EPSILON = 0.02;
/** However still the pointer is, report it at least this often — a gap in the track
 *  should read as "parked", never as "no data". */
export const DEFAULT_TRACK_MAX_GAP_SEC = 3;

/**
 * Douglas–Peucker on ONE time-series — x(t) or y(t) — between two anchors: keep the
 * sample whose value deviates most from the straight line joining the ends, recurse,
 * stop below `eps`. Iterative: a long capture is tens of thousands of samples and the
 * recursive form blows the stack on a path with no clear split.
 *
 * ponytail: per-axis against TIME, not the (x,y) path. Simplifying the path itself is
 * the obvious move and it is wrong for a keyframe reduction — perpendicular distance
 * to the chord ignores WHEN the pointer was where. A cursor that runs out and back
 * along the same line deviates from that chord by nothing, so the whole excursion
 * collapses and interpolation then swears the pointer never moved. Measured on a real
 * screencast: path-space simplification reconstructed to 0.380 of the frame at a 0.02
 * tolerance — nineteen times the budget, and silently. Per-axis bounds the error at
 * every instant, which is the only claim worth making.
 */
function simplifyAxis(
	pts: Array<{ timeMs: number }>,
	value: (i: number) => number,
	from: number,
	to: number,
	eps: number,
	kept: Set<number>,
): void {
	const stack: Array<[number, number]> = [[from, to]];
	while (stack.length) {
		const [lo, hi] = stack.pop() as [number, number];
		if (hi - lo < 2) continue;
		const t0 = pts[lo].timeMs;
		const span = pts[hi].timeMs - t0;
		const v0 = value(lo);
		const dv = value(hi) - v0;
		let worst = 0;
		let worstAt = -1;
		for (let i = lo + 1; i < hi; i += 1) {
			const k = span === 0 ? 0 : (pts[i].timeMs - t0) / span;
			const d = Math.abs(value(i) - (v0 + k * dv));
			if (d > worst) {
				worst = d;
				worstAt = i;
			}
		}
		if (worst > eps && worstAt >= 0) {
			kept.add(worstAt);
			stack.push([lo, worstAt], [worstAt, hi]);
		}
	}
}

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}

function round3(value: number): number {
	return Math.round(value * 1000) / 1000;
}

export interface CursorTrackOptions {
	assetId: string;
	samples: CursorTrackSample[];
	/** Source duration of the asset, used to clamp stray timestamps. */
	durationSec: number;
	clips: AxcutClip[];
	trimRanges?: AxcutTrimRange[];
	hz?: number;
	maxPoints?: number;
	/** Movement threshold in frame fractions; see DEFAULT_TRACK_EPSILON. */
	epsilon?: number;
	/** Longest silence in the track; see DEFAULT_TRACK_MAX_GAP_SEC. */
	maxGapSec?: number;
}

export function buildCursorTrack(options: CursorTrackOptions): CursorTrack {
	const { assetId, samples, durationSec, clips } = options;
	const trimRanges = options.trimRanges ?? [];
	const maxPoints = options.maxPoints ?? DEFAULT_MAX_TRACK_POINTS;
	const ceilingMs = Math.max(0, durationSec) * 1000 || Number.POSITIVE_INFINITY;

	const ordered = samples
		.filter((s) => Number.isFinite(s.timeMs) && Number.isFinite(s.cx) && Number.isFinite(s.cy))
		.map((s) => ({ ...s, timeMs: Math.max(0, Math.min(s.timeMs, ceilingMs)) }))
		.sort((a, b) => a.timeMs - b.timeMs);

	// Shape ids are opaque hashes; the model has no use for 64 hex chars, only for
	// "this is a different pointer than the previous one". Index them in order of
	// first appearance so the numbering is stable and readable.
	const shapeIndex = new Map<string, number>();
	for (const s of ordered) {
		if (typeof s.assetId === "string" && s.assetId && !shapeIndex.has(s.assetId)) {
			shapeIndex.set(s.assetId, shapeIndex.size);
		}
	}

	const coveredSec = ordered.length ? round2(ordered[ordered.length - 1].timeMs / 1000) : 0;

	// The rate can only get coarser: asking for 5 Hz over a 40-minute capture would
	// blow the ceiling, so the ceiling wins and `truncated` says so.
	//
	// ponytail: no floor on the derived rate. A `Math.max(1, …)` here reads as a
	// sanity guard and silently defeats the ceiling — 2400 s of capture at a
	// 400-point budget needs 0.17 Hz, and clamping that to 1 Hz returns 2400
	// points, six times the budget. A point every six seconds is the honest
	// answer for a recording that long; `truncated` is how the model learns it.
	// The budget is spent in two places, and they are settled in order. The gap floor
	// is charged first — it is what makes a parked pointer legible at all — and
	// movement gets what is left.
	//
	// ponytail: when the floor ALONE exceeds the budget (a 40-minute capture at one
	// point every 3s wants 800 rows for 400), the gap has to widen. An earlier version
	// wrote `… || wantedHz` here as a divide-by-zero guard, which did the opposite of
	// its job: with no movement budget left it fell back to the FULL requested rate,
	// so the ceiling raised the count instead of capping it.
	const wantedHz = options.hz ?? DEFAULT_TRACK_HZ;
	const spanSec = coveredSec || 1;
	let maxGapMs = (options.maxGapSec ?? DEFAULT_TRACK_MAX_GAP_SEC) * 1000;
	let floorPoints = Math.ceil(spanSec / (maxGapMs / 1000));
	let widened = false;
	if (floorPoints > maxPoints) {
		maxGapMs = (spanSec / maxPoints) * 1000;
		floorPoints = maxPoints;
		widened = true;
	}
	const hz = Math.min(wantedHz, Math.max(0, maxPoints - floorPoints) / spanSec);
	const truncated = widened || hz < wantedHz;
	const minIntervalMs = hz > 0 ? 1000 / hz : Number.POSITIVE_INFINITY;

	// ponytail: adaptive, not a fixed grid — a point is emitted when the pointer has
	// MOVED, and otherwise at most every `maxGapMs`. This is compression, not
	// interpretation: nothing is labelled interesting, the redundancy is simply not
	// repeated. A grid spends its budget uniformly, so a cursor parked for 9.6s costs
	// 48 near-identical rows while a slow traverse gets the same density as the parking.
	// Measured on a 66s screencast: 356 grid points (23.1 kB) → 288 adaptive (13.4 kB),
	// and at a tighter epsilon the SAME total budget puts 30 points on the traverse
	// instead of 24. Same signal, spent where something happens.
	// KEYFRAMES, in the animation sense: keep the points the motion turns on, drop the
	// in-betweens that linear interpolation puts back. This is Douglas–Peucker over the
	// pointer path — recursively keep the sample furthest from the chord joining the two
	// already-kept ends, until nothing deviates by more than `epsilon`.
	//
	// ponytail: distance to the CHORD, not to the previous kept point. A "moved more than
	// epsilon since the last one" rule looks equivalent and is not: a straight slow sweep
	// crosses epsilon over and over and bills a point each time, when two would rebuild it
	// exactly. Measured on a real 66s screencast, that difference is the bulk of the
	// saving — 356 grid points → 170. A parked pointer collapses for the same reason: the
	// chord through a stationary run is a point, so every in-between lies on it.
	//
	// Three things outrank the tolerance and are never dropped, because no interpolation
	// puts them back: a pointer-shape change, a non-move event, and the ends of a run
	// longer than `maxGapMs` (a parked cursor must read as "still here", never as missing
	// data). `minIntervalMs` then caps the rate so a thrashing pointer cannot spend the
	// whole budget in one second.
	const eps = options.epsilon ?? DEFAULT_TRACK_EPSILON;
	const mandatory = new Set<number>();
	if (ordered.length) {
		mandatory.add(0);
		mandatory.add(ordered.length - 1);
	}
	let lastShape: string | null | undefined = ordered[0]?.assetId;
	let lastMandatoryMs = ordered[0]?.timeMs ?? 0;
	for (let i = 0; i < ordered.length; i += 1) {
		const s = ordered[i];
		const shapeChanged = s.assetId !== lastShape && shapeIndex.size > 1;
		const notAMove = typeof s.interactionType === "string" && s.interactionType !== "move";
		const stale = s.timeMs - lastMandatoryMs >= maxGapMs;
		if (shapeChanged || notAMove || stale) {
			mandatory.add(i);
			lastMandatoryMs = s.timeMs;
			lastShape = s.assetId;
		}
	}

	// Both axes, union of what each needs: a horizontal sweep is all in x, a vertical
	// one all in y, and keeping either axis' keyframes for both costs nothing.
	const kept = new Set<number>(mandatory);
	const anchors = [...mandatory].sort((a, b) => a - b);
	for (let a = 0; a < anchors.length - 1; a += 1) {
		simplifyAxis(ordered, (i) => ordered[i].cx, anchors[a], anchors[a + 1], eps, kept);
		simplifyAxis(ordered, (i) => ordered[i].cy, anchors[a], anchors[a + 1], eps, kept);
	}

	// Rate ceiling, applied last so it can never drop a mandatory point.
	const keep: CursorTrackSample[] = [];
	let lastEmittedMs = Number.NEGATIVE_INFINITY;
	for (const i of [...kept].sort((a, b) => a - b)) {
		const s = ordered[i];
		if (mandatory.has(i) || s.timeMs - lastEmittedMs >= minIntervalMs) {
			keep.push(s);
			lastEmittedMs = s.timeMs;
		}
	}

	// ponytail: `virtualSec` is emitted per point ONLY when it differs from `atSec`.
	// A single clip laid down whole makes the two identical on every row — 28% of the
	// payload restating the timestamp next to itself, which on a 66s capture was 6.6 kB
	// of pure repetition. `virtualEqualsSource` on the envelope says so once, and the
	// field reappears per point the moment a clip is moved, cut or reordered and the
	// two axes diverge. The model still gets the coordinate addZoom takes; it just is
	// not told twice.
	const shifted = keep.some((s) => {
		const atSec = s.timeMs / 1000;
		const position = locateSourcePosition(clips, atSec, assetId);
		return !position || Math.abs(position.virtualTimeSec - atSec) > 0.005;
	});

	const points = keep.map((s) => {
		const atSec = s.timeMs / 1000;
		// `locateSourcePosition` is the existing source→virtual mapping, exact here
		// because trims do NOT compact the document's virtual axis — a trim is a hole
		// in playback, not a shortening of the ruler (see timeline/trim-mapping.ts).
		const position = locateSourcePosition(clips, atSec, assetId);
		const point: CursorTrackPoint = {
			atSec: round2(atSec),
			cx: round3(s.cx),
			cy: round3(s.cy),
		};
		if (shifted) point.virtualSec = position ? round2(position.virtualTimeSec) : null;
		const shape = typeof s.assetId === "string" ? shapeIndex.get(s.assetId) : undefined;
		if (shape !== undefined && shapeIndex.size > 1) point.shape = shape;
		if (typeof s.interactionType === "string" && s.interactionType !== "move") {
			point.kind = s.interactionType;
		}
		if (trimRanges.some((t) => t.assetId === assetId && atSec >= t.startSec && atSec <= t.endSec)) {
			point.trimmed = true;
		}
		return point;
	});

	// ponytail: the ceiling is soft, and saying so is the whole point. `maxPoints`
	// is spent on the gap floor and the rate above it; the mandatory points are
	// added afterwards and answer to neither. Charging them to the budget instead
	// would mean dropping a shape change to stay under it, which is the one thing
	// this track must never do — so the overflow is reported rather than prevented.
	// The field is absent when the budget held, so the common payload is unchanged.
	const overBudget =
		points.length > maxPoints
			? `${points.length} points for a ceiling of ${maxPoints}: the mandatory points are ` +
				`never dropped — the first and last sample, pointer-shape changes, non-move ` +
				`events and the ends of a parked run — and this recording has enough of them ` +
				`to land above the budget.`
			: undefined;

	return {
		assetId,
		sampleCount: samples.length,
		pointCount: points.length,
		hz: round2(hz),
		coveredSec,
		shapeCount: shapeIndex.size,
		truncated,
		...(overBudget ? { overBudget } : {}),
		virtualEqualsSource: !shifted,
		timeBase:
			"atSec is SOURCE time of the asset (the recording's own clock). virtualSec is the same " +
			"instant on the edited timeline — that is the coordinate addZoom takes; when " +
			"virtualEqualsSource is true the two are identical everywhere and virtualSec is left off " +
			"the points. A null virtualSec means no clip carries that moment; trimmed:true means a " +
			"trim cuts it out of " +
			"playback, so a zoom there would never be seen. `shape` is an index into the pointer " +
			"bitmaps this recording used: equal values are the same pointer, a change is a change.",
		points,
	};
}
