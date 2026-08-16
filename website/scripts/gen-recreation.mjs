#!/usr/bin/env node
/**
 * Emits the data the scroll-driven editor recreation renders.
 *
 * The recreation draws the app's chrome in live DOM. Every string and every
 * number it shows has to come from the same place the app gets it, or the page
 * becomes a drawing of the product that drifts away from it silently — which is
 * exactly what got the previous mock deleted. So nothing here is typed by hand
 * that can be read or computed instead:
 *
 *   - locale strings come from `src/i18n/locales/en/*.json`, through a `t()`
 *     that throws on a missing key and on an unresolved `{{interpolation}}`;
 *   - timecodes come from `formatSec` / `formatMs`, IMPORTED from
 *     `src/lib/ai-edition/timeline/format.ts`. A reimplementation is not a
 *     shortcut, it is the bug: a floor/remainder version renders `0:60.0` at
 *     59.96 where the real one renders `1:00.0`, which is the carry defect that
 *     file's header documents as fixed. It does not bite a 40.033 s fixture,
 *     and that is what makes it dangerous;
 *   - zoom pill labels come from `effectiveZoomScale` / `ZOOM_DEPTH_SCALES`,
 *     imported from `zoom-scale.ts`. Three parts of the app each invented their
 *     own factor for depth 3 and all three were wrong; a hand-typed "1.8×"
 *     re-commits that bug in public and permanently;
 *   - the transcript flow — silence insertion, kept/removed tagging, trim runs
 *     — is produced by the app's own `buildClipSection`, imported from
 *     `aggregated-transcript.ts`;
 *   - the ruler step, the ruler label format and the waveform bar arithmetic are
 *     extracted, as source text, out of `V4Timeline.tsx` and evaluated. That
 *     file cannot be imported (it reaches Zustand, Radix and the `@/` alias),
 *     so the next best thing is to run its actual expressions rather than a
 *     paraphrase of them.
 *
 * Node 22 imports those `.ts` files directly, with no flags and no config
 * (22.18+ strips types by default). The one thing it will not do is resolve the
 * app's extensionless relative specifiers, so a resolve hook adds `.ts` — see
 * `registerHooks` below.
 *
 * USAGE
 *   node scripts/gen-recreation.mjs            # emit generated.ts from the vendored fixture
 *   node scripts/gen-recreation.mjs --check    # emit nowhere; fail if the checked-in file differs
 *   node scripts/gen-recreation.mjs --vendor   # re-read the .openscreen document + decode the
 *                                              # recording's audio, rewriting fixture-slim.json.
 *                                              # Needs the app's Application Support directory and
 *                                              # ffmpeg; run it on a machine that has the project.
 *   node scripts/gen-recreation.mjs --media    # re-cut static/video/canvas-loop{,-sm}.mp4 and
 *                                              # static/img/walkthrough/canvas-poster.jpg. Needs
 *                                              # ffmpeg and the recording. Same caveat.
 *
 * `--check` is the mode CI runs. It must work from a clean checkout with no
 * ffmpeg and no Application Support directory, which is the whole reason
 * `fixture-slim.json` is vendored at all.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── where everything lives ──────────────────────────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
const WEBSITE = resolve(HERE, "..");
const APP = resolve(WEBSITE, "..");
const OUT_DIR = resolve(WEBSITE, "src/components/Recreation");
const FIXTURE = resolve(OUT_DIR, "fixture-slim.json");
const GENERATED = resolve(OUT_DIR, "generated.ts");

const ARGS = new Set(process.argv.slice(2));
const CHECK = ARGS.has("--check");

/** The document this page is a recreation of. Outside the repo on purpose: it is
 *  a real project file in the app's own store, and `--vendor` slims it in. */
const DOC_PATH = resolve(
	homedir(),
	"Library/Application Support/Openscreen/projects/proj_97e2ec4f-78a1-4198-9743-05511c204daa.openscreen",
);
/** The recording that document edits. 8 MB; never vendored, only sampled. */
const RECORDING = resolve(
	homedir(),
	"Library/Application Support/openscreen/recordings/recording-1786032000000.mp4",
);
const FFMPEG = process.env.FFMPEG ?? "ffmpeg";

const SCHEMA_VERSION = 7;

// ── importing the app's TypeScript directly ─────────────────────────────
// The app writes `import { trimAppliesToClip } from "./trim-mapping"` —
// extensionless, which the bundler resolves and Node's ESM resolver does not.
// Rather than copy the functions (the thing this generator exists to avoid),
// teach the resolver the same rule the bundler uses.
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
			const candidate = new URL(`${specifier}.ts`, context.parentURL);
			if (existsSync(fileURLToPath(candidate))) {
				return { url: candidate.href, shortCircuit: true };
			}
		}
		return nextResolve(specifier, context);
	},
});

const appModule = (rel) => import(pathToFileURL(resolve(APP, rel)).href);

const { formatSec, formatMs } = await appModule("src/lib/ai-edition/timeline/format.ts");
const { effectiveZoomScale, ZOOM_DEPTH_SCALES } = await appModule(
	"src/lib/ai-edition/timeline/zoom-scale.ts",
);
const { buildClipSection, isSilenceWord, SILENCE_THRESHOLD_SEC } = await appModule(
	"src/lib/ai-edition/timeline/aggregated-transcript.ts",
);

// ── locale access that fails loudly ─────────────────────────────────────
const locale = (ns) =>
	JSON.parse(readFileSync(resolve(APP, `src/i18n/locales/en/${ns}.json`), "utf8"));
const LOCALES = { editor: locale("editor"), settings: locale("settings"), timeline: locale("timeline") };

/**
 * `t("settings:transcript.silence", { duration: "2.2" })`.
 *
 * Throws on a missing key and on a `{{placeholder}}` left in the result. A
 * renamed key must break the build here rather than ship "transcript.title" as
 * a heading, and a renamed *placeholder* must break it too — that failure is
 * silent in the app (i18next leaves the token in place) and would be invisible
 * on a marketing page nobody reads with a translator's eye.
 */
