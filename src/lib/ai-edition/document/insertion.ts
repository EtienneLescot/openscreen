// An insertion IS a clip.
//
// A word typed into the transcript cuts its clip in two and puts a generated clip between
// the halves:
//
//     [ recording 0→5.3 ]  [ generated 0→0.4 ]  [ recording 5.3→20.9 ]
//
// Stored exactly as it reads. Nothing downstream carries a notion of an insertion: every
// mapping in this codebase rests on "a clip is an uninterrupted shift between its source
// seconds and the ruler", and three clips satisfy that where one interrupted clip satisfied
// none of them. The generated clip is then a clip like any other — it can be moved, cropped,
// edited and deleted from the timeline, with no code of its own for any of it.
//
// It owns its word: the asset is `ext:<wordId>`, the file is named by the pair, and the
// transcript holds that one word at 0→duration. So the pane, the captions, the cue highlight
// and the exporter all read it through the paths they already had.
//
// Deleting is the exact inverse, and it is not spelled out here: `removeClip` is the single
// mutator for taking a clip away, and it rejoins contiguous survivors. Both delete paths —
// the transcript pane and the timeline — therefore put the clip back together for free.

import type { AxcutAsset, AxcutClip, AxcutDocument, AxcutTranscript } from "../schema";
import {
	extensionAssetId,
	extensionClipPath,
	extensionDurationSec,
	isGeneratedAssetId,
} from "../timeline/clip-parts";
import { createId } from "./ids";
import { rederiveRegionMs, removeClip, resequenceClips } from "./timeline";

/** Where a new word goes relative to the word the caret was resting on. */
export type InsertSide = "before" | "after";

export { isGeneratedAssetId };

const EPS = 1e-6;

/**
 * The moment on the RULER the caret is asking for.
 *
 * Ruler seconds, not source seconds, so one path covers both anchors: a recorded word
 * resolves through its clip's own shift, and a word already inserted resolves to the edge of
 * the generated clip it lives on. Inserting beside an insertion then needs no case at all —
 * nothing is cut and the new clip lands between two existing ones.
 */
function anchorRulerSec(
	document: AxcutDocument,
	assetId: string,
	anchorWordId: string,
	side: InsertSide,
): number | null {
	const word = document.transcripts
		.find((t) => t.assetId === assetId)
		?.words.find((w) => w.id === anchorWordId);
	if (!word) return null;
	const at = side === "after" ? word.endSec : word.startSec;
	const clip = [...document.timeline.clips]
		.filter((c) => c.assetId === assetId)
		.sort((a, b) => a.timelineStartSec - b.timelineStartSec)
		.find((c) => at >= c.sourceStartSec - EPS && at <= (c.sourceEndSec ?? c.sourceStartSec) + EPS);
	return clip ? clip.timelineStartSec + (at - clip.sourceStartSec) : null;
}

/** `synth_N`, numbered past every generated asset the document already carries. */
function nextGeneratedWordId(document: AxcutDocument): string {
	let highest = 0;
	for (const asset of document.assets) {
		const match = /^ext:synth_(\d+)$/.exec(asset.id);
		if (match) highest = Math.max(highest, Number(match[1]));
	}
	return `synth_${highest + 1}`;
}

/** The recording the generated files are written beside. One rule, so the renderer and the
 *  main process arrive at the same folder without asking each other. */
function hostAsset(document: AxcutDocument): AxcutAsset | null {
	const primary = document.assets.find((a) => a.id === document.project.primaryAssetId);
	if (primary?.originalPath && !isGeneratedAssetId(primary.id)) return primary;
	return document.assets.find((a) => a.originalPath && !isGeneratedAssetId(a.id)) ?? null;
}

function generatedAsset(
	host: AxcutAsset,
	wordId: string,
	durationSec: number,
	text: string,
): AxcutAsset {
	return {
		id: extensionAssetId(wordId),
		kind: "video",
		label: text.slice(0, 40),
		originalPath: extensionClipPath(host.originalPath, wordId, durationSec),
		durationSec,
		// The recording's geometry: the generated file is made to match it.
		video: host.video,
		cameraTrack: null,
	};
}

function generatedTranscript(
	wordId: string,
	durationSec: number,
	text: string,
	language: string,
): AxcutTranscript {
	return {
		assetId: extensionAssetId(wordId),
		language,
		segments: [
			{ id: "seg_1", kind: "speech", startSec: 0, endSec: durationSec, text, wordIds: [wordId] },
		],
		words: [
			{ id: wordId, segmentId: "seg_1", startSec: 0, endSec: durationSec, text, source: "synth" },
		],
	};
}

/**
 * Every row anchored to the clip that was just cut, copied onto BOTH halves.
 *
 * Not "decide which half each row belongs to" — that is interval arithmetic this file has no
 * business owning. One copy per half, and `rederiveRegionMs` clamps each to its own clip's
 * source window and drops what has nothing left. A row wholly on one side survives once; one
 * straddling the cut survives on both, which is what a zoom drawn across the moment a word
 * was typed into actually means.
 */
