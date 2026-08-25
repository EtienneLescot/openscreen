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
export function inspectExport(file, scenario, { probe, tolerance = 42 } = {}) {
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
	if (e.background?.kind === "solid") {
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

	const failed = Object.entries(result.checks)
		.filter(([, v]) => v === false)
		.map(([k]) => k);
	result.allPassed = failed.length === 0;
	result.failed = failed;
	return result;
}
