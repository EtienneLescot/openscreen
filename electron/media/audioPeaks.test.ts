// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

	/**
	 * The shape that slipped through. A Linux dev checkout used to have
	 * `electron/native/bin/<tag>/ffmpeg` as a DIRECTORY of shared libraries
	 * rather than the binary; `existsSync` accepted it, resolution stopped
	 * there, and the failure only surfaced later as `spawn … EACCES`.
	 *
	 * That particular collision is gone — the helper's libraries moved to
	 * `helper-ffmpeg/` — but the assertion stays, because it is really about
	 * `resolveFfmpeg` not confusing existence with executability, and the next
	 * thing to land a directory on a candidate path will not announce itself
	 * either.
	 */
	it("skips a candidate that is a directory rather than the binary", () => {
		const here = mkdtempSync(path.join(tmpdir(), "openscreen-ffmpeg-"));
		const tag = `${process.platform}-${process.arch}`;
		const name = process.platform === "win32" ? "ffmpeg-shared.exe" : "ffmpeg";
		const staged = path.join(here, "electron", "native", "bin", tag, name);
		try {
			// A directory sitting exactly where the executable is looked for.
			mkdirSync(staged, { recursive: true });
			writeFileSync(path.join(staged, "libavcodec.so.62"), "");

			expect(resolveFfmpeg(here)).toBeNull();
		} finally {
			rmSync(here, { recursive: true, force: true });
		}
	});

	it("accepts a candidate that is an executable file", () => {
		const here = mkdtempSync(path.join(tmpdir(), "openscreen-ffmpeg-"));
		const tag = `${process.platform}-${process.arch}`;
		const name = process.platform === "win32" ? "ffmpeg-shared.exe" : "ffmpeg";
		const staged = path.join(here, "electron", "native", "bin", tag, name);
		try {
			mkdirSync(path.dirname(staged), { recursive: true });
			writeFileSync(staged, "", { mode: 0o755 });

			expect(resolveFfmpeg(here)).toBe(staged);
		} finally {
			rmSync(here, { recursive: true, force: true });
		}
	});

	// Non-executable files are the other half of the predicate, and the check is
	// only meaningful where the OS enforces the bit.
	it.runIf(process.platform !== "win32")(
		"skips a candidate that is a file but not executable",
		() => {
			const here = mkdtempSync(path.join(tmpdir(), "openscreen-ffmpeg-"));
			const staged = path.join(
				here,
				"electron",
				"native",
				"bin",
				`${process.platform}-${process.arch}`,
				"ffmpeg",
			);
			try {
				mkdirSync(path.dirname(staged), { recursive: true });
				writeFileSync(staged, "", { mode: 0o644 });

				expect(resolveFfmpeg(here)).toBeNull();
			} finally {
				rmSync(here, { recursive: true, force: true });
			}
		},
	);

	/**
	 * REJECTING IS NOT THE SAME AS CONTINUING, and only the second is the
	 * property the predicate exists for: swallowing every failure is what stops
	 * one bad path from denying a later working one. The tests above prove the
	 * first — with a single candidate staged, `null` is equally consistent with
	 * "skipped it" and "gave up on the whole list".
	 *
	 * `OPENSCREEN_FFMPEG_PATH` is the vehicle because `ffmpegCandidates` puts it
	 * FIRST, so a bad value there is the one case that could shadow every real
	 * candidate behind it.
	 */
	describe("falling through to a later candidate", () => {
		let here: string;
		let staged: string;

		beforeEach(() => {
			here = mkdtempSync(path.join(tmpdir(), "openscreen-ffmpeg-"));
			staged = path.join(
				here,
				"electron",
				"native",
				"bin",
				`${process.platform}-${process.arch}`,
				process.platform === "win32" ? "ffmpeg-shared.exe" : "ffmpeg",
			);
			mkdirSync(path.dirname(staged), { recursive: true });
			writeFileSync(staged, "", { mode: 0o755 });
		});

		afterEach(() => {
			delete process.env.OPENSCREEN_FFMPEG_PATH;
			rmSync(here, { recursive: true, force: true });
		});

		it("passes over a leading candidate that does not exist", () => {
			process.env.OPENSCREEN_FFMPEG_PATH = path.join(here, "nowhere", "ffmpeg");

			expect(resolveFfmpeg(here)).toBe(staged);
		});

		it("passes over a leading candidate that is a directory", () => {
			const decoy = path.join(here, "decoy-ffmpeg");
			mkdirSync(decoy, { recursive: true });
			writeFileSync(path.join(decoy, "libavcodec.so.62"), "");
			process.env.OPENSCREEN_FFMPEG_PATH = decoy;

			expect(resolveFfmpeg(here)).toBe(staged);
		});

		it.runIf(process.platform !== "win32")(
			"passes over a leading candidate that is not executable",
			() => {
				const decoy = path.join(here, "decoy-ffmpeg");
				writeFileSync(decoy, "", { mode: 0o644 });
				process.env.OPENSCREEN_FFMPEG_PATH = decoy;

				expect(resolveFfmpeg(here)).toBe(staged);
			},
		);

		// An unreadable-but-executable binary is legitimate on Unix, so it must be
		// ACCEPTED rather than fallen through — `X_OK` is deliberately not paired
		// with `R_OK`. Skipped as root, for whom access checks always pass.
		it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
			"still accepts an execute-only binary",
			() => {
				const executableOnly = path.join(here, "exec-only-ffmpeg");
				writeFileSync(executableOnly, "", { mode: 0o111 });
				process.env.OPENSCREEN_FFMPEG_PATH = executableOnly;

				expect(resolveFfmpeg(here)).toBe(executableOnly);
			},
		);
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
