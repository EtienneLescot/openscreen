import { describe, expect, it } from "vitest";
import { type AxcutAsset, type AxcutClip, createAudioTrack, createEmptyDocument } from "../schema";
import {
	anchorAudioTrackFragments,
	audioGhostExtent,
	collapseTracksToPills,
	packAudioTrackRows,
	patchAudioTrack,
	removeAudioTrack,
	resolveFadeSecs,
	slipAudioOffsetMs,
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
		const next = patchAudioTrack(doc, trackGroupId(frags[0]), {
			gainDb: -6,
			muted: true,
			// `loop` is the third payload key the patch spreads, and the one a half-applied
			// patch would break loudest: a track looping on one fragment and not the other
			// stops mid-take at the clip boundary.
			loop: true,
		});
		expect(next.audioTracks.map((t) => t.gainDb)).toEqual([-6, -6]);
		expect(next.audioTracks.every((t) => t.muted)).toBe(true);
		expect(next.audioTracks.every((t) => t.loop)).toBe(true);
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

describe("packAudioTrackRows", () => {
	const t = (id: string, startMs: number, endMs: number) => ({ id, startMs, endMs });

	it("keeps tracks that never overlap on one row", () => {
		// The common case stays a single-line lane.
		const { rowOf, rowCount } = packAudioTrackRows([
			t("a", 0, 1000),
			t("b", 1000, 2000),
			t("c", 5000, 6000),
		]);
		expect(rowCount).toBe(1);
		expect([rowOf.get("a"), rowOf.get("b"), rowOf.get("c")]).toEqual([0, 0, 0]);
	});

	it("stacks tracks that overlap, so neither hides the other", () => {
		const { rowOf, rowCount } = packAudioTrackRows([t("a", 0, 5000), t("b", 1000, 2000)]);
		expect(rowCount).toBe(2);
		expect(rowOf.get("a")).toBe(0);
		expect(rowOf.get("b")).toBe(1);
	});

	it("reuses a row as soon as it frees up", () => {
		// b overlaps a and goes to row 1; c starts after a ends, so it drops back
		// to row 0 rather than opening a third row.
		const { rowOf, rowCount } = packAudioTrackRows([
			t("a", 0, 3000),
			t("b", 1000, 9000),
			t("c", 4000, 5000),
		]);
		expect(rowCount).toBe(2);
		expect(rowOf.get("c")).toBe(0);
	});

	it("treats touching tracks as non-overlapping", () => {
		// One ending exactly where the next begins is a sequence, not a pile.
		const { rowCount } = packAudioTrackRows([t("a", 0, 1000), t("b", 1000, 2000)]);
		expect(rowCount).toBe(1);
	});

	it("always reports at least one row, even with nothing to place", () => {
		expect(packAudioTrackRows([]).rowCount).toBe(1);
	});
});

describe("audioGhostExtent", () => {
	// A 4s pill starting at ruler 10, showing the file from 2s, on a 60s file.
	const base = () => audioGhostExtent(2, 4, 60, 10, 14, 100);

	it("reaches back by the in-point and forward by what is left of the file", () => {
		const g = base();
		expect(g).not.toBeNull();
		// 2s of head before the pill, 54s of tail after it.
		expect(g?.startT).toBeCloseTo(8, 6);
		expect(g?.endT).toBeCloseTo(68, 6);
		// And the window it draws is the file's own, not the pill's.
		expect(g?.sourceStartSec).toBeCloseTo(0, 6);
		expect(g?.sourceEndSec).toBeCloseTo(60, 6);
	});

	it("stays inside the programme however long the file is", () => {
		// A four-minute bed under a short programme would otherwise ask for an element
		// tens of screens wide. Clamped at both ends.
		const g = audioGhostExtent(2, 4, 600, 10, 14, 20);
		expect(g?.startT).toBeCloseTo(8, 6);
		expect(g?.endT).toBe(20);
	});

	it("refuses when there is nothing around the pill to show", () => {
		// The pill already shows the whole file.
		expect(audioGhostExtent(0, 60, 60, 0, 60, 100)).toBeNull();
	});

	it("refuses an unknown duration rather than drawing a bound it cannot measure", () => {
		// Same rule as the edge stops: a failed probe must never invent a limit.
		expect(audioGhostExtent(0, 4, null, 0, 4, 100)).toBeNull();
		expect(audioGhostExtent(0, 4, undefined, 0, 4, 100)).toBeNull();
		expect(audioGhostExtent(0, 4, 0, 0, 4, 100)).toBeNull();
	});
});

describe("slipAudioOffsetMs", () => {
	it("slides the in-point by the delta it is given", () => {
		expect(slipAudioOffsetMs(10_000, 4_000, 60, 5_000)).toBe(15_000);
		expect(slipAudioOffsetMs(10_000, 4_000, 60, -5_000)).toBe(5_000);
	});

	it("never windows past either end of the file", () => {
		// Past the head is negative source time; past the tail is silence nobody asked
		// for. The last legal in-point is duration - span.
		expect(slipAudioOffsetMs(2_000, 4_000, 60, -10_000)).toBe(0);
		expect(slipAudioOffsetMs(50_000, 4_000, 60, 999_000)).toBe(56_000);
	});

	it("refuses a file no longer than the window onto it", () => {
		expect(slipAudioOffsetMs(0, 60_000, 60, 5_000)).toBeNull();
		expect(slipAudioOffsetMs(0, 90_000, 60, 5_000)).toBeNull();
	});

	it("refuses an unknown duration", () => {
		expect(slipAudioOffsetMs(0, 4_000, null, 5_000)).toBeNull();
		expect(slipAudioOffsetMs(0, 4_000, 0, 5_000)).toBeNull();
		// `undefined` is its own branch: an asset whose duration has never been probed
		// carries no key at all, which is not the same shape as a stored null.
		expect(slipAudioOffsetMs(0, 4_000, undefined, 5_000)).toBeNull();
	});

	it("returns whole milliseconds, which is what the schema stores", () => {
		// `offsetMs` is `z.number().int()`; a fractional slip would fail the parse on
		// the next save rather than at the gesture.
		expect(Number.isInteger(slipAudioOffsetMs(0, 4_000, 60, 1234.567) ?? 0)).toBe(true);
	});
});
