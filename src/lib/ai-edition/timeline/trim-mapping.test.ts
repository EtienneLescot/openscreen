import { describe, expect, it } from "vitest";
import type { AxcutClip, AxcutTrimRange } from "../schema";
import {
	coalescedTrimGroups,
	resolveTimelineSpanToTrim,
	trimToTimelineSpan,
	ventilateTimelineSpanToTrims,
} from "./trim-mapping";

function clip(partial: Partial<AxcutClip> & Pick<AxcutClip, "id" | "assetId">): AxcutClip {
	return {
		sourceStartSec: 0,
		sourceEndSec: 10,
		timelineStartSec: 0,
		timelineEndSec: 10,
		wordRefs: [],
		origin: "user",
		reason: "",
		...partial,
	};
}

function trim(
	partial: Partial<AxcutTrimRange> & Pick<AxcutTrimRange, "id" | "assetId">,
): AxcutTrimRange {
	return { startSec: 0, endSec: 1, reason: "", origin: "user", ...partial };
}

describe("trimToTimelineSpan", () => {
	it("maps a source-time trim through an identity single clip", () => {
		const clips = [
			clip({
				id: "c1",
				assetId: "a",
				sourceStartSec: 0,
				sourceEndSec: 42,
				timelineStartSec: 0,
				timelineEndSec: 42,
			}),
		];
		expect(trimToTimelineSpan({ assetId: "a", startSec: 5, endSec: 7 }, clips)).toEqual({
			start: 5,
			end: 7,
		});
	});

	it("offsets by the carrying clip's source→timeline shift", () => {
		// Clip plays source 16..30 at timeline 14..28.
		const clips = [
			clip({
				id: "c1",
				assetId: "a",
				sourceStartSec: 0,
				sourceEndSec: 14,
				timelineStartSec: 0,
				timelineEndSec: 14,
			}),
			clip({
				id: "c2",
				assetId: "a",
				sourceStartSec: 16,
				sourceEndSec: 30,
				timelineStartSec: 14,
				timelineEndSec: 28,
			}),
		];
		// A trim at source 20..22 lives in c2 → timeline 14 + (20-16) = 18..20.
		expect(trimToTimelineSpan({ assetId: "a", startSec: 20, endSec: 22 }, clips)).toEqual({
			start: 18,
			end: 20,
		});
	});

	it("returns null when no clip carries the trim's source region", () => {
		const clips = [clip({ id: "c1", assetId: "a", sourceStartSec: 0, sourceEndSec: 10 })];
		expect(trimToTimelineSpan({ assetId: "a", startSec: 40, endSec: 42 }, clips)).toBeNull();
		expect(trimToTimelineSpan({ assetId: "b", startSec: 2, endSec: 4 }, clips)).toBeNull();
	});
});

describe("resolveTimelineSpanToTrim", () => {
	it("maps a timeline span back to source-time on the containing clip", () => {
		const clips = [
			clip({
				id: "c1",
				assetId: "a",
				sourceStartSec: 0,
				sourceEndSec: 14,
				timelineStartSec: 0,
				timelineEndSec: 14,
			}),
			clip({
				id: "c2",
				assetId: "b",
				sourceStartSec: 16,
				sourceEndSec: 30,
				timelineStartSec: 14,
				timelineEndSec: 28,
			}),
		];
		// Timeline 18..20 falls in c2 (asset b) → source 16 + (18-14)=20 .. 22.
		expect(resolveTimelineSpanToTrim(18, 20, clips)).toEqual({
			assetId: "b",
			clipId: "c2",
			sourceStartSec: 20,
			sourceEndSec: 22,
		});
	});

	it("re-attaches to whichever clip the span's start lands in", () => {
		const clips = [
			clip({
				id: "c1",
				assetId: "a",
				sourceStartSec: 0,
				sourceEndSec: 14,
				timelineStartSec: 0,
				timelineEndSec: 14,
			}),
			clip({
				id: "c2",
				assetId: "b",
				sourceStartSec: 16,
				sourceEndSec: 30,
				timelineStartSec: 14,
				timelineEndSec: 28,
			}),
		];
		// Start in c1 → asset a, start in c2 → asset b.
		expect(resolveTimelineSpanToTrim(2, 4, clips)?.assetId).toBe("a");
		expect(resolveTimelineSpanToTrim(20, 22, clips)?.assetId).toBe("b");
	});

	it("clamps the span to the carrier clip's extent (no straddling)", () => {
		const clips = [
			clip({
				id: "c1",
				assetId: "a",
				sourceStartSec: 0,
				sourceEndSec: 14,
				timelineStartSec: 0,
				timelineEndSec: 14,
			}),
			clip({
				id: "c2",
				assetId: "b",
				sourceStartSec: 16,
				sourceEndSec: 30,
				timelineStartSec: 14,
				timelineEndSec: 28,
			}),
		];
		// Span 10..20 starts in c1; end clamps to c1's end (timeline 14 → source 14).
		expect(resolveTimelineSpanToTrim(10, 20, clips)).toEqual({
			assetId: "a",
			clipId: "c1",
			sourceStartSec: 10,
			sourceEndSec: 14,
		});
	});

	it("round-trips with trimToTimelineSpan", () => {
		const clips = [
			clip({
				id: "c1",
				assetId: "a",
				sourceStartSec: 0,
				sourceEndSec: 14,
				timelineStartSec: 0,
				timelineEndSec: 14,
			}),
			clip({
				id: "c2",
				assetId: "b",
				sourceStartSec: 16,
				sourceEndSec: 30,
				timelineStartSec: 14,
				timelineEndSec: 28,
			}),
		];
		const resolved = resolveTimelineSpanToTrim(18, 21, clips);
		expect(resolved).not.toBeNull();
		if (!resolved) return;
		const back = trimToTimelineSpan(
			{
				assetId: resolved.assetId,
				startSec: resolved.sourceStartSec,
				endSec: resolved.sourceEndSec,
			},
			clips,
		);
		expect(back).toEqual({ start: 18, end: 21 });
	});

	it("returns null with no clips", () => {
		expect(resolveTimelineSpanToTrim(1, 2, [])).toBeNull();
	});
});

