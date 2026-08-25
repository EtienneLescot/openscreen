/**
 * The rest of a real recording: a wallpaper, a webcam track, and cursor telemetry.
 *
 * The first version of this benchmark fed the apps a screen clip and nothing else, and that
 * measured the wrong thing. An export in this category is not a transcode with a coloured
 * border — it is a compositor pass that samples a background image, transforms and masks the
 * recording, renders a *synthetic* cursor from telemetry with smoothing and motion blur, draws
 * a webcam inset with its own mask and shadow, and motion-blurs the whole thing. Leave the
 * cursor and the camera out and the expensive half of the pipeline never runs.
 *
 * Two consequences shape this file:
 *
 * 1. **The cursor must not be drawn into the source.** These apps hide the system pointer while
 *    recording and re-render it at export time from a sidecar. Baking a cursor into the pixels
 *    would exercise nothing and would double-draw once an app rendered its own. So the
 *    trajectory is generated here, written in each app's telemetry format by its driver, and
 *    the screen clip is left clean.
 * 2. **Everything is generated from the same seed**, so a second machine reproduces the whole
 *    bundle — wallpaper, webcam and cursor path included — and can prove it by hash.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveFfmpeg } from "./env.mjs";
import { sha256 } from "./fixture.mjs";
import { pickH264Encoder } from "./platform.mjs";

function run(bin, args) {
	try {
		return execFileSync(bin, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	} catch (e) {
		const msg = (e.stderr?.toString() || e.stdout?.toString() || e.message).trim();
		throw new Error(`${bin.split(/[/\\]/).pop()} failed (exit ${e.status}):\n${msg}`);
	}
}

/* -------------------------------------------------------------------- wallpaper ---------- */

/**
 * A background the compositor has to *sample*, not fill.
 *
 * A flat colour is a single clear; an image is a texture upload and a per-pixel fetch for the
 * whole frame, every frame — which is what the apps' own wallpapers cost. Deliberately light,
 * so the dark recording's edge stays findable by the geometry verifier.
 */
export function buildWallpaper(workDir, spec) {
	const { ffmpeg } = resolveFfmpeg();
	const dir = join(workDir, "fixture");
	mkdirSync(dir, { recursive: true });
	const out = join(dir, `${spec.name}.wallpaper.png`);
	const jpg = join(dir, `${spec.name}.wallpaper.jpg`);
	if (existsSync(out) && existsSync(jpg)) {
		return { path: out, jpeg: jpg, sha256: sha256(out), regenerated: false };
	}

	// A soft diagonal gradient with a few large translucent discs — visually plausible as a
	// product-demo backdrop, and high-frequency enough that a sampler cannot shortcut it.
	const w = spec.width;
	const h = spec.height;
	const discs = [
		[0.18, 0.24, 0.3, "0xffffff@0.16"],
		[0.74, 0.18, 0.22, "0xf3d9c0@0.22"],
		[0.62, 0.78, 0.34, "0xc9d7ee@0.20"],
		[0.3, 0.86, 0.18, "0xffffff@0.12"],
	]
		.map(([cx, cy, r, color]) => {
			const rr = Math.round(r * Math.min(w, h));
			const x = Math.round(cx * w - rr);
			const y = Math.round(cy * h - rr);
			// drawbox has no ellipse; a stack of inset boxes reads as a soft blob once blurred.
			return `drawbox=x=${x}:y=${y}:w=${rr * 2}:h=${rr * 2}:color=${color}:t=fill`;
		})
		.join(",");

	run(ffmpeg, [
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-f",
		"lavfi",
		"-i",
		`gradients=s=${w}x${h}:c0=0x2b3a55:c1=0xd9c9b4:x0=0:y0=0:x1=${w}:y1=${h}:n=2`,
		"-vf",
		`${discs},gblur=sigma=${Math.round(Math.min(w, h) / 12)},format=rgb24`,
		"-frames:v",
		"1",
		out,
	]);
	// A JPEG copy, for apps that take the wallpaper inline rather than by path.
	run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", out, "-q:v", "6", jpg]);
	return { path: out, jpeg: jpg, sha256: sha256(out), regenerated: true };
}

/* ---------------------------------------------------------------------- webcam ----------- */

/**
 * A webcam track: a person-shaped subject that moves, on a backdrop.
 *
 * The point is not realism, it is cost — a second video stream to decode, scale, mask into a
 * rounded or circular inset, and drop a shadow behind, for every frame. Small and 30 fps
 * because that is what webcams actually deliver, and a driver that scales it to the screen
 * clip's 60 fps is doing the work a real project would.
 */
