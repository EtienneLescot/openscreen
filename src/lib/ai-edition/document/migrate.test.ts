import { describe, expect, it } from "vitest";
import type { EditorProjectData } from "@/components/video-editor/projectPersistence";
import { migrateAxcutDocumentToProjectData, migrateProjectDataToAxcutDocument } from "./migrate";

function makeV2Project(overrides: Partial<EditorProjectData> = {}): EditorProjectData {
	return {
		version: 2,
		media: { screenVideoPath: "/recordings/screen.webm" },
		editor: {
			wallpaper: "/wallpapers/wallpaper1.jpg",
			shadowIntensity: 0,
			showBlur: false,
			showTrimWaveform: true,
			motionBlurAmount: 0,
			borderRadius: 0,
			padding: 50,
			cropRegion: { x: 0, y: 0, width: 1, height: 1 },
			zoomRegions: [],
			autoZoomEnabled: false,
			autoFocusAll: false,
			trimRegions: [],
			speedRegions: [],
			annotationRegions: [],
			aspectRatio: "16:9",
			webcamLayoutPreset: "picture-in-picture",
			webcamMaskShape: "circle",
			webcamMirrored: true,
			webcamReactiveZoom: true,
			webcamSizePreset: 25,
			webcamPosition: { cx: 0.5, cy: 0.5 },
			exportQuality: "good",
			exportFormat: "mp4",
			gifFrameRate: 15,
			gifLoop: true,
			gifSizePreset: "medium",
			cursorTheme: "default",
		},
		...overrides,
	};
}

describe("migrateProjectDataToAxcutDocument", () => {
	it("produces a v3 document with one asset and one clip from a v2 single-recording project", () => {
		const doc = migrateProjectDataToAxcutDocument(makeV2Project());

		expect(doc.schemaVersion).toBe(3);
		expect(doc.assets).toHaveLength(1);
		const asset = doc.assets[0];
		expect(asset.kind).toBe("video");
		expect(asset.originalPath).toBe("/recordings/screen.webm");
		expect(doc.project.primaryAssetId).toBe(asset.id);

		expect(doc.timeline.clips).toHaveLength(1);
		const clip = doc.timeline.clips[0];
		expect(clip.assetId).toBe(asset.id);
		expect(clip.sourceStartSec).toBe(0);
		expect(clip.sourceEndSec).toBeUndefined();
	});

	it("converts trimRegions to skipRanges on the primary asset (1.5s cut)", () => {
		const doc = migrateProjectDataToAxcutDocument(
			makeV2Project({
				editor: {
					...makeV2Project().editor,
					trimRegions: [{ id: "trim_a", startMs: 1000, endMs: 2500 }],
				},
			}),
		);

		expect(doc.timeline.skipRanges).toHaveLength(1);
		const skip = doc.timeline.skipRanges[0];
		expect(skip.assetId).toBe(doc.assets[0].id);
		expect(skip.startSec).toBeCloseTo(1.0, 3);
		expect(skip.endSec).toBeCloseTo(2.5, 3);
		expect(skip.origin).toBe("user");
	});

	it("converts speedRegions to timeline.speedRanges in seconds", () => {
		const doc = migrateProjectDataToAxcutDocument(
			makeV2Project({
				editor: {
					...makeV2Project().editor,
					speedRegions: [{ id: "spd_a", startMs: 5000, endMs: 8000, speed: 2 }],
				},
			}),
		);
		expect(doc.timeline.speedRanges).toHaveLength(1);
		expect(doc.timeline.speedRanges[0].startSec).toBeCloseTo(5.0, 3);
		expect(doc.timeline.speedRanges[0].endSec).toBeCloseTo(8.0, 3);
	});

	it("converts zoomRegions to seconds with focus normalized", () => {
		const doc = migrateProjectDataToAxcutDocument(
			makeV2Project({
				editor: {
					...makeV2Project().editor,
					zoomRegions: [
						{
							id: "z_1",
							startMs: 0,
							endMs: 2000,
							depth: 4,
							focus: { cx: 1.5, cy: -0.5 },
							focusMode: "manual",
							rotationPreset: "iso",
							customScale: 2.5,
							source: "manual",
						},
					],
				},
			}),
		);
		expect(doc.zoomRanges).toHaveLength(1);
		const z = doc.zoomRanges[0];
		expect(z.depth).toBe(4);
		expect(z.focus.cx).toBe(1);
		expect(z.focus.cy).toBe(0);
		expect(z.startMs).toBe(0);
		expect(z.endMs).toBe(2000);
		expect(z.customScale).toBe(2.5);
		expect(z.rotationPreset).toBe("iso");
	});

	it("converts annotationRegions to seconds with type and content preserved", () => {
		const doc = migrateProjectDataToAxcutDocument(
			makeV2Project({
				editor: {
					...makeV2Project().editor,
					annotationRegions: [
						{
							id: "ann_1",
							startMs: 1000,
							endMs: 3000,
							type: "text",
							content: "Hello",
							position: { x: 4, y: 86 },
							size: { width: 92, height: 12 },
							style: {
								color: "#fff",
								backgroundColor: "transparent",
								fontSize: 24,
								fontFamily: "Inter",
								fontWeight: "bold",
								fontStyle: "normal",
								textDecoration: "none",
								textAlign: "center",
							},
							zIndex: 1,
							annotationSource: "auto-caption",
						},
					],
				},
			}),
		);
		expect(doc.annotations).toHaveLength(1);
		const a = doc.annotations[0];
		expect(a.type).toBe("text");
		expect(a.startMs).toBe(1000);
		expect(a.endMs).toBe(3000);
		expect(a.annotationSource).toBe("auto-caption");
	});

	it("stores the v2 editor shape under legacyEditor for round-trip", () => {
		const v2 = makeV2Project();
		const doc = migrateProjectDataToAxcutDocument(v2);
		expect(doc.legacyEditor).toMatchObject({
			wallpaper: "/wallpapers/wallpaper1.jpg",
			cursorTheme: "default",
			autoZoomEnabled: false,
		});
	});

	it("handles missing media by creating an empty document", () => {
		const doc = migrateProjectDataToAxcutDocument({
			version: 2,
			editor: makeV2Project().editor,
		});
		expect(doc.assets).toEqual([]);
		expect(doc.timeline.clips).toEqual([]);
		expect(doc.project.primaryAssetId).toBeUndefined();
	});

	it("supports a legacy v1 videoPath-only project", () => {
		const doc = migrateProjectDataToAxcutDocument({
			version: 1,
			videoPath: "/legacy/recording.webm",
			editor: makeV2Project().editor,
		});
		expect(doc.assets).toHaveLength(1);
		expect(doc.assets[0].originalPath).toBe("/legacy/recording.webm");
	});

	it("ignores webcamPath on forward migration (renderer-side concern)", () => {
		const doc = migrateProjectDataToAxcutDocument(
			makeV2Project({
				media: {
					screenVideoPath: "/screen.webm",
					webcamVideoPath: "/webcam.webm",
					cursorCaptureMode: "editable-overlay",
				},
			}),
		);
		expect(doc.assets).toHaveLength(1);
		expect(doc.assets[0].originalPath).toBe("/screen.webm");
	});
});

