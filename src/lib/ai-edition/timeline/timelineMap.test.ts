// Tests for the timeline coordinate mapper. The invariant under test: a modifier
// (or the playhead) authored on the RAW ruler must resolve to the SAME source
// moment regardless of trims earlier on the timeline — the raw↔compressed↔source
// bug this module exists to kill. See docs/architecture/timeline-coordinate-refactor.md.

import { describe, expect, it } from "vitest";
import { resolvePlaybackSegments } from "../document/timeline";
import type { AxcutClip, AxcutTrimRange } from "../schema";
import {
	anchorRawRegionsToClips,
	anchorRegionsWithDerivedMs,
	clampSpanAgainstNeighbours,
	coalesceByIdentity,
	coalesceRegionsForRuler,
	projectRegionsToSource,
	regionIdentityKey,
	replacePillSpan,
	resolveNativePosition,
	resolvePillIds,
} from "./timelineMap";

function clip(overrides: Partial<AxcutClip> & Pick<AxcutClip, "id" | "assetId">): AxcutClip {
	return {
		id: overrides.id,
		assetId: overrides.assetId,
		sourceStartSec: 0,
		sourceEndSec: 4,
		timelineStartSec: 0,
		timelineEndSec: 4,
		wordRefs: [],
		origin: "user",
		reason: "test",
		...overrides,
	};
}

function trim(assetId: string, startSec: number, endSec: number): AxcutTrimRange {
	return { id: `t_${startSec}_${endSec}`, assetId, startSec, endSec, reason: "", origin: "user" };
}

type Region = { id: string; startMs: number; endMs: number; payload?: string };
const region = (id: string, startSec: number, endSec: number, payload?: string): Region => ({
	id,
	startMs: startSec * 1000,
	endMs: endSec * 1000,
	...(payload ? { payload } : {}),
});

