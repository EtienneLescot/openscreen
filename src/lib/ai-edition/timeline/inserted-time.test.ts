// The ruler arithmetic behind an added word's pause.
//
// The one thing these have to pin: stored raw seconds and the seconds the user scrubs stop
// being the same number the moment a pause exists, and every reader that confuses the two
// puts a region, a playhead or a caption in the wrong place. The pair is an inverse
// everywhere except inside a pause — which is not a gap in the model, it is the pause.

import { describe, expect, it } from "vitest";
import type { AxcutClip, AxcutInsertRange, AxcutWord } from "../schema";
import {
	collapseRawSec,
	expandRawSec,
	insertedWordMarks,
	insertionEnteredBetween,
	type RulerInsert,
	rulerInserts,
	totalInsertedSec,
} from "./inserted-time";

function clip(overrides: Partial<AxcutClip> & Pick<AxcutClip, "id">): AxcutClip {
	return {
		assetId: "a1",
		sourceStartSec: 0,
		sourceEndSec: 10,
		timelineStartSec: 0,
		timelineEndSec: 10,
		wordRefs: [],
		origin: "user",
		reason: "",
		...overrides,
	};
}

function insert(overrides: Partial<AxcutInsertRange> = {}): AxcutInsertRange {
	return {
		id: "ins_1",
		assetId: "a1",
		atSec: 4,
		durationSec: 0.5,
		wordId: "synth_1",
		reason: "",
		origin: "user",
		...overrides,
	};
}

describe("rulerInserts", () => {
	it("projects a pause through the clip that plays its moment", () => {
		// The clip plays source 4–10 starting at ruler 20, so source 6 is ruler 22.
		const clips = [clip({ id: "c1", sourceStartSec: 4, timelineStartSec: 20, timelineEndSec: 26 })];
		expect(rulerInserts([insert({ atSec: 6 })], clips)).toEqual([
			{ id: "ins_1", wordId: "synth_1", atRawSec: 22, durationSec: 0.5 },
		]);
	});

	// The word is not on the timeline, so its pause has no place on the ruler and adds
	// nothing — the same rule a caption line follows when no clip covers it.
	it("drops a pause no clip plays", () => {
		const clips = [clip({ id: "c1", sourceStartSec: 0, sourceEndSec: 3, timelineEndSec: 3 })];
		expect(rulerInserts([insert({ atSec: 6 })], clips)).toEqual([]);
	});

	it("counts a pause sitting exactly on a clip's edge", () => {
		// A pause sits at the END of the word it follows, which is routinely the boundary.
		const clips = [clip({ id: "c1", sourceStartSec: 0, sourceEndSec: 4, timelineEndSec: 4 })];
		expect(rulerInserts([insert({ atSec: 4 })], clips)).toHaveLength(1);
	});

	it("returns them in ruler order, whatever order they were stored in", () => {
		const clips = [clip({ id: "c1" })];
		const placed = rulerInserts(
			[insert({ id: "b", atSec: 8 }), insert({ id: "a", atSec: 2 })],
			clips,
		);
		expect(placed.map((p) => p.id)).toEqual(["a", "b"]);
	});

	it("places a pause only once when two clips could play its moment", () => {
		const clips = [
			clip({ id: "c1" }),
			clip({ id: "c2", timelineStartSec: 10, timelineEndSec: 20 }),
		];
		expect(rulerInserts([insert()], clips)).toHaveLength(1);
	});
});

