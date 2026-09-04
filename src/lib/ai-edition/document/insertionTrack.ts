// An insertion in a VOICE-OVER is a track fragment.
//
// The same move as the recording lane one file over, in the coordinates a take has:
//
//     [ take 0→5.3 ]  [ generated 0→0.4 ]  [ take 5.3→20.9 ]
//
// The take splits in two and the generated audio goes between the halves. Both halves keep
// the file seconds they always had; the right one's `offsetMs` advances by exactly what the
// left consumed, which is the repair `anchorAudioTrackFragments` already does for a take
// spanning two clips.
//
// Two rules the maintainer settled before this, and this respects both:
//
//   - A recording-lane insertion does not touch a take. The take has its own audio and keeps
//     talking against a picture that has slid.
//   - A take insertion does NOT lengthen the programme. The clips decide the length. It
//     pushes the take's later content later inside the SAME timeline, and whatever that
//     pushes past the last frame is clamped at export, exactly as it always was.
//
// Undoing it is not spelled out here either: contiguous pills of one take whose file
// timecodes continue are one take, and `reanchorAudioTracks` folds them back.

import type { AxcutAudioTrack, AxcutDocument } from "../schema";

const EPS = 1e-6;

import { extensionAssetId, extensionDurationSec } from "../timeline/clip-parts";
import { removedRawSpans } from "../timeline/programme-time";
import { takeProgramme } from "../timeline/take-programme";
import {
	collapseTracksToPills,
	dropUnusedGeneratedMedia,
	reanchorAudioTracks,
	trackGroupId,
} from "./audioTracks";
import { createId } from "./ids";
import {
	generatedAsset,
	generatedTranscript,
	hostAsset,
	type InsertSide,
	nextGeneratedWordId,
} from "./insertion";

/** The take that plays this asset and actually contains that second of its file. */
function takeFor(
	document: AxcutDocument,
	assetId: string,
	fileSec: number,
): { pill: AxcutAudioTrack; rawSec: number } | null {
	const removed = removedRawSpans(document.timeline.clips, document.timeline.trimRanges);
	for (const pill of collapseTracksToPills(document.audioTracks)) {
		if (pill.assetId !== assetId || pill.loop) continue;
		for (const piece of takeProgramme(pill, removed)) {
			if (fileSec < piece.sourceStartSec - EPS || fileSec > piece.sourceEndSec + EPS) continue;
			return { pill, rawSec: piece.rawStartSec + (fileSec - piece.sourceStartSec) };
		}
	}
	return null;
}

/** True when this asset is spoken by a take rather than played by a clip. */
export function isTrackAsset(document: AxcutDocument, assetId: string): boolean {
	return document.audioTracks.some((track) => track.assetId === assetId);
}

/**
 * Insert a word nobody said into a take, as a track of its own.
 *
 * The take is cut at that moment and the generated track goes between the halves. Everything
 * of the take that followed moves later by its length; nothing else on the timeline does.
 */
export function insertGeneratedTrack(
	document: AxcutDocument,
	assetId: string,
	anchorWordId: string,
	side: InsertSide,
	text: string,
): AxcutDocument {
	const trimmed = text.trim();
	if (trimmed.length === 0) return document;
	const host = hostAsset(document);
	if (!host) {
		throw new Error("Cannot insert a word: the project has no recording to generate beside");
	}
	const word = document.transcripts
		.find((t) => t.assetId === assetId)
		?.words.find((w) => w.id === anchorWordId);
	if (!word) throw new Error(`Cannot insert beside word "${anchorWordId}": it has no transcript`);

	const found = takeFor(document, assetId, side === "after" ? word.endSec : word.startSec);
	if (!found) {
		throw new Error(`Cannot insert beside word "${anchorWordId}": no take speaks that moment`);
	}
	const { pill, rawSec } = found;

	const wordId = nextGeneratedWordId(document);
	const durationSec = extensionDurationSec(trimmed);
	const asset = generatedAsset(host, wordId, durationSec, trimmed);
	const atMs = Math.round(rawSec * 1000);
	const spanMs = Math.round(durationSec * 1000);

	// The take's own head and tail keep their fades; the generated stretch has neither.
	const left: AxcutAudioTrack = {
		...pill,
		id: createId("take"),
		trackId: undefined,
		endMs: atMs,
		fadeOutMs: 0,
	};
	const generated: AxcutAudioTrack = {
		...pill,
		id: asset.id,
		trackId: undefined,
		assetId: asset.id,
		label: trimmed.slice(0, 40),
		startMs: atMs,
		endMs: atMs + spanMs,
		offsetMs: 0,
		durationSec,
		fadeInMs: 0,
		fadeOutMs: 0,
	};
	const right: AxcutAudioTrack = {
		...pill,
		id: createId("take"),
		trackId: undefined,
		startMs: atMs + spanMs,
		// The take is as long as the audio it holds, so its tail moves by the whole insertion.
		endMs: pill.endMs + spanMs,
		offsetMs: pill.offsetMs + (atMs - pill.startMs),
		fadeInMs: 0,
	};

	const kept = document.audioTracks.filter((t) => trackGroupId(t) !== trackGroupId(pill));
	const pieces = [left, generated, right].filter((t) => t.endMs - t.startMs > 0);
	return {
		...document,
		assets: [...document.assets, asset],
		transcripts: [
			...document.transcripts,
			generatedTranscript(
				wordId,
				durationSec,
				trimmed,
				document.transcripts.find((t) => t.assetId === assetId)?.language ?? "en",
			),
		],
		audioTracks: reanchorAudioTracks([...kept, ...pieces], document.timeline.clips, () =>
			createId("take"),
		),
	};
}

