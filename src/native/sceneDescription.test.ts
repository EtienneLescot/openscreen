// Tests for `buildSceneDescription` — the pure serializer that maps an AxcutDocument +
// editor settings to the frozen `SceneDescription` contract the native D3D compositor reads.
//
// Pure: no DOM, no React, no fs/network. We build minimal inline typed AxcutDocument fixtures
// and verify every derivation branch listed in the spec (background / clips / zoomRegions /
// crop / settings mapping / output dims).

import { describe, expect, it } from "vitest";
import { DEFAULT_CROP_REGION } from "@/components/video-editor/types";
import type {
	AxcutAsset,
	AxcutClip,
	AxcutDocument,
	AxcutZoomRegion,
} from "@/lib/ai-edition/schema";
import { buildSceneDescription } from "./sceneDescription";

// --- Fixture helpers --------------------------------------------------------
// Keep fixtures minimal & deterministic — every field the serializer consults is filled in;
// irrelevant fields are defaulted so schema-defaulting does not muddy the test.

function makeAsset(
	overrides: Partial<AxcutAsset> & Pick<AxcutAsset, "id" | "originalPath">,
): AxcutAsset {
	return {
		kind: "video",
		label: overrides.label ?? overrides.id,
		cameraTrack: null,
		...overrides,
	};
}

function makeClip(
	overrides: Partial<AxcutClip> &
		Pick<AxcutClip, "id" | "assetId" | "sourceStartSec" | "timelineStartSec" | "timelineEndSec">,
): AxcutClip {
	return {
		wordRefs: [],
		origin: "system",
		reason: "",
		...overrides,
	};
}

function makeZoom(
	overrides: Partial<AxcutZoomRegion> &
		Pick<AxcutZoomRegion, "id" | "startMs" | "endMs" | "depth" | "focus">,
): AxcutZoomRegion {
	return {
		...overrides,
	};
}

function makeDoc(
	overrides: Partial<AxcutDocument> & { assets?: AxcutAsset[]; clips?: AxcutClip[] } = {},
): AxcutDocument {
	const assets = overrides.assets ?? [];
	const clips = overrides.clips ?? [];
	const createdAt = "2024-01-01T00:00:00.000Z";
	const baseProject = { id: "p1", title: "Test", createdAt, updatedAt: createdAt };
	return {
		schemaVersion: 4,
		project: {
			...baseProject,
			...(overrides.project ?? {}),
			primaryAssetId: overrides.project?.primaryAssetId ?? assets[0]?.id,
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
			...(overrides.timeline ?? {}),
		},
		annotations: [],
		zoomRanges: overrides.zoomRanges ?? [],
		legacyEditor: overrides.legacyEditor ?? null,
		agent: { pendingQuestions: [], suggestions: [], lastAppliedOperations: [] },
		preview: { strategy: "seek", revision: 0 },
		export: { preset: "final-balanced", lastJobId: null },
		history: { revisions: [] },
	};
}

// --- background ------------------------------------------------------------

describe("buildSceneDescription.background", () => {
	it('"#123456" → color', () => {
		const doc = makeDoc({ legacyEditor: { wallpaper: "#123456" } });
		expect(buildSceneDescription(doc).background).toEqual({ kind: "color", color: "#123456" });
	});

	it('"linear-gradient(135deg, #eaebed, #bcc0c6)" → {angleDeg:135, stops:[…]}', () => {
		const doc = makeDoc({
			legacyEditor: { wallpaper: "linear-gradient(135deg, #eaebed, #bcc0c6)" },
		});
		expect(buildSceneDescription(doc).background).toEqual({
			kind: "gradient",
			angleDeg: 135,
			stops: ["#eaebed", "#bcc0c6"],
		});
	});

	it('"linear-gradient(#a1b2c3, #d4e5f6)" → {angleDeg:180, stops:[…]}', () => {
		const doc = makeDoc({ legacyEditor: { wallpaper: "linear-gradient(#a1b2c3, #d4e5f6)" } });
		expect(buildSceneDescription(doc).background).toEqual({
			kind: "gradient",
			angleDeg: 180,
			stops: ["#a1b2c3", "#d4e5f6"],
		});
	});

	it('"/wallpapers/x.jpg" → image', () => {
		const doc = makeDoc({ legacyEditor: { wallpaper: "/wallpapers/x.jpg" } });
		expect(buildSceneDescription(doc).background).toEqual({
			kind: "image",
			path: "/wallpapers/x.jpg",
		});
	});

	it('"data:image/png;base64,AAAA" → image', () => {
		const doc = makeDoc({ legacyEditor: { wallpaper: "data:image/png;base64,AAAA" } });
		expect(buildSceneDescription(doc).background).toEqual({
			kind: "image",
			path: "data:image/png;base64,AAAA",
		});
	});
});

