import { describe, expect, it } from "vitest";
import type { AnnotationRegion, SpeedRegion, ZoomRegion } from "@/components/video-editor/types";
import { calculateMp4ExportSettings } from "@/lib/exporter/mp4ExportSettings";
import type { CursorRecordingData, CursorRecordingSample } from "@/native/contracts";
import type { AxcutAsset, AxcutClip, AxcutTrimRange } from "../schema";
import { buildRenderPlan, isIdentityFastPathEligible } from "./renderPlan";

// --- Factory helpers (lean: only fields the builder reads) --------------------

function asset(p: Partial<AxcutAsset> & Pick<AxcutAsset, "id">): AxcutAsset {
	return {
		kind: "video",
		label: "Asset",
		originalPath: "/tmp/asset.mp4",
		cameraTrack: null,
		...p,
	};
}

function clip(p: Partial<AxcutClip> & Pick<AxcutClip, "id">): AxcutClip {
	return {
		assetId: "a",
		sourceStartSec: 0,
		sourceEndSec: 10,
		timelineStartSec: 0,
		timelineEndSec: 10,
		wordRefs: [],
		origin: "user",
		reason: "",
		...p,
	};
}

function trim(p: Partial<AxcutTrimRange> & Pick<AxcutTrimRange, "id">): AxcutTrimRange {
	return { assetId: "a", startSec: 0, endSec: 1, origin: "user", reason: "", ...p };
}

function zoom(p: Partial<ZoomRegion> & Pick<ZoomRegion, "id">): ZoomRegion {
	return {
		startMs: 0,
		endMs: 1000,
		depth: 2,
		focus: { cx: 0.5, cy: 0.5 },
		...p,
	};
}

function annotation(p: Partial<AnnotationRegion> & Pick<AnnotationRegion, "id">): AnnotationRegion {
	return {
		startMs: 0,
		endMs: 1000,
		type: "text",
		content: "hi",
		position: { x: 50, y: 50 },
		size: { width: 30, height: 20 },
		style: {
			color: "#fff",
			backgroundColor: "transparent",
			fontSize: 32,
			fontFamily: "Inter",
			fontWeight: "bold",
			fontStyle: "normal",
			textDecoration: "none",
			textAlign: "center",
		},
		zIndex: 1,
		...p,
	};
}

function speed(p: Partial<SpeedRegion> & Pick<SpeedRegion, "id">): SpeedRegion {
	return { startMs: 0, endMs: 1000, speed: 1, ...p };
}

function cursorSample(
	p: Partial<CursorRecordingSample> & Pick<CursorRecordingSample, "timeMs">,
): CursorRecordingSample {
	return { cx: 0.5, cy: 0.5, ...p };
}

function cursorRecording(p: Partial<CursorRecordingData> = {}): CursorRecordingData {
	return { version: 1, provider: "native", samples: [], assets: [], ...p };
}

// Minimal valid document for the builder — the builder only reads project,
// assets, timeline.{clips, trimRanges}, zoomRanges, annotations, legacyEditor.
//
// ponytail: `zoomRegions` (with `s`) is the spec-facing key on RenderPlan and
// what tests pass in; `zoomRanges` (without) is the schema field on the
// document we feed the builder. Keep both names straight.
function doc(
	p: Partial<{
		assets: AxcutAsset[];
		clips: AxcutClip[];
		trimRanges: AxcutTrimRange[];
		zoomRegions: ZoomRegion[];
		annotations: AnnotationRegion[];
		legacyEditor: Record<string, unknown> | null;
		primaryAssetId: string;
	}> = {},
) {
	return {
		project: { primaryAssetId: p.primaryAssetId },
		assets: p.assets ?? [],
		timeline: {
			clips: p.clips ?? [],
			trimRanges: p.trimRanges ?? [],
		},
		zoomRanges: p.zoomRegions ?? [],
		annotations: p.annotations ?? [],
		legacyEditor: p.legacyEditor ?? null,
	};
}

