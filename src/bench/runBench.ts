/**
 * Headless export bench — the real pipeline, driven from a command line.
 *
 * Runs inside the app's own editor window (windowType=bench), so it exercises
 * the real preload, the real sandbox, the real GPU and the real main-process
 * ffmpeg. It loads a real saved project and calls exportAxcutDocument, the same
 * entry point ExportDialog uses — nothing about the export path is simulated.
 *
 * Why it exists: driving the export through the UI costs ~5 minutes a run and
 * silently injects confounds (an open DevTools panel handicapped one arm of the
 * first A/B; a window that lost focus stole another). A command gives repeats
 * cheaply, and repeats are what tell drift apart from effect.
 *
 * Deliberately NOT React: the bench replaces the app's UI entirely, so nothing
 * renders alongside the export.
 *
 *   npm run bench:export -- --project=os_parity --arms=webcodecs,native --runs=3
 */

import { exportAxcutDocument } from "@/lib/ai-edition/exporter/documentExporter";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import type { ExportQuality } from "@/lib/exporter";
import { nativeBridgeClient } from "@/native/client";

export interface BenchArm {
	/** localStorage flags applied before the run — the levers under test. */
	nativeEncode: boolean;
	readFrequently: boolean;
	/** Extract every frame and discard it. Diagnostic only — writes no file. */
	dropFrames?: boolean;
	/** Composite every frame and stop there. Diagnostic only — writes no file. */
	compositeOnly?: boolean;
	/** Undo the 2026-07-17 compositor fixes, to attribute them. */
	legacyCompositor?: boolean;
	/** Gate G0: sync the GPU after compositing, in a `fence` stage of its own. */
	gpuFence?: boolean;
}

export interface BenchRunResult {
	arm: string;
	run: number;
	ok: boolean;
	error?: string;
	/** The exporter's frame-loop wall — what the arms are compared on. */
	wallMs: number;
	/** Everything outside the loop (project load, renderer init), reported not compared. */
	setupMs?: number;
	frames: number;
	fps: number;
	/** Per-stage totals in ms, keyed as StageTimings names it. */
	stages: Record<string, number>;
}

const params = new URLSearchParams(window.location.search);

/** The dialog's labels, so the bench is asked for what the UI shows. */
const QUALITY: Record<string, ExportQuality> = {
	"720p": "medium",
	"1080p": "good",
	source: "source",
};

const BENCH_PARAMS = {
	project: params.get("project"),
	arms: (params.get("arms") ?? "webcodecs,native").split(",").filter(Boolean),
	runs: Number(params.get("runs") ?? "2"),
	fps: Number(params.get("fps") ?? "60"),
	// "good" is the dialog's own default, i.e. what the UI A/B measured.
	quality: QUALITY[params.get("quality") ?? "1080p"] ?? "good",
	effects: (params.get("effects") ?? "").split(",").filter(Boolean),
	// Cap the timeline to its first N seconds (in memory). Iteration speed:
	// per-frame stage attribution is a steady-state metric, so ~180 frames say
	// what 820 say, at a quarter of the wait. Wall/fps from a capped run are NOT
	// comparable with full-length runs — compare per-frame, or same-cap runs.
	clip: params.get("clip") ? Number(params.get("clip")) : null,
};

/**
 * Appearance the exporter reads out of `legacyEditor`, patched onto an in-memory
 * COPY of the document.
 *
 * Most saved projects carry no appearance at all, so the defaults apply:
 * shadowIntensity 0, showBlur false, borderRadius 0, wallpaper "". Whole effects
 * therefore never execute, and "fixing" them would have measured exactly zero on
 * a project that never ran them. This turns them on without writing to the
 * user's project store — nothing here reaches disk.
 *
 *   --effects=shadow,blur,radius
 */
const EFFECT_PATCHES: Record<string, Record<string, unknown>> = {
	// Three chained drop-shadows over the full frame, every frame.
	shadow: { shadowIntensity: 1 },
	// A static wallpaper, re-blurred every frame.
	blur: { showBlur: true },
	radius: { borderRadius: 24 },
	motionBlur: { motionBlurAmount: 1 },
};

/**
 * A zoom region, injected the same way: the saved projects have `zoomRanges: []`.
 *
 * It is not decoration. Zoom is the one effect that changes the composited
 * GEOMETRY every frame, so it is what invalidates any geometry-keyed cache. A
 * parity test on a project without zoom would happily pass with a broken cache
 * key, because nothing would ever ask it to invalidate.
 */