export function buildWebcam(workDir, spec) {
	const { ffmpeg } = resolveFfmpeg();
	const enc = pickH264Encoder(ffmpeg);
	const dir = join(workDir, "fixture");
	mkdirSync(dir, { recursive: true });
	const out = join(dir, `${spec.name}.webcam.mp4`);
	if (existsSync(out)) return { path: out, sha256: sha256(out), regenerated: false };

	const W = 1280;
	const H = 720;
	const fps = 30;
	// Head and shoulders that drift and breathe, so no two frames are identical and the
	// encoder cannot coast — a static webcam would cost almost nothing to composite.
	const headX = `${W / 2}-170+40*sin(2*PI*t/9)`;
	const headY = `${H / 2}-120+22*sin(2*PI*t/5)`;
	const filter = [
		`color=c=0x1d2430:s=${W}x${H}:r=${fps}:d=${spec.durationSec}`,
		`drawbox=x=0:y=0:w=${W}:h=${H}:color=0x243044@1:t=fill`,
		// backdrop pool of light
		`drawbox=x=${Math.round(W * 0.2)}:y=0:w=${Math.round(W * 0.6)}:h=${H}:color=0x2e3b52@0.8:t=fill`,
		// shoulders
		`drawbox=x='${W / 2}-300+40*sin(2*PI*t/9)':y=${Math.round(H * 0.72)}:w=600:h=${Math.round(H * 0.3)}:color=0x3a4a63@1:t=fill`,
		// head
		`drawbox=x='${headX}':y='${headY}':w=340:h=380:color=0xd8b49a@1:t=fill`,
		// hair
		`drawbox=x='${headX}':y='${headY}':w=340:h=90:color=0x3b2f2a@1:t=fill`,
		// eyes, which blink on a 4 s cycle
		`drawbox=x='${headX}+80':y='${headY}+170':w=42:h=22:color=0x2a2320@1:t=fill:enable='gt(mod(t\\,4)\\,0.18)'`,
		`drawbox=x='${headX}+218':y='${headY}+170':w=42:h=22:color=0x2a2320@1:t=fill:enable='gt(mod(t\\,4)\\,0.18)'`,
		// mouth, moving as if speaking
		`drawbox=x='${headX}+130':y='${headY}+270':w=80:h='14+10*abs(sin(2*PI*2.7*t))':color=0x8c4a44@1:t=fill`,
		"format=yuv420p",
	].join(",");

	run(ffmpeg, [
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-f",
		"lavfi",
		"-i",
		filter,
		"-t",
		String(spec.durationSec),
		"-r",
		String(fps),
		"-c:v",
		enc.encoder,
		...enc.rateArgs(6),
		"-pix_fmt",
		"yuv420p",
		"-movflags",
		"+faststart",
		out,
	]);
	return { path: out, sha256: sha256(out), regenerated: true, width: W, height: H, fps };
}

/* ---------------------------------------------------------------------- cursor ----------- */

/**
 * The cursor trajectory, as data.
 *
 * Deterministic from the spec's seed, sampled at a realistic rate, and shaped like real use:
 * long smooth glides, short pauses, and clicks at the pauses — which is exactly the signal the
 * apps' smoothing, click effects and dwell-based auto-zoom react to. A straight-line sweep
 * would let a smoothing implementation do nothing and cost nothing.
 *
 * Positions are normalised (0-1) against the screen frame, matching every format that consumes
 * them; each driver translates this into its app's own sidecar.
 */
export function cursorTrack(spec, { sampleHz = 60 } = {}) {
	const samples = [];
	const total = Math.round(spec.durationSec * sampleHz);
	// Dwell points the pointer travels between — a plausible tour of a UI.
	const stops = [
		[0.12, 0.18],
		[0.46, 0.32],
		[0.78, 0.24],
		[0.62, 0.66],
		[0.24, 0.74],
		[0.52, 0.48],
		[0.86, 0.62],
		[0.3, 0.36],
	];
	const legMs = (spec.durationSec * 1000) / stops.length;
	const glideFraction = 0.62; // the rest of each leg is a pause

	for (let i = 0; i < total; i++) {
		const timeMs = Math.round((i / sampleHz) * 1000);
		const leg = Math.min(stops.length - 1, Math.floor(timeMs / legMs));
		const within = (timeMs % legMs) / legMs;
		const from = stops[leg];
		const to = stops[(leg + 1) % stops.length];

		let cx;
		let cy;
		let interactionType = "move";
		if (within < glideFraction) {
			// Ease-in-out along the leg: acceleration is what smoothing has to work on.
			const u = within / glideFraction;
			const e = u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2;
			cx = from[0] + (to[0] - from[0]) * e;
			cy = from[1] + (to[1] - from[1]) * e;
		} else {
			cx = to[0];
			cy = to[1];
			// One click just after arriving, then stillness — the shape click effects expect.
			const sincePause = (within - glideFraction) * legMs;
			if (sincePause >= 120 && sincePause < 120 + 1000 / sampleHz) interactionType = "click";
			else if (sincePause >= 220 && sincePause < 220 + 1000 / sampleHz) interactionType = "mouseup";
		}
		samples.push({
			timeMs,
			cx: +cx.toFixed(5),
			cy: +cy.toFixed(5),
			visible: true,
			interactionType,
		});
	}
	return samples;
}

/** OpenScreen reads `<screenVideo>.cursor.json`; schema version 2, normalised coordinates. */
export function writeOpenscreenCursor(screenVideoPath, spec) {
	const path = `${screenVideoPath}.cursor.json`;
	writeFileSync(
		path,
		`${JSON.stringify({ version: 2, provider: "native", samples: cursorTrack(spec) }, null, 0)}\n`,
	);
	return path;
}

/**
 * Cap stores its pointer track as a JSON array of `{ process_time_ms, x, y, ... }` beside the
 * segment, referenced by `cursor` in recording-meta.json. Coordinates are normalised, as in
 * `cap-project`'s `CursorEvents`.
 */
export function writeCapCursor(projectDir, spec) {
	const path = join(projectDir, "content", "cursor.json");
	const track = cursorTrack(spec);
	// Field names come from cap-project's CursorMoveEvent / CursorClickEvent: `time_ms`, not
	// the `process_time_ms` a recording's raw log uses. Getting this wrong is silent — Cap
	// parses the file, finds no usable events, and exports with no pointer at all.
	const moves = track.map((s) => ({
		active_modifiers: [],
		cursor_id: "0",
		time_ms: s.timeMs,
		x: s.cx,
		y: s.cy,
	}));
	const clicks = track
		.filter((s) => s.interactionType === "click" || s.interactionType === "mouseup")
		.map((s) => ({
			active_modifiers: [],
			cursor_num: 0,
			cursor_id: "0",
			time_ms: s.timeMs,
			down: s.interactionType === "click",
		}));
	writeFileSync(path, `${JSON.stringify({ clicks, moves }, null, 0)}\n`);
	return path;
}
