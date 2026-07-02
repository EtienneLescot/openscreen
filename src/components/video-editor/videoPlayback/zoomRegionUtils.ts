import type { CursorTelemetryPoint, Rotation3D, ZoomFocus, ZoomRegion } from "../types";
import { DEFAULT_ROTATION_3D, getRotation3D, getZoomScale, lerpRotation3D } from "../types";
import { TRANSITION_WINDOW_MS, ZOOM_IN_TRANSITION_WINDOW_MS } from "./constants";
import { interpolateCursorAt } from "./cursorFollowUtils";
import { clampFocusToScale } from "./focusUtils";
import { clamp01, cubicBezier, easeOutScreenStudio } from "./mathUtils";

const CHAINED_ZOOM_PAN_GAP_MS = 1500;
const CONNECTED_ZOOM_PAN_DURATION_MS = 1000;
const ZOOM_IN_OVERLAP_MS = 500;

type DominantRegionOptions = {
	connectZooms?: boolean;
	cursorTelemetry?: CursorTelemetryPoint[];
	viewportRatio?: ViewportRatio;
	playbackRate?: number;
};

type ConnectedRegionPair = {
	currentRegion: ZoomRegion;
	nextRegion: ZoomRegion;
	transitionStart: number;
	transitionEnd: number;
};

type ConnectedPanTransition = {
	progress: number;
	startFocus: ZoomFocus;
	endFocus: ZoomFocus;
	startScale: number;
	endScale: number;
};

function lerp(start: number, end: number, amount: number) {
	return start + (end - start) * amount;
}

function easeConnectedPan(value: number) {
	return cubicBezier(0.1, 0.0, 0.2, 1.0, value);
}

// ponytail: `playbackRate` lets the caller scale the lead-in / lead-out
// windows in source-time so the zoom transition stays wall-clock constant
// inside speed regions (2× speed → window is 2× source-ms → takes 1×
// wall-clock-ms to traverse). Hold span between `zoomInEnd` and
// `region.endMs` stays in source-time, so the zoomed state still flies
// through under speed regions — that's the duration the user expects
// to scale.
export function computeRegionStrength(
	region: ZoomRegion,
	timeMs: number,
	playbackRate = 1,
): number {
	const zoomInWindow = ZOOM_IN_TRANSITION_WINDOW_MS * playbackRate;
	const zoomOutWindow = TRANSITION_WINDOW_MS * playbackRate;
	const zoomInEnd = region.startMs + ZOOM_IN_OVERLAP_MS;
	const leadInStart = zoomInEnd - zoomInWindow;
	const leadOutEnd = region.endMs + zoomOutWindow;

	if (timeMs < leadInStart || timeMs > leadOutEnd) {
		return 0;
	}

	if (timeMs < zoomInEnd) {
		const progress = (timeMs - leadInStart) / zoomInWindow;
		return easeOutScreenStudio(progress);
	}

	if (timeMs <= region.endMs) {
		return 1;
	}

	const progress = clamp01((timeMs - region.endMs) / zoomOutWindow);
	return 1 - easeOutScreenStudio(progress);
}

function getLinearFocus(start: ZoomFocus, end: ZoomFocus, amount: number): ZoomFocus {
	return {
		cx: lerp(start.cx, end.cx, amount),
		cy: lerp(start.cy, end.cy, amount),
	};
}

interface ViewportRatio {
	widthRatio: number;
	heightRatio: number;
}

function getResolvedFocus(
	region: ZoomRegion,
	zoomScale: number,
	timeMs?: number,
	cursorTelemetry?: CursorTelemetryPoint[],
	viewportRatio?: ViewportRatio,
): ZoomFocus {
	let focus = region.focus;

	if (
		region.focusMode === "auto" &&
		cursorTelemetry &&
		cursorTelemetry.length > 0 &&
		timeMs !== undefined
	) {
		const cursorFocus = interpolateCursorAt(cursorTelemetry, timeMs);
		if (cursorFocus) {
			focus = cursorFocus;
		}
	}

	return clampFocusToScale(focus, zoomScale, viewportRatio);
}

