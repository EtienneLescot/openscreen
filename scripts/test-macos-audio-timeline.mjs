/**
 * Does a sound land where it happened, and does the track cover the whole take?
 *
 * The macOS sibling of scripts/test-windows-audio-timeline.mjs, and it asks one more
 * question than that one does. The helper's mixed audio track used to take its origin
 * from the first buffer that happened to arrive, so a take beginning in silence began
 * the track wherever the first sound was — and it never called
 * `writer.endSession(atSourceTime:)`, so the file also ENDED at the last sample anything
 * delivered. Leading silence missing at the front, trailing silence missing at the back,
 * one cause: a cursor advanced by data instead of by a clock.
 *
 *   npm run test:sck-audio-timeline:mac
 *
 * Records ten seconds — four silent, three with a tone, three silent again — and measures
 * where the tone sits and how long each track is. Plays through the default output device
 * and captures the default display, so both have to be working: this measures the machine
 * as much as the code. `swift test` is the half that measures only the code, and that one
 * runs on every pull request.
 *
 * Two tolerances, because the two measurements are not equally tight:
 *
 *   - The tone's position is compared against the instant playback was ASKED for, so it
 *     carries afplay's start-up latency and the output device waking up. 250 ms.
 *   - The audio track's length is compared against the VIDEO track's length in the same
 *     file. Both come from one writer session and one endSession, so no wall clock enters
 *     it at all and the comparison can be tight. 100 ms.
 *
 * That second one is the assertion with teeth, and it is the one Windows cannot make: its
 * script has no video track to compare against and settles for "not shorter than the
 * silence", with TOLERANCE_S = 1.0.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const PLAY_AT_MS = Number(process.env.OPENSCREEN_SCK_TEST_PLAY_AT_MS ?? 4000);
const TONE_MS = 3000;
/** Silence after the tone, so the trailing half of the timeline is exercised too. */
const TAIL_MS = 3000;
/**
 * How far the tone may sit from where it was asked for before this is a failure.
 *
 * This budget is spent almost entirely before the timeline is involved: `afplay` has to
 * fork, link, open the output device and hand CoreAudio its first samples, and none of that
 * is charged to the code under test. Measured floor on an M1 Mac mini, output device already
 * warm and the tone asked for at 1.5s, 4s and 7s: a flat +0.22s at every position. The
 * original 0.25s left 30ms for the thing actually being measured, which is not a budget.
 *
 * 0.40s keeps the regression this exists to catch. The failure it guards against is a
 * start-up rebase moving real audio by up to 250ms (PR #343); on top of the 0.22s floor that
 * lands at 0.47s and still fails. A mis-rebase cannot hide under this number.
 */
const TONE_TOLERANCE_S = 0.4;
/** How far the audio track may differ in length from the video track in the same file. */
const TRACK_TOLERANCE_S = 0.1;
/** Analysis window for locating the tone. Tight enough to resolve a 250 ms mis-rebase. */
const WINDOW_MS = 20;

if (process.platform !== "darwin") {
	console.log("macOS only — skipping.");
	process.exit(0);
}

/**
 * The vendored LGPL tree first, then whatever is on PATH.
 *
 * scripts/fetch-ffmpeg-macos.mjs BUILDS its tree from source (roughly five minutes),
 * because no LGPL macOS binary is published — far too much to demand of a test run, so a
 * Homebrew ffmpeg is accepted here. That is fine for measuring a file and would not be
 * fine for shipping: Homebrew's build is GPL-3.0.
 */
function resolveTool(name) {
	const fromEnv = process.env[`OPENSCREEN_${name.toUpperCase()}`];
	if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

	const thirdparty = path.join(ROOT, "crates", "thirdparty");
	if (fs.existsSync(thirdparty)) {
		for (const entry of fs.readdirSync(thirdparty)) {
			if (!entry.startsWith("ffmpeg-n")) continue;
			const candidate = path.join(thirdparty, entry, "bin", name);
			if (fs.existsSync(candidate)) return candidate;
		}
	}

	const onPath = spawnSync("/usr/bin/which", [name], { encoding: "utf8" });
	const resolved = (onPath.stdout ?? "").trim();
	return resolved && fs.existsSync(resolved) ? resolved : null;
}

function resolveHelper() {
	const candidates = [
		process.env.OPENSCREEN_SCK_HELPER_BIN,
		path.join(
			ROOT,
			"electron",
			"native",
			"screencapturekit",
			"build",
			"openscreen-screencapturekit-helper",
		),
		path.join(
			ROOT,
			"electron",
			"native",
			"bin",
			"darwin-arm64",
			"openscreen-screencapturekit-helper",
		),
		path.join(
			ROOT,
			"electron",
			"native",
			"bin",
			"darwin-x64",
			"openscreen-screencapturekit-helper",
		),
	];
	return candidates.find((candidate) => candidate && fs.existsSync(candidate)) ?? null;
}