describe("projectRegionsToSource", () => {
	it("passes a region through unchanged (no clipIndex) when there are no segments", () => {
		const out = projectRegionsToSource([region("r", 1.5, 4.25)], [], [], () => "x");
		expect(out).toEqual([{ id: "r", startMs: 1500, endMs: 4250 }]);
	});

	it("maps a region to source time on an identity single clip", () => {
		const c = clip({
			id: "c1",
			assetId: "a",
			sourceStartSec: 0,
			sourceEndSec: 10,
			timelineEndSec: 10,
		});
		const out = projectRegionsToSource([region("r", 3, 5)], [c], [c], () => "x");
		expect(out).toEqual([{ id: "r", startMs: 3000, endMs: 5000, clipIndex: 0 }]);
	});

	it("keeps a region on its source moment despite a trim before it (the core bug)", () => {
		// Identity clip src[0,10]==raw[0,10]; trim removes src[2,4]. A region at raw[6,8]
		// must still land on source [6,8] — NOT [8,10] (compressed-vs-raw slip by 2s).
		const c = clip({
			id: "c1",
			assetId: "a",
			sourceStartSec: 0,
			sourceEndSec: 10,
			timelineEndSec: 10,
		});
		const segments = resolvePlaybackSegments([c], [trim("a", 2, 4)]);
		const out = projectRegionsToSource([region("r", 6, 8)], segments, [c], () => "x");
		expect(out).toEqual([{ id: "r", startMs: 6000, endMs: 8000, clipIndex: 1 }]);
	});

	it("splits a region straddling two clips into one entry per clip, payload preserved", () => {
		const c1 = clip({
			id: "c1",
			assetId: "a",
			sourceStartSec: 100,
			sourceEndSec: 105,
			timelineStartSec: 0,
			timelineEndSec: 5,
		});
		const c2 = clip({
			id: "c2",
			assetId: "a",
			sourceStartSec: 200,
			sourceEndSec: 205,
			timelineStartSec: 5,
			timelineEndSec: 10,
		});
		const out = projectRegionsToSource([region("r", 3, 7, "keep")], [c1, c2], [c1, c2], () => "r2");
		expect(out).toEqual([
			{ id: "r", startMs: 103000, endMs: 105000, clipIndex: 0, payload: "keep" },
			{ id: "r2", startMs: 200000, endMs: 202000, clipIndex: 1, payload: "keep" },
		]);
	});

	it("splits a region whose source range a trim cuts across two kept segments", () => {
		// Identity clip src[0,10]; trim removes src[4,6]. Region raw[3,8] covers source
		// [3,4] (seg1, kept) + [6,8] (seg2, kept); the [4,6] middle is trimmed away.
		const c = clip({
			id: "c1",
			assetId: "a",
			sourceStartSec: 0,
			sourceEndSec: 10,
			timelineEndSec: 10,
		});
		const segments = resolvePlaybackSegments([c], [trim("a", 4, 6)]);
		const out = projectRegionsToSource([region("r", 3, 8)], segments, [c], () => "r2");
		expect(out).toEqual([
			{ id: "r", startMs: 3000, endMs: 4000, clipIndex: 0 },
			{ id: "r2", startMs: 6000, endMs: 8000, clipIndex: 1 },
		]);
	});

	it("drops a region a trim removes entirely rather than leaking it onto a later clip", () => {
		// The reported bug: an effect fully UNDER a trim fired later instead of being ignored.
		// Two clips of DIFFERENT assets whose source windows overlap numerically (c1: asset a
		// [0,10] @ raw[0,10]; c2: asset b [0,10] @ raw[10,20]). A zoom anchored to c1 at source
		// [3,5] is then fully trimmed away on c1 (trim removes a[2,8]; c2's asset b is
		// untouched). It must VANISH — not reappear during c2, whose source window [0,10]
		// numerically contains [3,5]. A clipIndex-less passthrough used to re-emit it with raw
		// coords, and native's `belongs()` then matched it on c2 (any overlapping clip).
		const c1 = clip({
			id: "c1",
			assetId: "a",
			sourceStartSec: 0,
			sourceEndSec: 10,
			timelineStartSec: 0,
			timelineEndSec: 10,
		});
		const c2 = clip({
			id: "c2",
			assetId: "b",
			sourceStartSec: 0,
			sourceEndSec: 10,
			timelineStartSec: 10,
			timelineEndSec: 20,
		});
		const segments = resolvePlaybackSegments([c1, c2], [trim("a", 2, 8)]);
		const anchored = { ...region("r", 3, 5), clipId: "c1", sourceStartSec: 3, sourceEndSec: 5 };
		expect(projectRegionsToSource([anchored], segments, [c1, c2], () => "x")).toEqual([]);
	});

	it("drops an unanchored region that a trim removes entirely", () => {
		// The same class for an un-migrated (v1.7-imported) region that has only its RAW span:
		// raw[4.5,5.5] sits inside the removed stretch a[4,6], so it maps to no kept segment
		// and must be dropped — not passed through with its raw coords onto the native scene.
		const c = clip({
			id: "c1",
			assetId: "a",
			sourceStartSec: 0,
			sourceEndSec: 10,
			timelineEndSec: 10,
		});
		const segments = resolvePlaybackSegments([c], [trim("a", 4, 6)]);
		expect(projectRegionsToSource([region("r", 4.5, 5.5)], segments, [c], () => "x")).toEqual([]);
	});

	// --- anchored path: the anchor is the SSOT, `startMs`/`endMs` are not consulted ---

	it("places an anchored region from its anchor, ignoring a stale startMs/endMs", () => {
		// THE property phase 1 buys: the derived ms cache is deliberately WRONG here
		// (raw[0,1] — nowhere near the truth). A region that reads the anchor lands on
		// source [6,8]; one that still trusted the cache would land on [0,1].
		const c = clip({
			id: "c1",
			assetId: "a",
			sourceStartSec: 0,
			sourceEndSec: 10,
			timelineEndSec: 10,
		});
		const stale = {
			...region("r", 0, 1),
			clipId: "c1",
			sourceStartSec: 6,
			sourceEndSec: 8,
		};
		const out = projectRegionsToSource([stale], [c], [c], () => "x");
		expect(out).toEqual([{ ...stale, startMs: 6000, endMs: 8000, clipIndex: 0 }]);
	});

	it("splits an anchored region across the kept segments of its own clip", () => {
		// Same trim geometry as the unanchored split above, driven purely by the anchor.
		const c = clip({
			id: "c1",
			assetId: "a",
			sourceStartSec: 0,
			sourceEndSec: 10,
			timelineEndSec: 10,
		});
		const segments = resolvePlaybackSegments([c], [trim("a", 4, 6)]);
		const anchored = {
			...region("r", 3, 8),
			clipId: "c1",
			sourceStartSec: 3,
			sourceEndSec: 8,
		};
		const out = projectRegionsToSource([anchored], segments, [c], () => "r2");
		expect(out).toEqual([
			{ ...anchored, id: "r", startMs: 3000, endMs: 4000, clipIndex: 0 },
			{ ...anchored, id: "r2", startMs: 6000, endMs: 8000, clipIndex: 1 },
		]);
	});

	it("never places an anchored region on a different clip that shares the asset", () => {
		// Two clips, same asset, overlapping source windows. The anchor names c2, so the
		// region must appear ONCE, on c2 — the camera/record mix-up this model prevents.
		const c1 = clip({
			id: "c1",
			assetId: "a",
			sourceStartSec: 0,
			sourceEndSec: 5,
			timelineStartSec: 0,
			timelineEndSec: 5,
		});
		const c2 = clip({
			id: "c2",
			assetId: "a",
			sourceStartSec: 0,
			sourceEndSec: 5,
			timelineStartSec: 5,
			timelineEndSec: 10,
		});
		const anchored = {
			...region("r", 1, 2),
			clipId: "c2",
			sourceStartSec: 1,
			sourceEndSec: 2,
		};
		const out = projectRegionsToSource([anchored], [c1, c2], [c1, c2], () => "x");
		expect(out).toEqual([{ ...anchored, startMs: 1000, endMs: 2000, clipIndex: 1 }]);
	});

	it("falls back to the raw mapping when the anchor is incomplete", () => {
		// Migration keeps un-anchorable regions (never drops them), so a partial anchor
		// must still resolve via the legacy raw path rather than vanishing.
		const c = clip({
			id: "c1",
			assetId: "a",
			sourceStartSec: 0,
			sourceEndSec: 10,
			timelineEndSec: 10,
		});
		const partial = { ...region("r", 3, 5), clipId: "c1" }; // no source span
		const out = projectRegionsToSource([partial], [c], [c], () => "x");
		expect(out).toEqual([{ ...partial, startMs: 3000, endMs: 5000, clipIndex: 0 }]);
	});
});

