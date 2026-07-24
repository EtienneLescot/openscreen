import { describe, expect, it } from "vitest";
import type { AxcutAsset, AxcutClip, AxcutDocument } from "@/lib/ai-edition/schema";
import {
	ASPECT_RATIO_PRESETS,
	type AspectRatio,
	toAspectRatioToken,
} from "@/utils/aspectRatioUtils";
import {
	collectEffectiveClipDims,
	collectNativeFormats,
	pickOutputDims,
	referenceClipDims,
	resolveAspectRatioValue,
} from "./outputFormat";

function asset(id: string, width: number, height: number): AxcutAsset {
	return {
		kind: "video",
		id,
		label: id,
		originalPath: `/tmp/${id}.mp4`,
		cameraTrack: null,
		video: { width, height } as AxcutAsset["video"],
	};
}

function clip(id: string, assetId: string, cropRegion?: AxcutClip["cropRegion"]): AxcutClip {
	return {
		id,
		assetId,
		...(cropRegion ? { cropRegion } : {}),
		sourceStartSec: 0,
		sourceEndSec: 10,
		timelineStartSec: 0,
		timelineEndSec: 10,
		wordRefs: [],
		origin: "user",
		reason: "",
	};
}

function doc(assets: AxcutAsset[], clips: AxcutClip[]): AxcutDocument {
	return {
		schemaVersion: 3,
		project: {
			id: "proj_1",
			title: "Test",
			createdAt: "2026-06-26T10:00:00Z",
			updatedAt: "2026-06-26T10:00:00Z",
			primaryAssetId: assets[0]?.id ?? "asset_1",
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
		},
		annotations: [],
		zoomRanges: [],
		legacyEditor: null,
		agent: { pendingQuestions: [], suggestions: [], lastAppliedOperations: [] },
		preview: { strategy: "seek", revision: 0 },
		export: { preset: "final-balanced", lastJobId: null },
		history: { revisions: [] },
	} as AxcutDocument;
}

describe("collectNativeFormats", () => {
	it("returns one entry when every clip shares a shape — the common case stays a single choice", () => {
		const d = doc(
			[asset("a1", 1920, 1080), asset("a2", 1280, 720)],
			[clip("c1", "a1"), clip("c2", "a2")],
		);
		expect(collectNativeFormats(d)).toEqual([
			{ token: "16:9", ratio: 16 / 9, width: 1920, height: 1080, clipCount: 2 },
		]);
	});

	it("dedups by SHAPE, not pixel size — 1080p and 4K are the same 16:9 entry", () => {
		const d = doc(
			[asset("a1", 1920, 1080), asset("a2", 3840, 2160)],
			[clip("c1", "a1"), clip("c2", "a2")],
		);
		const formats = collectNativeFormats(d);
		expect(formats).toHaveLength(1);
		expect(formats[0].token).toBe("16:9");
		// Representative dims are the largest available, for the menu's size hint.
		expect(formats[0]).toMatchObject({ width: 3840, height: 2160, clipCount: 2 });
	});

	it("enumerates each distinct shape on a mixed timeline, most-used first", () => {
		const d = doc(
			[asset("a1", 1920, 1080), asset("a2", 2160, 3840)],
			[clip("c1", "a1"), clip("c2", "a1"), clip("c3", "a2")],
		);
		expect(collectNativeFormats(d).map((f) => [f.token, f.clipCount])).toEqual([
			["16:9", 2],
			["9:16", 1],
		]);
	});

	it("reduces non-preset shapes to their own token (ultrawide)", () => {
		const d = doc([asset("a1", 2560, 1080)], [clip("c1", "a1")]);
		expect(collectNativeFormats(d)[0].token).toBe("64:27");
	});

	it("ignores clips whose asset is missing or has no probed dimensions", () => {
		const d = doc([asset("a1", 0, 0)], [clip("c1", "a1"), clip("c2", "ghost")]);
		expect(collectNativeFormats(d)).toEqual([]);
	});

	it("counts clips, not assets — two cuts of one recording are one format", () => {
		const d = doc([asset("a1", 1920, 1080)], [clip("c1", "a1"), clip("c2", "a1")]);
		expect(collectNativeFormats(d)).toHaveLength(1);
		expect(collectNativeFormats(d)[0].clipCount).toBe(2);
	});

	it("only considers assets the timeline actually uses", () => {
		const d = doc([asset("a1", 1920, 1080), asset("unused", 1080, 1920)], [clip("c1", "a1")]);
		expect(collectNativeFormats(d).map((f) => f.token)).toEqual(["16:9"]);
	});

	it("a crop changes the shape — a cropped 16:9 clip is no longer a 16:9 entry", () => {
		// The reported case: both clips come from 16:9 recordings, but one is cropped, so its
		// real shape isn't 16:9 any more. Reading raw asset dims listed both under one "16:9"
		// entry and offered a shape that clip never has on screen.
		const d = doc(
			[asset("a1", 1920, 1080)],
			[clip("c1", "a1"), clip("c2", "a1", { x: 0.25, y: 0, width: 0.5, height: 1 })],
		);
		expect(collectNativeFormats(d).map((f) => [f.token, f.width, f.height])).toEqual([
			["16:9", 1920, 1080],
			["8:9", 960, 1080],
		]);
	});

	it("an identity crop is not a distinct shape — it must not split the entry", () => {
		const d = doc(
			[asset("a1", 1920, 1080)],
			[clip("c1", "a1"), clip("c2", "a1", { x: 0, y: 0, width: 1, height: 1 })],
		);
		expect(collectNativeFormats(d)).toHaveLength(1);
		expect(collectNativeFormats(d)[0].clipCount).toBe(2);
	});

	it("offers exactly the footprints the export dialog sizes from — one SSOT, not two", () => {
		// Both sides resolve crop through `clipEffectiveDims`; this pins them together so a
		// future change to one can't silently reopen the gap this test was written to close.
		const d = doc(
			[asset("a1", 1920, 1080), asset("a2", 3840, 2160)],
			[clip("c1", "a1", { x: 0, y: 0, width: 0.5, height: 1 }), clip("c2", "a2")],
		);
		const fromExportSizing = collectEffectiveClipDims(d).map((dims) =>
			toAspectRatioToken(dims.width, dims.height),
		);
		expect(
			collectNativeFormats(d)
				.map((f) => f.token)
				.sort(),
		).toEqual([...new Set(fromExportSizing)].sort());
	});
});