// --- clips -----------------------------------------------------------------

describe("buildSceneDescription.clips", () => {
	it("sorts clips ascending by timelineStartSec", () => {
		const asset = makeAsset({ id: "a", originalPath: "/a.mp4" });
		const clip2 = makeClip({
			id: "c2",
			assetId: "a",
			sourceStartSec: 0,
			sourceEndSec: 5,
			timelineStartSec: 10,
			timelineEndSec: 15,
		});
		const clip1 = makeClip({
			id: "c1",
			assetId: "a",
			sourceStartSec: 0,
			sourceEndSec: 5,
			timelineStartSec: 2,
			timelineEndSec: 7,
		});
		const doc = makeDoc({ assets: [asset], clips: [clip2, clip1] });
		const { clips } = buildSceneDescription(doc);
		expect(clips.map((c) => c.sourceStartSec)).toEqual([0, 0]);
		expect(clips.map((_, i) => buildSceneDescription(doc).clips[i].sourceStartSec)).toEqual([0, 0]);
		// Re-derive the order independently so the assertion is on the explicit order property:
		const ordered = buildSceneDescription(doc).clips;
		// Mapping timelineStartSec onto the produced clips by index: c1 has timelineStartSec=2,
		// c2 has 10. After sorting by timelineStartSec, the first clip's sourceStartSec belongs
		// to c1 (because the clip we gave at timelineStartSec=2 was clip1, whose sourceStartSec
		// is also 0 — same value — so verify the underlying ordering more directly).
		// We can distinguish by reading the ids via the document pairing — here both clips share
		// sourceStartSec=0 so check the paired timeline order by sourceEndSec instead (5 each).
		// To make the sort visible we instead add unique sourceStartSec values and re-check.
		expect(ordered).toHaveLength(2);
	});

	it("sorts clips ascending by timelineStartSec (with distinguishing values)", () => {
		const asset = makeAsset({ id: "a", originalPath: "/a.mp4" });
		const later = makeClip({
			id: "c-late",
			assetId: "a",
			sourceStartSec: 100,
			sourceEndSec: 105,
			timelineStartSec: 50,
			timelineEndSec: 55,
		});
		const earlier = makeClip({
			id: "c-early",
			assetId: "a",
			sourceStartSec: 10,
			sourceEndSec: 15,
			timelineStartSec: 5,
			timelineEndSec: 10,
		});
		const doc = makeDoc({ assets: [asset], clips: [later, earlier] });
		const { clips } = buildSceneDescription(doc);
		expect(clips.map((c) => c.sourceStartSec)).toEqual([10, 100]);
		expect(clips.map((c) => c.sourceEndSec)).toEqual([15, 105]);
	});

	it("infers sourceEndSec when undefined as start + (timelineEnd - timelineStart)", () => {
		const asset = makeAsset({ id: "a", originalPath: "/a.mp4" });
		const clip = makeClip({
			id: "c1",
			assetId: "a",
			sourceStartSec: 7,
			// sourceEndSec omitted on purpose
			timelineStartSec: 2,
			timelineEndSec: 10,
		});
		const doc = makeDoc({ assets: [asset], clips: [clip] });
		const { clips } = buildSceneDescription(doc);
		expect(clips[0].sourceStartSec).toBe(7);
		// 7 + (10 - 2) = 15
		expect(clips[0].sourceEndSec).toBe(15);
	});

	it("uses the explicit sourceEndSec when set", () => {
		const asset = makeAsset({ id: "a", originalPath: "/a.mp4" });
		const clip = makeClip({
			id: "c1",
			assetId: "a",
			sourceStartSec: 7,
			sourceEndSec: 11,
			timelineStartSec: 2,
			timelineEndSec: 10,
		});
		const doc = makeDoc({ assets: [asset], clips: [clip] });
		const { clips } = buildSceneDescription(doc);
		expect(clips[0].sourceEndSec).toBe(11);
	});

	it("routes screenPath/webcamPath/webcamOffsetSec through the cameraTrack when present", () => {
		const asset = makeAsset({
			id: "a",
			originalPath: "/screen.mp4",
			cameraTrack: {
				sourcePath: "/cam.mp4",
				startMs: 250,
				offsetMs: 750,
				visible: true,
			},
		});
		const clip = makeClip({
			id: "c1",
			assetId: "a",
			sourceStartSec: 0,
			sourceEndSec: 4,
			timelineStartSec: 0,
			timelineEndSec: 4,
		});
		const doc = makeDoc({ assets: [asset], clips: [clip] });
		const { clips } = buildSceneDescription(doc);
		expect(clips[0].screenPath).toBe("/screen.mp4");
		expect(clips[0].webcamPath).toBe("/cam.mp4");
		expect(clips[0].webcamOffsetSec).toBe((250 + 750) / 1000);
	});

	it("falls back to the screen path and 0 offset when no cameraTrack", () => {
		const asset = makeAsset({ id: "a", originalPath: "/screen.mp4", cameraTrack: null });
		const clip = makeClip({
			id: "c1",
			assetId: "a",
			sourceStartSec: 0,
			sourceEndSec: 4,
			timelineStartSec: 0,
			timelineEndSec: 4,
		});
		const doc = makeDoc({ assets: [asset], clips: [clip] });
		const { clips } = buildSceneDescription(doc);
		expect(clips[0].screenPath).toBe("/screen.mp4");
		expect(clips[0].webcamPath).toBe("/screen.mp4");
		expect(clips[0].webcamOffsetSec).toBe(0);
	});

	it("skips a clip whose asset is missing", () => {
		const doc = makeDoc({
			assets: [],
			clips: [
				makeClip({
					id: "c1",
					assetId: "ghost",
					sourceStartSec: 0,
					timelineStartSec: 0,
					timelineEndSec: 1,
				}),
			],
		});
		expect(buildSceneDescription(doc).clips).toEqual([]);
	});

	it("skips a clip whose asset lacks originalPath", () => {
		// Force-typed fixture: originalPath is required by the schema, but the serializer is
		// defensive and should skip on a falsy value. Cast through unknown to drop the constraint.
		const asset = {
			id: "a",
			kind: "video",
			label: "x",
			originalPath: "",
			cameraTrack: null,
		} as unknown as AxcutAsset;
		const clip = makeClip({
			id: "c1",
			assetId: "a",
			sourceStartSec: 0,
			sourceEndSec: 1,
			timelineStartSec: 0,
			timelineEndSec: 1,
		});
		const doc = makeDoc({ assets: [asset], clips: [clip] });
		expect(buildSceneDescription(doc).clips).toEqual([]);
	});

	it("sets hasAudio=true for a clip whose screen asset has an originalPath", () => {
		// ponytail: the rule is "screen recordings from this app always carry a decodable
		// audio track" (per product convention + ffprobe on real recordings). The visibleClips
		// filter above guarantees only clips with originalPath reach the producer, so every
		// produced CompositorClipInput must carry hasAudio=true today.
		const asset = makeAsset({ id: "a", originalPath: "/screen.mp4" });
		const clip = makeClip({
			id: "c1",
			assetId: "a",
			sourceStartSec: 0,
			sourceEndSec: 4,
			timelineStartSec: 0,
			timelineEndSec: 4,
		});
		const doc = makeDoc({ assets: [asset], clips: [clip] });
		expect(buildSceneDescription(doc).clips[0].hasAudio).toBe(true);
	});

	it("sets hasAudio=true consistently across multiple clips in the same scene", () => {
		const asset = makeAsset({ id: "a", originalPath: "/screen.mp4" });
		const clip1 = makeClip({
			id: "c1",
			assetId: "a",
			sourceStartSec: 0,
			sourceEndSec: 4,
			timelineStartSec: 0,
			timelineEndSec: 4,
		});
		const clip2 = makeClip({
			id: "c2",
			assetId: "a",
			sourceStartSec: 4,
			sourceEndSec: 8,
			timelineStartSec: 4,
			timelineEndSec: 8,
		});
		const doc = makeDoc({ assets: [asset], clips: [clip1, clip2] });
		const { clips } = buildSceneDescription(doc);
		expect(clips).toHaveLength(2);
		expect(clips.every((c) => c.hasAudio === true)).toBe(true);
	});
});

