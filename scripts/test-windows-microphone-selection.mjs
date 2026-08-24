/**
 * Which microphone does the helper actually open?
 *
 * WASAPI cannot run on Linux CI and there is no C++ test harness here, so the
 * selection rules are checked the only way that proves anything: by driving the
 * real helper on a real Windows machine and reading what it says it chose.
 *
 * What is being pinned is the pair of promises the recording flow rests on —
 * the microphone the user asked for is the one recorded, and when it cannot be
 * found the helper SAYS SO instead of quietly capturing something else
 * (getopenscreen/openscreen#404). The second half needs the first: a fuzzy name
 * match that resolved "some microphone" made the warning unreachable, because a
 * device had after all been resolved.
 *
 *   npm run test:wgc-mic-selection:win
 *
 * Case 4 needs a real microphone name; pass one that exists on this machine
 * through OPENSCREEN_WGC_TEST_MICROPHONE_DEVICE_NAME, or it is skipped.
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
const REAL_MIC_NAME = process.env.OPENSCREEN_WGC_TEST_MICROPHONE_DEVICE_NAME ?? "";
const RECORD_MS = Number(process.env.OPENSCREEN_WGC_TEST_DURATION_MS ?? 2500);

if (process.platform !== "win32") {
	console.log("Windows only — skipping.");
	process.exit(0);
}
if (!fs.existsSync(HELPER)) {
	console.error(`Helper not found at ${HELPER}. Run: npm run build:native:win`);
	process.exit(1);
}

function runHelper(label, microphoneDeviceId, microphoneDeviceName) {
	return new Promise((resolve) => {
		const outputPath = path.join(os.tmpdir(), `wgc-mic-${label}.mp4`);
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
			captureMic: true,
			microphoneDeviceId,
			microphoneDeviceName,
			microphoneGain: 1,
			webcamEnabled: false,
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
				// The helper may already be gone; the kill below is the backstop.
			}
		}, RECORD_MS);
		const killTimer = setTimeout(() => proc.kill(), RECORD_MS + 6000);

		proc.on("close", (code, signal) => {
			clearTimeout(stopTimer);
			clearTimeout(killTimer);
			fs.rmSync(outputPath, { force: true });
			resolve({
				// A helper that dies can still have printed everything expected, so
				// how it ended is part of the result rather than something to skip.
				spawnError,
				code,
				signal,
				defaulted: output.includes('"code":"microphone-defaulted"'),
				selected: output.match(/"microphoneDeviceName":"([^"]*)"/)?.[1] ?? null,
				// Which endpoints the helper actually saw. A negative case proves
				// nothing if the device it was meant to be tempted by was absent.
				candidates: [...output.matchAll(/Native microphone candidate: (.+?) score=(\d+)/g)].map(
					(match) => ({ name: match[1].trim(), score: Number(match[2]) }),
				),
			});
		});
	});
}

const cases = [
	{
		label: "unresolvable-id-no-name",
		why: "the reported bug: a browser device id the helper cannot resolve, and no name to fall back on",
		deviceId: "0f6a4c1e9b2d47a3ba55d8e01c7f9a24",
		deviceName: "",
		expectDefaulted: true,
	},
	{
		label: "name-matches-nothing",
		why: "a name was supplied and matches no endpoint — the match must not invent one",
		deviceId: "",
		deviceName: "A Microphone That Is Not Here",
		expectDefaulted: true,
	},
	{
		label: "short-word-inside-a-name",
		why: '"Micro" sits inside the "Microphone" that opens nearly every Windows endpoint name — containment must be whole words',
		deviceId: "",
		deviceName: "Micro",
		expectDefaulted: true,
	},
	{
		label: "short-word-inside-a-brand",
		why: '"Logi" sits inside "Logitech" — the same mistake one word along',
		deviceId: "",
		deviceName: "Logi",
		expectDefaulted: true,
	},
	{
		label: "shares-a-brand-only",
		why: "another device from the same maker is still another device — a shared brand must not answer for it",
		deviceId: "",
		deviceName: "Logitech Blue Yeti",
		expectDefaulted: true,
	},
	{
		label: "plain-default-request",
		why: "no particular device was asked for, so the default endpoint is the right answer and no warning is due",
		deviceId: "default",
		deviceName: "",
		expectDefaulted: false,
	},
];

if (REAL_MIC_NAME) {
	cases.push({
		label: "real-device-name",
		why: "the happy path: a name that exists resolves, and stays silent",
		deviceId: "",
		deviceName: REAL_MIC_NAME,
		expectDefaulted: false,
		expectSelectedToMatch: true,
	});
} else {
	console.log(
		"NOTE: set OPENSCREEN_WGC_TEST_MICROPHONE_DEVICE_NAME to a real microphone to cover the happy path.\n",
	);
}

let failures = 0;
for (const testCase of cases) {
	const result = await runHelper(testCase.label, testCase.deviceId, testCase.deviceName);

	const problems = [];
	if (result.spawnError) problems.push(`could not start the helper: ${result.spawnError}`);
	if (result.signal) problems.push(`helper killed by ${result.signal}`);
	if (result.code !== 0 && result.code !== null) problems.push(`helper exited ${result.code}`);
	if (result.defaulted !== testCase.expectDefaulted) {
		problems.push(`defaulted=${result.defaulted}, expected ${testCase.expectDefaulted}`);
	}
	// A case that supplies a name is only meaningful if the helper had endpoints
	// to be tempted by; with none enumerated it would pass whatever the rules
	// say. A case supplying no name never reaches enumeration at all, and that
	// short circuit IS the behaviour under test there.
	const scoringWasExercised = testCase.deviceName !== "";
	if (testCase.expectDefaulted && scoringWasExercised && result.candidates.length === 0) {
		problems.push("no endpoint was enumerated, so this case proves nothing");
	}
	if (testCase.expectDefaulted && result.candidates.some((c) => c.score > 0)) {
		const scored = result.candidates
			.filter((c) => c.score > 0)
			.map((c) => `${c.name}=${c.score}`)
			.join(", ");
		problems.push(`something scored above zero: ${scored}`);
	}
	if (testCase.expectSelectedToMatch) {
		const matches = Boolean(result.selected) && testCase.deviceName.includes(result.selected);
		if (!matches) problems.push(`opened "${result.selected}", which is not what was asked for`);
	}

	if (problems.length) failures += 1;
	console.log(
		`${problems.length ? "FAIL" : "PASS"}  ${testCase.label.padEnd(24)} defaulted=${String(result.defaulted).padEnd(5)} opened="${result.selected}"`,
	);
	console.log(`      ${testCase.why}`);
	for (const problem of problems) console.log(`      -> ${problem}`);
}

console.log(
	failures === 0
		? `\nAll ${cases.length} microphone selection cases behaved.`
		: `\n${failures} of ${cases.length} cases did not.`,
);
process.exit(failures === 0 ? 0 : 1);
