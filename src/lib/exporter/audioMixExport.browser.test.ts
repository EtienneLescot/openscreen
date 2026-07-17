import { describe, expect, it } from "vitest";
import dualAudioUrl from "../../../tests/fixtures/sample-dual-audio.mp4?url";
import { VideoExporter } from "./videoExporter";

/**
 * Regression test for issue #108: native macOS recordings write system audio and
 * the microphone as two separate tracks. FFmpeg's `av_find_best_stream` (used by
 * web-demuxer) resolves the bare "audio" selector to the first track, so when the
 * system-audio track is silent the exporter dropped the mic and produced silence.
 *
 * The fixture mirrors that layout: track 0 is silent, track 1 is a 440 Hz tone.
 * A correct export mixes both, so the output must carry the tone.
 */
async function measureAudioRms(blob: Blob): Promise<{ rms: number; hasAudio: boolean }> {
	const bytes = await blob.arrayBuffer();
	const audioContext = new AudioContext();
	try {
		const audioBuffer = await audioContext.decodeAudioData(bytes.slice(0));
		if (audioBuffer.numberOfChannels === 0 || audioBuffer.length === 0) {
			return { rms: 0, hasAudio: false };
		}
		let sumSquares = 0;
		let sampleCount = 0;
		for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
			const data = audioBuffer.getChannelData(channel);
			for (let i = 0; i < data.length; i++) {
				sumSquares += data[i] * data[i];
				sampleCount++;
			}
		}
		return { rms: Math.sqrt(sumSquares / sampleCount), hasAudio: true };
	} finally {
		await audioContext.close();
	}
}

describe("Multi-track audio export (real browser)", () => {
	it("mixes both audio tracks so a silent first track can't drop the mic (#108)", async () => {
		const exporter = new VideoExporter({
			videoUrl: dualAudioUrl,
			width: 320,
			height: 180,
			frameRate: 15,
			bitrate: 1_000_000,
			wallpaper: "#1a1a2e",
			zoomRegions: [],
			showShadow: false,
			shadowIntensity: 0,
			showBlur: false,
			cropRegion: { x: 0, y: 0, width: 1, height: 1 },
		});

		const result = await exporter.export();
		expect(result.success, result.error).toBe(true);
		expect(result.blob).toBeInstanceOf(Blob);

		const { rms, hasAudio } = await measureAudioRms(result.blob!);
		expect(hasAudio).toBe(true);
		// Silence (the first track alone) sits near 0; the mixed-in 440 Hz tone lifts
		// RMS well above the noise floor. A comfortable threshold below the tone's
		// real level (~0.08) but far above silence.
		expect(rms).toBeGreaterThan(0.01);
	});

	it("mixes both audio tracks through the speed-region (offline) path too", async () => {
		const exporter = new VideoExporter({
			videoUrl: dualAudioUrl,
			width: 320,
			height: 180,
			frameRate: 15,
			bitrate: 1_000_000,
			wallpaper: "#1a1a2e",
			zoomRegions: [],
			// A speed region routes audio through renderOfflineTimelineAudio, a distinct
			// mixing branch from the trim-only path exercised above.
			speedRegions: [{ id: "speed", startMs: 500, endMs: 1500, speed: 2 }],
			showShadow: false,
			shadowIntensity: 0,
			showBlur: false,
			cropRegion: { x: 0, y: 0, width: 1, height: 1 },
		});

		const result = await exporter.export();
		expect(result.success, result.error).toBe(true);

		const { rms, hasAudio } = await measureAudioRms(result.blob!);
		expect(hasAudio).toBe(true);
		expect(rms).toBeGreaterThan(0.01);
	});
});
