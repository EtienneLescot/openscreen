import { describe, expect, it } from "vitest";
import { resolvePlaybackSegments } from "../document/timeline";
import type { AxcutClip } from "../schema";
import { formatSeconds } from "./format";
import {
	clampVirtualTime,
	findNextKeptSegment,
	getRawVirtualStartTime,
	keptWordIdSet,
	locateKeptSegment,
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

	// The last ~50 ms of a clip: `reachedClipEnd` (VirtualPreview's rAF) fires at
	// `sourceEndSec - 0.04`, so this is the moment the tick has to still know which clip
	// it is on in order to advance to the RIGHT next one.
	describe("the closing edge of a clip, with a twin over the same recording", () => {
		const twins = (order: Array<{ id: string; assetId: string }>): AxcutClip[] => {
			let timelineStartSec = 0;
			return order.map((spec) => {
				const clip: AxcutClip = {
					...spec,
					sourceStartSec: 0,
					sourceEndSec: 10,
					timelineStartSec,
					timelineEndSec: timelineStartSec + 10,
					wordRefs: [],
					origin: "user",
					reason: "",
				};
				timelineStartSec += 10;
				return clip;
			});
		};
		const a1 = { id: "clip_a1", assetId: "a1" };
		const a2 = { id: "clip_a2", assetId: "a1" };
		const c3 = { id: "clip_c3", assetId: "c1" };

		// Before this, the preferred clip shared the ambiguous scan's EXCLUSIVE closing
		// edge, so at 9.96 it disowned its own last frames and the scan handed them to its
		// twin — reporting the playhead near the END of that twin (19.96 / 29.96). The rAF
		// then saw "clip end reached" on a clip nothing follows and stopped playback with
		// the playhead parked at the end of the timeline.
		it.each([
			["two clips over one recording", [a1, a2], "clip_a1", 9.96],
			["the same pair, laid down the other way round", [a2, a1], "clip_a2", 9.96],
			["a foreign clip between the twins", [a1, c3, a2], "clip_a1", 9.96],
			["a foreign clip before the twins", [c3, a1, a2], "clip_a1", 9.96],
			// This layout never showed the bug: the LAST array element was the foreign
			// clip, which the asset filter excluded, so the scan returned null and the rAF
			// fell back to timeline order. Same answer now, for a reason instead of by luck.
			["the foreign clip last", [a1, a2, c3], "clip_a1", 9.96],
		])("stays on the clip it is playing — %s", (_label, order, playing, sourceTimeSec) => {
			const clips = twins(order);
			const playingClip = clips.find((c) => c.id === playing);
			if (!playingClip) throw new Error("bad fixture");
			const pos = locateSourcePosition(
				clips,
				sourceTimeSec,
				playingClip.assetId,
				0.05,
				playingClip.id,
			);
			expect(pos?.clip.id).toBe(playing);
			expect(pos?.virtualTimeSec).toBeCloseTo(playingClip.timelineStartSec + sourceTimeSec, 6);
		});

		it("resolves the same clip whatever the clips' order, with no clip named", () => {
			// The scan cannot know which twin is playing — but its answer must at least not
			// depend on which twin happens to sit last in the array, which is what
			// `index === clips.length - 1` made it do.
			const forward = locateSourcePosition(twins([a1, a2]), 9.96, "a1");
			const reversed = locateSourcePosition(twins([a2, a1]), 9.96, "a1");
			expect(forward?.clip.id).toBe("clip_a1");
			expect(reversed?.clip.id).toBe("clip_a2");
			// i.e. both resolve to the FIRST clip of the asset — the documented behaviour of
			// the ambiguous scan (see the duplicate-clip case above), not to whichever one
			// was laid down last.
			expect(forward?.virtualTimeSec).toBeCloseTo(9.96, 6);
			expect(reversed?.virtualTimeSec).toBeCloseTo(9.96, 6);
		});

		it("still hands a shared boundary to the clip that starts there", () => {
			// A plain split: clip_1 ends where clip_2 begins. The exclusive edge exists for
			// exactly this, and the two-pass scan must not have loosened it.
			const split: AxcutClip[] = [
				{ ...twins([a1])[0], sourceStartSec: 0, sourceEndSec: 10 },
				{
					...twins([a2])[0],
					sourceStartSec: 10,
					sourceEndSec: 20,
					timelineStartSec: 10,
					timelineEndSec: 20,
				},
			];
			expect(locateSourcePosition(split, 10, "a1")?.clip.id).toBe("clip_a2");
			expect(locateSourcePosition(split, 9.9, "a1")?.clip.id).toBe("clip_a1");
			// …and the very end of the timeline still resolves rather than falling off it.
			expect(locateSourcePosition(split, 20, "a1")?.clip.id).toBe("clip_a2");
		});

		it("ignores a named clip whose asset is not the one playing", () => {
			// A stale id during an asset swap must fall through to the scan rather than
			// mapping the time through media that is not on screen.
			const clips = twins([a1, c3]);
			const pos = locateSourcePosition(clips, 5, "a1", 0.05, "clip_c3");
			expect(pos?.clip.id).toBe("clip_a1");
		});
	});

	describe("locateKeptSegment", () => {
		// clip_1 and clip_2 are the same recording twice. clip_1 carries a cut at source
		// 4–6; clip_2 carries none, so it KEEPS that stretch.
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
				assetId: "a1",
				sourceStartSec: 0,
				sourceEndSec: 10,
				timelineStartSec: 10,
				timelineEndSec: 20,
				wordRefs: [],
				origin: "user",
				reason: "",
			},
		];
		const playbackClips = resolvePlaybackSegments(rawClips, [
			{
				id: "trim_1",
				assetId: "a1",
				clipId: "clip_1",
				startSec: 4,
				endSec: 6,
				origin: "user",
				reason: "",
			},
		]);

		it("reports source time inside the playing clip's own cut as NOT kept", () => {
			// The twin keeps source 4–6, and the asset-wide scan used to accept its segment
			// as the answer — so the cut was never skipped while clip_1 played.
			expect(locateKeptSegment(playbackClips, rawClips, 5, "a1", "clip_1")).toBeNull();
		});

		it("reports the same source time as kept while the twin plays", () => {
			const pos = locateKeptSegment(playbackClips, rawClips, 5, "a1", "clip_2");
			expect(pos).not.toBeNull();
			expect(pos?.clip.id).toBe("clip_2");
		});

		it("keeps answering for content the playing clip does keep", () => {
			expect(locateKeptSegment(playbackClips, rawClips, 2, "a1", "clip_1")).not.toBeNull();
			expect(locateKeptSegment(playbackClips, rawClips, 8, "a1", "clip_1")).not.toBeNull();
		});

		it("falls back to the asset-wide scan when no clip is named yet", () => {
			// Before the first seek resolves a clip, there is nothing to be faithful to.
			expect(locateKeptSegment(playbackClips, rawClips, 5, "a1")).not.toBeNull();
		});
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

	describe("findNextKeptSegment never goes backwards", () => {
		// A slice from LATE in the recording laid down first, then a slice from early in
		// it, cut at source 5–10. Both draw on the same asset, so "later in source time"
		// spans two unrelated stretches of ruler.
		const rawClips: AxcutClip[] = [
			{
				id: "clip_1",
				assetId: "a1",
				sourceStartSec: 30,
				sourceEndSec: 40,
				timelineStartSec: 0,
				timelineEndSec: 10,
				wordRefs: [],
				origin: "user",
				reason: "",
			},
			{
				id: "clip_2",
				assetId: "a1",
				sourceStartSec: 0,
				sourceEndSec: 20,
				timelineStartSec: 10,
				timelineEndSec: 30,
				wordRefs: [],
				origin: "user",
				reason: "",
			},
		];
		const playbackClips = resolvePlaybackSegments(rawClips, [
			{
				id: "trim_1",
				assetId: "a1",
				clipId: "clip_2",
				startSec: 5,
				endSec: 10,
				origin: "user",
				reason: "",
			},
		]);

		it("resumes after the cut instead of jumping to the top of the timeline", () => {
			// Playing clip_2 at source 7 — inside its own cut — at raw position 10 + 7 = 17.
			// clip_1 starts at source 30, which IS "later in source time", and its raw start
			// is 0: answering it sent playback back to the beginning, straight into the same
			// cut again, forever.
			const next = findNextKeptSegment(playbackClips, rawClips, 17, "a1", 7, "clip_2");
			expect(next).toBeDefined();
			expect(getRawVirtualStartTime(next!, rawClips)).toBe(20);
			expect(next?.sourceStartSec).toBe(10);
		});

		it("uses the source clock to resume within the clip when the ruler lags", () => {
			// Same moment, but the raw position has not caught up (still reads 10, the start
			// of clip_2). The ruler test alone would answer clip_2's FIRST kept segment —
			// the stretch already played. The clip-scoped source test carries it past the cut.
			const next = findNextKeptSegment(playbackClips, rawClips, 10, "a1", 7, "clip_2");
			expect(next?.sourceStartSec).toBe(10);
		});
	});
});