// --- buildRenderPlan: segments ------------------------------------------------

describe("buildRenderPlan — segments", () => {
	it("single asset, identity: one segment with the expected fields and identity fast path", () => {
		const assets = [
			asset({
				id: "a",
				originalPath: "/tmp/a.mp4",
				durationSec: 30,
				video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
			}),
		];
		const clips = [clip({ id: "c1", assetId: "a", sourceStartSec: 0, sourceEndSec: 10 })];
		const plan = buildRenderPlan(doc({ assets, clips }), { quality: "source" });

		expect(plan.segments).toHaveLength(1);
		expect(plan.segments[0]).toEqual({
			clipId: "c1",
			assetId: "a",
			videoUrl: "file:///tmp/a.mp4",
			sourceStartSec: 0,
			sourceEndSec: 10,
			intraTrims: [],
			cropRegion: { x: 0, y: 0, width: 1, height: 1 },
			sourceWidth: 1920,
			sourceHeight: 1080,
			camera: null,
			cursorSamples: [],
		});
		expect(plan.cursor).toBeNull();
		// Output = source for a 1920x1080 ref at 16:9 source quality → same dims.
		expect(plan.output.width).toBe(1920);
		expect(plan.output.height).toBe(1080);
		expect(isIdentityFastPathEligible(plan)).toBe(true);
	});

	it("two clips across two assets: one segment per clip, each carrying its own videoUrl + dims", () => {
		const assets = [
			asset({
				id: "a1",
				originalPath: "/tmp/a1.mp4",
				durationSec: 30,
				video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
			}),
			asset({
				id: "a2",
				originalPath: "/tmp/a2.mp4",
				durationSec: 30,
				video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
			}),
		];
		const clips = [
			clip({
				id: "c1",
				assetId: "a1",
				sourceStartSec: 0,
				sourceEndSec: 5,
				timelineStartSec: 0,
				timelineEndSec: 5,
			}),
			clip({
				id: "c2",
				assetId: "a2",
				sourceStartSec: 5,
				sourceEndSec: 10,
				timelineStartSec: 5,
				timelineEndSec: 10,
			}),
		];
		const plan = buildRenderPlan(doc({ assets, clips }), { quality: "source" });

		expect(plan.segments).toHaveLength(2);
		expect(plan.segments[0]).toMatchObject({
			clipId: "c1",
			assetId: "a1",
			videoUrl: "file:///tmp/a1.mp4",
			sourceWidth: 1920,
			sourceHeight: 1080,
		});
		expect(plan.segments[1]).toMatchObject({
			clipId: "c2",
			assetId: "a2",
			videoUrl: "file:///tmp/a2.mp4",
			sourceWidth: 1920,
			sourceHeight: 1080,
		});
		expect(isIdentityFastPathEligible(plan)).toBe(false);
	});

	it("sorts segments by timelineStartSec regardless of input order", () => {
		const assets = [
			asset({
				id: "a1",
				originalPath: "/tmp/a1.mp4",
				durationSec: 30,
				video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
			}),
			asset({
				id: "a2",
				originalPath: "/tmp/a2.mp4",
				durationSec: 30,
				video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
			}),
		];
		// Inserted in reverse timeline order — builder must reorder by timelineStartSec.
		const clips = [
			clip({
				id: "c2",
				assetId: "a2",
				sourceStartSec: 5,
				sourceEndSec: 10,
				timelineStartSec: 5,
				timelineEndSec: 10,
			}),
			clip({
				id: "c1",
				assetId: "a1",
				sourceStartSec: 0,
				sourceEndSec: 5,
				timelineStartSec: 0,
				timelineEndSec: 5,
			}),
		];
		const plan = buildRenderPlan(doc({ assets, clips }), { quality: "source" });
		expect(plan.segments.map((s) => s.clipId)).toEqual(["c1", "c2"]);
	});

	it("falls back to asset.durationSec when clip.sourceEndSec is undefined", () => {
		const assets = [
			asset({
				id: "a",
				originalPath: "/tmp/a.mp4",
				durationSec: 42,
				video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
			}),
		];
		const clips = [clip({ id: "c1", assetId: "a", sourceStartSec: 5, sourceEndSec: undefined })];
		const plan = buildRenderPlan(doc({ assets, clips }), { quality: "source" });
		expect(plan.segments[0].sourceEndSec).toBe(42);
	});

	it("skips clips whose asset is missing (no throw, no segment)", () => {
		const assets = [
			asset({
				id: "a",
				originalPath: "/tmp/a.mp4",
				durationSec: 30,
				video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
			}),
		];
		const clips = [
			clip({ id: "c1", assetId: "a", sourceStartSec: 0, sourceEndSec: 5 }),
			clip({ id: "c2", assetId: "ghost", sourceStartSec: 5, sourceEndSec: 10 }),
		];
		const plan = buildRenderPlan(doc({ assets, clips }), { quality: "source" });
		expect(plan.segments.map((s) => s.clipId)).toEqual(["c1"]);
	});
});