describe("ventilateTimelineSpanToTrims", () => {
	// c1: asset a, source 0..14 at timeline 0..14. c2: asset b, source 16..30 at
	// timeline 14..28 (a source→timeline shift so mapping is observable).
	const clips = [
		clip({
			id: "c1",
			assetId: "a",
			sourceStartSec: 0,
			sourceEndSec: 14,
			timelineStartSec: 0,
			timelineEndSec: 14,
		}),
		clip({
			id: "c2",
			assetId: "b",
			sourceStartSec: 16,
			sourceEndSec: 30,
			timelineStartSec: 14,
			timelineEndSec: 28,
		}),
	];

	it("stays a single source range inside one clip (matches resolveTimelineSpanToTrim)", () => {
		expect(ventilateTimelineSpanToTrims(2, 4, clips)).toEqual([
			{ assetId: "a", clipId: "c1", sourceStartSec: 2, sourceEndSec: 4 },
		]);
	});

	it("splits a span across a clip boundary into one source range per clip", () => {
		// Timeline 10..20 covers c1 (10..14) and c2 (14..20).
		expect(ventilateTimelineSpanToTrims(10, 20, clips)).toEqual([
			{ assetId: "a", clipId: "c1", sourceStartSec: 10, sourceEndSec: 14 },
			// c2: source 16 + (14-14)=16 .. 16 + (20-14)=22.
			{ assetId: "b", clipId: "c2", sourceStartSec: 16, sourceEndSec: 22 },
		]);
	});

	it("returns [] when the span sits on no clip (caller falls back)", () => {
		expect(ventilateTimelineSpanToTrims(40, 45, clips)).toEqual([]);
	});
});

describe("coalescedTrimGroups", () => {
	it("groups two ventilation-produced fragments from one cross-boundary drag", () => {
		// c1 source [0,14) at timeline [0,14); c2 source [16,30) at timeline
		// [14,28) — a non-contiguous source gap, so trimToTimelineSpan can
		// unambiguously attribute each fragment to its own clip (matches the
		// fixture ventilateTimelineSpanToTrims's own tests use for the same
		// reason). Ventilating timeline 8..20 across these clips produces
		// exactly these two rows (source 8..14 on c1, source 16..22 on c2),
		// whose timeline spans touch exactly at 14.
		const clips = [
			clip({
				id: "c1",
				assetId: "a",
				sourceStartSec: 0,
				sourceEndSec: 14,
				timelineStartSec: 0,
				timelineEndSec: 14,
			}),
			clip({
				id: "c2",
				assetId: "a",
				sourceStartSec: 16,
				sourceEndSec: 30,
				timelineStartSec: 14,
				timelineEndSec: 28,
			}),
		];
		const trims = [
			trim({ id: "t1", assetId: "a", startSec: 8, endSec: 14 }), // -> timeline 8..14
			trim({ id: "t2", assetId: "a", startSec: 16, endSec: 22 }), // -> timeline 14..20
		];
		expect(coalescedTrimGroups(trims, clips)).toEqual([{ ids: ["t1", "t2"], start: 8, end: 20 }]);
	});

	it("groups two independently-created trims snapped to touching clip boundaries", () => {
		// Distinct from the ventilation case: two SEPARATE trims (not from one
		// drag), each fully inside its own clip, whose mapped timeline spans
		// happen to touch exactly at the clip boundary (e.g. both snapped there).
		const clips = [
			clip({
				id: "c1",
				assetId: "a",
				sourceStartSec: 0,
				sourceEndSec: 10,
				timelineStartSec: 0,
				timelineEndSec: 10,
			}),
			clip({
				id: "c2",
				assetId: "b",
				sourceStartSec: 0,
				sourceEndSec: 10,
				timelineStartSec: 10,
				timelineEndSec: 20,
			}),
		];
		const trims = [
			trim({ id: "t1", assetId: "a", startSec: 7, endSec: 10 }), // -> timeline 7..10
			trim({ id: "t2", assetId: "b", startSec: 0, endSec: 2 }), // -> timeline 10..12
		];
		expect(coalescedTrimGroups(trims, clips)).toEqual([{ ids: ["t1", "t2"], start: 7, end: 12 }]);
	});

	it("keeps a trim separated by a real gap in its own group", () => {
		const clips = [
			clip({
				id: "c1",
				assetId: "a",
				sourceStartSec: 0,
				sourceEndSec: 20,
				timelineStartSec: 0,
				timelineEndSec: 20,
			}),
		];
		const trims = [
			trim({ id: "t1", assetId: "a", startSec: 2, endSec: 4 }),
			trim({ id: "t2", assetId: "a", startSec: 10, endSec: 12 }),
		];
		expect(coalescedTrimGroups(trims, clips)).toEqual([
			{ ids: ["t1"], start: 2, end: 4 },
			{ ids: ["t2"], start: 10, end: 12 },
		]);
	});

	it("drops a trim whose carrying clip is gone, without corrupting other groups", () => {
		const clips = [
			clip({
				id: "c1",
				assetId: "a",
				sourceStartSec: 0,
				sourceEndSec: 10,
				timelineStartSec: 0,
				timelineEndSec: 10,
			}),
		];
		const trims = [
			trim({ id: "gone", assetId: "b", startSec: 0, endSec: 2 }), // no clip carries asset b
			trim({ id: "t1", assetId: "a", startSec: 3, endSec: 5 }),
		];
		expect(coalescedTrimGroups(trims, clips)).toEqual([{ ids: ["t1"], start: 3, end: 5 }]);
	});
});

