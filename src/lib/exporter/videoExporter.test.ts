import { describe, expect, it } from "vitest";
import { isSourceCopyFastPathEligible, type VideoExporterConfig } from "./videoExporter";

function createConfig(overrides: Partial<VideoExporterConfig> = {}): VideoExporterConfig {
	return {
		videoUrl: "recording.mp4",
		width: 1920,
		height: 1080,
		frameRate: 60,
		bitrate: 30_000_000,
		wallpaper: "#000000",
		zoomRegions: [],
		trimRegions: [],
		speedRegions: [],
		showShadow: false,
		shadowIntensity: 0,
		showBlur: false,
		cropRegion: { x: 0, y: 0, width: 1, height: 1 },
		...overrides,
	};
}

describe("isSourceCopyFastPathEligible", () => {
	it("allows a no-op MP4 export at source dimensions", () => {
		expect(
			isSourceCopyFastPathEligible(createConfig(), {
				width: 1920,
				height: 1080,
			}),
		).toBe(true);
	});

	it("rejects timeline edits and frame-level effects", () => {
		const videoInfo = { width: 1920, height: 1080 };

		expect(
			isSourceCopyFastPathEligible(
				createConfig({ trimRegions: [{ id: "trim", startMs: 100, endMs: 200 }] }),
				videoInfo,
			),
		).toBe(false);
		expect(
			isSourceCopyFastPathEligible(
				createConfig({
					speedRegions: [{ id: "speed", startMs: 100, endMs: 200, speed: 1.5 }],
				}),
				videoInfo,
			),
		).toBe(false);
		expect(
			isSourceCopyFastPathEligible(
				createConfig({
					zoomRegions: [
						{
							id: "zoom",
							startMs: 100,
							endMs: 200,
							depth: 2,
							focus: { cx: 0.5, cy: 0.5 },
						},
					],
				}),
				videoInfo,
			),
		).toBe(false);
		expect(isSourceCopyFastPathEligible(createConfig({ showBlur: true }), videoInfo)).toBe(false);
	});

	it("rejects resizing and overlays", () => {
		const videoInfo = { width: 1920, height: 1080 };

		expect(isSourceCopyFastPathEligible(createConfig({ width: 1280 }), videoInfo)).toBe(false);
		expect(
			isSourceCopyFastPathEligible(
				createConfig({
					cursorScale: 2,
					cursorRecordingData: {
						version: 2,
						provider: "native",
						assets: [
							{
								id: "cursor",
								platform: "win32",
								imageDataUrl: "data:image/png;base64,AA==",
								width: 32,
								height: 32,
								hotspotX: 0,
								hotspotY: 0,
							},
						],
						samples: [{ timeMs: 0, cx: 0.5, cy: 0.5, visible: true, assetId: "cursor" }],
					},
				}),
				videoInfo,
			),
		).toBe(false);
		expect(
			isSourceCopyFastPathEligible(
				createConfig({
					cursorHighlight: {
						enabled: true,
						style: "ring",
						sizePx: 24,
						color: "#ffffff",
						opacity: 1,
						onlyOnClicks: false,
						clickEmphasisDurationMs: 350,
						offsetXNorm: 0,
						offsetYNorm: 0,
					},
					cursorTelemetry: [{ timeMs: 0, cx: 0.5, cy: 0.5 }],
				}),
				videoInfo,
			),
		).toBe(false);
	});
});
