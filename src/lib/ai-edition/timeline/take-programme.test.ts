// Issue #560. A take loses time to a cut and gains it to an insertion, and the two must be
// one walk: resolved in two passes, an insertion's raw moment would be computed without the
// holds before it and land in the wrong place.
//
// The load-bearing property is the demotion: with no insertions this must agree with
// `subtractRemoved` exactly, because that is what the export and the preview already do and
// their answers must not move.

import { describe, expect, it } from "vitest";
import type { AxcutAudioTrack, AxcutClip, AxcutTrimRange } from "../schema";
import { removedRawSpans, subtractRemoved } from "./programme-time";
import { takePlaybackAt, takeProgramme } from "./take-programme";

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
			const played = takeProgramme(TAKE, removed)
				.filter((p) => p.kind === "play")
				.map((p) => [p.rawStartSec, p.rawEndSec]);
			const expected = subtractRemoved(0, 10, removed).map((s) => [s.startSec, s.endSec]);
			expect(played).toEqual(expected);
		}
	});
});

describe("takePlaybackAt", () => {
	const pieces = takeProgramme(TAKE, removedRawSpans(CLIPS, [trim(7, 8)]));

	it("plays the file where the file plays", () => {
		expect(takePlaybackAt(pieces, 2)).toMatchObject({ targetTimeSec: 2, shouldPlay: true });
	});

	it("has nothing to say outside the take", () => {
		expect(takePlaybackAt(pieces, 12)).toBeNull();
	});
});

// ─── The preview and the export, held to each other ─────────────────────────
// They read the same walk now, but "the same walk" is a claim about wiring. This walks the
// take frame by frame the way the rAF does and asserts the runs of source time it would
// play are the entries the export emits, piece for piece.
