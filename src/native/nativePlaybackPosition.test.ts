import { describe, expect, it } from "vitest";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import { resolveNativePlaybackPosition } from "./nativePlaybackPosition";

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

describe("resolveNativePlaybackPosition", () => {
	it("tracks later source windows when three timeline clips share one asset", () => {
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

		expect(resolveNativePlaybackPosition(clips, 6.5)).toMatchObject({
			clip: { id: "c2" },
			clipIndex: 1,
			sourceTimeSec: 22.5,
		});
		expect(resolveNativePlaybackPosition(clips, 10)).toMatchObject({
			clip: { id: "c3" },
			clipIndex: 2,
			sourceTimeSec: 42,
		});
	});

	it("tracks the active source clock when each clip references a distinct asset", () => {
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

		expect(resolveNativePlaybackPosition(clips, 7.25)).toMatchObject({
			clip: { id: "b-clip", assetId: "asset-b" },
			clipIndex: 1,
			sourceTimeSec: 103.25,
		});
		expect(resolveNativePlaybackPosition(clips, 11)).toMatchObject({
			clip: { id: "c-clip", assetId: "asset-c" },
			clipIndex: 2,
			sourceTimeSec: 14,
		});
	});

	it("selects the new clip exactly at a boundary and returns null in a gap", () => {
		const clips = [
			clip({ id: "first", assetId: "a", sourceStartSec: 10, sourceEndSec: 14 }),
			clip({
				id: "second",
				assetId: "b",
				sourceStartSec: 30,
				sourceEndSec: 34,
				timelineStartSec: 5,
				timelineEndSec: 9,
			}),
		];

		expect(resolveNativePlaybackPosition(clips, 4.5)).toBeNull();
		expect(resolveNativePlaybackPosition(clips, 5)).toMatchObject({
			clip: { id: "second" },
			clipIndex: 1,
			sourceTimeSec: 30,
		});
	});
});
