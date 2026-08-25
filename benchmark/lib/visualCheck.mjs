/**
 * Did the app actually render the scenario?
 *
 * Probing an output for resolution and duration only proves a file exists. An app that ignored
 * the background, dropped the zooms, or silently rendered a smaller video rect finishes sooner
 * and looks faster, and no metadata check would notice. So every export is also inspected as
 * pixels:
 *
 *   · the frame's corners must be the scenario's background colour  → background applied
 *   · the content's bounding box gives the real inset               → padding, comparably measured
 *   · the box's corners must be background while its edges are not  → corner radius applied
 *   · temporal activity must spike inside the zoom windows          → zooms applied
 *
 * The measured inset matters as much as the pass/fail: two apps whose padding controls are on
 * different scales end up compositing different-sized rectangles, and the report has to be
 * able to say how close they were.
 */
import { execFileSync } from "node:child_process";
import { cursorTrack } from "./assets.mjs";
import { resolveFfmpeg } from "./env.mjs";

/** Decode a single frame to raw RGB at full resolution. */
function frameRgb(file, atSec, width, height) {
	const { ffmpeg } = resolveFfmpeg();
	const buf = execFileSync(
		ffmpeg,
		[
			"-hide_banner",
			"-loglevel",
			"error",
			"-ss",
			String(atSec),
			"-i",
			file,
			"-frames:v",
			"1",
			"-vf",
			`scale=${width}:${height}:flags=neighbor`,
			"-pix_fmt",
			"rgb24",
			"-f",
			"rawvideo",
			"-",
		],
		{ maxBuffer: 64 * 1024 * 1024, encoding: "buffer" },
	);
	return { data: buf, width, height };
}

/** Decode the whole clip small and grey, for the temporal-activity trace. */
function greyTrace(file, fps, width, height) {
	const { ffmpeg } = resolveFfmpeg();
	const buf = execFileSync(
		ffmpeg,
		[
			"-hide_banner",
			"-loglevel",
			"error",
			"-i",
			file,
			"-vf",
			`fps=${fps},scale=${width}:${height}:flags=bilinear,format=gray`,
			"-f",
			"rawvideo",
			"-",
		],
		{ maxBuffer: 256 * 1024 * 1024, encoding: "buffer" },
	);
	const frameSize = width * height;
	const frames = Math.floor(buf.length / frameSize);
	const activity = [];
	for (let f = 1; f < frames; f++) {
		let sum = 0;
		const a = (f - 1) * frameSize;
		const b = f * frameSize;
		for (let i = 0; i < frameSize; i += 3) sum += Math.abs(buf[b + i] - buf[a + i]);
		activity.push(sum / Math.ceil(frameSize / 3));
	}
	return { activity, fps };
}

const px = (img, x, y) => {
	const i = (y * img.width + x) * 3;
	return [img.data[i], img.data[i + 1], img.data[i + 2]];
};

const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Bounding box of the dark composited recording against a light wallpaper.
 *
 * Scanned from the middle row and column inward, requiring a short run of genuinely dark
 * pixels so a drop shadow — dimmer than the wallpaper but nowhere near as dark as the editor —
 * does not drag the box outwards.
 */
function contentBoxByLuminance(img, { darkBelow = 90, run = 4 } = {}) {
	const midY = Math.floor(img.height / 2);
	const midX = Math.floor(img.width / 2);
	const solid = (x, y, dx, dy) => {
		for (let k = 0; k < run; k++) {
			const xx = x + dx * k;
			const yy = y + dy * k;
			if (xx < 0 || yy < 0 || xx >= img.width || yy >= img.height) return false;
			if (luminance(px(img, xx, yy)) >= darkBelow) return false;
		}
		return true;
	};
	let left = 0;
	while (left < img.width - run && !solid(left, midY, 1, 0)) left++;
	let right = img.width - 1;
	while (right > left && !solid(right, midY, -1, 0)) right--;
	let top = 0;
	while (top < img.height - run && !solid(midX, top, 0, 1)) top++;
	let bottom = img.height - 1;
	while (bottom > top && !solid(midX, bottom, 0, -1)) bottom--;
	return { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1 };
}