describe("referenceClipDims", () => {
	it("picks the largest pixel area among used clips", () => {
		const d = doc(
			[asset("a1", 1280, 720), asset("a2", 3840, 2160)],
			[clip("c1", "a1"), clip("c2", "a2")],
		);
		expect(referenceClipDims(d)).toEqual({ width: 3840, height: 2160 });
	});

	it("measures the CROPPED footprint, so a cropped 4K clip no longer sizes the output at 4K", () => {
		// The output resolution is the largest cropped footprint, not the largest raw asset. A 4K
		// clip cropped to half-width contributes 1920x2160, so it must not force a 3840 long side —
		// this is what kept the compositor rasterising at 4K while the export dialog already sized
		// off the smaller footprint.
		const d = doc(
			[asset("a1", 3840, 2160)],
			[clip("c1", "a1", { x: 0.25, y: 0, width: 0.5, height: 1 })],
		);
		expect(referenceClipDims(d)).toEqual({ width: 1920, height: 2160 });
	});

	it("falls back to any asset with dims when no used clip has probed yet", () => {
		const d = doc([asset("a1", 0, 0), asset("a2", 1280, 720)], [clip("c1", "a1")]);
		expect(referenceClipDims(d)).toEqual({ width: 1280, height: 720 });
	});

	it("falls back to 1920x1080 for a document with no dimensions at all", () => {
		expect(referenceClipDims(doc([], []))).toEqual({ width: 1920, height: 1080 });
	});
});

