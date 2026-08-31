// Placement and payload edits for timeline audio tracks (issue #350).
//
// Audio tracks are CLIP-ANCHORED, so unlike the array-only ops this module used
// to hold, placement goes through the shared pill helpers in
// `timeline/timelineMap.ts` — the same machinery zoom, annotation, speed and
// camera-fullscreen regions already use. One user-visible track is one PILL;
// underneath it is one anchored fragment per clip it covers.
//
// The one thing audio needs that no other region kind does is `offsetMs`
// advancement. `anchorRawRegionsToClips` copies a region's payload verbatim
// into every fragment, which is right for value-per-span effects (both halves
// of a split zoom are still "depth 3") and wrong for continuous media: two
// fragments each carrying `offsetMs: 2000` would both restart the file two
// seconds in, so a bed spanning a cut audibly restarts at the boundary.
// `anchorAudioTrackFragments` fixes the payload up afterwards: every
// fragment's `offsetMs` is advanced by the source time its predecessors
// consumed.

import type { AxcutAudioTrack, AxcutClip, AxcutDocument } from "../schema";
import { anchorRegionsWithDerivedMs, coalesceRegionsForRuler } from "../timeline/timelineMap";

/** Every fragment of one user-visible track shares this key. */
export function trackGroupId(track: AxcutAudioTrack): string {
	return track.trackId ?? track.id;
}

/**
 * Anchor a track's raw span to the clips it covers, then repair the payload so
 * the fragments play as ONE continuous take:
 *
 *  - `offsetMs` advances by the elapsed source time, so fragment 2 picks up the
 *    file where fragment 1 left off instead of restarting at the track offset.
 *  - `trackId` ties the fragments together for the lane, the inspector and
 *    delete.
 *
 * A track that overlaps no clip is returned unanchored (one fragment, the input
 * span), matching how `anchorRegionsWithDerivedMs` treats every other kind.
 */
export function anchorAudioTrackFragments(
	track: AxcutAudioTrack,
	clips: AxcutClip[],
	makeId: () => string,
): AxcutAudioTrack[] {
	const groupId = trackGroupId(track);
	const anchored = anchorRegionsWithDerivedMs([track], clips, makeId) as AxcutAudioTrack[];
	if (anchored.length === 0) return [];
	// Fragments come back in clip order, which is the order they play.
	let elapsedMs = 0;
	return anchored.map((fragment) => {
		const spanMs = Math.max(0, fragment.endMs - fragment.startMs);
		const next: AxcutAudioTrack = {
			...fragment,
			trackId: groupId,
			offsetMs: track.offsetMs + elapsedMs,
		};
		elapsedMs += spanMs;
		return next;
	});
}

/** Re-anchor every track in the document — used after a structural clip edit
 *  reshuffles what each fragment sits over. */
export function reanchorAudioTracks(
	tracks: AxcutAudioTrack[],
	clips: AxcutClip[],
	makeId: () => string,
): AxcutAudioTrack[] {
	// Coalesce back to one raw span per track FIRST: re-anchoring the stored
	// fragments individually would re-ventilate each one and multiply them.
	return collapseTracksToPills(tracks).flatMap((track) =>
		anchorAudioTrackFragments(track, clips, makeId),
	);
}

/**
 * The user-visible tracks: fragments folded back into one span per `trackId`,
 * carrying the FIRST fragment's payload — its `offsetMs` is the track's real
 * offset, since later fragments hold advanced copies.
 */
export function collapseTracksToPills(tracks: AxcutAudioTrack[]): AxcutAudioTrack[] {
	const groups = new Map<string, AxcutAudioTrack[]>();
	for (const track of tracks) {
		const key = trackGroupId(track);
		const bucket = groups.get(key);
		if (bucket) bucket.push(track);
		else groups.set(key, [track]);
	}
	return [...groups.values()].map((fragments) => {
		const ordered = [...fragments].sort((a, b) => a.startMs - b.startMs);
		const head = ordered[0];
		const tail = ordered[ordered.length - 1];
		return {
			...head,
			id: trackGroupId(head),
			trackId: undefined,
			clipId: undefined,
			sourceStartSec: undefined,
			sourceEndSec: undefined,
			startMs: head.startMs,
			endMs: tail.endMs,
		};
	});
}

/** Lane pills for the ruler, one per user-visible track. */
export function audioTrackPills(tracks: AxcutAudioTrack[]) {
	return coalesceRegionsForRuler(collapseTracksToPills(tracks));
}

/** Drop every fragment of a track, and its asset when nothing else needs it.
 *
 *  An imported audio asset is only ever reachable through its track — audio is
 *  filtered out of the clip lists, so it never becomes a clip — so a deleted
 *  track orphans it, and it would otherwise linger in the document forever,
 *  invisible in every asset list (issue #350). */
export function removeAudioTrack(doc: AxcutDocument, trackId: string): AxcutDocument {
	const doomed = doc.audioTracks.filter((t) => trackGroupId(t) === trackId);
	if (doomed.length === 0) return doc;
	const audioTracks = doc.audioTracks.filter((t) => trackGroupId(t) !== trackId);
	const assetId = doomed[0].assetId;
	const stillReferenced =
		audioTracks.some((t) => t.assetId === assetId) ||
		doc.timeline.clips.some((c) => c.assetId === assetId);
	const assets = stillReferenced ? doc.assets : doc.assets.filter((a) => a.id !== assetId);
	return { ...doc, audioTracks, assets };
}

/** Patch the shared payload of every fragment of one track. A payload edit must
 *  hit ALL fragments or the halves of a split track disagree; `offsetMs` keeps
 *  its per-fragment advance. */
export function patchAudioTrack(
	doc: AxcutDocument,
	trackId: string,
	patch: Partial<Pick<AxcutAudioTrack, "gainDb">> & { offsetMs?: number },
): AxcutDocument {
	const fragments = doc.audioTracks.filter((t) => trackGroupId(t) === trackId);
	if (fragments.length === 0) return doc;
	const ordered = [...fragments].sort((a, b) => a.startMs - b.startMs);
	const baseOffset = ordered[0].offsetMs;
	return {
		...doc,
		audioTracks: doc.audioTracks.map((t) => {
			if (trackGroupId(t) !== trackId) return t;
			return {
				...t,
				...(patch.gainDb === undefined ? {} : { gainDb: patch.gainDb }),
				// Shift the whole track by the delta so each fragment keeps the
				// advance that makes it continuous with its predecessor.
				...(patch.offsetMs === undefined
					? {}
					: { offsetMs: Math.max(0, t.offsetMs + (patch.offsetMs - baseOffset)) }),
			};
		}),
	};
}
