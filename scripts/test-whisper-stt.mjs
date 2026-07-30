// Round-trips a real WAV through a real `whisper-stt-server` and checks the
// response against the invariants in
// technical-documentation/architecture/transcription-and-captions.md.
//
// WHY THIS EXISTS. The helper's unit tests mock `fetch`, so every assertion
// about the wire format was made against a hand-written fixture rather than the
// binary. Three defects lived in that blind spot at once on macOS: no ggml
// dylib was staged next to the executable, the executable carried an absolute
// rpath into the build tree, and `backend`/`detected_language` reported values
// the helper had never actually resolved. All three are things only a real
// request can see.
//
// Usage:
//   node scripts/test-whisper-stt.mjs                # macOS: synthesizes speech with `say`
//   node scripts/test-whisper-stt.mjs --wav a.wav    # any platform: bring your own clip
//   node scripts/test-whisper-stt.mjs --wav a.wav --ref "expected words"
//   node scripts/test-whisper-stt.mjs --language fr  # force a language instead of auto
//
// Env overrides:
//   OPENSCREEN_WHISPER_SERVER_EXE  helper binary (default: the staged one for this host)
//   OPENSCREEN_WHISPER_MODEL       GGML model    (default: the userData cache location)

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const argOf = (flag) => {
	const i = process.argv.indexOf(flag);
	return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
};

const TAG = `${process.platform}-${process.arch}`;
const BIN =
	process.env.OPENSCREEN_WHISPER_SERVER_EXE ??
	path.join(
		ROOT,
		"electron",
		"native",
		"bin",
		TAG,
		process.platform === "win32" ? "whisper-stt-server.exe" : "whisper-stt-server",
	);

const MODEL = process.env.OPENSCREEN_WHISPER_MODEL ?? defaultModelPath();
const LANGUAGE = argOf("--language") ?? "auto";
const WAV_ARG = argOf("--wav");
const REF_ARG = argOf("--ref");

/**
 * Mirrors `SttManager`'s cache location: `app.getPath("userData")/stt-models`
 * ([electron/stt/index.ts:69](../electron/stt/index.ts)).
 *
 * The leaf of that userData path is `app.getName()`, which is package.json's
 * `name` ("openscreen") in dev and the productName once packaged — *not*
 * "Electron", which is only what a bare `electron .` with no app name would
 * use. Probe the plausible names and take the one that exists, so this works
 * whether the model was cached by the app or by a bare helper run.
 */
function defaultModelPath() {
	const file = path.join("stt-models", "whisper-ggml", "ggml-small-q8_0.bin");
	const roots =
		process.platform === "darwin"
			? [path.join(os.homedir(), "Library", "Application Support")]
			: process.platform === "win32"
				? [process.env.APPDATA ?? ""]
				: [process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")];
	const candidates = roots.flatMap((root) =>
		["openscreen", "Openscreen", "Electron"].map((appName) => path.join(root, appName, file)),
	);
	return candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
}

const failures = [];
const check = (ok, label, detail = "") => {
	console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(label);
};

/** Minimal RIFF/WAVE parse: enough to assert the clip is what the helper expects. */
function readWavMeta(file) {
	const buf = fs.readFileSync(file);
	if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
		throw new Error(`${file} is not a RIFF/WAVE file`);
	}
	let offset = 12;
	let fmt = null;
	let dataBytes = null;
	while (offset + 8 <= buf.length) {
		const id = buf.toString("ascii", offset, offset + 4);
		const size = buf.readUInt32LE(offset + 4);
		if (id === "fmt ") {
			fmt = {
				channels: buf.readUInt16LE(offset + 10),
				sampleRate: buf.readUInt32LE(offset + 12),
				bitsPerSample: buf.readUInt16LE(offset + 22),
			};
		} else if (id === "data") {
			dataBytes = size;
		}
		offset += 8 + size + (size % 2);
	}
	if (!fmt || dataBytes == null) throw new Error(`${file} has no fmt/data chunk`);
	const bytesPerFrame = (fmt.bitsPerSample / 8) * fmt.channels;
	return { ...fmt, durationSec: dataBytes / bytesPerFrame / fmt.sampleRate };
}

