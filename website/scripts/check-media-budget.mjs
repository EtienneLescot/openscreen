#!/usr/bin/env node
/**
 * Guards the landing page's media budget.
 *
 * The walkthrough's page weight is the whole argument for shipping video at all
 * — a demo that makes the page slow has argued against the product it is
 * demonstrating. Byte budgets that live only in a design document drift on the
 * first re-cut, so they live here and the build fails on them.
 *
 * Everything under website/static/ is committed to git permanently: this repo
 * has no LFS filter, and video neither compresses nor deltas, so a re-cut costs
 * its full size again rather than a diff. The directory ceiling is the real
 * constraint; the per-file ones just localise the failure.
 *
 * The audio check is not a nicety. WebKit grants gesture-free autoplay to media
 * that contains no audio track — the `muted` attribute alone is not enough on
 * iOS — and the masters these clips are cut from carry an AAC stream of digital
 * silence. Encoding without `-an` produces a clip that silently refuses to play
 * for a large share of visitors, and looks perfect on the machine that made it.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

const RULES = [
	{ dir: "static/video", ext: ".mp4", max: 200_000 },
	{ dir: "static/img/walkthrough", ext: ".jpg", max: 70_000 },
];
const TOTAL_MAX = 1_600_000;

const problems = [];
let total = 0;
let counted = 0;

function walk(dir) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return []; // an absent directory is a section not yet shot, not a failure
	}
	return entries.flatMap((e) =>
		e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
	);
}

/**
 * True if the MP4 declares a sound track. Reads the `hdlr` boxes rather than
 * shelling out to ffprobe, which is not guaranteed on a CI runner and would make
 * this check quietly skippable — which is how the guarantee would be lost.
 */
function hasAudioTrack(file) {
	const buf = readFileSync(file);
	for (let i = 0; i + 4 <= buf.length; i++) {
		if (buf[i] === 0x68 && buf[i + 1] === 0x64 && buf[i + 2] === 0x6c && buf[i + 3] === 0x72) {
			// hdlr: 4 size + 4 type + 4 version/flags + 4 predefined, then handler_type
			const handler = buf.subarray(i + 12, i + 16).toString("latin1");
			if (handler === "soun") return true;
		}
	}
	return false;
}

for (const rule of RULES) {
	const abs = join(ROOT, rule.dir);
	for (const file of walk(abs)) {
		const rel = relative(ROOT, file);
		const bytes = statSync(file).size;
		total += bytes;
		counted += 1;

		if (!file.endsWith(rule.ext)) {
			problems.push(`${rel}: unexpected file type in ${rule.dir} (only ${rule.ext} belongs here)`);
			continue;
		}
		if (bytes > rule.max) {
			problems.push(
				`${rel}: ${bytes.toLocaleString()} B exceeds the ${rule.max.toLocaleString()} B ceiling`,
			);
		}
		if (rule.ext === ".mp4" && hasAudioTrack(file)) {
			problems.push(
				`${rel}: carries an audio track. Re-encode with -an — iOS Safari refuses ` +
					`gesture-free autoplay for media that has one, muted or not.`,
			);
		}
	}
}

if (total > TOTAL_MAX) {
	problems.push(
		`walkthrough media totals ${total.toLocaleString()} B, over the ` +
			`${TOTAL_MAX.toLocaleString()} B ceiling. These bytes are permanent in git history.`,
	);
}

const summary = `${counted} file${counted === 1 ? "" : "s"}, ${total.toLocaleString()} B of ${TOTAL_MAX.toLocaleString()}`;

if (problems.length) {
	console.error(`media budget FAILED — ${summary}`);
	for (const p of problems) console.error(`  · ${p}`);
	process.exit(1);
}

console.log(`media budget ok — ${summary}`);
