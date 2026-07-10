import { describe, expect, it } from "vitest";
import type { AxcutClip, AxcutTrimRange } from "../schema";
import { computeExportTrimRegions } from "./documentExporter";

function clip(p: Partial<AxcutClip> & Pick<AxcutClip, "id">): AxcutClip {
	return {
		assetId: "a",
		sourceStartSec: 0,
		sourceEndSec: 10,
		timelineStartSec: 0,
		timelineEndSec: 10,
		wordRefs: [],
		origin: "user",
		reason: "",
		...p,
	};
}
function trim(p: Partial<AxcutTrimRange> & Pick<AxcutTrimRange, "id">): AxcutTrimRange {
	return { assetId: "a", startSec: 0, endSec: 1, origin: "user", reason: "", ...p };
}

describe("computeExportTrimRegions", () => {
	it("cuts everything outside the kept clip ranges (clip in/out)", () => {
		// One clip keeps source 2..8 of a 10s asset → cut 0..2 and 8..10.
		const clips = [clip({ id: "c1", sourceStartSec: 2, sourceEndSec: 8 })];
		expect(computeExportTrimRegions(10, clips, [], "a")).toEqual([
			{ id: "trim_1", startMs: 0, endMs: 2000 },
			{ id: "trim_2", startMs: 8000, endMs: 10000 },
		]);
	});

	it("also cuts a mid-clip trim (previously dropped from export)", () => {
		// Full clip 0..10, plus a trim removing source 4..6 → export must cut it.
		const clips = [clip({ id: "c1", sourceStartSec: 0, sourceEndSec: 10 })];
		const trims = [trim({ id: "t1", startSec: 4, endSec: 6 })];
		expect(computeExportTrimRegions(10, clips, trims, "a")).toEqual([
			{ id: "trim_1", startMs: 4000, endMs: 6000 },
		]);
	});

	it("merges overlapping clip-gap and trim cuts", () => {
		// Clip keeps 0..8 (cut 8..10); a trim 7..9 overlaps the tail cut → merge to 7..10.
		const clips = [clip({ id: "c1", sourceStartSec: 0, sourceEndSec: 8 })];
		const trims = [trim({ id: "t1", startSec: 7, endSec: 9 })];
		expect(computeExportTrimRegions(10, clips, trims, "a")).toEqual([
			{ id: "trim_1", startMs: 7000, endMs: 10000 },
		]);
	});

	it("ignores trims that belong to a different asset", () => {
		const clips = [clip({ id: "c1", sourceStartSec: 0, sourceEndSec: 10 })];
		const trims = [trim({ id: "t1", assetId: "other", startSec: 3, endSec: 5 })];
		expect(computeExportTrimRegions(10, clips, trims, "a")).toEqual([]);
	});
});