function getConnectedRegionPairs(regions: ZoomRegion[]) {
	const sortedRegions = [...regions].sort((a, b) => a.startMs - b.startMs);
	const pairs: ConnectedRegionPair[] = [];

	for (let index = 0; index < sortedRegions.length - 1; index += 1) {
		const currentRegion = sortedRegions[index];
		const nextRegion = sortedRegions[index + 1];
		const gapMs = nextRegion.startMs - currentRegion.endMs;

		if (gapMs > CHAINED_ZOOM_PAN_GAP_MS) {
			continue;
		}

		pairs.push({
			currentRegion,
			nextRegion,
			transitionStart: currentRegion.endMs,
			transitionEnd: currentRegion.endMs + CONNECTED_ZOOM_PAN_DURATION_MS,
		});
	}

	return pairs;
}

function getActiveRegion(
	regions: ZoomRegion[],
	timeMs: number,
	connectedPairs: ConnectedRegionPair[],
	cursorTelemetry?: CursorTelemetryPoint[],
	viewportRatio?: ViewportRatio,
	playbackRate = 1,
) {
	const activeRegions = regions
		.map((region) => {
			const outgoingPair = connectedPairs.find((pair) => pair.currentRegion.id === region.id);
			if (outgoingPair && timeMs > outgoingPair.currentRegion.endMs) {
				return { region, strength: 0 };
			}

			const incomingPair = connectedPairs.find((pair) => pair.nextRegion.id === region.id);
			if (incomingPair && timeMs < incomingPair.transitionEnd) {
				return { region, strength: 0 };
			}

			return { region, strength: computeRegionStrength(region, timeMs, playbackRate) };
		})
		.filter((entry) => entry.strength > 0)
		.sort((left, right) => {
			if (right.strength !== left.strength) {
				return right.strength - left.strength;
			}

			return right.region.startMs - left.region.startMs;
		});

	if (activeRegions.length === 0) {
		return null;
	}

	const activeRegion = activeRegions[0].region;
	const activeScale = getZoomScale(activeRegion);

	return {
		region: {
			...activeRegion,
			focus: getResolvedFocus(activeRegion, activeScale, timeMs, cursorTelemetry, viewportRatio),
		},
		strength: activeRegions[0].strength,
		blendedScale: null,
		rotation3D: getRotation3D(activeRegion),
	};
}

function getConnectedRegionHold(
	timeMs: number,
	connectedPairs: ConnectedRegionPair[],
	cursorTelemetry?: CursorTelemetryPoint[],
	viewportRatio?: ViewportRatio,
) {
	for (const pair of connectedPairs) {
		if (timeMs > pair.transitionEnd && timeMs < pair.nextRegion.startMs) {
			const nextScale = getZoomScale(pair.nextRegion);
			return {
				region: {
					...pair.nextRegion,
					focus: getResolvedFocus(
						pair.nextRegion,
						nextScale,
						timeMs,
						cursorTelemetry,
						viewportRatio,
					),
				},
				strength: 1,
				blendedScale: null,
				rotation3D: getRotation3D(pair.nextRegion),
			};
		}
	}

	return null;
}

function getConnectedRegionTransition(
	connectedPairs: ConnectedRegionPair[],
	timeMs: number,
	cursorTelemetry?: CursorTelemetryPoint[],
	viewportRatio?: ViewportRatio,
) {
	for (const pair of connectedPairs) {
		const { currentRegion, nextRegion, transitionStart, transitionEnd } = pair;

		if (timeMs < transitionStart || timeMs > transitionEnd) {
			continue;
		}

		const transitionProgress = easeConnectedPan(
			clamp01((timeMs - transitionStart) / Math.max(1, transitionEnd - transitionStart)),
		);
		const currentScale = getZoomScale(currentRegion);
		const nextScale = getZoomScale(nextRegion);
		const transitionScale = lerp(currentScale, nextScale, transitionProgress);
		// Both regions share the same timeMs, so interpolate cursor once and reuse.
		const sharedCursorFocus =
			cursorTelemetry && cursorTelemetry.length > 0
				? interpolateCursorAt(cursorTelemetry, timeMs)
				: null;
		const currentFocus = clampFocusToScale(
			currentRegion.focusMode === "auto" && sharedCursorFocus
				? sharedCursorFocus
				: currentRegion.focus,
			currentScale,
			viewportRatio,
		);
		const nextFocus = clampFocusToScale(
			nextRegion.focusMode === "auto" && sharedCursorFocus ? sharedCursorFocus : nextRegion.focus,
			nextScale,
			viewportRatio,
		);
		const transitionFocus = getLinearFocus(currentFocus, nextFocus, transitionProgress);
		const transitionRotation = lerpRotation3D(
			getRotation3D(currentRegion),
			getRotation3D(nextRegion),
			transitionProgress,
		);

		return {
			region: {
				...nextRegion,
				focus: transitionFocus,
			},
			strength: 1,
			blendedScale: transitionScale,
			rotation3D: transitionRotation,
			transition: {
				progress: transitionProgress,
				startFocus: currentFocus,
				endFocus: nextFocus,
				startScale: currentScale,
				endScale: nextScale,
			},
		};
	}

	return null;
}

