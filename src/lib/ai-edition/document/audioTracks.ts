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
// seconds in, so a bed spanning a cut audibly restarts at the boundary, and
// each fragment would re-run the layer's fades. `anchorAudioTrackFragments`
// fixes the payload up afterwards: every fragment's `offsetMs` is advanced by
// the source time its predecessors consumed, and the fades are kept on the
// outer edges only.

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
 *  - `fadeInMs` stays on the first fragment and `fadeOutMs` on the last, so a
 *    split track fades once at each real edge rather than at every cut.
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
	const last = anchored.length - 1;
	return anchored.map((fragment, index) => {
		const spanMs = Math.max(0, fragment.endMs - fragment.startMs);
		const next: AxcutAudioTrack = {
			...fragment,
			trackId: groupId,
			// Looping restarts the window on its own, so an advanced offset would
			// double-count the fold; the mixer and the preview both wrap within
			// `durationSec - offsetMs`, which every fragment shares.
			offsetMs: track.loop ? track.offsetMs : track.offsetMs + elapsedMs,
			fadeInMs: index === 0 ? track.fadeInMs : 0,
			fadeOutMs: index === last ? track.fadeOutMs : 0,
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
 * carrying the FIRST fragment's payload (its `offsetMs` is the track's real
 * offset — later fragments hold advanced copies) and the outer fades.
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
			fadeInMs: head.fadeInMs,
			fadeOutMs: tail.fadeOutMs,
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

/** Patch the shared payload of every fragment of one track. Payload edits (gain,
 *  mute, loop, offset) must hit ALL fragments or the halves of a split track
 *  disagree; `offsetMs` keeps its per-fragment advance. */
export function patchAudioTrack(
	doc: AxcutDocument,
	trackId: string,
	patch: Partial<Pick<AxcutAudioTrack, "gainDb" | "muted" | "loop" | "fadeInMs" | "fadeOutMs">> & {
		offsetMs?: number;
	},
): AxcutDocument {
	const fragments = doc.audioTracks.filter((t) => trackGroupId(t) === trackId);
	if (fragments.length === 0) return doc;
	const ordered = [...fragments].sort((a, b) => a.startMs - b.startMs);
	const baseOffset = ordered[0].offsetMs;
	const last = ordered[ordered.length - 1].id;
	return {
		...doc,
		audioTracks: doc.audioTracks.map((t) => {
			if (trackGroupId(t) !== trackId) return t;
			const isFirst = t.id === ordered[0].id;
			const isLast = t.id === last;
			return {
				...t,
				...(patch.gainDb === undefined ? {} : { gainDb: patch.gainDb }),
				...(patch.muted === undefined ? {} : { muted: patch.muted }),
				...(patch.loop === undefined ? {} : { loop: patch.loop }),
				// Fades live on the outer edges; an interior fragment keeps none.
				...(patch.fadeInMs === undefined ? {} : { fadeInMs: isFirst ? patch.fadeInMs : 0 }),
				...(patch.fadeOutMs === undefined ? {} : { fadeOutMs: isLast ? patch.fadeOutMs : 0 }),
				// Shift the whole track by the delta so each fragment keeps the
				// advance that makes it continuous with its predecessor.
				...(patch.offsetMs === undefined
					? {}
					: { offsetMs: Math.max(0, t.offsetMs + (patch.offsetMs - baseOffset)) }),
			};
		}),
	};
}

/**
 * Fade lengths in seconds, reduced to fit inside `spanSec`.
 *
 * Fades that do not fit share the span in proportion rather than being clamped
 * independently: clamping each to the span first would turn an asymmetric pair
 * into a symmetric one, losing the shape the user asked for. An unreduced
 * fade-in longer than the span is worse than cosmetic — it holds the gain at
 * zero for the whole track.
 *
 * Mirrored by `resolve_fade_samples` in `crates/compositor/src/audio.rs`; the
 * preview reads this one, the render reads that one, and they must agree.
 */
export function resolveFadeSecs(
	fadeInMs: number,
	fadeOutMs: number,
	spanSec: number,
): { fadeInSec: number; fadeOutSec: number } {
	const fadeInSec = Math.max(0, fadeInMs / 1000);
	const fadeOutSec = Math.max(0, fadeOutMs / 1000);
	const total = fadeInSec + fadeOutSec;
	if (total <= spanSec) return { fadeInSec, fadeOutSec };
	const scale = Math.max(0, spanSec) / total;
	return { fadeInSec: fadeInSec * scale, fadeOutSec: fadeOutSec * scale };
}

/**
 * Assign each track a ROW in the audio lane, so two tracks that overlap in time
 * never sit on top of each other.
 *
 * Greedy first-fit over tracks in start order: a track takes the topmost row
 * whose last occupant has already finished, and opens a new row only when every
 * existing one is still busy. Tracks that do not overlap therefore keep sharing
 * one row — the lane stays a single line for the common case, and grows only as
 * far as the actual overlap demands.
 *
 * Stacking is the whole point: a lane that draws every track at the same height
 * turns three voiceovers into one illegible pile where the user cannot tell
 * which pill they are about to drag.
 *
 * Returns the row index per track id, plus how many rows the lane needs.
 */
/**
 * The rest of the tape a pill is a window onto: where the file's own content still
 * sits to the left and right of it, in timeline seconds.
 *
 * An audio pill is the only timeline object that edits media you cannot see. Every
 * other pill holds a value over a span, and a clip's crop produces a clip that is
 * right there on screen; resizing an audio pill crops an invisible file, and nothing
 * said where in that file the edges had landed. The edges already stop at the
 * content (see the `lowerLeft` / `maxEnd` clamps in the lane drag) — this is what
 * makes the stop legible before you hit it.
 *
 * Clamped to the programme, so the element stays bounded however long the file is:
 * a four-minute bed under a five-second view would otherwise ask for a box tens of
 * screens wide. Returns null when there is nothing to show — no known duration (a
 * failed probe must never draw a bound it cannot measure), or a file no longer than
 * the window onto it.
 */
export function audioGhostExtent(
	offsetSec: number,
	spanSec: number,
	durationSec: number | null | undefined,
	pillStartT: number,
	pillEndT: number,
	totalT: number,
): { startT: number; endT: number; sourceStartSec: number; sourceEndSec: number } | null {
	if (durationSec == null || !(durationSec > 0)) return null;
	const startT = Math.max(0, pillStartT - Math.max(0, offsetSec));
	const endT = Math.min(totalT, pillEndT + Math.max(0, durationSec - (offsetSec + spanSec)));
	if (endT - startT <= pillEndT - pillStartT + 1e-6) return null;
	return {
		startT,
		endT,
		sourceStartSec: offsetSec - (pillStartT - startT),
		sourceEndSec: offsetSec + (endT - pillStartT),
	};
}

/**
 * Slip: slide the media under a pill whose span does not move.
 *
 * The gesture the ghost makes necessary rather than optional. An edge drag sets the
 * in-point at TIMELINE scale, which is unusable the moment the file is much longer
 * than the region it fills — reaching 3:00 inside a four-minute bed on a five-second
 * view means dragging three minutes of ruler. Slip separates the two questions a
 * pill conflates: *where it plays* (the span) and *what plays* (`offsetMs`).
 *
 * The RATE is the caller's business, not this function's — it takes a delta already
 * in source ms, because the timeline's own scale is the wrong one here and that is
 * the whole point. What belongs here is the clamp: an offset outside
 * `[0, duration - span]` windows past one end of the file, which is silence nobody
 * asked for.
 *
 * Returns null when there is nothing to slip, on the same two conditions the ghost
 * refuses on.
 */
export function slipAudioOffsetMs(
	offsetMs: number,
	spanMs: number,
	durationSec: number | null | undefined,
	deltaMs: number,
): number | null {
	if (durationSec == null || !(durationSec > 0)) return null;
	const slackMs = durationSec * 1000 - spanMs;
	if (!(slackMs > 0)) return null;
	return Math.round(Math.min(slackMs, Math.max(0, offsetMs + deltaMs)));
}

export function packAudioTrackRows(tracks: Array<{ id: string; startMs: number; endMs: number }>): {
	rowOf: Map<string, number>;
	rowCount: number;
} {
	const ordered = [...tracks].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
	// The end of the last track placed in each row, in the same index order.
	const rowEnds: number[] = [];
	const rowOf = new Map<string, number>();
	for (const track of ordered) {
		let row = rowEnds.findIndex((end) => end <= track.startMs);
		if (row === -1) {
			row = rowEnds.length;
			rowEnds.push(track.endMs);
		} else {
			rowEnds[row] = track.endMs;
		}
		rowOf.set(track.id, row);
	}
	return { rowOf, rowCount: Math.max(1, rowEnds.length) };
}