function t(path, vars = {}) {
	const [ns, key] = path.split(":");
	let node = LOCALES[ns];
	if (!node) throw new Error(`unknown locale namespace ${ns}`);
	for (const part of key.split(".")) {
		node = node?.[part];
		if (node === undefined) throw new Error(`missing locale key ${path}`);
	}
	if (typeof node !== "string") throw new Error(`locale key ${path} is not a string`);
	const out = node.replace(/\{\{(\w+)\}\}/g, (m, name) => {
		if (!(name in vars)) throw new Error(`${path}: no value for {{${name}}}`);
		return String(vars[name]);
	});
	if (/\{\{/.test(out)) throw new Error(`${path}: unresolved interpolation in ${JSON.stringify(out)}`);
	return out;
}

// ── expressions lifted out of V4Timeline.tsx ────────────────────────────
// That file is 1,600 lines of Zustand, Radix and `@/` imports, so it cannot be
// imported. Its *arithmetic* can be, as text: pull the exact source of the
// numbers this page reproduces and evaluate it. A change to any of them lands
// here as a changed output, which `--check` turns into a failed build.
const V4_SRC = readFileSync(
	resolve(APP, "src/components/ai-edition/v4/V4Timeline.tsx"),
	"utf8",
);

function lift(re, what) {
	const m = V4_SRC.match(re);
	if (!m) throw new Error(`could not lift ${what} out of V4Timeline.tsx — it moved or changed shape`);
	return m[1];
}

const TICK_STEPS_SEC = JSON.parse(
	`[${lift(/const TICK_STEPS_SEC = \[([^\]]+)\]/, "TICK_STEPS_SEC").replace(/\s+/g, "").replace(/,$/, "")}]`,
);
const MIN_LABEL_GAP_PX = Number(lift(/const MIN_LABEL_GAP_PX = (\d+)/, "MIN_LABEL_GAP_PX"));
const MINOR_PER_MAJOR = Number(lift(/const MINOR_PER_MAJOR = (\d+)/, "MINOR_PER_MAJOR"));
const AI_ENHANCE_PROMPT = JSON.parse(
	lift(/const AI_ENHANCE_PROMPT =\s*\n?\s*("(?:[^"\\]|\\.)*")/, "AI_ENHANCE_PROMPT"),
);

/** The ruler's label formatter, run rather than paraphrased. */
const fmtTick = new Function(
	`${lift(/(function fmtTick\(sec: number, stepSec: number\): string \{[\s\S]*?\n\})/, "fmtTick")
		.replace(/: number/g, "")
		.replace(/\): string/, ")")}; return fmtTick;`,
)();

/** ClipWaveform's three expressions, in its own words. */
const waveBarCount = new Function(
	"sourceStartSec",
	"sourceEndSec",
	`return ${lift(/const barCount = ([^;]+);/, "waveform barCount")};`,
);
const waveBarHeightPct = new Function(
	"h",
	`return ${lift(/height: `\$\{([^}]+)\}%`/, "waveform bar height")};`,
);
const waveBarOpacity = new Function(
	"h",
	`return ${lift(/opacity: ([^,\n]+),\n/, "waveform bar opacity")};`,
);

// ── the fixture ─────────────────────────────────────────────────────────
if (ARGS.has("--vendor")) vendorFixture();

const doc = JSON.parse(readFileSync(FIXTURE, "utf8"));
if (doc.schemaVersion !== SCHEMA_VERSION) {
	throw new Error(`fixture schemaVersion ${doc.schemaVersion}, expected ${SCHEMA_VERSION}`);
}

/**
 * Slim the real project document into the repo.
 *
 * Kept: everything the recreation reads, in its stored shape, so the vendored
 * copy is still a schemaVersion-7 document and the guard's `schemaVersion`
 * assertion means something. Dropped: `transcripts[]` (a byte-for-byte
 * duplicate of `transcript`) and `transcript.segments` (103 single-word
 * segments that restate `transcript.words`; the pane reads `words`, and the
 * schema defaults `segments` to `[]`). That is half the file for nothing.
 *
 * Added: `vendoredWaveform`, which is NOT part of schemaVersion 7 and is
 * namespaced so it reads as an intruder. The waveform is a property of the
 * recording's audio, the recording is 8 MB and lives outside the repo, and the
 * generator has to run in CI without it — so its 320 decoded amplitudes are
 * vendored beside the document for exactly the reason the document itself is.
 */
function vendorFixture() {
	const full = JSON.parse(readFileSync(DOC_PATH, "utf8"));
	if (full.schemaVersion !== SCHEMA_VERSION) {
		throw new Error(`document schemaVersion ${full.schemaVersion}, expected ${SCHEMA_VERSION}`);
	}
	const slim = {
		schemaVersion: full.schemaVersion,
		project: full.project,
		assets: full.assets,
		transcript: {
			assetId: full.transcript.assetId,
			language: full.transcript.language,
			words: full.transcript.words,
		},
		timeline: full.timeline,
		annotations: full.annotations,
		zoomRanges: full.zoomRanges,
		legacyEditor: full.legacyEditor,
		vendoredWaveform: decodePeaks(full.assets[0]),
	};
	writeFileSync(FIXTURE, `${JSON.stringify(slim, null, "\t")}\n`);
	console.log(`vendored ${FIXTURE}`);
}

/**
 * The 320 bar amplitudes the app's clip card draws.
 *
 * `audioPeaksWorker.ts` is a Web Worker whose only entry point is
 * `self.onmessage`, so it cannot be imported the way `format.ts` can. Its block
 * arithmetic is reproduced here — the one piece of app logic this file
 * duplicates rather than runs, and the reason it is written out in full instead
 * of summarised. Everything downstream of it (bar count, bar height, bar
 * opacity) is lifted from V4Timeline.tsx and evaluated, not retyped.
 */
function decodePeaks(asset) {
	const pcm = execFileSync(
		FFMPEG,
		["-v", "error", "-i", RECORDING, "-vn", "-ac", "2", "-ar", "48000", "-f", "f32le", "-"],
		{ maxBuffer: 1 << 30, encoding: "buffer" },
	);
	const interleaved = new Float32Array(
		pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength),
	);
	const frames = interleaved.length / 2;
	const duration = frames / 48000;

	// audioPeaksWorker.ts: N blocks of min/max over the channel-averaged signal.
	const N = Math.min(24000, Math.ceil(duration * 200));
	const blockSize = frames / N;
	const peaks = new Float32Array(N * 2);
	for (let i = 0; i < N; i++) {
		const start = Math.floor(i * blockSize);
		const end = Math.floor((i + 1) * blockSize);
		let minVal = 0;
		let maxVal = 0;
		for (let j = start; j < end; j++) {
			const sample = (interleaved[j * 2] + interleaved[j * 2 + 1]) / 2;
			if (sample < minVal) minVal = sample;
			if (sample > maxVal) maxVal = sample;
		}
		peaks[i * 2] = minVal;
		peaks[i * 2 + 1] = maxVal;
	}

	// V4Timeline.tsx ClipWaveform: reduce the blocks to one amplitude per bar.
	const durationSec = asset.durationSec;
	const barCount = waveBarCount(0, durationSec);
	const blocksPerSec = N / durationSec;
	const endBlock = Math.min(N, Math.ceil(durationSec * blocksPerSec));
	const rangeBlocks = Math.max(1, endBlock);
	const amps = [];
	for (let i = 0; i < barCount; i++) {
		const blockStart = Math.floor((i / barCount) * rangeBlocks);
		const blockEnd = Math.max(blockStart + 1, Math.floor(((i + 1) / barCount) * rangeBlocks));
		let amp = 0;
		for (let b = blockStart; b < blockEnd && b < N; b++) {
			amp = Math.max(amp, Math.abs(peaks[b * 2]), Math.abs(peaks[b * 2 + 1]));
		}
		amps.push(Number(amp.toFixed(4)));
	}
	return {
		note: "NOT schemaVersion 7. Decoded from the asset's audio track by scripts/gen-recreation.mjs --vendor; vendored because the recording is not in this repo.",
		source: asset.originalPath.replace(/^.*\//, ""),
		sampleRateHz: 48000,
		blocks: N,
		barCount,
		amps,
	};
}

// ── the pieces of the document the recreation draws ─────────────────────
const asset = doc.assets[0];
const clip = doc.timeline.clips[0];
const totalSec = asset.durationSec;
const trims = doc.timeline.trimRanges;

const section = buildClipSection(clip, { ...doc.transcript, segments: [] }, asset, trims);

const pct = (sec) => Number(((sec / totalSec) * 100).toFixed(4));

// ── transcript ──────────────────────────────────────────────────────────
// `buildClipSection` has already inserted the silence pseudo-words, tagged every
// word kept/removed against the two agent trims, and grouped the removed ones
// into runs. All that is left is the label each one carries.
const WORDS = section.words.map((cw, i) => {
	const silence = isSilenceWord(cw.word);
	const durationSec = cw.word.endSec - cw.word.startSec;
	return {
		i,
		id: cw.id,
		kind: silence ? "silence" : "word",
		text: silence ? t("settings:transcript.silence", { duration: durationSec.toFixed(1) }) : cw.word.text,
		startSec: cw.word.startSec,
		endSec: cw.word.endSec,
		kept: cw.kept,
		trimId: cw.trimId,
	};
});

const INSPECTOR = {
	title: t("settings:transcript.title"),
	indexBadge: "1",
	filename: asset.label,
	// RightPanes.tsx:958 — `clipLabel` and the source range joined by " · ",
	// the range itself being two `formatMs` calls around an em dash.
	clipRange: `${t("settings:transcript.clipLabel", { index: 1 })} · ${formatMs(
		clip.sourceStartSec * 1000,
	)}—${formatMs(clip.sourceEndSec * 1000)}`,
	wordCount: WORDS.filter((w) => w.kind === "word").length,
	silenceCount: WORDS.filter((w) => w.kind === "silence").length,
	silenceThresholdSec: SILENCE_THRESHOLD_SEC,
};

// ── lanes and pills ─────────────────────────────────────────────────────
// The app's order, top to bottom (V4Timeline.tsx:1521-1531): annotation, speed,
// trim, zoom, cameraFullscreen. A lane shows its shortcut hint if and only if it
// is empty — which is why the hint list is derived from the pill list and never
// written down beside it.
const zoomPills = doc.zoomRanges.map((z) => ({
	lane: "zoom",
	id: z.id,
	label: `${effectiveZoomScale(z).toFixed(2)}×`,
	startSec: z.sourceStartSec,
	endSec: z.sourceEndSec,
	leftPct: pct(z.sourceStartSec),
	widthPct: pct(z.sourceEndSec - z.sourceStartSec),
	depth: z.depth,
	focusMode: z.focusMode,
}));

const trimPills = trims.map((r) => ({
	lane: "trim",
	id: r.id,
	label: formatSec(r.endSec - r.startSec),
	startSec: r.startSec,
	endSec: r.endSec,
	leftPct: pct(r.startSec),
	widthPct: pct(r.endSec - r.startSec),
	origin: r.origin,
}));

const LANE_ORDER = [
	{ id: "annotation", hintKey: "timeline:hints.pressAnnotation", pills: [] },
	{ id: "speed", hintKey: "timeline:hints.pressSpeed", pills: [] },
	{ id: "trim", hintKey: "timeline:hints.pressTrim", pills: trimPills },
	{ id: "zoom", hintKey: "timeline:hints.pressZoom", pills: zoomPills },
	{ id: "cameraFullscreen", hintKey: "timeline:hints.pressCameraFullscreen", pills: [] },
];

// Cross-check against the document rather than trusting the table above: a lane
// that says it is empty while the document holds regions is the exact failure
// the recreation exists to make impossible.
const DOC_REGION_COUNTS = {
	annotation: doc.annotations.length,
	speed: doc.timeline.speedRanges.length,
	trim: doc.timeline.trimRanges.length,
	zoom: doc.zoomRanges.length,
	cameraFullscreen: doc.legacyEditor.cameraFullscreenRegions.length,
};
for (const lane of LANE_ORDER) {
	if (lane.pills.length !== DOC_REGION_COUNTS[lane.id]) {
		throw new Error(
			`${lane.id} lane emits ${lane.pills.length} pills, document holds ${DOC_REGION_COUNTS[lane.id]}`,
		);
	}
}

const LANES = LANE_ORDER.map((lane) => ({
	id: lane.id,
	hint: lane.pills.length === 0 ? t(lane.hintKey) : null,
	pills: lane.pills,
}));
const PILLS = LANES.flatMap((lane) => lane.pills);

// ── ruler ───────────────────────────────────────────────────────────────
// The step is the first "nice" one whose on-screen gap clears MIN_LABEL_GAP_PX.
// The recreation's timeline canvas is as wide as its world, so pxPerSec is
// world / duration and the step re-derives per breakpoint exactly as the app's
// does per zoom level. At 1920 that lands on 2 s — arithmetically identical to
// the shipped 02-timeline-a.jpg, which is what makes the plate a pixel oracle.
function rulerFor(worldPx) {
	const pxPerSec = worldPx / totalSec;
	const step =
		TICK_STEPS_SEC.find((s) => s * pxPerSec >= MIN_LABEL_GAP_PX) ??
		TICK_STEPS_SEC[TICK_STEPS_SEC.length - 1];
	const minor = step / MINOR_PER_MAJOR;
	const labels = [];
	for (let i = 0; i * step <= totalSec + 1e-6; i++) {
		const sec = i * step;
		labels.push({ sec, leftPct: pct(sec), text: fmtTick(sec, step) });
	}
	return {
		worldPx,
		pxPerSec: Number(pxPerSec.toFixed(4)),
		stepSec: step,
		minorSec: minor,
		minorPct: Number(((minor / totalSec) * 100).toFixed(6)),
		labels,
	};
}

/** Width at which the step drops to the next entry down. Below it the 1920 world
 *  applies; at or above it the world is the viewport and the rule re-steps. */
const WIDE_BREAKPOINT_PX = Math.ceil((MIN_LABEL_GAP_PX * totalSec) / TICK_STEPS_SEC[TICK_STEPS_SEC.indexOf(rulerFor(1920).stepSec) - 1]);

const RULER = {
	minLabelGapPx: MIN_LABEL_GAP_PX,
	minorPerMajor: MINOR_PER_MAJOR,
	tickStepsSec: TICK_STEPS_SEC,
	wideBreakpointPx: WIDE_BREAKPOINT_PX,
	variants: [rulerFor(1920), rulerFor(3440)],
};

// ── waveform ────────────────────────────────────────────────────────────
// 320 bars are 320 elements for a shape nobody can resolve at 2 px. They become
// five <path>s, one per opacity bucket: the app's own `0.5 + amp*0.5` rounded
// down to the nearest tenth, which is the whole of the declared quantisation.
// Geometry is left in ruler units — one unit per bar slot, 100 units tall — so
// the component can stretch it with `preserveAspectRatio="none"` and keep the
// bars at the app's literal 2 px with `vector-effect: non-scaling-stroke`.
const OPACITY_BUCKETS = [0.5, 0.6, 0.7, 0.8, 0.9];

function buildWaveform() {
	const amps = doc.vendoredWaveform.amps;
	const buckets = OPACITY_BUCKETS.map(() => []);
	for (let i = 0; i < amps.length; i++) {
		const h = amps[i];
		const exact = Number(waveBarOpacity(h));
		const bucket = Math.min(OPACITY_BUCKETS.length - 1, Math.floor((exact - 0.5) / 0.1 + 1e-9));
		const heightPct = waveBarHeightPct(h);
		const y0 = (100 - heightPct) / 2;
		const y1 = y0 + heightPct;
		buckets[bucket].push(`M${i + 0.5} ${trimNum(y0)}V${trimNum(y1)}`);
	}
	return {
		viewBox: `0 0 ${amps.length} 100`,
		barCount: amps.length,
		strokeWidthPx: 2,
		gapPx: 1,
		note: "preserveAspectRatio=none; stroke-width 2 with vector-effect:non-scaling-stroke reproduces .tlWave span {max-width:2px}",
		paths: buckets.map((segments, i) => ({
			opacity: OPACITY_BUCKETS[i],
			bars: segments.length,
			d: segments.join(""),
		})),
	};
}

const trimNum = (n) => String(Number(n.toFixed(1)));
const WAVEFORM = buildWaveform();

// ── chat ────────────────────────────────────────────────────────────────
/**
 * The agent's reply.
 *
 * THE WEAKEST PROVENANCE ON THIS PAGE, and it is labelled as such in
 * PROVENANCE. The conversation is not in the project document and there is no
 * conversations store on disk: its only existence is
 * `static/img/walkthrough/04-agent-a.jpg`, which the page already ships. This
 * is a transcription of the message body visible in that photograph.
 *
 * What is NOT transcribed: every number and every quoted word. The two timecode
 * pairs, the two silence durations, the two quoted words and the cut total are
 * `{{placeholders}}` filled from `timeline.trimRanges` and `transcript.words`,
 * so a re-cut document moves them and a stale transcription cannot outlive the
 * edit it describes.
 *
 * What is transcribed and deliberately left alone: "40.0s → 33.0s" and
 * "1.8×/2.2×". Both are the model's own rounding of values this file computes
 * differently (32.93 s; 1.80×/2.20×). They stay as the model wrote them because
 * the page is quoting a message, not rendering a readout — see PROVENANCE.
 *
 * The photograph's scrollback also shows a fragment above this body
 * (`"think."). Cutting both:Both trims landed. …`) — the tail of the agent's
 * tool-call narration, cut off mid-sentence by the top of the pane. It is not
 * transcribed: half a sentence is not a source.
 */
const AGENT_REPLY_MARKDOWN = `Here's what I found and cut:

**Finding:** The speech itself is nearly gapless — every pause between spoken words is well under a second, so there were no internal silences to remove. The only silences over 1s were at the two ends:

**Cuts applied (both on your single placed clip, which is untouched otherwise):**

- **{{trim1}}** — the {{dur1}}s dead lead-in before "{{firstWord}}" (cut)
- **{{trim2}}** — the ~{{dur2}}s dead tail after "{{lastWord}}" (cut)

The video now runs from "{{firstWord}}" straight through to "{{lastWord}}" — about **{{cutSeconds}} seconds shorter** (40.0s → 33.0s of playable footage).

Your zooms (incl. the manual 1.8×/2.2× punches) stay anchored to the same moments in the narration.

One note: the cut starts the video right at the first word with no lead-in. If you'd rather keep a half-second of breathing room before "{{firstWord}}" say the word and I'll restore a short lead.`;

/** `35.12`, `40.03`, `0` — the agent's own way of writing a source second. */
const sourceSec = (n) => String(Number(n.toFixed(2)));

const spokenWords = WORDS.filter((w) => w.kind === "word");
const cutSec = trims.reduce((sum, r) => sum + (r.endSec - r.startSec), 0);

const agentVars = {
	trim1: `${sourceSec(trims[0].startSec)}–${sourceSec(trims[0].endSec)}s`,
	trim2: `${sourceSec(trims[1].startSec)}–${sourceSec(trims[1].endSec)}s`,
	dur1: (trims[0].endSec - trims[0].startSec).toFixed(1),
	dur2: (trims[1].endSec - trims[1].startSec).toFixed(1),
	firstWord: spokenWords[0].text,
	lastWord: spokenWords[spokenWords.length - 1].text,
	cutSeconds: String(Math.round(cutSec)),
};

const agentReplyText = AGENT_REPLY_MARKDOWN.replace(/\{\{(\w+)\}\}/g, (m, name) => {
	if (!(name in agentVars)) throw new Error(`agent reply: no value for {{${name}}}`);
	return agentVars[name];
});
if (/\{\{/.test(agentReplyText)) throw new Error("agent reply: unresolved interpolation");

/**
 * Minimal block structure so the component does not need a markdown parser for
 * one message. `**bold**` becomes runs; `- ` becomes a list item.
 */
function parseReply(md) {
	return md
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const li = line.startsWith("- ");
			const body = li ? line.slice(2) : line;
			const runs = body
				.split(/(\*\*[^*]+\*\*)/g)
				.filter(Boolean)
				.map((piece) =>
					piece.startsWith("**")
						? { text: piece.slice(2, -2), strong: true }
						: { text: piece, strong: false },
				);
			return { kind: li ? "li" : "p", runs };
		});
}

/**
 * `applied: added 2 trims`.
 *
 * The prefix is a locale string; the rest is the shape the bulk-add tool emits
 * (`electron/ai-edition/agent-tools.ts`: `added ${n} ${noun}${n === 1 ? "" : "s"}`)
 * with n counted off the document — the trims whose `origin` is `agent`.
 */
const agentTrimCount = trims.filter((r) => r.origin === "agent").length;
const CHAT = {
	conversationTitle: `${t("editor:chat.untitledConversation")} 1`,
	emptyState: t("editor:chat.emptyState"),
	authorUser: t("editor:chat.authorUser"),
	authorAssistant: t("editor:chat.authorAssistant"),
	userPrompt: AI_ENHANCE_PROMPT,
	agentReply: parseReply(agentReplyText),
	agentReplyText,
	applied: `${t("editor:chat.appliedPrefix")} added ${agentTrimCount} trim${agentTrimCount === 1 ? "" : "s"}`,
	composerPlaceholder: t("editor:chat.composerPlaceholder"),
	modelChip: "deepseek-v4-flash",
};

// ── stage, transport, toolbar ───────────────────────────────────────────
// The recreation shows the loop that plays inside zoom region 2, so the picture
// on the canvas, the 2.20× pill under it and the playhead's position are three
// renderings of one fact and cannot disagree.
const LOOP_ZOOM = doc.zoomRanges[1];
const LOOP = {
	startSec: LOOP_ZOOM.sourceStartSec,
	/** Where the footage stops. The clip ends 0.2 s later on a held frame — see
	 *  the encode note at the bottom of this file. */
	contentEndSec: 24.3,
	contentDurationSec: 6.8,
	durationSec: 7,
	dissolveSec: 0.6,
	holdSec: 0.2,
	zoomScale: effectiveZoomScale(LOOP_ZOOM),
	crop: { w: 872, h: 490, x: 524, y: 295 },
	src: "/video/canvas-loop.mp4",
	srcSmall: "/video/canvas-loop-sm.mp4",
	poster: "/img/walkthrough/canvas-poster.jpg",
	width: 836,
	height: 470,
	widthSmall: 640,
	heightSmall: 360,
	/** `t = startSec + Math.min(video.currentTime, contentDurationSec)` — the
	 *  driver must clamp, or the last 0.2 s reports time the footage never
	 *  reaches. */
	timeMapping: "startSec + min(currentTime, contentDurationSec)",
};

// PreviewCanvas.tsx:238 — padding shrinks the whole content block, not just the
// screen: paddingFit = clamp(1 - (padding/100) * 0.4, 0.4, 1).
const FRAME = { width: 1071, height: 603 };
const paddingFit = Math.min(1, Math.max(0.4, 1 - (Math.min(100, Math.max(0, doc.legacyEditor.padding)) / 100) * 0.4));
const contentBox = {
	width: Math.round(FRAME.width * paddingFit),
	height: Math.round(FRAME.height * paddingFit),
};
const screenScale = Math.min(
	contentBox.width / asset.video.width,
	contentBox.height / asset.video.height,
);
const STAGE = {
	aspectRatio: doc.legacyEditor.aspectRatio,
	wallpaper: doc.legacyEditor.wallpaper,
	padding: doc.legacyEditor.padding,
	paddingFit: Number(paddingFit.toFixed(3)),
	borderRadius: doc.legacyEditor.borderRadius,
	frame: FRAME,
	contentBox,
	screen: {
		width: Math.round(asset.video.width * screenScale),
		height: Math.round(asset.video.height * screenScale),
	},
	webcam: null,
	webcamReason:
		"assets[0].cameraTrack.visible is false and legacyEditor.webcamLayoutPreset is \"no-webcam\" — there is no bubble to draw",
};

const TRANSPORT = {
	restCurrent: formatSec(LOOP.startSec),
	endCurrent: formatSec(LOOP.contentEndSec),
	total: formatSec(totalSec),
	restLeftPct: pct(LOOP.startSec),
	endLeftPct: pct(LOOP.contentEndSec),
};

const TOOLBAR = {
	aspectRatio: doc.legacyEditor.aspectRatio,
	panKbd: "Shift+Scroll",
	panLabel: t("timeline:labels.pan"),
	zoomKbd: "Ctrl+Scroll",
	zoomLabel: t("timeline:labels.zoom"),
	clipLabel: asset.label,
};

// ── tokens the recreation renders text on ───────────────────────────────
// Read out of the app's own dark block so the guard's contrast assertions are
// made against the real values, not a copy of them.
const TOKENS_SRC = readFileSync(resolve(APP, "src/styles/design-tokens.css"), "utf8");
const darkBlock = TOKENS_SRC.slice(TOKENS_SRC.indexOf(':root[data-theme="dark"]'));
function token(name) {
	const m = darkBlock.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8});`));
	if (!m) throw new Error(`token --${name} not found in the dark block of design-tokens.css`);
	return m[1];
}
const TOKENS = {
	surface: token("surface"),
	surface1: token("surface-1"),
	surface2: token("surface-2"),
	surface3: token("surface-3"),
	border: token("border"),
	borderHi: token("border-hi"),
	fg: token("fg"),
	fg2: token("fg-2"),
	muted: token("muted"),
	/** The one declared divergence: the app's `--meta` (#5b6470) computes 2.97:1
	 *  on --surface-1 and fails AA. The lane hints and the ruler labels use
	 *  `--muted` instead, one step up the app's own neutral ramp, at 5.87:1. */
	meta: token("muted"),
	metaInApp: token("meta"),
	accent: token("accent"),
	danger: token("danger"),
	playhead: "#6c55ff",
};

const CONTRAST_PAIRS = [
	[TOKENS.fg, TOKENS.surface, "transcript word on the inspector"],
	[TOKENS.muted, TOKENS.surface1, "clip range on the inspector"],
	[TOKENS.meta, TOKENS.surface, "lane hint on the floor"],
	[TOKENS.meta, TOKENS.surface, "ruler label on the floor"],
	[TOKENS.accent, TOKENS.surface, "zoom pill label"],
	[TOKENS.danger, TOKENS.surface, "trim pill label and struck silence"],
	[TOKENS.fg, TOKENS.surface2, "chat message body"],
	[TOKENS.muted, TOKENS.surface, "chat author label"],
	[TOKENS.accent, TOKENS.surface, "applied line"],
	[TOKENS.muted, TOKENS.surface1, "composer placeholder"],
];

// ── provenance ──────────────────────────────────────────────────────────
// One entry per string the recreation puts on screen. `shown` is the literal
// text; `source` says where it came from, precisely enough that a reader can go
// and check. "computed:" marks a value derived at build time rather than quoted.
const PROVENANCE = [
	{ shown: INSPECTOR.title, source: "src/i18n/locales/en/settings.json → transcript.title" },
	{
		shown: INSPECTOR.clipRange,
		source: `computed: settings.json transcript.clipLabel with index 1, joined to formatMs(${clip.sourceStartSec * 1000}) and formatMs(${clip.sourceEndSec * 1000}) from src/lib/ai-edition/timeline/format.ts`,
	},
	{ shown: INSPECTOR.filename, source: "fixture assets[0].label" },
	...WORDS.filter((w) => w.kind === "silence").map((w) => ({
		shown: w.text,
		source: `computed: settings.json transcript.silence over the ${(w.endSec - w.startSec).toFixed(3)}s gap ${w.startSec}–${w.endSec} that buildClipSection inserted at SILENCE_THRESHOLD_SEC ${SILENCE_THRESHOLD_SEC}; ${w.kept ? "outside any trim" : `inside trimRange ${w.trimId}`}`,
	})),
	{
		// The whole spoken flow, as one string. The fixture stores ONE WORD per
		// entry, so a check that asserts this against the document only resolves
		// if it rejoins them in start order — which is the point of quoting it
		// whole rather than claiming "103 words" and asserting nothing.
		shown: spokenWords.map((w) => w.text).join(" "),
		source: "fixture transcript.words, rejoined in start order; every entry is rendered as its own span",
	},
	{
		shown: CHAT.conversationTitle,
		source: "computed: editor.json chat.untitledConversation + the session index, as LeftPanel.tsx:1433 renders it",
	},
	{ shown: CHAT.emptyState, source: "editor.json chat.emptyState" },
	{ shown: CHAT.authorUser, source: "editor.json chat.authorUser" },
	{ shown: CHAT.authorAssistant, source: "editor.json chat.authorAssistant" },
	{
		shown: CHAT.userPrompt,
		source: "src/components/ai-edition/v4/V4Timeline.tsx AI_ENHANCE_PROMPT, lifted verbatim as source text",
	},
	{
		shown: CHAT.agentReplyText,
		source:
			"photograph: static/img/walkthrough/04-agent-a.jpg — hand-transcribed; the conversation is in no store on disk and this photograph is its only existence. THE WEAKEST PROVENANCE ON THE PAGE. Every timecode, duration, quoted word and cut total in it is regenerated from timeline.trimRanges and transcript.words, not transcribed. Two figures are transcribed as the model wrote them and disagree with this file's arithmetic on purpose: \"33.0s\" (recomputed: 32.93s) and \"1.8×/2.2×\" (the pills read 1.80×/2.20×). The page is quoting a message, not drawing a readout.",
	},
	{
		shown: CHAT.applied,
		source: `computed: editor.json chat.appliedPrefix + the bulk-add tool's own wording (electron/ai-edition/agent-tools.ts: added \${n} \${noun}s) with n = ${agentTrimCount}, the trimRanges whose origin is "agent"`,
	},
	{ shown: CHAT.composerPlaceholder, source: "editor.json chat.composerPlaceholder" },
	{
		shown: CHAT.modelChip,
		source:
			"photograph: static/img/walkthrough/editor-1560.jpg — what was on screen when the plate was shot. NOT in provider-registry.ts; it was typed into an OpenAI-compatible provider config. The one visible string whose referent cannot be verified in the source, kept because the photographs beside it already ship it.",
	},
	...zoomPills.map((p) => ({
		shown: p.label,
		source: `computed: effectiveZoomScale(zoomRanges depth ${p.depth}).toFixed(2) + "×" from src/lib/ai-edition/timeline/zoom-scale.ts`,
	})),
	...trimPills.map((p) => ({
		shown: p.label,
		source: `computed: formatSec(${p.endSec} − ${p.startSec}) over trimRange ${p.id}`,
	})),
	...LANES.filter((l) => l.hint).map((l) => ({
		shown: l.hint,
		source: `timeline.json hints.press${l.id[0].toUpperCase()}${l.id.slice(1)} — rendered because the document holds no ${l.id} regions`,
	})),
	{
		shown: RULER.variants[0].labels.map((l) => l.text).join(" "),
		source: `computed: fmtTick lifted from V4Timeline.tsx over a ${RULER.variants[0].stepSec}s step, itself derived as the first TICK_STEPS_SEC entry clearing MIN_LABEL_GAP_PX ${MIN_LABEL_GAP_PX} at ${RULER.variants[0].pxPerSec} px/s`,
	},
	{ shown: TRANSPORT.total, source: `computed: formatSec(assets[0].durationSec = ${totalSec})` },
	{ shown: TRANSPORT.restCurrent, source: `computed: formatSec(zoomRanges[1].sourceStartSec = ${LOOP.startSec}) — where the loop starts` },
	{ shown: TOOLBAR.aspectRatio, source: "fixture legacyEditor.aspectRatio" },
	{ shown: `${TOOLBAR.panKbd} ${TOOLBAR.panLabel}`, source: "computed: timeline.json labels.pan, with the key hint V4Timeline.tsx:1474 writes beside it" },
	{ shown: `${TOOLBAR.zoomKbd} ${TOOLBAR.zoomLabel}`, source: "computed: timeline.json labels.zoom, with the key hint V4Timeline.tsx:1477 writes beside it" },
	{ shown: TOOLBAR.clipLabel, source: "fixture assets[0].label, as the clip card's own label" },
];