// --- buildRenderPlan: intraTrims (per-segment scoping + clamping) -------------

describe("buildRenderPlan — intraTrims", () => {
	const assets = [
		asset({
			id: "a",
			originalPath: "/tmp/a.mp4",
			durationSec: 30,
			video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
		}),
		asset({
			id: "b",
			originalPath: "/tmp/b.mp4",
			durationSec: 30,
			video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
		}),
	];

	it("scopes intraTrims by assetId: trims on a different asset are dropped", () => {
		const clips = [clip({ id: "c1", assetId: "a", sourceStartSec: 0, sourceEndSec: 20 })];
		const trimRanges = [
			trim({ id: "t1", assetId: "a", startSec: 5, endSec: 8 }),
			trim({ id: "t2", assetId: "b", startSec: 5, endSec: 8 }), // different asset → ignored
		];
		const plan = buildRenderPlan(doc({ assets, clips, trimRanges }), { quality: "source" });
		expect(plan.segments[0].intraTrims).toEqual([{ startSec: 5, endSec: 8 }]);
	});

	it("clamps a partly-outside trim to the clip's [start, end) window", () => {
		const clips = [clip({ id: "c1", assetId: "a", sourceStartSec: 10, sourceEndSec: 20 })];
		const trimRanges = [trim({ id: "t1", assetId: "a", startSec: 5, endSec: 15 })];
		const plan = buildRenderPlan(doc({ assets, clips, trimRanges }), { quality: "source" });
		expect(plan.segments[0].intraTrims).toEqual([{ startSec: 10, endSec: 15 }]);
	});

	it("drops a trim that is fully outside the clip's source range", () => {
		const clips = [clip({ id: "c1", assetId: "a", sourceStartSec: 10, sourceEndSec: 20 })];
		const trimRanges = [trim({ id: "t1", assetId: "a", startSec: 0, endSec: 5 })];
		const plan = buildRenderPlan(doc({ assets, clips, trimRanges }), { quality: "source" });
		expect(plan.segments[0].intraTrims).toEqual([]);
	});
});

// --- buildRenderPlan: crop & camera -------------------------------------------