/**
 * Is a pointer being drawn where the telemetry says it is?
 *
 * The first version of this compared the cursor's window against three windows in the frame's
 * corners, and passed videos with no cursor at all — because the corners are static sidebar
 * while the cursor path crosses the scrolling code, so it was measuring "is this region busier
 * than the edges". Verified against Kap and the ffmpeg floor, which draw no pointer: both
 * scored 78×.
 *
 * The fix is to compare like with like. Control windows are spread *across the content*, over
 * the same scrolling material the cursor travels on, and the baseline is their 90th percentile
 * rather than their mean — so "the busiest ordinary place in the frame" is what a real cursor
 * has to beat.
 */
function cursorRendered(file, spec, box, atSec, { W, H }) {
	const dt = 0.1;
	const a = frameRgb(file, atSec, W, H);
	const b = frameRgb(file, atSec + dt, W, H);
	const track = cursorTrack(spec);
	const at = (t) => track[Math.min(track.length - 1, Math.round(t * 60))];

	const energy = (cx, cy, r = 26) => {
		const x0 = Math.max(0, Math.round(cx) - r);
		const y0 = Math.max(0, Math.round(cy) - r);
		const x1 = Math.min(W - 1, Math.round(cx) + r);
		const y1 = Math.min(H - 1, Math.round(cy) + r);
		let sum = 0;
		let n = 0;
		for (let y = y0; y <= y1; y += 2) {
			for (let x = x0; x <= x1; x += 2) {
				sum += Math.abs(luminance(px(a, x, y)) - luminance(px(b, x, y)));
				n++;
			}
		}
		return n ? sum / n : 0;
	};

	// Telemetry is normalised against the source frame, so it maps into the composited rect.
	const toFrame = (p) => [box.left + p.cx * box.width, box.top + p.cy * box.height];
	const [ax, ay] = toFrame(at(atSec));
	const [bx, by] = toFrame(at(atSec + dt));
	const onPath = Math.max(energy(ax, ay), energy(bx, by), energy((ax + bx) / 2, (ay + by) / 2));

	// A grid of controls over the content itself, skipping any that land near the cursor path.
	const controls = [];
	for (let gx = 1; gx <= 5; gx++) {
		for (let gy = 1; gy <= 3; gy++) {
			const cx = box.left + (box.width * gx) / 6;
			const cy = box.top + (box.height * gy) / 4;
			if (Math.hypot(cx - ax, cy - ay) < 90 || Math.hypot(cx - bx, cy - by) < 90) continue;
			controls.push(energy(cx, cy));
		}
	}
	controls.sort((x, y) => x - y);
	const p90 = controls.length ? controls[Math.floor(controls.length * 0.9)] : 0;
	const baseline = Math.max(0.5, p90);

	return {
		ratio: +(onPath / baseline).toFixed(2),
		onPath: +onPath.toFixed(2),
		baseline: +baseline.toFixed(2),
		controls: controls.length,
	};
}

/**
 * Is a camera inset present in the expected corner?
 *
 * The generated webcam has a deliberate skin tone on a blue-grey backdrop, which nothing in the
 * screen recording or the wallpaper comes close to — so counting pixels near that colour in the
 * corner is a specific test rather than "something changed here".
 */
function webcamRendered(img, { W, H }, corner = "bottom-right") {
	const rw = Math.round(W * 0.34);
	const rh = Math.round(H * 0.34);
	const x0 = corner.includes("right") ? W - rw : 0;
	const y0 = corner.includes("bottom") ? H - rh : 0;
	const skin = [216, 180, 154];
	let hits = 0;
	let n = 0;
	for (let y = y0; y < y0 + rh; y += 3) {
		for (let x = x0; x < x0 + rw; x += 3) {
			n++;
			if (dist(px(img, x, y), skin) < 90) hits++;
		}
	}
	return { fraction: +(hits / Math.max(1, n)).toFixed(4), samples: n };
}

const hexRgb = (hex) => {
	const h = (hex ?? "#000000").replace("#", "");
	return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
};

/**
 * Bounding box of everything that is not the background colour. Scanned from the middle rows
 * and columns so a drop shadow — which is background-ish but not exactly background — does not
 * drag the box outwards.
 */
