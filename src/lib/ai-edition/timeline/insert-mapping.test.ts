// Issue #560. An insertion made from the recording transcript buys the FILM time; one made
// from a voiceover transcript buys the TAKE silence and leaves the picture alone. The row
// looks identical either way — only the asset it names says which lane it is on.
//
// These also lock the inertness that is true today by ACCIDENT: a voiceover row reaches
// `rulerInserts` and `resolvePlaybackSegments` and is ignored by both, purely because they
// match on `clip.assetId`. That accident is the only reason writing one is harmless right
// now, so it becomes a rule with a test before anything starts writing them.

import { describe, expect, it } from "vitest";
import { resolvePlaybackSegments } from "../document/timeline";
import type { AxcutAudioTrack, AxcutClip, AxcutDocument, AxcutInsertRange } from "../schema";
import { resolveInsertPlacement, takeInserts } from "./insert-mapping";
import { rulerInserts } from "./inserted-time";

const CLIPS: AxcutClip[] = [
	{
		id: "c1",
		assetId: "rec",
		sourceStartSec: 0,
		sourceEndSec: 6,
		timelineStartSec: 0,
		timelineEndSec: 6,
		wordRefs: [],
		origin: "user",
		reason: "",
	},
	{
		id: "c2",
		assetId: "rec",
		sourceStartSec: 20,
		sourceEndSec: 26,
		timelineStartSec: 6,
		timelineEndSec: 12,
		wordRefs: [],
		origin: "user",
		reason: "",
	},
];

const TAKE = {
	id: "vo_frag",
	trackId: "vo",
	assetId: "aud",
	kind: "voiceover",
	startMs: 2000,
	endMs: 10_000,
	durationSec: 30,
	offsetMs: 1000,
	gainDb: 0,
	loop: false,
	fadeInMs: 0,
	fadeOutMs: 0,
	muted: false,
	label: "",
	origin: "user",
} as unknown as AxcutAudioTrack;

function insert(over: Partial<AxcutInsertRange> & { id: string }): AxcutInsertRange {
	return {
		assetId: "rec",
		atSec: 3,
		durationSec: 0.5,
		wordId: `w_${over.id}`,
		reason: "",
		origin: "user",
		...over,
	} as AxcutInsertRange;
}

function doc(inserts: AxcutInsertRange[], over: Partial<AxcutDocument> = {}): AxcutDocument {
	return {
		schemaVersion: 7,
		project: { id: "p", title: "T", createdAt: "", updatedAt: "" },
		assets: [
			{
				id: "rec",
				kind: "video",
				label: "r",
				originalPath: "/r.mp4",
				durationSec: 30,
				cameraTrack: null,
			},
			{
				id: "aud",
				kind: "audio",
				label: "a",
				originalPath: "/a.mp3",
				durationSec: 30,
				cameraTrack: null,
			},
		],
		transcript: null,
		transcripts: [],
		timeline: {
			clips: CLIPS,
			gaps: [],
			trimRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
			insertRanges: inserts,
		},
		annotations: [],
		zoomRanges: [],
		audioTracks: [TAKE],
		legacyEditor: null,
		...over,
	} as unknown as AxcutDocument;
}

describe("resolveInsertPlacement", () => {
	it("leaves a recording insert to `rulerInserts`, the one place that places one", () => {
		// It used to answer with a raw second of its own, from a plain shift the clip's own
		// insertions made wrong — a second, contradictory answer that nothing read.
		const row = insert({ id: "i1", atSec: 3 });
		expect(resolveInsertPlacement(row, doc([row]))).toBeNull();
	});

	it("leaves a voiceover insert UNPROJECTED, naming the take and a source second", () => {
		// Deliberately not a raw moment: where it lands depends on the insertions before it
		// inside the same take and on the cuts under it, and only the take's walk knows.
		const row = insert({ id: "i1", assetId: "aud", atSec: 4 });
		expect(resolveInsertPlacement(row, doc([row]))).toEqual({
			lane: "voiceover",
			trackGroupId: "vo",
			atSourceSec: 4,
		});
	});

	it("returns null when nothing carries the moment any more", () => {
		// Past every clip's source window...
		expect(resolveInsertPlacement(insert({ id: "i1", atSec: 40 }), doc([]))).toBeNull();
		// ...outside the take's own window (offset 1s, span 8s → source 1..9)...
		expect(
			resolveInsertPlacement(insert({ id: "i2", assetId: "aud", atSec: 12 }), doc([])),
		).toBeNull();
		// ...and when the take has been deleted outright.
		expect(
			resolveInsertPlacement(
				insert({ id: "i3", assetId: "aud", atSec: 4 }),
				doc([], { audioTracks: [] }),
			),
		).toBeNull();
	});

	it("names the take by its GROUP, so a split take resolves to one thing", () => {
		const split = doc([], {
			audioTracks: [
				{ ...TAKE, id: "f1", trackId: "vo", startMs: 2000, endMs: 6000, offsetMs: 1000 },
				{ ...TAKE, id: "f2", trackId: "vo", startMs: 6000, endMs: 10_000, offsetMs: 5000 },
			],
		});
		const row = insert({ id: "i1", assetId: "aud", atSec: 2 });
		expect(resolveInsertPlacement(row, split)).toMatchObject({ trackGroupId: "vo" });
	});
});

describe("takeInserts", () => {
	it("collects one take's insertions in its own source order", () => {
		const rows = [
			insert({ id: "b", assetId: "aud", atSec: 6 }),
			insert({ id: "a", assetId: "aud", atSec: 2 }),
			insert({ id: "film", assetId: "rec", atSec: 3 }),
		];
		expect(takeInserts(doc(rows), "vo").map((i) => [i.id, i.atSourceSec])).toEqual([
			["a", 2],
			["b", 6],
		]);
	});

	it("returns nothing for a take that has none", () => {
		expect(takeInserts(doc([insert({ id: "film" })]), "vo")).toEqual([]);
	});
});

describe("a voiceover insert is inert on the film, deliberately", () => {
	const row = insert({ id: "i1", assetId: "aud", atSec: 4 });

	it("produces no ruler insert, so the film's length does not move", () => {
		expect(rulerInserts([row], CLIPS)).toEqual([]);
		// And the recording's own row still does.
		expect(rulerInserts([insert({ id: "i2", atSec: 3 })], CLIPS)).toHaveLength(1);
	});

	it("produces no held segment, so no clip freezes for it", () => {
		const held = (rows: AxcutInsertRange[]) =>
			resolvePlaybackSegments(CLIPS, [], rows).filter((s) => s.heldSec !== undefined);
		expect(held([row])).toEqual([]);
		expect(held([insert({ id: "i2", atSec: 3 })])).toHaveLength(1);
	});
});
