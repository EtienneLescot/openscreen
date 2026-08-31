// Where an audio region's media actually plays — the ONE projection the preview and
// the export both read (issue #350).
//
// An audio region is a clip-anchored region like any other, which means a span the user
// drew across a cut is stored as one fragment per clip. For zoom or annotation that split
// is semantically free: the same value held over two adjacent spans is the same value.
// Audio is not a value, it is CONTINUOUS MEDIA — hand each fragment the pill's `offsetSec`
// verbatim and a music bed restarts from its in-point at every clip boundary, which is
// audible and wrong.
//
// So the pill's `offsetSec` is the in-point of the WHOLE pill, and each fragment's own
// in-point is derived here by walking the fragments left to right and advancing the cursor
// by the OUTPUT length of each. Output length, not raw length, because that is how much
// media the fragment actually gets to play: under a 2× stretch a 10 s raw span occupies 5 s
// of programme, so it consumes 5 s of the file (the media itself always plays at 1× —
// speed regions stretch clip PCM only, never an imported track).
//
// The same walk explains what happens to the rest of a pill when part of it is removed: a
// fragment whose clip was deleted contributes nothing and the cursor does not advance, so
// the surviving fragments simply carry on playing the file where the last kept one stopped.
// A cut under a bed shortens the bed; it never desynchronises what follows it.

import { type AnchoredSpeedRegion, projectRawTimelineSecToPlayback } from "../document/timeline";
import type { AxcutAudioKind, AxcutAudioRegion, AxcutClip, AxcutTrimRange } from "../schema";
import {
	anchoredToRawSpanSec,
	coalesceRegionsForRuler,
	hasCompleteClipAnchor,
} from "./timelineMap";

/** One fragment of one audio pill, resolved onto the output programme. */
export interface AudioPlacement {
	/** The pill the fragment belongs to — the id the ruler, the inspector and the agent
	 *  address. Every fragment of one pill repeats it, so consumers can group by it. */
	pillId: string;
	/** The stored region this fragment came from. */
	regionId: string;
	audioAssetId: string;
	kind: AxcutAudioKind;
	gainDb: number;
	/** OUTPUT programme seconds — the clock `mix_external_tracks` and the preview's
	 *  projected playhead both work in. */
	outputStartSec: number;
	outputEndSec: number;
	/** Source seconds into the audio file. */
	sourceInSec: number;
	sourceOutSec: number;
}

/**
 * Every audio region resolved to its output-programme placement, ordered by output start.
 *
 * Returns one entry per FRAGMENT, not per pill: the export needs one mixer entry per
 * contiguous run, and the preview needs to know which run the playhead is in. Fragments of
 * one pill share `pillId`.
 */
export function placeAudioRegions(
	regions: AxcutAudioRegion[],
	clips: AxcutClip[],
	trimRanges: AxcutTrimRange[],
	speedRegions: AnchoredSpeedRegion[],
): AudioPlacement[] {
	if (regions.length === 0) return [];
	const byId = new Map(regions.map((r) => [r.id, r]));
	const toOutput = (rawSec: number) =>
		projectRawTimelineSecToPlayback(clips, trimRanges, speedRegions, rawSec);

	const out: AudioPlacement[] = [];
	for (const pill of coalesceRegionsForRuler(regions)) {
		const fragments = pill.ids
			.map((id) => byId.get(id))
			.filter((r): r is AxcutAudioRegion => r != null)
			.map((region) => {
				// The anchor is the source of truth; `startMs`/`endMs` is the cache, and is all a
				// not-yet-anchored region has. A fragment whose clip was deleted resolves to null
				// and drops out entirely — same rule as every other region kind.
				const raw = hasCompleteClipAnchor(region)
					? anchoredToRawSpanSec(region, clips)
					: { startSec: region.startMs / 1000, endSec: region.endMs / 1000 };
				return raw ? { region, raw } : null;
			})
			.filter(
				(v): v is { region: AxcutAudioRegion; raw: { startSec: number; endSec: number } } =>
					v !== null,
			)
			.sort((a, b) => a.raw.startSec - b.raw.startSec);

		let cursor = Math.max(0, pill.member.offsetSec);
		for (const { region, raw } of fragments) {
			const outputStartSec = toOutput(raw.startSec);
			const outputEndSec = toOutput(raw.endSec);
			const duration = outputEndSec - outputStartSec;
			// A fragment entirely inside a trim projects to zero output length. It plays nothing
			// and must not advance the cursor, or the fragment after it would skip that much file.
			if (!(duration > 0)) continue;
			out.push({
				pillId: pill.ids[0],
				regionId: region.id,
				audioAssetId: pill.member.audioAssetId,
				kind: pill.member.kind,
				gainDb: pill.member.gainDb,
				outputStartSec,
				outputEndSec,
				sourceInSec: cursor,
				sourceOutSec: cursor + duration,
			});
			cursor += duration;
		}
	}
	return out.sort((a, b) => a.outputStartSec - b.outputStartSec);
}

/**
 * What one pill's `<audio>` element should be doing at `outputTimeSec`.
 *
 * `shouldPlay` is false outside every fragment — between two fragments separated by a cut
 * the element pauses rather than free-running, so it cannot drift past the resume point.
 * `targetTimeSec` is where to seek when it does play.
 */
export function resolveAudioPlayback(
	placements: AudioPlacement[],
	outputTimeSec: number,
): { targetTimeSec: number; shouldPlay: boolean } {
	for (const p of placements) {
		if (outputTimeSec >= p.outputStartSec && outputTimeSec < p.outputEndSec) {
			return {
				targetTimeSec: p.sourceInSec + (outputTimeSec - p.outputStartSec),
				shouldPlay: true,
			};
		}
	}
	const first = placements[0];
	return {
		targetTimeSec: first ? first.sourceInSec : 0,
		shouldPlay: false,
	};
}
