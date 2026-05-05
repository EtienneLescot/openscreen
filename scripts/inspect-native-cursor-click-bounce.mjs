#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const CLICK_ANIMATION_MS = 260;

function usage() {
	console.error(
		"Usage: node scripts/inspect-native-cursor-click-bounce.mjs <video-or-cursor-json-path> [--bounce=5]",
	);
	process.exit(1);
}

function getCursorJsonPath(inputPath) {
	if (!inputPath) {
		usage();
	}

	const resolved = path.resolve(inputPath);
	if (resolved.endsWith(".cursor.json")) {
		return resolved;
	}
	return `${resolved}.cursor.json`;
}

function getBounceValue() {
	const arg = process.argv.find((value) => value.startsWith("--bounce="));
	const parsed = Number(arg?.slice("--bounce=".length) ?? 5);
	return Number.isFinite(parsed) ? Math.min(5, Math.max(0, parsed)) : 5;
}

function clickBounceProgress(samples, timeMs) {
	for (let index = samples.length - 1; index >= 0; index -= 1) {
		const sample = samples[index];
		if (sample.timeMs > timeMs) {
			continue;
		}

		const ageMs = timeMs - sample.timeMs;
		if (ageMs > CLICK_ANIMATION_MS) {
			return 0;
		}

		if (sample.interactionType === "click") {
			return 1 - ageMs / CLICK_ANIMATION_MS;
		}
	}

	return 0;
}

function clickBounceScale(clickBounce, progress) {
	if (progress <= 0 || clickBounce <= 0) {
		return 1;
	}

	const intensity = Math.min(5, Math.max(0, clickBounce)) / 5;
	const elapsed = 1 - Math.min(1, Math.max(0, progress));
	if (elapsed < 0.38) {
		const pressProgress = Math.sin((elapsed / 0.38) * Math.PI);
		return 1 - pressProgress * intensity * 0.24;
	}

	const reboundProgress = Math.sin(((elapsed - 0.38) / 0.62) * Math.PI);
	return 1 + reboundProgress * intensity * 0.16;
}

const cursorJsonPath = getCursorJsonPath(process.argv[2]);
const clickBounce = getBounceValue();
const parsed = JSON.parse(fs.readFileSync(cursorJsonPath, "utf8"));
const samples = (Array.isArray(parsed) ? parsed : (parsed.samples ?? [])).sort(
	(a, b) => (a.timeMs ?? 0) - (b.timeMs ?? 0),
);
const clicks = samples.filter((sample) => sample.interactionType === "click");

const windows = clicks.slice(0, 8).map((click) => {
	const times = [0, 33, 66, 100, 133, 166, 200, 233, 260].map(
		(offsetMs) => click.timeMs + offsetMs,
	);
	return {
		clickTimeMs: click.timeMs,
		cursorType: click.cursorType ?? null,
		assetId: click.assetId ?? null,
		scales: times.map((timeMs) => ({
			timeMs,
			progress: Number(clickBounceProgress(samples, timeMs).toFixed(3)),
			scale: Number(clickBounceScale(clickBounce, clickBounceProgress(samples, timeMs)).toFixed(3)),
		})),
	};
});

const report = {
	cursorJsonPath,
	provider: parsed.provider ?? (Array.isArray(parsed) ? "legacy-array" : null),
	sampleCount: samples.length,
	assetCount: Array.isArray(parsed.assets) ? parsed.assets.length : 0,
	clickCount: clicks.length,
	interactionCounts: samples.reduce((counts, sample) => {
		const key = sample.interactionType ?? "missing";
		counts[key] = (counts[key] ?? 0) + 1;
		return counts;
	}, {}),
	clickBounce,
	windows,
};

console.log(JSON.stringify(report, null, 2));
if (clicks.length === 0) {
	process.exitCode = 2;
}