describe("the expanded ruler", () => {
	const INSERTS: RulerInsert[] = [
		{ id: "a", wordId: "w_a", atRawSec: 2, durationSec: 0.5 },
		{ id: "b", wordId: "w_b", atRawSec: 6, durationSec: 1 },
	];

	it("leaves everything before the first pause where it was", () => {
		expect(expandRawSec(0, INSERTS)).toBe(0);
		expect(expandRawSec(1.9, INSERTS)).toBe(1.9);
	});

	// The frame about to be held keeps its own instant; the pause opens after it.
	it("keeps the held moment itself in place", () => {
		expect(expandRawSec(2, INSERTS)).toBe(2);
	});

	it("shifts everything after a pause by what it added", () => {
		expect(expandRawSec(3, INSERTS)).toBe(3.5);
		expect(expandRawSec(6, INSERTS)).toBe(6.5);
		expect(expandRawSec(7, INSERTS)).toBe(8.5);
	});

	it("grows the ruler by the pauses' total", () => {
		expect(totalInsertedSec(INSERTS)).toBe(1.5);
		expect(expandRawSec(10, INSERTS)).toBe(10 + totalInsertedSec(INSERTS));
	});

	it("round-trips every moment that is not inside a pause", () => {
		for (const sec of [0, 1.9, 3, 5.99, 7, 10]) {
			const back = collapseRawSec(expandRawSec(sec, INSERTS), INSERTS);
			expect(back.sec).toBeCloseTo(sec, 9);
			expect(back.heldBy).toBeNull();
		}
	});

	// The held moment is the one place the pair is not a clean inverse, and it is not
	// meant to be: source 2 occupies the WHOLE of ruler [2, 2.5) — it is what the pause
	// shows. Expanding picks the start of that stretch; collapsing it back answers with
	// the same source moment and says it is being held, which is the honest reading of a
	// moment that is on screen for half a second.
	it("says the held moment is held, and still names the right source moment", () => {
		const back = collapseRawSec(expandRawSec(2, INSERTS), INSERTS);
		expect(back.sec).toBe(2);
		expect(back.heldBy?.id).toBe("a");
	});

	// Not a gap in the model — this IS the pause. A stretch of ruler stands for one held
	// source moment, and the caller is told which pause is holding it so it parks the
	// decoder instead of seeking through content that belongs after.
	it("collapses a moment inside a pause onto the frame being held", () => {
		for (const sec of [2.01, 2.25, 2.49]) {
			const back = collapseRawSec(sec, INSERTS);
			expect(back.sec).toBe(2);
			expect(back.heldBy?.id).toBe("a");
		}
	});

	it("resumes on the far side of a pause", () => {
		const back = collapseRawSec(2.5, INSERTS);
		expect(back.sec).toBe(2);
		expect(back.heldBy).toBeNull();
	});

	it("counts every earlier pause when collapsing a later moment", () => {
		// Ruler 8.5 is source 7: 0.5s from the first pause and 1s from the second.
		expect(collapseRawSec(8.5, INSERTS)).toEqual({ sec: 7, heldBy: null });
	});

	it("is the identity when there are no pauses", () => {
		expect(expandRawSec(4, [])).toBe(4);
		expect(collapseRawSec(4, [])).toEqual({ sec: 4, heldBy: null });
	});
});

// ─── Where an added word's mark goes ─────────────────────────────────────────
// Issue #560. Two defects lived in one ternary in V4Timeline: a word WITH a pause was
// placed on the expanded ruler and one WITHOUT at a fraction of the clip's SOURCE span —
// two clocks, and the clip box is drawn in neither of them consistently. And both edges
// were inclusive, so a word whose pause sits on a split boundary painted twice.

function markClip(over: Partial<AxcutClip> & { id: string }): AxcutClip {
	return {
		assetId: "a1",
		sourceStartSec: 0,
		sourceEndSec: 5,
		timelineStartSec: 0,
		timelineEndSec: 5,
		wordRefs: [],
		origin: "user",
		reason: "",
		...over,
	} as AxcutClip;
}

const synth = (id: string, startSec: number): AxcutWord =>
	({ id, segmentId: "s", text: id, startSec, endSec: startSec, source: "synth" }) as AxcutWord;

