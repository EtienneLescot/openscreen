export const CURSOR_MOTION_PRESETS = [
	"recorded",
	"straight",
	"arc",
	"wave",
	"loop",
	"overshoot",
] as const;

export type CursorMotionPreset = (typeof CURSOR_MOTION_PRESETS)[number];

export const CURSOR_MOTION_EASINGS = ["linear", "ease-in", "ease-out", "ease-in-out"] as const;

export type CursorMotionEasing = (typeof CURSOR_MOTION_EASINGS)[number];

export const CURSOR_MOTION_ANCHORS = ["manual", "rest", "click"] as const;

export type CursorMotionAnchor = (typeof CURSOR_MOTION_ANCHORS)[number];

export const CURSOR_MOTION_SEGMENT_KINDS = ["move", "hold"] as const;

export type CursorMotionSegmentKind = (typeof CURSOR_MOTION_SEGMENT_KINDS)[number];

export interface CursorMotionPoint {
	cx: number;
	cy: number;
}

export interface CursorMotionCropRegion {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface CursorMotionOwner {
	clipId: string;
	assetId: string;
}

export interface CursorMotionTelemetrySample extends CursorMotionPoint {
	timeMs: number;
	visible?: boolean;
	interactionType?: string | null;
}

export interface CursorMotionPath {
	sampleAtSourceTime(sourceTimeMs: number): CursorMotionPoint | null;
}

export interface CursorMotionRegion extends CursorMotionOwner {
	id: string;
	startMs: number;
	endMs: number;
	sourceStartMs: number;
	sourceEndMs: number;
	startPoint: CursorMotionPoint;
	endPoint: CursorMotionPoint;
	controlPoints: CursorMotionPoint[];
	startAnchor: CursorMotionAnchor;
	endAnchor: CursorMotionAnchor;
	segmentKind: CursorMotionSegmentKind;
	preset: CursorMotionPreset;
	speed: number;
	cycles: number;
	easing: CursorMotionEasing;
}

export type CursorMotionRegionDraft = Omit<CursorMotionRegion, "id">;

export const CURSOR_MOTION_SPEED_MIN = 1;
export const CURSOR_MOTION_SPEED_MAX = 4;
export const DEFAULT_CURSOR_MOTION_SPEED = 1;
export const CURSOR_MOTION_CYCLES_MIN = 1;
export const CURSOR_MOTION_CYCLES_MAX = 6;

const REST_MIN_DURATION_MS = 300;
const REST_MAX_DIAMETER = 0.009;
const REST_MAX_SAMPLE_GAP_MS = 150;
const MIN_SEGMENT_DURATION_MS = 2;

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export function clampCursorMotionPoint(point: CursorMotionPoint): CursorMotionPoint {
	return {
		cx: clamp(Number.isFinite(point.cx) ? point.cx : 0.5, 0, 1),
		cy: clamp(Number.isFinite(point.cy) ? point.cy : 0.5, 0, 1),
	};
}

export function projectCursorMotionPointToCrop(
	point: CursorMotionPoint,
	crop: CursorMotionCropRegion,
): CursorMotionPoint | null {
	if (
		!Number.isFinite(point.cx) ||
		!Number.isFinite(point.cy) ||
		!Number.isFinite(crop.x) ||
		!Number.isFinite(crop.y) ||
		!Number.isFinite(crop.width) ||
		!Number.isFinite(crop.height) ||
		crop.width <= 0 ||
		crop.height <= 0
	) {
		return null;
	}
	const right = crop.x + crop.width;
	const bottom = crop.y + crop.height;
	if (point.cx < crop.x || point.cx > right || point.cy < crop.y || point.cy > bottom) {
		return null;
	}
	if (crop.x === 0 && crop.y === 0 && crop.width === 1 && crop.height === 1) return point;
	return {
		cx: point.cx === crop.x ? 0 : point.cx === right ? 1 : (point.cx - crop.x) / crop.width,
		cy: point.cy === crop.y ? 0 : point.cy === bottom ? 1 : (point.cy - crop.y) / crop.height,
	};
}

export function unprojectCursorMotionPointFromCrop(
	point: CursorMotionPoint,
	crop: CursorMotionCropRegion,
): CursorMotionPoint | null {
	if (
		!Number.isFinite(point.cx) ||
		!Number.isFinite(point.cy) ||
		!Number.isFinite(crop.x) ||
		!Number.isFinite(crop.y) ||
		!Number.isFinite(crop.width) ||
		!Number.isFinite(crop.height) ||
		crop.width <= 0 ||
		crop.height <= 0
	) {
		return null;
	}
	if (crop.x === 0 && crop.y === 0 && crop.width === 1 && crop.height === 1) {
		return clampCursorMotionPoint(point);
	}
	return clampCursorMotionPoint({
		cx: crop.x + clamp(point.cx, 0, 1) * crop.width,
		cy: crop.y + clamp(point.cy, 0, 1) * crop.height,
	});
}

export function clampCursorMotionSpeed(speed: number | null | undefined): number {
	if (!Number.isFinite(speed)) return DEFAULT_CURSOR_MOTION_SPEED;
	return (
		Math.round(clamp(Number(speed), CURSOR_MOTION_SPEED_MIN, CURSOR_MOTION_SPEED_MAX) * 10) / 10
	);
}

export function clampCursorMotionCycles(cycles: number | null | undefined): number {
	if (!Number.isFinite(cycles)) return CURSOR_MOTION_CYCLES_MIN;
	return clamp(Math.round(Number(cycles)), CURSOR_MOTION_CYCLES_MIN, CURSOR_MOTION_CYCLES_MAX);
}

export function applyCursorMotionSpeed(progress: number, speed: number | null | undefined): number {
	const t = clamp(progress, 0, 1);
	return 1 - (1 - t) ** clampCursorMotionSpeed(speed);
}

function applyCursorMotionEasing(progress: number, easing: CursorMotionEasing): number {
	const t = clamp(progress, 0, 1);
	switch (easing) {
		case "ease-in":
			return t ** 3;
		case "ease-out":
			return 1 - (1 - t) ** 3;
		case "ease-in-out":
			return t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
		default:
			return t;
	}
}

function lerp(a: number, b: number, progress: number): number {
	return a + (b - a) * progress;
}

function cubicBezier(
	start: number,
	firstControl: number,
	secondControl: number,
	end: number,
	progress: number,
): number {
	const inverse = 1 - progress;
	return (
		inverse ** 3 * start +
		3 * inverse ** 2 * progress * firstControl +
		3 * inverse * progress ** 2 * secondControl +
		progress ** 3 * end
	);
}

function easeOutBack(progress: number): number {
	const overshoot = 1.70158;
	const t = clamp(progress, 0, 1) - 1;
	return 1 + (overshoot + 1) * t ** 3 + overshoot * t ** 2;
}

export function createDefaultCursorMotionControlPoint(
	start: CursorMotionPoint,
	end: CursorMotionPoint,
): CursorMotionPoint {
	const dx = end.cx - start.cx;
	const dy = end.cy - start.cy;
	const distance = Math.hypot(dx, dy);
	const normalX = distance > 0.0001 ? dy / distance : 0;
	const normalY = distance > 0.0001 ? -dx / distance : -1;
	const amplitude = clamp(distance * 0.35, 0.06, 0.18);
	return clampCursorMotionPoint({
		cx: (start.cx + end.cx) / 2 + normalX * amplitude,
		cy: (start.cy + end.cy) / 2 + normalY * amplitude,
	});
}

function cursorMotionControlOffset(region: CursorMotionRegion): CursorMotionPoint {
	const fallback = createDefaultCursorMotionControlPoint(region.startPoint, region.endPoint);
	const controls = region.controlPoints.length > 0 ? region.controlPoints : [fallback];
	const control = controls.reduce(
		(sum, point) => ({ cx: sum.cx + point.cx, cy: sum.cy + point.cy }),
		{ cx: 0, cy: 0 },
	);
	const midpoint = {
		cx: (region.startPoint.cx + region.endPoint.cx) / 2,
		cy: (region.startPoint.cy + region.endPoint.cy) / 2,
	};
	return {
		cx: control.cx / controls.length - midpoint.cx,
		cy: control.cy / controls.length - midpoint.cy,
	};
}

export function sampleCursorMotionRegion(
	region: CursorMotionRegion,
	sourceTimeMs: number,
): CursorMotionPoint {
	const durationMs = Math.max(Number.EPSILON, region.sourceEndMs - region.sourceStartMs);
	const rawProgress = clamp((sourceTimeMs - region.sourceStartMs) / durationMs, 0, 1);
	if (rawProgress === 0) return region.startPoint;
	if (rawProgress === 1) return region.endPoint;

	const motionProgress = applyCursorMotionSpeed(rawProgress, region.speed);
	const progress = applyCursorMotionEasing(motionProgress, region.easing);
	const offset = cursorMotionControlOffset(region);
	const base = {
		cx: lerp(region.startPoint.cx, region.endPoint.cx, progress),
		cy: lerp(region.startPoint.cy, region.endPoint.cy, progress),
	};
	const envelope = Math.sin(Math.PI * motionProgress);
	const cycles = clampCursorMotionCycles(region.cycles);

	let point: CursorMotionPoint;
	switch (region.preset) {
		case "arc": {
			const first = region.controlPoints[0];
			const second = region.controlPoints[1];
			point =
				first && second
					? {
							cx: cubicBezier(
								region.startPoint.cx,
								first.cx,
								second.cx,
								region.endPoint.cx,
								progress,
							),
							cy: cubicBezier(
								region.startPoint.cy,
								first.cy,
								second.cy,
								region.endPoint.cy,
								progress,
							),
						}
					: { cx: base.cx + offset.cx * envelope, cy: base.cy + offset.cy * envelope };
			break;
		}
		case "wave": {
			const wave = Math.sin(Math.PI * 2 * cycles * motionProgress) * envelope;
			point = { cx: base.cx + offset.cx * wave, cy: base.cy + offset.cy * wave };
			break;
		}
		case "loop": {
			const phase = Math.PI * 2 * cycles * motionProgress;
			const tangentOffset = Math.sin(phase) * envelope;
			const normalOffset = ((1 - Math.cos(phase)) / 2) * envelope;
			point = {
				cx: base.cx + offset.cx * tangentOffset - offset.cy * normalOffset,
				cy: base.cy + offset.cy * tangentOffset + offset.cx * normalOffset,
			};
			break;
		}
		case "overshoot": {
			const overshootProgress = easeOutBack(progress);
			point = {
				cx:
					lerp(region.startPoint.cx, region.endPoint.cx, overshootProgress) +
					offset.cx * envelope * 0.35,
				cy:
					lerp(region.startPoint.cy, region.endPoint.cy, overshootProgress) +
					offset.cy * envelope * 0.35,
			};
			break;
		}
		default:
			point = base;
	}
	return clampCursorMotionPoint(point);
}

export function findCursorMotionRegionAtSourceTime(
	regions: readonly CursorMotionRegion[],
	owner: CursorMotionOwner,
	sourceTimeMs: number,
): CursorMotionRegion | null {
	for (let index = regions.length - 1; index >= 0; index -= 1) {
		const region = regions[index];
		if (
			region.clipId === owner.clipId &&
			region.assetId === owner.assetId &&
			sourceTimeMs >= region.sourceStartMs &&
			sourceTimeMs < region.sourceEndMs
		) {
			return region;
		}
	}
	return null;
}

export function sampleCursorMotion(options: {
	path: CursorMotionPath | null | undefined;
	regions: readonly CursorMotionRegion[];
	owner: CursorMotionOwner;
	sourceTimeMs: number;
}): CursorMotionPoint | null {
	const recorded = options.path?.sampleAtSourceTime(options.sourceTimeMs) ?? null;
	if (!recorded) return null;
	const region = findCursorMotionRegionAtSourceTime(
		options.regions,
		options.owner,
		options.sourceTimeMs,
	);
	if (!region || region.preset === "recorded") return recorded;
	return sampleCursorMotionRegion(region, options.sourceTimeMs);
}

interface CursorMotionRestSpan {
	startMs: number;
	endMs: number;
	point: CursorMotionPoint;
}

interface CursorMotionBuilderAnchor {
	timeMs: number;
	point: CursorMotionPoint;
	kind: CursorMotionAnchor;
}

function isClickInteraction(interactionType: string | null | undefined): boolean {
	return (
		interactionType === "click" ||
		interactionType === "double-click" ||
		interactionType === "right-click" ||
		interactionType === "middle-click"
	);
}

function normalizeTelemetrySamples(
	samples: readonly CursorMotionTelemetrySample[],
): CursorMotionTelemetrySample[] {
	return samples
		.filter(
			(sample) =>
				sample.visible !== false &&
				Number.isFinite(sample.timeMs) &&
				Number.isFinite(sample.cx) &&
				Number.isFinite(sample.cy),
		)
		.map((sample) => ({ ...sample, ...clampCursorMotionPoint(sample) }))
		.sort((a, b) => a.timeMs - b.timeMs);
}

function detectCursorMotionRestSpans(
	samples: readonly CursorMotionTelemetrySample[],
): CursorMotionRestSpan[] {
	const rests: CursorMotionRestSpan[] = [];
	let startIndex = 0;
	while (startIndex < samples.length - 1) {
		let endIndex = startIndex + 1;
		let minCx = samples[startIndex].cx;
		let maxCx = minCx;
		let minCy = samples[startIndex].cy;
		let maxCy = minCy;
		while (endIndex < samples.length) {
			const sample = samples[endIndex];
			if (sample.timeMs - samples[endIndex - 1].timeMs > REST_MAX_SAMPLE_GAP_MS) break;
			const nextMinCx = Math.min(minCx, sample.cx);
			const nextMaxCx = Math.max(maxCx, sample.cx);
			const nextMinCy = Math.min(minCy, sample.cy);
			const nextMaxCy = Math.max(maxCy, sample.cy);
			if (Math.hypot(nextMaxCx - nextMinCx, nextMaxCy - nextMinCy) > REST_MAX_DIAMETER) {
				break;
			}
			minCx = nextMinCx;
			maxCx = nextMaxCx;
			minCy = nextMinCy;
			maxCy = nextMaxCy;
			endIndex += 1;
		}

		const run = samples.slice(startIndex, endIndex);
		if (run.at(-1)!.timeMs - run[0].timeMs >= REST_MIN_DURATION_MS) {
			const click = run.find((sample) => isClickInteraction(sample.interactionType));
			const point = click
				? clampCursorMotionPoint(click)
				: clampCursorMotionPoint({
						cx: run.reduce((total, sample) => total + sample.cx, 0) / run.length,
						cy: run.reduce((total, sample) => total + sample.cy, 0) / run.length,
					});
			rests.push({ startMs: run[0].timeMs, endMs: run.at(-1)!.timeMs, point });
			startIndex = endIndex;
		} else {
			startIndex += 1;
		}
	}
	return rests;
}

function nearestSamplePoint(
	samples: readonly CursorMotionTelemetrySample[],
	timeMs: number,
): CursorMotionPoint | null {
	let nearest: CursorMotionTelemetrySample | null = null;
	let distance = Number.POSITIVE_INFINITY;
	for (const sample of samples) {
		const candidateDistance = Math.abs(sample.timeMs - timeMs);
		if (candidateDistance < distance) {
			nearest = sample;
			distance = candidateDistance;
		}
	}
	return nearest ? clampCursorMotionPoint(nearest) : null;
}

function anchorPriority(anchor: CursorMotionAnchor): number {
	if (anchor === "click") return 3;
	if (anchor === "rest") return 2;
	return 1;
}

function normalizeBuilderAnchors(
	anchors: CursorMotionBuilderAnchor[],
): CursorMotionBuilderAnchor[] {
	const sorted = [...anchors].sort(
		(a, b) => a.timeMs - b.timeMs || anchorPriority(b.kind) - anchorPriority(a.kind),
	);
	const normalized: CursorMotionBuilderAnchor[] = [];
	for (const anchor of sorted) {
		const previous = normalized.at(-1);
		if (previous && Math.abs(previous.timeMs - anchor.timeMs) <= 1) {
			if (anchorPriority(anchor.kind) > anchorPriority(previous.kind)) {
				normalized[normalized.length - 1] = anchor;
			}
			continue;
		}
		normalized.push(anchor);
	}
	return normalized;
}

function getCursorMotionSegmentKind(
	start: CursorMotionBuilderAnchor,
	end: CursorMotionBuilderAnchor,
): CursorMotionSegmentKind {
	if (start.kind === "rest" && end.kind === "rest") return "hold";
	return Math.hypot(end.point.cx - start.point.cx, end.point.cy - start.point.cy) <=
		REST_MAX_DIAMETER
		? "hold"
		: "move";
}

export function buildCursorMotionRegionDrafts(options: {
	owner: CursorMotionOwner;
	currentSourceTimeMs: number;
	currentVirtualTimeMs: number;
	clipSourceEndMs: number;
	samples: readonly CursorMotionTelemetrySample[];
	path?: CursorMotionPath | null;
}): CursorMotionRegionDraft[] {
	if (
		!Number.isFinite(options.currentSourceTimeMs) ||
		!Number.isFinite(options.currentVirtualTimeMs) ||
		!Number.isFinite(options.clipSourceEndMs)
	) {
		return [];
	}
	const sourceStartMs = Math.max(0, options.currentSourceTimeMs);
	const clipSourceEndMs = Math.max(sourceStartMs, options.clipSourceEndMs);
	if (sourceStartMs >= clipSourceEndMs) return [];

	const ownerSamples = normalizeTelemetrySamples(options.samples);
	const endClick = ownerSamples.find(
		(sample) =>
			sample.timeMs > sourceStartMs &&
			sample.timeMs <= clipSourceEndMs &&
			isClickInteraction(sample.interactionType),
	);
	if (!endClick) return [];

	const sourceEndMs = endClick.timeMs;
	const samples = ownerSamples.filter(
		(sample) => sample.timeMs >= sourceStartMs && sample.timeMs <= sourceEndMs,
	);
	const startPoint =
		options.path?.sampleAtSourceTime(sourceStartMs) ?? nearestSamplePoint(samples, sourceStartMs);
	if (!startPoint) return [];

	const rests = detectCursorMotionRestSpans(samples);
	const anchors: CursorMotionBuilderAnchor[] = [
		{ timeMs: sourceStartMs, point: clampCursorMotionPoint(startPoint), kind: "manual" },
		{ timeMs: sourceEndMs, point: clampCursorMotionPoint(endClick), kind: "click" },
	];
	for (const rest of rests) {
		anchors.push(
			{ timeMs: rest.startMs, point: rest.point, kind: "rest" },
			{ timeMs: rest.endMs, point: rest.point, kind: "rest" },
		);
	}

	const normalizedAnchors = normalizeBuilderAnchors(anchors).filter(
		(anchor) => anchor.timeMs >= sourceStartMs && anchor.timeMs <= sourceEndMs,
	);
	const drafts: CursorMotionRegionDraft[] = [];
	for (let index = 1; index < normalizedAnchors.length; index += 1) {
		const start = normalizedAnchors[index - 1];
		const end = normalizedAnchors[index];
		if (end.timeMs - start.timeMs < MIN_SEGMENT_DURATION_MS) continue;
		const virtualOffset = options.currentVirtualTimeMs - sourceStartMs;
		drafts.push({
			...options.owner,
			startMs: start.timeMs + virtualOffset,
			endMs: end.timeMs + virtualOffset,
			sourceStartMs: start.timeMs,
			sourceEndMs: end.timeMs,
			startPoint: start.point,
			endPoint: end.point,
			controlPoints: [createDefaultCursorMotionControlPoint(start.point, end.point)],
			startAnchor: start.kind,
			endAnchor: end.kind,
			segmentKind: getCursorMotionSegmentKind(start, end),
			preset: "recorded",
			speed: DEFAULT_CURSOR_MOTION_SPEED,
			cycles: CURSOR_MOTION_CYCLES_MIN,
			easing: "ease-in-out",
		});
	}
	return drafts;
}
