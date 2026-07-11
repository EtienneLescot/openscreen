import { describe, expect, it, vi } from "vitest";
import {
	getSourceCopyFastPathBlockers,
	isSourceCopyFastPathEligible,
	resolveCropAt,
	type VideoExporterConfig,
	waitForEncoderQueueSpace,
} from "./videoExporter";

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
				frameRate: 60,
				codec: "avc1.640033",
			}),
		).toBe(true);
	});

	it("rejects a frame rate or codec that differs from the source", () => {
		const videoInfo = { width: 1920, height: 1080, frameRate: 60, codec: "avc1.640033" };

		expect(isSourceCopyFastPathEligible(createConfig({ frameRate: 30 }), videoInfo)).toBe(false);
		expect(
			isSourceCopyFastPathEligible(createConfig({ codec: "hvc1.1.6.L120.90" }), videoInfo),
		).toBe(false);
		// A container-rounded rate (59.94 vs the nominal 60) shouldn't force a
		// re-encode on its own.
		expect(isSourceCopyFastPathEligible(createConfig(), { ...videoInfo, frameRate: 59.94 })).toBe(
			true,
		);
	});

	it("rejects timeline edits and frame-level effects", () => {
		const videoInfo = { width: 1920, height: 1080, frameRate: 60, codec: "avc1.640033" };

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
		// A 100× region must also block the copy path (any non-1× speed does), so its
		// audio is re-rendered (offline time-stretch) rather than passed through untouched.
		expect(
			isSourceCopyFastPathEligible(
				createConfig({
					speedRegions: [{ id: "speed", startMs: 100, endMs: 200, speed: 100 }],
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
		const videoInfo = { width: 1920, height: 1080, frameRate: 60, codec: "avc1.640033" };

		expect(isSourceCopyFastPathEligible(createConfig({ width: 1280 }), videoInfo)).toBe(false);
		expect(
			isSourceCopyFastPathEligible(
				createConfig({
					cursorScale: 2,
				}),
				videoInfo,
			),
		).toBe(false);
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
	});
});

describe("getSourceCopyFastPathBlockers", () => {
	it("reports the source-size mismatch that blocks copy-only export", () => {
		expect(
			getSourceCopyFastPathBlockers(createConfig({ height: 1080 }), {
				width: 1920,
				height: 1032,
				frameRate: 60,
				codec: "avc1.640033",
			}),
		).toContain("output-size 1920x1080 differs from source 1920x1032");
	});

	it("blocks the fast path when any clip in the crop schedule has a non-default crop", () => {
		const videoInfo = { width: 1920, height: 1080, frameRate: 60, codec: "avc1.640033" };
		const blockers = getSourceCopyFastPathBlockers(
			createConfig({
				cropSchedule: [
					{ startSec: 0, endSec: 3, cropRegion: { x: 0, y: 0, width: 1, height: 1 } },
					{ startSec: 3, endSec: 6, cropRegion: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } },
				],
			}),
			videoInfo,
		);
		expect(blockers).toContain("crop is not default");
	});

	it("allows the fast path when every clip in the crop schedule is default", () => {
		const videoInfo = { width: 1920, height: 1080, frameRate: 60, codec: "avc1.640033" };
		const blockers = getSourceCopyFastPathBlockers(
			createConfig({
				cropSchedule: [
					{ startSec: 0, endSec: 3, cropRegion: { x: 0, y: 0, width: 1, height: 1 } },
					{ startSec: 3, endSec: 6, cropRegion: { x: 0, y: 0, width: 1, height: 1 } },
				],
			}),
			videoInfo,
		);
		expect(blockers).not.toContain("crop is not default");
	});
});

describe("resolveCropAt", () => {
	const identity = { x: 0, y: 0, width: 1, height: 1 };
	const halfCrop = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
	const schedule = [
		{ startSec: 0, endSec: 3, cropRegion: halfCrop },
		{ startSec: 3, endSec: 6, cropRegion: identity },
	];

	it("picks the schedule entry covering the given source time", () => {
		expect(resolveCropAt(schedule, 1.5, identity)).toBe(halfCrop);
		expect(resolveCropAt(schedule, 4, identity)).toBe(identity);
	});

	it("treats entry end as exclusive so back-to-back clips don't overlap", () => {
		expect(resolveCropAt(schedule, 3, identity)).toBe(identity);
	});

	it("falls back when nothing covers the timestamp or the schedule is absent", () => {
		const fallback = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
		expect(resolveCropAt(schedule, 10, fallback)).toBe(fallback);
		expect(resolveCropAt(undefined, 1.5, fallback)).toBe(fallback);
		expect(resolveCropAt([], 1.5, fallback)).toBe(fallback);
	});
});

// The original bug measured the timeout from the encoder's last *output* event
// (lastEncoderOutputAt), which went stale while the decoder discarded frames inside
// a trim region. waitForEncoderQueueSpace fixes this by starting the clock fresh on
// each call instead of accepting any such external timestamp — by construction, there
// is no "last output" state to go stale, so that regression can't be reintroduced
// without changing this function's signature.
describe("waitForEncoderQueueSpace", () => {
	function fakeClock(start = 0) {
		let elapsedMs = start;
		return {
			now: () => elapsedMs,
			sleep: async (ms: number) => {
				elapsedMs += ms;
			},
		};
	}

	it("resolves immediately when the queue already has space", async () => {
		const clock = fakeClock();
		const sleep = vi.fn(clock.sleep);

		await waitForEncoderQueueSpace({
			getQueueSize: () => 0,
			maxEncodeQueue: 8,
			isCancelled: () => false,
			encoderPreference: "prefer-hardware",
			now: clock.now,
			sleep,
		});

		expect(sleep).not.toHaveBeenCalled();
	});

	it("waits for the queue to drain and then resolves", async () => {
		const clock = fakeClock();
		let queueSize = 8;
		// Queue drains well within the timeout.
		const sleep = vi.fn(async (ms: number) => {
			await clock.sleep(ms);
			queueSize = 0;
		});

		await waitForEncoderQueueSpace({
			getQueueSize: () => queueSize,
			maxEncodeQueue: 8,
			isCancelled: () => false,
			encoderPreference: "prefer-hardware",
			now: clock.now,
			sleep,
		});

		expect(sleep).toHaveBeenCalledTimes(1);
	});

	it("throws a hardware-specific error once the queue stays full past the timeout", async () => {
		const clock = fakeClock();

		await expect(
			waitForEncoderQueueSpace({
				getQueueSize: () => 8,
				maxEncodeQueue: 8,
				isCancelled: () => false,
				encoderPreference: "prefer-hardware",
				now: clock.now,
				sleep: clock.sleep,
			}),
		).rejects.toThrow(
			"The hardware video encoder stopped responding. Retrying with a safer encoder.",
		);
	});

	it("throws a generic error for the software encoder once the queue stays full past the timeout", async () => {
		const clock = fakeClock();

		await expect(
			waitForEncoderQueueSpace({
				getQueueSize: () => 8,
				maxEncodeQueue: 8,
				isCancelled: () => false,
				encoderPreference: "prefer-software",
				now: clock.now,
				sleep: clock.sleep,
			}),
		).rejects.toThrow("The video encoder stopped responding during export.");
	});

	it("stops waiting without throwing once cancelled", async () => {
		const clock = fakeClock();
		let cancelled = false;
		const sleep = vi.fn(async (ms: number) => {
			await clock.sleep(ms);
			cancelled = true;
		});

		await expect(
			waitForEncoderQueueSpace({
				getQueueSize: () => 8,
				maxEncodeQueue: 8,
				isCancelled: () => cancelled,
				encoderPreference: "prefer-hardware",
				now: clock.now,
				sleep,
			}),
		).resolves.toBeUndefined();
	});
});