describe("resolveNativePosition", () => {
	it("tracks later source windows when three clips share one asset (no trims)", () => {
		const clips = [
			clip({ id: "c1", assetId: "shared", sourceStartSec: 0, sourceEndSec: 4 }),
			clip({
				id: "c2",
				assetId: "shared",
				sourceStartSec: 20,
				sourceEndSec: 24,
				timelineStartSec: 4,
				timelineEndSec: 8,
			}),
			clip({
				id: "c3",
				assetId: "shared",
				sourceStartSec: 40,
				sourceEndSec: 44,
				timelineStartSec: 8,
				timelineEndSec: 12,
			}),
		];
		expect(resolveNativePosition(6.5, clips, clips)).toMatchObject({
			clip: { id: "c2" },
			clipIndex: 1,
			sourceTimeSec: 22.5,
		});
		expect(resolveNativePosition(10, clips, clips)).toMatchObject({
			clip: { id: "c3" },
			clipIndex: 2,
			sourceTimeSec: 42,
		});
	});

	it("tracks the active source clock (and thus the right asset/camera) across distinct assets", () => {
		const clips = [
			clip({ id: "a-clip", assetId: "asset-a", sourceStartSec: 5, sourceEndSec: 9 }),
			clip({
				id: "b-clip",
				assetId: "asset-b",
				sourceStartSec: 100,
				sourceEndSec: 105,
				timelineStartSec: 4,
				timelineEndSec: 9,
			}),
			clip({
				id: "c-clip",
				assetId: "asset-c",
				sourceStartSec: 12,
				sourceEndSec: 15,
				timelineStartSec: 9,
				timelineEndSec: 12,
			}),
		];
		expect(resolveNativePosition(7.25, clips, clips)).toMatchObject({
			clip: { assetId: "asset-b" },
			clipIndex: 1,
			sourceTimeSec: 103.25,
		});
		expect(resolveNativePosition(11, clips, clips)).toMatchObject({
			clip: { assetId: "asset-c" },
			clipIndex: 2,
			sourceTimeSec: 14,
		});
	});

	it("resolves the playhead to the correct source time after a trim (no compressed slip)", () => {
		const c = clip({
			id: "c1",
			assetId: "a",
			sourceStartSec: 0,
			sourceEndSec: 10,
			timelineEndSec: 10,
		});
		const segments = resolvePlaybackSegments([c], [trim("a", 2, 4)]);
		// raw 1 → source 1 on seg1; raw 6 → source 6 on seg2 (NOT 8).
		expect(resolveNativePosition(1, segments, [c])).toMatchObject({
			clipIndex: 0,
			sourceTimeSec: 1,
		});
		expect(resolveNativePosition(6, segments, [c])).toMatchObject({
			clipIndex: 1,
			sourceTimeSec: 6,
		});
	});

	it("snaps to the next kept segment when the playhead sits over a trimmed-out stretch", () => {
		const c = clip({
			id: "c1",
			assetId: "a",
			sourceStartSec: 0,
			sourceEndSec: 10,
			timelineEndSec: 10,
		});
		const segments = resolvePlaybackSegments([c], [trim("a", 2, 4)]);
		// raw 3 is inside the removed [2,4] stretch → resume at seg2's source start (4).
		expect(resolveNativePosition(3, segments, [c])).toMatchObject({
			clipIndex: 1,
			sourceTimeSec: 4,
		});
	});

	it("returns null when there are no segments", () => {
		expect(resolveNativePosition(1, [], [])).toBeNull();
	});
});

