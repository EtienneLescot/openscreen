/**
 * Does a sound land where it happened?
 *
 * The helper's audio timestamps come from a running count of emitted frames, so
 * they only describe the take if a chunk goes out for every chunk of real time.
 * When that count advanced only while a source had samples queued, a recording
 * that began in silence emitted nothing until something played — and the first
 * sound landed at timestamp zero, with the track shorter than the take by the
 * silence it skipped (getopenscreen/openscreen#406).
 *
 * A working microphone hid it, streaming continuously and keeping the queue
 * non-empty, which is why it surfaced as a system-audio desync on a machine
 * whose microphone had failed.
 *
 * WASAPI cannot run on Linux CI, so this drives the real helper: record in
 * silence, play a tone at a known instant, and measure where the tone actually
 * sits in the file.
 *
 *   npm run test:wgc-audio-timeline:win
 *
 * Plays through the default render endpoint, so that device has to be working
 * and audible — this measures the machine as much as the code.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const HELPER =
	process.env.OPENSCREEN_WGC_CAPTURE_EXE ??
	path.join(ROOT, "electron", "native", "bin", "win32-x64", "wgc-capture.exe");
const FFMPEG = path.join(ROOT, "electron", "native", "bin", "win32-x64", "ffmpeg.exe");
const PLAY_AT_MS = Number(process.env.OPENSCREEN_WGC_TEST_PLAY_AT_MS ?? 4000);
const TONE_MS = 6000;
/** How far the tone may sit from where it was played before this is a failure. */
const TOLERANCE_S = 1.0;

if (process.platform !== "win32") {
	console.log("Windows only — skipping.");
	process.exit(0);
}
for (const [what, where] of [
	["helper", HELPER],
	["ffmpeg", FFMPEG],
]) {
	if (!fs.existsSync(where)) {
		console.error(`No ${what} at ${where}. Run: npm run build:native:win && npm run fetch:ffmpeg`);
		process.exit(1);
	}
}

const tonePath = path.join(os.tmpdir(), "openscreen-audio-timeline-tone.wav");
const madeTone = spawnSync(
	FFMPEG,
	// deno-fmt-ignore
	[
		"-hide_banner",
		"-loglevel",
		"error",
		"-f",
		"lavfi",
		"-i",
		`sine=frequency=440:duration=${TONE_MS / 1000}`,
		"-ac",
		"2",
		"-ar",
		"48000",
		"-acodec",
		"pcm_s16le",
		"-y",
		tonePath,
	],
	{ windowsHide: true },
);
if (madeTone.status !== 0 || !fs.existsSync(tonePath)) {
	console.error("Could not synthesise the test tone.");
	process.exit(1);
}

const outputPath = path.join(os.tmpdir(), "openscreen-audio-timeline.mp4");
fs.rmSync(outputPath, { force: true });

const config = {
	schemaVersion: 2,
	recordingId: Date.now(),
	outputPath,
	sourceType: "display",
	sourceId: "screen:0:0",
	displayId: 0,
	fps: 30,
	videoWidth: 1280,
	videoHeight: 720,
	hasDisplayBounds: false,
	captureSystemAudio: true,
	// No microphone on purpose: it is the state a failed one leaves behind, and
	// a working one masks the bug by keeping the mixer's queue fed.
	captureMic: false,
	webcamEnabled: false,
	cursorCaptureMode: "editable-overlay",
};

console.log(`Recording in silence, playing a ${TONE_MS / 1000}s tone at ${PLAY_AT_MS / 1000}s...`);
const proc = spawn(HELPER, [JSON.stringify(config)], { windowsHide: true });
let helperOutput = "";
let spawnError = null;
proc.on("error", (error) => {
	spawnError = error.message;
});
proc.stdout.on("data", (chunk) => {
	helperOutput += chunk.toString();
});
proc.stderr.on("data", (chunk) => {
	helperOutput += chunk.toString();
});

setTimeout(() => {
	// Blocking on purpose: it guarantees the tone really played before the stop
	// below is sent, which is the whole premise of the measurement.
	spawnSync(
		"powershell.exe",
		["-NoProfile", "-Command", `(New-Object System.Media.SoundPlayer '${tonePath}').PlaySync()`],
		{ windowsHide: true },
	);
	try {
		proc.stdin.write("stop\n");
	} catch {
		// Already gone; the close handler reports how it ended.
	}
}, PLAY_AT_MS);

proc.on("close", (code, signal) => {
	const problems = [];
	if (spawnError) problems.push(`could not start the helper: ${spawnError}`);
	if (signal) problems.push(`helper killed by ${signal}`);
	if (code !== 0 && code !== null) problems.push(`helper exited ${code}`);

	const decoded = spawnSync(
		FFMPEG,
		// deno-fmt-ignore
		[
			"-hide_banner",
			"-nostats",
			"-i",
			outputPath,
			"-map",
			"0:a",
			"-f",
			"s16le",
			"-ac",
			"1",
			"-ar",
			"16000",
			"-",
		],
		{ maxBuffer: 1 << 28, windowsHide: true },
	);
	const pcm = decoded.stdout ?? Buffer.alloc(0);
	const rate = 16000;
	const samples = pcm.length / 2;
	const windowSamples = rate / 10;
	const audible = [];
	for (let index = 0; index * windowSamples < samples; index += 1) {
		let peak = 0;
		const from = index * windowSamples;
		const to = Math.min(from + windowSamples, samples);
		for (let at = from; at < to; at += 1) {
			peak = Math.max(peak, Math.abs(pcm.readInt16LE(at * 2)));
		}
		// Well above dither, well below a real tone.
		if (peak > 1200) audible.push(index / 10);
	}

	const trackSeconds = samples / rate;
	const startedAt = audible.length ? audible[0] : null;
	if (startedAt === null) {
		problems.push(
			"no audible tone in the recording — check the default playback device is on and unmuted",
		);
	} else if (Math.abs(startedAt - PLAY_AT_MS / 1000) > TOLERANCE_S) {
		problems.push(
			`the tone sits at ${startedAt.toFixed(1)}s, and was played at ${(PLAY_AT_MS / 1000).toFixed(1)}s`,
		);
	}
	// The silence before the tone has to be IN the file, not skipped over.
	if (trackSeconds < PLAY_AT_MS / 1000) {
		problems.push(
			`the track is ${trackSeconds.toFixed(2)}s, shorter than the silence that preceded the tone`,
		);
	}

	fs.rmSync(outputPath, { force: true });
	console.log(
		`\n${problems.length ? "FAIL" : "PASS"}  track=${trackSeconds.toFixed(2)}s  tone at ${startedAt === null ? "(none)" : `${startedAt.toFixed(1)}s`}, played at ${(PLAY_AT_MS / 1000).toFixed(1)}s`,
	);
	for (const problem of problems) console.log(`      -> ${problem}`);
	process.exit(problems.length ? 1 : 0);
});
