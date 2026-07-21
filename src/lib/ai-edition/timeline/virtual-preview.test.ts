import { describe, expect, it } from "vitest";
import type { AxcutClip } from "../schema";
import {
	clampVirtualTime,
	findNextKeptSegment,
	formatSeconds,
	getRawVirtualStartTime,
	keptWordIdSet,
	locateSourcePosition,
	locateVirtualPosition,
	totalVirtualDuration,
} from "./virtual-preview";

const clips: AxcutClip[] = [
	{
		id: "clip_1",
		assetId: "a1",
		sourceStartSec: 0,
		sourceEndSec: 10,
		timelineStartSec: 0,
		timelineEndSec: 10,
		wordRefs: ["w1", "w2"],
		origin: "system",
		reason: "",
	},
	{
		id: "clip_2",
		assetId: "a1",
		sourceStartSec: 20,
		sourceEndSec: 30,
		timelineStartSec: 10,
		timelineEndSec: 20,
		wordRefs: ["w3"],
		origin: "system",
		reason: "",
	},
];

describe("virtual-preview pure functions", () => {
	it("totalVirtualDuration returns the last clip's timelineEndSec", () => {
		expect(totalVirtualDuration(clips)).toBe(20);
		expect(totalVirtualDuration([])).toBe(0);
	});

	it("clampVirtualTime bounds to [0, total]", () => {
		expect(clampVirtualTime(clips, -5)).toBe(0);
		expect(clampVirtualTime(clips, 999)).toBe(20);
		expect(clampVirtualTime(clips, 15)).toBe(15);
	});

	it("locateVirtualPosition maps virtual time to source time", () => {
		const pos = locateVirtualPosition(clips, 12);
		expect(pos).not.toBeNull();
		expect(pos?.clipIndex).toBe(1);
		expect(pos?.sourceTimeSec).toBe(22);
	});

	it("locateVirtualPosition returns null for empty clips", () => {
		expect(locateVirtualPosition([], 0)).toBeNull();
	});

	it("locateSourcePosition maps source time back to virtual time", () => {
		const pos = locateSourcePosition(clips, 25);
		expect(pos).not.toBeNull();
		expect(pos?.virtualTimeSec).toBe(15);
	});

	it("locateSourcePosition returns null for source time in a cut", () => {
		expect(locateSourcePosition(clips, 15)).toBeNull();
	});

	it("keptWordIdSet flattens wordRefs from all clips", () => {
		expect(keptWordIdSet(clips)).toEqual(new Set(["w1", "w2", "w3"]));
	});

	it("formatSeconds formats mm:ss.s and h:mm:ss.s", () => {
		expect(formatSeconds(0)).toBe("0:00.0");
		expect(formatSeconds(65.4)).toBe("1:05.4");
		expect(formatSeconds(3661.5)).toBe("1:01:01.5");
	});

	it("locateSourcePosition filters by assetId when provided", () => {
		const multiClips: AxcutClip[] = [
			{
				id: "clip_1",
				assetId: "a1",
				sourceStartSec: 0,
				sourceEndSec: 10,
				timelineStartSec: 0,
				timelineEndSec: 10,
				wordRefs: [],
				origin: "system",
				reason: "",
			},
			{
				id: "clip_2",
				assetId: "a2",
				sourceStartSec: 0,
				sourceEndSec: 10,
				timelineStartSec: 10,
				timelineEndSec: 20,
				wordRefs: [],
				origin: "system",
				reason: "",
			},
		];
		const pos1 = locateSourcePosition(multiClips, 5, "a1");
		expect(pos1?.clip.id).toBe("clip_1");

		const pos2 = locateSourcePosition(multiClips, 5, "a2");
		expect(pos2?.clip.id).toBe("clip_2");

		const posNone = locateSourcePosition(multiClips, 5, "a3");
		expect(posNone).toBeNull();
	});

	it("locateSourcePosition prefers the given clip id when two clips share an asset and overlap in source-time", () => {
		// Same asset, identical (untrimmed) source range — e.g. the same clip
		// duplicated, or the same recording dropped onto the timeline twice.
		const duplicateClips: AxcutClip[] = [
			{
				id: "clip_1",
				assetId: "a1",
				sourceStartSec: 0,
				sourceEndSec: 10,
				timelineStartSec: 0,
				timelineEndSec: 10,
				wordRefs: [],
				origin: "system",
				reason: "",
			},
			{
				id: "clip_2",
				assetId: "a1",
				sourceStartSec: 0,
				sourceEndSec: 10,
				timelineStartSec: 10,
				timelineEndSec: 20,
				wordRefs: [],
				origin: "system",
				reason: "",
			},
		];

		// Without a preferred clip id, the ambiguous scan always resolves to
		// the earliest matching clip — this is the bug: playing back the
		// second clip's segment would still report position/identity for the
		// first.
		const ambiguous = locateSourcePosition(duplicateClips, 5, "a1");
		expect(ambiguous?.clip.id).toBe("clip_1");

		// With the currently-active clip id passed through, it's preferred
		// even though clip_1 also matches (assetId, sourceTime).
		const disambiguated = locateSourcePosition(duplicateClips, 5, "a1", 0.05, "clip_2");
		expect(disambiguated?.clip.id).toBe("clip_2");
		expect(disambiguated?.virtualTimeSec).toBe(15);

		// A preferred clip id that no longer applies (source time moved
		// outside its range) falls back to the ambiguous scan rather than
		// forcing a stale match.
		const outOfRange = locateSourcePosition(duplicateClips, 5, "a1", 0.05, "clip_3");
		expect(outOfRange?.clip.id).toBe("clip_1");
	});

	it("getRawVirtualStartTime maps a kept segment back to exact raw virtual start time", () => {
		const rawClips: AxcutClip[] = [
			{
				id: "clip_1",
				assetId: "a1",
				sourceStartSec: 0,
				sourceEndSec: 10,
				timelineStartSec: 0,
				timelineEndSec: 10,
				wordRefs: [],
				origin: "user",
				reason: "",
			},
			{
				id: "clip_2",
				assetId: "a2",
				sourceStartSec: 0,
				sourceEndSec: 10,
				timelineStartSec: 10,
				timelineEndSec: 20,
				wordRefs: [],
				origin: "user",
				reason: "",
			},
		];

		const segClip1Part2: AxcutClip = {
			...rawClips[0],
			id: "clip_1_seg2",
			sourceStartSec: 6,
			sourceEndSec: 10,
			timelineStartSec: 3,
			timelineEndSec: 7,
		};

		const segClip2Part1: AxcutClip = {
			...rawClips[1],
			id: "clip_2",
			sourceStartSec: 3.2,
			sourceEndSec: 10,
			timelineStartSec: 7,
			timelineEndSec: 13.8,
		};

		expect(getRawVirtualStartTime(segClip1Part2, rawClips)).toBe(6);
		expect(getRawVirtualStartTime(segClip2Part1, rawClips)).toBe(13.2);
	});

	it("findNextKeptSegment finds next kept segment across multi-clip trim boundary", () => {
		const rawClips: AxcutClip[] = [
			{
				id: "clip_1",
				assetId: "a1",
				sourceStartSec: 0,
				sourceEndSec: 7.5,
				timelineStartSec: 0,
				timelineEndSec: 7.5,
				wordRefs: [],
				origin: "user",
				reason: "",
			},
			{
				id: "clip_2",
				assetId: "a2",
				sourceStartSec: 0,
				sourceEndSec: 7.5,
				timelineStartSec: 7.5,
				timelineEndSec: 15.0,
				wordRefs: [],
				origin: "user",
				reason: "",
			},
		];

		// Multi-clip trim cut 2.5..7.5 on clip_1 and 0..3.2 on clip_2.
		// Kept segments:
		// seg 0: clip_1, source 0..2.5, timelineStart 0
		// seg 1: clip_2, source 3.2..7.5, timelineStart 2.5
		const playbackClips: AxcutClip[] = [
			{
				...rawClips[0],
				id: "clip_1",
				sourceStartSec: 0,
				sourceEndSec: 2.5,
				timelineStartSec: 0,
				timelineEndSec: 2.5,
			},
			{
				...rawClips[1],
				id: "clip_2",
				sourceStartSec: 3.2,
				sourceEndSec: 7.5,
				timelineStartSec: 2.5,
				timelineEndSec: 6.8,
			},
		];

		// At current raw virtual time 2.5s (end of seg 0), next kept segment is seg 1 (clip_2)
		const nextSeg = findNextKeptSegment(playbackClips, rawClips, 2.5, "a1", 2.5);
		expect(nextSeg).toBeDefined();
		expect(nextSeg?.id).toBe("clip_2");
		expect(nextSeg?.assetId).toBe("a2");
		expect(getRawVirtualStartTime(nextSeg!, rawClips)).toBe(10.7);
	});
});