describe("anchorRawRegionsToClips (v4→v5 migration core)", () => {
	// goodtest's real layout: clip A [asset_f] src[0,25.557313] raw[0,25.557313],
	// clip B [asset_e] src[0,8.149313] raw[25.557313,33.706626].
	const clipA = clip({
		id: "clip_a",
		assetId: "asset_f",
		sourceStartSec: 0,
		sourceEndSec: 25.557313,
		timelineStartSec: 0,
		timelineEndSec: 25.557313,
	});
	const clipB = clip({
		id: "clip_b",
		assetId: "asset_e",
		sourceStartSec: 0,
		sourceEndSec: 8.149313,
		timelineStartSec: 25.557313,
		timelineEndSec: 33.706626,
	});

	it("splits a straddling region into one anchored entry per clip, payload preserved", () => {
		// goodtest speed [8149,28575]ms straddles A→B; first entry keeps the id.
		let n = 0;
		const out = anchorRawRegionsToClips(
			[{ id: "s_straddle", startMs: 8149, endMs: 28575, speed: 3 }],
			[clipA, clipB],
			() => `gen_${n++}`,
		);
		expect(out).toHaveLength(2);
		// The two fragments carry no shared marker: equal properties + adjacency is what
		// makes them read as one pill.
		expect(out[0]).toMatchObject({
			id: "s_straddle",
			clipId: "clip_a",
			speed: 3,
		});
		expect(out[0].sourceStartSec).toBeCloseTo(8.149, 5);
		expect(out[0].sourceEndSec).toBeCloseTo(25.557313, 5);
		expect(out[1]).toMatchObject({
			id: "gen_0",
			clipId: "clip_b",
			speed: 3,
		});
		expect(out[1].sourceStartSec).toBeCloseTo(0, 5);
		expect(out[1].sourceEndSec).toBeCloseTo(3.017687, 5);
		// No leftover RAW-ms fields on the anchored shape.
		expect(out[0]).not.toHaveProperty("startMs");
		expect(out[0]).not.toHaveProperty("endMs");
	});

	it("anchors a region wholly inside one clip to that clip, keeping its id", () => {
		let n = 0;
		const out = anchorRawRegionsToClips(
			[{ id: "s_inA", startMs: 2151, endMs: 8149, speed: 3 }],
			[clipA, clipB],
			() => `gen_${n++}`,
		);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ id: "s_inA", clipId: "clip_a", speed: 3 });
		expect(out[0].sourceStartSec).toBeCloseTo(2.151, 5);
		expect(out[0].sourceEndSec).toBeCloseTo(8.149, 5);
	});

	it("drops a zero-length / off-timeline region (covers no clip, can never play)", () => {
		let n = 0;
		const out = anchorRawRegionsToClips(
			[
				{ id: "s_zero", startMs: 8149, endMs: 8149, speed: 3 },
				{ id: "s_past_end", startMs: 40000, endMs: 42000, speed: 3 },
			],
			[clipA, clipB],
			() => `gen_${n++}`,
		);
		expect(out).toEqual([]);
	});
});

