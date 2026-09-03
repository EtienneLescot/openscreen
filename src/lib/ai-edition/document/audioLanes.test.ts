// Issue #560, step 6. "The voiceover" has to name ONE thing for the transcript tab's lane
// switch to mean anything, so each kind keeps one row. Enforced at the single placement
// door every writer goes through, and repaired — never refused — after a structural edit.

import { describe, expect, it } from "vitest";
import type { AxcutAudioTrack, AxcutClip, AxcutDocument } from "../schema";
import {
	audioLanePills,
	collapseTracksToPills,
	firstFreeHeadMs,
	placeAudioTrackInDocument,
	separateAudioLanes,
} from "./audioTracks";

const CLIPS: AxcutClip[] = [
	{
		id: "c1",
		assetId: "rec",
		sourceStartSec: 0,
		sourceEndSec: 60,
		timelineStartSec: 0,
		timelineEndSec: 60,
		wordRefs: [],
		origin: "user",
		reason: "",
	},
];

function track(over: Partial<AxcutAudioTrack> & { id: string }): AxcutAudioTrack {
	return {
		trackId: over.id,
		assetId: "aud",
		kind: "voiceover",
		startMs: 0,
		endMs: 4000,
		durationSec: 30,
		offsetMs: 0,
		gainDb: 0,
		loop: false,
		fadeInMs: 0,
		fadeOutMs: 0,
		muted: false,
		label: "",
		origin: "user",
		clipId: "c1",
		sourceStartSec: 0,
		sourceEndSec: 4,
		...over,
	} as unknown as AxcutAudioTrack;
}

