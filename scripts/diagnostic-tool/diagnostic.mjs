#!/usr/bin/env node
// OpenScreen standalone diagnostic tool.
//
// Runs the native capture helper outside the Electron app, captures its
// stdout/stderr, and writes a JSON report you can attach to a bug report.
// Used to capture [stop-timing] lines from the helper without requiring the
// full app to install/reproduce.
//
// Usage:
//   node diagnostic.mjs                       # 10s recording, default output
//   node diagnostic.mjs --duration 30         # 30s recording
//   node diagnostic.mjs --output ./out.json   # custom output path
//   node diagnostic.mjs --window              # capture a window (default: display)
//
// Helper discovery:
//   1. $OPENSCREEN_HELPER_EXE (any path)
//   2. ./wgc-capture.exe                          (Windows)
//      ./openscreen-screencapturekit-helper        (macOS)
//   3. ./helpers/<platform>-<arch>/<helper-name>  (CI artifact layout)

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HELPER_CANDIDATES = {
	win32: {
		x64: { name: "wgc-capture.exe", kind: "windows" },
		arm64: { name: "wgc-capture.exe", kind: "windows" },
	},
	darwin: {
		x64: { name: "openscreen-screencapturekit-helper", kind: "mac" },
		arm64: { name: "openscreen-screencapturekit-helper", kind: "mac" },
	},
};

function parseArgs(argv) {
	const opts = {
		duration: 10_000,
		output: null,
		source: "display",
		systemAudio: false,
		mic: false,
		help: false,
	};
	const requireNumber = (raw, flag) => {
		const n = Number(raw);
		if (!Number.isFinite(n) || n <= 0) {
			throw new Error(`${flag} requires a positive number, got: ${raw}`);
		}
		return n;
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--duration" || arg === "-d") {
			const value = argv[++i];
			if (value === undefined) throw new Error(`${arg} requires a value`);
			opts.duration = requireNumber(value, arg) * 1000;
		} else if (arg === "--output" || arg === "-o") {
			const value = argv[++i];
			if (value === undefined) throw new Error(`${arg} requires a value`);
			opts.output = value;
		} else if (arg === "--source") {
			const value = argv[++i];
			if (value === undefined) throw new Error(`${arg} requires a value`);
			opts.source = value;
		} else if (arg === "--window") {
			opts.source = "window";
		} else if (arg === "--system-audio") {
			opts.systemAudio = true;
		} else if (arg === "--mic") {
			opts.mic = true;
		} else if (arg === "--help" || arg === "-h") {
			opts.help = true;
		} else if (arg.startsWith("--")) {
			throw new Error(`Unknown flag: ${arg}`);
		}
	}
	return opts;
}

function printHelp() {
	console.log(`OpenScreen standalone diagnostic tool

Usage:
  node diagnostic.mjs [flags]

Flags:
  -d, --duration <seconds>   Recording length before sending stop (default: 10)
  -o, --output  <path>       Output JSON path (default: ./openscreen-diagnostic-<timestamp>.json)
  --source <display|window>  Capture source type (default: display)
  --window                   Shortcut for --source window
  --system-audio             Also capture system (loopback) audio
  --mic                      Also capture the default microphone
  -h, --help                 Show this help

The audio flags are off by default, which is why a plain run cannot reproduce a
hang that only happens with audio: an audio write and a video write contend for
the same sink-writer lock, and with no audio there is nothing to contend with.
If a recording hangs in the app but not here, re-run with whichever sources the
failing recording used -- --system-audio, --mic, or both.
`);
}