// --- zoomRegions -----------------------------------------------------------

describe("buildSceneDescription.zoomRegions", () => {
	it("depth 1 → scale 1.0", () => {
		const z = makeZoom({ id: "z", startMs: 0, endMs: 1000, depth: 1, focus: { cx: 0.5, cy: 0.5 } });
		const doc = makeDoc({ zoomRanges: [z] });
		const { zoomRegions } = buildSceneDescription(doc);
		expect(zoomRegions[0].scale).toBe(1.0);
	});

	it("depth 6 → scale 3.5", () => {
		const z = makeZoom({ id: "z", startMs: 0, endMs: 1000, depth: 6, focus: { cx: 0.5, cy: 0.5 } });
		const doc = makeDoc({ zoomRanges: [z] });
		const { zoomRegions } = buildSceneDescription(doc);
		expect(zoomRegions[0].scale).toBe(3.5);
	});

	it("customScale overrides the depth-derived value", () => {
		const z = makeZoom({
			id: "z",
			startMs: 0,
			endMs: 1000,
			depth: 3,
			focus: { cx: 0.5, cy: 0.5 },
			customScale: 4.25,
		});
		const doc = makeDoc({ zoomRanges: [z] });
		const { zoomRegions } = buildSceneDescription(doc);
		expect(zoomRegions[0].scale).toBe(4.25);
	});

	it("passes focus + rotationPreset through verbatim", () => {
		const z = makeZoom({
			id: "z",
			startMs: 2000,
			endMs: 5000,
			depth: 4,
			focus: { cx: 0.25, cy: 0.75 },
			rotationPreset: "iso",
		});
		const doc = makeDoc({ zoomRanges: [z] });
		const { zoomRegions } = buildSceneDescription(doc);
		expect(zoomRegions[0].focusX).toBe(0.25);
		expect(zoomRegions[0].focusY).toBe(0.75);
		expect(zoomRegions[0].rotation).toBe("iso");
	});

	it("converts ms→sec for start/end", () => {
		const z = makeZoom({
			id: "z",
			startMs: 1500,
			endMs: 4250,
			depth: 2,
			focus: { cx: 0.5, cy: 0.5 },
		});
		const doc = makeDoc({ zoomRanges: [z] });
		const { zoomRegions } = buildSceneDescription(doc);
		expect(zoomRegions[0].startSec).toBe(1.5);
		expect(zoomRegions[0].endSec).toBe(4.25);
	});

	it("rotation defaults to null when no rotationPreset is set", () => {
		const z = makeZoom({
			id: "z",
			startMs: 0,
			endMs: 1000,
			depth: 2,
			focus: { cx: 0.5, cy: 0.5 },
		});
		const doc = makeDoc({ zoomRanges: [z] });
		expect(buildSceneDescription(doc).zoomRegions[0].rotation).toBeNull();
	});

	it("yields [] when zoomRanges is missing", () => {
		const doc = makeDoc({ zoomRanges: undefined });
		expect(buildSceneDescription(doc).zoomRegions).toEqual([]);
	});
});

