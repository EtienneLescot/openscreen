// Issue #560. A take loses time to a cut and gains it to an insertion, and the two must be
// one walk: resolved in two passes, an insertion's raw moment would be computed without the
// holds before it and land in the wrong place.
//
// The load-bearing property is the demotion: with no insertions this must agree with
// `subtractRemoved` exactly, because that is what the export and the preview already do and
// their answers must not move.

import { describe, expect, it } from "vitest";
import { rawSpanForOutDuration } from "../document/timeline";
import type { AxcutAudioTrack, AxcutClip, AxcutTrimRange } from "../schema";
import { removedRawSpans, subtractRemoved } from "./programme-time";
import { consumedSourceSec, takePlaybackAt, takeProgramme } from "./take-programme";

const CLIPS: AxcutClip[] = [
	{
		id: "c1",
		assetId: "rec",
		sourceStartSec: 0,
		sourceEndSec: 20,
		timelineStartSec: 0,
		timelineEndSec: 20,
		wordRefs: [],
		origin: "user",
		reason: "",
	},
];

const trim = (startSec: number, endSec: number, id = "t1"): AxcutTrimRange =>
	({
		id,
		assetId: "rec",
		clipId: "c1",
		startSec,
		endSec,
		origin: "user",
		reason: "",
	}) as AxcutTrimRange;

/** A take from raw 0 to raw 10, reading its file from the head. */
const TAKE = { startMs: 0, endMs: 10_000, offsetMs: 0 } as Pick<
	AxcutAudioTrack,
	"startMs" | "endMs" | "offsetMs"
>;

const ins = (atSourceSec: number, durationSec: number, id = "i1") => ({
	id,
	wordId: `w_${id}`,
	atSourceSec,
	durationSec,
});

const shape = (pieces: ReturnType<typeof takeProgramme>) =>
	pieces.map((p) => [p.kind, p.rawStartSec, p.rawEndSec, p.sourceStartSec, p.sourceEndSec]);

describe("takeProgramme", () => {
	it("is exactly subtractRemoved when nothing is inserted", () => {
		// The demotion. Every fixture the export and the preview already agree on has to
		// keep its current answer.
		for (const cuts of [
			[] as AxcutTrimRange[],
			[trim(3, 5)],
			[trim(0, 2)],
			[trim(8, 12)],
			[trim(2, 3), trim(6, 7, "t2")],
		]) {
			const removed = removedRawSpans(CLIPS, cuts);
			const played = takeProgramme(TAKE, removed, [])
				.filter((p) => p.kind === "play")
				.map((p) => [p.rawStartSec, p.rawEndSec]);
			const expected = subtractRemoved(0, 10, removed).map((s) => [s.startSec, s.endSec]);
			expect(played).toEqual(expected);
		}
	});

	it("parks the voice for an insertion and resumes on the same word", () => {
		const pieces = takeProgramme(TAKE, [], [ins(4, 1)]);
		expect(shape(pieces)).toEqual([
			["play", 0, 4, 0, 4],
			["hold", 4, 5, 4, 4],
			["play", 5, 10, 4, 9],
		]);
		// The take consumed 9 seconds of its file, not 10: the second the pause took is
		// pushed off the end and lost, which is the accepted cost of the clips deciding
		// the length.
		expect(consumedSourceSec(pieces)).toBeCloseTo(9, 6);
	});

	it("resolves the second insertion AFTER the first one's hold, not before it", () => {
		// The case a two-pass design gets wrong: mapped up front, source 6 would be raw 6,
		// which is inside the first hold.
		const pieces = takeProgramme(TAKE, [], [ins(4, 1, "a"), ins(6, 1, "b")]);
		expect(shape(pieces)).toEqual([
			["play", 0, 4, 0, 4],
			["hold", 4, 5, 4, 4],
			["play", 5, 7, 4, 6],
			["hold", 7, 8, 6, 6],
			["play", 8, 10, 6, 8],
		]);
	});

	it("makes two insertions at one moment two adjacent holds, with no empty play between", () => {
		const pieces = takeProgramme(TAKE, [], [ins(4, 1, "a"), ins(4, 0.5, "b")]);
		expect(pieces.map((p) => p.kind)).toEqual(["play", "hold", "hold", "play"]);
		expect(pieces.filter((p) => p.kind === "hold").map((p) => p.holdId)).toEqual(["a", "b"]);
		expect(pieces.some((p) => p.rawEndSec === p.rawStartSec)).toBe(false);
	});

	it("gives nothing to an insertion a cut swallowed", () => {
		const removed = removedRawSpans(CLIPS, [trim(3, 6)]);
		const withIt = takeProgramme(TAKE, removed, [ins(4, 1)]);
		const without = takeProgramme(TAKE, removed, []);
		// The moment it holds is not in the film any more, so it buys no time.
		expect(withIt.some((p) => p.kind === "hold")).toBe(false);
		expect(shape(withIt)).toEqual(shape(without));
	});

	it("keeps an insertion on a cut's far edge, which is what follows the cut", () => {
		const removed = removedRawSpans(CLIPS, [trim(3, 6)]);
		const pieces = takeProgramme(TAKE, removed, [ins(6, 1)]);
		expect(pieces.map((p) => p.kind)).toEqual(["play", "removed", "hold", "play"]);
	});

	it("drops an insertion at or past the take's last moment", () => {
		expect(takeProgramme(TAKE, [], [ins(10, 1)]).some((p) => p.kind === "hold")).toBe(false);
		expect(takeProgramme(TAKE, [], [ins(30, 1)]).some((p) => p.kind === "hold")).toBe(false);
	});

	it("ignores an insertion of no duration", () => {
		expect(takeProgramme(TAKE, [], [ins(4, 0)]).map((p) => p.kind)).toEqual(["play"]);
	});

	it("spends a pause on the take's own clock under a speed region", () => {
		// A voice plays at 1x in the mix. Under a 2x region a one-second pause has to eat
		// TWO raw seconds to last one second of programme.
		const speed = [{ startMs: 0, endMs: 20_000, speed: 2 }];
		const pieces = takeProgramme(TAKE, [], [ins(4, 1)], speed);
		const hold = pieces.find((p) => p.kind === "hold");
		expect(hold && hold.rawEndSec - hold.rawStartSec).toBeCloseTo(2, 6);
	});
});

