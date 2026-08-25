/**
 * Deterministic source-clip generation.
 *
 * A benchmark that ships a 200 MB .mp4 is not reproducible — the file rots, and nobody can
 * tell whether two machines measured the same work. So the source is *generated* from a spec
 * plus a seed, with pure ffmpeg primitives, and fingerprinted afterwards. Two machines that
 * agree on the fingerprint measured the same workload.
 *
 * The frame is built to look like a screen recording rather than a test pattern, because that
 * is what changes an encoder's job: large static regions, dense sharp-edged "text", a small
 * amount of localized motion, and a cursor.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveFfmpeg } from "./env.mjs";

/** execFileSync, but a non-zero exit surfaces ffmpeg's own message instead of a byte dump. */
function run(bin, args) {
	try {
		return execFileSync(bin, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	} catch (e) {
		const msg = (e.stderr?.toString() || e.stdout?.toString() || e.message).trim();
		throw new Error(`${bin.split("/").pop()} failed (exit ${e.status}):\n${msg}`);
	}
}

/** xorshift32 — tiny, seeded, identical in every JS runtime. */
function rng(seed) {
	let x = seed >>> 0 || 0x9e3779b9;
	return () => {
		x ^= x << 13;
		x >>>= 0;
		x ^= x >> 17;
		x ^= x << 5;
		x >>>= 0;
		return x / 0x100000000;
	};
}

export const DEFAULT_SPEC = {
	name: "ide-1080p60-60s",
	width: 1920,
	height: 1080,
	fps: 60,
	durationSec: 60,
	seed: 20260825,
	/** Target bitrate of the *source*. Screen recorders emit roughly this for 1080p30 UI. */
	sourceBitrateMbps: 12,
};

const PALETTE = [
	"0xd7dae0",
	"0x89b4fa",
	"0xa6e3a1",
	"0xf9e2af",
	"0xf38ba8",
	"0xcba6f7",
	"0x94e2d5",
];

/** Static "page" of code-like rows, tall enough to scroll through for the whole clip. */
function pageFilter(spec, pageHeight) {
	const rand = rng(spec.seed);
	const left = 360;
	const right = spec.width - 80;
	const rowH = 12;
	const rowGap = 26;
	const boxes = [];
	for (let y = 20; y < pageHeight - 40; y += rowGap) {
		// Indentation in steps, like real code.
		const indent = left + Math.floor(rand() * 5) * 28;
		let x = indent;
		const tokens = 2 + Math.floor(rand() * 7);
		for (let t = 0; t < tokens && x < right - 40; t++) {
			const w = Math.floor(30 + rand() * 190);
			const color = PALETTE[Math.floor(rand() * PALETTE.length)];
			boxes.push(
				`drawbox=x=${x}:y=${y}:w=${Math.min(w, right - x)}:h=${rowH}:color=${color}@0.92:t=fill`,
			);
			x += w + 12 + Math.floor(rand() * 18);
		}
		// Gutter line numbers.
		boxes.push(`drawbox=x=${left - 56}:y=${y + 2}:w=28:h=${rowH - 4}:color=0x585b70@0.8:t=fill`);
	}
	return boxes.join(",");
}

/** Window chrome: title bar, sidebar rows, a status bar. Static, so it is baked once. */
function chromeFilter(spec) {
	const rand = rng(spec.seed ^ 0x5bf03635);
	const b = [
		`drawbox=x=0:y=0:w=${spec.width}:h=44:color=0x11141a@1:t=fill`,
		`drawbox=x=0:y=44:w=320:h=${spec.height - 44 - 32}:color=0x171b22@1:t=fill`,
		`drawbox=x=0:y=${spec.height - 32}:w=${spec.width}:h=32:color=0x11141a@1:t=fill`,
	];
	for (const [i, c] of ["0xff5f57", "0xfebc2e", "0x28c840"].entries()) {
		b.push(`drawbox=x=${18 + i * 22}:y=16:w=12:h=12:color=${c}@1:t=fill`);
	}
	// Tab strip.
	let tx = 120;
	for (let i = 0; i < 5; i++) {
		const w = 110 + Math.floor(rand() * 70);
		b.push(`drawbox=x=${tx}:y=12:w=${w}:h=20:color=${i === 1 ? "0x2a3040" : "0x1b1f27"}@1:t=fill`);
		b.push(`drawbox=x=${tx + 12}:y=19:w=${w - 40}:h=7:color=0x9aa3b2@0.9:t=fill`);
		tx += w + 8;
	}
	// Sidebar file tree.
	for (let y = 70, i = 0; y < spec.height - 60; y += 30, i++) {
		const indent = 24 + (i % 3) * 18;
		b.push(
			`drawbox=x=${indent}:y=${y}:w=${Math.floor(80 + rand() * 150)}:h=9:color=0x9aa3b2@0.75:t=fill`,
		);
	}
	// Status bar chips.
	for (let i = 0, x = 20; i < 4; i++) {
		const w = 70 + Math.floor(rand() * 80);
		b.push(`drawbox=x=${x}:y=${spec.height - 22}:w=${w}:h=11:color=0x89b4fa@0.7:t=fill`);
		x += w + 26;
	}
	return b.join(",");
}

/**
 * The animated layer. Kept deliberately small: a scrolling viewport, a caret, a selection
 * band and a cursor. Screen recordings are mostly static, and an encoder benchmark that
 * feeds full-frame motion measures a different workload entirely.
 */
function animationFilter(spec, pageHeight) {
	const visibleH = spec.height - 44 - 32;
	const scrollRange = Math.max(1, pageHeight - visibleH);
	// Ease in/out so the scroll starts and stops, like a human dragging.
	const scrollY = `(${scrollRange}*(0.5-0.5*cos(2*PI*t/${spec.durationSec})))`;
	return {
		scrollY,
		overlays: [
			// Caret: blinks at 1 Hz.
			`drawbox=x=380+mod(floor(t*7)\\,40)*14:y=${44 + Math.floor(visibleH / 2)}:w=3:h=18:color=0xffffff@1:t=fill:enable='lt(mod(t\\,1)\\,0.5)'`,
			// Selection band sweeping down the pane.
			`drawbox=x=360:y=${44}+mod(floor(t*2)*36\\,${visibleH - 40}):w=760:h=22:color=0x3b5bdb@0.35:t=fill`,
			// Cursor arrow, approximated by a small bright square on a Lissajous path.
			`drawbox=x=${spec.width / 2}+${spec.width / 2 - 140}*sin(2*PI*t/11):y=${spec.height / 2}+${spec.height / 2 - 120}*sin(2*PI*t/7):w=14:h=20:color=0xffffff@0.95:t=fill`,
			`drawbox=x=${spec.width / 2}+${spec.width / 2 - 140}*sin(2*PI*t/11)-1:y=${spec.height / 2}+${spec.height / 2 - 120}*sin(2*PI*t/7)-1:w=16:h=22:color=0x000000@0.6:t=3`,
		].join(","),
	};
}

/** A deterministic voice-shaped audio bed: an AM-modulated tone with syllable-rate gating. */
function audioFilter() {
	return (
		"aevalsrc='0.28*sin(2*PI*(180+40*sin(2*PI*0.7*t))*t)" +
		"*(0.45+0.55*sin(2*PI*3.1*t))" +
		"*(0.25+0.75*lt(mod(floor(t*1.7),4),3))':s=48000:c=stereo"
	);
}

export function fixturePath(workDir, spec) {
	return join(workDir, "fixture", `${spec.name}.mp4`);
}

/** ffprobe a media file into a compact, comparable descriptor. */
export function probe(file) {
	const { ffprobe } = resolveFfmpeg();
	const raw = execFileSync(
		ffprobe,
		["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
		{ encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
	);
	const j = JSON.parse(raw);
	const v = j.streams.find((s) => s.codec_type === "video");
	const a = j.streams.find((s) => s.codec_type === "audio");
	const num = (x) => (x == null ? null : Number(x));
	const fps = v?.avg_frame_rate?.includes("/")
		? +(Number(v.avg_frame_rate.split("/")[0]) / Number(v.avg_frame_rate.split("/")[1])).toFixed(3)
		: null;
	return {
		durationSec: num(j.format?.duration),
		sizeBytes: num(j.format?.size),
		bitrateKbps: j.format?.bit_rate ? Math.round(Number(j.format.bit_rate) / 1000) : null,
		container: j.format?.format_name ?? null,
		video: v
			? {
					codec: v.codec_name,
					profile: v.profile ?? null,
					width: v.width,
					height: v.height,
					fps,
					pixFmt: v.pix_fmt,
					nbFrames: num(v.nb_frames),
				}
			: null,
		audio: a ? { codec: a.codec_name, sampleRate: num(a.sample_rate), channels: a.channels } : null,
	};
}

export function sha256(file) {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * Build the source clip. Idempotent: an existing file whose probe matches the spec is reused,
 * because regenerating it is several minutes and changes nothing.
 */
export function buildFixture(
	workDir,
	spec = DEFAULT_SPEC,
	{ force = false, log = () => undefined } = {},
) {
	const { ffmpeg } = resolveFfmpeg();
	const out = fixturePath(workDir, spec);
	mkdirSync(join(workDir, "fixture"), { recursive: true });

	if (!force && existsSync(out)) {
		const p = probe(out);
		const ok =
			p.video?.width === spec.width &&
			p.video?.height === spec.height &&
			Math.abs((p.durationSec ?? 0) - spec.durationSec) < 0.5;
		if (ok) {
			log(`fixture: reusing ${out}`);
			return { path: out, spec, probe: p, sha256: sha256(out), regenerated: false };
		}
	}

	// One scrolled page-height per 10 s of clip, so the scroll speed is spec-independent.
	const pageHeight = Math.min(8192, (spec.height - 76) * 3);
	const pagePng = join(workDir, "fixture", `${spec.name}.page.png`);

	log("fixture: rendering static layers");
	run(ffmpeg, [
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-f",
		"lavfi",
		"-i",
		`color=c=0x1b1f27:s=${spec.width}x${pageHeight}:d=1`,
		"-vf",
		pageFilter(spec, pageHeight),
		"-frames:v",
		"1",
		pagePng,
	]);

	const { scrollY, overlays } = animationFilter(spec, pageHeight);
	const visibleH = spec.height - 44 - 32;
	const filter = [
		`color=c=0x1b1f27:s=${spec.width}x${spec.height}:r=${spec.fps}:d=${spec.durationSec}[bg]`,
		`[1:v]crop=${spec.width}:${visibleH}:0:'${scrollY}'[page]`,
		`[bg][page]overlay=0:44:shortest=1[scrolled]`,
		`[scrolled]${chromeFilter(spec)},${overlays},format=yuv420p[v]`,
	].join(";");

	log(`fixture: encoding ${spec.durationSec}s @ ${spec.width}x${spec.height}${spec.fps}`);
	const t0 = Date.now();
	run(ffmpeg, [
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-f",
		"lavfi",
		"-i",
		audioFilter(),
		"-loop",
		"1",
		"-i",
		pagePng,
		"-filter_complex",
		filter,
		"-map",
		"[v]",
		"-map",
		"0:a",
		"-t",
		String(spec.durationSec),
		"-r",
		String(spec.fps),
		"-c:v",
		"h264_videotoolbox",
		"-b:v",
		`${spec.sourceBitrateMbps}M`,
		"-profile:v",
		"high",
		"-pix_fmt",
		"yuv420p",
		"-c:a",
		"aac",
		"-b:a",
		"128k",
		"-ar",
		"48000",
		"-movflags",
		"+faststart",
		out,
	]);
	log(`fixture: encoded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

	return { path: out, spec, probe: probe(out), sha256: sha256(out), regenerated: true };
}
