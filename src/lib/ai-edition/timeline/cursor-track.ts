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
	/** The same instant on the edited timeline, the coordinate addZoom takes.
	 *  Null when no clip currently carries it. */
	virtualSec: number | null;
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
	timeBase: string;
	points: CursorTrackPoint[];
}

/** 5 Hz keeps a slow traverse legible (a 5s sweep is 25 points) while a minute
 *  of capture stays around 300 points. Shape changes are added on top. */
export const DEFAULT_TRACK_HZ = 5;
/** A ceiling, not a target: long recordings drop to a coarser rate rather than
 *  returning a list nobody can read. */
export const DEFAULT_MAX_TRACK_POINTS = 400;

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
	const wantedHz = options.hz ?? DEFAULT_TRACK_HZ;
	const spanSec = coveredSec || 1;
	const hz = Math.min(wantedHz, maxPoints / spanSec);
	const truncated = hz < wantedHz;
	const stepMs = 1000 / hz;

	const keep: CursorTrackSample[] = [];
	let nextTickMs = 0;
	let lastShape: string | null | undefined;
	for (const s of ordered) {
		const shapeChanged = s.assetId !== lastShape && shapeIndex.size > 1;
		const isTick = s.timeMs >= nextTickMs;
		const notAMove = typeof s.interactionType === "string" && s.interactionType !== "move";
		if (isTick || shapeChanged || notAMove) {
			keep.push(s);
			if (isTick) nextTickMs = s.timeMs + stepMs;
			lastShape = s.assetId;
		}
	}

	const points = keep.map((s) => {
		const atSec = s.timeMs / 1000;
		// `locateSourcePosition` is the existing source→virtual mapping, exact here
		// because trims do NOT compact the document's virtual axis — a trim is a hole
		// in playback, not a shortening of the ruler (see timeline/trim-mapping.ts).
		const position = locateSourcePosition(clips, atSec, assetId);
		const point: CursorTrackPoint = {
			atSec: round2(atSec),
			virtualSec: position ? round2(position.virtualTimeSec) : null,
			cx: round3(s.cx),
			cy: round3(s.cy),
		};
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

	return {
		assetId,
		sampleCount: samples.length,
		pointCount: points.length,
		hz: round2(hz),
		coveredSec,
		shapeCount: shapeIndex.size,
		truncated,
		timeBase:
			"atSec is SOURCE time of the asset (the recording's own clock). virtualSec is the same " +
			"instant on the edited timeline — that is the coordinate addZoom takes. A null virtualSec " +
			"means no clip currently carries that moment; trimmed:true means a trim cuts it out of " +
			"playback, so a zoom there would never be seen. `shape` is an index into the pointer " +
			"bitmaps this recording used: equal values are the same pointer, a change is a change.",
		points,
	};
}
