import { describe, expect, it } from "vitest";
import {
	annotationRegionSchema,
	assetSchema,
	axcutSchemaVersion,
	clipSchema,
	createEmptyDocument,
	documentSchema,
	ensureDocument,
	legacyEditorSchema,
	rangeSchema,
	skipRangeSchema,
	timelineSchema,
	zoomRegionSchema,
} from "./index";

describe("axcut-schema v4", () => {
	it("uses schema version 4", () => {
		expect(axcutSchemaVersion).toBe(4);
	});

	it("rejects unknown schema versions", () => {
		expect(() =>
			documentSchema.parse({
				...createEmptyDocument({ projectId: "p", title: "t" }),
				schemaVersion: 2,
			}),
		).toThrow();
	});

	it("createEmptyDocument returns a valid v4 doc with empty collections", () => {
		const doc = createEmptyDocument({ projectId: "proj_1", title: "Demo" });
		expect(doc.schemaVersion).toBe(4);
		expect(doc.assets).toEqual([]);
		expect(doc.timeline.clips).toEqual([]);
		expect(doc.timeline.skipRanges).toEqual([]);
		expect(doc.timeline.speedRanges).toEqual([]);
		expect(doc.timeline.muteRanges).toEqual([]);
		expect(doc.timeline.captionRanges).toEqual([]);
		expect(doc.annotations).toEqual([]);
		expect(doc.zoomRanges).toEqual([]);
		expect(doc.transcripts).toEqual([]);
		expect(doc.legacyEditor).toBeNull();
		expect(doc.history.revisions).toEqual([]);
	});

	it("ensureDocument rejects garbage", () => {
		expect(() => ensureDocument({ schemaVersion: 3, project: "not-an-object" })).toThrow();
	});

	it("accepts a clip with sourceEndSec undefined (asset duration unknown at migration time)", () => {
		const clip = clipSchema.parse({
			id: "clip_1",
			assetId: "asset_1",
			sourceStartSec: 0,
			timelineStartSec: 0,
			timelineEndSec: 0,
			origin: "system",
		});
		expect(clip.sourceEndSec).toBeUndefined();
	});

	it("rejects negative clip times", () => {
		expect(() =>
			clipSchema.parse({
				id: "clip_1",
				assetId: "asset_1",
				sourceStartSec: -1,
				timelineStartSec: 0,
				timelineEndSec: 0,
				origin: "system",
			}),
		).toThrow();
	});

	it("assetSchema requires kind = 'video'", () => {
		expect(() =>
			assetSchema.parse({
				id: "asset_1",
				kind: "audio",
				label: "x",
				originalPath: "/x.mp4",
			}),
		).toThrow();
	});

	it("skipRangeSchema carries assetId and origin", () => {
		const skip = skipRangeSchema.parse({
			id: "skip_1",
			assetId: "asset_1",
			startSec: 1.5,
			endSec: 3.0,
			origin: "user",
		});
		expect(skip.assetId).toBe("asset_1");
		expect(skip.origin).toBe("user");
	});

	it("rangeSchema has no required fields beyond startSec/endSec", () => {
		const r = rangeSchema.parse({ startSec: 0, endSec: 1 });
		expect(r.reason).toBe("");
	});

	it("timelineSchema defaults skipRanges to []", () => {
		const t = timelineSchema.parse({});
		expect(t.skipRanges).toEqual([]);
		expect(t.muteRanges).toEqual([]);
		expect(t.captionRanges).toEqual([]);
	});

	it("annotationRegionSchema accepts OpenScreen-shape regions", () => {
		const region = annotationRegionSchema.parse({
			id: "ann_1",
			startMs: 0,
			endMs: 1500,
			type: "text",
			content: "hello",
			position: { x: 4, y: 86 },
			size: { width: 92, height: 12 },
			style: {
				color: "#ffffff",
				backgroundColor: "transparent",
				fontSize: 24,
				fontFamily: "Inter",
				fontWeight: "bold",
				fontStyle: "normal",
				textDecoration: "none",
				textAlign: "center",
			},
			zIndex: 1,
		});
		expect(region.type).toBe("text");
		expect(region.annotationSource).toBeUndefined();
	});

	it("zoomRegionSchema rejects unknown depths", () => {
		expect(() =>
			zoomRegionSchema.parse({
				id: "z_1",
				startMs: 0,
				endMs: 1000,
				depth: 7,
				focus: { cx: 0.5, cy: 0.5 },
			}),
		).toThrow();
	});

	it("zoomRegionSchema accepts depth 1..6", () => {
		for (const d of [1, 2, 3, 4, 5, 6] as const) {
			const z = zoomRegionSchema.parse({
				id: `z_${d}`,
				startMs: 0,
				endMs: 1000,
				depth: d,
				focus: { cx: 0.5, cy: 0.5 },
			});
			expect(z.depth).toBe(d);
		}
	});

	it("legacyEditorSchema accepts arbitrary passthrough keys", () => {
		const legacy = legacyEditorSchema.parse({
			wallpaper: "/wallpapers/wallpaper1.jpg",
			autoZoomEnabled: true,
			someFutureField: "preserved",
		});
		expect(legacy?.someFutureField).toBe("preserved");
	});

	it("documentSchema defaults missing v3 envelopes on a v3 document", () => {
		expect(() =>
			documentSchema.parse({
				schemaVersion: 3,
				project: {
					id: "p",
					title: "t",
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				},
				assets: [],
				transcript: null,
				timeline: {},
				agent: {},
				preview: {},
				export: {},
				history: {},
			}),
		).not.toThrow();
	});

	it("assetSchema defaults cameraTrack to null", () => {
		const asset = assetSchema.parse({
			id: "asset_1",
			kind: "video",
			label: "x",
			originalPath: "/x.mp4",
		});
		expect(asset.cameraTrack).toBeNull();
	});

	describe("v3 -> v4 cameraTrack migration", () => {
		function v3Doc(overrides: Record<string, unknown> = {}) {
			return {
				schemaVersion: 3,
				project: {
					id: "p",
					title: "t",
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				},
				assets: [
					{ id: "asset_1", kind: "video", label: "a1", originalPath: "/a1.mp4" },
					{ id: "asset_2", kind: "video", label: "a2", originalPath: "/a2.mp4" },
				],
				cameraTrack: { sourcePath: "/cam.mp4", startMs: 0, offsetMs: 0, visible: true },
				...overrides,
			};
		}

		it("relocates a legacy top-level cameraTrack onto the primaryAssetId asset", () => {
			const doc = documentSchema.parse(
				v3Doc({ project: { ...v3Doc().project, primaryAssetId: "asset_2" } }),
			);
			expect(doc.schemaVersion).toBe(4);
			expect((doc as Record<string, unknown>).cameraTrack).toBeUndefined();
			expect(doc.assets.find((a) => a.id === "asset_1")?.cameraTrack).toBeNull();
			expect(doc.assets.find((a) => a.id === "asset_2")?.cameraTrack?.sourcePath).toBe("/cam.mp4");
		});

		it("falls back to the first asset when there is no primaryAssetId", () => {
			const doc = documentSchema.parse(v3Doc());
			expect(doc.assets[0].cameraTrack?.sourcePath).toBe("/cam.mp4");
			expect(doc.assets[1].cameraTrack).toBeNull();
		});

		it("is a no-op when the v3 document has no legacy cameraTrack", () => {
			const doc = documentSchema.parse(v3Doc({ cameraTrack: null }));
			expect(doc.schemaVersion).toBe(4);
			for (const asset of doc.assets) {
				expect(asset.cameraTrack).toBeNull();
			}
		});

		it("still rejects schemaVersion 2 (only v3 is auto-upgraded)", () => {
			expect(() => documentSchema.parse(v3Doc({ schemaVersion: 2 }))).toThrow();
		});
	});

	describe("range ordering validation", () => {
		it("rangeSchema rejects endSec < startSec", () => {
			expect(() => rangeSchema.parse({ startSec: 10, endSec: 5 })).toThrow();
			expect(rangeSchema.parse({ startSec: 5, endSec: 10 })).toBeTruthy();
			expect(rangeSchema.parse({ startSec: 5, endSec: 5 })).toBeTruthy();
		});

		it("skipRangeSchema rejects endSec < startSec", () => {
			expect(() =>
				skipRangeSchema.parse({
					id: "s1",
					assetId: "a1",
					startSec: 10,
					endSec: 5,
					origin: "user",
				}),
			).toThrow();
		});

		it("clipSchema rejects timelineEndSec < timelineStartSec or sourceEndSec < sourceStartSec", () => {
			const validBase = {
				id: "c1",
				assetId: "a1",
				sourceStartSec: 0,
				sourceEndSec: 10,
				timelineStartSec: 0,
				timelineEndSec: 10,
				origin: "user" as const,
			};
			expect(() => clipSchema.parse({ ...validBase, timelineEndSec: -1 })).toThrow();
			expect(() => clipSchema.parse({ ...validBase, sourceEndSec: -1 })).toThrow();
			expect(() =>
				clipSchema.parse({ ...validBase, sourceStartSec: 10, sourceEndSec: 5 }),
			).toThrow();
			expect(() =>
				clipSchema.parse({ ...validBase, timelineStartSec: 10, timelineEndSec: 5 }),
			).toThrow();
		});

		it("zoomRegionSchema rejects endMs < startMs", () => {
			expect(() =>
				zoomRegionSchema.parse({
					id: "z1",
					startMs: 100,
					endMs: 50,
					depth: 1,
					focus: { cx: 0.5, cy: 0.5 },
				}),
			).toThrow();
		});

		it("annotationRegionSchema rejects endMs < startMs", () => {
			expect(() =>
				annotationRegionSchema.parse({
					id: "a1",
					startMs: 100,
					endMs: 50,
					type: "text",
					position: { x: 10, y: 10 },
					size: { width: 100, height: 100 },
					style: {
						fontFamily: "Inter",
						fontSize: 14,
						color: "#ffffff",
						backgroundColor: "#000000",
					},
					zIndex: 1,
					figureData: {},
					blurData: {},
				}),
			).toThrow();
		});
	});
});