describe("pickOutputDims", () => {
	it("derives the short side from the chosen ratio, keeping the reference long side", () => {
		const d = doc([asset("a1", 1920, 1080)], [clip("c1", "a1")]);
		expect(pickOutputDims(d, "16:9")).toEqual({ width: 1920, height: 1080 });
		expect(pickOutputDims(d, "9:16")).toEqual({ width: 1080, height: 1920 });
		expect(pickOutputDims(d, "1:1")).toEqual({ width: 1920, height: 1920 });
	});

	it("accepts a concrete non-preset token picked from the Original section", () => {
		const d = doc([asset("a1", 2560, 1080)], [clip("c1", "a1")]);
		expect(pickOutputDims(d, "64:27")).toEqual({ width: 2560, height: 1080 });
	});

	it("never emits an odd axis — an Original token on a differently-shaped reference", () => {
		// The case enumeration makes reachable: the user picks the shape of the 1366x768 clip
		// ("683:384") while the 4K clip is the reference by pixel area. 3840/(683/384) = 2158.946,
		// which bare rounding turns into an odd 3840x2159 — a height H.264's 4:2:0 plane cannot
		// subsample. Snapping to the NEAREST even lands on 2158, not 2160.
		const mixed = doc(
			[asset("a1", 1366, 768), asset("a2", 3840, 2160)],
			[clip("c1", "a1"), clip("c2", "a2")],
		);
		expect(pickOutputDims(mixed, "683:384")).toEqual({ width: 3840, height: 2158 });
	});

	it("keeps both axes even across every preset and odd-capture token", () => {
		// Presets pass this even without the clamp (they divide a normal long side evenly), which
		// is exactly why the odd case stayed latent — so the sweep has to include odd shapes too.
		const d = doc(
			[asset("a1", 1366, 768), asset("a2", 3840, 2160)],
			[clip("c1", "a1"), clip("c2", "a2")],
		);
		const tokens: AspectRatio[] = [
			...ASPECT_RATIO_PRESETS,
			"683:384",
			"64:27",
			"1023:767",
			"native",
		];
		for (const token of tokens) {
			const out = pickOutputDims(d, token);
			expect(out.width % 2, `width for ${token}`).toBe(0);
			expect(out.height % 2, `height for ${token}`).toBe(0);
			expect(out.width).toBeGreaterThanOrEqual(2);
			expect(out.height).toBeGreaterThanOrEqual(2);
		}
	});

	it("a stored shape no longer moves when a bigger clip of another shape is added", () => {
		const before = doc([asset("a1", 1920, 1080)], [clip("c1", "a1")]);
		const after = doc(
			[asset("a1", 1920, 1080), asset("a2", 2160, 3840)],
			[clip("c1", "a1"), clip("c2", "a2")],
		);
		const shapeOf = (d: AxcutDocument) => {
			const o = pickOutputDims(d, "16:9");
			return o.width / o.height;
		};
		expect(shapeOf(after)).toBeCloseTo(shapeOf(before), 6);
		// Resolution still follows the largest clip — that policy is unchanged.
		expect(pickOutputDims(after, "16:9")).toEqual({ width: 3840, height: 2160 });
	});

	it('legacy "native" still resolves to the reference clip, drift included', () => {
		const portraitWins = doc(
			[asset("a1", 1920, 1080), asset("a2", 2160, 3840)],
			[clip("c1", "a1"), clip("c2", "a2")],
		);
		expect(pickOutputDims(portraitWins, "native")).toEqual({ width: 2160, height: 3840 });
	});

	it("sizes the output off the cropped footprint, not the raw 4K asset", () => {
		// A single 4K clip cropped to a 16:9 half-width strip: the output must rasterise at the
		// crop's real size (1920x1080), not the asset's 3840x2160. Before the reference went
		// crop-aware, every frame drew at 4K while the export dialog already showed 1920-wide.
		const cropped = doc(
			[asset("a1", 3840, 2160)],
			[clip("c1", "a1", { x: 0.25, y: 0.25, width: 0.5, height: 0.5 })],
		);
		expect(pickOutputDims(cropped, "16:9")).toEqual({ width: 1920, height: 1080 });
	});
});

describe("resolveAspectRatioValue", () => {
	it('resolves legacy "native" against the document instead of the 16/9 fallback', () => {
		const d = doc([asset("a1", 1080, 1920)], [clip("c1", "a1")]);
		expect(resolveAspectRatioValue(d, "native")).toBeCloseTo(1080 / 1920, 6);
	});

	it('falls back to 16/9 for "native" with no document (preview before load)', () => {
		expect(resolveAspectRatioValue(null, "native")).toBeCloseTo(16 / 9, 6);
	});

	it("passes concrete tokens straight through", () => {
		const d = doc([asset("a1", 1080, 1920)], [clip("c1", "a1")]);
		expect(resolveAspectRatioValue(d, "4:5")).toBeCloseTo(0.8, 6);
		expect(resolveAspectRatioValue(d, "64:27")).toBeCloseTo(64 / 27, 6);
	});
});