function zoomRanges(doc: AxcutDocument): unknown[] {
	const clips = (doc as { timeline?: { clips?: { timelineEndSec?: number }[] } }).timeline?.clips;
	const endSec = clips?.[0]?.timelineEndSec ?? 5;
	return [
		{
			id: "bench-zoom",
			startMs: 500,
			endMs: Math.max(1500, Math.round(endSec * 1000) - 500),
			depth: "medium",
			focus: { cx: 0.5, cy: 0.5 },
		},
	];
}

/**
 * Truncate the timeline to its first N seconds, on the in-memory copy only.
 *
 * Clips are 1:1 with source time in the v4 model (speed is applied later, from
 * legacyEditor.speedRegions, by the export segment loop), so capping timeline
 * and source together keeps the document coherent. Regions past the cap simply
 * never fire, like on any short project. Nothing here reaches disk.
 */
function withClipCap(doc: AxcutDocument, seconds: number | null): AxcutDocument {
	if (!seconds || !(seconds > 0)) return doc;
	const timeline = (
		doc as {
			timeline?: {
				clips?: {
					sourceStartSec: number;
					sourceEndSec: number;
					timelineStartSec: number;
					timelineEndSec: number;
				}[];
			};
		}
	).timeline;
	if (!timeline?.clips?.length) return doc;
	const clips = [];
	for (const clip of timeline.clips) {
		if (clip.timelineStartSec >= seconds) continue;
		if (clip.timelineEndSec <= seconds) {
			clips.push(clip);
			continue;
		}
		const keep = seconds - clip.timelineStartSec;
		clips.push({
			...clip,
			timelineEndSec: seconds,
			sourceEndSec: clip.sourceStartSec + keep,
		});
	}
	if (clips.length === 0) {
		throw new Error(`--clip=${seconds} leaves no timeline at all`);
	}
	return { ...doc, timeline: { ...timeline, clips } } as AxcutDocument;
}

function withEffects(doc: AxcutDocument, effects: string[]): AxcutDocument {
	if (effects.length === 0) return doc;
	const legacy: Record<string, unknown> = {
		...((doc as { legacyEditor?: Record<string, unknown> }).legacyEditor ?? {}),
	};
	let patched = doc;
	for (const name of effects) {
		if (name === "zoom") {
			patched = { ...patched, zoomRanges: zoomRanges(doc) } as AxcutDocument;
			continue;
		}
		const patch = EFFECT_PATCHES[name];
		if (!patch) {
			throw new Error(`Unknown effect "${name}". Known: ${Object.keys(EFFECT_PATCHES)}, zoom`);
		}
		Object.assign(legacy, patch);
	}
	// `blur` only does anything against a real wallpaper; a project with none
	// would silently skip the very pass being measured.
	if (effects.includes("blur") && !legacy.wallpaper) {
		legacy.wallpaper = "wallpaper13.jpg";
	}
	return { ...patched, legacyEditor: legacy } as AxcutDocument;
}

const ARMS: Record<string, BenchArm> = {
	// The path we ship today: WebCodecs encodes straight off the GPU texture.
	webcodecs: { nativeEncode: false, readFrequently: false },
	// Frames descend to the CPU and cross to ffmpeg.
	native: { nativeEncode: true, readFrequently: false },
	// Native, but with CPU-backed canvases (what Linux already does) so the
	// per-frame descent is a memcpy rather than a GPU round-trip.
	"native-cpu": { nativeEncode: true, readFrequently: true },
	// Control: isolates the canvas change from the encoder change. Without this
	// arm a native-cpu win could be the canvas, the encoder, or neither.
	"webcodecs-cpu": { nativeEncode: false, readFrequently: true },
	// Ceiling, not a candidate: descend every frame to RAM, then discard it —
	// the crossing costs exactly zero. Bounds EVERY "remove the crossing"
	// proposal at once (option A' sandbox:false, shared memory, zero-copy
	// transfer), because none of them can skip the readback. Writes no file.
	"readback-ceiling": { nativeEncode: true, readFrequently: false, dropFrames: true },
	// Prices the GPU compositing of the real effect set, with nothing downstream
	// to absorb it. This is the number the native-core case rests on: a pipeline
	// that composites on-device cannot beat decode + this + encode. Writes no file.
	"composite-ceiling": { nativeEncode: true, readFrequently: false, compositeOnly: true },
	// The same ceiling with the compositor fixes undone. Pairing these two in one
	// interleaved run is the only honest way to price the fixes: across sessions
	// this machine drifts further than they are worth.
	"composite-ceiling-legacy": {
		nativeEncode: true,
		readFrequently: false,
		compositeOnly: true,
		legacyCompositor: true,
	},
	/** Today's shipping path, with the compositor fixes undone. */
	"webcodecs-legacy": { nativeEncode: false, readFrequently: false, legacyCompositor: true },
	// Gate G0 (rendering-architecture.md §7.1): the shipping path, but the GPU is
	// forced to FINISH compositing before the encode timers start. The claim under
	// test is pure attribution — encodeWait has been billing the compositor's
	// execution. If §7.1 holds, encodeWait collapses to the encoder's own time and
	// the difference reappears under `fence`; the wall itself may even worsen
	// (the fence removes compositor/encoder overlap), which is fine — G0 is about
	// where the time GOES, not how much there is. Run interleaved with its
	// unfenced twin.
	"webcodecs-fence": { nativeEncode: false, readFrequently: false, gpuFence: true },
	// Same gate against the PRE-fix compositor — the arm the spec's numbers
	// (encodeWait ~18.9 → ~6 ms) are actually quoted for.
	"webcodecs-legacy-fence": {
		nativeEncode: false,
		readFrequently: false,
		legacyCompositor: true,
		gpuFence: true,
	},
	// These two WRITE FILES, which is what makes them the parity gate: encode the
	// same timeline with the old and new compositor through the same encoder at
	// the same bitrate, then diff the results (SSIM). Unit tests never look at a
	// pixel, and "obviously equivalent" is what this investigation keeps punishing.
	"native-legacy": { nativeEncode: true, readFrequently: false, legacyCompositor: true },
};

