// Pure document operations for imported audio tracks (issue #350). No DOM, no
// IPC: each function takes an AxcutDocument and returns a new one with
// `audioTracks` updated. The store (useTimeline) wraps these with saveDocument;
// the schema factory (createAudioTrack) builds the track the append receives.
//
// Audio tracks are NOT clip-anchored — they float over the assembled programme
// in OUTPUT (post-trim/post-speed) timeline seconds — so unlike clip regions
// these ops need no anchoring, just array edits with schema-valid guards.

import type { AxcutAudioTrack, AxcutDocument } from "../schema";

// Timeline values arrive from drag deltas and persisted documents, both of which
// can carry NaN; every op clamps the same way the region ops in useTimeline do.
const finiteNonNeg = (n: number) => (Number.isFinite(n) ? Math.max(0, n) : 0);
const finite = (n: number) => (Number.isFinite(n) ? n : 0);

/** Append a track (built by `createAudioTrack`) to the document. */
export function appendAudioTrack(doc: AxcutDocument, track: AxcutAudioTrack): AxcutDocument {
	return { ...doc, audioTracks: [...doc.audioTracks, track] };
}

/** Drop a track by id. A no-op if the id isn't present. */
export function removeAudioTrack(doc: AxcutDocument, trackId: string): AxcutDocument {
	return { ...doc, audioTracks: doc.audioTracks.filter((t) => t.id !== trackId) };
}

// Shared updater — maps the one matching track through `patch`. Keeps every op
// below a single expression and the "not found" case a clean no-op.
function updateAudioTrack(
	doc: AxcutDocument,
	trackId: string,
	patch: (track: AxcutAudioTrack) => AxcutAudioTrack,
): AxcutDocument {
	return {
		...doc,
		audioTracks: doc.audioTracks.map((t) => (t.id === trackId ? patch(t) : t)),
	};
}

/** Reposition a track's head on the programme (output-timeline seconds). */
export function moveAudioTrack(
	doc: AxcutDocument,
	trackId: string,
	timelineStartSec: number,
): AxcutDocument {
	return updateAudioTrack(doc, trackId, (t) => ({
		...t,
		timelineStartSec: finiteNonNeg(timelineStartSec),
	}));
}

/**
 * Window the source file. `trimStartSec` floors at 0; `trimEndSec`, when given,
 * is pulled up to at least `trimStartSec` so the result always satisfies the
 * schema's `trimEndSec >= trimStartSec` rule. Pass `trimEndSec: undefined` to
 * clear the tail trim (play to the end of the file).
 */
export function setAudioTrackTrim(
	doc: AxcutDocument,
	trackId: string,
	trim: { trimStartSec: number; trimEndSec?: number },
): AxcutDocument {
	const trimStartSec = finiteNonNeg(trim.trimStartSec);
	const trimEndSec =
		trim.trimEndSec === undefined
			? undefined
			: Math.max(trimStartSec, finiteNonNeg(trim.trimEndSec));
	return updateAudioTrack(doc, trackId, (t) => ({ ...t, trimStartSec, trimEndSec }));
}

/** Set a track's level in dB. Any finite value; the mixer applies the gain. */
export function setAudioTrackGain(
	doc: AxcutDocument,
	trackId: string,
	gainDb: number,
): AxcutDocument {
	return updateAudioTrack(doc, trackId, (t) => ({ ...t, gainDb: finite(gainDb) }));
}

/** Mute or unmute a track without losing its stored gain. */
export function setAudioTrackMute(
	doc: AxcutDocument,
	trackId: string,
	mute: boolean,
): AxcutDocument {
	return updateAudioTrack(doc, trackId, (t) => ({ ...t, mute }));
}