/**
 * The helper matches `source.displayId` against `SCShareableContent.displays`, so this has
 * to be a real CGDirectDisplayID rather than an index. Asked of CoreGraphics directly —
 * guessing 1 is right on most single-display Macs and wrong on the rest.
 */
function resolveDisplayId() {
	const override = Number(process.env.OPENSCREEN_SCK_TEST_DISPLAY_ID);
	if (Number.isFinite(override) && override > 0) return override;

	const probe = path.join(os.tmpdir(), "openscreen-main-display-id.swift");
	fs.writeFileSync(probe, "import CoreGraphics\nprint(CGMainDisplayID())\n");
	const result = spawnSync("swift", [probe], { encoding: "utf8" });
	fs.rmSync(probe, { force: true });
	const parsed = Number((result.stdout ?? "").trim());
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

const FFMPEG = resolveTool("ffmpeg");
const FFPROBE = resolveTool("ffprobe");
const HELPER = resolveHelper();
if (!HELPER) {
	console.error("No ScreenCaptureKit helper found. Run: npm run build:native:mac");
	process.exit(1);
}
if (!FFMPEG || !FFPROBE) {
	console.error(
		"No ffmpeg/ffprobe found. Run `npm run fetch:ffmpeg:mac`, install one with Homebrew,\n" +
			"or point OPENSCREEN_FFMPEG and OPENSCREEN_FFPROBE at binaries.",
	);
	process.exit(1);
}

const tonePath = path.join(os.tmpdir(), "openscreen-audio-timeline-tone.wav");
const madeTone = spawnSync(
	FFMPEG,
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
	{ encoding: "utf8" },
);
if (madeTone.status !== 0 || !fs.existsSync(tonePath)) {
	// Report what ffmpeg said. A shared-library build whose dylibs are not on the loader path
	// fails here with a linker error that has nothing to do with the tone, and swallowing it
	// sends you looking at the audio pipeline instead of at the binary.
	const detail = `${madeTone.stderr ?? ""}${madeTone.error?.message ?? ""}`.trim();
	console.error(`Could not synthesise the test tone with ${FFMPEG}.`);
	if (detail) console.error(detail.split("\n").slice(-5).join("\n"));
	process.exit(1);
}

const outputPath = path.join(os.tmpdir(), "openscreen-audio-timeline.mp4");
fs.rmSync(outputPath, { force: true });

const displayId = resolveDisplayId();
const request = {
	schemaVersion: 1,
	recordingId: Date.now(),
	source: { type: "display", sourceId: `screen:${displayId}:0`, displayId },
	video: { fps: 30, width: 1280, height: 720, bitrate: 4_000_000, hideSystemCursor: true },
	audio: {
		system: { enabled: true },
		// No microphone on purpose: a live one streams continuously and would keep the
		// timeline moving on its own, hiding exactly the failure this measures.
		microphone: { enabled: false, deviceId: null, deviceName: null, gain: 1 },
	},
	webcam: { enabled: false, deviceId: null, deviceName: null, width: 1280, height: 720, fps: 30 },
	cursor: { mode: "editable-overlay" },
	outputs: { screenPath: outputPath },
};

/**
 * Starts the default output device before the take, so its wake-up is not measured as offset.
 *
 * The tone's position is compared against the instant playback was ASKED for, so everything
 * between the two lands in the budget — including CoreAudio starting an idle output device,
 * which is not free. Measured on an M1 Mac mini: a cold device puts the tone 0.28s late and
 * fails the 0.25s tolerance on its own, while a warm one is reproducibly 0.18s late at every
 * position tried. Removing the wake-up is worth more than widening the tolerance would be,
 * because the tolerance is what gives the measurement its teeth.
 *
 * It has to make a real sound: a warm-up of digital silence was tried first and measured no
 * better than no warm-up at all (0.32s late from cold), because nothing starts the device
 * until there are samples to play. It is short and it runs BEFORE the helper starts, which is
 * what keeps it out of the measurement — a warm-up playing once the writer session was open
 * would be found by `firstAudibleSecond` instead of the tone and reported as a wildly early
 * hit.
 */
function warmOutputDevice() {
	const warmPath = path.join(os.tmpdir(), "openscreen-audio-timeline-warmup.wav");
	const made = spawnSync(
		FFMPEG,
		[
			"-hide_banner",
			"-loglevel",
			"error",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:duration=0.5",
			"-ac",
			"2",
			"-ar",
			"48000",
			"-acodec",
			"pcm_s16le",
			"-y",
			warmPath,
		],
		{ encoding: "utf8" },
	);
	if (made.status === 0 && fs.existsSync(warmPath)) {
		spawnSync("/usr/bin/afplay", [warmPath]);
		fs.rmSync(warmPath, { force: true });
	}
}
warmOutputDevice();

console.log(
	`Recording ${(PLAY_AT_MS + TONE_MS + TAIL_MS) / 1000}s on display ${displayId}: ` +
		`${PLAY_AT_MS / 1000}s of silence, a ${TONE_MS / 1000}s tone, then ${TAIL_MS / 1000}s of silence...`,
);
const proc = spawn(HELPER, [JSON.stringify(request)]);
let helperOutput = "";
let spawnError = null;
let playbackArmed = false;
const helperEvents = [];
proc.on("error", (error) => {
	spawnError = error.message;
});

/**
 * Arms the tone once the helper says it is recording, never from spawn.
 *
 * Everything measured here is relative to the writer session, which opens on the first
 * video frame — after ScreenCaptureKit, the encoder and the audio taps have all come up.
 * Counting from spawn would fold that setup into the offset and fail the test on a slow
 * machine with nothing wrong with the timestamps.
 */
function armPlaybackOnce() {
	if (playbackArmed || !helperEvents.some((event) => event.event === "recording-started")) {
		return;
	}
	playbackArmed = true;
	setTimeout(() => {
		// Blocking on purpose: it guarantees the tone really played before the tail is
		// timed and the stop below is sent, which is the premise of the measurement.
		spawnSync("/usr/bin/afplay", [tonePath]);
		setTimeout(() => {
			try {
				proc.stdin.write("stop\n");
			} catch {
				// Already gone; the close handler reports how it ended.
			}
		}, TAIL_MS);
	}, PLAY_AT_MS);
}

/**
 * Reassembles the helper's NDJSON across chunk boundaries.
 *
 * A `data` chunk is whatever the pipe had ready, not a whole line, so splitting each chunk on
 * its own newlines drops any event a read happened to bisect — both halves parse as neither.
 * Losing `recording-started` that way leaves the tone unarmed and the run hangs until the
 * 30 s timeout kills the helper, which reads as "the helper never started" rather than as a
 * framing bug. Only stdout carries events; stderr is diagnostics and is kept as raw text.
 */
let stdoutTail = "";
function consumeStdout(chunk) {
	const text = chunk.toString();
	helperOutput += text;
	stdoutTail += text;
	const lines = stdoutTail.split("\n");
	stdoutTail = lines.pop() ?? "";
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		try {
			helperEvents.push(JSON.parse(trimmed));
		} catch {
			// Not one of ours; the raw text is kept in helperOutput either way.
		}
	}
	armPlaybackOnce();
}
proc.stdout.on("data", consumeStdout);
proc.stderr.on("data", (chunk) => {
	helperOutput += chunk.toString();
});

