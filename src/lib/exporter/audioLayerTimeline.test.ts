import { describe, expect, it } from "vitest";
import type { AxcutClip, AxcutTrimRange } from "@/lib/ai-edition/schema";
import { buildExportTimelineMapping, rawToExportTime } from "./audioLayerTimeline";

function clip(
	id: string,
	timelineStartSec: number,
	sourceStartSec: number,
	sourceEndSec: number,
): AxcutClip {
	return {
		id,
		assetId: "a1",
		sourceStartSec,
		sourceEndSec,
		timelineStartSec,
		timelineEndSec: timelineStartSec + (sourceEndSec - sourceStartSec),
		wordRefs: [],
		origin: "user",
		reason: "",
	};
}

function trim(id: string, clipId: string, startSec: number, endSec: number): AxcutTrimRange {
	return { id, assetId: "a1", clipId, startSec, endSec, origin: "user", reason: "" };
}

describe("buildExportTimelineMapping", () => {
	it("is the identity when there are no trims", () => {
		const mapping = buildExportTimelineMapping([clip("c1", 0, 0, 10), clip("c2", 10, 0, 5)], []);
		expect(mapping).toEqual([
			{ rawStart: 0, rawEnd: 10, exportStart: 0 },
			{ rawStart: 10, rawEnd: 15, exportStart: 10 },
		]);
	});

	it("compresses trimmed spans onto the assembled timeline", () => {
		// One 10s clip with the middle 2s (4..6) cut.
		const mapping = buildExportTimelineMapping([clip("c1", 0, 0, 10)], [trim("t1", "c1", 4, 6)]);
		expect(mapping).toEqual([
			{ rawStart: 0, rawEnd: 4, exportStart: 0 },
			{ rawStart: 6, rawEnd: 10, exportStart: 4 },
		]);
	});

	it("maps a raw instant inside a trim to the boundary the video jumps to", () => {
		const mapping = buildExportTimelineMapping([clip("c1", 0, 0, 10)], [trim("t1", "c1", 4, 6)]);
		expect(rawToExportTime(2, mapping)).toBeCloseTo(2);
		// 4..6 is cut: the video jumps from raw 4 to raw 6 — a layer starting
		// at raw 5 lands where raw 6 resumes (export 4).
		expect(rawToExportTime(5, mapping)).toBeCloseTo(4);
		expect(rawToExportTime(8, mapping)).toBeCloseTo(6);
	});

	it("keeps the mapping per-clip across an edited source range", () => {
		// Clip starts 3s into the source; raw timeline 0 = source 3.
		const mapping = buildExportTimelineMapping([clip("c1", 0, 3, 13)], [trim("t1", "c1", 5, 7)]);
		// Raw 2 = source 5 = start of the trim → next kept starts at raw 4 (source 7).
		expect(mapping).toEqual([
			{ rawStart: 0, rawEnd: 2, exportStart: 0 },
			{ rawStart: 4, rawEnd: 10, exportStart: 2 },
		]);
		expect(rawToExportTime(1, mapping)).toBeCloseTo(1);
		expect(rawToExportTime(5, mapping)).toBeCloseTo(3);
	});
});
