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

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

const RULES = [
	{ dir: "static/video", ext: [".mp4"], max: 200_000 },
	{ dir: "static/img/walkthrough", ext: [".jpg", ".avif"], max: 70_000 },
	// The cursor packs, copied out of the application's own public/cursors. Each
	// is a 32-logical sprite at 128px, so a five-figure file here means someone
	// has shipped a full-resolution source by mistake.
	{ dir: "static/img/cursors", ext: [".png"], max: 12_000 },
];

/**
 * A `-scrub` clip is a different kind of file and gets a different ceiling.
 *
 * It is never played; scroll position seeks it. A seek into a long GOP has to
 * decode from the preceding keyframe, so these are encoded all-intra — every
 * frame its own keyframe — which is the entire reason they are large. Measured
 * on the export beat at 960x540: 32 KB at `-g 60`, 402 KB all-intra at 30fps,
 * 268 KB once dropped to 20fps. Twenty frames a second is finer than a scroll
 * resolves, and it is where this ceiling was set.
 *
 * The generous per-file number is safe because TOTAL_MAX is the rule that
 * actually protects the repository, and it did not move.
 */
const SCRUB_MAX = 300_000;
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
	return entries.flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

/** The boxes a track's `hdlr` can be nested inside. Everything else is skipped
 *  whole — including `mdat`, which is the point. */
const MP4_CONTAINERS = new Set(["moov", "trak", "mdia"]);

/**
 * True if the MP4 declares a sound track. Reads the `hdlr` boxes rather than
 * shelling out to ffprobe, which is not guaranteed on a CI runner and would make
 * this check quietly skippable — which is how the guarantee would be lost.
 *
 * Walked as a box tree, not searched for as a byte pattern. `mdat` is compressed
 * picture: the twelve bytes that spell a sound handler can occur in it by
 * chance, and the failure that would produce — a silent clip rejected for an
 * audio track it does not have — is unreproducible and looks like a bug in this
 * file rather than in the clip.
 */
function hasAudioTrack(file) {
	const buf = readFileSync(file);
	const walk = (start, end) => {
		let pos = start;
		while (pos + 8 <= end) {
			let size = buf.readUInt32BE(pos);
			let head = 8;
			if (size === 1) {
				if (pos + 16 > end) return false;
				size = Number(buf.readBigUInt64BE(pos + 8));
				head = 16;
			} else if (size === 0) {
				size = end - pos; // the last box, extending to the end of the file
			}
			// A size that runs past its parent means the file is not what it says
			// it is; stop rather than resync, which is how a scan gets back into
			// payload bytes.
			if (size < head || pos + size > end) return false;
			const type = buf.toString("latin1", pos + 4, pos + 8);
			if (type === "hdlr") {
				// FullBox: 4 version/flags, 4 pre_defined, then handler_type.
				if (buf.toString("latin1", pos + head + 8, pos + head + 12) === "soun") return true;
			} else if (MP4_CONTAINERS.has(type) && walk(pos + head, pos + size)) {
				return true;
			}
			pos += size;
		}
		return false;
	};
	return walk(0, buf.length);
}

/**
 * Why an AVIF might not belong. It is offered *ahead of* the JPEG and never
 * instead of it — an engine that cannot decode AVIF falls through to the same
 * <picture>'s JPEG, and the schema.org screenshot points at the JPEG as well —
 * so the pair only pays for itself while the AVIF is the smaller of the two. An
 * encoder run that came out heavier would hand every modern browser the worse
 * file, and the JPEG would still be in git behind it: two costs for no win.
 */
function avifProblem(file, bytes) {
	const fallback = file.replace(/\.avif$/, ".jpg");
	if (!existsSync(fallback)) {
		return "has no .jpg beside it — engines without AVIF would have nothing to fall back to";
	}
	const fallbackBytes = statSync(fallback).size;
	if (bytes >= fallbackBytes) {
		return (
			`${bytes.toLocaleString()} B is no smaller than its ${fallbackBytes.toLocaleString()} B ` +
			`JPEG. Re-encode it lower, or drop the AVIF and ship the JPEG alone.`
		);
	}
	return null;
}

for (const rule of RULES) {
	const abs = join(ROOT, rule.dir);
	for (const file of walk(abs)) {
		const rel = relative(ROOT, file);
		const bytes = statSync(file).size;
		total += bytes;
		counted += 1;

		if (!rule.ext.some((e) => file.endsWith(e))) {
			problems.push(
				`${rel}: unexpected file type in ${rule.dir} (only ${rule.ext.join(" or ")} belongs here)`,
			);
			continue;
		}
		const ceiling = /-scrub(-sm)?\.mp4$/.test(file) ? SCRUB_MAX : rule.max;
		if (bytes > ceiling) {
			problems.push(
				`${rel}: ${bytes.toLocaleString()} B exceeds the ${ceiling.toLocaleString()} B ceiling`,
			);
		}
		const avifFault = file.endsWith(".avif") && avifProblem(file, bytes);
		if (avifFault) problems.push(`${rel}: ${avifFault}`);
		if (file.endsWith(".mp4") && hasAudioTrack(file)) {
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
