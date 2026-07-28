// Converts window-focus telemetry (`<video>.focus.json`) into zoom regions
// that frame whichever window the user had focused — the export renderer's
// zoom spring then pans/zooms between windows cinematically. Pure module so
// it can be unit-tested and reused by a future GUI toggle.

import type { ZoomRegion } from "@/components/video-editor/types";
import type { FocusRecordingData, FocusSample } from "./contracts";

/** Focus shorter than this is treated as "passing through" and ignored. */
export const MIN_FOCUS_DWELL_MS = 1500;
/** Same-window intervals separated by less than this are merged. */
export const MERGE_GAP_MS = 800;
/** Padding around the framed window, as a fraction of its size per side. */
export const FRAME_MARGIN = 0.06;
/** Windows this close to filling the display are shown without zooming. */
export const MIN_ZOOM_SCALE = 1.15;
/** Matches the editor's maximum zoom scale. */
export const MAX_ZOOM_SCALE = 5;

interface FocusInterval {
	startMs: number;
	endMs: number;
	sample: FocusSample;
}

function sampleKey(sample: FocusSample): string {
	// Bucket bounds so window-move/resize animations don't fragment intervals.
	const bucket = (value: number) => Math.round(value / 48);
	return [
		sample.appName,
		bucket(sample.x),
		bucket(sample.y),
		bucket(sample.width),
		bucket(sample.height),
	].join("|");
}

function buildIntervals(samples: FocusSample[], totalMs: number): FocusInterval[] {
	const intervals: FocusInterval[] = [];
	for (const sample of samples) {
		if (sample.timeMs >= totalMs) break;
		const previous = intervals[intervals.length - 1];
		if (previous && sampleKey(previous.sample) === sampleKey(sample)) {
			previous.endMs = totalMs;
			previous.sample = sample; // keep the freshest bounds
			continue;
		}
		if (previous) {
			previous.endMs = sample.timeMs;
		}
		intervals.push({ startMs: sample.timeMs, endMs: totalMs, sample });
	}

	// Drop sub-dwell detours first so that "Main → brief popup → Main" leaves
	// two adjacent Main intervals, then merge same-window neighbors.
	const dwelled = intervals.filter(
		(interval) => interval.endMs - interval.startMs >= MIN_FOCUS_DWELL_MS,
	);
	const merged: FocusInterval[] = [];
	for (const interval of dwelled) {
		const previous = merged[merged.length - 1];
		if (
			previous &&
			sampleKey(previous.sample) === sampleKey(interval.sample) &&
			interval.startMs - previous.endMs < MERGE_GAP_MS
		) {
			previous.endMs = interval.endMs;
			previous.sample = interval.sample;
			continue;
		}
		merged.push({ ...interval });
	}
	return merged;
}

export interface FocusZoomOptions {
	totalMs: number;
	existingRegions: { startMs: number; endMs: number }[];
}

/**
 * Returns zoom regions framing each sufficiently-long window focus. Windows
 * near display size produce no region (the camera pulls back to full frame).
 * Regions overlapping existing ones are dropped so manual edits win.
 */
export function focusTelemetryToZoomRegions(
	data: FocusRecordingData,
	options: FocusZoomOptions,
): ZoomRegion[] {
	const display = data.displays.find((candidate) => candidate.id === data.recordedDisplayId);
	if (!display || display.bounds.width <= 0 || display.bounds.height <= 0) {
		return [];
	}

	const displaySamples = data.samples.filter(
		(sample) => sample.displayId === data.recordedDisplayId,
	);
	const intervals = buildIntervals(displaySamples, options.totalMs);

	const regions: ZoomRegion[] = [];
	let nextId = 1;
	for (const interval of intervals) {
		const { sample } = interval;
		const normWidth = (sample.width * (1 + 2 * FRAME_MARGIN)) / display.bounds.width;
		const normHeight = (sample.height * (1 + 2 * FRAME_MARGIN)) / display.bounds.height;
		if (normWidth <= 0 || normHeight <= 0) continue;

		const scale = Math.min(MAX_ZOOM_SCALE, 1 / Math.max(normWidth, normHeight));
		if (scale < MIN_ZOOM_SCALE) continue; // window ~fills the display

		const centerX = (sample.x + sample.width / 2 - display.bounds.x) / display.bounds.width;
		const centerY = (sample.y + sample.height / 2 - display.bounds.y) / display.bounds.height;

		const startMs = Math.max(0, Math.round(interval.startMs));
		const endMs = Math.min(options.totalMs, Math.round(interval.endMs));
		if (endMs <= startMs) continue;

		const overlapsExisting = options.existingRegions.some(
			(region) => endMs > region.startMs && startMs < region.endMs,
		);
		if (overlapsExisting) continue;

		regions.push({
			id: `follow-window-${nextId++}`,
			startMs,
			endMs,
			depth: 3,
			customScale: Math.max(1, Math.min(MAX_ZOOM_SCALE, scale)),
			focus: {
				cx: Math.max(0, Math.min(1, centerX)),
				cy: Math.max(0, Math.min(1, centerY)),
			},
			focusMode: "manual",
			source: "auto",
		});
	}
	return regions;
}
