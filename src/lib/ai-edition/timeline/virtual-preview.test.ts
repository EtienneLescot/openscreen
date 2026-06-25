import { describe, expect, it } from "vitest";
import type { AxcutClip } from "../schema";
import {
	clampVirtualTime,
	formatSeconds,
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
});