// ─── The two universal region rules ────────────────────────────────────────

describe("regionIdentityKey (what a region IS)", () => {
	it("ignores position and provenance entirely", () => {
		const a = { id: "a", clipId: "c1", startMs: 0, endMs: 1000, sourceStartSec: 0, speed: 3 };
		const b = {
			id: "b",
			clipId: "c2",
			startMs: 90000,
			endMs: 92000,
			sourceStartSec: 40,
			origin: "agent",
			reason: "whatever",
			speed: 3,
		};
		expect(regionIdentityKey(a)).toBe(regionIdentityKey(b));
	});

	it("separates regions whose properties differ", () => {
		expect(regionIdentityKey({ id: "a", speed: 3 })).not.toBe(
			regionIdentityKey({ id: "b", speed: 2 }),
		);
		expect(regionIdentityKey({ id: "a", depth: 3, focus: { cx: 0.5, cy: 0.5 } })).not.toBe(
			regionIdentityKey({ id: "b", depth: 3, focus: { cx: 0.2, cy: 0.5 } }),
		);
	});

	it("is stable against key order, including nested objects", () => {
		expect(regionIdentityKey({ id: "a", depth: 3, focus: { cy: 0.4, cx: 0.1 } })).toBe(
			regionIdentityKey({ focus: { cx: 0.1, cy: 0.4 }, depth: 3, id: "b" }),
		);
	});

	it("collapses a property-less kind (trim / full-camera) to a constant → always mergeable", () => {
		const t1 = { id: "t1", assetId: "a", startSec: 0, endSec: 2, reason: "", origin: "user" };
		const t2 = { id: "t2", assetId: "b", startSec: 9, endSec: 9.5, reason: "x", origin: "agent" };
		expect(regionIdentityKey(t1)).toBe(regionIdentityKey(t2));
	});
});

