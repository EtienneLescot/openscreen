import { describe, expect, it } from "vitest";
import { migrateRawDocumentToCurrent } from "../document/migrate";
import {
	annotationRegionSchema,
	assetSchema,
	audioTrackSchema,
	axcutSchemaVersion,
	clipSchema,
	createAudioTrack,
	createEmptyDocument,
	documentSchema,
	ensureDocument,
	legacyEditorSchema,
	rangeSchema,
	timelineSchema,
	trimRangeSchema,
	zoomRegionSchema,
} from "./index";

describe("axcut-schema v7", () => {
	it("uses schema version 7", () => {
		expect(axcutSchemaVersion).toBe(7);
	});

	it("rejects unknown schema versions", () => {
		expect(() =>
			documentSchema.parse({
				...createEmptyDocument({ projectId: "p", title: "t" }),
				schemaVersion: 2,
			}),
		).toThrow();
	});

	it("createEmptyDocument returns a valid v7 doc with empty collections", () => {
		const doc = createEmptyDocument({ projectId: "proj_1", title: "Demo" });
		expect(doc.schemaVersion).toBe(7);
		expect(doc.assets).toEqual([]);
		expect(doc.timeline.clips).toEqual([]);
		expect(doc.timeline.trimRanges).toEqual([]);
		expect(doc.timeline.speedRanges).toEqual([]);
		expect(doc.timeline.muteRanges).toEqual([]);
		expect(doc.timeline.captionRanges).toEqual([]);
		expect(doc.annotations).toEqual([]);
		expect(doc.zoomRanges).toEqual([]);
		expect(doc.audioTracks).toEqual([]);
		expect(doc.transcripts).toEqual([]);
		expect(doc.legacyEditor).toBeNull();
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

	it("assetSchema accepts kind 'video' and 'audio', defaulting to 'video'", () => {
		// Widened from a literal when external-audio import landed (issue #350).
		const video = assetSchema.parse({ id: "a1", label: "x", originalPath: "/x.mp4" });
		expect(video.kind).toBe("video");
		const audio = assetSchema.parse({
			id: "a2",
			kind: "audio",
			label: "bgm",
			originalPath: "/bgm.mp3",
		});
		expect(audio.kind).toBe("audio");
	});

	it("assetSchema rejects an unknown kind", () => {
		expect(() =>
			assetSchema.parse({ id: "a1", kind: "image", label: "x", originalPath: "/x.png" }),
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

	it("keeps the remembered background colour through a save-path parse", () => {
		// Le chemin d'enregistrement valide le document dans le processus principal, et zod jette
		// tout champ non déclaré : une mémoire que l'interface écrit mais que le schéma ignore
		// disparaît au premier enregistrement — silencieusement, ce qui est le pire cas.
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
				lastBackgroundColor: "#3b82f6",
				fontSize: 24,
			},
			zIndex: 1,
		});
		expect(region.style.lastBackgroundColor).toBe("#3b82f6");
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
		// After the migration hoist, a v3 doc must run through
		// `migrateRawDocumentToCurrent` first; this models the new load-time
		// contract: the schema parse is a pure v7 validation step.
		expect(() =>
			documentSchema.parse(
				migrateRawDocumentToCurrent({
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
			),
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
			// After the migration hoist, v3 input runs through the load-time
			// upgrader before the pure v7 schema parse.
			const doc = documentSchema.parse(
				migrateRawDocumentToCurrent(
					v3Doc({ project: { ...v3Doc().project, primaryAssetId: "asset_2" } }),
				),
			);
			expect(doc.schemaVersion).toBe(7);
			expect((doc as Record<string, unknown>).cameraTrack).toBeUndefined();
			expect(doc.assets.find((a) => a.id === "asset_1")?.cameraTrack).toBeNull();
			expect(doc.assets.find((a) => a.id === "asset_2")?.cameraTrack?.sourcePath).toBe("/cam.mp4");
		});

		it("falls back to the first asset when there is no primaryAssetId", () => {
			const doc = documentSchema.parse(migrateRawDocumentToCurrent(v3Doc()));
			expect(doc.assets[0].cameraTrack?.sourcePath).toBe("/cam.mp4");
			expect(doc.assets[1].cameraTrack).toBeNull();
		});

		it("is a no-op when the v3 document has no legacy cameraTrack", () => {
			const doc = documentSchema.parse(migrateRawDocumentToCurrent(v3Doc({ cameraTrack: null })));
			expect(doc.schemaVersion).toBe(7);
			for (const asset of doc.assets) {
				expect(asset.cameraTrack).toBeNull();
			}
		});

		it("rejects schemaVersion 2 (the load-time helper only upgrades v3/v4)", () => {
			// The pre-hoist schema auto-upgraded v3 inside its `z.preprocess`;
			// the post-hoist schema is a pure v7 validator, and the helper
			// only handles v3/v4. v2 still requires the separate
			// `migrateProjectDataToAxcutDocument` pure function.
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
// speed region [8149,28575]ms. See technical-documentation/architecture/timeline-model.md

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
		// After the migration hoist, v4 input runs through the load-time
		// upgrader before the pure v7 schema parse.
		const doc = documentSchema.parse(
			migrateRawDocumentToCurrent(
				makeV4Doc({
					zoomRanges: [
						{ id: "z1", startMs: 2000, endMs: 5000, depth: 3, focus: { cx: 0.5, cy: 0.5 } },
					],
				}),
			),
		);
		expect(doc.schemaVersion).toBe(7);
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
			migrateRawDocumentToCurrent(
				makeV4Doc({
					legacyEditor: { speedRegions: [{ id: "s1", startMs: 8149, endMs: 28575, speed: 3 }] },
				}),
			),
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
		const doc = documentSchema.parse(
			migrateRawDocumentToCurrent({
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
				zoomRanges: [
					{ id: "z1", startMs: 1000, endMs: 2000, depth: 3, focus: { cx: 0.5, cy: 0.5 } },
				],
			}),
		);
		expect(doc.zoomRanges).toHaveLength(1);
		expect(doc.zoomRanges[0]).toMatchObject({ id: "z1", startMs: 1000, endMs: 2000 });
		expect(doc.zoomRanges[0].clipId).toBeUndefined();
	});

	it("is idempotent — re-parsing an already-v7 document changes nothing", () => {
		// First call: v4 input → load-time upgrade → v7.
		const once = documentSchema.parse(
			migrateRawDocumentToCurrent(
				makeV4Doc({
					zoomRanges: [
						{ id: "z1", startMs: 2000, endMs: 5000, depth: 3, focus: { cx: 0.5, cy: 0.5 } },
					],
				}),
			),
		);
		// Second call: already-current input, no upgrade needed; the parse is now a
		// pure v7 validation step.
		const twice = documentSchema.parse(once);
		expect(twice).toEqual(once);
	});
});

// --- v5 -> v6 native AspectRatio migration -----------------------------------
// `"native"` used to be a runtime-only sentinel that resolved to the timeline's largest
// clip. v6 makes that resolution permanent by baking the concrete `"W:H"` token into the
// document. After this upgrader runs, no document ever contains `"native"` again — the
// union arm in `AspectRatio` is dropped, and the runtime bridge in
// `lib/ai-edition/document/outputFormat` is no longer needed.

describe("v5 -> v6 native AspectRatio migration", () => {
	function makeV5Doc(overrides: Record<string, unknown> = {}) {
		const createdAt = "2024-01-01T00:00:00.000Z";
		return {
			schemaVersion: 5,
			project: { id: "p1", title: "v5-aspect", createdAt, updatedAt: createdAt },
			assets: [
				{ id: "asset_f", kind: "video", label: "A", originalPath: "/a.mp4", cameraTrack: null },
			],
			timeline: {
				clips: [
					{
						id: "clip_a",
						assetId: "asset_f",
						sourceStartSec: 0,
						sourceEndSec: 30,
						timelineStartSec: 0,
						timelineEndSec: 30,
						origin: "user",
					},
				],
			},
			...overrides,
		};
	}

	it("rewrites legacy aspectRatio === 'native' to the largest clip's concrete token", () => {
		const doc = documentSchema.parse(
			migrateRawDocumentToCurrent(
				makeV5Doc({
					legacyEditor: { aspectRatio: "native" },
					assets: [
						{
							id: "asset_f",
							kind: "video",
							label: "A",
							originalPath: "/a.mp4",
							cameraTrack: null,
							video: { width: 1920, height: 1080 },
						},
					],
				}),
			),
		);
		expect(doc.schemaVersion).toBe(7);
		expect((doc.legacyEditor as Record<string, unknown>).aspectRatio).toBe("16:9");
	});

	it("picks the largest clip when the timeline is mixed-shape", () => {
		const doc = documentSchema.parse(
			migrateRawDocumentToCurrent({
				schemaVersion: 5,
				project: {
					id: "p1",
					title: "mixed",
					createdAt: "2024-01-01T00:00:00.000Z",
					updatedAt: "2024-01-01T00:00:00.000Z",
				},
				assets: [
					{
						id: "asset_f",
						kind: "video",
						label: "A",
						originalPath: "/a.mp4",
						cameraTrack: null,
						video: { width: 1920, height: 1080 },
					},
					{
						id: "asset_g",
						kind: "video",
						label: "B",
						originalPath: "/b.mp4",
						cameraTrack: null,
						video: { width: 2160, height: 3840 },
					},
				],
				timeline: {
					clips: [
						{
							id: "clip_a",
							assetId: "asset_f",
							sourceStartSec: 0,
							sourceEndSec: 10,
							timelineStartSec: 0,
							timelineEndSec: 10,
							origin: "user",
						},
						{
							id: "clip_b",
							assetId: "asset_g",
							sourceStartSec: 0,
							sourceEndSec: 10,
							timelineStartSec: 10,
							timelineEndSec: 20,
							origin: "user",
						},
					],
				},
				legacyEditor: { aspectRatio: "native" },
			}),
		);
		expect(doc.schemaVersion).toBe(7);
		expect((doc.legacyEditor as Record<string, unknown>).aspectRatio).toBe("9:16");
	});

	it("leaves 'native' alone when the timeline has no clips with known dimensions", () => {
		// Deliberately NOT a 16:9 fallback: an empty/unprobed timeline gives no basis
		// for a concrete token, and guessing one persists a wrong frame. See the v1.7
		// import case below.
		const doc = documentSchema.parse(
			migrateRawDocumentToCurrent(makeV5Doc({ legacyEditor: { aspectRatio: "native" } })),
		);
		expect(doc.schemaVersion).toBe(7);
		expect((doc.legacyEditor as Record<string, unknown>).aspectRatio).toBe("native");
	});

	it("passes through a concrete aspectRatio unchanged", () => {
		const doc = documentSchema.parse(
			migrateRawDocumentToCurrent(makeV5Doc({ legacyEditor: { aspectRatio: "4:5" } })),
		);
		expect(doc.schemaVersion).toBe(7);
		expect((doc.legacyEditor as Record<string, unknown>).aspectRatio).toBe("4:5");
	});

	it("passes through a legacyEditor without aspectRatio unchanged", () => {
		const doc = documentSchema.parse(
			migrateRawDocumentToCurrent(makeV5Doc({ legacyEditor: { someOtherField: "preserved" } })),
		);
		expect(doc.schemaVersion).toBe(7);
		const legacy = doc.legacyEditor as Record<string, unknown>;
		expect(legacy.someOtherField).toBe("preserved");
		expect(legacy.aspectRatio).toBeUndefined();
	});

	it("passes through a v5 doc with no legacyEditor at all (only the version bumps)", () => {
		const v5 = makeV5Doc();
		const doc = documentSchema.parse(migrateRawDocumentToCurrent(v5));
		expect(doc.schemaVersion).toBe(7);
		expect(doc.legacyEditor).toBeNull();
	});

	it("is idempotent — re-parsing an already-v7 document changes nothing", () => {
		const once = documentSchema.parse(
			migrateRawDocumentToCurrent(makeV5Doc({ legacyEditor: { aspectRatio: "16:9" } })),
		);
		const twice = documentSchema.parse(once);
		expect(twice).toEqual(once);
	});

	it("keeps 'native' when the source dimensions are not known yet (v1.7 import)", () => {
		// The v1.7 -> v1.8 path: `{version:2, media, editor}` carries only file paths,
		// so `migrateProjectDataToAxcutDocument` produces assets with no `video` block.
		// Baking here would stamp a hardcoded 16:9 and persist it — permanently
		// reframing every portrait v1.7 project saved with "Native". Leave the
		// sentinel; it resolves dynamically at runtime and converts on a later load,
		// once useTimeline's probe has written `asset.video` back.
		const doc = documentSchema.parse(
			migrateRawDocumentToCurrent({
				schemaVersion: 5,
				project: {
					id: "p1",
					title: "from v1.7",
					createdAt: "2024-01-01T00:00:00.000Z",
					updatedAt: "2024-01-01T00:00:00.000Z",
				},
				assets: [
					{
						id: "asset_u",
						kind: "video",
						label: "A",
						originalPath: "/a.mp4",
						cameraTrack: null,
						// no `video` — exactly what the v2 import produces
					},
				],
				timeline: {
					clips: [
						{
							id: "clip_a",
							assetId: "asset_u",
							sourceStartSec: 0,
							sourceEndSec: 10,
							timelineStartSec: 0,
							timelineEndSec: 10,
							origin: "user",
						},
					],
				},
				legacyEditor: { aspectRatio: "native" },
			}),
		);
		expect(doc.schemaVersion).toBe(7);
		expect((doc.legacyEditor as Record<string, unknown>).aspectRatio).toBe("native");
	});

	it("converts 'native' once the probe has persisted dimensions", () => {
		// Second load of the same project, after useTimeline probed a PORTRAIT source.
		// This is the case that must not become 16:9.
		const doc = documentSchema.parse(
			migrateRawDocumentToCurrent({
				schemaVersion: 5,
				project: {
					id: "p1",
					title: "from v1.7, probed",
					createdAt: "2024-01-01T00:00:00.000Z",
					updatedAt: "2024-01-01T00:00:00.000Z",
				},
				assets: [
					{
						id: "asset_u",
						kind: "video",
						label: "A",
						originalPath: "/a.mp4",
						cameraTrack: null,
						video: { width: 1080, height: 1920 },
					},
				],
				timeline: {
					clips: [
						{
							id: "clip_a",
							assetId: "asset_u",
							sourceStartSec: 0,
							sourceEndSec: 10,
							timelineStartSec: 0,
							timelineEndSec: 10,
							origin: "user",
						},
					],
				},
				legacyEditor: { aspectRatio: "native" },
			}),
		);
		expect(doc.schemaVersion).toBe(7);
		expect((doc.legacyEditor as Record<string, unknown>).aspectRatio).toBe("9:16");
	});

	it("bakes the CROPPED dimensions, not the raw ones", () => {
		// "native" resolved to the cropped clip at runtime. A 3840x2160 asset cropped
		// to its left half is effectively 1920x2160 → 8:9. Reading the raw dims would
		// wrongly yield 16:9 and silently reframe the project.
		const doc = documentSchema.parse(
			migrateRawDocumentToCurrent({
				schemaVersion: 5,
				project: {
					id: "p1",
					title: "cropped",
					createdAt: "2024-01-01T00:00:00.000Z",
					updatedAt: "2024-01-01T00:00:00.000Z",
				},
				assets: [
					{
						id: "asset_c",
						kind: "video",
						label: "A",
						originalPath: "/a.mp4",
						cameraTrack: null,
						video: { width: 3840, height: 2160 },
					},
				],
				timeline: {
					clips: [
						{
							id: "clip_a",
							assetId: "asset_c",
							sourceStartSec: 0,
							sourceEndSec: 10,
							timelineStartSec: 0,
							timelineEndSec: 10,
							origin: "user",
							cropRegion: { x: 0, y: 0, width: 0.5, height: 1 },
						},
					],
				},
				legacyEditor: { aspectRatio: "native" },
			}),
		);
		expect(doc.schemaVersion).toBe(7);
		expect((doc.legacyEditor as Record<string, unknown>).aspectRatio).toBe("8:9");
	});
});

// --- v6 -> v7 trim clip-anchor migration -------------------------------------
// A v6 trim names only an asset, so on two clips over the same media it is ambiguous:
// the transcript pane showed it twice, the ruler drew it on the first clip, and playback
// cut it from both. The upgrade ventilates each stored trim into one anchored row per
// clip it covers — a faithful restatement of what the document already rendered, but now
// separately addressable so the user can delete the copy they did not mean.
describe("v6 -> v7 trim clip-anchor migration", () => {
	const v6Doc = (
		clips: Array<Record<string, unknown>>,
		trimRanges: Array<Record<string, unknown>>,
	) => ({
		schemaVersion: 6,
		project: {
			id: "p",
			title: "t",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			primaryAssetId: "asset_1",
		},
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "rec.mp4",
				originalPath: "/rec.mp4",
				durationSec: 12,
				cameraTrack: null,
			},
		],
		timeline: { clips, trimRanges },
	});

	const twoSharedClips = [
		{
			id: "clip_1",
			assetId: "asset_1",
			sourceStartSec: 0,
			sourceEndSec: 12,
			timelineStartSec: 0,
			timelineEndSec: 12,
			origin: "user",
		},
		{
			id: "clip_2",
			assetId: "asset_1",
			sourceStartSec: 0,
			sourceEndSec: 12,
			timelineStartSec: 12,
			timelineEndSec: 24,
			origin: "user",
		},
	];

	const trimsOf = (raw: unknown) =>
		((raw as Record<string, unknown>).timeline as Record<string, unknown>).trimRanges as Array<
			Record<string, unknown>
		>;

	it("anchors a trim to the single clip that covers it", () => {
		const out = migrateRawDocumentToCurrent(
			v6Doc(
				[twoSharedClips[0]],
				[{ id: "t1", assetId: "asset_1", startSec: 3, endSec: 5, origin: "user", reason: "" }],
			),
		);
		expect((out as Record<string, unknown>).schemaVersion).toBe(7);
		expect(trimsOf(out)).toEqual([
			{
				id: "t1",
				assetId: "asset_1",
				clipId: "clip_1",
				startSec: 3,
				endSec: 5,
				origin: "user",
				reason: "",
			},
		]);
	});

	it("ventilates into one row per covering clip, preserving what the document rendered", () => {
		const out = migrateRawDocumentToCurrent(
			v6Doc(twoSharedClips, [
				{ id: "t1", assetId: "asset_1", startSec: 3, endSec: 5, origin: "user", reason: "" },
			]),
		);
		const trims = trimsOf(out);
		expect(trims).toHaveLength(2);
		// The first row keeps the original id, so anything already holding it still resolves.
		expect(trims[0]).toMatchObject({ id: "t1", clipId: "clip_1", startSec: 3, endSec: 5 });
		expect(trims[1]).toMatchObject({ clipId: "clip_2", startSec: 3, endSec: 5 });
		expect(trims[1].id).not.toBe("t1");
	});

	it("clamps each row to its own clip's source window", () => {
		const out = migrateRawDocumentToCurrent(
			v6Doc(
				[
					{ ...twoSharedClips[0], sourceStartSec: 0, sourceEndSec: 6 },
					{ ...twoSharedClips[1], sourceStartSec: 6, sourceEndSec: 12 },
				],
				[{ id: "t1", assetId: "asset_1", startSec: 4, endSec: 9, origin: "user", reason: "" }],
			),
		);
		expect(trimsOf(out).map((t) => [t.clipId, t.startSec, t.endSec])).toEqual([
			["clip_1", 4, 6],
			["clip_2", 6, 9],
		]);
	});

	it("keeps a trim that covers no clip rather than dropping user data", () => {
		// `replaceTimeline` mints exactly these: the complement of the kept intervals, which
		// lies outside every clip by construction.
		const out = migrateRawDocumentToCurrent(
			v6Doc(
				[{ ...twoSharedClips[0], sourceStartSec: 0, sourceEndSec: 3 }],
				[{ id: "t1", assetId: "asset_1", startSec: 8, endSec: 9, origin: "user", reason: "" }],
			),
		);
		expect(trimsOf(out)).toEqual([
			{ id: "t1", assetId: "asset_1", startSec: 8, endSec: 9, origin: "user", reason: "" },
		]);
	});

	it("leaves an unprobed clip's trims un-anchored (no real window to clamp against)", () => {
		const out = migrateRawDocumentToCurrent(
			v6Doc(
				[{ ...twoSharedClips[0], sourceStartSec: 0, sourceEndSec: undefined }],
				[{ id: "t1", assetId: "asset_1", startSec: 3, endSec: 5, origin: "user", reason: "" }],
			),
		);
		expect(trimsOf(out)[0].clipId).toBeUndefined();
	});

	it("is idempotent — an already-anchored trim is left alone", () => {
		const once = migrateRawDocumentToCurrent(
			v6Doc(twoSharedClips, [
				{ id: "t1", assetId: "asset_1", startSec: 3, endSec: 5, origin: "user", reason: "" },
			]),
		);
		expect(migrateRawDocumentToCurrent(once)).toEqual(once);
	});

	it("survives a malformed clip entry instead of failing the whole project load", () => {
		const out = migrateRawDocumentToCurrent(
			v6Doc(
				[null as unknown as Record<string, unknown>, twoSharedClips[1]],
				[{ id: "t1", assetId: "asset_1", startSec: 3, endSec: 5, origin: "user", reason: "" }],
			),
		);
		expect(trimsOf(out)).toEqual([
			{
				id: "t1",
				assetId: "asset_1",
				clipId: "clip_2",
				startSec: 3,
				endSec: 5,
				origin: "user",
				reason: "",
			},
		]);
	});
});

describe("audio tracks (issue #350)", () => {
	it("applies defaults for gain, trim, position, and label", () => {
		const track = audioTrackSchema.parse({
			id: "audio_1",
			assetId: "asset_1",
			durationSec: 42,
		});
		expect(track.timelineStartSec).toBe(0);
		expect(track.trimStartSec).toBe(0);
		expect(track.trimEndSec).toBeUndefined();
		expect(track.gainDb).toBe(0);
		expect(track.label).toBe("");
	});

	it("rejects a trim window whose end precedes its start", () => {
		expect(() =>
			audioTrackSchema.parse({
				id: "audio_1",
				assetId: "asset_1",
				durationSec: 10,
				trimStartSec: 5,
				trimEndSec: 2,
			}),
		).toThrow();
	});

	it("rejects a negative timelineStartSec", () => {
		expect(() =>
			audioTrackSchema.parse({
				id: "audio_1",
				assetId: "asset_1",
				durationSec: 10,
				timelineStartSec: -1,
			}),
		).toThrow();
	});

	it("createAudioTrack builds a schema-valid track with a prefixed id", () => {
		const track = createAudioTrack({
			assetId: "asset_1",
			durationSec: 12.5,
			timelineStartSec: 3,
			label: "voiceover.mp3",
		});
		expect(track.id).toMatch(/^audio_/);
		expect(track.assetId).toBe("asset_1");
		expect(track.durationSec).toBe(12.5);
		expect(track.timelineStartSec).toBe(3);
		expect(track.label).toBe("voiceover.mp3");
		// The factory output must itself round-trip through the schema.
		expect(() => audioTrackSchema.parse(track)).not.toThrow();
	});

	it("defaults audioTracks to [] when a stored document omits the key", () => {
		// A document written before issue #350 has no `audioTracks`; the defaulted
		// array must fill in so older files load unchanged (no schemaVersion bump).
		const { audioTracks: _drop, ...withoutAudio } = createEmptyDocument({
			projectId: "p",
			title: "t",
		});
		expect("audioTracks" in withoutAudio).toBe(false);
		const parsed = documentSchema.parse(withoutAudio);
		expect(parsed.audioTracks).toEqual([]);
	});

	it("round-trips a document carrying an audio track", () => {
		const track = createAudioTrack({ assetId: "asset_1", durationSec: 8 });
		const doc = {
			...createEmptyDocument({ projectId: "p", title: "t" }),
			audioTracks: [track],
		};
		const parsed = documentSchema.parse(doc);
		expect(parsed.audioTracks).toEqual([track]);
	});
});