function applyArm(arm: BenchArm): void {
	localStorage.setItem("openscreen.nativeEncode", arm.nativeEncode ? "1" : "0");
	localStorage.setItem("openscreen.readFrequently", arm.readFrequently ? "1" : "0");
	localStorage.setItem("openscreen.dropFrames", arm.dropFrames ? "1" : "0");
	localStorage.setItem("openscreen.compositeOnly", arm.compositeOnly ? "1" : "0");
	localStorage.setItem("openscreen.legacyCompositor", arm.legacyCompositor ? "1" : "0");
	localStorage.setItem("openscreen.gpuFence", arm.gpuFence ? "1" : "0");
}

/**
 * aiEdition.get() reports failure as {success:false, error} rather than
 * throwing, so an unchecked read of .document turns every load error into a
 * silent null — which is exactly how "project not found" masked the real reason
 * once already. Surface it.
 */
async function loadDocument(id: string): Promise<AxcutDocument> {
	const result = (await nativeBridgeClient.aiEdition.get(id)) as {
		success?: boolean;
		document?: AxcutDocument;
		error?: string;
	};
	if (!result?.success || !result.document) {
		throw new Error(`Cannot load project ${id}: ${result?.error ?? "no document returned"}`);
	}
	return result.document;
}

/**
 * Accepts a project id, an id prefix, or a title.
 *
 * Titles need care: a summary's title is the name the project was CREATED with
 * ("Recording 15/07/2026 18:38:53") and does not follow a rename, so the one
 * shown in the editor — the document's own project.title — may match nothing in
 * the summary list. Hence the fallback that opens documents to check. It is the
 * slow path on purpose: only reached when the cheap matches miss.
 */
async function resolveDocument(projectRef: string | null): Promise<AxcutDocument> {
	const projects = await nativeBridgeClient.aiEdition.listProjects();
	if (projects.length === 0) throw new Error("No saved projects to bench against");
	if (!projectRef) return loadDocument(projects[0].id);

	const summary =
		projects.find((p) => p.id === projectRef) ??
		projects.find((p) => p.id.startsWith(projectRef)) ??
		projects.find((p) => p.title === projectRef);
	if (summary) return loadDocument(summary.id);

	const failures: string[] = [];
	for (const p of projects) {
		try {
			const doc = await loadDocument(p.id);
			if (doc.project?.title === projectRef) return doc;
		} catch (error) {
			failures.push(error instanceof Error ? error.message : String(error));
		}
	}
	throw new Error(
		`Project "${projectRef}" not found by id, id prefix, or title ` +
			`(${projects.length} searched, ${failures.length} failed to load).` +
			(failures.length ? `\nFirst load failure: ${failures[0]}` : ""),
	);
}

/**
 * Largest source on the timeline — mirrors ExportDialog's referenceSource so
 * "Source" quality picks the same output size the UI would.
 */
function referenceSource(doc: AxcutDocument): { width?: number; height?: number } {
	let best: { width?: number; height?: number } = {};
	let bestArea = 0;
	for (const asset of doc.assets ?? []) {
		const w = asset.video?.width;
		const h = asset.video?.height;
		if (!w || !h) continue;
		if (w * h > bestArea) {
			bestArea = w * h;
			best = { width: w, height: h };
		}
	}
	return best;
}

interface Captured {
	stages: Record<string, number>;
	/** The exporter's own loop numbers, which exclude the bench's setup. */
	loop: { wallMs: number; frames: number; fps: number } | null;
	restore: () => void;
}