// --- cameraFullscreenRegions -------------------------------------------------

describe("buildSceneDescription.cameraFullscreenRegions", () => {
	it("converts ms->sec for start/end", () => {
		const doc = makeDoc({
			legacyEditor: {
				cameraFullscreenRegions: [{ id: "cf1", startMs: 2000, endMs: 5500 }],
			},
		});
		const { cameraFullscreenRegions } = buildSceneDescription(doc);
		expect(cameraFullscreenRegions).toEqual([{ startSec: 2, endSec: 5.5 }]);
	});

	it("yields [] when legacyEditor.cameraFullscreenRegions is missing", () => {
		const doc = makeDoc({ legacyEditor: {} });
		expect(buildSceneDescription(doc).cameraFullscreenRegions).toEqual([]);
	});

	it("splits a region straddling two clips into one entry per clip's source time", () => {
		const asset = makeAsset({ id: "a", originalPath: "/a.mp4" });
		const clip1 = makeClip({
			id: "c1",
			assetId: "a",
			sourceStartSec: 100,
			sourceEndSec: 105,
			timelineStartSec: 0,
			timelineEndSec: 5,
		});
		const clip2 = makeClip({
			id: "c2",
			assetId: "a",
			sourceStartSec: 200,
			sourceEndSec: 205,
			timelineStartSec: 5,
			timelineEndSec: 10,
		});
		// Region spans timeline [3s, 7s) — 2s over clip1's tail, 2s over clip2's head.
		const doc = makeDoc({
			assets: [asset],
			clips: [clip1, clip2],
			legacyEditor: {
				cameraFullscreenRegions: [{ id: "cf1", startMs: 3000, endMs: 7000 }],
			},
		});
		const { cameraFullscreenRegions } = buildSceneDescription(doc);
		expect(cameraFullscreenRegions).toEqual([
			{ startSec: 103, endSec: 105 },
			{ startSec: 200, endSec: 202 },
		]);
	});
});

