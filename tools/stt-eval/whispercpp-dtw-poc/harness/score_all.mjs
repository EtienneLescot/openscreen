// score_all.mjs — For every (engine, mode) JSON in results/, compute
//   - WER vs fixtures/refs/<name>.txt
//   - analyze.mjs-style stats (monotonic, lastWordEnd <= duration, etc.)
// Then compute the §5.1 word-timestamp head-to-head
//   - fp16-vs-fp16: wcpp_cpu_fp16 vs ct2_fp16
//   - q8_0-vs-int8 : wcpp_cpu_q8_0 vs ct2_int8
// Output:
//   - results/wer_table.tsv
//   - results/timestamp_headtohead.json  (median/p90, gross disagreements)

import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const POC = path.join(ROOT, "tools", "stt-eval", "whispercpp-dtw-poc");
const RESULTS = path.join(POC, "results");
const REFS = path.join(POC, "fixtures", "refs");
const FIXTURES = path.join(POC, "fixtures");
const HARNESS = path.join(POC, "harness");

const audioDur = {
	jfk: 11.002,
	librispeech_demo_0: 5.851,
	librispeech_demo_1: 4.438,
	librispeech_demo_2: 11.967,
	librispeech_demo_3: 9.500,
	librispeech_demo_4: 29.130,
	"two-min-clip": 130.324,
};

const isWindows = process.platform === "win32";
const nodeBin = isWindows ? "node.exe" : "node";

function runNode(script, args) {
	return spawnSync(nodeBin, [path.join(HARNESS, script), ...args], {
		encoding: "utf8",
		maxBuffer: 50 * 1024 * 1024,
	});
}

