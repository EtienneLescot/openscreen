// The ruler arithmetic behind an added word's pause.
//
// The one thing these have to pin: stored raw seconds and the seconds the user scrubs stop
// being the same number the moment a pause exists, and every reader that confuses the two
// puts a region, a playhead or a caption in the wrong place. The pair is an inverse
// everywhere except inside a pause — which is not a gap in the model, it is the pause.

import { describe, expect, it } from "vitest";
import type { AxcutClip, AxcutInsertRange, AxcutWord } from "../schema";
import {
	insertedWordMarks,
	insertionEnteredBetween,
	type RulerInsert,
	rulerInserts,
	sourceToTimelineSec,
	timelineToSourceSec,
} from "./inserted-time";

function clipFixture(overrides: Partial<AxcutClip> & Pick<AxcutClip, "id">): AxcutClip {
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
		const clips = [
			clipFixture({ id: "c1", sourceStartSec: 4, timelineStartSec: 20, timelineEndSec: 26 }),
		];
		expect(rulerInserts([insert({ atSec: 6 })], clips)).toEqual([
			{ id: "ins_1", wordId: "synth_1", atRawSec: 22, durationSec: 0.5 },
		]);
	});

	// The word is not on the timeline, so its pause has no place on the ruler and adds
	// nothing — the same rule a caption line follows when no clip covers it.
	it("drops a pause no clip plays", () => {
		const clips = [
			clipFixture({ id: "c1", sourceStartSec: 0, sourceEndSec: 3, timelineEndSec: 3 }),
		];
		expect(rulerInserts([insert({ atSec: 6 })], clips)).toEqual([]);
	});

	it("counts a pause sitting exactly on a clip's edge", () => {
		// A pause sits at the END of the word it follows, which is routinely the boundary.
		const clips = [
			clipFixture({ id: "c1", sourceStartSec: 0, sourceEndSec: 4, timelineEndSec: 4 }),
		];
		expect(rulerInserts([insert({ atSec: 4 })], clips)).toHaveLength(1);
	});

	it("returns them in ruler order, whatever order they were stored in", () => {
		const clips = [clipFixture({ id: "c1" })];
		const placed = rulerInserts(
			[insert({ id: "b", atSec: 8 }), insert({ id: "a", atSec: 2 })],
			clips,
		);
		expect(placed.map((p) => p.id)).toEqual(["a", "b"]);
	});

	it("places a pause only once when two clips could play its moment", () => {
		const clips = [
			clipFixture({ id: "c1" }),
			clipFixture({ id: "c2", timelineStartSec: 10, timelineEndSec: 20 }),
		];
		expect(rulerInserts([insert()], clips)).toHaveLength(1);
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
		const marks = insertedWordMarks([{ assetId: "a1", words: [synth("w_edge", 5)] }], split, []);
		expect(marks).toHaveLength(1);
		expect(marks[0]).toMatchObject({ clipId: "c2", atRawSec: 5 });
	});

	it("places every mark in RAW seconds through its own clip", () => {
		const marks = insertedWordMarks(
			[{ assetId: "a1", words: [synth("early", 2), synth("late", 7)] }],
			split,
			[],
		);
		expect(marks.map((m) => [m.clipId, m.atRawSec])).toEqual([
			["c1", 2],
			["c2", 7],
		]);
	});

	it("keeps a word at the very end of the last clip", () => {
		// Half-open everywhere but the tail, or the final word of a project vanishes.
		const marks = insertedWordMarks([{ assetId: "a1", words: [synth("w_end", 10)] }], split, []);
		expect(marks.map((m) => m.wordId)).toEqual(["w_end"]);
	});

	it("ignores words nobody added", () => {
		const spoken = { id: "w1", segmentId: "s", text: "w1", startSec: 2, endSec: 3 } as AxcutWord;
		expect(insertedWordMarks([{ assetId: "a1", words: [spoken] }], split, [])).toEqual([]);
	});

	it("ignores a transcript no clip draws on", () => {
		expect(insertedWordMarks([{ assetId: "other", words: [synth("w1", 2)] }], split, [])).toEqual(
			[],
		);
	});
});

// ─── Source ↔ timeline, inside one clip ─────────────────────────────────────
// The whole consequence of an insertion being MEDIA: the clip is longer than its source
// window, so a moment past an insertion sits that much further along the timeline. Every
// place that used to convert between a "raw" and an "expanded" ruler is asking this, of
// one clip — and getting it wrong put a caption, a playhead or a decoder in the wrong
// place (issue #560).

describe("source ↔ timeline through a clip that carries insertions", () => {
	// Ten seconds of recording laid at timeline 0, with 0.5s inserted at source 2 and 1s
	// at source 6 — so the clip is 11.5s long and its source window is untouched.
	const clip = clipFixture({
		id: "c1",
		sourceStartSec: 0,
		sourceEndSec: 10,
		timelineStartSec: 0,
		timelineEndSec: 11.5,
	});
	const ranges: AxcutInsertRange[] = [
		{
			id: "a",
			assetId: "a1",
			atSec: 2,
			durationSec: 0.5,
			wordId: "w_a",
			reason: "",
			origin: "user",
		},
		{
			id: "b",
			assetId: "a1",
			atSec: 6,
			durationSec: 1,
			wordId: "w_b",
			reason: "",
			origin: "user",
		},
	];

	it("leaves everything before the first insertion where it was", () => {
		expect(sourceToTimelineSec(clip, 0, ranges)).toBeCloseTo(0, 6);
		expect(sourceToTimelineSec(clip, 1.9, ranges)).toBeCloseTo(1.9, 6);
	});

	it("counts every insertion before the moment, and only those", () => {
		expect(sourceToTimelineSec(clip, 4, ranges)).toBeCloseTo(4.5, 6);
		expect(sourceToTimelineSec(clip, 10, ranges)).toBeCloseTo(11.5, 6);
	});

	it("puts the insertion's own moment where it opens, or where it closes", () => {
		// The choice is real: a position and a span's START go before the inserted media,
		// a span's END goes after it, so a caption running up to an added word covers it.
		expect(sourceToTimelineSec(clip, 2, ranges, "opens")).toBeCloseTo(2, 6);
		expect(sourceToTimelineSec(clip, 2, ranges, "closes")).toBeCloseTo(2.5, 6);
	});

	it("comes back to the source moment it started from", () => {
		for (const source of [0, 1.9, 2, 3, 5.5, 6, 9.99]) {
			const back = timelineToSourceSec(clip, sourceToTimelineSec(clip, source, ranges), ranges);
			expect(back.sourceSec).toBeCloseTo(source, 6);
		}
	});

	it("has no source moment inside an insertion, and says which one", () => {
		// There is nothing else it could answer: none of those seconds come from the file.
		const inside = timelineToSourceSec(clip, 2.25, ranges);
		expect(inside.sourceSec).toBeCloseTo(2, 6);
		expect(inside.insideInsert?.id).toBe("a");
		expect(timelineToSourceSec(clip, 2.5, ranges).insideInsert).toBeNull();
	});

	it("is the plain shift when the clip carries nothing", () => {
		expect(sourceToTimelineSec(clip, 4, [])).toBeCloseTo(4, 6);
		expect(timelineToSourceSec(clip, 4, []).sourceSec).toBeCloseTo(4, 6);
	});

	it("ignores insertions belonging to another recording", () => {
		const other = [{ ...ranges[0], assetId: "a2" }];
		expect(sourceToTimelineSec(clip, 4, other)).toBeCloseTo(4, 6);
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
