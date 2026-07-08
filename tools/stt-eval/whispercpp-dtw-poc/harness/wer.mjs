// Word-level WER (Levenshtein) between reference and hypothesis text.
function normalize(s) {
  return s
    .toUpperCase()
    .replace(/[.,!?;:"“”‘’]/g, "")
    .replace(/-/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function wer(ref, hyp) {
  const r = normalize(ref);
  const h = normalize(hyp);
  const n = r.length, m = h.length;
  const d = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) d[i][0] = i;
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (r[i - 1] === h[j - 1]) d[i][j] = d[i - 1][j - 1];
      else d[i][j] = 1 + Math.min(d[i - 1][j - 1], d[i - 1][j], d[i][j - 1]);
    }
  }
  const edits = d[n][m];
  return { edits, refWords: n, wer: n === 0 ? 0 : edits / n };
}

const [, , refPath, hypText] = process.argv;
const fs = await import("fs");
const ref = fs.readFileSync(refPath, "utf8").trim();
const result = wer(ref, hypText);
console.log(JSON.stringify(result));
