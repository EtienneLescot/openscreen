import { describe, expect, it } from "vitest";
import {
	DEFAULT_CROP_REGION,
	DEFAULT_CURSOR_SIZE,
	DEFAULT_WEBCAM_LAYOUT_PRESET,
	DEFAULT_WEBCAM_MASK_SHAPE,
} from "@/components/video-editor/types";
import type { AxcutDocument } from "../schema";
import { DEFAULT_EDITOR_SETTINGS, getEditorSettings, patchEditorSettings } from "./editorSettings";

const baseDoc: AxcutDocument = {
	schemaVersion: 3,
	project: { id: "p1", title: "Test", primaryAssetId: "a1" },
	assets: [{ id: "a1", kind: "video", label: "clip", originalPath: "/x.mp4" }],
	timeline: { clips: [], trimRanges: [] },
	annotations: [],
	zoomRanges: [],
	transcripts: [],
	transcript: null,
	preview: { revision: 0 },
	legacyEditor: null,
};

describe("getEditorSettings", () => {
	it("returns the defaults when the document has no legacyEditor", () => {
		const snap = getEditorSettings(baseDoc);
		expect(snap.wallpaper).toBe(DEFAULT_EDITOR_SETTINGS.wallpaper);
		expect(snap.aspectRatio).toBe("16:9");
		expect(snap.shadowIntensity).toBe(0);
		expect(snap.showBlur).toBe(false);
		expect(snap.showTrimWaveform).toBe(true);
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
		expect(snap.shadowIntensity).toBe(0);
		expect(snap.cropRegion).toEqual(DEFAULT_CROP_REGION);
	});

	it("merges into an existing legacyEditor envelope", () => {
		const seed = patchEditorSettings(baseDoc, { showBlur: true });
		const next = patchEditorSettings(seed, { shadowIntensity: 0.7 });
		const snap = getEditorSettings(next);
		expect(snap.showBlur).toBe(true);
		expect(snap.shadowIntensity).toBe(0.7);
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
});