// --- speedRegions -----------------------------------------------------------
// Speed regions today live under `document.legacyEditor.speedRegions` (the schema's
// `timeline.speedRanges` is `rangeSchema[]` which carries no `speed` value — see
// src/native/sceneDescription.ts SceneDescription.speedRegions comment). These tests
// mirror the cameraFullscreenRegions shape but additionally carry the `speed` field
// through projection (and assert it stays the same on both sides of a clip split).

describe("buildSceneDescription.speedRegions", () => {
	it("converts ms->sec for start/end and carries the speed value through", () => {
		const asset = makeAsset({ id: "a", originalPath: "/a.mp4" });
		const clip = makeClip({
			id: "c1",
			assetId: "a",
			sourceStartSec: 0,
			sourceEndSec: 10,
			timelineStartSec: 0,
			timelineEndSec: 10,
		});
		const doc = makeDoc({
			assets: [asset],
			clips: [clip],
			legacyEditor: {
				speedRegions: [{ id: "s1", startMs: 2000, endMs: 5500, speed: 2.5 }],
			},
		});
		const { speedRegions } = buildSceneDescription(doc);
		expect(speedRegions).toEqual([{ startSec: 2, endSec: 5.5, speed: 2.5 }]);
	});

	it("yields [] when legacyEditor.speedRegions is missing", () => {
		const doc = makeDoc({ legacyEditor: {} });
		expect(buildSceneDescription(doc).speedRegions).toEqual([]);
	});

	it("splits a region straddling two clips into one entry per clip, both keeping the same speed", () => {
		const asset = makeAsset({ id: "a", originalPath: "/a.mp4" });
		const clip1 = makeClip({
			id: "c1",
			assetId: "a",
			sourceStartSec: 100,
			sourceEndSec: 105,
			timelineStartSec: 0,
			timelineEndSec: 5,
		});
		const clip2 = makeClip({
			id: "c2",
			assetId: "a",
			sourceStartSec: 200,
			sourceEndSec: 205,
			timelineStartSec: 5,
			timelineEndSec: 10,
		});
		// Region spans timeline [3s, 7s) — 2s over clip1's tail, 2s over clip2's head.
		// Both fragments must carry the original `speed` value (3.0) — the projection
		// function only rewrites startMs/endMs/id, every other field passes through.
		const doc = makeDoc({
			assets: [asset],
			clips: [clip1, clip2],
			legacyEditor: {
				speedRegions: [{ id: "s1", startMs: 3000, endMs: 7000, speed: 3.0 }],
			},
		});
		const { speedRegions } = buildSceneDescription(doc);
		expect(speedRegions).toEqual([
			{ startSec: 103, endSec: 105, speed: 3.0 },
			{ startSec: 200, endSec: 202, speed: 3.0 },
		]);
	});
});

// --- cropByClip --------------------------------------------------------------

describe("buildSceneDescription.cropByClip", () => {
	it("is null for a clip without its own cropRegion", () => {
		const asset = makeAsset({ id: "a", originalPath: "/a.mp4" });
		const clip = makeClip({
			id: "c1",
			assetId: "a",
			sourceStartSec: 0,
			sourceEndSec: 4,
			timelineStartSec: 0,
			timelineEndSec: 4,
		});
		const doc = makeDoc({ assets: [asset], clips: [clip] });
		expect(buildSceneDescription(doc).cropByClip).toEqual([null]);
	});

	it("is null for a clip whose cropRegion equals the identity (DEFAULT_CROP_REGION)", () => {
		const asset = makeAsset({ id: "a", originalPath: "/a.mp4" });
		const clip = makeClip({
			id: "c1",
			assetId: "a",
			sourceStartSec: 0,
			sourceEndSec: 4,
			timelineStartSec: 0,
			timelineEndSec: 4,
			cropRegion: { ...DEFAULT_CROP_REGION },
		});
		const doc = makeDoc({ assets: [asset], clips: [clip] });
		expect(buildSceneDescription(doc).cropByClip).toEqual([null]);
	});

	it("carries a non-identity per-clip cropRegion through, one entry per clip in clips[] order", () => {
		const asset = makeAsset({ id: "a", originalPath: "/a.mp4" });
		const region = { x: 0.1, y: 0.2, width: 0.5, height: 0.6 };
		const cropped = makeClip({
			id: "c1",
			assetId: "a",
			sourceStartSec: 0,
			sourceEndSec: 4,
			timelineStartSec: 0,
			timelineEndSec: 4,
			cropRegion: region,
		});
		const plain = makeClip({
			id: "c2",
			assetId: "a",
			sourceStartSec: 4,
			sourceEndSec: 8,
			timelineStartSec: 4,
			timelineEndSec: 8,
		});
		const doc = makeDoc({ assets: [asset], clips: [cropped, plain] });
		expect(buildSceneDescription(doc).cropByClip).toEqual([region, null]);
	});
});

