// The one property everything above this module depends on: the parts are contiguous, they
// start where the clip starts, and no stored source coordinate moved to achieve it.

import { describe, expect, it } from "vitest";
import type { AxcutClip, AxcutWord } from "../schema";
import {
	clipParts,
	clipsWithExtensions,
	extensionAssetId,
	extensionAt,
	extensionDurationSec,
	partsLengthSec,
	partsRawSec,
	partsSourceSec,
} from "./clip-parts";

const CLIP: AxcutClip = {
	id: "c1",
	assetId: "a1",
	sourceStartSec: 0,
	sourceEndSec: 10,
	timelineStartSec: 0,
	timelineEndSec: 10,
	wordRefs: [],
	origin: "user",
	reason: "",
};

const word = (over: Partial<AxcutWord> & { id: string; startSec: number }): AxcutWord => ({
	segmentId: "s1",
	endSec: over.startSec,
	text: "hello",
	...over,
});

const added = (id: string, at: number, text: string): AxcutWord =>
	word({ id, startSec: at, text, source: "synth" });

describe("clipParts", () => {
	it("is one recording part when nothing was added", () => {
		expect(clipParts(CLIP, [word({ id: "w1", startSec: 1 })])).toEqual([
			{
				kind: "recording",
				timelineStartSec: 0,
				timelineEndSec: 10,
				sourceStartSec: 0,
				sourceEndSec: 10,
			},
		]);
	});

	it("splits the recording where the word was added, extension between the halves", () => {
		const parts = clipParts(CLIP, [added("s1", 4, "really")]);
		expect(parts.map((p) => p.kind)).toEqual(["recording", "extension", "recording"]);
		expect(parts[0]).toMatchObject({ sourceStartSec: 0, sourceEndSec: 4, timelineEndSec: 4 });
		// "really" is 6 chars at 15/s.
		expect(parts[1]).toMatchObject({ kind: "extension", wordId: "s1", timelineStartSec: 4 });
		expect(parts[1].timelineEndSec).toBeCloseTo(4.4, 6);
		// The SOURCE window of the second half is untouched — it resumes where it left off.
		expect(parts[2]).toMatchObject({ sourceStartSec: 4, sourceEndSec: 10 });
		expect(parts[2].timelineStartSec).toBeCloseTo(4.4, 6);
	});

	it("leaves every stored source coordinate exactly where it was", () => {
		// The whole reason the extension is appended to the LIST and not spliced into the
		// media's axis: adding one cannot move an anchor anyone else stored.
		const parts = clipParts(CLIP, [added("s1", 4, "really"), added("s2", 7, "quite")]);
		const recorded = parts.filter((p) => p.kind === "recording");
		expect(recorded.map((p) => [p.sourceStartSec, p.sourceEndSec])).toEqual([
			[0, 4],
			[4, 7],
			[7, 10],
		]);
	});

	it("is contiguous, and starts where the clip starts", () => {
		const parts = clipParts({ ...CLIP, timelineStartSec: 12, timelineEndSec: 22 }, [
			added("s1", 4, "really"),
			added("s2", 7, "quite"),
		]);
		expect(parts[0].timelineStartSec).toBe(12);
		for (const [i, part] of parts.slice(0, -1).entries()) {
			expect(part.timelineEndSec).toBeCloseTo(parts[i + 1].timelineStartSec, 9);
		}
	});

	it("grows the clip by exactly what was added, and by nothing else", () => {
		const bare = partsLengthSec(clipParts(CLIP, []));
		const grown = partsLengthSec(clipParts(CLIP, [added("s1", 4, "really")]));
		expect(bare).toBeCloseTo(10, 6);
		expect(grown - bare).toBeCloseTo(extensionDurationSec("really"), 6);
	});

	it("ignores a word another clip of the same recording plays", () => {
		const late = { ...CLIP, sourceStartSec: 6, sourceEndSec: 10, timelineEndSec: 4 };
		expect(clipParts(late, [added("s1", 4, "really")]).map((p) => p.kind)).toEqual(["recording"]);
	});

	it("ignores an empty word, which buys nothing", () => {
		expect(clipParts(CLIP, [added("s1", 4, "   ")]).map((p) => p.kind)).toEqual(["recording"]);
	});
});

