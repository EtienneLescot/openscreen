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

		proc.on("close", () => {
			clearTimeout(stopTimer);
			clearTimeout(killTimer);
			fs.rmSync(outputPath, { force: true });
			fs.rmSync(webcamPath, { force: true });
			resolve({
				opened: output.match(/"event":"webcam-format".*?"deviceName":"([^"]*)"/)?.[1] ?? null,
				scores: [...output.matchAll(/candidate \[\d+\] name="([^"]*)" score=(\d+)/g)].map(
					(m) => `${m[1]}=${m[2]}`,
				),
			});
		});
	});
}

const cases = [
	{
		label: "shares-a-prefix-only",
		why: '"Logi Capture" is a real device, and shares no word with "Logitech StreamCam" — but "logi" is inside "logitech"',
		deviceName: "Logi Capture",
		expectOpened: null,
	},
	{
		label: "shares-a-brand-only",
		why: "another camera from the same maker is still another camera",
		deviceName: "Logitech BRIO",
		expectOpened: null,
	},
	{
		label: "nothing-like-it",
		why: "a name with nothing in common must resolve to nothing, so the caller can fall through",
		deviceName: "Elgato Facecam Pro",
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
for (const testCase of cases) {
	const result = await runHelper(testCase.label, testCase.deviceName);
	const ok =
		testCase.expectOpened === "any"
			? Boolean(result.opened)
			: result.opened === testCase.expectOpened;
	if (!ok) failures += 1;
	console.log(
		`${ok ? "PASS" : "FAIL"}  ${testCase.label.padEnd(22)} requested="${testCase.deviceName}" opened=${result.opened === null ? "(none)" : `"${result.opened}"`}`,
	);
	console.log(`      ${testCase.why}`);
	if (result.scores.length) console.log(`      scores: ${result.scores.join("  ")}`);
}

console.log(
	failures === 0
		? `\nAll ${cases.length} camera selection cases behaved.`
		: `\n${failures} of ${cases.length} cases did not.`,
);
process.exit(failures === 0 ? 0 : 1);