// A string that claims a locale source but is not in the locale files is the
// failure this array exists to catch, so catch it here too rather than only in
// the guard.
const localeCorpus = JSON.stringify(LOCALES);
for (const entry of PROVENANCE) {
	if (!entry.source.includes(".json →") && !/\.json /.test(entry.source)) continue;
	if (entry.source.startsWith("computed:")) continue;
	if (!localeCorpus.includes(JSON.stringify(entry.shown).slice(1, -1))) {
		throw new Error(`PROVENANCE claims a locale source for ${JSON.stringify(entry.shown)}, which is not in en/*.json`);
	}
}

// ── emit ────────────────────────────────────────────────────────────────
const banner = `/**
 * GENERATED FILE — do not edit. Run \`node scripts/gen-recreation.mjs\` instead.
 *
 * Every value below was read out of, or computed from, one of:
 *   · src/components/Recreation/fixture-slim.json (the project document, schemaVersion ${SCHEMA_VERSION})
 *   · ../src/i18n/locales/en/{editor,settings,timeline}.json
 *   · ../src/lib/ai-edition/timeline/{format,zoom-scale,aggregated-transcript}.ts, imported and run
 *   · ../src/components/ai-edition/v4/V4Timeline.tsx, lifted as source text and evaluated
 *   · ../src/styles/design-tokens.css
 *   · static/img/walkthrough/04-agent-a.jpg and editor-1560.jpg (two strings; see PROVENANCE)
 *
 * PROVENANCE names the source of every string this file puts on screen. Nothing
 * that could not be sourced was invented to fill a gap: the chat's context pill
 * is absent for that reason, and so is the webcam bubble.
 */`;