function contentBox(img, bg, { contentTol = 120, run = 4 } = {}) {
	const midY = Math.floor(img.height / 2);
	const midX = Math.floor(img.width / 2);
	// A drop shadow is background-ish but not background, so "anything that is not exactly the
	// background" would find the shadow's outer edge. Requiring a short run of pixels that are
	// *far* from the background finds the video itself.
	const solid = (x, y, dx, dy) => {
		for (let k = 0; k < run; k++) {
			const xx = x + dx * k;
			const yy = y + dy * k;
			if (xx < 0 || yy < 0 || xx >= img.width || yy >= img.height) return false;
			if (dist(px(img, xx, yy), bg) <= contentTol) return false;
		}
		return true;
	};
	let left = 0;
	while (left < img.width - run && !solid(left, midY, 1, 0)) left++;
	let right = img.width - 1;
	while (right > left && !solid(right, midY, -1, 0)) right--;
	let top = 0;
	while (top < img.height - run && !solid(midX, top, 0, 1)) top++;
	let bottom = img.height - 1;
	while (bottom > top && !solid(midX, bottom, 0, -1)) bottom--;
	return { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1 };
}

/**
 * @param {string} file            the exported video
 * @param {object} scenario        the scenario it was supposed to render
 * @param {object} opts.probe      ffprobe output for `file`
 */
