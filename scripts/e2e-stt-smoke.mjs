// End-to-end STT smoke test: spawns ctranslate2-server directly (same
// binary/args as ctranslate2Server.ts) and transcribes the actual user
// recording (12-second webm), same way the IPC handler does.
//
// Run: node scripts/e2e-stt-smoke.mjs
//
// ponytail: the recording path + the desktop model cache layout both match
// what production hands to the ctranslate2-server wrapper. If you want to
// point this at a different recording, override RECORDING at runtime:
//   RECORDING=/path/to/audio.webm MODEL_DIR=/path/to/ct2-model node scripts/e2e-stt-smoke.mjs

import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const RECORDING = join(
	process.env.APPDATA || tmpdir(),
	"Electron",
	"recordings",
	"recording-1783174040055.webm",
);
const CT2_BIN = join(
	ROOT,
	"electron",
	"native",
	"bin",
	"win32-x64",
	process.platform === "win32"
		? "ctranslate2-server-ctranslate2-cpu.exe"
		: "ctranslate2-server-ctranslate2-cpu",
);
// ponytail: the unpacked model directory. CTranslate2's runtime expects a
// directory (multiple files), not a single .bin blob — production hands it
// whatever modelManager.ensureModels() left under userData/stt-models/whisper-ct2.
const MODEL_DIR =
	process.env.MODEL_DIR ||
	join(process.env.APPDATA || tmpdir(), "Electron", "stt-models", "whisper-ct2");

async function extractWav(src, dst) {
	const ffmpeg = spawn("ffmpeg", ["-y", "-i", src, "-ar", "16000", "-ac", "1", "-f", "wav", dst], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	return new Promise((resolve, reject) => {
		let stderr = "";
		ffmpeg.stderr.on("data", (c) => (stderr += c.toString()));
		ffmpeg.on("close", (code) =>
			code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${stderr}`)),
		);
		ffmpeg.on("error", reject);
	});
}

async function main() {
	console.log("=== STT end-to-end smoke test ===");

	// 1. ffmpeg-extract the recording to 16 kHz mono WAV.
	const tmpDir = join(tmpdir(), "openscreen-stt-e2e");
	await mkdir(tmpDir, { recursive: true });
	const wavPath = join(tmpDir, "audio.wav");
	console.log(`Converting ${RECORDING} → ${wavPath}`);
	await extractWav(RECORDING, wavPath);
	const { size } = await stat(wavPath);
	console.log(`WAV ready: ${size} bytes`);

	// 2. Spawn ctranslate2-server directly (skip the wrapper module to keep
	//    the smoke test dependency-light).
	const port = 18800;
	console.log(`Spawning ctranslate2-server on 127.0.0.1:${port}`);
	const server = spawn(
		CT2_BIN,
		["--model", MODEL_DIR, "--port", String(port), "--host", "127.0.0.1"],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	server.stderr.on("data", (c) => {
		const line = c.toString().trimEnd();
		if (line) console.log(`  server> ${line}`);
	});

	// 3. Wait for server to be ready (poll /).
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		try {
			const r = await fetch(`http://127.0.0.1:${port}/`);
			if (r.ok) break;
		} catch {
			// not up yet
		}
		await new Promise((res) => setTimeout(res, 250));
	}
	console.log(`Server up after polling`);

	// 4. Read the WAV bytes, post to /inference with response_format=verbose_json.
	const wavBytes = await readFile(wavPath);
	const form = new FormData();
	form.append("file", new Blob([wavBytes], { type: "audio/wav" }), basename(wavPath));
	form.append("response_format", "verbose_json");
	form.append("language", "auto");

	const t0 = Date.now();
	const response = await fetch(`http://127.0.0.1:${port}/inference`, {
		method: "POST",
		body: form,
	});
	const json = await response.json();
	const elapsed = Date.now() - t0;
	console.log(`Inference took ${elapsed}ms`);
	console.log("--- ctranslate2-server output ---");
	if (json.text) console.log(`text: ${JSON.stringify(json.text)}`);
	if (Array.isArray(json.segments)) {
		for (const seg of json.segments) {
			console.log(`  [${seg.start?.toFixed(2)}-${seg.end?.toFixed(2)}] ${seg.text?.trim()}`);
		}
	}

	// 5. Cleanup.
	server.kill("SIGTERM");
	await new Promise((res) => setTimeout(res, 1500));
	if (!server.killed) server.kill("SIGKILL");

	console.log("\n=== Smoke test complete ===");
}

main().catch((err) => {
	console.error("FAILED:", err);
	process.exit(1);
});
