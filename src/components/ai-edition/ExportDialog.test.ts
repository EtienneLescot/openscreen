import { describe, expect, it } from "vitest";
import {
	collectEffectiveClipDims,
	collectUsedAssetDims,
	pickExtremeDims,
} from "@/lib/ai-edition/document/outputFormat";
import type { AxcutAsset, AxcutClip, AxcutDocument } from "@/lib/ai-edition/schema";

function asset(p: Partial<AxcutAsset> & Pick<AxcutAsset, "id">): AxcutAsset {
	return {
		kind: "video",
		label: "asset",
		originalPath: "/tmp/a.mp4",
		cameraTrack: null,
		...p,
	};
}

function clip(p: Partial<AxcutClip> & Pick<AxcutClip, "id" | "assetId">): AxcutClip {
	return {
		sourceStartSec: 0,
		sourceEndSec: 10,
		timelineStartSec: 0,
		timelineEndSec: 10,
		wordRefs: [],
		origin: "user",
		reason: "",
		...p,
	};
}

function doc(assets: AxcutAsset[], clips: AxcutClip[]): AxcutDocument {
	return {
		schemaVersion: 3,
		project: {
			id: "proj_1",
			title: "Test",
			createdAt: "2026-06-26T10:00:00Z",
			updatedAt: "2026-06-26T10:00:00Z",
			primaryAssetId: assets[0]?.id ?? "asset_1",
		},
		assets,
		transcript: null,
		transcripts: [],
		timeline: {
			clips,
			gaps: [],
			trimRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		annotations: [],
		zoomRanges: [],
		legacyEditor: null,
		agent: { pendingQuestions: [], suggestions: [], lastAppliedOperations: [] },
		preview: { strategy: "seek", revision: 0 },
		export: { preset: "final-balanced", lastJobId: null },
		history: { revisions: [] },
	};
}

describe("pickExtremeDims", () => {
	it("picks the largest by pixel count", () => {
		const items = [
			{ width: 640, height: 360 },
			{ width: 1920, height: 1080 },
			{ width: 100, height: 100 },
		];
		expect(pickExtremeDims(items, "largest")).toEqual({ width: 1920, height: 1080 });
	});

	it("picks the smallest by pixel count", () => {
		const items = [
			{ width: 640, height: 360 },
			{ width: 1920, height: 1080 },
			{ width: 100, height: 100 },
		];
		expect(pickExtremeDims(items, "smallest")).toEqual({ width: 100, height: 100 });
	});

	it("ignores zero/invalid dims and returns null when nothing usable remains", () => {
		expect(pickExtremeDims([{ width: 0, height: 0 }], "largest")).toBeNull();
		expect(pickExtremeDims([], "largest")).toBeNull();
	});
});

describe("collectEffectiveClipDims", () => {
	it("uses the CROP's true pixel size for a cropped clip, not the full asset resolution", () => {
		// The reported bug: a 1920x1080 (16:9) source cropped to an exact 9:16 vertical
		// strip must be sized off the crop's own ~340x1080 footprint, not 1920x1080.
		const a = asset({ id: "a1", video: { codec: "h264", width: 1920, height: 1080, fps: 30 } });
		const cropW = (9 / 16) * (1080 / 1920);
		const clips = [
			clip({
				id: "c1",
				assetId: "a1",
				cropRegion: { x: (1 - cropW) / 2, y: 0, width: cropW, height: 1 },
			}),
		];
		const dims = collectEffectiveClipDims(doc([a], clips), {});
		expect(dims).toHaveLength(1);
		expect(dims[0].height).toBe(1080);
		// ~608px wide (1920 * cropW, rounded to even) — nowhere near the full 1920.
		expect(dims[0].width).toBeLessThan(700);
		expect(dims[0].width).toBeGreaterThan(600);
	});

	it("treats an unset cropRegion as the identity crop (full asset size)", () => {
		const a = asset({ id: "a1", video: { codec: "h264", width: 1920, height: 1080, fps: 30 } });
		const clips = [clip({ id: "c1", assetId: "a1" })];
		expect(collectEffectiveClipDims(doc([a], clips), {})).toEqual([{ width: 1920, height: 1080 }]);
	});

	it("resolves the same asset cropped differently across two clips to two different sizes", () => {
		const a = asset({ id: "a1", video: { codec: "h264", width: 1920, height: 1080, fps: 30 } });
		const clips = [
			clip({ id: "c1", assetId: "a1" }),
			clip({
				id: "c2",
				assetId: "a1",
				cropRegion: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
			}),
		];
		const dims = collectEffectiveClipDims(doc([a], clips), {});
		expect(dims).toEqual([
			{ width: 1920, height: 1080 },
			{ width: 960, height: 540 },
		]);
	});

	it("falls back to raw (uncropped) asset dims while nothing has probed yet", () => {
		const a = asset({ id: "a1" }); // no `.video` — not probed yet
		const clips = [clip({ id: "c1", assetId: "a1" })];
		expect(collectEffectiveClipDims(doc([a], clips), { a1: { width: 1280, height: 720 } })).toEqual(
			[{ width: 1280, height: 720 }],
		);
	});
});

describe("collectUsedAssetDims", () => {
	it("only considers assets actually referenced by a clip", () => {
		const used = asset({
			id: "used",
			video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
		});
		const unused = asset({
			id: "unused",
			video: { codec: "h264", width: 3840, height: 2160, fps: 30 },
		});
		const clips = [clip({ id: "c1", assetId: "used" })];
		expect(collectUsedAssetDims(doc([used, unused], clips), {})).toEqual([
			{ width: 1920, height: 1080 },
		]);
	});
});
