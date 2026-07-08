// run_ct2.mjs — Spawn the OpenScreen CT2 server, POST each fixture to /inference
// via curl.exe (multipart/form-data, field name 'file' — the server's
// ctranslate2-server/src/main.cpp endpoint reads req.files.find("file")),
// save the JSON responses and per-fixture wall-clock timings.
//
// Usage:
//   node harness/run_ct2.mjs <results-dir> <mode:int8|fp16> <port> <model-dir> <fixture1> [fixture2] ...
//
// `mode` controls whether the server is launched with `--int8` or not.

import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";

const [
	,
	,
	resultsDir,
	modeArg,
	portArg,
	modelDir,
	...fixtures
] = process.argv;
if (!resultsDir || !modeArg || !portArg || !modelDir || fixtures.length === 0) {
	process.stderr.write(
		"usage: node run_ct2.mjs <results-dir> <int8|fp16> <port> <model-dir> <fixture.wav> [...]\n",
	);
	process.exit(2);
}
const mode = modeArg === "int8" ? "int8" : modeArg === "fp16" ? "fp16" : null;
if (!mode) {
	process.stderr.write(`unknown mode "${modeArg}" (want int8 or fp16)\n`);
	process.exit(2);
}
const port = Number.parseInt(portArg, 10);
const serverExe =
	"C:/Users/camil/Documents/repos/openscreen-new/electron/native/bin/win32-x64/ctranslate2-server-ctranslate2-cpu.exe";

const args = [
	"--model",
	modelDir,
	"--port",
	String(port),
	"--host",
	"127.0.0.1",
];
if (mode === "int8") args.push("--int8");

await fs.mkdir(resultsDir, { recursive: true });

const child = spawn(serverExe, args, { stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", (d) => process.stderr.write(`[ct2-server] ${d}`));
child.stderr.on("data", (d) => process.stderr.write(`[ct2-server] ${d}`));

const cleanup = () => {
	try {
		child.kill();
	} catch {}
	process.exit(1);
};
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

async function waitForServer(timeoutMs = 30_000) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		const ok = await new Promise((resolve) => {
			const req = http.request(
				{ method: "GET", host: "127.0.0.1", port, path: "/health" },
				(res) => {
					res.resume();
					resolve(res.statusCode && res.statusCode < 500);
				},
			);
			req.on("error", () => resolve(false));
			req.end();
		});
		if (ok) return;
		if (child.exitCode !== null) {
			throw new Error(`server exited early with code ${child.exitCode}`);
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error(`server did not become ready within ${timeoutMs} ms`);
}

function postFixture(wavPath) {
	return new Promise((resolve, reject) => {
		const r = spawnSync(
			"curl.exe",
			[
				"-s",
				"-X",
				"POST",
				`-w`,
				`\n%{time_total}`,
				`http://127.0.0.1:${port}/inference`,
				`-F`,
				`file=@${wavPath}`,
				`-F`,
				`language=en`,
			],
			{ encoding: "utf8", maxBuffer: 500 * 1024 * 1024, timeout: 20 * 60 * 1000 },
		);
		if (r.status !== 0) {
			reject(new Error(`curl status ${r.status}: ${r.stderr.slice(0, 400)}`));
			return;
		}
		const lines = r.stdout.split("\n");
		const time_total_str = lines.at(-1);
		const body = lines.slice(0, -1).join("\n");
		const time_total = Number.parseFloat(time_total_str);
		if (!Number.isFinite(time_total)) {
			reject(new Error(`bad time_total from curl: ${time_total_str}`));
			return;
		}
		resolve({ body, time_total });
	});
}

await waitForServer().catch((e) => {
	process.stderr.write(`server failed to start: ${e.message}\n`);
	cleanup();
});

const timingsPath = path.join(resultsDir, `timings_${mode}.tsv`);
const timingsLines = ["fixture\taudio_s\twallclock_s\trtf"];

for (const fixture of fixtures) {
	const wavPath = path.resolve(fixture);
	const name = path.basename(wavPath, path.extname(wavPath));
	const stat = await fs.stat(wavPath);
	const samples = stat.size / 2; // PCM16 mono ⇒ 2 bytes/sample
	const audio_s = samples / 16000;

	let body;
	let wall_s;
	try {
		({ body, time_total: wall_s } = await postFixture(wavPath));
	} catch (e) {
		process.stderr.write(`FAIL ${name}: ${e.message}\n`);
		continue;
	}
	const rtf = wall_s / audio_s;

	const outPath = path.join(resultsDir, `ct2_${mode}_${name}.json`);
	await fs.writeFile(outPath, body);
	timingsLines.push(
		`${name}\t${audio_s.toFixed(4)}\t${wall_s.toFixed(4)}\t${rtf.toFixed(4)}`,
	);
	process.stdout.write(
		`ct2 ${mode} ${name}: wall=${wall_s.toFixed(3)}s audio=${audio_s.toFixed(3)}s rtf=${rtf.toFixed(3)}\n`,
	);
}

await fs.writeFile(timingsPath, timingsLines.join("\n") + "\n");
process.stdout.write(`wrote ${timingsPath}\n`);

child.kill();
await new Promise((r) => setTimeout(r, 200));
process.exit(0);
