import { describe, expect, it } from "vitest";
import { type AxcutAsset, type AxcutClip, createAudioTrack, createEmptyDocument } from "../schema";
import {
	anchorAudioTrackFragments,
	collapseTracksToPills,
	patchAudioTrack,
	removeAudioTrack,
	resolveFadeSecs,
	trackGroupId,
} from "./audioTracks";

const emptyDoc = () => createEmptyDocument({ projectId: "p", title: "t" });

function clip(id: string, timelineStartSec: number, lengthSec: number): AxcutClip {
	return {
		id,
		assetId: "video_1",
		sourceStartSec: 0,
		sourceEndSec: lengthSec,
		timelineStartSec,
		timelineEndSec: timelineStartSec + lengthSec,
		wordRefs: [],
		origin: "user",
		reason: "",
	};
}

// Two 10s clips back to back: a track crossing second 10 is ventilated in two.
const twoClips = [clip("c1", 0, 10), clip("c2", 10, 10)];

let seq = 0;
const makeId = () => `frag_${++seq}`;

const track = (over: Partial<ReturnType<typeof createAudioTrack>> = {}) => ({
	...createAudioTrack({ assetId: "asset_1", durationSec: 30, timelineStartSec: 5, spanSec: 10 }),
	...over,
});

const audioAsset: AxcutAsset = {
	id: "asset_1",
	kind: "audio",
	label: "BGM",
	originalPath: "/bgm.mp3",
	cameraTrack: null,
};

describe("anchorAudioTrackFragments", () => {
	it("leaves a track that fits inside one clip as a single fragment", () => {
		const frags = anchorAudioTrackFragments(
			track({ startMs: 1000, endMs: 6000 }),
			twoClips,
			makeId,
		);
		expect(frags).toHaveLength(1);
		expect(frags[0].clipId).toBe("c1");
		expect(frags[0].offsetMs).toBe(0);
	});

	it("advances each fragment's source offset by the time its predecessors played", () => {
		// 5s..15s spans the c1/c2 boundary at 10s: 5s of source, then the next 5s.
		const frags = anchorAudioTrackFragments(
			track({ startMs: 5000, endMs: 15_000, offsetMs: 2000 }),
			twoClips,
			makeId,
		);
		expect(frags).toHaveLength(2);
		expect(frags.map((f) => f.clipId)).toEqual(["c1", "c2"]);
		// Fragment 1 starts the file at the track's own offset...
		expect(frags[0].offsetMs).toBe(2000);
		// ...and fragment 2 picks up where it left off, rather than restarting
		// there — that restart is what made a bed audibly repeat at every cut.
		expect(frags[1].offsetMs).toBe(7000);
	});

	it("keeps the fades on the outer edges only", () => {
		const frags = anchorAudioTrackFragments(
			track({ startMs: 5000, endMs: 15_000, fadeInMs: 500, fadeOutMs: 800 }),
			twoClips,
			makeId,
		);
		expect(frags.map((f) => [f.fadeInMs, f.fadeOutMs])).toEqual([
			[500, 0],
			[0, 800],
		]);
	});

	it("does not advance the offset of a looping track", () => {
		// Looping folds within `duration - offset`, which every fragment shares;
		// an advanced offset would shorten the window and drift out of phase.
		const frags = anchorAudioTrackFragments(
			track({ startMs: 5000, endMs: 15_000, offsetMs: 1000, loop: true }),
			twoClips,
			makeId,
		);
		expect(frags.map((f) => f.offsetMs)).toEqual([1000, 1000]);
	});

	it("ties every fragment to one group id", () => {
		const frags = anchorAudioTrackFragments(
			track({ startMs: 5000, endMs: 15_000 }),
			twoClips,
			makeId,
		);
		const groups = new Set(frags.map(trackGroupId));
		expect(groups.size).toBe(1);
	});

	it("returns the track unanchored when no clip is under it", () => {
		const frags = anchorAudioTrackFragments(track({ startMs: 5000, endMs: 15_000 }), [], makeId);
		expect(frags).toHaveLength(1);
		expect(frags[0].clipId).toBeUndefined();
	});
});

describe("collapseTracksToPills", () => {
	it("folds a ventilated track back into one span with its real offset", () => {
		const frags = anchorAudioTrackFragments(
			track({ startMs: 5000, endMs: 15_000, offsetMs: 2000, fadeInMs: 400, fadeOutMs: 600 }),
			twoClips,
			makeId,
		);
		const [pill] = collapseTracksToPills(frags);
		expect(pill.startMs).toBe(5000);
		expect(pill.endMs).toBe(15_000);
		// The FIRST fragment's offset is the track's own; the later ones hold
		// advanced copies that must not leak back into the pill.
		expect(pill.offsetMs).toBe(2000);
		expect([pill.fadeInMs, pill.fadeOutMs]).toEqual([400, 600]);
		expect(pill.clipId).toBeUndefined();
	});

	it("round-trips through anchoring unchanged", () => {
		const original = track({ startMs: 5000, endMs: 15_000, offsetMs: 2000 });
		const once = anchorAudioTrackFragments(original, twoClips, makeId);
		const twice = anchorAudioTrackFragments(collapseTracksToPills(once)[0], twoClips, makeId);
		expect(twice.map((f) => [f.startMs, f.endMs, f.offsetMs])).toEqual(
			once.map((f) => [f.startMs, f.endMs, f.offsetMs]),
		);
	});
});