/**
 * Delete inserted words spoken over a take.
 *
 * The exact inverse of the insertion: the generated track goes, and the half it pushed later
 * comes back by the same amount. The two halves then meet with the file continuing across the
 * join, which is all `reanchorAudioTracks` needs to fold them into one take again.
 *
 * A track lane is not re-laid the way the clip list is — pills hold absolute ruler positions —
 * so nothing closes this gap on its own. Only the pushed half moves: the insertion moved only
 * that, and taking it back has to be as narrow as making it was.
 */
export function removeGeneratedTracks(
	document: AxcutDocument,
	wordIds: readonly string[],
): AxcutDocument {
	return wordIds.reduce((next, wordId) => {
		const id = extensionAssetId(wordId);
		const generated = collapseTracksToPills(next.audioTracks).find((t) => t.assetId === id);
		if (!generated) return next;
		const spanMs = generated.endMs - generated.startMs;
		const pills = collapseTracksToPills(next.audioTracks)
			.filter((pill) => pill.assetId !== id)
			.map((pill) => shiftIfAfter(pill, generated.endMs, -spanMs));
		return dropUnusedGeneratedMedia({
			...next,
			audioTracks: reanchorAudioTracks(pills, next.timeline.clips, () => createId("take")),
		});
	}, document);
}

/** The pill the insertion pushed: the one that starts where the generated stretch ends.
 *  Nothing else on the lane moved when it was made, so nothing else moves now. */
function shiftIfAfter(pill: AxcutAudioTrack, atMs: number, deltaMs: number): AxcutAudioTrack {
	if (deltaMs === 0 || Math.abs(pill.startMs - atMs) > 1) return pill;
	return { ...pill, startMs: pill.startMs + deltaMs, endMs: pill.endMs + deltaMs };
}

/**
 * Rewrite the text of a word inserted into a take.
 *
 * Its length is its text, so the track resizes and the file it plays is renamed. Everything
 * of the take after it moves by the difference — the same push the insertion itself made.
 */
export function retextGeneratedTrack(
	document: AxcutDocument,
	wordId: string,
	text: string,
): AxcutDocument {
	const trimmed = text.trim();
	const id = extensionAssetId(wordId);
	const host = hostAsset(document);
	const current = document.audioTracks.find((t) => t.assetId === id);
	if (trimmed.length === 0 || !host || !current) return document;

	const durationSec = extensionDurationSec(trimmed);
	const spanMs = Math.round(durationSec * 1000);
	const deltaMs = spanMs - (current.endMs - current.startMs);
	const language = document.transcripts.find((t) => t.assetId === id)?.language ?? "en";

	const pills = collapseTracksToPills(document.audioTracks).map((pill) =>
		pill.assetId === id
			? { ...pill, endMs: pill.startMs + spanMs, durationSec, label: trimmed.slice(0, 40) }
			: // Only the half the insertion pushed moves again, and only by the difference.
				shiftIfAfter(pill, current.endMs, deltaMs),
	);

	return {
		...document,
		assets: document.assets.map((a) =>
			a.id === id ? generatedAsset(host, wordId, durationSec, trimmed) : a,
		),
		transcripts: document.transcripts.map((t) =>
			t.assetId === id ? generatedTranscript(wordId, durationSec, trimmed, language) : t,
		),
		audioTracks: reanchorAudioTracks(pills, document.timeline.clips, () => createId("take")),
	};
}
