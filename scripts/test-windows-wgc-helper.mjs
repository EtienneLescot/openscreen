import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const HELPER_PATH =
	process.env.OPENSCREEN_WGC_CAPTURE_EXE ??
	path.join(ROOT, "electron", "native", "bin", "win32-x64", "wgc-capture.exe");

const DURATION_MS = Number(process.env.OPENSCREEN_WGC_TEST_DURATION_MS ?? 5000);
const WITH_SYSTEM_AUDIO =
	process.env.OPENSCREEN_WGC_TEST_SYSTEM_AUDIO === "true" ||
	process.argv.includes("--system-audio");
const WITH_MICROPHONE =
	process.env.OPENSCREEN_WGC_TEST_MICROPHONE === "true" ||
	process.argv.includes("--microphone") ||
	process.argv.includes("--mic");
const WITH_WINDOW =
	process.env.OPENSCREEN_WGC_TEST_WINDOW === "true" || process.argv.includes("--window");
const WITH_WEBCAM =
	process.env.OPENSCREEN_WGC_TEST_WEBCAM === "true" || process.argv.includes("--webcam");
const CAPTURE_CURSOR =
	process.env.OPENSCREEN_WGC_TEST_CAPTURE_CURSOR === "true" ||
	process.argv.includes("--capture-cursor");
const WITH_SOFTWARE_ENCODER =
	process.env.OPENSCREEN_WGC_TEST_SOFTWARE_ENCODER === "true" ||
	process.argv.includes("--software-encoder");
const WITH_SOFTWARE_FALLBACK =
	process.env.OPENSCREEN_WGC_TEST_SOFTWARE_FALLBACK === "true" ||
	process.argv.includes("--software-fallback");
const INJECT_DEFAULT_SINK_WRITER_FAILURE_ENV =
	"OPENSCREEN_WGC_TEST_INJECT_DEFAULT_SINK_WRITER_FAILURE_ONCE";
const INJECTION_MARKER = "TEST-ONLY: Injected default sink-writer creation failure";
const STALL_READBACK_ENV = "OPENSCREEN_WGC_TEST_STALL_READBACK_MS";
/**
 * Reproduces issue #252 on ordinary hardware: holds the frame lock across a
 * stall the way a wedged GPU readback does. Before the fix the helper hung
 * forever with no `[stop-timing]` output at all; it must now always exit.
 */
const WITH_STALLED_READBACK =
	process.env.OPENSCREEN_WGC_TEST_STALL_READBACK === "true" ||
	process.argv.includes("--stall-readback");
const STALL_READBACK_MS = Number(process.env[STALL_READBACK_ENV] ?? 60_000);
const STALL_FRAME_CALLBACK_ENV = "OPENSCREEN_WGC_TEST_STALL_FRAME_CALLBACK_MS";
/**
 * Reproduces getopenscreen/openscreen#460 on ordinary hardware: stalls the WGC
 * frame *callback* itself while it holds the frame lock, the shape that issue
 * actually reproduced on Intel HD 520 ("A WGC frame callback did not finish").
 * Distinct from WITH_STALLED_READBACK above -- that stalls the writer's own
 * readback, which quiesceLegacyCallback()'s drain cannot see
 * (callbacksInFlight_ stays at zero), so it cannot exercise the
 * video-writer-join skip this stall exists to test.
 *
 * Forces the legacy push path on (below), because that is the only path with a
 * frame callback to stall: the default pull path has no WGC-owned thread, so
 * this scenario would otherwise stall nothing and assert on a skip that can
 * never be taken.
 */
const WITH_STALLED_FRAME_CALLBACK =
	process.env.OPENSCREEN_WGC_TEST_STALL_FRAME_CALLBACK === "true" ||
	process.argv.includes("--stall-frame-callback");
const STALL_FRAME_CALLBACK_MS = Number(process.env[STALL_FRAME_CALLBACK_ENV] ?? 60_000);
const LEGACY_FRAME_CALLBACK_ENV = "OPENSCREEN_WGC_LEGACY_FRAME_CALLBACK";
/**
 * Runs any scenario on the pre-#306 push-based delivery path instead of the
 * pull-based default -- the same lever a user gets, so a machine that only
 * fails one way can be A/B'd without swapping builds.
 */
const WITH_LEGACY_FRAME_CALLBACK =
	process.env.OPENSCREEN_WGC_LEGACY_FRAME_CALLBACK === "1" ||
	process.argv.includes("--legacy-frame-callback");