// If the helper never announces itself, nothing would ever stop it.
const startTimeout = setTimeout(() => {
	if (!playbackArmed) {
		console.error("The helper never reported that recording had started.");
		proc.kill();
	}
}, 30_000);

/** Per-stream durations, which is what "does the audio cover the take" is asked of. */
function streamDurations() {
	const probed = spawnSync(
		FFPROBE,
		[
			"-hide_banner",
			"-loglevel",
			"error",
			"-show_entries",
			"stream=codec_type,duration",
			"-of",
			"json",
			outputPath,
		],
		{ encoding: "utf8", maxBuffer: 1 << 24 },
	);
	try {
		const streams = JSON.parse(probed.stdout ?? "{}").streams ?? [];
		const durationOf = (kind) => {
			const stream = streams.find((candidate) => candidate.codec_type === kind);
			const seconds = Number(stream?.duration);
			return Number.isFinite(seconds) ? seconds : null;
		};
		return { audio: durationOf("audio"), video: durationOf("video") };
	} catch {
		return { audio: null, video: null };
	}
}

/** Where the tone actually sits, from the decoded samples rather than the metadata. */
function firstAudibleSecond() {
	const rate = 16000;
	const decoded = spawnSync(
		FFMPEG,
		[
			"-hide_banner",
			"-nostats",
			"-loglevel",
			"error",
			"-i",
			outputPath,
			"-map",
			"0:a",
			"-f",
			"s16le",
			"-ac",
			"1",
			"-ar",
			String(rate),
			"-",
		],
		{ maxBuffer: 1 << 28 },
	);
	const pcm = decoded.stdout ?? Buffer.alloc(0);
	const samples = pcm.length / 2;
	const windowSamples = (rate * WINDOW_MS) / 1000;
	for (let index = 0; index * windowSamples < samples; index += 1) {
		let peak = 0;
		const from = index * windowSamples;
		const to = Math.min(from + windowSamples, samples);
		for (let at = from; at < to; at += 1) {
			peak = Math.max(peak, Math.abs(pcm.readInt16LE(at * 2)));
		}
		// Well above dither, well below a real tone.
		if (peak > 1200) return (index * WINDOW_MS) / 1000;
	}
	return null;
}

