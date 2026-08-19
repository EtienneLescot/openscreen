import { describe, expect, it } from "vitest";
import {
	DEFAULT_CROP_REGION,
	DEFAULT_CURSOR_SIZE,
	DEFAULT_WEBCAM_LAYOUT_PRESET,
	DEFAULT_WEBCAM_MASK_SHAPE,
} from "@/components/video-editor/types";
import type { AxcutDocument } from "../schema";
import { axcutSchemaVersion } from "../schema";
import { DEFAULT_EDITOR_SETTINGS, getEditorSettings, patchEditorSettings } from "./editorSettings";

const baseDoc: AxcutDocument = {
	schemaVersion: axcutSchemaVersion,
	project: {
		id: "p1",
		title: "Test",
		createdAt: "2026-06-25T10:00:00.000Z",
		updatedAt: "2026-06-25T10:00:00.000Z",
		primaryAssetId: "a1",
	},
	assets: [{ id: "a1", kind: "video", label: "clip", originalPath: "/x.mp4", cameraTrack: null }],
	timeline: {
		clips: [],
		gaps: [],
		trimRanges: [],
		muteRanges: [],
		speedRanges: [],
		captionRanges: [],
	},
	annotations: [],
	zoomRanges: [],
	transcripts: [],
	transcript: null,
	legacyEditor: null,
};

describe("getEditorSettings", () => {
	it("returns the defaults when the document has no legacyEditor", () => {
		const snap = getEditorSettings(baseDoc);
		expect(snap.wallpaper).toBe(DEFAULT_EDITOR_SETTINGS.wallpaper);
		expect(snap.aspectRatio).toBe("16:9");
		expect(snap.shadowIntensity).toBe(DEFAULT_EDITOR_SETTINGS.shadowIntensity);
		expect(snap.showBlur).toBe(false);
		expect(snap.webcamLayoutPreset).toBe(DEFAULT_WEBCAM_LAYOUT_PRESET);
		expect(snap.webcamMaskShape).toBe(DEFAULT_WEBCAM_MASK_SHAPE);
		expect(snap.cursor.size).toBe(DEFAULT_CURSOR_SIZE);
	});

	it("returns the defaults when the document is null", () => {
		const snap = getEditorSettings(null);
		expect(snap).toEqual(DEFAULT_EDITOR_SETTINGS);
	});

	it("reads overrides from legacyEditor", () => {
		const doc: AxcutDocument = {
			...baseDoc,
			legacyEditor: {
				wallpaper: "linear-gradient(red, blue)",
				aspectRatio: "9:16",
				shadowIntensity: 0.5,
				showBlur: true,
				webcamLayoutPreset: "side-by-side",
				webcamMaskShape: "circle",
				cursorSize: 5,
				cursorSmoothing: 0.8,
			},
		};
		const snap = getEditorSettings(doc);
		expect(snap.wallpaper).toBe("linear-gradient(red, blue)");
		expect(snap.aspectRatio).toBe("9:16");
		expect(snap.shadowIntensity).toBe(0.5);
		expect(snap.showBlur).toBe(true);
		expect(snap.webcamLayoutPreset).toBe("side-by-side");
		expect(snap.webcamMaskShape).toBe("circle");
		expect(snap.cursor.size).toBe(5);
		expect(snap.cursor.smoothing).toBe(0.8);
	});

	it("falls back to defaults for unknown or wrong-type values", () => {
		const doc: AxcutDocument = {
			...baseDoc,
			legacyEditor: { showBlur: "not-a-bool" as unknown as boolean },
		};
		const snap = getEditorSettings(doc);
		expect(snap.showBlur).toBe(false);
	});
});