/** The perf line the exporter prints is for humans; the bench needs the numbers. */
function captureStages(): Captured {
	const captured: Captured = {
		stages: {},
		loop: null,
		restore: () => {
			console.warn = original;
		},
	};
	const original = console.warn;
	console.warn = (...args: unknown[]) => {
		const text = args.map(String).join(" ");
		if (text.includes("[export perf]")) {
			// "[export perf] wall 77557ms · 546 frames · 7.0 fps"
			const head = /wall\s+([\d.]+)ms\D+(\d+)\s+frames\D+([\d.]+)\s+fps/.exec(text);
			if (head) {
				captured.loop = {
					wallMs: Number(head[1]),
					frames: Number(head[2]),
					fps: Number(head[3]),
				};
			}
			for (const line of text.split("\n")) {
				// "  render     1680.0    3.0%     3.08  n=546"
				const m = /^\s*([a-zA-Z]+)\s+([\d.]+)\s+[\d.]+%/.exec(line);
				if (m && m[1] !== "TOTAL") captured.stages[m[1]] = Number(m[2]);
			}
		}
		original(...args);
	};
	return captured;
}

async function runOnce(
	doc: AxcutDocument,
	armName: string,
	arm: BenchArm,
	run: number,
): Promise<BenchRunResult> {
	applyArm(arm);
	const src = referenceSource(doc);
	const capture = captureStages();
	const started = performance.now();
	try {
		const result = await exportAxcutDocument(doc, {
			format: "mp4",
			quality: BENCH_PARAMS.quality,
			frameRate: BENCH_PARAMS.fps,
			codec: "h264",
			sourceWidth: src.width,
			sourceHeight: src.height,
		});
		const wallMs = performance.now() - started;
		// The native arm returns no blob (ffmpeg wrote the file itself), so a
		// missing blob is not a failure here the way it is in ExportDialog.
		if (!result.success) throw new Error(result.error ?? "export failed");
		if (!capture.loop) throw new Error("exporter printed no [export perf] line");
		return {
			arm: armName,
			run,
			ok: true,
			// The exporter's own loop wall, not the bench's: comparing arms means
			// comparing the frame loop, not project loading.
			wallMs: capture.loop.wallMs,
			setupMs: wallMs - capture.loop.wallMs,
			frames: capture.loop.frames,
			fps: capture.loop.fps,
			stages: capture.stages,
		};
	} catch (error) {
		return {
			arm: armName,
			run,
			ok: false,
			error: error instanceof Error ? error.message : String(error),
			wallMs: performance.now() - started,
			frames: 0,
			fps: 0,
			stages: capture.stages,
		};
	} finally {
		capture.restore();
	}
}

/**
 * Interleaves arms rather than running each arm's repeats together: A,B,A,B.
 * Same-arm repeats then bracket the other arm in time, so drift shows up as
 * disagreement between a run and its own repeat instead of masquerading as the
 * effect under test. The first A/B on this machine drifted 26% between two
 * identical runs — enough to invert the conclusion.
 */
export async function runBench(): Promise<void> {
	const results: BenchRunResult[] = [];
	const emit = (event: string, payload: unknown) =>
		// Picked up by the runner off stdout; console.warn is what the app's
		// console forwarder actually relays to the main process.
		console.warn(`[bench] ${JSON.stringify({ event, ...(payload as object) })}`);

	try {
		for (const armName of BENCH_PARAMS.arms) {
			if (!ARMS[armName]) throw new Error(`Unknown arm "${armName}"`);
		}
		// Loaded once and shared by every run: each arm must see byte-identical
		// input, and the title fallback can open every project on disk.
		// Cap BEFORE effects, so the injected zoom fits inside the capped window.
		const doc = withEffects(
			withClipCap(await resolveDocument(BENCH_PARAMS.project), BENCH_PARAMS.clip),
			BENCH_PARAMS.effects,
		);
		emit("start", {
			arms: BENCH_PARAMS.arms,
			runs: BENCH_PARAMS.runs,
			project: doc.project?.title ?? "(untitled)",
			effects: BENCH_PARAMS.effects.length ? BENCH_PARAMS.effects.join("+") : "(project default)",
			clip: BENCH_PARAMS.clip,
		});
		for (let run = 1; run <= BENCH_PARAMS.runs; run++) {
			for (const armName of BENCH_PARAMS.arms) {
				const result = await runOnce(doc, armName, ARMS[armName], run);
				results.push(result);
				emit("run", result);
			}
		}
		emit("done", { results });
	} catch (error) {
		emit("fatal", { error: error instanceof Error ? error.message : String(error) });
	}
	await window.electronAPI?.benchFinished?.();
}