describe("buildRenderPlan — crop & camera", () => {
	it("carries an explicit clip.cropRegion through verbatim", () => {
		const assets = [
			asset({
				id: "a",
				originalPath: "/tmp/a.mp4",
				durationSec: 30,
				video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
			}),
		];
		const crop = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
		const clips = [
			clip({ id: "c1", assetId: "a", sourceStartSec: 0, sourceEndSec: 10, cropRegion: crop }),
		];
		const plan = buildRenderPlan(doc({ assets, clips }), { quality: "source" });
		expect(plan.segments[0].cropRegion).toEqual(crop);
	});

	it("defaults to the identity crop when the clip has none", () => {
		const assets = [
			asset({
				id: "a",
				originalPath: "/tmp/a.mp4",
				durationSec: 30,
				video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
			}),
		];
		const clips = [clip({ id: "c1", assetId: "a", sourceStartSec: 0, sourceEndSec: 10 })];
		const plan = buildRenderPlan(doc({ assets, clips }), { quality: "source" });
		expect(plan.segments[0].cropRegion).toEqual({ x: 0, y: 0, width: 1, height: 1 });
	});

	it("attaches a camera entry when the asset's cameraTrack is visible + has a sourcePath", () => {
		const assets = [
			asset({
				id: "a",
				originalPath: "/tmp/a.mp4",
				durationSec: 30,
				video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
				cameraTrack: {
					sourcePath: "/tmp/a-cam.mp4",
					startMs: 0,
					offsetMs: 250,
					visible: true,
				},
			}),
		];
		const clips = [clip({ id: "c1", assetId: "a", sourceStartSec: 0, sourceEndSec: 10 })];
		const plan = buildRenderPlan(doc({ assets, clips }), { quality: "source" });
		expect(plan.segments[0].camera).toEqual({
			videoUrl: "file:///tmp/a-cam.mp4",
			offsetMs: 250,
		});
	});

	it("omits camera when cameraTrack is invisible", () => {
		const assets = [
			asset({
				id: "a",
				originalPath: "/tmp/a.mp4",
				durationSec: 30,
				video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
				cameraTrack: {
					sourcePath: "/tmp/a-cam.mp4",
					startMs: 0,
					offsetMs: 0,
					visible: false,
				},
			}),
		];
		const clips = [clip({ id: "c1", assetId: "a", sourceStartSec: 0, sourceEndSec: 10 })];
		const plan = buildRenderPlan(doc({ assets, clips }), { quality: "source" });
		expect(plan.segments[0].camera).toBeNull();
	});

	it("omits camera when cameraTrack is null", () => {
		const assets = [
			asset({
				id: "a",
				originalPath: "/tmp/a.mp4",
				durationSec: 30,
				video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
				cameraTrack: null,
			}),
		];
		const clips = [clip({ id: "c1", assetId: "a", sourceStartSec: 0, sourceEndSec: 10 })];
		const plan = buildRenderPlan(doc({ assets, clips }), { quality: "source" });
		expect(plan.segments[0].camera).toBeNull();
	});
});

// --- buildRenderPlan: output sizing -------------------------------------------

