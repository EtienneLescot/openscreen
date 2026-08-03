import { describe, expect, it } from "vitest";
import {
	calculateEffectiveSourceDimensions,
	calculateMp4ExportSettings,
	wouldUpscale,
} from "./mp4ExportSettings";

describe("calculateMp4ExportSettings", () => {
	it("keeps 1080p explicit even when it upscales short native captures", () => {
		const aspectRatioValue = 1920 / 1032;

		expect(
			calculateMp4ExportSettings({
				quality: "good",
				sourceWidth: 1920,
				sourceHeight: 1032,
				aspectRatioValue,
			}),
		).toMatchObject({
			width: 2008,
			height: 1080,
			bitrate: 30_000_000,
		});

		expect(
			calculateMp4ExportSettings({
				quality: "source",
				sourceWidth: 1920,
				sourceHeight: 1032,
				aspectRatioValue,
			}),
		).toMatchObject({
			width: 1920,
			height: 1032,
			bitrate: 30_000_000,
		});
	});

	it("keeps lower quality presets below the source size when downscaling is useful", () => {
		expect(
			calculateMp4ExportSettings({
				quality: "medium",
				sourceWidth: 1920,
				sourceHeight: 1032,
				aspectRatioValue: 1920 / 1032,
			}),
		).toMatchObject({
			width: 1338,
			height: 720,
			bitrate: 20_000_000,
		});
	});

	it("keeps 1080p explicit even for 720p source dimensions", () => {
		expect(
			calculateMp4ExportSettings({
				quality: "good",
				sourceWidth: 1280,
				sourceHeight: 720,
				aspectRatioValue: 16 / 9,
			}),
		).toMatchObject({
			width: 1920,
			height: 1080,
			bitrate: 20_000_000,
		});
	});

	it("preserves source-sized High exports when the source is already 1080p or larger", () => {
		expect(
			calculateMp4ExportSettings({
				quality: "source",
				sourceWidth: 1920,
				sourceHeight: 1080,
				aspectRatioValue: 16 / 9,
			}),
		).toMatchObject({
			width: 1920,
			height: 1080,
			bitrate: 30_000_000,
		});

		expect(
			calculateMp4ExportSettings({
				quality: "source",
				sourceWidth: 3840,
				sourceHeight: 2160,
				aspectRatioValue: 16 / 9,
			}),
		).toMatchObject({
			width: 3840,
			height: 2160,
			bitrate: 80_000_000,
		});
	});

	it("keeps portrait presets on the short side", () => {
		expect(
			calculateMp4ExportSettings({
				quality: "good",
				sourceWidth: 1080,
				sourceHeight: 1920,
				aspectRatioValue: 9 / 16,
			}),
		).toMatchObject({
			width: 1080,
			height: 1920,
			bitrate: 20_000_000,
		});
	});

	it("does not call letterbox rows an upscale (1920x1032 window capture, 16:9 project)", () => {
		const source = { width: 1920, height: 1032 };
		const tier = (quality: "medium" | "good" | "source") =>
			calculateMp4ExportSettings({
				quality,
				sourceWidth: source.width,
				sourceHeight: source.height,
				aspectRatioValue: 16 / 9,
			});

		// The reported bug: both tiers resolve to the exact same 1920x1080 frame, so they must
		// carry the same badge. The old short-side test flagged only one of them.
		expect(tier("good")).toMatchObject({ width: 1920, height: 1080 });
		expect(tier("source")).toMatchObject({ width: 1920, height: 1080 });
		expect(wouldUpscale(tier("good"), source)).toBe(false);
		expect(wouldUpscale(tier("source"), source)).toBe(false);
		expect(wouldUpscale(tier("medium"), source)).toBe(false);
	});

	it("still flags a tier that genuinely stretches the source", () => {
		const source = { width: 1280, height: 720 };
		expect(
			wouldUpscale(
				calculateMp4ExportSettings({
					quality: "good",
					sourceWidth: source.width,
					sourceHeight: source.height,
					aspectRatioValue: 16 / 9,
				}),
				source,
			),
		).toBe(true);
	});

	it("uses the cropped area as the effective source size", () => {
		const effectiveSource = calculateEffectiveSourceDimensions(3840, 2160, {
			width: 854 / 3840,
			height: 480 / 2160,
		});

		expect(effectiveSource).toEqual({
			width: 854,
			height: 480,
		});

		expect(
			calculateMp4ExportSettings({
				quality: "source",
				sourceWidth: effectiveSource.width,
				sourceHeight: effectiveSource.height,
				aspectRatioValue: effectiveSource.width / effectiveSource.height,
			}),
		).toMatchObject({
			width: 854,
			height: 480,
			bitrate: 30_000_000,
		});

		expect(
			calculateMp4ExportSettings({
				quality: "good",
				sourceWidth: effectiveSource.width,
				sourceHeight: effectiveSource.height,
				aspectRatioValue: effectiveSource.width / effectiveSource.height,
			}),
		).toMatchObject({
			width: 1920,
			height: 1080,
			bitrate: 20_000_000,
		});
	});
});