function findHelper() {
	const explicit = process.env.OPENSCREEN_HELPER_EXE?.trim();
	if (explicit && fs.existsSync(explicit)) return { path: explicit, kind: null };

	const platform = process.platform;
	const arch = process.arch === "arm64" ? "arm64" : "x64";
	const descriptor = HELPER_CANDIDATES[platform]?.[arch];
	if (!descriptor) {
		throw new Error(`Unsupported platform: ${platform}-${arch}`);
	}

	const inScriptDir = path.join(__dirname, descriptor.name);
	if (fs.existsSync(inScriptDir)) return { path: inScriptDir, kind: descriptor.kind };

	const inHelpersDir = path.join(__dirname, "helpers", `${platform}-${arch}`, descriptor.name);
	if (fs.existsSync(inHelpersDir)) return { path: inHelpersDir, kind: descriptor.kind };

	throw new Error(
		`Native helper not found for ${platform}-${arch}. Looked for:\n` +
			`  $OPENSCREEN_HELPER_EXE\n` +
			`  ${inScriptDir}\n` +
			`  ${inHelpersDir}\n` +
			`Download the matching diagnostic bundle from the OpenScreen releases / CI artifacts.`,
	);
}

function buildConfig(opts) {
	const now = Date.now();
	return {
		schemaVersion: 2,
		recordingId: now,
		outputPath: path.join(os.tmpdir(), `openscreen-diag-${now}.mp4`),
		sourceType: opts.source === "window" ? "window" : "display",
		sourceId: opts.source === "window" ? "window:0:0" : "screen:0:0",
		displayId: 0,
		fps: 30,
		videoWidth: 1280,
		videoHeight: 720,
		// No Electron here, so no real display rect to send. The helper reads these
		// as physical pixels, and a hardcoded 1920x1080 only happens to hit on an
		// unscaled 1080p primary. Omitting them skips the bounds match entirely and
		// lands on the primary monitor deterministically, which is what this tool
		// wanted all along (#346).
		hasDisplayBounds: false,
		captureSystemAudio: opts.systemAudio,
		captureMic: opts.mic,
		captureCursor: false,
		microphoneDeviceId: "default",
		microphoneDeviceName: "",
		microphoneGain: 1.0,
		webcamEnabled: false,
		outputs: { screenPath: "" },
	};
}

function parseStopTiming(stderrText) {
	const lines = [];
	for (const line of stderrText.split(/\r?\n/)) {
		// `phase` is the point of the whole log: `begin` is the step being
		// entered, `abandoned` names the step the shutdown watchdog gave up on.
		// Dropping it left the report unable to say which step hung -- the one
		// question a #252 bug report has to answer.
		const m = line.match(/\[stop-timing\]\s+step=(\S+)\s+elapsed_ms=(\d+)(?:\s+phase=(\S+))?/);
		if (m) lines.push({ step: m[1], elapsedMs: Number(m[2]), phase: m[3] ?? "end" });
	}
	return lines;
}