/** macOS-only: synthesize a clip with a known transcript so WER is meaningful. */
function synthesizeWav() {
	const text =
		"And so my fellow Americans, ask not what your country can do for you, " +
		"ask what you can do for your country.";
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-stt-test-"));
	const aiff = path.join(dir, "speech.aiff");
	const wav = path.join(dir, "speech.wav");
	for (const [cmd, args] of [
		["say", ["-o", aiff, text]],
		["afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]],
	]) {
		const r = spawnSync(cmd, args, { stdio: "inherit" });
		if (r.status !== 0) throw new Error(`${cmd} failed (status ${r.status})`);
	}
	return { wav, ref: text, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const normalize = (s) =>
	s
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s']/gu, " ")
		.split(/\s+/)
		.filter(Boolean);

/** Word error rate: Levenshtein over word arrays, (S+D+I)/N. */
function wer(refText, hypText) {
	const ref = normalize(refText);
	const hyp = normalize(hypText);
	if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
	let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j);
	for (let i = 1; i <= ref.length; i++) {
		const cur = [i];
		for (let j = 1; j <= hyp.length; j++) {
			cur[j] = Math.min(
				prev[j] + 1,
				cur[j - 1] + 1,
				prev[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1),
			);
		}
		prev = cur;
	}
	return prev[hyp.length] / ref.length;
}

async function waitForReady(baseUrl, timeoutMs = 120_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(baseUrl, { method: "GET" });
			if (res.ok) return;
		} catch {
			// not up yet
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`helper did not become ready within ${timeoutMs}ms`);
}

async function main() {
	for (const [label, p] of [
		["helper binary", BIN],
		["GGML model", MODEL],
	]) {
		if (!fs.existsSync(p)) {
			console.error(`FATAL: ${label} not found at ${p}`);
			if (label === "helper binary") {
				console.error("       Build it: bash scripts/build-whisper-stt.sh");
			} else {
				console.error(
					"       Run a transcription in the app once, or set OPENSCREEN_WHISPER_MODEL.",
				);
			}
			process.exit(1);
		}
	}

	let wavPath = WAV_ARG;
	let refText = REF_ARG;
	// No-op unless we synthesize a clip into a temp dir that needs removing.
	let cleanup = () => undefined;
	if (!wavPath) {
		if (process.platform !== "darwin") {
			console.error("FATAL: --wav <file> is required off macOS (no `say` to synthesize with).");
			process.exit(2);
		}
		const made = synthesizeWav();
		wavPath = made.wav;
		refText = refText ?? made.ref;
		cleanup = made.cleanup;
	}

	const meta = readWavMeta(wavPath);
	console.log(`\nclip   : ${wavPath}`);
	console.log(
		`format : ${meta.channels}ch ${meta.sampleRate}Hz ${meta.bitsPerSample}-bit, ` +
			`${meta.durationSec.toFixed(2)}s`,
	);
	console.log(`helper : ${BIN}`);
	console.log(`model  : ${MODEL}\n`);

	const port = 20100 + Math.floor(process.pid % 400);
	const child = spawn(
		BIN,
		[
			"--model",
			MODEL,
			"--port",
			String(port),
			"--host",
			"127.0.0.1",
			"--threads",
			String(Math.max(1, os.cpus().length)),
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	let stderr = "";
	child.stderr.on("data", (d) => {
		stderr += String(d);
	});
	child.on("exit", (code, signal) => {
		if (code !== 0 && code !== null) {
			console.error(`\nhelper exited early (code ${code}, signal ${signal}):`);
			console.error(stderr.split("\n").slice(-15).join("\n"));
		}
	});

	let json;
	try {
		await waitForReady(`http://127.0.0.1:${port}/`);
		const form = new FormData();
		form.append("file", new Blob([fs.readFileSync(wavPath)]), path.basename(wavPath));
		form.append("language", LANGUAGE);
		form.append("response_format", "verbose_json");
		const res = await fetch(`http://127.0.0.1:${port}/inference`, {
			method: "POST",
			body: form,
		});
		if (!res.ok) throw new Error(`/inference returned ${res.status}: ${await res.text()}`);
		json = await res.json();
	} finally {
		child.kill();
		cleanup();
	}

	const segments = json.segments ?? [];
	const words = segments.flatMap((s) => s.words ?? []);
	const text = segments
		.map((s) => s.text ?? "")
		.join("")
		.trim();

	console.log(`text   : ${text}\n`);
	console.log("assertions:");

	check(segments.length > 0, "response carries phrase segments", `${segments.length}`);
	check(words.length > 0, "response carries per-word timings", `${words.length} words`);

	// The DTW guardrail lives in the helper; its stderr line is the only place
	// the result is reported, and a FAIL there is a 500 rather than a bad body.
	check(/§4\.1 guardrail: PASS/.test(stderr), "DTW guardrail passed in the helper");

	// `backend` is documented as the source of truth for the device that ran.
	// Metal reported as CPU is the exact bug this catches: ggml's Metal *device*
	// is named "MTL0", so a matcher looking for "Metal" never fires.
	const gpuExpected =
		(process.platform === "darwin" && process.arch === "arm64") || process.platform === "win32";
	check(
		typeof json.backend === "string" && json.backend.startsWith("whispercpp-"),
		"backend is a contract value",
		String(json.backend),
	);
	if (gpuExpected) {
		check(
			json.backend !== "whispercpp-cpu",
			"backend reports GPU offload on a GPU-capable host",
			String(json.backend),
		);
	}

	// "auto" is a request value, never a response value: the helper must report
	// the language whisper resolved.
	check(
		typeof json.detected_language === "string" &&
			json.detected_language !== "auto" &&
			json.detected_language.length > 0,
		"detected_language is a resolved language, not the request echo",
		String(json.detected_language),
	);

	// Contract invariant: absolute seconds in the source recording, [0, duration).
	//
	// These are checked separately rather than as one `every()`. Bundled, a
	// failure could not say which property broke: a real French clip tripped the
	// combined check and read as "word times outside the clip" when nothing was
	// outside the clip at all — three punctuation tokens had end < start.
	const tolerance = 0.5; // whisper rounds segment ends up to the chunk edge
	check(
		words.every((w) => w.start >= 0),
		"word starts are non-negative",
	);
	check(
		words.every((w) => w.end <= meta.durationSec + tolerance),
		"word ends lie within the clip",
		`clip is ${meta.durationSec.toFixed(2)}s`,
	);
	check(
		words.every((w, i) => i === 0 || w.start >= words[i - 1].start),
		"word starts are monotonic non-decreasing",
	);

	// NOT a failure. whisper.cpp gives the last word of a segment the segment's
	// own t1 as its end, while the word's DTW start runs 80–150 ms late — so a
	// token emitted near the boundary (typically standalone punctuation) can land
	// after it and invert. The contract's [startSec, endSec) guarantee is enforced
	// one layer up, deliberately: whisperServer.ts clamps to
	// `Math.max(startSec + 0.02, endSec)` and snapWordBoundaries.ts keeps
	// "degenerate words (whisper sometimes reports end <= start) non-empty". This
	// harness speaks to the raw helper, below that clamp, so it reports the count
	// as information instead of asserting on it.
	const inverted = words.filter((w) => w.end < w.start);
	if (inverted.length > 0) {
		console.log(
			`  info  ${inverted.length}/${words.length} raw word(s) have end < start ` +
				`(${inverted.map((w) => JSON.stringify(w.word)).join(", ")}) — expected at segment ` +
				"boundaries; whisperServer.ts clamps these before they reach the document.",
		);
	}

	if (refText) {
		const rate = wer(refText, text);
		check(rate <= 0.15, "WER within tolerance", `${rate.toFixed(4)}`);
	}

	if (json.timing) {
		console.log(
			`\ntiming : ${json.timing.elapsed_s?.toFixed?.(2)}s for ` +
				`${json.timing.audio_s?.toFixed?.(2)}s audio (rtf ${json.timing.rtf?.toFixed?.(3)})`,
		);
	}

	if (failures.length > 0) {
		console.error(`\n${failures.length} check(s) failed: ${failures.join("; ")}`);
		process.exit(1);
	}
	console.log("\nAll checks passed.");
}

main().catch((err) => {
	console.error(`\nFATAL: ${err.message}`);
	process.exit(1);
});