function fanOutAnchors(document: AxcutDocument, from: string, to: string): AxcutDocument {
	// `?? []` for the reason every other collection walk here has one: these keys are
	// additive, so a document written before one of them — or hand-built, never through the
	// schema — simply has none, and the schema defaults it back to an empty array anyway.
	const both = <T extends { id: string; clipId?: string }>(rows: readonly T[] | undefined): T[] =>
		(rows ?? []).flatMap((row) =>
			row.clipId === from ? [row, { ...row, id: createId("frag"), clipId: to }] : [row],
		);
	return {
		...document,
		timeline: { ...document.timeline, trimRanges: both(document.timeline.trimRanges) },
		zoomRanges: both(document.zoomRanges),
		annotations: both(document.annotations),
		audioTracks: both(document.audioTracks),
	};
}

/**
 * Insert a word nobody said, as a clip of its own.
 *
 * The clip under the caret is cut at that moment and the generated clip goes between the
 * halves; everything after slides along by its length. Dropped on a clip's edge nothing is
 * cut — the new clip simply takes its place in the order.
 */
export function insertGeneratedClip(
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
	const atRuler = anchorRulerSec(document, assetId, anchorWordId, side);
	if (atRuler === null) {
		throw new Error(`Cannot insert beside word "${anchorWordId}": no clip plays that moment`);
	}

	const wordId = nextGeneratedWordId(document);
	const durationSec = extensionDurationSec(trimmed);
	const asset = generatedAsset(host, wordId, durationSec, trimmed);
	const generated: AxcutClip = {
		id: asset.id,
		assetId: asset.id,
		sourceStartSec: 0,
		sourceEndSec: durationSec,
		timelineStartSec: atRuler,
		timelineEndSec: atRuler + durationSec,
		wordRefs: [],
		origin: "user",
		reason: "inserted word",
	};

	const ordered = [...document.timeline.clips].sort(
		(a, b) => a.timelineStartSec - b.timelineStartSec,
	);
	const clips: AxcutClip[] = [];
	let split: { from: string; to: string } | null = null;
	let placed = false;
	for (const clip of ordered) {
		const cutsHere = atRuler > clip.timelineStartSec + EPS && atRuler < clip.timelineEndSec - EPS;
		if (!placed && cutsHere) {
			const cut = clip.sourceStartSec + (atRuler - clip.timelineStartSec);
			const right = {
				...clip,
				id: createId("clip"),
				sourceStartSec: cut,
				timelineStartSec: atRuler,
			};
			clips.push({ ...clip, sourceEndSec: cut, timelineEndSec: atRuler }, generated, right);
			split = { from: clip.id, to: right.id };
			placed = true;
			continue;
		}
		if (!placed && clip.timelineStartSec >= atRuler - EPS) {
			clips.push(generated);
			placed = true;
		}
		clips.push(clip);
	}
	if (!placed) clips.push(generated);

	const next: AxcutDocument = {
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
		timeline: { ...document.timeline, clips: resequenceClips(clips) },
	};
	const anchored = split ? fanOutAnchors(next, split.from, split.to) : next;
	return rederiveRegionMs(anchored, anchored.timeline.clips);
}

/**
 * Delete inserted words.
 *
 * `removeClip` does the whole of it: the gap closes, the halves rejoin when they are still
 * one continuous piece of media, and the rows anchored to the half that goes away follow.
 * What is left here is the media the clip was the only user of.
 */
export function removeGeneratedClips(
	document: AxcutDocument,
	wordIds: readonly string[],
): AxcutDocument {
	return wordIds.reduce((next, wordId) => {
		const id = extensionAssetId(wordId);
		if (!next.timeline.clips.some((c) => c.id === id)) return next;
		const after = removeClip(next, id);
		return {
			...after,
			assets: after.assets.filter((a) => a.id !== id),
			transcripts: after.transcripts.filter((t) => t.assetId !== id),
		};
	}, document);
}

/**
 * Rewrite an inserted word's text.
 *
 * Its length IS its text, so this resizes the clip and renames the file it plays. The old
 * file is simply never asked for again; the new one is generated on the next save.
 */
export function retextGeneratedClip(
	document: AxcutDocument,
	wordId: string,
	text: string,
): AxcutDocument {
	const trimmed = text.trim();
	const id = extensionAssetId(wordId);
	const host = hostAsset(document);
	if (trimmed.length === 0 || !host || !document.assets.some((a) => a.id === id)) return document;

	const durationSec = extensionDurationSec(trimmed);
	const language = document.transcripts.find((t) => t.assetId === id)?.language ?? "en";
	const next: AxcutDocument = {
		...document,
		assets: document.assets.map((a) =>
			a.id === id ? generatedAsset(host, wordId, durationSec, trimmed) : a,
		),
		transcripts: document.transcripts.map((t) =>
			t.assetId === id ? generatedTranscript(wordId, durationSec, trimmed, language) : t,
		),
		timeline: {
			...document.timeline,
			clips: resequenceClips(
				document.timeline.clips.map((c) => (c.id === id ? { ...c, sourceEndSec: durationSec } : c)),
			),
		},
	};
	return rederiveRegionMs(next, next.timeline.clips);
}