function doc(audioTracks: AxcutAudioTrack[]): AxcutDocument {
	return {
		schemaVersion: 7,
		project: { id: "p", title: "T", createdAt: "", updatedAt: "" },
		assets: [],
		transcript: null,
		transcripts: [],
		timeline: {
			clips: CLIPS,
			gaps: [],
			trimRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		annotations: [],
		zoomRanges: [],
		audioTracks,
		legacyEditor: null,
	} as unknown as AxcutDocument;
}

let n = 0;
const ids = () => `f${n++}`;
const pills = (d: AxcutDocument, kind: AxcutAudioTrack["kind"] = "voiceover") =>
	audioLanePills(d.audioTracks, kind).map((p) => [p.startMs, p.endMs]);

describe("one row per kind", () => {
	it("queues a second take behind the first instead of on top of it", () => {
		// Two takes recorded from the same playhead. This is what forced a second voiceover
		// row into existence, and with it a lane switch that could not name what it meant.
		const first = doc([track({ id: "a", startMs: 2000, endMs: 6000 })]);
		const next = placeAudioTrackInDocument(
			first,
			track({ id: "b", startMs: 2000, endMs: 5000 }),
			ids,
			"create",
		);
		expect(pills(next)).toEqual([
			[2000, 6000],
			[6000, 9000],
		]);
	});

	it("parks a moved take against the wall with its duration intact", () => {
		const before = doc([
			track({ id: "a", startMs: 0, endMs: 4000 }),
			track({ id: "b", startMs: 8000, endMs: 12_000 }),
		]);
		// Dragged from 8s back to 2s, where "a" already sits. A move must never CROP a
		// take: the user asked to move it, not to shorten it.
		const next = placeAudioTrackInDocument(
			before,
			track({ id: "b", startMs: 2000, endMs: 6000 }),
			ids,
			"move",
		);
		const moved = audioLanePills(next.audioTracks, "voiceover").find(
			(p) => (p.trackId ?? p.id) === "b",
		);
		expect(moved?.endMs && moved.endMs - moved.startMs).toBe(4000);
		expect(moved?.startMs).toBe(4000);
	});

	it("stops a resized edge at the neighbour", () => {
		const before = doc([
			track({ id: "a", startMs: 0, endMs: 4000 }),
			track({ id: "b", startMs: 8000, endMs: 12_000 }),
		]);
		// Dragging "b"'s left edge back to 1s: it stops where "a" ends, and the head is
		// what moves, not the whole pill.
		const next = placeAudioTrackInDocument(
			before,
			track({ id: "b", startMs: 1000, endMs: 12_000 }),
			ids,
			"resize",
		);
		const resized = audioLanePills(next.audioTracks, "voiceover").find(
			(p) => (p.trackId ?? p.id) === "b",
		);
		expect([resized?.startMs, resized?.endMs]).toEqual([4000, 12_000]);
	});

	it("leaves a voiceover over a music bed alone", () => {
		// Different kinds, different rows: the normal case, and it must not clamp.
		const before = doc([track({ id: "bed", kind: "music", startMs: 0, endMs: 20_000 })]);
		const next = placeAudioTrackInDocument(
			before,
			track({ id: "vo", startMs: 3000, endMs: 7000 }),
			ids,
			"create",
		);
		expect(pills(next, "voiceover")).toEqual([[3000, 7000]]);
		expect(pills(next, "music")).toEqual([[0, 20_000]]);
	});

	it("does not merge two different files that happen to match", () => {
		// `regionIdentityKey` puts `assetId` in NON_IDENTITY_FIELDS, so two takes with the
		// same payload hash identically — reusing it here would splice them into one pill.
		const before = doc([track({ id: "a", assetId: "one", startMs: 0, endMs: 4000 })]);
		const next = placeAudioTrackInDocument(
			before,
			track({ id: "b", assetId: "two", startMs: 4000, endMs: 8000 }),
			ids,
			"create",
		);
		expect(collapseTracksToPills(next.audioTracks)).toHaveLength(2);
	});
});

describe("firstFreeHeadMs", () => {
	it("takes the head as given when nothing is in the way", () => {
		expect(firstFreeHeadMs([{ startMs: 10_000, endMs: 12_000 }], 2000, 4000)).toBe(2000);
	});

	it("slides past every pill that would overlap, in order", () => {
		const busy = [
			{ startMs: 0, endMs: 3000 },
			{ startMs: 3000, endMs: 5000 },
		];
		expect(firstFreeHeadMs(busy, 1000, 2000)).toBe(5000);
	});

	it("fits a pill into a gap big enough for it", () => {
		const busy = [
			{ startMs: 0, endMs: 2000 },
			{ startMs: 9000, endMs: 12_000 },
		];
		expect(firstFreeHeadMs(busy, 2000, 3000)).toBe(2000);
	});
});

describe("separateAudioLanes", () => {
	it("pushes a pill whose head fell inside its predecessor forward", () => {
		// What a clip reorder can do with no audio code running.
		const overlapped = [
			track({ id: "a", startMs: 0, endMs: 5000 }),
			track({ id: "b", startMs: 3000, endMs: 6000 }),
		];
		expect(separateAudioLanes(overlapped).map((t) => [t.startMs, t.endMs])).toEqual([
			[0, 5000],
			[5000, 8000],
		]);
	});

	it("is idempotent, and leaves a document that is already separated alone", () => {
		const fine = [
			track({ id: "a", startMs: 0, endMs: 4000 }),
			track({ id: "b", startMs: 4000, endMs: 8000 }),
		];
		expect(separateAudioLanes(fine)).toBe(fine); // same reference: nothing to do
		const once = separateAudioLanes([
			track({ id: "a", startMs: 0, endMs: 5000 }),
			track({ id: "b", startMs: 1000, endMs: 4000 }),
		]);
		expect(separateAudioLanes(once)).toBe(once);
	});

	it("separates each kind on its own, never against the other", () => {
		const mixed = [
			track({ id: "vo", startMs: 0, endMs: 5000 }),
			track({ id: "bed", kind: "music", startMs: 1000, endMs: 9000 }),
		];
		// They overlap, and they should: they are different rows.
		expect(separateAudioLanes(mixed)).toBe(mixed);
	});

	it("keeps every fragment of a split take moving together", () => {
		const split = [
			track({ id: "a", startMs: 0, endMs: 6000 }),
			track({ id: "b1", trackId: "b", startMs: 2000, endMs: 4000 }),
			track({ id: "b2", trackId: "b", startMs: 4000, endMs: 7000 }),
		];
		const out = separateAudioLanes(split);
		// The pill moves as one thing; its halves do not drift apart.
		expect(out.filter((t) => t.trackId === "b").map((t) => [t.startMs, t.endMs])).toEqual([
			[6000, 8000],
			[8000, 11_000],
		]);
	});
});
