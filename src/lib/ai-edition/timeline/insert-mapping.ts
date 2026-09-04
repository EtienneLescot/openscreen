// Where an insertion lives, resolved rather than stored (issue #560).
//
// An added word buys itself time. On the RECORDING lane that time is film: the clip holds
// a frame and the ruler grows. On the VOICEOVER lane it is a silence inside the take: the
// picture is not touched at all, and the narration that follows lands later against the
// same image.
//
// The record says which by naming an asset, and the asset's `kind` says which lane it is
// on. Nothing stores a container id, and that is deliberate: every candidate is ephemeral.
// A voiceover fragment id is re-minted by `reanchorAudioTracks` on the first clip drag; a
// clip id does not survive a split, which in this repo is `duplicateClip` plus two
// `setClipSourceRange` calls that move `atSec` out of the half that was named. An
// un-anchored region reaching every placement of its asset is the working state here — see
// `duplicateClip`'s own comment about trims.
//
// The two lanes come back in DIFFERENT shapes on purpose. A recording insert can be given
// its raw moment immediately, through the clip that plays that source second. A voiceover
// insert cannot: its ruler position depends on the insertions before it inside the same
// take AND on the cuts under it, and only the take's own walk can resolve that. Handing
// back an unprojected result is what stops a caller from inventing a projection that would
// disagree with the walk.

import { trackGroupId } from "../document/audioTracks";
import type { AxcutDocument, AxcutInsertRange } from "../schema";

/** A silence inside a take: no picture of its own. */
export interface VoiceoverInsertPlacement {
	lane: "voiceover";
	/** The user-visible take, not one of its stored fragments. */
	trackGroupId: string;
	/** Deliberately in the take's SOURCE seconds — see the note above. */
	atSourceSec: number;
}

export type InsertPlacement = VoiceoverInsertPlacement;

/**
 * Which TAKE carries this insertion, or null — a recording's insertion, or a take that has
 * been deleted. Only takes need answering here: an insertion in the film is placed by
 * `rulerInserts`, which is the one definition of where an insertion sits on the timeline.
 *
 * The lane is read from the ASSET, never from the row: `kind: "audio"` is the only thing
 * that distinguishes a take's transcript from the film's, and it is already the
 * discriminator `lanePlacements` uses for the transcript tab.
 */
export function resolveInsertPlacement(
	insert: AxcutInsertRange,
	document: AxcutDocument,
): InsertPlacement | null {
	const asset = document.assets.find((a) => a.id === insert.assetId);
	if (asset?.kind !== "audio") return null;
	// The first take drawing on this asset whose source window contains the moment.
	// Inclusive at both edges, matching `rulerInserts`: an insertion sits at the END of the
	// word it follows, which is routinely a window's own boundary.
	for (const track of document.audioTracks ?? []) {
		if (track.kind !== "voiceover" || track.assetId !== insert.assetId) continue;
		const startSec = track.offsetMs / 1000;
		const endSec = startSec + Math.max(0, track.endMs - track.startMs) / 1000;
		if (insert.atSec < startSec || insert.atSec > endSec) continue;
		return { lane: "voiceover", trackGroupId: trackGroupId(track), atSourceSec: insert.atSec };
	}
	return null;
}

/** The insertions belonging to one take, in the take's own source order. */
export function takeInserts(
	document: AxcutDocument,
	groupId: string,
): Array<{ id: string; wordId: string; atSourceSec: number; durationSec: number }> {
	const out: Array<{ id: string; wordId: string; atSourceSec: number; durationSec: number }> = [];
	for (const insert of document.timeline.insertRanges ?? []) {
		const placement = resolveInsertPlacement(insert, document);
		if (placement?.lane !== "voiceover" || placement.trackGroupId !== groupId) continue;
		out.push({
			id: insert.id,
			wordId: insert.wordId,
			atSourceSec: placement.atSourceSec,
			durationSec: insert.durationSec,
		});
	}
	return out.sort((a, b) => a.atSourceSec - b.atSourceSec || a.id.localeCompare(b.id));
}