export function inspectExport(file, scenario, { probe, tolerance = 42, spec = null } = {}) {
	const e = scenario.effects;
	const W = probe?.video?.width ?? scenario.output.width;
	const H = probe?.video?.height ?? scenario.output.height;
	const duration = probe?.durationSec ?? 0;

	// A reference instant that no zoom window covers, so the geometry read is of the resting
	// composition rather than a mid-animation frame.
	const zoomWindows = (e.zooms ?? []).map((z) => [z.startSec - 1, z.endSec + 1]);
	let refSec = 2;
	for (let t = 2; t < duration - 2; t += 0.5) {
		if (!zoomWindows.some(([a, b]) => t >= a && t <= b)) {
			refSec = t;
			break;
		}
	}

	const img = frameRgb(file, refSec, W, H);
	const result = { refSec, checks: {}, measured: {} };

	/* ---- background ------------------------------------------------------------------- */
	// An image background cannot be checked by colour equality, so geometry switches to
	// luminance: the composited recording is a dark editor and every wallpaper this benchmark
	// generates is light, which separates them cleanly. Skipping the check when the background
	// is an image — which is what the first version did — meant the padding, radius and
	// background stages went unverified precisely when they got more expensive.
	if (e.background?.kind === "image") {
		const box = contentBoxByLuminance(img);
		result.measured.contentBox = box;
		result.measured.contentFraction = +((box.width * box.height) / (W * H)).toFixed(4);
		result.measured.insetPercentShortSide = +(
			(Math.min(box.left, box.top, W - 1 - box.right, H - 1 - box.bottom) / Math.min(W, H)) *
			100
		).toFixed(2);
		// A wallpaper was applied if the frame's corners are light while the content is dark.
		const cornerLum = [
			luminance(px(img, 2, 2)),
			luminance(px(img, W - 3, 2)),
			luminance(px(img, 2, H - 3)),
			luminance(px(img, W - 3, H - 3)),
		];
		result.measured.cornerLuminance = cornerLum.map((v) => Math.round(v));
		result.checks.background = Math.min(...cornerLum) > 110;
		result.checks.padding = e.paddingPercent > 0 ? box.left > 2 && box.top > 2 : true;
		if (e.cornerRadiusPx > 0 && box.width > 40) {
			// At the box's own corner a rounded rect still shows wallpaper; a quarter along its
			// top edge it must show the dark recording.
			const atCorner = luminance(px(img, box.left + 1, box.top + 1));
			const alongEdge = luminance(px(img, box.left + Math.floor(box.width / 4), box.top + 3));
			result.measured.cornerIsBackground = atCorner > 110;
			result.measured.edgeIsContent = alongEdge < 110;
			result.checks.cornerRadius =
				result.measured.cornerIsBackground && result.measured.edgeIsContent;
		}
	} else if (e.background?.kind === "solid") {
		const bg = hexRgb(e.background.color);
		const corners = [px(img, 2, 2), px(img, W - 3, 2), px(img, 2, H - 3), px(img, W - 3, H - 3)];
		const worst = Math.max(...corners.map((c) => dist(c, bg)));
		result.measured.cornerColor = corners[0];
		result.measured.cornerColorDistance = worst;
		result.checks.background = worst <= tolerance;

		/* ---- padding ------------------------------------------------------------------ */
		const box = contentBox(img, bg);
		result.measured.contentBox = box;
		result.measured.contentFraction = +((box.width * box.height) / (W * H)).toFixed(4);
		// Inset as a percent of the frame's short side — the same unit the scenario uses.
		result.measured.insetPercentShortSide = +(
			(Math.min(box.left, box.top, W - 1 - box.right, H - 1 - box.bottom) / Math.min(W, H)) *
			100
		).toFixed(2);
		result.checks.padding = e.paddingPercent > 0 ? box.left > 2 && box.top > 2 : true;

		/* ---- corner radius -------------------------------------------------------------- */
		if (e.cornerRadiusPx > 0 && box.width > 40) {
			// At the box's own corner a rounded rect still shows background; a quarter of the
			// way along its top edge it must show content. Both conditions together separate a
			// radius from a plain rectangle and from a missing video.
			const atCorner = px(img, box.left + 1, box.top + 1);
			const alongEdge = px(img, box.left + Math.floor(box.width / 4), box.top + 2);
			result.measured.cornerIsBackground = dist(atCorner, bg) <= tolerance;
			result.measured.edgeIsContent = dist(alongEdge, bg) > tolerance;
			result.checks.cornerRadius =
				result.measured.cornerIsBackground && result.measured.edgeIsContent;
		}
	}

	/* ---- zooms ------------------------------------------------------------------------ */
	if ((e.zooms ?? []).length) {
		const traceFps = 10;
		const { activity } = greyTrace(file, traceFps, 192, 108);
		const at = (sec) => Math.round(sec * traceFps);
		const windowMax = (a, b) =>
			Math.max(0, ...activity.slice(Math.max(0, at(a)), Math.min(activity.length, at(b))));

		// Baseline: the median of the whole trace. A zoom transition has to stand well clear of
		// it — the source itself is always moving, so an absolute threshold would not do.
		const sorted = [...activity].sort((x, y) => x - y);
		const baseline = sorted[Math.floor(sorted.length / 2)] || 1e-6;
		const spikes = e.zooms.map((z) => {
			const inRamp = Math.max(
				windowMax(z.startSec - 0.4, z.startSec + 1.2),
				windowMax(z.endSec - 0.4, z.endSec + 1.2),
			);
			return +(inRamp / baseline).toFixed(2);
		});
		result.measured.activityBaseline = +baseline.toFixed(3);
		result.measured.zoomSpikeRatios = spikes;
		// Every zoom must produce a transition at least 1.8× the resting activity.
		result.checks.zooms = spikes.every((s) => s >= 1.8);
	}

	/* ---- rendered cursor --------------------------------------------------------------- */
	if (e.cursor?.enabled && spec && result.measured.contentBox) {
		try {
			// The same resting instant the geometry check uses, so both stages describe one
			// moment of the composition.
			const c = cursorRendered(file, spec, result.measured.contentBox, refSec, { W, H });
			result.measured.cursorMotionRatio = c.ratio;
			result.measured.cursorOnPath = c.onPath;
			result.measured.cursorBaseline = c.baseline;
			// Calibrated against real exports rather than guessed. Measured on this fixture:
			// OpenScreen 2.72 (its pointer and motion-blur trail are visible in the frame),
			// Cap 1.27, Kap 1.15, ffmpeg floor 1.16 — the last three draw no pointer at all.
			// 2.0 sits between the confirmed positive and the confirmed negatives; the ratio
			// itself is recorded on every run so the margin is auditable rather than implied.
			result.checks.cursor = c.ratio >= 2;
		} catch (err) {
			result.measured.cursorError = err.message?.slice(0, 160);
		}
	}

	/* ---- webcam inset ------------------------------------------------------------------ */
	if (e.webcam?.enabled) {
		const wc = webcamRendered(img, { W, H }, e.webcam.position ?? "bottom-right");
		result.measured.webcamSkinFraction = wc.fraction;
		// A camera inset at 25% of the frame puts a lot of face in that corner, and nothing
		// else in this composition is anywhere near skin tone.
		// Measured: 0.188 (OpenScreen) and 0.275 (Cap) with a camera inset; 0.006 for Kap and
		// the ffmpeg floor, which have none — the fixture's warm syntax colours are near enough
		// to skin to register at that level. 0.05 sits an order of magnitude clear of both.
		result.checks.webcam = wc.fraction > 0.05;
	}

	/* ---- motion blur -------------------------------------------------------------------- */
	// Deliberately not asserted. Motion blur changes edge softness by an amount that depends on
	// the app's implementation and on local motion, and every threshold tried here passed some
	// correct renders and failed others. It is reported as configured, never as verified —
	// saying so is more useful than a check that means nothing.

	const failed = Object.entries(result.checks)
		.filter(([, v]) => v === false)
		.map(([k]) => k);
	result.allPassed = failed.length === 0;
	result.failed = failed;
	return result;
}