describe("migrateAxcutDocumentToProjectData", () => {
	it("round-trips skipRanges back to trimRegions", () => {
		const v2 = makeV2Project({
			editor: {
				...makeV2Project().editor,
				trimRegions: [{ id: "trim_a", startMs: 1000, endMs: 2500 }],
			},
		});
		const doc = migrateProjectDataToAxcutDocument(v2);
		const back = migrateAxcutDocumentToProjectData(doc);
		expect(back.editor.trimRegions).toHaveLength(1);
		expect(back.editor.trimRegions[0].startMs).toBe(1000);
		expect(back.editor.trimRegions[0].endMs).toBe(2500);
	});

	it("round-trips legacyEditor fields back into editor.*", () => {
		const v2 = makeV2Project();
		const doc = migrateProjectDataToAxcutDocument(v2);
		const back = migrateAxcutDocumentToProjectData(doc);
		expect(back.editor.wallpaper).toBe("/wallpapers/wallpaper1.jpg");
		expect(back.editor.cursorTheme).toBe("default");
		expect(back.editor.webcamMaskShape).toBe("circle");
	});

	it("round-trips zoomRegions and annotationRegions back to ms", () => {
		const v2 = makeV2Project({
			editor: {
				...makeV2Project().editor,
				zoomRegions: [
					{
						id: "z_1",
						startMs: 0,
						endMs: 2000,
						depth: 4,
						focus: { cx: 0.5, cy: 0.5 },
					},
				],
				annotationRegions: [
					{
						id: "ann_1",
						startMs: 1000,
						endMs: 3000,
						type: "text",
						content: "Hello",
						position: { x: 50, y: 50 },
						size: { width: 30, height: 20 },
						style: {
							color: "#fff",
							backgroundColor: "transparent",
							fontSize: 24,
							fontFamily: "Inter",
							fontWeight: "bold",
							fontStyle: "normal",
							textDecoration: "none",
							textAlign: "center",
						},
						zIndex: 1,
					},
				],
			},
		});
		const doc = migrateProjectDataToAxcutDocument(v2);
		const back = migrateAxcutDocumentToProjectData(doc);
		expect(back.editor.zoomRegions[0].startMs).toBe(0);
		expect(back.editor.zoomRegions[0].endMs).toBe(2000);
		expect(back.editor.annotationRegions[0].startMs).toBe(1000);
		expect(back.editor.annotationRegions[0].endMs).toBe(3000);
	});

	it("rebuilds media.screenVideoPath from the primary asset", () => {
		const v2 = makeV2Project();
		const doc = migrateProjectDataToAxcutDocument(v2);
		const back = migrateAxcutDocumentToProjectData(doc);
		expect(back.media?.screenVideoPath).toBe("/recordings/screen.webm");
		expect(back.videoPath).toBe("/recordings/screen.webm");
	});

	it("clamps bad zoom focus to [0, 1] on forward migration", () => {
		const doc = migrateProjectDataToAxcutDocument(
			makeV2Project({
				editor: {
					...makeV2Project().editor,
					zoomRegions: [
						{
							id: "z_1",
							startMs: 0,
							endMs: 1000,
							depth: 1,
							focus: { cx: 2.5, cy: -0.5 },
						},
					],
				},
			}),
		);
		expect(doc.zoomRanges[0].focus.cx).toBe(1);
		expect(doc.zoomRanges[0].focus.cy).toBe(0);
	});
});