describe("buildRenderPlan — output sizing", () => {
	it("sizes output from the largest-by-pixel-area segment and matches calculateMp4ExportSettings", () => {
		const assets = [
			asset({
				id: "a1",
				originalPath: "/tmp/a1.mp4",
				durationSec: 30,
				video: { codec: "h264", width: 1280, height: 720, fps: 30 },
			}),
			asset({
				id: "a2",
				originalPath: "/tmp/a2.mp4",
				durationSec: 30,
				video: { codec: "h264", width: 3840, height: 2160, fps: 30 },
			}),
		];
		const clips = [
			clip({
				id: "c1",
				assetId: "a1",
				sourceStartSec: 0,
				sourceEndSec: 5,
				timelineStartSec: 0,
				timelineEndSec: 5,
			}),
			clip({
				id: "c2",
				assetId: "a2",
				sourceStartSec: 5,
				sourceEndSec: 10,
				timelineStartSec: 5,
				timelineEndSec: 10,
			}),
		];
		const plan = buildRenderPlan(doc({ assets, clips, legacyEditor: { aspectRatio: "16:9" } }), {
			quality: "source",
		});
		const expected = calculateMp4ExportSettings({
			quality: "source",
			sourceWidth: 3840,
			sourceHeight: 2160,
			aspectRatioValue: 16 / 9,
		});
		expect(plan.output.width).toBe(expected.width);
		expect(plan.output.height).toBe(expected.height);
		expect(plan.output.bitrate).toBe(expected.bitrate);
		expect(plan.aspectRatioValue).toBeCloseTo(16 / 9, 6);
	});

	it("falls back to the option-provided fallback dims when there are no segments", () => {
		const plan = buildRenderPlan(doc({ assets: [], clips: [] }), {
			quality: "source",
			fallbackSourceWidth: 640,
			fallbackSourceHeight: 480,
		});
		const expected = calculateMp4ExportSettings({
			quality: "source",
			sourceWidth: 640,
			sourceHeight: 480,
			aspectRatioValue: 16 / 9,
		});
		expect(plan.output.width).toBe(expected.width);
		expect(plan.output.height).toBe(expected.height);
	});

	it("honors frameRate + codec options", () => {
		const assets = [
			asset({
				id: "a",
				originalPath: "/tmp/a.mp4",
				durationSec: 30,
				video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
			}),
		];
		const clips = [clip({ id: "c1", assetId: "a", sourceStartSec: 0, sourceEndSec: 10 })];
		const plan = buildRenderPlan(doc({ assets, clips }), {
			quality: "source",
			frameRate: 30,
			codec: "h265",
		});
		expect(plan.output.frameRate).toBe(30);
		expect(plan.output.codec).toBe("hvc1.1.6.L120.90");
	});
});

// --- buildRenderPlan: effects pass-through (VIRTUAL time, NO projection) ------

describe("buildRenderPlan — effects pass-through", () => {
	const baseAssets = [
		asset({
			id: "a",
			originalPath: "/tmp/a.mp4",
			durationSec: 30,
			video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
		}),
	];
	const baseClips = [clip({ id: "c1", assetId: "a", sourceStartSec: 0, sourceEndSec: 10 })];

	it("carries zoomRanges verbatim (same ids + startMs + endMs) — no projection", () => {
		const zoomRegions = [
			zoom({ id: "z1", startMs: 500, endMs: 2500, depth: 3 }),
			zoom({ id: "z2", startMs: 4000, endMs: 6000, depth: 4 }),
		];
		const plan = buildRenderPlan(doc({ assets: baseAssets, clips: baseClips, zoomRegions }), {
			quality: "source",
		});
		expect(plan.zoomRegions).toEqual(zoomRegions);
	});

	it("carries annotations verbatim (same ids + startMs + endMs) — no projection", () => {
		const annotations = [
			annotation({ id: "a1", startMs: 1000, endMs: 3000 }),
			annotation({ id: "a2", startMs: 3500, endMs: 5500 }),
		];
		const plan = buildRenderPlan(doc({ assets: baseAssets, clips: baseClips, annotations }), {
			quality: "source",
		});
		expect(plan.annotationRegions).toEqual(annotations);
	});

	it("carries speedRegions verbatim (same ids + startMs + endMs + speed) — no projection", () => {
		const speedRegions = [
			speed({ id: "s1", startMs: 1500, endMs: 2500, speed: 2 }),
			speed({ id: "s2", startMs: 4000, endMs: 5000, speed: 0.5 }),
		];
		const plan = buildRenderPlan(
			doc({
				assets: baseAssets,
				clips: baseClips,
				legacyEditor: { speedRegions },
			}),
			{ quality: "source" },
		);
		expect(plan.speedRegions).toEqual(speedRegions);
	});

	it("defaults speedRegions to [] when legacyEditor is null and skips speedRegions absent", () => {
		const plan = buildRenderPlan(doc({ assets: baseAssets, clips: baseClips }), {
			quality: "source",
		});
		expect(plan.speedRegions).toEqual([]);
	});

	it("reads appearance defaults from legacyEditor with the documented fallbacks", () => {
		const plan = buildRenderPlan(doc({ assets: baseAssets, clips: baseClips }), {
			quality: "source",
		});
		expect(plan.appearance).toEqual({
			wallpaper: "",
			padding: 50,
			borderRadius: 0,
			shadowIntensity: 0,
			showBlur: false,
			motionBlurAmount: 0,
		});
	});
});