const STOP_BUDGET_ENV = "OPENSCREEN_WGC_STOP_BUDGET_MS";
/**
 * The helper's global shutdown ceiling, pinned into its environment below so
 * the harness and the helper cannot drift apart. It matters because the
 * encoder-finalize step is the one allowed to spend the whole ceiling — issue
 * #34 exists because a long software-encoder finalize legitimately takes
 * seconds — so a limit below it would kill a helper that was still working and
 * report it as the #252 hang.
 */
const STOP_BUDGET_MS = Number(process.env[STOP_BUDGET_ENV] ?? 50_000);
/** Past the helper's own ceiling it never ended itself, which IS issue #252. */
const STOP_HANG_LIMIT_MS = STOP_BUDGET_MS + 15_000;
/** A healthy stop is well under a second. */
const STOP_LATENCY_BUDGET_MS = 15_000;

if (WITH_SOFTWARE_ENCODER && WITH_SOFTWARE_FALLBACK) {
	throw new Error("--software-encoder and --software-fallback are mutually exclusive");
}

function runHelper(
	config,
	{
		injectDefaultSinkWriterFailure = false,
		stallReadbackMs = 0,
		stallFrameCallbackMs = 0,
		legacyFrameCallback = false,
	} = {},
) {
	return new Promise((resolve, reject) => {
		const env = { ...process.env };
		delete env[INJECT_DEFAULT_SINK_WRITER_FAILURE_ENV];
		delete env[STALL_READBACK_ENV];
		delete env[STALL_FRAME_CALLBACK_ENV];
		delete env[LEGACY_FRAME_CALLBACK_ENV];
		env[STOP_BUDGET_ENV] = String(STOP_BUDGET_MS);
		if (legacyFrameCallback) {
			env[LEGACY_FRAME_CALLBACK_ENV] = "1";
		}
		if (injectDefaultSinkWriterFailure) {
			env[INJECT_DEFAULT_SINK_WRITER_FAILURE_ENV] = "1";
		}
		if (stallReadbackMs > 0) {
			env[STALL_READBACK_ENV] = String(stallReadbackMs);
		}
		if (stallFrameCallbackMs > 0) {
			env[STALL_FRAME_CALLBACK_ENV] = String(stallFrameCallbackMs);
		}
		const child = spawn(HELPER_PATH, [JSON.stringify(config)], {
			env,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});

		let stdout = "";
		let stderr = "";
		let stopTimer = null;
		let stopSentAt = null;
		let stopHung = false;
		let hangTimer = null;
		const scheduleStop = () => {
			if (stopTimer) {
				return;
			}
			stopTimer = setTimeout(() => {
				stopSentAt = Date.now();
				child.stdin.write("stop\n");
				// The whole point of issues #115 and #252 was a helper that never
				// came back from `stop`. Without a bound here the harness inherits
				// the hang instead of reporting it.
				hangTimer = setTimeout(() => {
					stopHung = true;
					child.kill();
				}, STOP_HANG_LIMIT_MS);
			}, DURATION_MS);
		};
		const fallbackTimer = setTimeout(scheduleStop, 15_000);

		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
			if (stdout.includes('"recording-started"') || stdout.includes("Recording started")) {
				scheduleStop();
			}
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			clearTimeout(fallbackTimer);
			if (stopTimer) {
				clearTimeout(stopTimer);
			}
			if (hangTimer) {
				clearTimeout(hangTimer);
			}
			resolve({
				code,
				stdout,
				stderr,
				stopHung,
				stopLatencyMs: stopSentAt === null ? null : Date.now() - stopSentAt,
			});
		});
	});
}

/**
 * Every `[stop-timing]` step the helper *finished*, in order.
 *
 * `phase=begin` is the same step announced on entry, so counting both listed
 * every step twice. `phase=abandoned` is kept: that step did end, just badly.
 */
function readStopTimingSteps(stderr) {
	return [...stderr.matchAll(/\[stop-timing\]\s+step=(\S+)\s+elapsed_ms=\d+(?:\s+phase=(\S+))?/g)]
		.filter((match) => match[2] !== "begin")
		.map((match) => match[1]);
}