describe("removeAudioTrack", () => {
	it("drops every fragment of the track and is a no-op for unknown ids", () => {
		const frags = anchorAudioTrackFragments(
			track({ startMs: 5000, endMs: 15_000 }),
			twoClips,
			makeId,
		);
		const doc = { ...emptyDoc(), audioTracks: frags };
		expect(removeAudioTrack(doc, trackGroupId(frags[0])).audioTracks).toEqual([]);
		expect(removeAudioTrack(doc, "nope").audioTracks).toEqual(frags);
	});

	it("also drops the track's asset when nothing else references it", () => {
		const t = track();
		const doc = { ...emptyDoc(), audioTracks: [t], assets: [audioAsset] };
		const next = removeAudioTrack(doc, t.id);
		expect(next.audioTracks).toEqual([]);
		expect(next.assets).toEqual([]);
	});

	it("keeps the asset when another track still references it", () => {
		const t1 = track();
		const t2 = track({ id: "audio_other" });
		const doc = { ...emptyDoc(), audioTracks: [t1, t2], assets: [audioAsset] };
		expect(removeAudioTrack(doc, t1.id).assets).toEqual([audioAsset]);
	});
});

describe("patchAudioTrack", () => {
	it("applies a payload edit to every fragment", () => {
		const frags = anchorAudioTrackFragments(
			track({ startMs: 5000, endMs: 15_000 }),
			twoClips,
			makeId,
		);
		const doc = { ...emptyDoc(), audioTracks: frags };
		const next = patchAudioTrack(doc, trackGroupId(frags[0]), { gainDb: -6, muted: true });
		expect(next.audioTracks.map((t) => t.gainDb)).toEqual([-6, -6]);
		expect(next.audioTracks.every((t) => t.muted)).toBe(true);
	});

	it("keeps fades on the outer edges when they are edited", () => {
		const frags = anchorAudioTrackFragments(
			track({ startMs: 5000, endMs: 15_000 }),
			twoClips,
			makeId,
		);
		const doc = { ...emptyDoc(), audioTracks: frags };
		const next = patchAudioTrack(doc, trackGroupId(frags[0]), { fadeInMs: 300, fadeOutMs: 400 });
		expect(next.audioTracks.map((t) => [t.fadeInMs, t.fadeOutMs])).toEqual([
			[300, 0],
			[0, 400],
		]);
	});

	it("shifts the whole track by the offset delta, preserving each advance", () => {
		const frags = anchorAudioTrackFragments(
			track({ startMs: 5000, endMs: 15_000, offsetMs: 2000 }),
			twoClips,
			makeId,
		);
		const doc = { ...emptyDoc(), audioTracks: frags };
		// 2000 → 3000 is +1000 everywhere; fragment 2 keeps its 5000ms advance.
		const next = patchAudioTrack(doc, trackGroupId(frags[0]), { offsetMs: 3000 });
		expect(next.audioTracks.map((t) => t.offsetMs)).toEqual([3000, 8000]);
	});

	it("leaves other tracks untouched", () => {
		const a = track({ id: "audio_a" });
		const b = track({ id: "audio_b" });
		const doc = { ...emptyDoc(), audioTracks: [a, b] };
		const next = patchAudioTrack(doc, "audio_b", { gainDb: -6 });
		expect(next.audioTracks[0]).toEqual(a);
		expect(next.audioTracks[1]?.gainDb).toBe(-6);
	});
});

describe("resolveFadeSecs", () => {
	it("passes fades that fit through untouched", () => {
		expect(resolveFadeSecs(1000, 2000, 10)).toEqual({ fadeInSec: 1, fadeOutSec: 2 });
	});

	it("shrinks a fade-in longer than the span to the span", () => {
		// Unreduced this holds the gain at zero for the whole track.
		expect(resolveFadeSecs(5000, 0, 2)).toEqual({ fadeInSec: 2, fadeOutSec: 0 });
	});

	it("shares the span in proportion when both fades overflow", () => {
		const { fadeInSec, fadeOutSec } = resolveFadeSecs(6000, 4000, 2);
		expect(fadeInSec).toBeCloseTo(1.2);
		expect(fadeOutSec).toBeCloseTo(0.8);
	});
});