describe("extensionDurationSec", () => {
	it("is the text's own length at the assumed rate", () => {
		expect(extensionDurationSec("really")).toBeCloseTo(6 / 15, 6);
	});

	it("never returns a span too short to be a part", () => {
		expect(extensionDurationSec("a")).toBe(0.15);
	});

	it("is nothing at all for nothing at all", () => {
		expect(extensionDurationSec("  ")).toBe(0);
	});
});

// ─── What a player sees ─────────────────────────────────────────────────────
// The DOM preview already plays several clips over several files and swaps at the boundary.
// An extension is exactly that, so it is handed a clip rather than taught a new case.

describe("clipsWithExtensions", () => {
	const transcripts = [{ assetId: "a1", words: [added("synth_1", 4, "really")] }];

	it("splices the extension in as a clip of its own, on its own media", () => {
		const out = clipsWithExtensions([CLIP], transcripts);
		expect(out.map((c) => c.assetId)).toEqual(["a1", "ext:synth_1", "a1"]);
		expect(out[1]).toMatchObject({ sourceStartSec: 0 });
		expect(out[1].sourceEndSec).toBeCloseTo(6 / 15, 6);
	});

	it("lays them end to end, so the player's clock never sees a gap", () => {
		const out = clipsWithExtensions([CLIP], transcripts);
		expect(out[0].timelineStartSec).toBe(0);
		for (const [i, clip] of out.slice(0, -1).entries()) {
			expect(clip.timelineEndSec).toBeCloseTo(out[i + 1].timelineStartSec, 9);
		}
	});

	it("returns the clips unchanged when no word was added", () => {
		expect(clipsWithExtensions([CLIP], [{ assetId: "a1", words: [] }])).toEqual([CLIP]);
	});

	it("gives the extension an id no real asset can collide with", () => {
		expect(extensionAssetId("synth_1")).toBe("ext:synth_1");
	});
});

// ─── The one conversion ─────────────────────────────────────────────────────
// Every reader used to write `timelineStartSec + (sec - sourceStartSec)` for itself. That
// subtraction is right until a clip carries an extension and wrong for every second after
// it, which is one bug per reader — so it lives here now, once.

describe("partsRawSec", () => {
	const parts = clipParts(CLIP, [added("s1", 4, "really")]);
	const ext = extensionDurationSec("really");

	it("leaves the seconds before the insertion where they were", () => {
		expect(partsRawSec(parts, 2)).toBeCloseTo(2, 6);
	});

	it("pushes the seconds after it along by exactly what was inserted", () => {
		expect(partsRawSec(parts, 6)).toBeCloseTo(6 + ext, 6);
		expect(partsRawSec(parts, 10)).toBeCloseTo(10 + ext, 6);
	});

	it("puts the split second AFTER the extension, where its media actually plays", () => {
		expect(partsRawSec(parts, 4)).toBeCloseTo(4 + ext, 6);
	});

	it("is the plain subtraction when nothing was added", () => {
		const plain = clipParts({ ...CLIP, timelineStartSec: 12, timelineEndSec: 22 }, []);
		expect(partsRawSec(plain, 6)).toBeCloseTo(18, 6);
	});
});

describe("partsSourceSec", () => {
	const parts = clipParts(CLIP, [added("s1", 4, "really")]);
	const ext = extensionDurationSec("really");

	it("undoes partsRawSec for a second the recording actually plays", () => {
		for (const sec of [0, 2, 4, 6, 10]) {
			expect(partsSourceSec(parts, partsRawSec(parts, sec))).toBeCloseTo(sec, 6);
		}
	});

	it("parks at the split while the extension plays — no recording runs there", () => {
		expect(partsSourceSec(parts, 4 + ext / 2)).toBeCloseTo(4, 6);
	});
});

describe("extensionAt", () => {
	const parts = clipParts(CLIP, [added("s1", 4, "really")]);
	const ext = extensionDurationSec("really");

	it("names the word being spoken over its own media", () => {
		expect(extensionAt(parts, 4 + ext / 2)).toBe("s1");
	});

	it("is nothing on either side of it, so the recorded words keep the highlight", () => {
		expect(extensionAt(parts, 3.9)).toBeNull();
		expect(extensionAt(parts, 4 + ext + 0.01)).toBeNull();
	});
});