function assertStopWasClean(result) {
	if (result.stopHung) {
		throw new Error(
			`Helper did not exit within ${STOP_HANG_LIMIT_MS}ms of "stop" (issue #252). ` +
				`stop-timing steps seen: ${readStopTimingSteps(result.stderr).join(", ") || "none"}`,
		);
	}
	const steps = readStopTimingSteps(result.stderr);
	if (!steps.includes("command-received")) {
		throw new Error(
			'Helper never acknowledged the stop command ("[stop-timing] step=command-received").',
		);
	}
	if (steps.includes("wgc-session-close") === false) {
		throw new Error(
			`Helper stopped without completing its shutdown sequence. Steps: ${steps.join(", ")}`,
		);
	}
	if (result.stopLatencyMs !== null && result.stopLatencyMs > STOP_LATENCY_BUDGET_MS) {
		throw new Error(
			`Stop took ${result.stopLatencyMs}ms, over the ${STOP_LATENCY_BUDGET_MS}ms budget.`,
		);
	}
}

function startFixtureWindow() {
	return new Promise((resolve, reject) => {
		const child = spawn("mspaint.exe", [], {
			stdio: ["ignore", "ignore", "ignore"],
			windowsHide: false,
		});

		const poll = setInterval(() => {
			const lookup = spawnSync(
				"powershell",
				[
					"-NoProfile",
					"-Command",
					`(Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue).MainWindowHandle`,
				],
				{ encoding: "utf8", windowsHide: true },
			);
			const handle = lookup.stdout
				.trim()
				.split(/\r?\n/)
				.find((line) => /^\d+$/.test(line.trim()));
			if (handle && handle !== "0") {
				clearInterval(poll);
				clearTimeout(timer);
				resolve({ child, sourceId: `window:${handle.trim()}:0` });
			}
		}, 250);

		const timer = setTimeout(() => {
			clearInterval(poll);
			child.kill();
			reject(new Error("Timed out waiting for fixture window handle"));
		}, 10_000);
		child.once("error", (error) => {
			clearInterval(poll);
			clearTimeout(timer);
			reject(error);
		});
	});
}

/**
 * Windows Graphics Capture delivers frames on compositor damage, not on a
 * fixed clock -- on a genuinely idle desktop the frame pool can go a full
 * test run without ever firing FrameArrived once. That is invisible to most
 * of this harness, which just needs *a* frame eventually, but the
 * stalled-frame-callback regression check needs one to land *inside* the
 * DURATION_MS window specifically, so the stall this injects is actually the
 * thing holding the frame lock when `stop` arrives.
 *
 * Moving the cursor alone does not reliably do this: most modern GPU/driver
 * combinations composite the cursor on its own hardware overlay plane, so
 * repositioning it never touches the desktop bitmap WGC captures (confirmed
 * empirically here -- frames=0 with a cursor-only nudge running the whole
 * test). A visible window changing position is not optional the way the
 * cursor is; DWM has to redraw the area it moved across. Returns a stop
 * function; always call it, paired failure or not, or the window and its
 * PowerShell host outlive the test process.
 */
function startScreenActivity() {
	const child = spawn(
		"powershell",
		[
			"-NoProfile",
			"-Command",
			"Add-Type -AssemblyName System.Windows.Forms; " +
				"$f = New-Object System.Windows.Forms.Form; " +
				"$f.StartPosition = 'Manual'; $f.Location = New-Object System.Drawing.Point(0,0); " +
				"$f.Size = New-Object System.Drawing.Size(200,200); " +
				"$f.TopMost = $true; $f.Show(); " +
				"$x = 0; " +
				"while ($true) { " +
				"$f.Location = New-Object System.Drawing.Point($x, 0); " +
				"$x = ($x + 20) % 200; " +
				"[System.Windows.Forms.Application]::DoEvents(); " +
				"Start-Sleep -Milliseconds 100; " +
				"}",
		],
		{ stdio: ["ignore", "ignore", "ignore"], windowsHide: false },
	);
	return () => child.kill();
}

