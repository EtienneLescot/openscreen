/**
 * Which camera does the helper actually open?
 *
 * Media Foundation and DirectShow cannot run on Linux CI and there is no C++
 * test harness here, so the selection rules are checked the only way that proves
 * anything: by driving the real helper on a real Windows machine and reading
 * back what it says it opened.
 *
 * What is pinned is that a requested name either resolves to THAT camera or to
 * none at all. A name matching nothing must score zero, because zero is what
 * sends the request on to the DirectShow fallback — the provider that holds
 * every camera Media Foundation cannot enumerate, NVIDIA Broadcast among them. A
 * near-miss that scores instead opens the wrong camera and the fallback is never
 * reached (getopenscreen/openscreen#405).
 *
 *   npm run test:wgc-camera-selection:win
 *
 * The happy path needs a camera that exists here: pass its name through
 * OPENSCREEN_WGC_TEST_WEBCAM_DEVICE_NAME, or that case is skipped.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const HELPER =
	process.env.OPENSCREEN_WGC_CAPTURE_EXE ??
	path.join(ROOT, "electron", "native", "bin", "win32-x64", "wgc-capture.exe");
const REAL_CAMERA = process.env.OPENSCREEN_WGC_TEST_WEBCAM_DEVICE_NAME ?? "";
const RECORD_MS = Number(process.env.OPENSCREEN_WGC_TEST_DURATION_MS ?? 2500);

if (process.platform !== "win32") {
	console.log("Windows only — skipping.");
	process.exit(0);
}
if (!fs.existsSync(HELPER)) {
	console.error(`Helper not found at ${HELPER}. Run: npm run build:native:win`);
	process.exit(1);
}

function runHelper(label, webcamDeviceName) {
	return new Promise((resolve) => {
		const outputPath = path.join(os.tmpdir(), `wgc-cam-${label}.mp4`);
		const webcamPath = path.join(os.tmpdir(), `wgc-cam-${label}-webcam.mp4`);
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
			captureSystemAudio: false,
			captureMic: false,
			captureCursor: false,
			webcamEnabled: true,
			webcamDeviceId: "",
			webcamDeviceName,
			// Deliberately empty: this exercises the Media Foundation matcher alone,
			// so a name that fits nothing has nowhere else to go and the mistake is
			// visible rather than papered over by the DirectShow fallback.
			webcamDirectShowClsid: "",
			webcamPath,
			webcamWidth: 0,
			webcamHeight: 0,
			webcamFps: 30,
			cursorCaptureMode: "editable-overlay",
		};

		const proc = spawn(HELPER, [JSON.stringify(config)], { windowsHide: true });
		let output = "";
		let spawnError = null;
		proc.on("error", (error) => {
			spawnError = error.message;
		});
		proc.stdout.on("data", (chunk) => {
			output += chunk.toString();
		});
		proc.stderr.on("data", (chunk) => {
			output += chunk.toString();
		});
		const stopTimer = setTimeout(() => {
			try {
				proc.stdin.write("stop\n");
			} catch {
				// Already gone; the kill below is the backstop.
			}
		}, RECORD_MS);
		const killTimer = setTimeout(() => proc.kill(), RECORD_MS + 6000);

		proc.on("close", (code, signal) => {
			clearTimeout(stopTimer);
			clearTimeout(killTimer);
			fs.rmSync(outputPath, { force: true });
			fs.rmSync(webcamPath, { force: true });
			resolve({
				// A helper that dies can still have printed everything expected, so
				// how it ended is part of the result rather than something to skip.
				spawnError,
				code,
				signal,
				opened: output.match(/"event":"webcam-format".*?"deviceName":"([^"]*)"/)?.[1] ?? null,
				// Which cameras Media Foundation actually offered. A negative case
				// proves nothing if the camera it was meant to be tempted by was
				// not among them.
				candidates: [...output.matchAll(/candidate \[\d+\] name="([^"]*)" score=(\d+)/g)].map(
					(match) => ({ name: match[1], score: Number(match[2]) }),
				),
			});
		});
	});
}

/**
 * `tempts` names the camera each negative case exists to be tempted by. Without
 * it a case passes on a machine where that camera is simply absent — nothing was
 * opened, but nothing could have been, and the rule under test was never
 * exercised. Cases naming one that is not enumerated here are skipped and say
 * so, rather than reporting a pass they did not earn.
 */
