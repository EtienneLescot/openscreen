// A document written before insertions took up time on the timeline.
//
// Nothing else reconciles it: `withInsertRangesForWords` only runs when a transcript word is
// written, so a project the user merely OPENS keeps its old geometry while all the code
// around it assumes the new — the film's ruler stops short, the insertion pills are drawn at
// their source position, and the subtitles slide further out of step with every insertion
// passed (issue #560).

import { describe, expect, it } from "vitest";
import type { AxcutClip, AxcutDocument, AxcutInsertRange } from "../schema";
import { reconcileClipsWithInserts } from "./load";

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
