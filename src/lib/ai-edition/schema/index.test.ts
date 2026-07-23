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
	timelineSchema,
	trimRangeSchema,
	zoomRegionSchema,
} from "./index";

describe("axcut-schema v5", () => {
	it("uses schema version 4", () => {
		expect(axcutSchemaVersion).toBe(5);
	});

	it("rejects unknown schema versions", () => {
		expect(() =>
			documentSchema.parse({
				...createEmptyDocument({ projectId: "p", title: "t" }),
				schemaVersion: 2,
			}),
		).toThrow();
	});

	it("createEmptyDocument returns a valid v5 doc with empty collections", () => {
		const doc = createEmptyDocument({ projectId: "proj_1", title: "Demo" });
		expect(doc.schemaVersion).toBe(5);
		expect(doc.assets).toEqual([]);
		expect(doc.timeline.clips).toEqual([]);
		expect(doc.timeline.trimRanges).toEqual([]);
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

	it("trimRangeSchema carries assetId and origin", () => {
		const skip = trimRangeSchema.parse({
			id: "trim_1",
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

	it("timelineSchema defaults trimRanges to []", () => {
		const t = timelineSchema.parse({});
		expect(t.trimRanges).toEqual([]);
		expect(t.muteRanges).toEqual([]);
		expect(t.captionRanges).toEqual([]);
	});

	it("timelineSchema migrates legacy skipRanges → trimRanges", () => {
		// Documents persisted before the skip→trim rename carry `skipRanges`.
		const t = timelineSchema.parse({
			skipRanges: [
				{ id: "skip_1", assetId: "a", startSec: 3, endSec: 5, reason: "", origin: "user" },
			],
		});
		expect(t.trimRanges).toEqual([
			{ id: "skip_1", assetId: "a", startSec: 3, endSec: 5, reason: "", origin: "user" },
		]);
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
			expect(doc.schemaVersion).toBe(5);
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
			expect(doc.schemaVersion).toBe(5);
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

		it("trimRangeSchema rejects endSec < startSec", () => {
			expect(() =>
				trimRangeSchema.parse({
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

// --- v4 -> v5 clip-anchoring migration (round-trip) --------------------------
// Uses goodtest's real layout: clip A [asset_f] src[0,25.557313] raw[0,25.557313],
// clip B [asset_e] src[0,8.149313] raw[25.557313,33.706626], and its straddling
// speed region [8149,28575]ms. See docs/architecture/timeline-coordinate-refactor.md §6.

describe("v4 -> v5 clip-anchored modifier migration", () => {
	const CLIP_A_END = 25.557313;
	const CLIP_B_END = 33.706626;

	function makeV4Doc(overrides: Record<string, unknown> = {}) {
		const createdAt = "2024-01-01T00:00:00.000Z";
		return {
			schemaVersion: 4,
			project: { id: "p1", title: "goodtest-like", createdAt, updatedAt: createdAt },
			assets: [
				{ id: "asset_f", kind: "video", label: "A", originalPath: "/a.mp4", cameraTrack: null },
				{ id: "asset_e", kind: "video", label: "B", originalPath: "/b.mp4", cameraTrack: null },
			],
			timeline: {
				clips: [
					{
						id: "clip_a",
						assetId: "asset_f",
						sourceStartSec: 0,
						sourceEndSec: CLIP_A_END,
						timelineStartSec: 0,
						timelineEndSec: CLIP_A_END,
						origin: "user",
					},
					{
						id: "clip_b",
						assetId: "asset_e",
						sourceStartSec: 0,
						sourceEndSec: 8.149313,
						timelineStartSec: CLIP_A_END,
						timelineEndSec: CLIP_B_END,
						origin: "user",
					},
				],
			},
			...overrides,
		};
	}

	it("bumps the version and anchors a zoom wholly inside one clip", () => {
		const doc = documentSchema.parse(
			makeV4Doc({
				zoomRanges: [
					{ id: "z1", startMs: 2000, endMs: 5000, depth: 3, focus: { cx: 0.5, cy: 0.5 } },
				],
			}),
		);
		expect(doc.schemaVersion).toBe(5);
		expect(doc.zoomRanges).toHaveLength(1);
		const z = doc.zoomRanges[0];
		expect(z).toMatchObject({ id: "z1", clipId: "clip_a", depth: 3 });
		expect(z.sourceStartSec).toBeCloseTo(2, 5);
		expect(z.sourceEndSec).toBeCloseTo(5, 5);
		// derived ms cache stays consistent with the anchor
		expect(z.startMs).toBe(2000);
		expect(z.endMs).toBe(5000);
	});

	it("splits a straddling speed region into two fragments that still read as one pill", () => {
		const doc = documentSchema.parse(
			makeV4Doc({
				legacyEditor: { speedRegions: [{ id: "s1", startMs: 8149, endMs: 28575, speed: 3 }] },
			}),
		);
		const speeds = (doc.legacyEditor as Record<string, unknown>).speedRegions as Array<
			Record<string, unknown>
		>;
		expect(speeds).toHaveLength(2);
		// No shared marker is stored: equal properties + adjacency is what re-merges them.
		expect(speeds.every((s) => s.speed === 3)).toBe(true);
		expect(speeds.map((s) => s.clipId)).toEqual(["clip_a", "clip_b"]);
		expect(speeds[0].sourceStartSec).toBeCloseTo(8.149, 5);
		expect(speeds[1].sourceStartSec).toBeCloseTo(0, 5);
		// The two derived ms spans are contiguous and together cover the original.
		expect(speeds[0].startMs).toBe(8149);
		expect(speeds[1].endMs).toBe(28575);
		expect(speeds[0].endMs).toBe(speeds[1].startMs);
	});

	it("never drops a region it cannot anchor (unknown clip duration → passes through)", () => {
		// A v2-imported project before its duration is probed: zero-extent clip.
		const doc = documentSchema.parse({
			schemaVersion: 4,
			project: {
				id: "p2",
				title: "unprobed",
				createdAt: "2024-01-01T00:00:00.000Z",
				updatedAt: "2024-01-01T00:00:00.000Z",
			},
			assets: [{ id: "a", kind: "video", label: "A", originalPath: "/a.mp4", cameraTrack: null }],
			timeline: {
				clips: [
					{
						id: "c1",
						assetId: "a",
						sourceStartSec: 0,
						timelineStartSec: 0,
						timelineEndSec: 0,
						origin: "user",
					},
				],
			},
			zoomRanges: [{ id: "z1", startMs: 1000, endMs: 2000, depth: 3, focus: { cx: 0.5, cy: 0.5 } }],
		});
		expect(doc.zoomRanges).toHaveLength(1);
		expect(doc.zoomRanges[0]).toMatchObject({ id: "z1", startMs: 1000, endMs: 2000 });
		expect(doc.zoomRanges[0].clipId).toBeUndefined();
	});

	it("is idempotent — re-parsing an already-v5 document changes nothing", () => {
		const once = documentSchema.parse(
			makeV4Doc({
				zoomRanges: [
					{ id: "z1", startMs: 2000, endMs: 5000, depth: 3, focus: { cx: 0.5, cy: 0.5 } },
				],
			}),
		);
		const twice = documentSchema.parse(once);
		expect(twice).toEqual(once);
	});
});
