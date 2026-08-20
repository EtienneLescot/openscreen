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

	it("preserves a non-zero crop at the bottom-right edge", () => {
		const doc: AxcutDocument = {
			...baseDoc,
			legacyEditor: { webcamCropRegion: { x: 1, y: 1, width: 0.5, height: 0.5 } },
		};

		const crop = getEditorSettings(doc).webcamCropRegion;
		expect(crop.x).toBeCloseTo(0.99);
		expect(crop.y).toBeCloseTo(0.99);
		expect(crop.width).toBeCloseTo(0.01);
		expect(crop.height).toBeCloseTo(0.01);
	});

	// Every project on disk today carries a crop rect and no pan, because the pan did not
	// exist when they were saved. Recovering it from the rect is what keeps opening one a
	// no-op; defaulting to centred would quietly reframe all of them.
	it("recovers the pan of a crop authored before the pan was stored", () => {
		const doc: AxcutDocument = {
			...baseDoc,
			legacyEditor: { webcamCropRegion: { x: 0.375, y: 0, width: 0.5, height: 0.5 } },
		};

		const snap = getEditorSettings(doc);
		// 0.375 of the 0.5 the crop leaves free is three quarters of the way across.
		expect(snap.webcamCropPan.x).toBeCloseTo(0.75);
		expect(snap.webcamCropPan.y).toBeCloseTo(0);
		// And the rect comes back exactly as it went in — this is the identity that makes
		// the change invisible to an existing document.
		expect(snap.webcamCropRegion.x).toBeCloseTo(0.375);
		expect(snap.webcamCropRegion.y).toBeCloseTo(0);
	});

	it("reads a full-frame crop as centred, since it has no room to sit in", () => {
		const doc: AxcutDocument = {
			...baseDoc,
			legacyEditor: { webcamCropRegion: { x: 0, y: 0, width: 1, height: 1 } },
		};

		expect(getEditorSettings(doc).webcamCropPan).toEqual({ x: 0.5, y: 0.5 });
	});

	it("rebuilds the crop's offset from the pan when the two disagree on disk", () => {
		// The pan is authoritative: a rect whose offset contradicts it is a half-written
		// pair, and the pan is the half that carries intent.
		const doc: AxcutDocument = {
			...baseDoc,
			legacyEditor: {
				webcamCropRegion: { x: 0, y: 0, width: 0.5, height: 0.5 },
				webcamCropPan: { x: 1, y: 0.5 },
			},
		};

		const crop = getEditorSettings(doc).webcamCropRegion;
		expect(crop.x).toBeCloseTo(0.5);
		expect(crop.y).toBeCloseTo(0.25);
		expect(crop.width).toBeCloseTo(0.5);
	});

	it("clamps a stored pan that is out of range", () => {
		const doc: AxcutDocument = {
			...baseDoc,
			legacyEditor: {
				webcamCropRegion: { x: 0, y: 0, width: 0.5, height: 0.5 },
				webcamCropPan: { x: 5, y: -2 },
			},
		};

		const snap = getEditorSettings(doc);
		expect(snap.webcamCropPan).toEqual({ x: 1, y: 0 });
		// And the rect that follows from it still sits inside the frame.
		expect(snap.webcamCropRegion.x).toBeCloseTo(0.5);
		expect(snap.webcamCropRegion.y).toBeCloseTo(0);
	});

	it("falls back per axis when only one of the pan's coordinates is usable", () => {
		// A half-written or hand-edited pan must not drag the good axis down with it: each
		// coordinate recovers from the rect on its own.
		const doc: AxcutDocument = {
			...baseDoc,
			legacyEditor: {
				webcamCropRegion: { x: 0.375, y: 0.125, width: 0.5, height: 0.5 },
				webcamCropPan: { x: "left", y: 0.9 } as unknown as { x: number; y: number },
			},
		};

		const snap = getEditorSettings(doc);
		// x is unusable, so it comes back from the rect: 0.375 of the 0.5 free is 0.75.
		expect(snap.webcamCropPan.x).toBeCloseTo(0.75);
		// y is a number, so it is kept — and 0.9 is deliberately NOT what the rect implies
		// (0.125 of 0.5 free would be 0.25), so this fails if the axes are not independent.
		expect(snap.webcamCropPan.y).toBeCloseTo(0.9);
		// The rect then follows each axis from its own resolved pan.
		expect(snap.webcamCropRegion.x).toBeCloseTo(0.375);
		expect(snap.webcamCropRegion.y).toBeCloseTo(0.45);
	});
});