function run(opts) {
	const helper = findHelper();
	console.log(`[diag] helper: ${helper.path}`);
	console.log(`[diag] platform: ${process.platform}-${process.arch}`);
	const audioSummary =
		[opts.systemAudio && "system", opts.mic && "mic"].filter(Boolean).join("+") || "none";
	console.log(
		`[diag] duration: ${opts.duration}ms, source: ${opts.source}, audio: ${audioSummary}`,
	);

	const config = buildConfig(opts);
	config.outputs.screenPath = config.outputPath;

	const t0 = Date.now();
	const proc = spawn(helper.path, [JSON.stringify(config)], {
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});

	let stdout = "";
	let stderr = "";
	let stopSent = false;
	let stopSentAt = 0;

	proc.stdout.on("data", (chunk) => {
		const text = chunk.toString();
		stdout += text;
		process.stdout.write(`[helper/stdout] ${text}`);
	});
	proc.stderr.on("data", (chunk) => {
		const text = chunk.toString();
		stderr += text;
		process.stderr.write(`[helper/stderr] ${text}`);
	});

	const stopTimer = setTimeout(() => {
		if (stopSent) return;
		stopSent = true;
		stopSentAt = Date.now();
		proc.stdin.write("stop\n");
		console.log(`[diag] sent stop after ${stopSentAt - t0}ms`);
	}, opts.duration);

	const fallbackTimer = setTimeout(() => {
		if (!stopSent) {
			stopSent = true;
			stopSentAt = Date.now();
			proc.stdin.write("stop\n");
			console.log(`[diag] fallback stop fired after ${opts.duration}ms`);
		}
	}, opts.duration + 2_000);

	const killTimer = setTimeout(() => {
		console.error(`[diag] helper did not exit after stop, killing`);
		proc.kill("SIGKILL");
	}, opts.duration + 95_000);

	return new Promise((resolve) => {
		proc.once("exit", (code, signal) => {
			clearTimeout(stopTimer);
			clearTimeout(fallbackTimer);
			clearTimeout(killTimer);
			const tExit = Date.now();
			resolve({
				code,
				signal,
				t0,
				stopSentAt,
				tExit,
				stdout,
				stderr,
				config,
			});
		});
		proc.once("error", (error) => {
			clearTimeout(stopTimer);
			clearTimeout(fallbackTimer);
			clearTimeout(killTimer);
			resolve({
				code: -1,
				signal: null,
				t0,
				stopSentAt,
				tExit: Date.now(),
				stdout,
				stderr: stderr + `\n[spawn-error] ${error.message}\n`,
				config,
				spawnError: error,
			});
		});
	});
}

function buildReport(result) {
	const stopTiming = parseStopTiming(result.stderr);
	const stopElapsedMs = result.stopSentAt > 0 ? result.tExit - result.stopSentAt : null;
	const helperPath = process.env.OPENSCREEN_HELPER_EXE?.trim() || "(auto-resolved)";

	return {
		timestamp: new Date(result.t0).toISOString(),
		platform: process.platform,
		arch: process.arch,
		osRelease: os.release(),
		osVersion: os.version(),
		cpuModel: os.cpus()[0]?.model ?? null,
		cpuCount: os.cpus().length,
		totalMemoryMB: Math.round(os.totalmem() / 1024 / 1024),
		nodeVersion: process.versions.node,
		helperPath,
		durationMs: result.stopSentAt > 0 ? result.stopSentAt - result.t0 : null,
		stopElapsedMs,
		exitCode: result.code,
		exitSignal: result.signal,
		spawnError: result.spawnError?.message ?? null,
		config: result.config,
		helperStdout: result.stdout,
		helperStderr: result.stderr,
		stopTiming,
	};
}

async function main() {
	let opts;
	try {
		opts = parseArgs(process.argv.slice(2));
	} catch (error) {
		console.error(`[diag] ${error.message}`);
		process.exit(2);
	}
	if (opts.help) {
		printHelp();
		process.exit(0);
	}

	let result;
	try {
		result = await run(opts);
	} catch (error) {
		console.error(`[diag] ${error.message}`);
		process.exit(1);
	}

	const report = buildReport(result);
	const outputPath =
		opts.output ?? path.join(process.cwd(), `openscreen-diagnostic-${Date.now()}.json`);
	await fs.promises.writeFile(outputPath, JSON.stringify(report, null, 2), "utf-8");

	console.log("");
	console.log(`[diag] exit code:        ${report.exitCode}`);
	console.log(`[diag] stop elapsed:     ${report.stopElapsedMs}ms`);
	console.log(`[diag] stop timing steps:`);
	for (const entry of report.stopTiming) {
		// Only the outcome of each step, so the summary reads as one line per
		// step rather than an entry-and-exit pair, and an abandoned step is
		// impossible to miss.
		if (entry.phase === "begin") {
			continue;
		}
		const suffix = entry.phase === "end" ? "" : `  <-- ${entry.phase.toUpperCase()}`;
		console.log(`[diag]   ${entry.step.padEnd(28)} ${entry.elapsedMs}ms${suffix}`);
	}
	console.log(`[diag] report:           ${outputPath}`);
}

main();
