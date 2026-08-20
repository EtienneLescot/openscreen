/**
 * Does a sound land where it happened, and does the track cover the whole take?
 *
 * The Linux sibling of scripts/test-macos-audio-timeline.mjs, asking the same questions
 * of a helper that answers them for a different reason. Windows and macOS both had to
 * move their audio timeline onto a clock (getopenscreen/openscreen#406, and the macOS
 * anchor after it). Linux never did, and the code is not why: `AudioEncoder::next_pts`
 * is a running count of the samples handed to the encoder — the same data-driven cursor
 * Windows had — and `AudioMix::pump` returns early when no input has any. What holds the
 * timeline up is the TAP. System audio here is the default sink's monitor, and PipeWire
 * keeps delivering its buffers whether or not anything is playing, silence included,
 * where the WASAPI loopback tap simply stops. So the count advances at real time and the
 * cursor cannot stall.
 *
 * That is exactly why this is worth running: the property belongs to the capture source,
 * not to the helper, and nothing in the helper would notice the day the source changed.
 * The whole record that any of it held was one sentence in a commit message — a live
 * 29-second capture, an 18-second tone coming back as 18 seconds of steady signal, the
 * two streams ending 62 ms apart. This is that sentence, re-runnable.
 *
 *   npm run test:pw-audio-timeline:linux
 *
 * Records ten seconds — four silent, three with a tone, three silent again — and measures
 * where the tone sits and how long each track is. NOT unattended: the portal raises the
 * compositor's own source picker and the take does not begin until someone answers it.
 * The tone plays to the DEFAULT SINK, which has to be the sink whose monitor the helper
 * captured, so this measures the machine as much as the code.
 *
 * Two tolerances, because the two measurements are not equally tight:
 *
 *   - The tone's position is compared against the instant playback was ASKED for, so it
 *     carries the player's start-up latency and the node it creates being linked into the
 *     graph. 250 ms.
 *   - The audio track's length is compared against the VIDEO track's length in the same
 *     file — no wall clock enters that at all. 250 ms rather than the 100 ms macOS uses,
 *     because there the two tracks come out of one writer session and here they do not:
 *     the video track ends at the last `Capture::advance()` and the audio track at
 *     everything the rings still held, plus AAC's final padded block. Those measured
 *     62 ms apart on a 29-second capture (video 29.100 s, audio 29.162 s), which is the
 *     number this bound is set around. It is still far tighter than the failure it is
 *     here for, which is a track that ends at the last sound and misses three seconds.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const PLAY_AT_MS = Number(process.env.OPENSCREEN_PW_TEST_PLAY_AT_MS ?? 4000);
const TONE_MS = 3000;
/** Silence after the tone, so the trailing half of the timeline is exercised too. */
const TAIL_MS = 3000;
/** How far the tone may sit from where it was asked for before this is a failure. */
const TONE_TOLERANCE_S = 0.25;
/** How far the audio track may differ in length from the video track in the same file. */
const TRACK_TOLERANCE_S = 0.25;
/** Analysis window for locating the tone. Tight enough to resolve a 250 ms mis-rebase. */
const WINDOW_MS = 20;
/**
 * How long to wait for the compositor's picker to be answered.
 *
 * Deliberately generous where the Windows and macOS scripts allow 30 s: those helpers
 * start recording on their own, and this one cannot start until a human has clicked a
 * dialog. The wait has no honest upper bound; this one only exists so an abandoned run
 * eventually stops instead of holding a portal session open forever.
 */
const PICKER_TIMEOUT_MS = Number(process.env.OPENSCREEN_PW_TEST_PICKER_TIMEOUT_MS ?? 180_000);

if (process.platform !== "linux") {
	console.log("Linux only — skipping.");
	process.exit(0);
}

const ARCH_TAG = `linux-${process.arch === "arm64" ? "arm64" : "x64"}`;
/** The shared ffmpeg tree the helper itself links against (build.rs, fetch-ffmpeg.mjs). */
const VENDORED_FFMPEG = path.join(ROOT, "crates", "thirdparty", "ffmpeg-linux64-lgpl-shared");

/**
 * A binary and whatever environment it needs to run, or null.
 *
 * Three places, in order of how self-contained they are. The vendored SHARED tree is the
 * one that always answers on a machine that can build the helper at all — build.rs
 * refuses to compile without it — and it is where ffprobe comes from, since the static
 * CLI `npm run fetch:ffmpeg` vendors is ffmpeg alone. Its binaries do not resolve their
 * own libraries, hence the explicit lib directory.
 */