// --- buildRenderPlan: cursor (per-segment, decision D1) ----------------------

describe("buildRenderPlan — cursor", () => {
	const twoAssets = [
		asset({
			id: "a1",
			originalPath: "/tmp/a1.mp4",
			durationSec: 30,
			video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
		}),
		asset({
			id: "a2",
			originalPath: "/tmp/a2.mp4",
			durationSec: 30,
			video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
		}),
	];
	const twoClips = [
		clip({
			id: "c1",
			assetId: "a1",
			sourceStartSec: 0,
			sourceEndSec: 5,
			timelineStartSec: 0,
			timelineEndSec: 5,
		}),
		clip({
			id: "c2",
			assetId: "a2",
			sourceStartSec: 5,
			sourceEndSec: 10,
			timelineStartSec: 5,
			timelineEndSec: 10,
		}),
	];

	it("partitions samples per segment by assetId — each segment gets only its asset's samples", () => {
		const recordingData = cursorRecording({
			samples: [
				cursorSample({ timeMs: 100, assetId: "a1" }),
				cursorSample({ timeMs: 200, assetId: "a2" }),
				cursorSample({ timeMs: 300, assetId: "a1" }),
			],
		});
		const plan = buildRenderPlan(doc({ assets: twoAssets, clips: twoClips }), {
			quality: "source",
			cursor: { recordingData, scale: 1 },
		});
		expect(plan.segments[0].cursorSamples.map((s) => s.timeMs)).toEqual([100, 300]);
		expect(plan.segments[1].cursorSamples.map((s) => s.timeMs)).toEqual([200]);
	});

	it("attributes untagged samples (no assetId) to the primary asset", () => {
		const recordingData = cursorRecording({
			samples: [cursorSample({ timeMs: 100 }), cursorSample({ timeMs: 200, assetId: "a2" })],
		});
		const plan = buildRenderPlan(
			doc({ assets: twoAssets, clips: twoClips, primaryAssetId: "a1" }),
			{ quality: "source", cursor: { recordingData, scale: 1 } },
		);
		expect(plan.segments[0].cursorSamples.map((s) => s.timeMs)).toEqual([100]);
		expect(plan.segments[1].cursorSamples.map((s) => s.timeMs)).toEqual([200]);
	});

	it("falls back to the first asset for untagged samples when primaryAssetId is unset", () => {
		const recordingData = cursorRecording({ samples: [cursorSample({ timeMs: 100 })] });
		const plan = buildRenderPlan(doc({ assets: twoAssets, clips: twoClips }), {
			quality: "source",
			cursor: { recordingData, scale: 1 },
		});
		expect(plan.segments[0].cursorSamples.map((s) => s.timeMs)).toEqual([100]);
		expect(plan.segments[1].cursorSamples).toEqual([]);
	});

	it("gives a segment whose asset has no cursor data an empty samples array (no overlay)", () => {
		const recordingData = cursorRecording({
			samples: [cursorSample({ timeMs: 100, assetId: "a1" })],
		});
		const plan = buildRenderPlan(doc({ assets: twoAssets, clips: twoClips }), {
			quality: "source",
			cursor: { recordingData, scale: 1 },
		});
		expect(plan.segments[1].cursorSamples).toEqual([]);
	});

	it("builds plan.cursor (shared atlas + style) when scale > 0 and a recording is present", () => {
		const spriteAsset = {
			id: "cur1",
			platform: "windows",
			imageDataUrl: "data:,",
			width: 16,
			height: 16,
			hotspotX: 0,
			hotspotY: 0,
		} as CursorRecordingData["assets"][number];
		const recordingData = cursorRecording({
			version: 2,
			provider: "native",
			assets: [spriteAsset],
			samples: [cursorSample({ timeMs: 0, assetId: "a1" })],
		});
		const plan = buildRenderPlan(doc({ assets: twoAssets, clips: twoClips }), {
			quality: "source",
			cursor: {
				recordingData,
				scale: 1.5,
				smoothing: 0.3,
				motionBlur: 0.2,
				clickBounce: 0.5,
				clipToBounds: true,
				theme: "dark",
			},
		});
		expect(plan.cursor).toEqual({
			version: 2,
			provider: "native",
			assets: [spriteAsset],
			scale: 1.5,
			smoothing: 0.3,
			motionBlur: 0.2,
			clickBounce: 0.5,
			clipToBounds: true,
			theme: "dark",
		});
	});

	it("leaves plan.cursor null and carries no samples when scale is 0 (cursor disabled)", () => {
		const recordingData = cursorRecording({
			samples: [cursorSample({ timeMs: 0, assetId: "a1" })],
		});
		const plan = buildRenderPlan(doc({ assets: twoAssets, clips: twoClips }), {
			quality: "source",
			cursor: { recordingData, scale: 0 },
		});
		expect(plan.cursor).toBeNull();
		expect(plan.segments.every((s) => s.cursorSamples.length === 0)).toBe(true);
	});

	it("leaves plan.cursor null when no recording is supplied", () => {
		const plan = buildRenderPlan(doc({ assets: twoAssets, clips: twoClips }), {
			quality: "source",
			cursor: { scale: 1 },
		});
		expect(plan.cursor).toBeNull();
		expect(plan.segments.every((s) => s.cursorSamples.length === 0)).toBe(true);
	});
});