function normalizeDeviceName(value) {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

function scoreDeviceName(candidateName, candidateId, requestedName) {
	const candidate = normalizeDeviceName(candidateName ?? "");
	const id = normalizeDeviceName(candidateId ?? "");
	const requested = normalizeDeviceName(requestedName ?? "");
	if (!requested) return 0;
	if (candidate === requested) return 1000;
	if (candidate.includes(requested) || requested.includes(candidate)) return 900;
	if (id.includes(requested) || requested.includes(id)) return 800;
	return requested
		.split(/\s+/)
		.filter((word) => word.length > 1 && !["camera", "webcam", "video", "input"].includes(word))
		.reduce((score, word) => {
			if (candidate.includes(word)) return score + 100;
			if (id.includes(word)) return score + 50;
			return score;
		}, 0);
}

function resolveDirectShowWebcamClsid(requestedName) {
	if (!requestedName) return "";
	const query = spawnSync(
		"reg.exe",
		["query", "HKCR\\CLSID\\{860BB310-5D01-11D0-BD3B-00A0C911CE86}\\Instance", "/s"],
		{ encoding: "utf8", windowsHide: true },
	);
	if (query.status !== 0) return "";
	const entries = [];
	let current = {};
	for (const rawLine of query.stdout.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		if (/^HKEY_/i.test(line)) {
			if (current.friendlyName || current.clsid) entries.push(current);
			current = {};
			continue;
		}
		const match = line.match(/^(\S+)\s+REG_SZ\s+(.+)$/);
		if (!match) continue;
		if (match[1] === "FriendlyName") current.friendlyName = match[2].trim();
		if (match[1] === "CLSID") current.clsid = match[2].trim();
	}
	if (current.friendlyName || current.clsid) entries.push(current);

	let best = null;
	for (const entry of entries) {
		if (!entry.clsid) continue;
		const score = scoreDeviceName(entry.friendlyName, entry.clsid, requestedName);
		if (!best || score > best.score) {
			best = { ...entry, score };
		}
	}
	return best && best.score > 0 ? best.clsid : "";
}

function probeStreams(outputPath) {
	const ffprobe = spawnSync(
		"ffprobe",
		["-v", "error", "-show_streams", "-of", "json", outputPath],
		{ encoding: "utf8", windowsHide: true },
	);
	if (ffprobe.status !== 0) {
		throw new Error(`ffprobe failed: ${ffprobe.stderr || ffprobe.stdout}`);
	}
	return JSON.parse(ffprobe.stdout).streams ?? [];
}

/**
 * The property the fragmented container exists for, checked without having to
 * kill anything: a fragmented MP4 carries its index up front and its samples in
 * self-describing `moof`+`mdat` pairs, so a prefix of the file still decodes. A
 * plain MP4 only becomes readable when `Finalize()` writes `moov` at the end,
 * which is exactly the call the shutdown watchdog's `TerminateProcess`
 * pre-empts in issues #252 / #292 / #327.
 *
 * Truncating a copy is a proxy for that kill, not a replacement: it proves the
 * container survives losing its tail. It does not prove the helper flushed
 * anything before dying, which only the real kill test can.
 */
function assertPrefixIsReadable(outputPath) {
	const truncatedPath = `${outputPath}.truncated.mp4`;
	const source = fs.readFileSync(outputPath);
	fs.writeFileSync(truncatedPath, source.subarray(0, Math.floor(source.length * 0.6)));
	try {
		// A plain MP4 does not merely lose its tail here, it fails to open at
		// all ("moov atom not found"), so the throw and the empty result are the
		// same finding and get the same message.
		let truncatedStreams = [];
		try {
			truncatedStreams = probeStreams(truncatedPath);
		} catch {
			truncatedStreams = [];
		}
		if (!truncatedStreams.some((stream) => stream.codec_name === "h264")) {
			throw new Error(
				`A 60% prefix of ${outputPath} has no readable H.264 stream, so the recording is ` +
					"still all-or-nothing: the container is not fragmented.",
			);
		}
	} finally {
		fs.rmSync(truncatedPath, { force: true });
	}
}

function measureFirstFrameLuma(outputPath) {
	const ffmpeg = spawnSync(
		"ffmpeg",
		[
			"-v",
			"error",
			"-i",
			outputPath,
			"-frames:v",
			"1",
			"-f",
			"rawvideo",
			"-pix_fmt",
			"gray",
			"pipe:1",
		],
		{ windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
	);
	if (ffmpeg.status !== 0) {
		throw new Error(`ffmpeg frame extraction failed: ${ffmpeg.stderr?.toString() ?? ""}`);
	}
	const data = ffmpeg.stdout;
	if (!data || data.length === 0) {
		throw new Error(`ffmpeg did not return frame data for ${outputPath}`);
	}
	let sum = 0;
	let max = 0;
	for (const value of data) {
		sum += value;
		if (value > max) {
			max = value;
		}
	}
	return { average: sum / data.length, max };
}

if (process.platform !== "win32") {
	console.log("Skipping WGC helper smoke test: Windows-only.");
	process.exit(0);
}

if (!fs.existsSync(HELPER_PATH)) {
	throw new Error(`WGC helper not found at ${HELPER_PATH}. Run npm run build:native:win first.`);
}

const outputPath = path.join(
	os.tmpdir(),
	`openscreen-wgc-helper-${WITH_WEBCAM ? "webcam" : WITH_WINDOW ? "window" : WITH_SYSTEM_AUDIO || WITH_MICROPHONE ? "audio" : "video"}-${process.pid}-${Date.now()}-${randomUUID()}.mp4`,
);
const webcamOutputPath = WITH_WEBCAM ? outputPath.replace(/\.mp4$/i, "-webcam.mp4") : null;

const fixtureWindow = WITH_WINDOW ? await startFixtureWindow() : null;

const config = {
	schemaVersion: 2,
	recordingId: Date.now(),
	preferSoftwareEncoder: WITH_SOFTWARE_ENCODER,
	outputPath,
	sourceType: fixtureWindow ? "window" : "display",
	sourceId: fixtureWindow ? fixtureWindow.sourceId : "screen:0:0",
	displayId: 0,
	fps: 30,
	videoWidth: 1280,
	videoHeight: 720,
	// Same reasoning as scripts/diagnostic-tool/diagnostic.mjs: without Electron
	// there is no honest display rect to send, and the helper reads these as
	// physical pixels. Omitting them lands on the primary monitor
	// deterministically instead of by accident (#346).
	hasDisplayBounds: false,
	captureSystemAudio: WITH_SYSTEM_AUDIO,
	captureMic: WITH_MICROPHONE,
	captureCursor: CAPTURE_CURSOR,
	microphoneDeviceId: process.env.OPENSCREEN_WGC_TEST_MICROPHONE_DEVICE_ID ?? "default",
	microphoneDeviceName: process.env.OPENSCREEN_WGC_TEST_MICROPHONE_DEVICE_NAME ?? "",
	microphoneGain: 1.4,
	webcamEnabled: WITH_WEBCAM,
	webcamDeviceId: process.env.OPENSCREEN_WGC_TEST_WEBCAM_DEVICE_ID ?? "",
	webcamDeviceName: process.env.OPENSCREEN_WGC_TEST_WEBCAM_DEVICE_NAME ?? "",
	webcamDirectShowClsid: resolveDirectShowWebcamClsid(
		process.env.OPENSCREEN_WGC_TEST_WEBCAM_DEVICE_NAME ?? "",
	),
	webcamWidth: 640,
	webcamHeight: 360,
	webcamFps: 30,
	outputs: {
		screenPath: outputPath,
		...(webcamOutputPath ? { webcamPath: webcamOutputPath } : {}),
	},
};

const stopScreenActivity = WITH_STALLED_FRAME_CALLBACK ? startScreenActivity() : null;
let result;
try {
	result = await runHelper(config, {
		injectDefaultSinkWriterFailure: WITH_SOFTWARE_FALLBACK,
		stallReadbackMs: WITH_STALLED_READBACK ? STALL_READBACK_MS : 0,
		stallFrameCallbackMs: WITH_STALLED_FRAME_CALLBACK ? STALL_FRAME_CALLBACK_MS : 0,
		legacyFrameCallback: WITH_LEGACY_FRAME_CALLBACK || WITH_STALLED_FRAME_CALLBACK,
	});
} finally {
	if (fixtureWindow) {
		fixtureWindow.child.kill();
	}
	stopScreenActivity?.();
}

// The regression check for issue #252. With the frame lock deliberately wedged
// there is no usable recording to assert on -- what matters is only that the
// helper still noticed the stop and still died, naming the step it died in.
if (WITH_STALLED_READBACK) {
	if (result.stopHung) {
		throw new Error(
			`Helper survived ${STOP_HANG_LIMIT_MS}ms past "stop" with a stalled readback. ` +
				"Its shutdown watchdog did not fire (issue #252).",
		);
	}
	const steps = readStopTimingSteps(result.stderr);
	if (!steps.includes("command-received")) {
		throw new Error(`Helper never acknowledged "stop". Steps seen: ${steps.join(", ") || "none"}`);
	}
	if (!/phase=abandoned/.test(result.stderr)) {
		throw new Error(
			`Helper exited without reporting an abandoned shutdown step. stderr:\n${result.stderr}`,
		);
	}
	console.log("WGC helper stalled-readback stop check passed", {
		stopLatencyMs: result.stopLatencyMs,
		steps,
		abandoned: result.stderr.match(/step=(\S+)\s+elapsed_ms=\d+\s+phase=abandoned/)?.[1] ?? null,
	});
	fs.rmSync(outputPath, { force: true });
	process.exit(0);
}

// The regression check for getopenscreen/openscreen#460: a frame callback
// wedged inside the driver, confirmed on real hardware via a Save Diagnostics
// report. Before the fix, video-writer-join burned its whole step budget
// joining a thread parked behind that same stuck callback -- this asserts
// both that the helper still exits promptly (not the ~13s that step's own
// budget alone would cost) and that it took the specific skip path rather
// than any other route to exiting.
if (WITH_STALLED_FRAME_CALLBACK) {
	if (result.stopHung) {
		throw new Error(
			`Helper survived ${STOP_HANG_LIMIT_MS}ms past "stop" with a stalled frame callback. ` +
				"Its shutdown watchdog did not fire (issue #460).",
		);
	}
	const steps = readStopTimingSteps(result.stderr);
	if (!steps.includes("command-received")) {
		throw new Error(`Helper never acknowledged "stop". Steps seen: ${steps.join(", ") || "none"}`);
	}
	if (!result.stderr.includes("reason=frame-callback-stuck")) {
		throw new Error(
			`Helper did not take the video-writer-join skip path. stderr:\n${result.stderr}`,
		);
	}
	// wgc-quiesce's own drain is a fixed 5000ms, so a healthy skip lands
	// there plus the near-instant audio/microphone/webcam steps -- nowhere
	// near the ~13s (5s drain + the 8s step budget) the join it replaces
	// would have cost before this fix.
	const STALLED_FRAME_CALLBACK_LATENCY_BUDGET_MS = 10_000;
	if (
		result.stopLatencyMs !== null &&
		result.stopLatencyMs > STALLED_FRAME_CALLBACK_LATENCY_BUDGET_MS
	) {
		throw new Error(
			`Stop took ${result.stopLatencyMs}ms with a stalled frame callback, over the ` +
				`${STALLED_FRAME_CALLBACK_LATENCY_BUDGET_MS}ms budget the video-writer-join skip should keep it under.`,
		);
	}
	console.log("WGC helper stalled-frame-callback stop check passed", {
		stopLatencyMs: result.stopLatencyMs,
		steps,
	});
	fs.rmSync(outputPath, { force: true });
	process.exit(0);
}

assertStopWasClean(result);

if (result.code !== 0) {
	if (
		WITH_WEBCAM &&
		/No native Windows webcam devices were found|Failed to initialize native webcam/.test(
			result.stderr,
		)
	) {
		console.log("Skipping WGC webcam smoke test: no native Windows webcam device is available.");
		process.exit(0);
	}
	throw new Error(`WGC helper exited with ${result.code}\n${result.stdout}\n${result.stderr}`);
}
if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
	throw new Error(`WGC helper did not produce a video at ${outputPath}`);
}
if (WITH_WEBCAM && (!fs.existsSync(webcamOutputPath) || fs.statSync(webcamOutputPath).size === 0)) {
	throw new Error(`WGC helper did not produce a webcam video at ${webcamOutputPath}`);
}

const streams = probeStreams(outputPath);
const webcamStreams =
	webcamOutputPath && fs.existsSync(webcamOutputPath) ? probeStreams(webcamOutputPath) : [];
const hasVideo = streams.some((stream) => stream.codec_type === "video");
const hasAudio = streams.some((stream) => stream.codec_type === "audio");
const videoStream = streams.find((stream) => stream.codec_type === "video");
const webcamFormatLine = result.stdout
	.split(/\r?\n/)
	.find((line) => line.includes('"event":"webcam-format"'));
const webcamFormat = webcamFormatLine ? JSON.parse(webcamFormatLine) : null;
const audioFormatLine = result.stdout
	.split(/\r?\n/)
	.find((line) => line.includes('"event":"audio-format"'));
const audioFormat = audioFormatLine ? JSON.parse(audioFormatLine) : null;
const cursorCaptureLine = result.stdout
	.split(/\r?\n/)
	.find((line) => line.includes('"event":"cursor-capture"'));
const cursorCapture = cursorCaptureLine ? JSON.parse(cursorCaptureLine) : null;
const encoderSelectionLine = result.stdout
	.split(/\r?\n/)
	.find((line) => line.includes('"event":"encoder-selection"'));
const encoderSelection = encoderSelectionLine ? JSON.parse(encoderSelectionLine) : null;
const nativeWebcamDiagnostics = result.stderr
	.split(/\r?\n/)
	.filter((line) => line.includes("Native webcam candidate"));
const nativeMicrophoneDiagnostics = result.stderr
	.split(/\r?\n/)
	.filter(
		(line) =>
			line.includes("Native microphone candidate") ||
			line.includes("Selected native microphone endpoint"),
	);
if (!hasVideo) {
	throw new Error(`WGC helper output has no video stream: ${outputPath}`);
}
if (videoStream.codec_name !== "h264") {
	throw new Error(
		`WGC helper output video codec is ${videoStream.codec_name ?? "unknown"}, expected h264: ${outputPath}`,
	);
}
const videoDurationSeconds = Number(videoStream.duration);
const minimumPlausibleDurationSeconds = Math.max(0.5, (DURATION_MS / 1000) * 0.5);
const maximumPlausibleDurationSeconds = Math.max(
	minimumPlausibleDurationSeconds,
	(DURATION_MS / 1000) * 2 + 2,
);
if (
	!Number.isFinite(videoDurationSeconds) ||
	videoDurationSeconds < minimumPlausibleDurationSeconds ||
	videoDurationSeconds > maximumPlausibleDurationSeconds
) {
	throw new Error(
		`WGC helper output duration ${videoStream.duration ?? "unknown"}s is not plausible for a ${DURATION_MS}ms recording: ${outputPath}`,
	);
}
if (WITH_WEBCAM && !webcamStreams.some((stream) => stream.codec_type === "video")) {
	throw new Error(`WGC helper webcam output has no video stream: ${webcamOutputPath}`);
}
if (
	(CAPTURE_CURSOR && !cursorCapture) ||
	(cursorCapture &&
		(cursorCapture.requested !== CAPTURE_CURSOR || cursorCapture.applied !== CAPTURE_CURSOR))
) {
	throw new Error(
		`WGC helper did not apply requested cursor capture mode (${CAPTURE_CURSOR}): ${result.stdout}`,
	);
}
const expectedEncoderSelection = WITH_SOFTWARE_FALLBACK
	? "software-fallback"
	: WITH_SOFTWARE_ENCODER
		? "software-preferred"
		: "default";
if (
	encoderSelection?.video !== expectedEncoderSelection ||
	encoderSelection.preferSoftwareEncoder !== WITH_SOFTWARE_ENCODER
) {
	throw new Error(
		`WGC helper encoder selection was ${JSON.stringify(encoderSelection)}, expected ${expectedEncoderSelection} with preferSoftwareEncoder=${WITH_SOFTWARE_ENCODER}: ${result.stdout}`,
	);
}
// videoEncoderRuntime is separate from `video` above: it is what
// GetTransformForStream found in the sink writer's own resolved pipeline
// after BeginWriting(), not which configuration path was tried. "unknown"
// here on a run that otherwise passed means the introspection itself is
// broken (wrong COM call, wrong category, wrong attribute), not a real
// ambiguity -- a healthy sink writer always has exactly one encoder node.
if (!["hardware", "software", "unknown"].includes(encoderSelection.videoEncoderRuntime)) {
	throw new Error(
		`WGC helper reported an unrecognised videoEncoderRuntime: ${JSON.stringify(encoderSelection)}`,
	);
}
if (encoderSelection.videoEncoderRuntime === "unknown") {
	throw new Error(
		`WGC helper could not introspect its own sink writer for videoEncoderRuntime: ${JSON.stringify(encoderSelection)}`,
	);
}
// forceSoftwareEncoder disables hardware transforms explicitly
// (MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS=FALSE), so this is deterministic
// regardless of what the test machine has registered -- unlike the "default"
// path, whose runtime legitimately depends on the machine.
if (
	(WITH_SOFTWARE_ENCODER || WITH_SOFTWARE_FALLBACK) &&
	encoderSelection.videoEncoderRuntime !== "software"
) {
	throw new Error(
		`WGC helper forced the software encoder but videoEncoderRuntime was ${encoderSelection.videoEncoderRuntime}, expected software: ${JSON.stringify(encoderSelection)}`,
	);
}
// Every fallback path has to stay fragmented, not just the nominal one. The
// helper degrades to the plain container rather than failing a recording, so
// without this the fix could quietly stop applying and every other assertion
// here would still pass.
if (encoderSelection.container !== "fragmented-mp4") {
	throw new Error(
		`WGC helper wrote a ${encoderSelection.container} container, expected fragmented-mp4: ${result.stdout}`,
	);
}
assertPrefixIsReadable(outputPath);
if (webcamOutputPath && fs.existsSync(webcamOutputPath)) {
	assertPrefixIsReadable(webcamOutputPath);
}

const combinedHelperOutput = `${result.stdout}\n${result.stderr}`;
const helperDiagnosticLines = combinedHelperOutput.split(/\r?\n/).filter(Boolean);
const injectionLines = helperDiagnosticLines.filter((line) => line.includes(INJECTION_MARKER));
const fallbackDiagnosticPatterns = [
	INJECTION_MARKER,
	"WARNING: Sink-writer creation failed (hr=0x80070003)",
	"retrying with the Microsoft software H.264 encoder.",
	"INFO: Registered the Microsoft software H.264 MFT locally for this helper process.",
	"INFO: Created the real software H.264 sink writer successfully.",
];
const fallbackDiagnostics = WITH_SOFTWARE_FALLBACK
	? helperDiagnosticLines.filter((line) =>
			fallbackDiagnosticPatterns.some((pattern) => line.includes(pattern)),
		)
	: [];
if (WITH_SOFTWARE_FALLBACK) {
	if (
		injectionLines.length !== 1 ||
		!injectionLines[0].includes("hr=0x80070003") ||
		!injectionLines[0].includes("consumed exactly once")
	) {
		throw new Error(
			`Expected exactly one consumed 0x80070003 test-only injection, found ${injectionLines.length}: ${combinedHelperOutput}`,
		);
	}
	for (const pattern of fallbackDiagnosticPatterns.slice(1)) {
		if (!helperDiagnosticLines.some((line) => line.includes(pattern))) {
			throw new Error(
				`WGC helper fallback diagnostics are missing ${JSON.stringify(pattern)}: ${combinedHelperOutput}`,
			);
		}
	}
} else if (injectionLines.length !== 0) {
	throw new Error(
		`WGC helper unexpectedly injected a default sink-writer failure: ${combinedHelperOutput}`,
	);
}
if ((WITH_SYSTEM_AUDIO || WITH_MICROPHONE) && !hasAudio) {
	throw new Error(`WGC helper output has no audio stream: ${outputPath}`);
}
const frameLuma = measureFirstFrameLuma(outputPath);
if (frameLuma.average < 1 && frameLuma.max < 5) {
	throw new Error(
		`WGC helper output first frame is black: ${outputPath}\n${result.stdout}\n${result.stderr}`,
	);
}

console.log(
	JSON.stringify(
		{
			success: true,
			stopLatencyMs: result.stopLatencyMs,
			stopTimingSteps: readStopTimingSteps(result.stderr),
			outputPath,
			webcamOutputPath,
			bytes: fs.statSync(outputPath).size,
			webcamBytes:
				webcamOutputPath && fs.existsSync(webcamOutputPath)
					? fs.statSync(webcamOutputPath).size
					: undefined,
			streams: streams.map((stream) => ({
				index: stream.index,
				codecType: stream.codec_type,
				codecName: stream.codec_name,
				duration: stream.duration,
			})),
			webcamStreams: webcamStreams.map((stream) => ({
				index: stream.index,
				codecType: stream.codec_type,
				codecName: stream.codec_name,
				width: stream.width,
				height: stream.height,
				duration: stream.duration,
			})),
			cursorCapture,
			encoderSelection,
			selectedMicrophoneDeviceName: audioFormat?.microphoneDeviceName,
			selectedWebcamDeviceName: webcamFormat?.deviceName,
			nativeMicrophoneDiagnostics,
			nativeWebcamDiagnostics,
			fallbackDiagnostics,
			firstFrameLuma: frameLuma,
		},
		null,
		2,
	),
);