proc.on("close", (code, signal) => {
	clearTimeout(startTimeout);
	// The summary is the last thing the helper writes, so a final line without its newline
	// would otherwise sit in the tail buffer and never be read.
	if (stdoutTail.trim().startsWith("{")) {
		try {
			helperEvents.push(JSON.parse(stdoutTail.trim()));
		} catch {
			// Truncated on exit; nothing to recover.
		}
	}
	const problems = [];
	if (!playbackArmed) problems.push("recording never started, so no tone was played");
	if (spawnError) problems.push(`could not start the helper: ${spawnError}`);
	if (signal) problems.push(`helper killed by ${signal}`);
	if (code !== 0 && code !== null) problems.push(`helper exited ${code}`);

	const { audio, video } = streamDurations();
	const toneAt = firstAudibleSecond();
	const playedAt = PLAY_AT_MS / 1000;

	if (audio === null) {
		problems.push("the recording has no audio track at all");
	}
	if (toneAt === null) {
		problems.push(
			"no audible tone in the recording — check the default output device is on and unmuted",
		);
	} else if (Math.abs(toneAt - playedAt) > TONE_TOLERANCE_S) {
		problems.push(
			`the tone sits at ${toneAt.toFixed(2)}s, and was played at ${playedAt.toFixed(2)}s`,
		);
	}
	// The whole take has to be IN the audio track: the silence before the tone and the
	// silence after it, not just the part where something was playing.
	if (audio !== null && video !== null && Math.abs(audio - video) > TRACK_TOLERANCE_S) {
		problems.push(
			`the audio track is ${audio.toFixed(2)}s and the video track is ${video.toFixed(2)}s — ` +
				`the mixed track does not span the take`,
		);
	}

	// The mixer's own account of what the system-audio tap actually handed over. On a take
	// where nothing plays, this is the measurement that says whether ScreenCaptureKit's
	// system-audio output is silence-gapped the way the WASAPI loopback tap is, or whether it
	// streams silence continuously.
	const summary = helperEvents.findLast((event) => event.event === "audio-timeline");
	const system = summary?.system;
	// `droppedSeconds` is audio the mixer could not place, and nothing else: what a source loses
	// at the head of a take while it is still catching up to a cursor that has already started
	// moving is reported apart, as `trimmedSeconds`. That one is normal here and varies from
	// take to take — it was measured at 0.00s to 0.04s across runs on one machine — which is
	// exactly why it cannot share a counter with a fault. This can now be checked against zero,
	// the only threshold that means anything.
	const dropped = Number(system?.droppedSeconds ?? 0);
	if (dropped > 0) {
		problems.push(
			`${dropped.toFixed(2)}s of captured audio arrived too late to be placed — the emission grace is too short for this tap`,
		);
	}

	fs.rmSync(outputPath, { force: true });
	console.log(
		`\n${problems.length ? "FAIL" : "PASS"}  audio=${audio?.toFixed(2) ?? "(none)"}s  ` +
			`video=${video?.toFixed(2) ?? "(none)"}s  ` +
			`tone at ${toneAt === null ? "(none)" : `${toneAt.toFixed(2)}s`}, played at ${playedAt.toFixed(2)}s`,
	);
	if (system) {
		const track = Number(summary.trackSeconds ?? 0);
		const undelivered = Number(system.undeliveredSeconds ?? 0);
		console.log(
			`      system audio delivered nothing for ${undelivered.toFixed(2)}s of a ${track.toFixed(2)}s ` +
				`track, longest hole ${Number(system.longestHoleSeconds ?? 0).toFixed(2)}s, ` +
				`${Number(system.trimmedSeconds ?? 0).toFixed(2)}s trimmed while the tap caught up\n` +
				`      => ${
					undelivered > track / 2
						? "ScreenCaptureKit GAPS its silence, like WASAPI loopback"
						: "ScreenCaptureKit STREAMS silence; only the take's edges needed the clock"
				}`,
		);
	}
	for (const problem of problems) console.log(`      -> ${problem}`);
	if (problems.length) {
		const complaints = helperEvents
			.filter((event) => event.event === "error" || event.event === "warning")
			.slice(-5);
		for (const complaint of complaints) {
			console.log(`      helper: ${complaint.code}: ${complaint.message}`);
		}
		if (!complaints.length && helperOutput.trim()) {
			console.log(`      helper: ${helperOutput.trim().split("\n").slice(-3).join(" | ")}`);
		}
	}
	process.exit(problems.length ? 1 : 0);
});
