// Builds the window-switch timeline for multi-window captures: which recorded
// window is on screen when, and how each hand-off animates. Pure module,
// unit-tested, shared by the CLI compositor and any future GUI integration.

import type { MultiWindowManifest } from "./contracts";

/** Focus shorter than this never takes over the screen. */
export const MIN_SWITCH_DWELL_MS = 1200;
export const DEFAULT_TRANSITION_MS = 450;

export type SlideDirection = "from-right" | "from-left";

export interface SwitchSegment {
	windowIndex: number;
	startMs: number;
	endMs: number;
}

export interface SwitchTransition {
	/** Transition midpoint — the segment boundary. */
	atMs: number;
	fromIndex: number;
	toIndex: number;
	direction: SlideDirection;
	durationMs: number;
}

export interface WindowSwitchTimeline {
	segments: SwitchSegment[];
	transitions: SwitchTransition[];
}

/**
 * Maps the focus timeline onto the recorded windows. Focus on windows that
 * were not captured keeps the previous window on screen; sub-dwell focus
 * flickers are ignored. The slide direction follows screen geometry: a window
 * that sat to the right of the previous one slides in from the right.
 */
export function buildWindowSwitchTimeline(
	manifest: MultiWindowManifest,
	totalMs: number,
	transitionMs: number = DEFAULT_TRANSITION_MS,
): WindowSwitchTimeline {
	const windowIndexById = new Map<number, number>();
	manifest.windows.forEach((window, index) => {
		windowIndexById.set(window.windowId, index);
	});

	// Focus samples → candidate switch points (recorded windows only).
	const switchPoints: { timeMs: number; windowIndex: number }[] = [];
	for (const sample of manifest.focus.samples) {
		const windowIndex = windowIndexById.get(sample.windowNumber);
		if (windowIndex === undefined) continue;
		const previous = switchPoints[switchPoints.length - 1];
		if (previous && previous.windowIndex === windowIndex) continue;
		switchPoints.push({ timeMs: Math.max(0, sample.timeMs), windowIndex });
	}

	// The primary window opens the video even if focus data starts late.
	if (switchPoints.length === 0 || switchPoints[0].timeMs > 0) {
		switchPoints.unshift({ timeMs: 0, windowIndex: switchPoints[0]?.windowIndex ?? 0 });
	}

	// Collapse flickers: a segment must hold the screen for MIN_SWITCH_DWELL_MS.
	const held: { timeMs: number; windowIndex: number }[] = [];
	for (const point of switchPoints) {
		const previous = held[held.length - 1];
		if (!previous) {
			held.push(point);
			continue;
		}
		if (point.windowIndex === previous.windowIndex) continue;
		if (point.timeMs - previous.timeMs < MIN_SWITCH_DWELL_MS) {
			// Too soon after the previous switch: replace it if it was itself a
			// flicker start, otherwise ignore this blip.
			const beforePrevious = held[held.length - 2];
			if (beforePrevious && beforePrevious.windowIndex === point.windowIndex) {
				held.pop();
			}
			continue;
		}
		held.push(point);
	}

	const segments: SwitchSegment[] = [];
	for (let index = 0; index < held.length; index++) {
		const startMs = index === 0 ? 0 : held[index].timeMs;
		const endMs = index + 1 < held.length ? held[index + 1].timeMs : totalMs;
		if (endMs <= startMs) continue;
		segments.push({ windowIndex: held[index].windowIndex, startMs, endMs });
	}
	if (segments.length === 0) {
		segments.push({ windowIndex: 0, startMs: 0, endMs: totalMs });
	}

	const transitions: SwitchTransition[] = [];
	for (let index = 1; index < segments.length; index++) {
		const fromWindow = manifest.windows[segments[index - 1].windowIndex];
		const toWindow = manifest.windows[segments[index].windowIndex];
		const fromCenter = fromWindow.bounds.x + fromWindow.bounds.width / 2;
		const toCenter = toWindow.bounds.x + toWindow.bounds.width / 2;
		transitions.push({
			atMs: segments[index].startMs,
			fromIndex: segments[index - 1].windowIndex,
			toIndex: segments[index].windowIndex,
			direction: toCenter >= fromCenter ? "from-right" : "from-left",
			durationMs: transitionMs,
		});
	}

	return { segments, transitions };
}

/** Per-frame render state: which windows to draw and at which x-offsets. */
export interface SwitchFrameState {
	activeIndex: number;
	/** Present during a transition. */
	transition?: {
		outgoingIndex: number;
		incomingIndex: number;
		/** 0..1 eased progress of the slide. */
		progress: number;
		direction: SlideDirection;
	};
}

function easeInOutCubic(t: number): number {
	return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

export function switchStateAt(timeline: WindowSwitchTimeline, timeMs: number): SwitchFrameState {
	for (const transition of timeline.transitions) {
		const start = transition.atMs - transition.durationMs / 2;
		const end = transition.atMs + transition.durationMs / 2;
		if (timeMs >= start && timeMs < end) {
			const raw = (timeMs - start) / transition.durationMs;
			return {
				activeIndex: transition.toIndex,
				transition: {
					outgoingIndex: transition.fromIndex,
					incomingIndex: transition.toIndex,
					progress: easeInOutCubic(Math.max(0, Math.min(1, raw))),
					direction: transition.direction,
				},
			};
		}
	}

	let activeIndex = timeline.segments[0]?.windowIndex ?? 0;
	for (const segment of timeline.segments) {
		if (timeMs >= segment.startMs) {
			activeIndex = segment.windowIndex;
		}
	}
	return { activeIndex };
}