const lit = (value) => JSON.stringify(value, null, "\t");
/** One row per entry. The word list is 106 objects; pretty-printing it costs ~11 KB
 *  of shipped bundle for indentation nobody reads. One line each stays diffable. */
const litRows = (rows) => `[
${rows.map((r) => `	${JSON.stringify(r)},`).join("\n")}
]`;

/** The ruler, pretty everywhere except its 21 + 41 label rows. */
const litRuler = (ruler) =>
	lit({ ...ruler, variants: ruler.variants.map((v, i) => ({ ...v, labels: `__LABELS_${i}__` })) })
		.replace(/"__LABELS_(\d+)__"/g, (_m, i) => litRows(ruler.variants[Number(i)].labels));

const generated = `${banner}

export interface RecreationWord {
	i: number;
	id: string;
	kind: "word" | "silence";
	text: string;
	startSec: number;
	endSec: number;
	kept: boolean;
	trimId: string | null;
}

export interface RecreationPill {
	lane: string;
	id: string;
	label: string;
	startSec: number;
	endSec: number;
	leftPct: number;
	widthPct: number;
	/** zoom lanes only — the stored ordinal the label was derived from. */
	depth?: number;
	/** zoom lanes only. */
	focusMode?: string;
	/** trim lanes only — "agent" for the two the agent placed. */
	origin?: string;
}

export interface RecreationLane {
	id: string;
	hint: string | null;
	pills: RecreationPill[];
}

export interface ProvenanceEntry {
	shown: string;
	source: string;
}

/** Where this data came from, and what it is a recreation of. */
export const META = ${lit({
	schemaVersion: doc.schemaVersion,
	projectId: doc.project.id,
	projectTitle: doc.project.title,
	assetLabel: asset.label,
	assetDurationSec: totalSec,
	assetVideo: asset.video,
	cameraTrackVisible: asset.cameraTrack.visible,
	generator: "website/scripts/gen-recreation.mjs",
})} as const;

/** The transcript pane's header. */
export const INSPECTOR = ${lit(INSPECTOR)} as const;

/**
 * The transcript flow, produced by the app's own \`buildClipSection\`: ${INSPECTOR.wordCount}
 * words and ${INSPECTOR.silenceCount} silence markers, each tagged kept or removed against the
 * document's two agent trims. ${WORDS.filter((w) => !w.kept).length} entries are removed, all of them silences.
 */
export const WORDS: RecreationWord[] = ${litRows(WORDS)};

/** The five lanes in the app's order. A lane carries its shortcut hint if and
 *  only if the document holds no regions for it. */
export const LANES: RecreationLane[] = ${litRows(LANES)};

/** Every pill on the floor, flattened. */
export const PILLS: RecreationPill[] = ${litRows(PILLS)};

/** The ruler, re-derived per breakpoint the way the app re-derives it per zoom. */
export const RULER = ${litRuler(RULER)} as const;

/** ${WAVEFORM.barCount} bars in five opacity buckets, five paths. */
export const WAVEFORM = ${lit(WAVEFORM)} as const;

/** The conversation. */
export const CHAT = ${lit(CHAT)} as const;

/** The preview frame's geometry, and the loop that plays inside it. */
export const STAGE = ${lit(STAGE)} as const;
export const LOOP = ${lit(LOOP)} as const;

export const TRANSPORT = ${lit(TRANSPORT)} as const;
export const TOOLBAR = ${lit(TOOLBAR)} as const;

/** The app's dark tokens, read out of design-tokens.css. */
export const TOKENS = ${lit(TOKENS)} as const;

/** One entry per string on screen. */
export const PROVENANCE: ProvenanceEntry[] = ${litRows(PROVENANCE)};

/** What check-recreation.mjs asserts against. */
export const MARKUP = {
	pills: PILLS,
	hints: LANES.filter((lane) => lane.hint !== null).map((lane) => lane.id),
	words: WORDS,
	contrastPairs: ${lit(CONTRAST_PAIRS)} as [string, string, string][],
} as const;
`;