describe("patchEditorSettings", () => {
	it("writes a single field and leaves others intact", () => {
		const next = patchEditorSettings(baseDoc, { showBlur: true });
		const snap = getEditorSettings(next);
		expect(snap.showBlur).toBe(true);
		expect(snap.shadowIntensity).toBe(DEFAULT_EDITOR_SETTINGS.shadowIntensity);
		expect(snap.cropRegion).toEqual(DEFAULT_CROP_REGION);
	});

	it("merges into an existing legacyEditor envelope", () => {
		const seed = patchEditorSettings(baseDoc, { showBlur: true });
		const next = patchEditorSettings(seed, { shadowIntensity: 0.7 });
		const snap = getEditorSettings(next);
		expect(snap.showBlur).toBe(true);
		expect(snap.shadowIntensity).toBe(0.7);
	});

	it("treats an explicitly undefined key as absent, not as a clear", () => {
		const seed = patchEditorSettings(baseDoc, { showBlur: true, shadowIntensity: 0.7 });
		const next = patchEditorSettings(seed, { showBlur: undefined, padding: 12 });
		const snap = getEditorSettings(next);
		expect(snap.showBlur).toBe(true);
		expect(snap.shadowIntensity).toBe(0.7);
		expect(snap.padding).toBe(12);
	});

	it("patches nested cursor settings without clobbering siblings", () => {
		const seed = patchEditorSettings(baseDoc, { cursor: { size: 4 } });
		const next = patchEditorSettings(seed, { cursor: { smoothing: 0.9 } });
		const snap = getEditorSettings(next);
		expect(snap.cursor.size).toBe(4);
		expect(snap.cursor.smoothing).toBe(0.9);
	});

	it("does not mutate the source document", () => {
		const before = getEditorSettings(baseDoc);
		patchEditorSettings(baseDoc, { showBlur: true });
		const after = getEditorSettings(baseDoc);
		expect(after).toEqual(before);
	});

	it("round-trips webcamPosition through legacyEditor", () => {
		const dragged = patchEditorSettings(baseDoc, {
			webcamPosition: { cx: 0.32, cy: 0.71 },
		});
		const snap = getEditorSettings(dragged);
		expect(snap.webcamPosition).toEqual({ cx: 0.32, cy: 0.71 });
	});

	it("clamps out-of-range webcamPosition when reading", () => {
		const doc: AxcutDocument = {
			...baseDoc,
			legacyEditor: { webcamPosition: { cx: 1.7, cy: -0.4 } },
		};
		const snap = getEditorSettings(doc);
		expect(snap.webcamPosition).toEqual({ cx: 1, cy: 0 });
	});

	it("leaves the chroma key off for a project that never mentions it", () => {
		// Every project recorded before this feature. The camera has to come back
		// exactly as it was shot, so "no setting" can only mean "no key".
		expect(getEditorSettings(baseDoc).webcamChromaKey.enabled).toBe(false);
	});

	it("merges a partial chroma-key patch instead of replacing the object", () => {
		// The toggle and each slider patch ONE field. A straight spread would drop
		// the picked colour every time the user moved a slider.
		const picked = patchEditorSettings(baseDoc, {
			webcamChromaKey: { color: "#123456", enabled: true },
		});
		const tuned = patchEditorSettings(picked, { webcamChromaKey: { similarity: 0.5 } });
		const snap = getEditorSettings(tuned);
		expect(snap.webcamChromaKey.color).toBe("#123456");
		expect(snap.webcamChromaKey.enabled).toBe(true);
		expect(snap.webcamChromaKey.similarity).toBe(0.5);
	});

	it("normalises a malformed persisted chroma key on read", () => {
		const doc: AxcutDocument = {
			...baseDoc,
			legacyEditor: {
				webcamChromaKey: { enabled: true, color: "#0F0", similarity: 9, spill: "lots" },
			},
		};
		const key = getEditorSettings(doc).webcamChromaKey;
		expect(key.enabled).toBe(true);
		expect(key.color).toBe("#00ff00");
		expect(key.similarity).toBe(1);
		expect(key.spill).toBe(DEFAULT_EDITOR_SETTINGS.webcamChromaKey.spill);
	});
});