// --- isIdentityFastPathEligible -----------------------------------------------

describe("isIdentityFastPathEligible", () => {
	function singleUntouchedAsset() {
		return asset({
			id: "a",
			originalPath: "/tmp/a.mp4",
			durationSec: 30,
			video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
		});
	}
	function singleClipOn(assetId: string) {
		return clip({ id: "c1", assetId, sourceStartSec: 0, sourceEndSec: 10 });
	}

	it("returns true for an untouched single clip whose output matches source dims", () => {
		const assets = [singleUntouchedAsset()];
		const clips = [singleClipOn("a")];
		const plan = buildRenderPlan(doc({ assets, clips }), { quality: "source" });
		expect(isIdentityFastPathEligible(plan)).toBe(true);
	});

	it("returns false when there are 2+ segments", () => {
		const assets = [
			singleUntouchedAsset(),
			asset({
				id: "a2",
				originalPath: "/tmp/a2.mp4",
				durationSec: 30,
				video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
			}),
		];
		const clips = [
			clip({
				id: "c1",
				assetId: "a",
				sourceStartSec: 0,
				sourceEndSec: 5,
				timelineStartSec: 0,
				timelineEndSec: 5,
			}),
			clip({
				id: "c2",
				assetId: "a2",
				sourceStartSec: 0,
				sourceEndSec: 5,
				timelineStartSec: 5,
				timelineEndSec: 10,
			}),
		];
		const plan = buildRenderPlan(doc({ assets, clips }), { quality: "source" });
		expect(isIdentityFastPathEligible(plan)).toBe(false);
	});

	it("returns false when the single segment has intraTrims", () => {
		const assets = [singleUntouchedAsset()];
		const clips = [singleClipOn("a")];
		const trimRanges = [trim({ id: "t1", assetId: "a", startSec: 3, endSec: 5 })];
		const plan = buildRenderPlan(doc({ assets, clips, trimRanges }), { quality: "source" });
		expect(isIdentityFastPathEligible(plan)).toBe(false);
	});

	it("returns false when the single segment has a non-identity crop", () => {
		const assets = [singleUntouchedAsset()];
		const clips = [
			clip({
				id: "c1",
				assetId: "a",
				sourceStartSec: 0,
				sourceEndSec: 10,
				cropRegion: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
			}),
		];
		const plan = buildRenderPlan(doc({ assets, clips }), { quality: "source" });
		expect(isIdentityFastPathEligible(plan)).toBe(false);
	});

	it("returns false when any active (non-zero-length, non-1x) speedRegion is present", () => {
		const assets = [singleUntouchedAsset()];
		const clips = [singleClipOn("a")];
		const plan = buildRenderPlan(
			doc({
				assets,
				clips,
				legacyEditor: { speedRegions: [speed({ id: "s1", startMs: 1000, endMs: 3000, speed: 2 })] },
			}),
			{ quality: "source" },
		);
		expect(isIdentityFastPathEligible(plan)).toBe(false);
	});

	it("treats a 1x speedRegion of any length as inactive", () => {
		const assets = [singleUntouchedAsset()];
		const clips = [singleClipOn("a")];
		const plan = buildRenderPlan(
			doc({
				assets,
				clips,
				legacyEditor: {
					speedRegions: [
						speed({ id: "s1", startMs: 1000, endMs: 3000, speed: 1 }),
						speed({ id: "s2", startMs: 0, endMs: 0, speed: 2 }), // zero-length → inactive
					],
				},
			}),
			{ quality: "source" },
		);
		expect(isIdentityFastPathEligible(plan)).toBe(true);
	});

	it("returns false when a zoomRegion is present", () => {
		const assets = [singleUntouchedAsset()];
		const clips = [singleClipOn("a")];
		const plan = buildRenderPlan(doc({ assets, clips, zoomRegions: [zoom({ id: "z1" })] }), {
			quality: "source",
		});
		expect(isIdentityFastPathEligible(plan)).toBe(false);
	});

	it("returns false when an annotationRegion is present", () => {
		const assets = [singleUntouchedAsset()];
		const clips = [singleClipOn("a")];
		const plan = buildRenderPlan(
			doc({ assets, clips, annotations: [annotation({ id: "ann1" })] }),
			{ quality: "source" },
		);
		expect(isIdentityFastPathEligible(plan)).toBe(false);
	});

	it("returns false when output dims differ from source dims", () => {
		const assets = [
			asset({
				id: "a",
				originalPath: "/tmp/a.mp4",
				durationSec: 30,
				video: { codec: "h264", width: 3840, height: 2160, fps: 30 },
			}),
		];
		const clips = [singleClipOn("a")];
		// quality: "good" → output short-side 1080 at 16:9 → 1920x1080, smaller than 3840x2160.
		const plan = buildRenderPlan(doc({ assets, clips }), { quality: "good" });
		expect(isIdentityFastPathEligible(plan)).toBe(false);
	});

	it("returns false when an active cursor overlay covers the single segment", () => {
		const assets = [singleUntouchedAsset()];
		const clips = [singleClipOn("a")];
		const recordingData = cursorRecording({
			samples: [cursorSample({ timeMs: 0, assetId: "a" })],
		});
		const plan = buildRenderPlan(doc({ assets, clips }), {
			quality: "source",
			cursor: { recordingData, scale: 1 },
		});
		expect(plan.segments[0].cursorSamples.length).toBeGreaterThan(0);
		expect(isIdentityFastPathEligible(plan)).toBe(false);
	});

	it("stays eligible when a cursor recording exists but cursor is disabled (scale 0)", () => {
		const assets = [singleUntouchedAsset()];
		const clips = [singleClipOn("a")];
		const recordingData = cursorRecording({
			samples: [cursorSample({ timeMs: 0, assetId: "a" })],
		});
		const plan = buildRenderPlan(doc({ assets, clips }), {
			quality: "source",
			cursor: { recordingData, scale: 0 },
		});
		expect(isIdentityFastPathEligible(plan)).toBe(true);
	});
});