type DominantRegionResult = {
	region: ZoomRegion | null;
	strength: number;
	blendedScale: number | null;
	rotation3D: Rotation3D;
	transition: ConnectedPanTransition | null;
};

// Single-slot cache: the ticker calls findDominantRegion at 60fps with mostly
// unchanged inputs (especially while paused), so reusing the last result skips
// the per-frame O(N) scan and allocations.
let dominantRegionCache: {
	regions: ZoomRegion[];
	timeMsKey: number;
	playbackRateKey: number;
	telemetry: CursorTelemetryPoint[] | undefined;
	connectZooms: boolean;
	viewportRatio: ViewportRatio | undefined;
	result: DominantRegionResult;
} | null = null;

export function findDominantRegion(
	regions: ZoomRegion[],
	timeMs: number,
	options: DominantRegionOptions = {},
): DominantRegionResult {
	const connectZooms = !!options.connectZooms;
	const telemetry = options.cursorTelemetry;
	const vr = options.viewportRatio;
	const playbackRate = options.playbackRate ?? 1;
	const timeMsKey = Math.round(timeMs);
	const playbackRateKey = Math.round(playbackRate * 1000);

	if (
		dominantRegionCache &&
		dominantRegionCache.regions === regions &&
		dominantRegionCache.timeMsKey === timeMsKey &&
		dominantRegionCache.telemetry === telemetry &&
		dominantRegionCache.connectZooms === connectZooms &&
		dominantRegionCache.viewportRatio === vr &&
		dominantRegionCache.playbackRateKey === playbackRateKey
	) {
		return dominantRegionCache.result;
	}

	const connectedPairs = connectZooms ? getConnectedRegionPairs(regions) : [];

	let result: DominantRegionResult;
	if (connectZooms) {
		const connectedTransition = getConnectedRegionTransition(connectedPairs, timeMs, telemetry, vr);
		if (connectedTransition) {
			result = connectedTransition;
		} else {
			const connectedHold = getConnectedRegionHold(timeMs, connectedPairs, telemetry, vr);
			if (connectedHold) {
				result = { ...connectedHold, transition: null };
			} else {
				const activeRegion = getActiveRegion(
					regions,
					timeMs,
					connectedPairs,
					telemetry,
					vr,
					playbackRate,
				);
				result = activeRegion
					? { ...activeRegion, transition: null }
					: {
							region: null,
							strength: 0,
							blendedScale: null,
							rotation3D: DEFAULT_ROTATION_3D,
							transition: null,
						};
			}
		}
	} else {
		const activeRegion = getActiveRegion(
			regions,
			timeMs,
			connectedPairs,
			telemetry,
			vr,
			playbackRate,
		);
		result = activeRegion
			? { ...activeRegion, transition: null }
			: {
					region: null,
					strength: 0,
					blendedScale: null,
					rotation3D: DEFAULT_ROTATION_3D,
					transition: null,
				};
	}

	dominantRegionCache = {
		regions,
		timeMsKey,
		playbackRateKey,
		telemetry,
		connectZooms,
		viewportRatio: vr,
		result,
	};

	return result;
}