function resolveTool(name) {
	const fromEnv = process.env[`OPENSCREEN_${name.toUpperCase().replaceAll("-", "_")}`];
	if (fromEnv && fs.existsSync(fromEnv)) return { bin: fromEnv, env: null };

	const staticCli = path.join(ROOT, "electron", "native", "bin", ARCH_TAG, name);
	if (fs.existsSync(staticCli)) return { bin: staticCli, env: null };

	const shared = path.join(VENDORED_FFMPEG, "bin", name);
	if (fs.existsSync(shared)) {
		const libs = [path.join(VENDORED_FFMPEG, "lib"), process.env.LD_LIBRARY_PATH]
			.filter(Boolean)
			.join(":");
		return { bin: shared, env: { LD_LIBRARY_PATH: libs } };
	}

	const onPath = spawnSync("/usr/bin/which", [name], { encoding: "utf8" });
	const resolved = (onPath.stdout ?? "").trim();
	return resolved && fs.existsSync(resolved) ? { bin: resolved, env: null } : null;
}

function runTool(tool, args, options = {}) {
	return spawnSync(tool.bin, args, {
		...options,
		env: tool.env ? { ...process.env, ...tool.env } : process.env,
	});
}

/** Mirrors helperCandidates() in pipeWireCursorRecordingSession.ts, env var included. */
function resolveHelper() {
	const name = "openscreen-pipewire-helper";
	const candidates = [
		process.env.OPENSCREEN_LINUX_CURSOR_HELPER_EXE,
		path.join(ROOT, "electron", "native", "pipewire-capture", "build", name),
		path.join(ROOT, "electron", "native", "bin", ARCH_TAG, name),
	];
	return candidates.find((candidate) => candidate && fs.existsSync(candidate)) ?? null;
}

/**
 * Something that will play a WAV to the session's default sink.
 *
 * The order is about which graph the sound lands in. `pw-play` is PipeWire's own client
 * and always lands on the session default, which is the sink whose monitor the helper is
 * recording; `paplay` reaches the same graph through pipewire-pulse. ALSA is last because
 * it can be pointed at a raw device that bypasses the graph entirely, in which case
 * nothing reaches the monitor and the tone is simply missing from the file.
 */
const PLAYERS = [
	{ name: "pw-play", args: (tone) => [tone] },
	{ name: "paplay", args: (tone) => [tone] },
	{
		name: "ffplay",
		args: (tone) => ["-hide_banner", "-loglevel", "error", "-nodisp", "-autoexit", tone],
	},
	{ name: "aplay", args: (tone) => [tone] },
];

function resolvePlayer() {
	const forced = process.env.OPENSCREEN_PW_TEST_PLAYER?.trim();
	// A player named by hand still gets the argument list its basename is known for, so
	// pointing at a specific ffplay does not silently lose `-nodisp`.
	const known = PLAYERS.find((player) => player.name === path.basename(forced ?? ""));
	const wanted = forced ? [{ name: forced, args: known?.args ?? ((tone) => [tone]) }] : PLAYERS;
	for (const player of wanted) {
		const tool = resolveTool(player.name);
		if (tool) return { ...tool, name: path.basename(player.name), args: player.args };
	}
	return null;
}

const FFMPEG = resolveTool("ffmpeg");
const FFPROBE = resolveTool("ffprobe");
const HELPER = resolveHelper();
const PLAYER = resolvePlayer();
if (!HELPER) {
	console.error("No PipeWire helper found. Run: npm run build:native:linux");
	process.exit(1);
}
if (!FFMPEG || !FFPROBE) {
	console.error(
		"No ffmpeg/ffprobe found. Run `npm run fetch:ffmpeg:sdk`, which vendors both beside the\n" +
			"libraries the helper links, or point OPENSCREEN_FFMPEG and OPENSCREEN_FFPROBE at binaries.",
	);
	process.exit(1);
}
if (!PLAYER) {
	console.error(
		`Nothing here can play a WAV. Install one of ${PLAYERS.map((player) => player.name).join(", ")}\n` +
			"(pw-play ships with pipewire, paplay with pulseaudio-utils), or point\n" +
			"OPENSCREEN_PW_TEST_PLAYER at a player that takes a file path.",
	);
	process.exit(1);
}

const tonePath = path.join(os.tmpdir(), "openscreen-audio-timeline-tone.wav");
const madeTone = runTool(FFMPEG, [
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
]);
if (madeTone.status !== 0 || !fs.existsSync(tonePath)) {
	console.error("Could not synthesise the test tone.");
	process.exit(1);
}

const outputPath = path.join(os.tmpdir(), "openscreen-audio-timeline.mp4");
fs.rmSync(outputPath, { force: true });

const request = {
	outputPath,
	// `hidden`, not the app's `metadata`. The pointer is irrelevant to this measurement,
	// while metadata mode is a second, unrelated way for the run to fail — the helper
	// refuses to start on a compositor that does not advertise it — and it puts a
	// cursor-sample line on stdout every 33 ms, sprites included as data URLs.
	cursorMode: "hidden",
	video: { fps: 30 },
	audio: {
		system: { enabled: true },
		// No microphone on purpose: a live one streams continuously and would keep the
		// timeline moving on its own, hiding exactly the failure this measures. On
		// Windows that was not a choice — it is the state a broken microphone left
		// behind, and the reason #406 surfaced as a system-audio desync.
		microphone: { enabled: false, deviceName: null, gain: 1 },
	},
};

