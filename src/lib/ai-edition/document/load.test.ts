// A document written before insertions took up time on the timeline.
//
// Nothing else reconciles it: `withInsertRangesForWords` only runs when a transcript word is
// written, so a project the user merely OPENS keeps its old geometry while all the code
// around it assumes the new — the film's ruler stops short, the insertion pills are drawn at
// their source position, and the subtitles slide further out of step with every insertion
// passed (issue #560).

import { describe, expect, it } from "vitest";
import type { AxcutClip, AxcutDocument, AxcutInsertRange } from "../schema";
import { reconcileClipsWithInserts, reconcileInsertions } from "./load";

function clip(over: Partial<AxcutClip> & { id: string }): AxcutClip {
	return {
		assetId: "a1",
		sourceStartSec: 0,
		sourceEndSec: 10,
		timelineStartSec: 0,
		timelineEndSec: 10,
		wordRefs: [],
		origin: "user",
		reason: "",
		...over,
	};
}

const insert = (over: Partial<AxcutInsertRange> & { id: string }): AxcutInsertRange => ({
	assetId: "a1",
	atSec: 5,
	durationSec: 1,
	wordId: "w1",
	reason: "",
	origin: "user",
	...over,
});

function doc(clips: AxcutClip[], insertRanges: AxcutInsertRange[]): AxcutDocument {
	return { timeline: { clips, insertRanges } } as unknown as AxcutDocument;
}

describe("reconcileClipsWithInserts", () => {
	it("gives a short clip back the time its insertions take", () => {
		const before = doc([clip({ id: "c1" })], [insert({ id: "i1" })]);
		const [after] = reconcileClipsWithInserts(before).timeline.clips;
		expect(after.timelineEndSec - after.timelineStartSec).toBeCloseTo(11, 6);
		// The recording is untouched: no frame was added to or taken from the file.
		expect(after.sourceStartSec).toBe(0);
		expect(after.sourceEndSec).toBe(10);
	});

	it("pushes every later clip along by what the one before it gained", () => {
		const before = doc(
			[clip({ id: "c1" }), clip({ id: "c2", timelineStartSec: 10, timelineEndSec: 20 })],
			[insert({ id: "i1" })],
		);
		const [, second] = reconcileClipsWithInserts(before).timeline.clips;
		expect(second.timelineStartSec).toBeCloseTo(11, 6);
		expect(second.timelineEndSec).toBeCloseTo(21, 6);
	});

	it("is idempotent, so it can run on every load", () => {
		const before = doc([clip({ id: "c1" })], [insert({ id: "i1" })]);
		const once = reconcileClipsWithInserts(before);
		const twice = reconcileClipsWithInserts(once);
		expect(twice.timeline.clips).toEqual(once.timeline.clips);
		// And a document already in step is returned as-is, not rebuilt.
		expect(twice).toBe(once);
	});

	it("leaves a document with no insertions completely alone", () => {
		const before = doc([clip({ id: "c1" })], []);
		expect(reconcileClipsWithInserts(before)).toBe(before);
	});

	it("counts several insertions in one clip, and only that clip's", () => {
		const before = doc(
			[
				clip({ id: "c1" }),
				clip({ id: "c2", assetId: "a2", timelineStartSec: 10, timelineEndSec: 20 }),
			],
			[insert({ id: "i1", atSec: 3 }), insert({ id: "i2", atSec: 7, durationSec: 0.5 })],
		);
		const [first, second] = reconcileClipsWithInserts(before).timeline.clips;
		expect(first.timelineEndSec).toBeCloseTo(11.5, 6);
		expect(second.timelineEndSec - second.timelineStartSec).toBeCloseTo(10, 6);
	});
});

// ─── An added word nobody marked ────────────────────────────────────────────
// `source: "synth"` is how the whole pipeline recognises a word the user typed: it decides
// whether the word gets an insertion, whether the film makes room for it, and whether the
// caption line breaks around it. A row minted before that field existed answers no to all
// three — its text plays over the recording and everything after it drifts. Found in the
// live project: `synth_1`, zero-width at source 9.15, with no insertion at all (issue #560).

describe("reconcileInsertions", () => {
	function docWithUnmarkedWord(): AxcutDocument {
		return {
			assets: [{ id: "a1", kind: "video" }],
			transcripts: [
				{
					assetId: "a1",
					language: "en",
					segments: [{ id: "s1", kind: "speech", startSec: 0, endSec: 6, text: "x", wordIds: [] }],
					words: [
						{ id: "w1", segmentId: "s1", startSec: 0, endSec: 1, text: "hello" },
						// Minted as an added word — the id says so — but never marked.
						{ id: "synth_1", segmentId: "s1", startSec: 1, endSec: 1, text: "a much longer thing" },
					],
				},
			],
			timeline: { clips: [clip({ id: "c1" })], insertRanges: [] },
		} as unknown as AxcutDocument;
	}

	it("marks it, gives it an insertion, and makes room for it", () => {
		const out = reconcileInsertions(docWithUnmarkedWord());
		const word = out.transcripts[0].words.find((w) => w.id === "synth_1");
		expect(word?.source).toBe("synth");
		const range = out.timeline.insertRanges?.find((r) => r.wordId === "synth_1");
		expect(range).toBeDefined();
		expect(range?.durationSec ?? 0).toBeGreaterThan(0);
		const [c] = out.timeline.clips;
		expect(c.timelineEndSec - c.timelineStartSec).toBeCloseTo(10 + (range?.durationSec ?? 0), 6);
	});

	it("leaves a word that was never added alone", () => {
		const out = reconcileInsertions(docWithUnmarkedWord());
		expect(out.transcripts[0].words.find((w) => w.id === "w1")?.source).toBeUndefined();
	});

	it("is idempotent", () => {
		const once = reconcileInsertions(docWithUnmarkedWord());
		const twice = reconcileInsertions(once);
		expect(twice.timeline.clips).toEqual(once.timeline.clips);
		expect(twice.timeline.insertRanges).toEqual(once.timeline.insertRanges);
	});
});