// The reported bug, at the ruler: two clips over the SAME media with the SAME source
// window. Source time is per asset, so it cannot separate them — only `clipId` can.
// Every earlier fixture in this file sidesteps the ambiguity by giving the two clips
// disjoint source ranges, which is exactly why none of them caught this.
describe("two clips sharing one asset over the same source window", () => {
	const sharedClips = () => [
		clip({
			id: "c1",
			assetId: "a",
			sourceStartSec: 0,
			sourceEndSec: 12,
			timelineStartSec: 0,
			timelineEndSec: 12,
		}),
		clip({
			id: "c2",
			assetId: "a",
			sourceStartSec: 0,
			sourceEndSec: 12,
			timelineStartSec: 12,
			timelineEndSec: 24,
		}),
	];

	it("maps a trim anchored to the second clip onto the SECOND clip's ruler span", () => {
		// Without the anchor this returned {3,5} — the first clip — because the loop
		// stopped at the first clip whose asset and source window matched.
		expect(
			trimToTimelineSpan({ assetId: "a", clipId: "c2", startSec: 3, endSec: 5 }, sharedClips()),
		).toEqual({ start: 15, end: 17 });
	});

	it("keeps mapping an un-anchored trim to the first matching clip (pre-v7 behaviour)", () => {
		expect(trimToTimelineSpan({ assetId: "a", startSec: 3, endSec: 5 }, sharedClips())).toEqual({
			start: 3,
			end: 5,
		});
	});

	it("draws one pill per clip when each clip carries its own trim", () => {
		const trims = [
			trim({ id: "t1", assetId: "a", clipId: "c1", startSec: 3, endSec: 5 }),
			trim({ id: "t2", assetId: "a", clipId: "c2", startSec: 3, endSec: 5 }),
		];
		// Two pills, 12s apart — not one merged pill, and not two stacked on c1.
		expect(coalescedTrimGroups(trims, sharedClips())).toEqual([
			{ ids: ["t1"], start: 3, end: 5 },
			{ ids: ["t2"], start: 15, end: 17 },
		]);
	});

	it("drops an anchored trim whose clip is gone even though a twin clip remains", () => {
		// The twin still uses the same asset over the same source range, so an asset-only
		// match would resurrect the cut on it.
		const trims = [trim({ id: "orphan", assetId: "a", clipId: "c2", startSec: 3, endSec: 5 })];
		expect(coalescedTrimGroups(trims, [sharedClips()[0]])).toEqual([]);
	});

	it("still shows a pill when the anchor clip was re-cut past the trim's start", () => {
		// c2 narrowed to source [4,12]: the trim [3,5] still cuts [4,5] of it, so the
		// ruler has to show that remainder rather than hiding a cut the user can't undo.
		const clips = [
			clip({
				id: "c2",
				assetId: "a",
				sourceStartSec: 4,
				sourceEndSec: 12,
				timelineStartSec: 0,
				timelineEndSec: 8,
			}),
		];
		expect(
			trimToTimelineSpan({ assetId: "a", clipId: "c2", startSec: 3, endSec: 5 }, clips),
		).toEqual({ start: 0, end: 1 });
	});
});
