import { describe, expect, it } from "vitest";
import type { AxcutAudioRegion } from "@/lib/ai-edition/schema";
import { layerSourcePosition, layerVolumeAt } from "./AudioLayersPlayback";

function region(overrides: Partial<AxcutAudioRegion> = {}): AxcutAudioRegion {
	return {
		id: "aud_1",
		startMs: 10_000,
		endMs: 20_000,
		assetId: "asset_m",
		kind: "music",
		offsetMs: 0,
		gainDb: 0,
		loop: false,
		fadeInMs: 0,
		fadeOutMs: 0,
		muted: false,
		origin: "user",
		...overrides,
	};
}

describe("layerSourcePosition", () => {
	it("maps timeline time to the source via the layer start and offset", () => {
		expect(layerSourcePosition(region({ offsetMs: 2000 }), 13, 60)).toBeCloseTo(5);
	});

	it("clamps a non-looping layer to the end of its source", () => {
		expect(layerSourcePosition(region(), 40, 30)).toBeCloseTo(30);
	});

	it("folds a looping layer back into the source", () => {
		// offset 0, source 4s: timeline 13 (= local 3) → 3; timeline 14.5 → 0.5.
		expect(layerSourcePosition(region({ loop: true }), 13, 4)).toBeCloseTo(3);
		expect(layerSourcePosition(region({ loop: true }), 14.5, 4)).toBeCloseTo(0.5);
	});

	it("folds a looping layer over the post-offset window, matching the export", () => {
		// offset 2s into a 6s file → the loop repeats source [2, 6): 4s long.
		// local 0 → 2; local 4 → 2 (wrapped); local 5 → 3.
		const r = region({ loop: true, offsetMs: 2000 });
		expect(layerSourcePosition(r, 10, 6)).toBeCloseTo(2);
		expect(layerSourcePosition(r, 14, 6)).toBeCloseTo(2);
		expect(layerSourcePosition(r, 15, 6)).toBeCloseTo(3);
	});

	it("holds a looping layer at the end when the offset leaves nothing to loop", () => {
		expect(layerSourcePosition(region({ loop: true, offsetMs: 5000 }), 12, 5)).toBeCloseTo(5);
	});

	it("is undefined-safe for unloaded metadata (0 duration)", () => {
		expect(layerSourcePosition(region(), 12, 0)).toBeCloseTo(2);
	});
});

describe("layerVolumeAt", () => {
	it("is unity mid-span with no fades", () => {
		expect(layerVolumeAt(region(), 5)).toBe(1);
	});

	it("ramps in over the fade-in", () => {
		const r = region({ fadeInMs: 1000 });
		expect(layerVolumeAt(r, 0)).toBe(0);
		expect(layerVolumeAt(r, 0.5)).toBeCloseTo(0.5);
		expect(layerVolumeAt(r, 1)).toBe(1);
	});

	it("ramps out over the fade-out", () => {
		const r = region({ fadeOutMs: 1000 });
		expect(layerVolumeAt(r, 9.5)).toBeCloseTo(0.5);
		expect(layerVolumeAt(r, 10)).toBe(0);
	});

	it("is zero when muted", () => {
		expect(layerVolumeAt(region({ muted: true }), 5)).toBe(0);
	});
});