describe("rawSpanForOutDuration", () => {
	it("is the identity with no regions", () => {
		expect(rawSpanForOutDuration(3, 2)).toBe(2);
	});

	it("inverts outputDurationOfRawSpan across a boundary", () => {
		const speed = [{ startMs: 4000, endMs: 8000, speed: 2 }];
		// From raw 3: one output second buys 1 raw second before the region, then the rest
		// at 2x. Two output seconds = 1 + 2 = 3 raw seconds.
		expect(rawSpanForOutDuration(3, 2, speed)).toBeCloseTo(3, 6);
	});

	it("returns zero for a non-positive duration", () => {
		expect(rawSpanForOutDuration(0, 0)).toBe(0);
		expect(rawSpanForOutDuration(0, -1)).toBe(0);
	});
});

describe("takePlaybackAt", () => {
	const pieces = takeProgramme(TAKE, removedRawSpans(CLIPS, [trim(7, 8)]), [ins(4, 1)]);

	it("plays the file where the file plays", () => {
		expect(takePlaybackAt(pieces, 2)).toMatchObject({ targetTimeSec: 2, shouldPlay: true });
	});

	it("parks on one moment inside the pause rather than tracking a moving target", () => {
		expect(takePlaybackAt(pieces, 4.5)).toMatchObject({
			targetTimeSec: 4,
			shouldPlay: false,
			heldBy: "i1",
		});
	});

	it("keeps the clock running through a cut, silently", () => {
		// Raw 7.5 is one second past the pause, so the file is at 6.5 — and muted.
		expect(takePlaybackAt(pieces, 7.5)).toMatchObject({ targetTimeSec: 6.5, shouldPlay: false });
	});

	it("has nothing to say outside the take", () => {
		expect(takePlaybackAt(pieces, 12)).toBeNull();
	});
});

// ─── The preview and the export, held to each other ─────────────────────────
// They read the same walk now, but "the same walk" is a claim about wiring. This walks the
// take frame by frame the way the rAF does and asserts the runs of source time it would
// play are the entries the export emits, piece for piece.

describe("preview and export agree over a take with a cut and a pause", () => {
	const removed = removedRawSpans(CLIPS, [trim(7, 8)]);
	const pieces = takeProgramme(TAKE, removed, [ins(4, 1)]);

	it("plays exactly the play pieces, and nothing between them", () => {
		const runs: Array<{ from: number; to: number }> = [];
		// A run breaks on SILENCE, not on a jump in source time. Across a pause the source
		// is deliberately continuous — the voice resumes on the word it stopped on — so a
		// detector watching only the source would merge the two halves and see one run.
		let wasPlaying = false;
		for (let raw = 0; raw < 10; raw += 0.05) {
			const at = takePlaybackAt(pieces, raw);
			if (!at?.shouldPlay) {
				wasPlaying = false;
				continue;
			}
			const last = runs.at(-1);
			if (wasPlaying && last && Math.abs(at.targetTimeSec - last.to) < 0.06) {
				last.to = at.targetTimeSec;
			} else {
				runs.push({ from: at.targetTimeSec, to: at.targetTimeSec });
			}
			wasPlaying = true;
		}
		const entries = pieces
			.filter((p) => p.kind === "play")
			.map((p) => [p.sourceStartSec, p.sourceEndSec]);
		expect(runs).toHaveLength(entries.length);
		runs.forEach((run, i) => {
			expect(run.from).toBeCloseTo(entries[i][0], 1);
			expect(run.to).toBeCloseTo(entries[i][1], 1);
		});
	});

	it("never re-seeks while the voice is parked", () => {
		// One value for the whole pause: a target that drifted would re-seek a paused
		// element every frame, and resuming would restart on the wrong word.
		const inside = [4.1, 4.3, 4.5, 4.7, 4.9].map((raw) => takePlaybackAt(pieces, raw));
		expect(inside.every((at) => at?.shouldPlay === false)).toBe(true);
		expect(new Set(inside.map((at) => at?.targetTimeSec)).size).toBe(1);
	});

	it("resumes on the second it stopped on", () => {
		const parked = takePlaybackAt(pieces, 4.5)?.targetTimeSec;
		const resumed = takePlaybackAt(pieces, 5.01)?.targetTimeSec;
		expect(resumed).toBeCloseTo(parked ?? -1, 1);
	});
});
