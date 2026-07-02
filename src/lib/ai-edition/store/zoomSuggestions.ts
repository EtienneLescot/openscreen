// F2.1 — auto-zoom "wand" suggestions. Scans the transcript for sustained
// speech segments (the silence heuristic in reverse: anything the transcriber
// didn't mark as silence is where the speaker is explaining something) and
// proposes zoom regions covering them. Pure — the Bottombar Magic button
// applies the result via saveDocument.

import { createId } from "../document/ids";
import type { AxcutDocument, AxcutZoomRegion } from "../schema";
import { locateSourcePosition } from "../timeline/virtual-preview";

// A speech segment must run at least this long to justify a zoom-in.
const MIN_SPEECH_SEC = 4;
// Don't flood the timeline — the user can re-run after accepting/deleting.
const MAX_SUGGESTIONS = 6;
// Trim the zoom slightly inside the segment so the zoom-in lands after the
// speaker starts and releases before they stop.
const EDGE_PADDING_SEC = 0.4;

function overlapsExisting(
	startMs: number,
	endMs: number,
	existing: Array<{ startMs: number; endMs: number }>,
): boolean {
	return existing.some((z) => startMs < z.endMs && endMs > z.startMs);
}

export function suggestZoomRegions(document: AxcutDocument): AxcutZoomRegion[] {
	const primaryAssetId = document.project.primaryAssetId ?? document.assets[0]?.id;
	if (!primaryAssetId) return [];
	const transcript =
		document.transcripts.find((t) => t.assetId === primaryAssetId) ??
		(document.transcript?.assetId === primaryAssetId ? document.transcript : null);
	if (!transcript) return [];

	const clips = document.timeline.clips;
	const suggestions: AxcutZoomRegion[] = [];
	const occupied: Array<{ startMs: number; endMs: number }> = document.zoomRanges.map((z) => ({
		startMs: z.startMs,
		endMs: z.endMs,
	}));

	for (const segment of transcript.segments) {
		if (suggestions.length >= MAX_SUGGESTIONS) break;
		if (segment.kind !== "speech") continue;
		if (segment.endSec - segment.startSec < MIN_SPEECH_SEC) continue;

		// Map source time → timeline time through the clip layout; segments
		// that were cut out of the timeline are skipped entirely.
		const start = locateSourcePosition(clips, segment.startSec + EDGE_PADDING_SEC, primaryAssetId);
		const end = locateSourcePosition(clips, segment.endSec - EDGE_PADDING_SEC, primaryAssetId);
		if (!start || !end) continue;
		const startMs = Math.round(start.virtualTimeSec * 1000);
		const endMs = Math.round(end.virtualTimeSec * 1000);
		if (endMs - startMs < (MIN_SPEECH_SEC - 2 * EDGE_PADDING_SEC) * 1000) continue;
		if (overlapsExisting(startMs, endMs, occupied)) continue;

		const region: AxcutZoomRegion = {
			id: createId("zoom"),
			startMs,
			endMs,
			depth: 2,
			focus: { cx: 0.5, cy: 0.5 },
			focusMode: "auto",
			source: "auto",
		};
		suggestions.push(region);
		occupied.push({ startMs, endMs });
	}

	return suggestions;
}