describe("insertedWordMarks", () => {
	const split = [
		markClip({
			id: "c1",
			sourceStartSec: 0,
			sourceEndSec: 5,
			timelineStartSec: 0,
			timelineEndSec: 5,
		}),
		markClip({
			id: "c2",
			sourceStartSec: 5,
			sourceEndSec: 10,
			timelineStartSec: 5,
			timelineEndSec: 10,
		}),
	];

	it("paints a word on a split boundary exactly once", () => {
		const marks = insertedWordMarks([{ assetId: "a1", words: [synth("w_edge", 5)] }], split);
		expect(marks).toHaveLength(1);
		expect(marks[0]).toMatchObject({ clipId: "c2", atRawSec: 5 });
	});

	it("places every mark in RAW seconds through its own clip", () => {
		const marks = insertedWordMarks(
			[{ assetId: "a1", words: [synth("early", 2), synth("late", 7)] }],
			split,
		);
		expect(marks.map((m) => [m.clipId, m.atRawSec])).toEqual([
			["c1", 2],
			["c2", 7],
		]);
	});

	it("keeps a word at the very end of the last clip", () => {
		// Half-open everywhere but the tail, or the final word of a project vanishes.
		const marks = insertedWordMarks([{ assetId: "a1", words: [synth("w_end", 10)] }], split);
		expect(marks.map((m) => m.wordId)).toEqual(["w_end"]);
	});

	it("ignores words nobody added", () => {
		const spoken = { id: "w1", segmentId: "s", text: "w1", startSec: 2, endSec: 3 } as AxcutWord;
		expect(insertedWordMarks([{ assetId: "a1", words: [spoken] }], split)).toEqual([]);
	});

	it("ignores a transcript no clip draws on", () => {
		expect(insertedWordMarks([{ assetId: "other", words: [synth("w1", 2)] }], split)).toEqual([]);
	});
});

// ─── The scrub round-trip ───────────────────────────────────────────────────
// The timeline measures the pointer against the EXPANDED ruler and writes the result into
// a store every consumer reads as a RAW second — the preview seek, the caption lookup, the
// transcript cue, the audio mix. Straight through, the playhead sat one accumulated pause
// AHEAD of everything it pointed at: the right playhead, the wrong subtitle (issue #560).

describe("a scrub survives the round trip", () => {
	const marks: RulerInsert[] = [
		{ id: "i1", wordId: "w1", atRawSec: 4, durationSec: 2 },
		{ id: "i2", wordId: "w2", atRawSec: 9, durationSec: 1 },
	];

	it("comes back to the raw second it started from, before and after each pause", () => {
		for (const raw of [0, 1.5, 3.9, 6, 8.5, 12, 30]) {
			expect(collapseRawSec(expandRawSec(raw, marks), marks).sec).toBeCloseTo(raw, 6);
		}
	});

	it("lands on the held moment for a pointer inside a pause, and says so", () => {
		// Every ruler second inside an insertion is the same raw moment: none of those
		// seconds come from the recording, so there is nothing else it could mean.
		const inside = collapseRawSec(5, marks);
		expect(inside.sec).toBeCloseTo(4, 6);
		expect(inside.heldBy?.id).toBe("i1");
		expect(collapseRawSec(5.9, marks).sec).toBeCloseTo(4, 6);
	});

	it("counts every pause before the pointer, not just the first", () => {
		// Ruler 13 is past both: 13 − 2 − 1 = raw 10.
		expect(collapseRawSec(13, marks).sec).toBeCloseTo(10, 6);
		expect(collapseRawSec(13, marks).heldBy).toBeNull();
	});
});

// ─── Running into an insertion ──────────────────────────────────────────────
// An added word inserts MEDIA inside the clip — a fixed frame and silence, until there is
// a generator for it. Playback runs THROUGH that media, and the half-open rule below is
// what keeps it from running through the same insertion forever.

describe("the insertion a frame runs into", () => {
	const marks: RulerInsert[] = [
		{ id: "i1", wordId: "w1", atRawSec: 4, durationSec: 2 },
		{ id: "i2", wordId: "w2", atRawSec: 9, durationSec: 1 },
	];

	it("is found when the frame crosses it", () => {
		expect(insertionEnteredBetween(3.98, 4.02, marks)?.id).toBe("i1");
		expect(insertionEnteredBetween(8.9, 9.1, marks)?.id).toBe("i2");
	});

	it("is not found again from the moment it occupies", () => {
		// While the insertion plays, the raw playhead stands still at exactly 4. Coming out,
		// the next frames must not re-enter — otherwise the film never gets past it.
		expect(insertionEnteredBetween(4, 4.02, marks)).toBeUndefined();
		expect(insertionEnteredBetween(4, 4.5, marks)).toBeUndefined();
	});

	it("takes the earliest of several in one frame, and none outside", () => {
		expect(insertionEnteredBetween(0, 20, marks)?.id).toBe("i1");
		expect(insertionEnteredBetween(5, 8, marks)).toBeUndefined();
	});

	it("plays an insertion landing exactly on the frame boundary", () => {
		expect(insertionEnteredBetween(3.9, 4, marks)?.id).toBe("i1");
	});
});