function normalizeWord(w) {
	return w
		.toUpperCase()
		.replace(/[.,!?;:"“”‘’]/g, "")
		.replace(/-/g, " ")
		.trim();
}

// Flatten a JSON's segments[].words[] into a single ordered word list.
function flattenWords(json) {
	const out = [];
	for (const seg of json.segments || []) {
		for (const w of seg.words || []) {
			out.push({ word: w.word, start: w.start, end: w.end, probability: w.probability });
		}
	}
	return out;
}

// Per-fixture WER + analyze.
const runs = []; // { run, fixture, jsonPath, refPath, audio_s, hyp, ref, edits, refWords, wer, monotonic, maxBacktrack, lastWordEnd, numWords, numSegments, segmentsWithoutWords, zeroStartCountExcludingFirst }

const fixtures = Object.keys(audioDur);

// Read the CT2 timings directly from the timings_*.tsv files, since the
// CT2 server's JSON response has no `timing` field.
async function readTimingsTsv(name) {
	const p = path.join(RESULTS, name);
	if (!(await fs.stat(p).catch(() => null))) return {};
	const text = await fs.readFile(p, "utf8");
	const out = {};
	for (const line of text.split(/\r?\n/)) {
		const m = line.match(/^(\S+)\t([\d.]+)\t([\d.]+)\t([\d.]+)/);
		if (m) out[m[1]] = { audio_s: +m[2], wall_s: +m[3], rtf: +m[4] };
	}
	return out;
}
const ct2Timings      = await readTimingsTsv("timings_int8.tsv");
const ct2Fp16Timings  = await readTimingsTsv("timings_fp16.tsv");
const wcppCpuFp16     = await readTimingsTsv("timings_wcpp_cpu_fp16.tsv");
const wcppCpuQ80      = await readTimingsTsv("timings_wcpp_cpu_q8_0.tsv");
const wcppVulkanFp16  = await readTimingsTsv("timings_wcpp_vulkan_fp16.tsv");
const wcppVulkanQ80   = await readTimingsTsv("timings_wcpp_vulkan_q8_0.tsv");

const jsonFiles = (await fs.readdir(RESULTS))
	.filter((f) => f.endsWith(".json") && !f.endsWith("error.json"))
	.sort();

for (const jf of jsonFiles) {
	const mCt = jf.match(/^(ct2)_(int8|fp16)_(.+)\.json$/);
	const mWc = jf.match(/^(wcpp)_(cpu|vulkan|cuda)_(fp16|q8_0)_(.+)\.json$/);
	let engine, kind, prec, fixture;
	if (mCt) {
		engine  = mCt[1];
		kind    = mCt[2];
		prec    = mCt[2];
		fixture = mCt[3];
	} else if (mWc) {
		engine  = mWc[1];
		kind    = mWc[2];
		prec    = mWc[3];
		fixture = mWc[4];
	} else {
		continue;
	}
	if (!audioDur[fixture]) continue;
	const refPath = path.join(REFS, `${fixture}.txt`);
	if (!(await fs.stat(refPath).catch(() => null))) continue;

	const jsonPath = path.join(RESULTS, jf);
	const json = JSON.parse(await fs.readFile(jsonPath, "utf8"));

	// Pull the engine-measured timing from the TSV rather than from the JSON,
	// because CT2 JSON has no `timing` field and wcpp JSON `audio_s` is just
	// a re-derivation of the WAV header.
	let timing = { audio_s: undefined, wall_s: undefined, rtf: undefined };
	if (engine === "wcpp") {
		const t = (kind === "cpu" && prec === "fp16") ? wcppCpuFp16 :
		          (kind === "cpu" && prec === "q8_0") ? wcppCpuQ80 :
		          (kind === "vulkan" && prec === "fp16") ? wcppVulkanFp16 :
		          (kind === "vulkan" && prec === "q8_0") ? wcppVulkanQ80 : {};
		if (t[fixture]) timing = t[fixture];
	} else if (engine === "ct2") {
		const t = prec === "int8" ? ct2Timings : ct2Fp16Timings;
		if (t[fixture]) timing = t[fixture];
	}

	// WER
	const extract = runNode("extract_text.mjs", [jsonPath]);
	if (extract.status !== 0) continue;
	const hyp = extract.stdout;
	const werOut = runNode("wer.mjs", [refPath, hyp]);
	const wer = JSON.parse(werOut.stdout);

	// analyze — patch the JSON before passing to analyze.mjs to drop
	// broken timestamps (CT2 jfk: trailing segment emits word "you" with
	// start/end = 3.69e+17 because of an uninitialised timestamp variable
	// in ctranslate2-server/src/main.cpp when the trailing silences form
	// a 1-word segment).
	const patchedPath = path.join(RESULTS, `_patched_${jf}`);
	const patched = {
		...json,
		segments: (json.segments || []).map((seg) => ({
			...seg,
			words: (seg.words || []).filter((w) =>
				Number.isFinite(w.start) && Number.isFinite(w.end) &&
				w.start < 1e6 && w.end < 1e6,
			),
		})),
	};
	await fs.writeFile(patchedPath, JSON.stringify(patched), "utf8");
	const aOut = runNode("analyze.mjs", [patchedPath, String(audioDur[fixture])]);
	const a = JSON.parse(aOut.stdout);
	await fs.unlink(patchedPath).catch(() => {});

	runs.push({
		run: jf.replace(/\.json$/, ""),
		engine,
		kind,
		prec,
		fixture,
		refWords: wer.refWords,
		edits: wer.edits,
		wer: wer.wer,
		numWords: a.numWords,
		numSegments: a.numSegments,
		monotonic: a.monotonic,
		maxBacktrack: a.maxBacktrack,
		lastWordEnd: a.lastWordEnd,
		clipDuration: a.clipDuration,
		zeroStartCount: a.zeroStartCountExcludingFirst,
		segmentsWithoutWords: a.segmentsWithoutWords,
		rtf: timing.rtf,
		wall_s: timing.wall_s,
		audio_s: timing.audio_s,
	});
}

// WER table (TSV).
const werHeader = [
	"run", "engine", "backend", "prec", "fixture",
	"audio_s", "rtf", "refWords", "edits", "wer",
	"numWords", "numSegments", "monotonic", "maxBacktrack",
	"lastWordEnd", "zeroStartCount", "segmentsWithoutWords",
];
const werLines = [werHeader.join("\t")];
for (const r of runs) {
	werLines.push([
		r.run, r.engine, r.kind, r.prec, r.fixture,
		r.audio_s?.toFixed?.(4) ?? "",
		r.rtf?.toFixed?.(4) ?? "",
		r.refWords, r.edits, r.wer?.toFixed?.(4) ?? "",
		r.numWords, r.numSegments, r.monotonic, r.maxBacktrack?.toFixed?.(3),
		r.lastWordEnd?.toFixed?.(3), r.zeroStartCount, r.segmentsWithoutWords,
	].join("\t"));
}
await fs.writeFile(path.join(RESULTS, "wer_table.tsv"), werLines.join("\n") + "\n", "utf8");
process.stdout.write(`wrote ${path.join(RESULTS, "wer_table.tsv")} (${runs.length} rows)\n`);

// §5.1 head-to-head: align words by normalized text, then per-word |Δ start| / |Δ end|.
// We compute FOUR separate deltas, because wcpp t_dtw is the "moment of
// emission" (= roughly CT2's word END) rather than the start of the audio
// range (= CT2's word START), so direct start↔start comparison is unfair.
//   * dStart       = |wcpp.start − ct2.start|  (apples-to-apples if both are word audio ranges)
//   * dEnd         = |wcpp.end   − ct2.end|
//   * dWcppStartToCt2End = |wcpp.start − ct2.end|   (if wcpp t_dtw tracks CT2's word end, this should be ~0)
//   * dWcppMidToCt2Mid   = |wcpp.midpoint − ct2.midpoint|
async function alignHeadToHead(precA, precB) {
	const byFixture = new Map();
	for (const r of runs) {
		if (r.engine === "wcpp" && r.prec === precA) {
			const e = byFixture.get(r.fixture) || {};
			e.a = r;
			byFixture.set(r.fixture, e);
		}
	}
	for (const r of runs) {
		if (r.engine === "ct2" && r.kind === precB) {
			const e = byFixture.get(r.fixture) || {};
			e.b = r;
			byFixture.set(r.fixture, e);
		}
	}
	const dStart = [], dEnd = [], dWcppStartToCt2End = [], dWcppMidToCt2Mid = [];
	const gross = [];
	for (const [fixture, { a, b }] of byFixture.entries()) {
		if (!a || !b) continue;
		const jsonA = JSON.parse(await fs.readFile(path.join(RESULTS, `${a.run}.json`), "utf8"));
		const jsonB = JSON.parse(await fs.readFile(path.join(RESULTS, `${b.run}.json`), "utf8"));
		const wordsA = flattenWords(jsonA).map((w) => ({ ...w, _key: normalizeWord(w.word) })).filter((w) => w._key);
		const wordsB = flattenWords(jsonB).map((w) => ({ ...w, _key: normalizeWord(w.word) })).filter((w) => w._key);
		let i = 0, j = 0;
		while (i < wordsA.length && j < wordsB.length) {
			if (wordsA[i]._key === wordsB[j]._key) {
				const ds = Math.abs(wordsA[i].start - wordsB[j].start) * 1000;
				const de = Math.abs(wordsA[i].end   - wordsB[j].end)   * 1000;
				const dwx = Math.abs(wordsA[i].start - wordsB[j].end)   * 1000;
				const dmid = Math.abs((wordsA[i].start + wordsA[i].end)/2 - (wordsB[j].start + wordsB[j].end)/2) * 1000;
				dStart.push(ds);
				dEnd.push(de);
				dWcppStartToCt2End.push(dwx);
				dWcppMidToCt2Mid.push(dmid);
				if (ds > 200 || de > 200) {
					gross.push({ fixture, word: wordsA[i]._key, wcpp: { s: wordsA[i].start, e: wordsA[i].end }, ct2: { s: wordsB[j].start, e: wordsB[j].end }, ds, de });
				}
				i++; j++;
			} else {
				i++;
			}
		}
	}
	function pct(arr, q) {
		if (!arr.length) return null;
		const s = [...arr].sort((a, b) => a - b);
		const idx = Math.min(s.length - 1, Math.floor(s.length * q));
		return s[idx];
	}
	return {
		count: dStart.length,
		dStart_median_ms: pct(dStart, 0.5),
		dStart_p90_ms:    pct(dStart, 0.9),
		dStart_max_ms:    Math.max(...dStart, 0),
		dEnd_median_ms:   pct(dEnd,   0.5),
		dEnd_p90_ms:      pct(dEnd,   0.9),
		dEnd_max_ms:      Math.max(...dEnd,   0),
		dWcppStartToCt2End_median_ms: pct(dWcppStartToCt2End, 0.5),
		dWcppStartToCt2End_p90_ms:    pct(dWcppStartToCt2End, 0.9),
		dWcppMidToCt2Mid_median_ms:   pct(dWcppMidToCt2Mid,   0.5),
		dWcppMidToCt2Mid_p90_ms:      pct(dWcppMidToCt2Mid,   0.9),
		gross_count:                  gross.length,
		gross_examples:               gross.slice(0, 20),
	};
}

const h_fp16_vs_fp16  = await alignHeadToHead("fp16", "fp16");
const h_q8_0_vs_int8  = await alignHeadToHead("q8_0", "int8");

const headToHead = {
	"fp16-vs-fp16 (wcpp_cpu_fp16 vs ct2_fp16)": h_fp16_vs_fp16,
	"q8_0-vs-int8 (wcpp_cpu_q8_0 vs ct2_int8)": h_q8_0_vs_int8,
};
await fs.writeFile(
	path.join(RESULTS, "timestamp_headtohead.json"),
	JSON.stringify(headToHead, null, 2),
	"utf8",
);
process.stdout.write(`wrote ${path.join(RESULTS, "timestamp_headtohead.json")}\n`);

// Console summary
process.stdout.write("\n=== WER (smaller is better, 0 = perfect) ===\n");
for (const r of runs) {
	process.stdout.write(
		`${r.run.padEnd(34)}  refWords=${String(r.refWords).padStart(3)}  edits=${String(r.edits).padStart(3)}  wer=${(r.wer ?? 0).toFixed(4)}  rtf=${(r.rtf ?? 0).toFixed(3)}  monotonic=${r.monotonic}  numWords=${r.numWords}/${r.numSegments}\n`,
	);
}
process.stdout.write("\n=== §5.1 Word-timestamp head-to-head (4 metrics) ===\n");
for (const [k, v] of Object.entries(headToHead)) {
	process.stdout.write(
		`${k}  (n=${v.count}):\n` +
		`   Δstart (wcpp.start vs ct2.start):           median=${v.dStart_median_ms?.toFixed(0).padStart(5)}ms  p90=${v.dStart_p90_ms?.toFixed(0).padStart(5)}ms  max=${v.dStart_max_ms?.toFixed(0).padStart(6)}ms\n` +
		`   Δend   (wcpp.end   vs ct2.end):             median=${v.dEnd_median_ms?.toFixed(0).padStart(5)}ms  p90=${v.dEnd_p90_ms?.toFixed(0).padStart(5)}ms  max=${v.dEnd_max_ms?.toFixed(0).padStart(6)}ms\n` +
		`   ΔwcppStart↔ct2End   (t_dtw ≈ word-end?):    median=${v.dWcppStartToCt2End_median_ms?.toFixed(0).padStart(5)}ms  p90=${v.dWcppStartToCt2End_p90_ms?.toFixed(0).padStart(5)}ms\n` +
		`   Δmid    (wcpp.mid   vs ct2.mid):            median=${v.dWcppMidToCt2Mid_median_ms?.toFixed(0).padStart(5)}ms  p90=${v.dWcppMidToCt2Mid_p90_ms?.toFixed(0).padStart(5)}ms\n` +
		`   gross(>200ms any): ${v.gross_count}\n`,
	);
}
