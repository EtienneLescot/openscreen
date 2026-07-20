import { describe, expect, it } from "vitest";
import type { AxcutClip } from "../schema";
import {
	coalesceTouchingSpans,
	projectRegionsToSourceTime,
	reprojectRegionsForReorder,
	reprojectSpanForReorder,
	ventilateSpanAcrossClips,
	virtualSpanToSourceSpans,
} from "./region-ventilation";

// Clips are laid contiguously on the timeline; `src` is just an identity tag on
// the source range so reordering is observable.
function clip(id: string, timelineStartSec: number, lenSec: number, srcStart = 0): AxcutClip {
	return {
		id,
		assetId: "a",
		sourceStartSec: srcStart,
		sourceEndSec: srcStart + lenSec,
		timelineStartSec,
		timelineEndSec: timelineStartSec + lenSec,
		wordRefs: [],
		origin: "user",
		reason: "",
	};
}

// A 3-clip timeline: c1 [0,10) c2 [10,20) c3 [20,30).
const c1 = clip("c1", 0, 10);
const c2 = clip("c2", 10, 10);
const c3 = clip("c3", 20, 10);
const threeClips = [c1, c2, c3];

describe("ventilateSpanAcrossClips", () => {
	it("keeps a span inside one clip as a single clip-local fragment", () => {
		expect(ventilateSpanAcrossClips(2, 6, threeClips)).toEqual([
			{ clipId: "c1", clipIndex: 0, localStartSec: 2, localEndSec: 6 },
		]);
	});

	it("splits a span straddling two clips into per-clip fragments", () => {
		expect(ventilateSpanAcrossClips(8, 13, threeClips)).toEqual([
			{ clipId: "c1", clipIndex: 0, localStartSec: 8, localEndSec: 10 },
			{ clipId: "c2", clipIndex: 1, localStartSec: 0, localEndSec: 3 },
		]);
	});

	it("splits across three clips", () => {
		expect(ventilateSpanAcrossClips(5, 25, threeClips)).toEqual([
			{ clipId: "c1", clipIndex: 0, localStartSec: 5, localEndSec: 10 },
			{ clipId: "c2", clipIndex: 1, localStartSec: 0, localEndSec: 10 },
			{ clipId: "c3", clipIndex: 2, localStartSec: 0, localEndSec: 5 },
		]);
	});

	it("omits clips the span doesn't touch", () => {
		expect(ventilateSpanAcrossClips(22, 28, threeClips)).toEqual([
			{ clipId: "c3", clipIndex: 2, localStartSec: 2, localEndSec: 8 },
		]);
	});
});

describe("reprojectSpanForReorder", () => {
	it("shifts a single-clip span to the clip's new position", () => {
		// Move c2 to the front: new layout c2 [0,10) c1 [10,20) c3 [20,30).
		const newClips = [clip("c2", 0, 10), clip("c1", 10, 10), c3];
		// A zoom over c1 (2..6s) must ride c1 to its new [10,20) slot → 12..16s.
		expect(reprojectSpanForReorder(2000, 6000, threeClips, newClips)).toEqual([
			{ startMs: 12000, endMs: 16000 },
		]);
	});

	it("splits a cross-clip span into two when the clips separate", () => {
		// Zoom straddling c1 (8..10) + c2 (10..13). Move c3 between them:
		// new layout c1 [0,10) c3 [10,20) c2 [20,30).
		const newClips = [c1, clip("c3", 10, 10), clip("c2", 20, 10)];
		expect(reprojectSpanForReorder(8000, 13000, threeClips, newClips)).toEqual([
			{ startMs: 8000, endMs: 10000 }, // stays on c1
			{ startMs: 20000, endMs: 23000 }, // rides c2 to its new slot
		]);
	});

	it("merges the pieces back when the clips stay contiguous after the move", () => {
		// Same straddling zoom, but c1 and c2 remain adjacent (just both shifted):
		// swap so order is c2,c1 would break adjacency — instead move c3 to front:
		// new layout c3 [0,10) c1 [10,20) c2 [20,30). c1 then c2 still contiguous.
		const newClips = [clip("c3", 0, 10), clip("c1", 10, 10), clip("c2", 20, 10)];
		expect(reprojectSpanForReorder(8000, 13000, threeClips, newClips)).toEqual([
			{ startMs: 18000, endMs: 23000 },
		]);
	});

	it("leaves a span not sitting on any clip unchanged", () => {
		const newClips = [clip("c2", 0, 10), clip("c1", 10, 10), c3];
		// 40..45s is past the end of every clip.
		expect(reprojectSpanForReorder(40000, 45000, threeClips, newClips)).toEqual([
			{ startMs: 40000, endMs: 45000 },
		]);
	});
});

describe("reprojectRegionsForReorder", () => {
	it("keeps the id on single-piece regions and preserves extra fields", () => {
		const newClips = [clip("c2", 0, 10), clip("c1", 10, 10), c3];
		const regions = [{ id: "z1", startMs: 2000, endMs: 6000, depth: 2 }];
		expect(reprojectRegionsForReorder(regions, threeClips, newClips, () => "NEW")).toEqual([
			{ id: "z1", startMs: 12000, endMs: 16000, depth: 2 },
		]);
	});

	it("emits a fresh id for the extra fragment of a split region", () => {
		const newClips = [c1, clip("c3", 10, 10), clip("c2", 20, 10)];
		const regions = [{ id: "z1", startMs: 8000, endMs: 13000, depth: 3 }];
		expect(reprojectRegionsForReorder(regions, threeClips, newClips, () => "z2")).toEqual([
			{ id: "z1", startMs: 8000, endMs: 10000, depth: 3 },
			{ id: "z2", startMs: 20000, endMs: 23000, depth: 3 },
		]);
	});
});