// --- settings mapping ------------------------------------------------------

describe("buildSceneDescription.settings mapping", () => {
	it("divides padding by 100", () => {
		const doc = makeDoc({ legacyEditor: { padding: 50 } });
		expect(buildSceneDescription(doc).effects.padding).toBe(0.5);
	});

	it("roundnessPx equals borderRadius", () => {
		const doc = makeDoc({ legacyEditor: { borderRadius: 12 } });
		expect(buildSceneDescription(doc).effects.roundnessPx).toBe(12);
	});

	it("webcamSize is webcamSizeToFraction(webcamSizePreset) — clamp(preset,10,50)/100", () => {
		const doc = makeDoc({ legacyEditor: { webcamSizePreset: 33.4 } });
		expect(buildSceneDescription(doc).layout.webcamSize).toBeCloseTo(0.334, 5);
	});

	it("webcamSize clamps below 10 and above 50", () => {
		const low = makeDoc({ legacyEditor: { webcamSizePreset: 2 } });
		const high = makeDoc({ legacyEditor: { webcamSizePreset: 90 } });
		expect(buildSceneDescription(low).layout.webcamSize).toBeCloseTo(0.1, 5);
		expect(buildSceneDescription(high).layout.webcamSize).toBeCloseTo(0.5, 5);
	});

	it("maps the cursor sub-settings", () => {
		const doc = makeDoc({
			legacyEditor: {
				cursorSize: 4,
				cursorSmoothing: 0.9,
				cursorMotionBlur: 0.5,
				cursorClickBounce: 1.5,
				cursorClipToBounds: true,
			},
		});
		const cursor = buildSceneDescription(doc).cursor;
		expect(cursor.size).toBe(4);
		expect(cursor.smoothing).toBe(0.9);
		expect(cursor.motionBlur).toBe(0.5);
		expect(cursor.clickBounce).toBe(1.5);
		expect(cursor.clipToBounds).toBe(true);
	});

	it("maps show / theme / shape / mirror through to layout+cursor", () => {
		const doc = makeDoc({
			legacyEditor: {
				webcamMaskShape: "circle",
				webcamMirrored: true,
				cursorShow: false,
				cursorTheme: "macos-dark",
			},
		});
		const scene = buildSceneDescription(doc);
		expect(scene.layout.webcamShape).toBe("circle");
		expect(scene.layout.webcamMirror).toBe(true);
		expect(scene.cursor.show).toBe(false);
		expect(scene.cursor.theme).toBe("macos-dark");
	});

	it("populates layout.webcamRect with computeCompositeLayout's webcamRect, in fractions", () => {
		// PiP @ 25% doit produire un rect (fractions) aligné avec `computeCompositeLayout`.
		// Parité preview ↔ natif : la valeur que `PreviewCanvas` pose dans `.webcamSlot` est
		// exactement celle que reçoit le natif dans `layout.webcamRect`. Ce test couvre
		// principalement la conversion pixels → fractions (width/height du canvas = output dims).
		const asset = makeAsset({
			id: "a",
			originalPath: "/a.mp4",
			video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
		});
		const doc = makeDoc({
			assets: [asset],
			clips: [
				makeClip({
					id: "c1",
					assetId: "a",
					sourceStartSec: 0,
					sourceEndSec: 1,
					timelineStartSec: 0,
					timelineEndSec: 1,
				}),
			],
			legacyEditor: { webcamSizePreset: 25 },
		});
		const scene = buildSceneDescription(doc);
		const rect = scene.layout.webcamRect;
		expect(rect).not.toBeNull();
		// Le preset picture-in-picture à size=25% (default) place la webcam en bas-droite avec
		// une marge ~2% du canvas (cf. `compositeLayout.ts:162`). Pour un canvas 1920×1080 :
		// - côté ≈ sqrt(1920*1080) * 0.25 ≈ 360px ; avec aspect 4:3 → ~360x270
		// - x ≈ (1920 - margin - 360) / 1920 ≈ 0.795 ; y similaire pour h
		// Les valeurs exactes sont issues de computeCompositeLayout ; on vérifie surtout :
		//  • bornes 0..1 strictes ; • ratio PIXELS ≈ webcamSize (4:3 conservé) ; • x/y > 0.5 (bas-droite).
		expect(rect!.x).toBeGreaterThan(0.5);
		expect(rect!.y).toBeGreaterThan(0.5);
		expect(rect!.x + rect!.width).toBeLessThanOrEqual(1.0);
		expect(rect!.y + rect!.height).toBeLessThanOrEqual(1.0);
		// ratio cohérent en PIXELS (largeur*canvasW / hauteur*canvasH ~ 960/720 = 4/3 ≈ 1.333) —
		// PAS le ratio des fractions brutes, qui diffère du ratio pixel dès que le canvas n'est
		// pas carré (ici 1920x1080 : une fraction-ratio de 0.75 correspond bien à un pixel-ratio
		// de 4/3, puisque 1920/1080 = 16/9 redistribue les deux axes différemment).
		const pixelWidth = rect!.width * scene.output.width;
		const pixelHeight = rect!.height * scene.output.height;
		expect(pixelWidth / pixelHeight).toBeCloseTo(4 / 3, 1);
	});

	it("layout.webcamRect is null when no-webcam preset is selected", () => {
		const doc = makeDoc({
			legacyEditor: { webcamLayoutPreset: "no-webcam" },
		});
		const scene = buildSceneDescription(doc);
		expect(scene.layout.webcamRect).toBeNull();
	});
});

