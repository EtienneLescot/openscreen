// run_wcpp.mjs — Spawn wcpp_dtw_bench_<backend>, write JSON (UTF-8),
// then run analyze.mjs and extract_text.mjs and save artefacts.
//
// Usage:
//   node harness/run_wcpp.mjs <results-dir> <backend:cpu|vulkan|cuda>
//       <model.bin> <path/to/wcpp_dtw_bench_<backend>>
//       <fixture.wav> [...]

import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

const [
	,
	,
	resultsDir,
	backend,
	modelPath,
	benchExe,
	...fixtures
] = process.argv;
if (!resultsDir || !backend || !modelPath || !benchExe || fixtures.length === 0) {
	process.stderr.write(
		"usage: node run_wcpp.mjs <results-dir> <backend> <model.bin> <bench-exe> <fixture.wav> [...]\n",
	);
	process.exit(2);
}

const precTag = modelPath.includes("q8_0") ? "q8_0" : "fp16";
await fs.mkdir(resultsDir, { recursive: true });

const timingsPath = path.join(resultsDir, `timings_wcpp_${backend}_${precTag}.tsv`);
const lines = ["fixture\taudio_s\twallclock_s\trtf"];

for (const fixture of fixtures) {
	const wav = path.resolve(fixture);
	const name = path.basename(wav, path.extname(wav));
	const stat = await fs.stat(wav);
	const audio_s = stat.size / 2 / 16000; // PCM16 mono

	const r = spawnSync(benchExe, [modelPath, wav], {
		encoding: "buffer",
		maxBuffer: 500 * 1024 * 1024,
		timeout: 30 * 60 * 1000,
	});
	const stderr = r.stderr.toString("utf8");
	const stdout = r.stdout;
	const guardrailLine = stderr
		.split(/\r?\n/)
		.reverse()
		.find((l) => l.includes("§4.1 guardrail")) || "(no guardrail line in stderr)";
	if (r.status !== 0) {
		process.stderr.write(`FAIL ${name}: exit ${r.status} — ${guardrailLine}\n${stderr}`);
		continue;
	}

	const jsonPath = path.join(resultsDir, `wcpp_${backend}_${precTag}_${name}.json`);
	await fs.writeFile(jsonPath, stdout);
	const elapsed_s = r.signal ? NaN : (process.hrtime.bigint?.() ?? 0); // fallback
	// We trust the harness's own elapsed_s — read it from JSON.
	let wall_s = NaN;
	let reported_rtf = NaN;
	try {
		const parsed = JSON.parse(stdout.toString("utf8"));
		wall_s      = parsed.timing?.elapsed_s ?? NaN;
		reported_rtf = parsed.timing?.rtf ?? NaN;
	} catch (e) {
		process.stderr.write(`WARN ${name}: JSON parse failed: ${e.message}\n`);
	}
	const rtf = Number.isFinite(wall_s) && audio_s > 0 ? wall_s / audio_s : NaN;
	lines.push(`${name}\t${audio_s.toFixed(4)}\t${wall_s.toFixed(4)}\t${rtf.toFixed(4)}`);
	process.stdout.write(
		`wcpp ${backend} ${precTag} ${name}: wall=${wall_s.toFixed(3)}s audio=${audio_s.toFixed(3)}s rtf=${rtf.toFixed(3)} | ${guardrailLine.trim()}\n`,
	);
}

await fs.writeFile(timingsPath, lines.join("\n") + "\n", "utf8");
process.stdout.write(`wrote ${timingsPath}\n`);
