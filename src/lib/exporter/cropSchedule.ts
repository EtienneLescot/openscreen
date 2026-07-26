// Per-clip crop lookup, shared by the GIF exporter and the document adapter.
// Lived in videoExporter.ts until the web MP4 path was removed; GIF is the only
// remaining renderer that resolves a crop off a timeline.

import type { CropRegion } from "@/components/video-editor/types";

export interface CropScheduleEntry {
	startSec: number;
	endSec: number;
	cropRegion: CropRegion;
}

/** Finds which clip's crop applies at a given SOURCE-media timestamp — the
 * first schedule entry whose [startSec, endSec) covers it, falling back to
 * `fallback` when the schedule is absent or nothing covers it (e.g. a gap). */
export function resolveCropAt(
	schedule: CropScheduleEntry[] | undefined,
	sourceSec: number,
	fallback: CropRegion,
): CropRegion {
	if (!schedule || schedule.length === 0) return fallback;
	const covering = schedule.find(
		(entry) => sourceSec >= entry.startSec && sourceSec < entry.endSec,
	);
	return covering?.cropRegion ?? fallback;
}