describe("coalesceByIdentity (rule 1 — merge)", () => {
	const span = (id: string, start: number, end: number, identity: string) => ({
		id,
		start,
		end,
		identity,
	});

	it("merges touching spans of the same identity regardless of provenance", () => {
		const out = coalesceByIdentity([span("a", 0, 5, "x"), span("b", 5, 9, "x")]);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ start: 0, end: 9, ids: ["a", "b"] });
	});

	it("never merges touching spans of different identity", () => {
		const out = coalesceByIdentity([span("a", 0, 5, "fast"), span("b", 5, 9, "slow")]);
		expect(out).toHaveLength(2);
	});

	it("does not merge same-identity spans separated by a gap", () => {
		const out = coalesceByIdentity([span("a", 0, 5, "x"), span("b", 7, 9, "x")]);
		expect(out).toHaveLength(2);
	});

	it("property-less kinds (constant identity) always merge when adjacent — the trim rule, derived", () => {
		const out = coalesceByIdentity([
			span("t1", 0, 2, ""),
			span("t2", 2, 4, ""),
			span("t3", 4, 6, ""),
		]);
		expect(out).toHaveLength(1);
		expect(out[0].ids).toEqual(["t1", "t2", "t3"]);
	});

	it("split → change a property → rejoined: stays TWO pills (identity mismatch)", () => {
		// The exact scenario: one region split by a reorder, one half edited, clips restored.
		const rejoinedButEdited = coalesceByIdentity([
			span("half1", 0, 5, regionIdentityKey({ speed: 3 })),
			span("half2", 5, 9, regionIdentityKey({ speed: 2 })),
		]);
		expect(rejoinedButEdited).toHaveLength(2);
		// …and if the property is put back, they merge again, with no memory of the split.
		const rejoinedUnedited = coalesceByIdentity([
			span("half1", 0, 5, regionIdentityKey({ speed: 3 })),
			span("half2", 5, 9, regionIdentityKey({ speed: 3 })),
		]);
		expect(rejoinedUnedited).toHaveLength(1);
	});
});

describe("clampSpanAgainstNeighbours (rule 2 — repel)", () => {
	const other = (id: string, start: number, end: number, identity: string) => ({
		id,
		start,
		end,
		identity,
	});

	it("stops at a different-identity neighbour on the right", () => {
		const out = clampSpanAgainstNeighbours({ start: 0, end: 8 }, "fast", [
			other("n", 5, 12, "slow"),
		]);
		expect(out).toEqual({ start: 0, end: 5 });
	});

	it("stops at a different-identity neighbour on the left", () => {
		const out = clampSpanAgainstNeighbours({ start: 3, end: 10 }, "fast", [
			other("n", 0, 5, "slow"),
		]);
		expect(out).toEqual({ start: 5, end: 10 });
	});

	it("treats a same-identity neighbour as no obstacle (they simply merge)", () => {
		const out = clampSpanAgainstNeighbours({ start: 0, end: 8 }, "fast", [
			other("n", 5, 12, "fast"),
		]);
		expect(out).toEqual({ start: 0, end: 8 });
	});

	it("is squeezed by blockers on both sides", () => {
		const out = clampSpanAgainstNeighbours({ start: 1, end: 10 }, "fast", [
			other("l", 0, 3, "slow"),
			other("r", 7, 12, "other"),
		]);
		expect(out).toEqual({ start: 3, end: 7 });
	});

	it("leaves a span that overlaps nothing untouched", () => {
		expect(
			clampSpanAgainstNeighbours({ start: 2, end: 4 }, "fast", [other("n", 8, 9, "slow")]),
		).toEqual({ start: 2, end: 4 });
	});
});