if (CHECK) {
	const current = existsSync(GENERATED) ? readFileSync(GENERATED, "utf8") : "";
	if (current !== generated) {
		console.error(
			"generated.ts is stale — a locale key, a timeline constant, a token or the document moved.\n" +
				"Run `node scripts/gen-recreation.mjs` and commit the result.",
		);
		process.exit(1);
	}
	console.log(`recreation data up to date — ${PROVENANCE.length} strings, ${WORDS.length} words, ${PILLS.length} pills`);
} else {
	mkdirSync(OUT_DIR, { recursive: true });
	writeFileSync(GENERATED, generated);
	console.log(
		`wrote ${GENERATED}\n  ${WORDS.length} transcript entries (${INSPECTOR.wordCount} words, ${INSPECTOR.silenceCount} silences)\n` +
			`  ${PILLS.length} pills, ${LANES.filter((l) => l.hint).length} hints, ${RULER.variants[0].labels.length}/${RULER.variants[1].labels.length} ruler labels\n` +
			`  ${WAVEFORM.barCount} waveform bars in ${WAVEFORM.paths.length} paths, ${PROVENANCE.length} provenance entries`,
	);
}

if (ARGS.has("--media")) cutMedia();

/**
 * Cut the canvas loop.
 *
 * The window is zoom region 2 — ${'`'}zoomRanges[1]${'`'}, 17.5→24.5 s at depth 4 — and the
 * footage is pre-cropped to that region's 2.20× framing, centred on its focus.
 * Choosing that window is what makes the picture, the 2.20× pill under it and
 * the playhead's position three renderings of one fact: the clip never leaves
 * the region, so no frame of the loop can contradict the chrome around it.
 *
 * Seamlessness, since the clip loops forever and is never seeked: the first
 * frame is the frame at 17.5 s exactly (which is also the poster), and the last
 * 0.6 s dissolves back into a held copy of that same first frame, followed by
 * 0.2 s of hold. Measured pre-encode, the last four frames are bit-identical to
 * frame 0; after encoding they differ by 1.88/255 mean luma, which is the
 * quantiser, not the cut. The dissolve lands entirely inside the recording's own
 * static stretch (23.3–24.4 s), so nothing that is moving is faded.
 *
 * -an is not optional: WebKit refuses gesture-free autoplay for media that
 * carries an audio track at all, muted or not, and check-media-budget.mjs fails
 * the build on one.
 */