// --- output dims -----------------------------------------------------------

describe("buildSceneDescription.output", () => {
	it("picks the larger of two used assets", () => {
		const small = makeAsset({
			id: "small",
			originalPath: "/s.mp4",
			video: { codec: "h264", width: 1280, height: 720, fps: 30 },
		});
		const big = makeAsset({
			id: "big",
			originalPath: "/b.mp4",
			video: { codec: "h264", width: 3840, height: 2160, fps: 30 },
		});
		const doc = makeDoc({
			assets: [small, big],
			clips: [
				makeClip({
					id: "c1",
					assetId: "small",
					sourceStartSec: 0,
					sourceEndSec: 1,
					timelineStartSec: 0,
					timelineEndSec: 1,
				}),
				makeClip({
					id: "c2",
					assetId: "big",
					sourceStartSec: 0,
					sourceEndSec: 1,
					timelineStartSec: 1,
					timelineEndSec: 2,
				}),
			],
		});
		const { output } = buildSceneDescription(doc);
		expect(output).toEqual({ width: 3840, height: 2160, fps: null });
	});

	it("falls back to {1920, 1080} when no asset has dims", () => {
		const a = makeAsset({ id: "a", originalPath: "/a.mp4" }); // no video dims
		const doc = makeDoc({
			assets: [a],
			clips: [
				makeClip({
					id: "c1",
					assetId: "a",
					sourceStartSec: 0,
					sourceEndSec: 1,
					timelineStartSec: 0,
					timelineEndSec: 1,
				}),
			],
		});
		const { output } = buildSceneDescription(doc);
		expect(output).toEqual({ width: 1920, height: 1080, fps: null });
	});

	it("falls back to any asset with dims when no used asset has them", () => {
		const used = makeAsset({ id: "used", originalPath: "/u.mp4" }); // no dims
		const probe = makeAsset({
			id: "probe",
			originalPath: "/p.mp4",
			video: { codec: "h264", width: 2560, height: 1440, fps: 30 },
		});
		const doc = makeDoc({
			assets: [used, probe],
			clips: [
				makeClip({
					id: "c1",
					assetId: "used",
					sourceStartSec: 0,
					sourceEndSec: 1,
					timelineStartSec: 0,
					timelineEndSec: 1,
				}),
			],
		});
		const { output } = buildSceneDescription(doc);
		expect(output).toEqual({ width: 2560, height: 1440, fps: null });
	});
});
