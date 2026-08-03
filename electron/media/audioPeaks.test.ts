// @vitest-environment node
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ffmpegCandidates, peakBlockCount, resolveFfmpeg } from "./audioPeaks";

const ROOT = path.resolve(__dirname, "..", "..");

describe("peakBlockCount", () => {
	it("matches the browser pipelines' block maths", () => {
		// Same formula as audioPeaksWorker.ts / streamingAudioPeaks.ts: a clip must
		// not change shape depending on which pipeline drew it.
		expect(peakBlockCount(10)).toBe(2000);
		expect(peakBlockCount(60)).toBe(12000);
		// Capped, so a 30-minute recording costs the same DOM/array budget as a
		// 2-minute one.
		expect(peakBlockCount(1951)).toBe(24000);
		expect(peakBlockCount(99999)).toBe(24000);
	});

	it("never returns zero blocks for a sliver of audio", () => {
		expect(peakBlockCount(0.001)).toBe(1);
	});
});

describe("ffmpeg resolution", () => {
	it("prefers the shared build the installer actually ships", () => {
		const candidates = ffmpegCandidates(ROOT);
		const shared = candidates.findIndex((c) => c.endsWith("ffmpeg-shared.exe"));
		const vendorTree = candidates.findIndex((c) => c.includes("lgpl-shared"));
		if (process.platform === "win32") {
			expect(shared).toBeGreaterThanOrEqual(0);
			// The static ffmpeg.exe is excluded from the Windows installer
			// ("!win32-*/ffmpeg.exe"), so resolving to it would work in dev and fail
			// in production. It must not be a candidate at all.
			expect(
				candidates.some((c) => c.endsWith(`bin${path.sep}win32-x64${path.sep}ffmpeg.exe`)),
			).toBe(false);
			expect(shared).toBeLessThan(vendorTree);
		}
	});

	it("honours the env override first", () => {
		process.env.OPENSCREEN_FFMPEG_PATH = "/custom/ffmpeg";
		try {
			expect(ffmpegCandidates(ROOT)[0]).toBe("/custom/ffmpeg");
		} finally {
			process.env.OPENSCREEN_FFMPEG_PATH = undefined;
		}
	});

	it("returns null rather than throwing when nothing is staged", () => {
		expect(resolveFfmpeg(path.join(ROOT, "does", "not", "exist"))).toBeNull();
	});
});

// Only runs where the binary is actually staged; skipped elsewhere rather than
// failing a checkout that has not run scripts/fetch-ffmpeg.mjs.
const staged = resolveFfmpeg(ROOT);
describe.runIf(staged)("decoding a real file", () => {
	it("produces peaks in range, with real signal in them", async () => {
		// A synthetic 5s 440 Hz tone from ffmpeg's own lavfi source — no user
		// recording in the repo, and a signal whose shape is known rather than
		// "whatever this capture happened to contain".
		const fixture = path.join(ROOT, "electron", "media", "__fixtures__", "peaks-sample.m4a");
		if (!existsSync(fixture)) return;
		const { getAudioPeaks } = await import("./audioPeaks");
		const peaks = await getAudioPeaks(fixture, 5);
		expect(peaks).not.toBeNull();
		if (!peaks) return;
		expect(peaks.length).toBe(peakBlockCount(5) * 2);
		// [min, max] pairs, both inside [-1, 1], min <= 0 <= max (the folder starts
		// each block at the silence baseline, like the worker does).
		for (let i = 0; i < peaks.length; i += 2) {
			expect(peaks[i]).toBeLessThanOrEqual(0);
			expect(peaks[i + 1]).toBeGreaterThanOrEqual(0);
			expect(peaks[i]).toBeGreaterThanOrEqual(-1);
			expect(peaks[i + 1]).toBeLessThanOrEqual(1);
		}
		// Not all silence — otherwise everything above would pass on a pipeline
		// that returned a zeroed array.
		//
		// The bound is tight rather than "> 0" because loose is the same as
		// absent here: the mistakes worth catching are all scale errors — int16
		// divided by 65536 instead of 32768, a stereo downmix halving the signal,
		// a block whose samples never get compared — and every one of them is a
		// factor of two. 0.214 is what ffmpeg itself decodes this fixture to
		// (verified with `-f s16le` straight to a file), so this asserts the fold
		// agrees with the decoder rather than restating the fixture's nominal
		// amplitude, which lavfi's volume filter does not actually deliver.
		let mn = 0;
		let mx = 0;
		for (const v of peaks) {
			if (v < mn) mn = v;
			if (v > mx) mx = v;
		}
		expect(mx).toBeCloseTo(0.214, 1);
		expect(mn).toBeCloseTo(-0.205, 1);
	}, 120_000);
});
