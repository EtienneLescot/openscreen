// debug_jfk.mjs — Compare wcpp-cpu-fp16 vs ct2-fp16 word-by-word for jfk.wav
import { promises as fs } from "node:fs";
const a = JSON.parse(await fs.readFile("tools/stt-eval/whispercpp-dtw-poc/results/wcpp_cpu_fp16_jfk.json", "utf8"));
const b = JSON.parse(await fs.readFile("tools/stt-eval/whispercpp-dtw-poc/results/ct2_fp16_jfk.json", "utf8"));
const wa = a.segments[0].words;
const wb = b.segments[0].words;
console.log("wcpp words:", wa.length, "ct2 words:", wb.length);
const maxN = Math.max(wa.length, wb.length);
for (let i = 0; i < maxN; i++) {
	const aw = wa[i] || { word: "<eof>", start: 0, end: 0 };
	const bw = wb[i] || { word: "<eof>", start: 0, end: 0 };
	const dw = aw.end - aw.start, dc = bw.end - bw.start;
	const dStart = Math.abs(aw.start - bw.start) * 1000;
	const dEnd   = Math.abs(aw.end   - bw.end)   * 1000;
	console.log(
		`  ${String(i).padStart(2)} ` +
		`wcpp=${aw.word.padEnd(15)}[${aw.start.toFixed(2)},${aw.end.toFixed(2)}]  ` +
		`ct2 =${bw.word.padEnd(15)}[${bw.start.toFixed(2)},${bw.end.toFixed(2)}]  ` +
		`Δs=${dStart.toFixed(0).padStart(5)}ms  Δe=${dEnd.toFixed(0).padStart(5)}ms  ` +
		`wcpp_dur=${(dw*1000).toFixed(0).padStart(5)}ms  ct2_dur=${(dc*1000).toFixed(0).padStart(5)}ms`,
	);
}
