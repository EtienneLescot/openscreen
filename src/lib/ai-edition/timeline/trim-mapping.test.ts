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
			{ assetId: "a", sourceStartSec: 2, sourceEndSec: 4 },
		]);
	});

	it("splits a span across a clip boundary into one source range per clip", () => {
		// Timeline 10..20 covers c1 (10..14) and c2 (14..20).
		expect(ventilateTimelineSpanToTrims(10, 20, clips)).toEqual([
			{ assetId: "a", sourceStartSec: 10, sourceEndSec: 14 },
			// c2: source 16 + (14-14)=16 .. 16 + (20-14)=22.
			{ assetId: "b", sourceStartSec: 16, sourceEndSec: 22 },
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