describe("pills wired to the universal rules", () => {
	const clipA = clip({
		id: "clip_a",
		assetId: "asset_f",
		sourceStartSec: 0,
		sourceEndSec: 25.557313,
		timelineStartSec: 0,
		timelineEndSec: 25.557313,
	});
	const clipB = clip({
		id: "clip_b",
		assetId: "asset_e",
		sourceStartSec: 0,
		sourceEndSec: 8.149313,
		timelineStartSec: 25.557313,
		timelineEndSec: 33.706626,
	});
	const clips = [clipA, clipB];
	const ids = () => {
		let n = 0;
		return () => `gen_${n++}`;
	};

	it("merges two INDEPENDENTLY authored adjacent regions with equal properties", () => {
		// Never authored as one region, never split — they merge purely because they are
		// indistinguishable. This is what the groupId model could not do.
		const pills = coalesceRegionsForRuler([
			{ id: "a", startMs: 2000, endMs: 5000, speed: 3 },
			{ id: "b", startMs: 5000, endMs: 9000, speed: 3 },
		]);
		expect(pills).toHaveLength(1);
		expect(pills[0].ids).toEqual(["a", "b"]);
	});

	it("keeps adjacent regions with different properties as separate pills", () => {
		const pills = coalesceRegionsForRuler([
			{ id: "a", startMs: 2000, endMs: 5000, speed: 3 },
			{ id: "b", startMs: 5000, endMs: 9000, speed: 1.5 },
		]);
		expect(pills).toHaveLength(2);
	});

	it("resolvePillIds returns every region under the pill, from any member id", () => {
		const regions = [
			{ id: "a", startMs: 2000, endMs: 5000, speed: 3 },
			{ id: "b", startMs: 5000, endMs: 9000, speed: 3 },
			{ id: "c", startMs: 20000, endMs: 21000, speed: 3 },
		];
		expect(resolvePillIds(regions, "b").sort()).toEqual(["a", "b"]);
		expect(resolvePillIds(regions, "c")).toEqual(["c"]);
	});

	it("resizing a pill across a clip boundary re-anchors it into one fragment per clip", () => {
		const regions = anchorRegionsWithDerivedMs(
			[{ id: "s", startMs: 2000, endMs: 5000, speed: 3 }],
			clips,
			ids(),
		);
		const out = replacePillSpan(regions, "s", 20000, 28000, clips, ids());
		expect(out).toHaveLength(2);
		expect(out.map((r) => (r as { clipId?: string }).clipId)).toEqual(["clip_a", "clip_b"]);
		// …and it still reads as a single pill, because the halves share properties.
		expect(coalesceRegionsForRuler(out)).toHaveLength(1);
	});

	it("clamps a resize at a neighbouring pill of different properties (magnet)", () => {
		const regions = [
			...anchorRegionsWithDerivedMs(
				[{ id: "fast", startMs: 0, endMs: 4000, speed: 3 }],
				clips,
				ids(),
			),
			...anchorRegionsWithDerivedMs(
				[{ id: "slow", startMs: 10000, endMs: 15000, speed: 1.5 }],
				clips,
				ids(),
			),
		];
		// Try to stretch `fast` well into `slow`; it must stop at slow's edge (10s).
		const out = replacePillSpan(regions, "fast", 0, 13000, clips, ids());
		const fast = out.find((r) => (r as { speed?: number }).speed === 3);
		const slow = out.find((r) => (r as { speed?: number }).speed === 1.5);
		expect(fast?.endMs).toBe(10000);
		// the neighbour is never moved or trimmed
		expect(slow?.startMs).toBe(10000);
		expect(slow?.endMs).toBe(15000);
	});
});

describe("legacy groupId must never affect identity (regression: test 1)", () => {
	it("merges two independently authored regions that carry DIFFERENT legacy groupIds", () => {
		// Reproduces the in-app failure: both regions were migrated to v5 and kept a
		// groupId from the removed group model. Same speed, exactly adjacent → one pill.
		const pills = coalesceRegionsForRuler([
			{ id: "a", groupId: "grp_a", startMs: 6599, endMs: 8149, speed: 0.75 },
			{ id: "b", groupId: "grp_b", startMs: 8149, endMs: 14349, speed: 0.75 },
		]);
		expect(pills).toHaveLength(1);
		expect(pills[0].ids).toEqual(["a", "b"]);
	});

	it("still separates them when a real property differs", () => {
		const pills = coalesceRegionsForRuler([
			{ id: "a", groupId: "grp_a", startMs: 6599, endMs: 8149, speed: 0.75 },
			{ id: "b", groupId: "grp_b", startMs: 8149, endMs: 14349, speed: 2 },
		]);
		expect(pills).toHaveLength(2);
	});

	it("drops groupId when re-anchoring, so it stops propagating", () => {
		const c = clip({
			id: "c1",
			assetId: "a",
			sourceStartSec: 0,
			sourceEndSec: 20,
			timelineEndSec: 20,
		});
		const out = anchorRegionsWithDerivedMs(
			[{ id: "s", groupId: "legacy", startMs: 2000, endMs: 5000, speed: 3 }],
			[c],
			() => "gen",
		);
		expect(out[0]).not.toHaveProperty("groupId");
	});
});
