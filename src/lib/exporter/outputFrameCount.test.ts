// The numbers below are the contract with the Rust exporter, not a snapshot of this file's
// arithmetic. `speed_segments_match_the_exporter_frame_totals` in
// `crates/compositor/src/regions.rs` asserts the SAME table against
// `speed_segments_for_window`, which is what `walk_composited_timeline` iterates. Change one
// side and the other goes red — which is the point: a silent divergence here is a progress
// bar that lies, and it has already shipped once (OpenScreen#371, the "frozen at ~80%").

import { describe, expect, it } from "vitest";
import { clipOutputFrameCount, outputFrameCount } from "./outputFrameCount";

const FPS = 30;

describe("outputFrameCount", () => {
	it("counts a clip with no speed region at its plain duration", () => {
		expect(clipOutputFrameCount({ sourceStartSec: 0, sourceEndSec: 10 }, [], FPS)).toBe(300);
	});

	it("is the whole bug: a 1.25x clip emits 80% of the frames its duration suggests", () => {
		// 10 s at 30 fps looks like 300 frames and renders 240. The old total was the former,
		// so the bar stopped at exactly 80% and the export finished there.
		const naive = Math.round(10 * FPS);
		const real = clipOutputFrameCount(
			{ sourceStartSec: 0, sourceEndSec: 10 },
			[{ startSec: 0, endSec: 10, speed: 1.25 }],
			FPS,
		);
		expect(real).toBe(240);
		expect(real / naive).toBeCloseTo(0.8, 5);
	});

	it("counts a slow-motion clip above its duration", () => {
		// The other half of the same bug: a 0.5x region pins the bar at 100% for the second
		// half of the export instead of stopping short.
		expect(
			clipOutputFrameCount(
				{ sourceStartSec: 0, sourceEndSec: 10 },
				[{ startSec: 0, endSec: 10, speed: 0.5 }],
				FPS,
			),
		).toBe(600);
	});

	it("splits a partially covered clip into 1x and sped spans", () => {
		expect(
			clipOutputFrameCount(
				{ sourceStartSec: 0, sourceEndSec: 10 },
				[{ startSec: 2, endSec: 4, speed: 2 }],
				FPS,
			),
		).toBe(60 + 30 + 180);
	});

	it("clamps a region that runs past the trimmed window", () => {
		expect(
			clipOutputFrameCount(
				{ sourceStartSec: 1, sourceEndSec: 5 },
				[{ startSec: 0, endSec: 100, speed: 2 }],
				FPS,
			),
		).toBe(60);
	});

	it("never renders the same source time twice when two regions overlap", () => {
		// A stale payload can overlap; the first region keeps the covered portion, matching
		// `speed_segments_for_window`'s cursor.
		expect(
			clipOutputFrameCount(
				{ sourceStartSec: 0, sourceEndSec: 10 },
				[
					{ startSec: 2, endSec: 6, speed: 2 },
					{ startSec: 4, endSec: 8, speed: 4 },
				],
				FPS,
			),
		).toBe(60 + 60 + 15 + 60);
	});

	it("ignores a region belonging to another clip", () => {
		const clips = [
			{ sourceStartSec: 0, sourceEndSec: 10 },
			{ sourceStartSec: 0, sourceEndSec: 10 },
		];
		const regions = [{ startSec: 0, endSec: 10, speed: 2, clipIndex: 1 }];
		expect(outputFrameCount(clips, regions, FPS)).toBe(300 + 150);
	});

	it("applies a region with no clipIndex to every clip", () => {
		const clips = [
			{ sourceStartSec: 0, sourceEndSec: 10 },
			{ sourceStartSec: 0, sourceEndSec: 10 },
		];
		expect(outputFrameCount(clips, [{ startSec: 0, endSec: 10, speed: 2 }], FPS)).toBe(150 + 150);
	});

	it("treats a non-positive speed as 1x rather than dividing by it", () => {
		expect(
			clipOutputFrameCount(
				{ sourceStartSec: 0, sourceEndSec: 10 },
				[{ startSec: 0, endSec: 10, speed: 0 }],
				FPS,
			),
		).toBe(300);
	});

	it("never returns a total the callers would divide by zero", () => {
		expect(outputFrameCount([], [], FPS)).toBe(1);
		expect(outputFrameCount([{ sourceStartSec: 4, sourceEndSec: 4 }], [], FPS)).toBe(1);
		expect(outputFrameCount([{ sourceStartSec: 0, sourceEndSec: 10 }], [], 0)).toBe(1);
	});
});