const cases = [
	{
		label: "shares-a-prefix-only",
		why: '"Logi Capture" is a real device, and shares no word with "Logitech StreamCam" — but "logi" is inside "logitech"',
		deviceName: "Logi Capture",
		tempts: "Logitech StreamCam",
		expectOpened: null,
	},
	{
		label: "shares-a-brand-only",
		why: "another camera from the same maker is still another camera",
		deviceName: "Logitech BRIO",
		tempts: "Logitech StreamCam",
		expectOpened: null,
	},
	{
		label: "short-word-inside-a-brand",
		why: '"Logi" is spelled inside "Logitech", but is not a word of it',
		deviceName: "Logi",
		tempts: "Logitech StreamCam",
		expectOpened: null,
	},
	{
		label: "nothing-like-it",
		why: "a name with nothing in common must resolve to nothing, so the caller can fall through",
		deviceName: "Elgato Facecam Pro",
		// Nothing in particular tempts this one; any enumerated camera will do.
		tempts: null,
		expectOpened: null,
	},
];

if (REAL_CAMERA) {
	cases.push({
		label: "real-device-name",
		why: "the happy path: a camera that exists resolves to itself",
		deviceName: REAL_CAMERA,
		expectOpened: "any",
	});
} else {
	console.log(
		"NOTE: set OPENSCREEN_WGC_TEST_WEBCAM_DEVICE_NAME to a real camera to cover the happy path.\n",
	);
}

let failures = 0;
let skipped = 0;
for (const testCase of cases) {
	const result = await runHelper(testCase.label, testCase.deviceName);

	const problems = [];
	if (result.spawnError) problems.push(`could not start the helper: ${result.spawnError}`);
	if (result.signal) problems.push(`helper killed by ${result.signal}`);
	if (result.code !== 0 && result.code !== null) problems.push(`helper exited ${result.code}`);

	// The camera this case exists to be tempted by has to be on offer, or the
	// rule under test was never exercised and a pass would mean nothing.
	const temptationPresent =
		testCase.tempts === null
			? result.candidates.length > 0
			: result.candidates.some((candidate) => candidate.name === testCase.tempts);
	if (testCase.expectOpened === null && !problems.length && !temptationPresent) {
		skipped += 1;
		console.log(
			`SKIP  ${testCase.label.padEnd(22)} requested="${testCase.deviceName}" — ${testCase.tempts ?? "no camera"} was not enumerated here`,
		);
		console.log(`      ${testCase.why}`);
		continue;
	}

	if (testCase.expectOpened === "any") {
		if (!result.opened) problems.push("nothing was opened");
	} else {
		if (result.opened) problems.push(`opened "${result.opened}", and should have opened nothing`);
		const scored = result.candidates.filter((candidate) => candidate.score > 0);
		if (scored.length) {
			problems.push(
				`something scored above zero: ${scored.map((c) => `${c.name}=${c.score}`).join(", ")}`,
			);
		}
	}

	if (problems.length) failures += 1;
	console.log(
		`${problems.length ? "FAIL" : "PASS"}  ${testCase.label.padEnd(22)} requested="${testCase.deviceName}" opened=${result.opened === null ? "(none)" : `"${result.opened}"`}`,
	);
	console.log(`      ${testCase.why}`);
	if (result.candidates.length) {
		console.log(
			`      enumerated: ${result.candidates.map((c) => `${c.name}=${c.score}`).join("  ")}`,
		);
	}
	for (const problem of problems) console.log(`      -> ${problem}`);
}

console.log(
	failures === 0
		? `\nAll ${cases.length - skipped} camera selection cases behaved${skipped ? `, ${skipped} skipped for want of the camera they test against` : ""}.`
		: `\n${failures} of ${cases.length} cases did not.`,
);
process.exit(failures === 0 ? 0 : 1);
