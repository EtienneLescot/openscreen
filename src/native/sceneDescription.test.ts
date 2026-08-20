// Tests for `buildSceneDescription` — the pure serializer that maps an AxcutDocument +
// editor settings to the frozen `SceneDescription` contract the native D3D compositor reads.
//
// Pure: no DOM, no React, no fs/network. We build minimal inline typed AxcutDocument fixtures
// and verify every derivation branch listed in the spec (background / clips / zoomRegions /
// crop / settings mapping / output dims).

import { describe, expect, it } from "vitest";
import {
	DEFAULT_CROP_REGION,
	getZoomScale,
	ZOOM_DEPTH_SCALES,
} from "@/components/video-editor/types";
import type {
	AxcutAsset,
	AxcutClip,
	AxcutDocument,
	AxcutZoomRegion,
} from "@/lib/ai-edition/schema";
import { axcutSchemaVersion } from "@/lib/ai-edition/schema";
import { getFocusBoundsForScale } from "@/lib/zoomMath/focusUtils";
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
	overrides: Omit<Partial<AxcutDocument>, "timeline"> & {
		assets?: AxcutAsset[];
		clips?: AxcutClip[];
		// spread over the full default timeline below, so a fixture names only the
		// tracks it actually exercises instead of restating five empty arrays.
		timeline?: Partial<AxcutDocument["timeline"]>;
	} = {},
): AxcutDocument {
	const assets = overrides.assets ?? [];
	const clips = overrides.clips ?? [];
	const createdAt = "2024-01-01T00:00:00.000Z";
	const baseProject = { id: "p1", title: "Test", createdAt, updatedAt: createdAt };
	return {
		schemaVersion: axcutSchemaVersion,
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
		annotations: overrides.annotations ?? [],
		zoomRanges: overrides.zoomRanges ?? [],
		legacyEditor: overrides.legacyEditor ?? null,
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

	// The three below are why parseWallpaper delegates to parseCssGradient
	// instead of splitting on commas: the flat split shredded rgba() stops and
	// ignored keyword directions. The last one pins the failure mode — an
	// unparseable gradient stays a gradient (the native side falls back to the
	// layout background) rather than becoming an image path.
	it("keeps rgba() stops whole", () => {
		const doc = makeDoc({
			legacyEditor: { wallpaper: "linear-gradient(90deg, rgba(1,2,3,0.5), #fff)" },
		});
		expect(buildSceneDescription(doc).background).toEqual({
			kind: "gradient",
			angleDeg: 90,
			stops: ["rgba(1,2,3,0.5)", "#fff"],
		});
	});

	it('resolves "to bottom right" to 135deg', () => {
		const doc = makeDoc({
			legacyEditor: { wallpaper: "linear-gradient(to bottom right, #a1b2c3, #d4e5f6)" },
		});
		expect(buildSceneDescription(doc).background).toEqual({
			kind: "gradient",
			angleDeg: 135,
			stops: ["#a1b2c3", "#d4e5f6"],
		});
	});

	it("stays a gradient when the parser rejects the string", () => {
		// parseCssGradient anchors on a trailing ")" — a trailing space is enough.
		const doc = makeDoc({ legacyEditor: { wallpaper: "linear-gradient(135deg, red, blue) " } });
		expect(buildSceneDescription(doc).background).toEqual({
			kind: "gradient",
			angleDeg: 180,
			stops: [],
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

	it("emits empty webcamPath and 0 offset when no cameraTrack", () => {
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
		expect(clips[0].webcamPath).toBe("");
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
	// Ces deux tests attendaient `depth / 2 + 0.5` — la formule qui vivait dans
	// `sceneDescription`, à côté de la table que le reste de l'app utilise. Ils verrouillaient donc
	// le bug : le focus était borné avec la table et la fenêtre source découpée avec la formule.
	it("depth 1 → the table's scale, not a formula", () => {
		const z = makeZoom({ id: "z", startMs: 0, endMs: 1000, depth: 1, focus: { cx: 0.5, cy: 0.5 } });
		const doc = makeDoc({ zoomRanges: [z] });
		const { zoomRegions } = buildSceneDescription(doc);
		expect(zoomRegions[0].scale).toBe(ZOOM_DEPTH_SCALES[1]);
		expect(zoomRegions[0].scale).toBe(1.25);
	});

	it("clamps a customScale the schema lets through, exactly like the UI", () => {
		// `zoomRegionSchema` only requires `customScale` to be positive, so
		// `customScale: 12` is a legal document. This line read the raw field and
		// skipped the [1.0, 5.0] clamp `getZoomScale` applies — the web preview
		// rendered 5× and the native compositor 12×, for the same document. Same
		// class of disagreement as the formula above, one storey down.
		const z = makeZoom({
			id: "z",
			startMs: 0,
			endMs: 1000,
			depth: 3,
			focus: { cx: 0.5, cy: 0.5 },
			customScale: 12,
		});
		const { zoomRegions } = buildSceneDescription(makeDoc({ zoomRanges: [z] }));
		expect(zoomRegions[0].scale).toBe(5);
		expect(zoomRegions[0].scale).toBe(getZoomScale({ depth: 3, customScale: 12 }));
	});

	it("depth 6 → the table's scale", () => {
		const z = makeZoom({ id: "z", startMs: 0, endMs: 1000, depth: 6, focus: { cx: 0.5, cy: 0.5 } });
		const doc = makeDoc({ zoomRanges: [z] });
		const { zoomRegions } = buildSceneDescription(doc);
		expect(zoomRegions[0].scale).toBe(ZOOM_DEPTH_SCALES[6]);
		expect(zoomRegions[0].scale).toBe(5.0);
	});

	// L'invariant qui compte, et que personne ne vérifiait : le compositeur doit recevoir
	// EXACTEMENT l'échelle avec laquelle l'interface borne le point de focus. Sinon la fenêtre
	// source ne peut plus atteindre le bord de l'enregistrement — gimbal poussé à fond dans le
	// coin, 53 px sur 1920 restaient hors d'atteinte à la profondeur 3.
	it("sends the very scale the focus bounds are computed from, at every depth", () => {
		for (const depth of [1, 2, 3, 4, 5, 6] as const) {
			const z = makeZoom({
				id: "z",
				startMs: 0,
				endMs: 1000,
				depth,
				focus: { cx: 0.5, cy: 0.5 },
			});
			const { zoomRegions } = buildSceneDescription(makeDoc({ zoomRanges: [z] }));
			const uiScale = getZoomScale({ depth });
			expect(zoomRegions[0].scale).toBe(uiScale);
			// Et la conséquence géométrique : au bord du domaine de focus, la fenêtre source touche
			// bien le bord de la source (à la précision flottante près).
			const bounds = getFocusBoundsForScale(uiScale);
			const halfWindow = 1 / (2 * zoomRegions[0].scale);
			expect(bounds.minX - halfWindow).toBeCloseTo(0, 10);
			expect(bounds.minY - halfWindow).toBeCloseTo(0, 10);
		}
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

// --- zoomRegions × trims (raw↔compressed regression) ------------------------
// See technical-documentation/architecture/timeline-model.md. Regions are authored in
// RAW virtual-ms (trims still occupy the ruler), but the scene handed to native is
// built from TRIM-COMPRESSED playback segments (`resolveVisibleClips`). A region
// after a trim must still fire at the SAME source moment the user placed it on the
// raw ruler; today it slips by the total trimmed duration before it. This block is
// the failing witness for that bug (preview AND export both build the scene here).

describe("buildSceneDescription.zoomRegions with an earlier trim", () => {
	it("keeps a zoom on the source moment it was authored on, despite a trim before it", () => {
		// Identity clip: source [0,10] == timeline [0,10] (raw ruler == source time).
		const asset = makeAsset({ id: "a", originalPath: "/a.mp4" });
		const clip = makeClip({
			id: "c1",
			assetId: "a",
			sourceStartSec: 0,
			sourceEndSec: 10,
			timelineStartSec: 0,
			timelineEndSec: 10,
		});
		// Trim removes source [2,4]. Playback compresses to two kept segments:
		//   seg1 source [0,2] @ compressed timeline [0,2]
		//   seg2 source [4,10] @ compressed timeline [2,8]
		// Zoom authored at RAW timeline [6,8] → identity clip → source [6,8]. Source 6
		// is kept (after the trim) so it belongs to seg2 (clipIndex 1). The CORRECT
		// scene zoom is source [6,8] on clipIndex 1 — NOT [8,10] (what raw-coords-vs-
		// compressed-clips ventilation produces: it shifts the region forward by the 2s
		// the trim removed earlier on the timeline).
		const doc = makeDoc({
			assets: [asset],
			clips: [clip],
			timeline: {
				trimRanges: [
					{ id: "t1", assetId: "a", startSec: 2, endSec: 4, reason: "", origin: "user" },
				],
			},
			zoomRanges: [
				makeZoom({ id: "z", startMs: 6000, endMs: 8000, depth: 3, focus: { cx: 0.5, cy: 0.5 } }),
			],
		});
		const { zoomRegions } = buildSceneDescription(doc);
		expect(zoomRegions).toEqual([
			{
				id: "z",
				startSec: 6,
				endSec: 8,
				// profondeur 3 = 1.8 dans `ZOOM_DEPTH_SCALES` ; ce test portait sur la ventilation
				// du zoom après un trim, pas sur l'échelle, mais il en fixait la valeur au passage.
				scale: ZOOM_DEPTH_SCALES[3],
				focusX: 0.5,
				focusY: 0.5,
				focusMode: null,
				rotation: null,
				clipIndex: 1,
			},
		]);
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
			{ startSec: 103, endSec: 105, clipIndex: 0 },
			{ startSec: 200, endSec: 202, clipIndex: 1 },
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
		expect(speedRegions).toEqual([{ startSec: 2, endSec: 5.5, speed: 2.5, clipIndex: 0 }]);
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
			{ startSec: 103, endSec: 105, speed: 3.0, clipIndex: 0 },
			{ startSec: 200, endSec: 202, speed: 3.0, clipIndex: 1 },
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

// --- audio -----------------------------------------------------------------

describe("buildSceneDescription.audio", () => {
	// The editor claims "what you hear is what you export". That only holds while this
	// payload carries nothing the preview cannot reproduce on the raw source file it
	// plays — which is a linear gain, and nothing else. These tests exist so a future
	// stage with state (a filter, a compressor), one measured over the assembled
	// programme (a loudness normaliser), or one expressed in timeline time (a sync
	// offset — this shipped once and was removed) cannot be added here unnoticed.
	it("carries the authored gain through to the native payload", () => {
		const doc = makeDoc({ legacyEditor: { audioGainDb: 4.5 } });
		expect(buildSceneDescription(doc).audio).toEqual({ gainDb: 4.5 });
	});

	it("defaults to a no-op for a project that predates the control", () => {
		expect(buildSceneDescription(makeDoc()).audio).toEqual({ gainDb: 0 });
	});

	it("exposes only the gain", () => {
		// Guards the parity contract itself, not a value: an extra key here means the
		// export applies something the preview does not.
		expect(Object.keys(buildSceneDescription(makeDoc()).audio)).toEqual(["gainDb"]);
	});

	it("clamps to the range the slider offers, so the UI can always display it", () => {
		expect(buildSceneDescription(makeDoc({ legacyEditor: { audioGainDb: -99 } })).audio).toEqual({
			gainDb: -12,
		});
		expect(buildSceneDescription(makeDoc({ legacyEditor: { audioGainDb: 99 } })).audio).toEqual({
			gainDb: 12,
		});
	});
});

// --- settings mapping ------------------------------------------------------

describe("buildSceneDescription.settings mapping", () => {
	it("divides padding by 100", () => {
		const doc = makeDoc({ legacyEditor: { padding: 50 } });
		expect(buildSceneDescription(doc).effects.padding).toBe(0.5);
	});

	it("roundnessFrac is the slider divided by the frame's short side, not raw pixels", () => {
		// The contract carries no pixel counts: the compositor rasterises the preview
		// smaller than the export, so a pixel means two different things across the
		// boundary. Absolute values crossing it is what drew the PiP circle as a blob.
		const doc = makeDoc({ legacyEditor: { borderRadius: 12 } });
		const scene = buildSceneDescription(doc);
		const shortSide = Math.min(scene.output.width, scene.output.height);
		expect(scene.effects.roundnessFrac).toBeCloseTo(12 / shortSide, 10);
	});

	it("round-trips the authored pixel value at output size, whatever the resolution", () => {
		// The slider keeps meaning "N pixels of the finished video" — the fraction only
		// exists so the native side can rebuild it against whatever it is rasterising
		// into. Multiplying back by the output's short side must return exactly N.
		const at = (w: number, h: number) => {
			const doc = makeDoc({
				assets: [
					makeAsset({
						id: "a",
						originalPath: "/a.mp4",
						video: { codec: "h264", width: w, height: h, fps: 30 },
					}),
				],
				clips: [
					makeClip({
						id: "c1",
						assetId: "a",
						sourceStartSec: 0,
						timelineStartSec: 0,
						timelineEndSec: 5,
					}),
				],
				legacyEditor: { borderRadius: 24 },
			});
			const scene = buildSceneDescription(doc);
			return scene.effects.roundnessFrac * Math.min(scene.output.width, scene.output.height);
		};
		expect(at(1920, 1080)).toBeCloseTo(24, 6);
		expect(at(3840, 2160)).toBeCloseTo(24, 6);
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
			// The camera the preset presupposes. A clip WITHOUT one lays out as
			// "no-webcam" whatever the panel says (see the camera-less cases below),
			// so there would be no rect here to convert.
			cameraTrack: { sourcePath: "/a-webcam.mp4", startMs: 0, offsetMs: 0, visible: true },
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

	it("lays the camera box out from the camera's own dimensions, with no second argument", () => {
		// The parity claim, and the reason `cameraTrack` carries dimensions at all.
		//
		// The case above passes a cameraTrack WITHOUT dimensions and gets 4:3 — the fallback,
		// which is correct for a document written before the field existed. This one carries
		// them, and must get 16:9 from the ARGUMENT-FREE call, because that is the call every
		// export makes: `ExportDialog` and the CLI runner both invoke
		// `buildSceneDescription(document)` with nothing else.
		//
		// Before the camera's size lived in the document, only the preview could supply it —
		// through the optional second argument, filled from a mounted <video>'s reported size.
		// So the same project framed a 16:9 camera 16:9 on screen and 4:3 in the file, and
		// `cover_uv_rect` (Rust) trimmed the authored crop to that wrong box. This test fails
		// on any version where the box depends on who is asking.
		const asset = makeAsset({
			id: "a",
			originalPath: "/a.mp4",
			video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
			cameraTrack: {
				sourcePath: "/a-webcam.mp4",
				startMs: 0,
				offsetMs: 0,
				visible: true,
				width: 1280,
				height: 720,
			},
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
		// Pixel ratio, not fraction ratio — see the neighbouring case for why.
		const pixelWidth = rect!.width * scene.output.width;
		const pixelHeight = rect!.height * scene.output.height;
		expect(pixelWidth / pixelHeight).toBeCloseTo(16 / 9, 1);
	});

	it("layout.webcamRect is null when no-webcam preset is selected", () => {
		const doc = makeDoc({
			legacyEditor: { webcamLayoutPreset: "no-webcam" },
		});
		const scene = buildSceneDescription(doc);
		expect(scene.layout.webcamRect).toBeNull();
	});

	it("ships the screen box next to the camera box for the block layouts", () => {
		// Both rects come from the same computeCompositeLayout call; the native side must
		// consume them together, otherwise it draws the app's camera against its own
		// hardcoded screen box and the camera lands outside the scene.
		const asset = makeAsset({
			id: "a",
			originalPath: "/a.mp4",
			cameraTrack: { sourcePath: "/cam.mp4", startMs: 0, offsetMs: 0, visible: true },
		});
		const doc = makeDoc({
			assets: [asset],
			clips: [
				makeClip({
					id: "c1",
					assetId: "a",
					sourceStartSec: 0,
					sourceEndSec: 10,
					timelineStartSec: 0,
					timelineEndSec: 10,
				}),
			],
			legacyEditor: { webcamLayoutPreset: "dual-frame", padding: 0 },
		});
		const scene = buildSceneDescription(doc);
		const screen = scene.layout.screenRect;
		const cam = scene.layout.webcamRect;
		expect(screen).not.toBeNull();
		expect(cam).not.toBeNull();
		// Side by side, padding 0: the block spans the full width of the frame.
		expect(screen!.x).toBeCloseTo(0, 2);
		expect(cam!.x + cam!.width).toBeCloseTo(1, 2);
		// …and neither box escapes it.
		expect(cam!.x + cam!.width).toBeLessThanOrEqual(1.001);
		expect(cam!.y + cam!.height).toBeLessThanOrEqual(1.001);
		// Camera sits after the screen, same height, no overlap.
		expect(cam!.x).toBeGreaterThan(screen!.x + screen!.width);
		expect(cam!.height).toBeCloseTo(screen!.height, 3);
		// The block layouts impose their corner radius on the screen too.
		expect(scene.layout.screenRadiusFrac).toBeGreaterThan(0);
	});

	it("leaves screenRadiusFrac null for picture-in-picture, so the Roundness slider still drives it", () => {
		const doc = makeDoc({ legacyEditor: { webcamLayoutPreset: "picture-in-picture" } });
		expect(buildSceneDescription(doc).layout.screenRadiusFrac).toBeNull();
	});

	/** A document with a camera on its only clip, so the layout resolves a webcam box. */
	function docWithCamera(legacyEditor: Record<string, unknown>) {
		const asset = makeAsset({
			id: "a",
			originalPath: "/a.mp4",
			cameraTrack: { sourcePath: "/cam.mp4", startMs: 0, offsetMs: 0, visible: true },
		});
		return makeDoc({
			assets: [asset],
			clips: [
				makeClip({
					id: "c1",
					assetId: "a",
					sourceStartSec: 0,
					sourceEndSec: 10,
					timelineStartSec: 0,
					timelineEndSec: 10,
				}),
			],
			legacyEditor,
		});
	}

	it.each([
		"dual-frame",
		"vertical-stack",
	] as const)("ships a rectangle for %s, whatever shape the user last picked under PiP", (preset) => {
		// The shape picker is hidden for the block layouts, but the setting survives
		// from the last time PiP was active — shipping it raw is what rounded the
		// side-by-side camera off into a disc.
		const scene = buildSceneDescription(
			docWithCamera({ webcamLayoutPreset: preset, webcamMaskShape: "circle" }),
		);
		expect(scene.layout.webcamShape).toBe("rectangle");
	});

	it.each([
		"circle",
		"rounded",
		"square",
		"rectangle",
	] as const)("ships the same camera radius for a block layout whatever the stored mask shape (%s)", (shape) => {
		const scene = buildSceneDescription(
			docWithCamera({ webcamLayoutPreset: "dual-frame", webcamMaskShape: shape }),
		);
		const reference = buildSceneDescription(
			docWithCamera({ webcamLayoutPreset: "dual-frame", webcamMaskShape: "rectangle" }),
		);
		expect(scene.layout.webcamRadiusFrac).toBe(reference.layout.webcamRadiusFrac);
		expect(scene.layout.webcamRadiusFrac).toBeGreaterThan(0);
	});

	it("rounds both halves of a block alike — one radius, not two formulas", () => {
		// The native side used to derive the camera's radius from its own table while the
		// screen took the app's, so the welded block could never match itself. Both are
		// fractions of their OWN box, and the block gives the two boxes different shapes,
		// so equality has to be checked back in output pixels.
		const scene = buildSceneDescription(
			docWithCamera({ webcamLayoutPreset: "vertical-stack", webcamMaskShape: "circle" }),
		);
		const px = (frac: number | null | undefined, box: { width: number; height: number } | null) =>
			frac != null && box
				? frac * Math.min(box.width * scene.output.width, box.height * scene.output.height)
				: null;
		expect(px(scene.layout.webcamRadiusFrac, scene.layout.webcamRect ?? null)).toBeCloseTo(
			px(scene.layout.screenRadiusFrac, scene.layout.screenRect ?? null) ?? 0,
			6,
		);
	});

	it("still honours the shape picker under picture-in-picture", () => {
		const scene = buildSceneDescription(
			docWithCamera({ webcamLayoutPreset: "picture-in-picture", webcamMaskShape: "circle" }),
		);
		expect(scene.layout.webcamShape).toBe("circle");
		// A circle is a rounded rect whose radius is HALF its (square) box — that exact
		// fraction is what makes the native rounded-box SDF draw a disc rather than a
		// blob, at any render size.
		expect(scene.layout.webcamRadiusFrac).toBeCloseTo(0.5, 2);
	});

	it("leaves webcamRadiusFrac null when the layout resolves no camera box", () => {
		const doc = makeDoc({ legacyEditor: { webcamLayoutPreset: "no-webcam" } });
		expect(buildSceneDescription(doc).layout.webcamRadiusFrac).toBeNull();
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

	it("honors legacyEditor.aspectRatio instead of always following the source asset's own ratio", () => {
		// BUG corrigé : output ignorait complètement le sélecteur de ratio et retournait
		// toujours les dims brutes de l'asset (16:9 ici) — la correction "fit" côté natif
		// (compose_frame, compositor.rs) compare `output` à sa résolution interne 16:9 pour
		// savoir combien corriger l'écran/la webcam, donc un `output` toujours ~16:9 rendait
		// cette correction systématiquement un no-op quel que soit le ratio choisi.
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
			legacyEditor: { aspectRatio: "9:16" },
		});
		const { output } = buildSceneDescription(doc);
		// Longest side (1920, the source asset's own width) stays pinned; the other side is
		// derived from the 9:16 ratio — portrait, not the source's native 16:9.
		expect(output.width).toBe(1080);
		expect(output.height).toBe(1920);
	});
});

// --- screenRect vs crop ------------------------------------------------------

describe("buildSceneDescription.layout.screenRect", () => {
	// `compositor.rs` consumes `layout.screenRect` AS-IS — its `fit_screen` closure skips
	// its own crop fit precisely because the rect is documented as "already at the crop's
	// aspect ratio". So the rect's aspect IS the contract: get it wrong and the video is
	// stretched to fill a mis-shaped box, with nothing downstream to catch it.
	const cropped = (crop: { x: number; y: number; width: number; height: number } | undefined) => {
		const asset = makeAsset({
			id: "a",
			originalPath: "/screen.mp4",
			video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
		});
		const clip = makeClip({
			id: "c1",
			assetId: "a",
			sourceStartSec: 0,
			sourceEndSec: 4,
			timelineStartSec: 0,
			timelineEndSec: 4,
			...(crop ? { cropRegion: crop } : {}),
		});
		const scene = buildSceneDescription(makeDoc({ assets: [asset], clips: [clip] }));
		const r = scene.layout.screenRect;
		if (!r) throw new Error("screenRect absent");
		// fractions of the output frame -> pixels, to compare a real aspect
		return (r.width * scene.output.width) / (r.height * scene.output.height);
	};

	// `computeCompositeLayout` works in integer pixels, so an extreme aspect quantizes
	// by a fraction of a percent. A RELATIVE tolerance is the meaningful check here:
	// the failure this guards against is off by 2-3x, not by 0.1%.
	const expectAspect = (got: number, want: number) =>
		expect(Math.abs(got - want) / want).toBeLessThan(0.01);

	it("matches the cropped source aspect, not the full frame's", () => {
		// The reported regression: a tall narrow crop (30% x 89% of a 16:9 source) was
		// handed a 16:9 box, so the strip was stretched ~2.8x horizontally.
		const crop = { x: 0.44, y: 0.06, width: 0.3, height: 0.89 };
		expectAspect(cropped(crop), (1920 * crop.width) / (1080 * crop.height));
	});

	it("keeps the full source aspect when the clip is not cropped", () => {
		expectAspect(cropped(undefined), 1920 / 1080);
	});

	it("follows a wide letterbox crop too", () => {
		const crop = { x: 0, y: 0.3, width: 1, height: 0.4 };
		expectAspect(cropped(crop), (1920 * 1) / (1080 * 0.4));
	});
});

// --- layoutByClip : la forme de la source est PAR CLIP -----------------------

describe("buildSceneDescription.layout.layoutByClip", () => {
	// Un clip est un enregistrement d'ecran + camera/son optionnels : rien n'impose a deux
	// clips la meme taille ni le meme ratio. Le crop n'est qu'une maniere de plus de faire
	// varier cette forme. Un layout unique pour toute la scene ne peut donc pas etre juste —
	// c'est ce qui etirait un clip croppe place apres un clip non croppe (cas rapporte).
	const aspectOf = (r: { width: number; height: number }, out: { width: number; height: number }) =>
		(r.width * out.width) / (r.height * out.height);

	const twoClipDoc = () => {
		const asset = makeAsset({
			id: "a",
			originalPath: "/screen.mp4",
			video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
		});
		const plain = makeClip({
			id: "c1",
			assetId: "a",
			sourceStartSec: 0,
			sourceEndSec: 4,
			timelineStartSec: 0,
			timelineEndSec: 4,
		});
		const cropped = makeClip({
			id: "c2",
			assetId: "a",
			sourceStartSec: 4,
			sourceEndSec: 8,
			timelineStartSec: 4,
			timelineEndSec: 8,
			cropRegion: { x: 0.45, y: 0.11, width: 0.31, height: 0.89 },
		});
		return makeDoc({ assets: [asset], clips: [plain, cropped] });
	};

	it("gives each clip a layout at ITS OWN source aspect", () => {
		const scene = buildSceneDescription(twoClipDoc());
		const byClip = scene.layout.layoutByClip;
		if (!byClip) throw new Error("layoutByClip absent");
		expect(byClip).toHaveLength(2);

		const plain = byClip[0];
		const cropped = byClip[1];
		if (!plain || !cropped) throw new Error("entree manquante");

		// clip 0 : pas de crop -> ratio de la source
		expect(aspectOf(plain.screenRect, scene.output)).toBeCloseTo(1920 / 1080, 1);
		// clip 1 : croppe -> ratio du crop, PAS celui du clip 0
		const want = (1920 * 0.31) / (1080 * 0.89);
		const got = aspectOf(cropped.screenRect, scene.output);
		expect(Math.abs(got - want) / want).toBeLessThan(0.01);
	});

	it("is index-aligned with clips and cropByClip", () => {
		const scene = buildSceneDescription(twoClipDoc());
		expect(scene.layout.layoutByClip).toHaveLength(scene.clips.length);
		expect(scene.cropByClip).toHaveLength(scene.clips.length);
		expect(scene.cropByClip[0]).toBeNull();
		expect(scene.cropByClip[1]).not.toBeNull();
	});

	it("keeps the scalar layout fields as the first clip's entry", () => {
		const scene = buildSceneDescription(twoClipDoc());
		expect(scene.layout.screenRect).toEqual(scene.layout.layoutByClip?.[0]?.screenRect);
	});

	// issue #248 — le preset est GLOBAL (un seul panneau) mais la camera est PAR CLIP.
	// Un projet melange sans probleme un enregistrement avec webcam et un import qui n'en
	// a pas ; le reglage ne doit s'appliquer qu'aux clips qui ont vraiment une camera.
	const mixedDoc = (preset: string) => {
		const withCam = makeAsset({
			id: "cam",
			originalPath: "/rec.mp4",
			video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
			cameraTrack: { sourcePath: "/rec-webcam.webm", startMs: 0, offsetMs: 0, visible: true },
		});
		const noCam = makeAsset({
			id: "nocam",
			originalPath: "/import.mp4",
			video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
		});
		return makeDoc({
			assets: [withCam, noCam],
			clips: [
				makeClip({
					id: "c1",
					assetId: "cam",
					sourceStartSec: 0,
					sourceEndSec: 4,
					timelineStartSec: 0,
					timelineEndSec: 4,
				}),
				makeClip({
					id: "c2",
					assetId: "nocam",
					sourceStartSec: 0,
					sourceEndSec: 4,
					timelineStartSec: 4,
					timelineEndSec: 8,
				}),
			],
			legacyEditor: { webcamLayoutPreset: preset },
		});
	};

	it.each([
		"picture-in-picture",
		"dual-frame",
		"vertical-stack",
	])("under %s, only the clip that HAS a camera gets a webcam rect", (preset) => {
		const byClip = buildSceneDescription(mixedDoc(preset)).layout.layoutByClip;
		if (!byClip) throw new Error("layoutByClip absent");
		expect(byClip[0]?.webcamRect).not.toBeNull();
		expect(byClip[1]?.webcamRect).toBeNull();
	});

	// Le coeur du bug rapporte : les presets en bloc dimensionnent l'ECRAN sur le bloc.
	// Masquer la seule vignette ne suffit pas — sans ca le clip sans camera gardait un
	// ecran comprime dans sa moitie, avec du vide a cote.
	it.each([
		"dual-frame",
		"vertical-stack",
	])("under %s, the camera-less clip gets its full frame back", (preset) => {
		const scene = buildSceneDescription(mixedDoc(preset));
		const byClip = scene.layout.layoutByClip;
		if (!byClip) throw new Error("layoutByClip absent");
		const blocked = byClip[0]?.screenRect;
		const alone = byClip[1]?.screenRect;
		if (!blocked || !alone) throw new Error("entree manquante");
		// Meme source (1920x1080) des deux cotes : la seule difference est la camera.
		const area = (r: { width: number; height: number }) => r.width * r.height;
		expect(area(alone)).toBeGreaterThan(area(blocked) * 1.2);
		// Et il retrouve le ratio de sa source, au lieu du slot du bloc.
		expect(aspectOf(alone, scene.output)).toBeCloseTo(1920 / 1080, 1);
	});
});

// --- annotations -----------------------------------------------------------

describe("buildSceneDescription.annotations", () => {
	const style = {
		color: "#ffffff",
		backgroundColor: "transparent",
		fontSize: 32,
		fontFamily: "Inter",
		fontWeight: "bold" as const,
		fontStyle: "normal" as const,
		textDecoration: "none" as const,
		textAlign: "center" as const,
	};

	function docWithAnnotations(annotations: AxcutDocument["annotations"]) {
		return makeDoc({
			assets: [makeAsset({ id: "a1", originalPath: "/tmp/a1.mp4", durationSec: 30 })],
			clips: [
				makeClip({
					id: "c1",
					assetId: "a1",
					sourceStartSec: 0,
					sourceEndSec: 30,
					timelineStartSec: 0,
					timelineEndSec: 30,
				}),
			],
			annotations,
		});
	}

	it("converts the authored percentages into screen-rect fractions", () => {
		// The web overlay divides by 100 against `layout.screenRect`; native gets the same space
		// as fractions so it never has to know about percent.
		const scene = buildSceneDescription(
			docWithAnnotations([
				{
					id: "ann1",
					startMs: 1000,
					endMs: 3000,
					type: "text",
					content: "",
					textContent: "Hello",
					position: { x: 25, y: 50 },
					size: { width: 40, height: 10 },
					style,
					zIndex: 0,
				},
			]),
		);
		expect(scene.annotations).toHaveLength(1);
		expect(scene.annotations[0]).toMatchObject({
			id: "ann1",
			kind: "text",
			startSec: 1,
			endSec: 3,
			x: 0.25,
			y: 0.5,
			w: 0.4,
			h: 0.1,
			clipIndex: 0,
		});
	});

	it("carries the text payload, reading the field the inspector actually writes", () => {
		const scene = buildSceneDescription(
			docWithAnnotations([
				{
					id: "ann1",
					startMs: 0,
					endMs: 1000,
					type: "text",
					content: "migrated",
					textContent: "live",
					position: { x: 0, y: 0 },
					size: { width: 10, height: 10 },
					style: { ...style, textAlign: "left", textAnimation: "fade" },
					zIndex: 0,
				},
			]),
		);
		// `content` wins: that is the field the inspector's textarea writes to. Asserting the
		// other way round is what let the empty-string bug through -- `addAnnotation` seeds
		// `textContent: ""`, so a `??` chain returned that empty string and the compositor drew
		// nothing.
		expect(scene.annotations[0].text).toMatchObject({
			content: "migrated",
			color: "#ffffff",
			backgroundColor: "transparent",
			// 32 px authored against ANNOTATION_REFERENCE_HEIGHT (1080) -> fraction of the rect.
			fontSizeRel: 32 / 1080,
			textAlign: "left",
			animation: "fade",
		});
	});

	it("falls back to textContent when content is empty", () => {
		// Le cas qui casse avec `??` : `content` vaut "" (ni null ni undefined), donc seul un
		// `||` retombe sur l'autre champ.
		const scene = buildSceneDescription(
			docWithAnnotations([
				{
					id: "ann1",
					startMs: 0,
					endMs: 1000,
					type: "text",
					content: "",
					textContent: "depuis un ancien document",
					position: { x: 0, y: 0 },
					size: { width: 10, height: 10 },
					style,
					zIndex: 0,
				},
			]),
		);
		expect(scene.annotations[0].text?.content).toBe("depuis un ancien document");
	});

	it("defaults a figure's arrow data when the document omits it", () => {
		const scene = buildSceneDescription(
			docWithAnnotations([
				{
					id: "ann1",
					startMs: 0,
					endMs: 1000,
					type: "figure",
					content: "",
					position: { x: 10, y: 10 },
					size: { width: 20, height: 20 },
					style,
					zIndex: 0,
				},
			]),
		);
		expect(scene.annotations[0].figure).toEqual({
			direction: "right",
			color: "#34B27B",
			strokeWidth: 4,
		});
		expect(scene.annotations[0].text).toBeUndefined();
	});

	it("normalises freehand blur points into the same space as the rect", () => {
		const scene = buildSceneDescription(
			docWithAnnotations([
				{
					id: "ann1",
					startMs: 0,
					endMs: 1000,
					type: "blur",
					content: "",
					position: { x: 0, y: 0 },
					size: { width: 50, height: 50 },
					style,
					zIndex: 0,
					blurData: {
						type: "mosaic",
						shape: "freehand",
						color: "black",
						intensity: 8,
						blockSize: 16,
						freehandPoints: [
							{ x: 10, y: 20 },
							{ x: 30, y: 40 },
						],
					},
				},
			]),
		);
		expect(scene.annotations[0].blur).toMatchObject({
			style: "mosaic",
			shape: "freehand",
			color: "black",
			intensity: 8,
			blockSize: 16,
			freehandPoints: [
				{ x: 0.1, y: 0.2 },
				{ x: 0.3, y: 0.4 },
			],
		});
	});

	it("emits ascending zIndex so the compositor can paint without sorting per frame", () => {
		const at = (id: string, zIndex: number) => ({
			id,
			startMs: 0,
			endMs: 1000,
			type: "text" as const,
			content: "",
			textContent: id,
			position: { x: 0, y: 0 },
			size: { width: 10, height: 10 },
			style,
			zIndex,
		});
		const scene = buildSceneDescription(docWithAnnotations([at("top", 5), at("bottom", 1)]));
		expect(scene.annotations.map((a) => a.id)).toEqual(["bottom", "top"]);
	});

	it("is empty when the document has no annotations", () => {
		const scene = buildSceneDescription(docWithAnnotations([]));
		expect(scene.annotations).toEqual([]);
	});
});

// --- captions --------------------------------------------------------------

describe("buildSceneDescription.captions", () => {
	function docWithCaptions(enabled: boolean) {
		const doc = makeDoc({
			assets: [makeAsset({ id: "a1", originalPath: "/tmp/a1.mp4", durationSec: 30 })],
			clips: [
				makeClip({
					id: "c1",
					assetId: "a1",
					sourceStartSec: 0,
					sourceEndSec: 30,
					timelineStartSec: 0,
					timelineEndSec: 30,
				}),
			],
			annotations: [],
		});
		return {
			...doc,
			transcripts: [
				{
					assetId: "a1",
					language: "en",
					segments: [
						{
							id: "seg_1",
							kind: "speech" as const,
							startSec: 1,
							endSec: 3,
							text: "hello there friend",
							wordIds: ["w1", "w2", "w3"],
						},
					],
					words: [
						{ id: "w1", segmentId: "seg_1", startSec: 1, endSec: 1.6, text: "hello" },
						{ id: "w2", segmentId: "seg_1", startSec: 1.6, endSec: 2.3, text: "there" },
						{ id: "w3", segmentId: "seg_1", startSec: 2.3, endSec: 3, text: "friend" },
					],
				},
			],
			legacyEditor: {
				...((doc.legacyEditor as Record<string, unknown> | null) ?? {}),
				captions: { enabled, fontSize: 48, minWordsPerLine: 2, maxWordsPerLine: 7 },
			},
		} as AxcutDocument;
	}

	it("sends captions to the compositor as text annotations", () => {
		// Without this the caption would show in the DOM overlay and be missing from the
		// composited pixels — the preview/render gap the annotation bridge exists to close.
		const scene = buildSceneDescription(docWithCaptions(true));
		expect(scene.annotations).toHaveLength(1);
		expect(scene.annotations[0]).toMatchObject({ kind: "text" });
		expect(scene.annotations[0].text?.content).toBe("hello there friend");
	});

	it("sends nothing while the caption layer is hidden", () => {
		expect(buildSceneDescription(docWithCaptions(false)).annotations).toHaveLength(0);
	});

	it("marks captions as frame-space so the compositor stops measuring the footage", () => {
		const scene = buildSceneDescription(docWithCaptions(true));
		expect(scene.annotations[0].space).toBe("frame");
	});

	it("holds the caption still while padding shrinks the screen rect", () => {
		// Issue #396. Padding pulls `screenRect` in; a subtitle belongs to the frame the
		// viewer sees, so its rect must not follow. Three points, because two could agree
		// by coincidence — `paddingFit` is 1 - padding/100 * 0.4, so 1.0 / 0.8 / 0.6.
		const rects = [0, 50, 100].map((padding) => {
			const base = docWithCaptions(true);
			const scene = buildSceneDescription({
				...base,
				legacyEditor: { ...(base.legacyEditor as Record<string, unknown>), padding },
			} as AxcutDocument);
			const caption = scene.annotations[0];
			return {
				screenWidth: scene.layout.screenRect?.width,
				caption: { x: caption.x, y: caption.y, w: caption.w, h: caption.h },
				fontSizeRel: caption.text?.fontSizeRel,
			};
		});

		// The screen rect really does move — otherwise this test proves nothing.
		expect(new Set(rects.map((r) => r.screenWidth)).size).toBe(3);
		// ...and the caption does not, in position or in size.
		expect(rects[1].caption).toEqual(rects[0].caption);
		expect(rects[2].caption).toEqual(rects[0].caption);
		// The font denominator has to follow the rect, or the caption holds still and
		// still shrinks its text with the padding slider.
		expect(rects[1].fontSizeRel).toBe(rects[0].fontSizeRel);
		expect(rects[2].fontSizeRel).toBe(rects[0].fontSizeRel);
	});

	it("leaves the space key off a real annotation entirely", () => {
		// Not `space: undefined` — an explicit key would change the annotation payload that
		// shipped binaries already parse. `in` is the only check that tells them apart.
		const doc = makeDoc({
			annotations: [
				{
					id: "ann1",
					startMs: 0,
					endMs: 1000,
					type: "text",
					content: "hi",
					position: { x: 10, y: 10 },
					size: { width: 20, height: 10 },
					style: {
						color: "#fff",
						backgroundColor: "transparent",
						fontSize: 48,
						fontFamily: "Inter",
						fontWeight: "normal",
						fontStyle: "normal",
						textDecoration: "none",
						textAlign: "center",
						textAnimation: "none",
					},
					zIndex: 1,
				},
			],
		});
		const annotation = buildSceneDescription(doc).annotations[0];
		expect(annotation).toBeDefined();
		expect("space" in annotation).toBe(false);
	});

	it("carries the caption font size as a fraction, like every annotation", () => {
		const scene = buildSceneDescription(docWithCaptions(true));
		// 48px authored against a 1080-high frame.
		expect(scene.annotations[0].text?.fontSizeRel).toBeCloseTo(48 / 1080, 6);
	});

	// Issue #178 — captions rendered as text without the background plate, because the JS
	// bridge ships `rgba(...)` (CSS string from `captionBackgroundCss`) and the native side's
	// colour parser only understood hex. The plate disappeared, the user saw floating white
	// text, and reported "no captions in the export". This test pins the JS contract so a
	// future rewrite of either side can't silently drop the alpha again.
	it("ships the caption background as a parseable CSS colour, not a hex", () => {
		const scene = buildSceneDescription(docWithCaptions(true));
		const text = scene.annotations[0].text;
		expect(text?.backgroundColor).toBe("rgba(0, 0, 0, 0.55)");
		// The text colour is independently chosen via ColorField (hex); the background is the
		// only piece that goes through the opacity-combining path.
		expect(text?.color).toBe("#ffffff");
	});
});