console.log(
	`Recording ${(PLAY_AT_MS + TONE_MS + TAIL_MS) / 1000}s: ${PLAY_AT_MS / 1000}s of silence, ` +
		`a ${TONE_MS / 1000}s tone through ${PLAYER.name}, then ${TAIL_MS / 1000}s of silence.`,
);
console.log("Answer the compositor's source picker when it appears — the take starts there.");

const proc = spawn(HELPER, [JSON.stringify(request)]);
let helperOutput = "";
let spawnError = null;
let playbackArmed = false;
const helperEvents = [];
proc.on("error", (error) => {
	spawnError = error.message;
});

/**
 * Arms the tone once the helper says it is capturing, never from spawn.
 *
 * `capture-started` is emitted from the same frame that sets the epoch, and the epoch is
 * what everything here is measured against: it is the instant the audio rings are cleared
 * and audio sample 0 begins. Counting from spawn would fold in the portal negotiation,
 * the picker, and however long the user took to answer it — an interval with no bound at
 * all, which would fail every run rather than a broken one.
 */
function armPlaybackOnce() {
	if (playbackArmed || !helperEvents.some((event) => event.event === "capture-started")) {
		return;
	}
	playbackArmed = true;
	setTimeout(() => {
		// Blocking on purpose: it guarantees the tone really played before the tail is
		// timed and the stop below is sent, which is the premise of the measurement.
		runTool(PLAYER, PLAYER.args(tonePath));
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
 * A `data` chunk is whatever the pipe had ready, not a whole line, so splitting each chunk
 * on its own newlines drops any event a read happened to bisect — both halves parse as
 * neither. Losing `capture-started` that way leaves the tone unarmed and the run hangs
 * until the picker timeout kills the helper, which reads as "nobody answered the picker"
 * rather than as a framing bug. Only stdout carries events; stderr is diagnostics and is
 * kept as raw text.
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
			const event = JSON.parse(trimmed);
			helperEvents.push(event);
			if (event.event === "stream-started") {
				console.log(`Streaming ${event.width}x${event.height}; waiting for the first frame...`);
			}
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

// If the picker is never answered, nothing would ever stop the helper — and it holds a
// portal session, so the compositor keeps saying the screen is being shared.
const startTimeout = setTimeout(() => {
	if (!playbackArmed) {
		console.error("Nothing was recorded: the source picker was never answered.");
		proc.kill();
	}
}, PICKER_TIMEOUT_MS);

/** Per-stream durations, which is what "does the audio cover the take" is asked of. */
function streamDurations() {
	const probed = runTool(
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
	const decoded = runTool(
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

	// Only if there was a take. A run that never got past the picker has no file to
	// measure, and "the recording has no audio track" would bury the line that says why.
	if (playbackArmed) {
		if (audio === null) {
			problems.push("the recording has no audio track at all");
		}
		if (toneAt === null) {
			problems.push(
				"no audible tone in the recording — check the tone played to the same sink the helper " +
					"monitored, and that it is not muted",
			);
		} else if (toneAt < TONE_TOLERANCE_S) {
			// The failure this exists for, named as itself: a timeline advanced by data
			// alone emits nothing until something plays, so the file BEGINS at the first
			// sound and the silence in front of it is not in the file at all.
			problems.push(
				`the recording begins at the tone (${toneAt.toFixed(2)}s), so the ${playedAt.toFixed(2)}s ` +
					"of silence before it is missing entirely",
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
					"the mixed track does not span the take",
			);
		}
	}

	// The ring stands in silence for anything it had to drop, so an overflow no longer
	// pulls the rest of the take earlier — but it is still a hole in the audio, and this
	// is the only place it is ever reported.
	for (const warning of helperEvents.filter((event) => event.code === "audio-dropped")) {
		problems.push(`the helper dropped audio: ${warning.message}`);
	}

	const stopped = helperEvents.findLast((event) => event.event === "capture-stopped");
	const source = helperEvents.find(
		(event) => event.event === "audio-source" && event.role === "system",
	);

	fs.rmSync(outputPath, { force: true });
	console.log(
		`\n${problems.length ? "FAIL" : "PASS"}  audio=${audio?.toFixed(2) ?? "(none)"}s  ` +
			`video=${video?.toFixed(2) ?? "(none)"}s  ` +
			`tone at ${toneAt === null ? "(none)" : `${toneAt.toFixed(2)}s`}, played at ${playedAt.toFixed(2)}s`,
	);
	if (stopped) {
		console.log(
			`      ${stopped.frames} frames written, ${(stopped.durationMs / 1000).toFixed(2)}s of video, ` +
				`${stopped.dropped} frame(s) dropped`,
		);
	}
	if (source) {
		// The first thing anyone needs when the tone is missing: the tap is the session
		// default sink's monitor, and the tone has to have played to that same sink.
		console.log(`      system audio came from ${source.node ?? "the session default sink"}`);
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
