// Analyze a ctranslate2-server /inference response: full text, word-timestamp
// sanity (monotonic, coverage vs clip duration), and basic stats.
import fs from "fs";

const [, , jsonPath, durationSec] = process.argv;
const d = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
const dur = parseFloat(durationSec);

let text = "";
let words = [];
for (const seg of d.segments || []) {
  text += seg.text;
  for (const w of seg.words || []) words.push(w);
}

let monotonic = true;
let maxBacktrack = 0;
let coverageGaps = [];
for (let i = 1; i < words.length; i++) {
  if (words[i].start < words[i - 1].start) {
    monotonic = false;
    maxBacktrack = Math.max(maxBacktrack, words[i - 1].start - words[i].start);
  }
  if (words[i].end < words[i].start) {
    coverageGaps.push(`word[${i}] '${words[i].word}' end<start`);
  }
}

const lastWordEnd = words.length ? words[words.length - 1].end : 0;
const zeroStartCount = words.filter((w, i) => i > 0 && w.start === 0).length;

console.log(
  JSON.stringify(
    {
      detected_language: d.detected_language,
      numSegments: (d.segments || []).length,
      numWords: words.length,
      text: text.trim(),
      monotonic,
      maxBacktrack,
      lastWordEnd,
      clipDuration: dur,
      zeroStartCountExcludingFirst: zeroStartCount,
      segmentsWithoutWords: (d.segments || []).filter((s) => !s.words || s.words.length === 0).length,
    },
    null,
    2
  )
);
