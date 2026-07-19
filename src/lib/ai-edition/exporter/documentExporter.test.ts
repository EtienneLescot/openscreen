import { describe, expect, it } from "vitest";
import type { CursorRecordingData } from "@/native/contracts";
import type { AxcutAsset, AxcutClip, AxcutDocument, AxcutTrimRange } from "../schema";
import type { DocumentExportOptions } from "./documentExporter";
import {
	buildDocumentRenderPlan,
	computeCropSchedule,
	computeExportTrimRegions,
} from "./documentExporter";

function clip(p: Partial<AxcutClip> & Pick<AxcutClip, "id">): AxcutClip {
	return {
		assetId: "a",
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
function trim(p: Partial<AxcutTrimRange> & Pick<AxcutTrimRange, "id">): AxcutTrimRange {
	return { assetId: "a", startSec: 0, endSec: 1, origin: "user", reason: "", ...p };
}

describe("computeExportTrimRegions", () => {
	it("cuts everything outside the kept clip ranges (clip in/out)", () => {
		// One clip keeps source 2..8 of a 10s asset → cut 0..2 and 8..10.
		const clips = [clip({ id: "c1", sourceStartSec: 2, sourceEndSec: 8 })];
		expect(computeExportTrimRegions(10, clips, [], "a")).toEqual([
			{ id: "trim_1", startMs: 0, endMs: 2000 },
			{ id: "trim_2", startMs: 8000, endMs: 10000 },
		]);
	});

	it("also cuts a mid-clip trim (previously dropped from export)", () => {
		// Full clip 0..10, plus a trim removing source 4..6 → export must cut it.
		const clips = [clip({ id: "c1", sourceStartSec: 0, sourceEndSec: 10 })];
		const trims = [trim({ id: "t1", startSec: 4, endSec: 6 })];
		expect(computeExportTrimRegions(10, clips, trims, "a")).toEqual([
			{ id: "trim_1", startMs: 4000, endMs: 6000 },
		]);
	});

	it("merges overlapping clip-gap and trim cuts", () => {
		// Clip keeps 0..8 (cut 8..10); a trim 7..9 overlaps the tail cut → merge to 7..10.
		const clips = [clip({ id: "c1", sourceStartSec: 0, sourceEndSec: 8 })];
		const trims = [trim({ id: "t1", startSec: 7, endSec: 9 })];
		expect(computeExportTrimRegions(10, clips, trims, "a")).toEqual([
			{ id: "trim_1", startMs: 7000, endMs: 10000 },
		]);
	});

	it("ignores trims that belong to a different asset", () => {
		const clips = [clip({ id: "c1", sourceStartSec: 0, sourceEndSec: 10 })];
		const trims = [trim({ id: "t1", assetId: "other", startSec: 3, endSec: 5 })];
		expect(computeExportTrimRegions(10, clips, trims, "a")).toEqual([]);
	});
});

describe("computeCropSchedule", () => {
	function assetA(durationSec?: number): AxcutAsset {
		return {
			kind: "video",
			id: "a",
			label: "Asset A",
			originalPath: "/a.mp4",
			cameraTrack: null,
			...(durationSec !== undefined ? { durationSec } : {}),
		};
	}

	it("builds one schedule entry per clip, defaulting to the identity crop", () => {
		const clips = [
			clip({ id: "c1", sourceStartSec: 0, sourceEndSec: 3 }),
			clip({
				id: "c2",
				sourceStartSec: 3,
				sourceEndSec: 6,
				cropRegion: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
			}),
		];
		expect(computeCropSchedule(clips, assetA(6))).toEqual([
			{ startSec: 0, endSec: 3, cropRegion: { x: 0, y: 0, width: 1, height: 1 } },
			{
				startSec: 3,
				endSec: 6,
				cropRegion: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
			},
		]);
	});

	it("falls back to asset.durationSec when a clip's sourceEndSec is unset", () => {
		const clips = [clip({ id: "c1", sourceStartSec: 0, sourceEndSec: undefined })];
		expect(computeCropSchedule(clips, assetA(12))).toEqual([
			{ startSec: 0, endSec: 12, cropRegion: { x: 0, y: 0, width: 1, height: 1 } },
		]);
	});

	it("excludes clips that belong to a different asset", () => {
		const clips = [
			clip({ id: "c1", assetId: "a" }),
			clip({ id: "c2", assetId: "other", cropRegion: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } }),
		];
		expect(computeCropSchedule(clips, assetA(10))).toEqual([
			{ startSec: 0, endSec: 10, cropRegion: { x: 0, y: 0, width: 1, height: 1 } },
		]);
	});
});

describe("buildDocumentRenderPlan", () => {
	function assetOf(p: Partial<AxcutAsset> & Pick<AxcutAsset, "id">): AxcutAsset {
		return {
			kind: "video",
			label: "Asset",
			originalPath: `/tmp/${p.id}.mp4`,
			cameraTrack: null,
			...p,
		};
	}

	// Minimal document — buildDocumentRenderPlan/buildRenderPlan only read project,
	// assets, timeline.{clips,trimRanges}, zoomRanges, annotations, legacyEditor.
	function docOf(p: {
		assets: AxcutAsset[];
		clips: AxcutClip[];
		primaryAssetId?: string;
		legacyEditor?: Record<string, unknown> | null;
	}): AxcutDocument {
		return {
			project: { primaryAssetId: p.primaryAssetId },
			assets: p.assets,
			timeline: { clips: p.clips, trimRanges: [] },
			zoomRanges: [],
			annotations: [],
			legacyEditor: p.legacyEditor ?? null,
		} as unknown as AxcutDocument;
	}

	const baseOptions: DocumentExportOptions = { quality: "source", format: "mp4" };

	it("maps codec + frameRate and sizes output from the largest asset", () => {
		const doc = docOf({
			assets: [
				assetOf({
					id: "a",
					durationSec: 30,
					video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
				}),
			],
			clips: [clip({ id: "c1", assetId: "a", sourceStartSec: 0, sourceEndSec: 10 })],
		});
		const plan = buildDocumentRenderPlan(doc, { ...baseOptions, codec: "h265", frameRate: 30 });
		expect(plan.output.codec).toBe("hvc1.1.6.L120.90");
		expect(plan.output.frameRate).toBe(30);
		expect(plan.output.width).toBe(1920);
		expect(plan.output.height).toBe(1080);
		expect(plan.segments).toHaveLength(1);
	});

	it("uses options.sourceWidth/Height as fallback dims when the asset has no video block", () => {
		const doc = docOf({
			assets: [assetOf({ id: "a", durationSec: 30 })], // no `video`
			clips: [clip({ id: "c1", assetId: "a", sourceStartSec: 0, sourceEndSec: 10 })],
		});
		const plan = buildDocumentRenderPlan(doc, {
			...baseOptions,
			sourceWidth: 1280,
			sourceHeight: 720,
		});
		expect(plan.segments[0].sourceWidth).toBe(1280);
		expect(plan.segments[0].sourceHeight).toBe(720);
	});

	it("threads cursor recording + scale + theme into plan.cursor and partitions samples per segment", () => {
		const recordingData: CursorRecordingData = {
			version: 1,
			provider: "native",
			assets: [],
			samples: [
				{ timeMs: 100, cx: 0.5, cy: 0.5, assetId: "a" },
				{ timeMs: 200, cx: 0.4, cy: 0.4, assetId: "b" },
			],
		};
		const doc = docOf({
			assets: [
				assetOf({
					id: "a",
					durationSec: 30,
					video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
				}),
				assetOf({
					id: "b",
					durationSec: 30,
					video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
				}),
			],
			clips: [
				clip({
					id: "c1",
					assetId: "a",
					sourceStartSec: 0,
					sourceEndSec: 5,
					timelineStartSec: 0,
					timelineEndSec: 5,
				}),
				clip({
					id: "c2",
					assetId: "b",
					sourceStartSec: 0,
					sourceEndSec: 5,
					timelineStartSec: 5,
					timelineEndSec: 10,
				}),
			],
			legacyEditor: { cursorTheme: "dark" },
		});
		const plan = buildDocumentRenderPlan(doc, {
			...baseOptions,
			cursorRecordingData: recordingData,
			cursorScale: 1.2,
			cursorSmoothing: 0.4,
		});
		expect(plan.cursor).toMatchObject({ scale: 1.2, smoothing: 0.4, theme: "dark" });
		expect(plan.segments[0].cursorSamples.map((s) => s.timeMs)).toEqual([100]);
		expect(plan.segments[1].cursorSamples.map((s) => s.timeMs)).toEqual([200]);
	});

	it("leaves plan.cursor null when cursor scale is unset (0)", () => {
		const recordingData: CursorRecordingData = {
			version: 1,
			provider: "native",
			assets: [],
			samples: [{ timeMs: 0, cx: 0.5, cy: 0.5, assetId: "a" }],
		};
		const doc = docOf({
			assets: [
				assetOf({
					id: "a",
					durationSec: 30,
					video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
				}),
			],
			clips: [clip({ id: "c1", assetId: "a", sourceStartSec: 0, sourceEndSec: 10 })],
		});
		const plan = buildDocumentRenderPlan(doc, {
			...baseOptions,
			cursorRecordingData: recordingData,
		});
		expect(plan.cursor).toBeNull();
	});
});