function cutMedia() {
	const videoDir = resolve(WEBSITE, "static/video");
	const imgDir = resolve(WEBSITE, "static/img/walkthrough");
	const filter = (w, h) =>
		`[0:v]crop=${LOOP.crop.w}:${LOOP.crop.h}:${LOOP.crop.x}:${LOOP.crop.y},scale=${w}:${h}:flags=lanczos,fps=30,format=yuv420p,setpts=PTS-STARTPTS,split=2[a][h];` +
		`[h]trim=start_frame=0:end_frame=1,setpts=PTS-STARTPTS,loop=loop=23:size=1:start=0,setpts=N/30/TB,fps=30[b];` +
		`[a][b]xfade=transition=fade:duration=${LOOP.dissolveSec}:offset=${LOOP.contentDurationSec - LOOP.dissolveSec},format=yuv420p[v]`;
	const encode = (w, h, bitrate, maxrate, bufsize, out) =>
		execFileSync(
			FFMPEG,
			[
				// prettier-ignore
				"-y", "-v", "error",
				"-ss", String(LOOP.startSec), "-t", String(LOOP.contentDurationSec), "-i", RECORDING,
				"-filter_complex", filter(w, h),
				"-map", "[v]", "-an",
				"-c:v", "h264_videotoolbox",
				"-b:v", bitrate, "-maxrate", maxrate, "-bufsize", bufsize,
				"-g", "60",
				// An IDR where the hold begins re-quantises the held frame against the
				// same source as frame 0, which halves the visible step at the wrap.
				"-force_key_frames", `0,${LOOP.contentDurationSec}`,
				"-movflags", "+faststart",
				resolve(videoDir, out),
			],
			{ stdio: "inherit" },
		);

	mkdirSync(videoDir, { recursive: true });
	mkdirSync(imgDir, { recursive: true });
	encode(LOOP.width, LOOP.height, "138k", "230k", "450k", "canvas-loop.mp4");
	encode(LOOP.widthSmall, LOOP.heightSmall, "62k", "110k", "220k", "canvas-loop-sm.mp4");

	// The poster is the loop's own first frame, at the crop's native size. It is
	// NOT upscaled past that: the 2.20× crop is 872 px wide in the master, so a
	// 1252 px poster would be invented sharpness on the one image the reader
	// looks at longest — it is what shows at rest, under reduced motion, without
	// JavaScript, before the driver attaches, and in print.
	execFileSync(
		FFMPEG,
		[
			// prettier-ignore
			"-y", "-v", "error",
			"-ss", String(LOOP.startSec), "-i", RECORDING, "-frames:v", "1",
			"-vf", `crop=${LOOP.crop.w}:${LOOP.crop.h}:${LOOP.crop.x}:${LOOP.crop.y}`,
			"-c:v", "mjpeg", "-q:v", "4", "-pix_fmt", "yuvj420p",
			resolve(imgDir, "canvas-poster.jpg"),
		],
		{ stdio: "inherit" },
	);
	console.log("cut static/video/canvas-loop{,-sm}.mp4 and static/img/walkthrough/canvas-poster.jpg");
}