describe("virtualSpanToSourceSpans (export coherence)", () => {
	it("is a no-op for an identity single clip (source == virtual)", () => {
		const clips = [clip("c1", 0, 10, 0)];
		expect(virtualSpanToSourceSpans(2000, 4000, clips)).toEqual([
			{ clipIndex: 0, startMs: 2000, endMs: 4000 },
		]);
	});

	it("shifts by clip in/out (a virtual span maps to its source range)", () => {
		// Clip plays source 5..15 at virtual 0..10.
		const clips = [clip("c1", 0, 10, 5)];
		// Zoom at virtual 2..4 → source 7..9 (so the export matches the right frames
		// instead of source 2..4, which are trimmed off the clip's head).
		expect(virtualSpanToSourceSpans(2000, 4000, clips)).toEqual([
			{ clipIndex: 0, startMs: 7000, endMs: 9000 },
		]);
	});

	it("splits a span across a clip boundary into two source spans", () => {
		// c1 source 0..10 @ virtual 0..10; c2 source 20..30 @ virtual 10..20.
		const clips = [clip("c1", 0, 10, 0), clip("c2", 10, 10, 20)];
		// Zoom at virtual 8..12 straddles the boundary → source 8..10 and 20..22.
		expect(virtualSpanToSourceSpans(8000, 12000, clips)).toEqual([
			{ clipIndex: 0, startMs: 8000, endMs: 10000 },
			{ clipIndex: 1, startMs: 20000, endMs: 22000 },
		]);
	});

	it("returns [] when the span sits on no clip", () => {
		expect(virtualSpanToSourceSpans(40000, 45000, [clip("c1", 0, 10, 0)])).toEqual([]);
	});
});

describe("projectRegionsToSourceTime (export coherence)", () => {
	it("splits a cross-boundary zoom into two source-time regions, second with a fresh id", () => {
		const clips = [clip("c1", 0, 10, 0), clip("c2", 10, 10, 20)];
		const zooms = [{ id: "z1", startMs: 8000, endMs: 12000, depth: 4 }];
		expect(projectRegionsToSourceTime(zooms, clips, () => "z2")).toEqual([
			{ id: "z1", startMs: 8000, endMs: 10000, depth: 4, clipIndex: 0 },
			{ id: "z2", startMs: 20000, endMs: 22000, depth: 4, clipIndex: 1 },
		]);
	});

	it("passes a region over no clip through unchanged", () => {
		const clips = [clip("c1", 0, 10, 0)];
		const zooms = [{ id: "z1", startMs: 40000, endMs: 45000, depth: 2 }];
		expect(projectRegionsToSourceTime(zooms, clips, () => "NEW")).toEqual(zooms);
	});
});

describe("coalesceTouchingSpans", () => {
	it("returns [] for empty input", () => {
		expect(coalesceTouchingSpans([])).toEqual([]);
	});

	it("passes a single span through as its own group", () => {
		expect(coalesceTouchingSpans([{ id: "a", start: 2, end: 5 }])).toEqual([
			{ ids: ["a"], start: 2, end: 5 },
		]);
	});

	it("merges two spans that touch exactly (zero gap)", () => {
		const spans = [
			{ id: "a", start: 0, end: 5 },
			{ id: "b", start: 5, end: 9 },
		];
		expect(coalesceTouchingSpans(spans)).toEqual([{ ids: ["a", "b"], start: 0, end: 9 }]);
	});

	it("merges a gap just under epsilon, keeps a gap just over epsilon separate", () => {
		const eps = 0.001;
		const justUnder = [
			{ id: "a", start: 0, end: 5 },
			{ id: "b", start: 5 + eps * 0.5, end: 9 },
		];
		expect(coalesceTouchingSpans(justUnder, eps)).toEqual([{ ids: ["a", "b"], start: 0, end: 9 }]);

		const justOver = [
			{ id: "a", start: 0, end: 5 },
			{ id: "b", start: 5 + eps * 2, end: 9 },
		];
		expect(coalesceTouchingSpans(justOver, eps)).toEqual([
			{ ids: ["a"], start: 0, end: 5 },
			{ ids: ["b"], start: 5 + eps * 2, end: 9 },
		]);
	});

	it("merges a transitive chain A-touching-B-touching-C into one group of 3, left-to-right", () => {
		const spans = [
			{ id: "c", start: 8, end: 12 },
			{ id: "a", start: 0, end: 4 },
			{ id: "b", start: 4, end: 8 },
		];
		expect(coalesceTouchingSpans(spans)).toEqual([{ ids: ["a", "b", "c"], start: 0, end: 12 }]);
	});

	it("does not shrink the group's end when a later, nested span ends earlier (Math.max regression)", () => {
		// A=[0,10] fully contains B=[3,7]. A naive `end = next.end` would corrupt
		// the group's end to 7, potentially detaching a real third span near 10.
		const spans = [
			{ id: "a", start: 0, end: 10 },
			{ id: "b", start: 3, end: 7 },
		];
		expect(coalesceTouchingSpans(spans)).toEqual([{ ids: ["a", "b"], start: 0, end: 10 }]);
	});

	it("sorts unsorted input before grouping", () => {
		const spans = [
			{ id: "b", start: 5, end: 9 },
			{ id: "a", start: 0, end: 5 },
		];
		expect(coalesceTouchingSpans(spans)).toEqual([{ ids: ["a", "b"], start: 0, end: 9 }]);
	});
});
