// ponytail: one home for the documents the workbench measures against,
// replacing four near-identical hand-written copies (agent-tools.test.ts:9,
// chat-service.toolloop.test.ts:24, chat-service.test.ts:116, and the original
// harness.ts:31).
//
// Every fixture goes out through `documentSchema.parse`, so a field that drifts
// out of the schema fails HERE rather than three layers downstream. That is
// exactly the failure tsconfig.test.json:1-12 was written about, and
// `workbench/` is outside the CI typecheck ratchet — the parse is the net.
//
// `primaryAssetId` is always set and `durationSec` is always non-zero: a zero
// duration silently makes `replaceTimeline` wipe the timeline (DSL-3), which
// must be a scenario's deliberate choice, never a fixture accident.

import {
	type AxcutDocument,
	type AxcutTranscript,
	createEmptyDocument,
	documentSchema,
} from "../../src/lib/ai-edition/schema";
import type { CursorTrackSample } from "../../src/lib/ai-edition/timeline/cursor-track";
import type { InterestPoint } from "./editorial";
import { synthesizeWords, transcriptFromWords, type WordTiming } from "./transcript";

const ASSET_ID = "asset_1";
const CREATED_AT = "2026-01-01T00:00:00.000Z";

/**
 * ponytail: what a fixture KNOWS about its own material, beyond what the
 * document can express.
 *
 * A document says where the zooms are; it cannot say where they OUGHT to be.
 * Interest points are that missing half — the moments a good edit draws
 * attention to — and without them "was this zoom well placed?" has no
 * deterministic answer, so `zoomIssues` stays silent rather than inventing a
 * preference. Declared here, next to the material, never inside a check.
 *
 * Keyed by `project.id` rather than by object identity: `scenario
 * .document()` mints a fresh document per repetition, and the truth has to
 * survive that (and a JSON round trip through a persisted run).
 */
export interface FixtureTruth {
	interestPoints: InterestPoint[];
	/** Where these came from — telemetry, a human pass, an assumption. */
	provenance: string;
}

const TRUTH_BY_PROJECT = new Map<string, FixtureTruth>();

function registerTruth(projectId: string, truth: FixtureTruth): void {
	TRUTH_BY_PROJECT.set(projectId, truth);
}

/** The declared ground truth for a document, or `null` when its fixture
 * declares none — which is the normal case and never an error. */
export function fixtureTruth(document: AxcutDocument): FixtureTruth | null {
	return TRUTH_BY_PROJECT.get(document.project.id) ?? null;
}

interface AssetOptions {
	durationSec: number;
	cameraTrack?: { sourcePath: string; offsetMs?: number } | null;
}

function baseDocument(projectId: string, title: string): AxcutDocument {
	return createEmptyDocument({ title, projectId, createdAt: CREATED_AT });
}

function asset(options: AssetOptions) {
	return {
		id: ASSET_ID,
		kind: "video" as const,
		label: "Recording",
		originalPath: "/tmp/wb/recording.mp4",
		durationSec: options.durationSec,
		cameraTrack: options.cameraTrack
			? {
					sourcePath: options.cameraTrack.sourcePath,
					startMs: 0,
					offsetMs: options.cameraTrack.offsetMs ?? 0,
					visible: true,
				}
			: null,
	};
}

function clip(id: string, sourceStart: number, sourceEnd: number, label: string) {
	return {
		id,
		assetId: ASSET_ID,
		sourceStartSec: sourceStart,
		sourceEndSec: sourceEnd,
		timelineStartSec: sourceStart,
		timelineEndSec: sourceEnd,
		wordRefs: [],
		origin: "agent" as const,
		reason: label,
	};
}

/** One asset, one clip covering it whole. The blank slate. */
export function singleClip(options?: { durationSec?: number; projectId?: string }): AxcutDocument {
	const durationSec = options?.durationSec ?? 24.703979;
	const base = baseDocument(options?.projectId ?? "wb_single", "WB single clip");
	return documentSchema.parse({
		...base,
		project: { ...base.project, primaryAssetId: ASSET_ID },
		assets: [asset({ durationSec })],
		timeline: { ...base.timeline, clips: [clip("clip_1", 0, durationSec, "")] },
	});
}

/**
 * A recording with a transcript whose `kind: "silence"` segments sit exactly on
 * the requested spans. Without this, half of the wizard prompt ("cut the dead
 * time") is unanswerable: `getTranscript` is the model's ONLY source of
 * silence positions, and the transcript is in SOURCE time.
 *
 * `withWords` fills in per-word timings under the same segments. It is OPT-IN,
 * and stays off for the scenarios that were measured on 2026-07-31: adding
 * words changes what `getTranscript` hands the model, which changes the run
 * fingerprint and makes every baseline rate incomparable. New scenarios should
 * turn it on; existing ones should be re-baselined deliberately if they do.
 */
export function recordingWithSilences(options: {
	durationSec?: number;
	silences: Array<[number, number]>;
	projectId?: string;
	withWords?: boolean;
}): AxcutDocument {
	const durationSec = options.durationSec ?? 62;
	const base = baseDocument(options.projectId ?? "wb_silences", "WB recording");
	const segments: Array<{
		id: string;
		kind: "speech" | "silence";
		startSec: number;
		endSec: number;
		text: string;
		wordIds: string[];
	}> = [];
	const words: Array<{
		id: string;
		segmentId: string;
		startSec: number;
		endSec: number;
		text: string;
	}> = [];
	const pushSpeech = (id: string, startSec: number, endSec: number, text: string) => {
		const wordIds: string[] = [];
		if (options.withWords) {
			for (const word of synthesizeWords({ speech: [[startSec, endSec]] })) {
				const wordId = `word_${words.length + 1}`;
				words.push({ id: wordId, segmentId: id, ...word });
				wordIds.push(wordId);
			}
		}
		segments.push({ id, kind: "speech", startSec, endSec, text, wordIds });
	};
	let cursor = 0;
	let n = 0;
	for (const [start, end] of [...options.silences].sort((a, b) => a[0] - b[0])) {
		if (start > cursor) {
			n += 1;
			pushSpeech(`seg_${n}`, cursor, start, `spoken passage ${n}`);
		}
		n += 1;
		segments.push({
			id: `seg_${n}`,
			kind: "silence",
			startSec: start,
			endSec: end,
			text: "",
			wordIds: [],
		});
		cursor = end;
	}
	if (cursor < durationSec) {
		n += 1;
		pushSpeech(`seg_${n}`, cursor, durationSec, `spoken passage ${n}`);
	}
	return documentSchema.parse({
		...base,
		project: { ...base.project, primaryAssetId: ASSET_ID },
		assets: [asset({ durationSec })],
		transcripts: [{ assetId: ASSET_ID, language: "en", segments, words }],
		timeline: { ...base.timeline, clips: [clip("clip_1", 0, durationSec, "")] },
	});
}

/**
 * Two labelled clips plus a trim. Serves clip-targeting scenarios AND the
 * time-base traps: after the trim the ruler still reads 0-60 (RAW virtual)
 * while the edit plays for 55 s (compressed), and the written contract in
 * `agent-tools.ts:536-537` describes the latter while the code means the former.
 */
export function twoClipsWithTrim(options?: { projectId?: string }): AxcutDocument {
	const base = baseDocument(options?.projectId ?? "wb_two_clips", "WB two clips");
	return documentSchema.parse({
		...base,
		project: { ...base.project, primaryAssetId: ASSET_ID },
		assets: [asset({ durationSec: 60 })],
		timeline: {
			...base.timeline,
			clips: [clip("clip_1", 0, 30, "intro"), clip("clip_2", 30, 60, "demo")],
			trimRanges: [
				{
					id: "trim_1",
					assetId: ASSET_ID,
					startSec: 12,
					endSec: 17,
					reason: "silence",
					origin: "agent",
				},
			],
		},
	});
}

/**
 * A zoom carrying BOTH `depth` and `customScale` — the state a v1.7 project
 * lands in after `document/migrate.ts:185`. `customScale` wins at render
 * (`effectiveZoomScale`). It used to be invisible in the model's snapshot with
 * no tool able to write or clear it, so `setZoom {depth:6}` left the picture at
 * 1.10× while the agent announced 5×. The snapshot now carries `customScale`
 * and `depthIsOverridden`, and a depth write clears the override — this fixture
 * is what keeps both honest.
 */
export function migratedV17WithCustomScale(options?: { projectId?: string }): AxcutDocument {
	const doc = singleClip({ durationSec: 40, projectId: options?.projectId ?? "wb_migrated" });
	return documentSchema.parse({
		...doc,
		zoomRanges: [
			{
				id: "zoom_1",
				startMs: 5_000,
				endMs: 12_000,
				clipId: "clip_1",
				sourceStartSec: 5,
				sourceEndSec: 12,
				depth: 3,
				focus: { cx: 0.5, cy: 0.5 },
				focusMode: "manual",
				customScale: 1.1,
				source: "manual",
			},
		],
	});
}

/**
 * One asset, one clip, one zoom already placed — the fixture for "describe what
 * is on the timeline".
 *
 * `depth` is an ORDINAL (1–6), not a factor. The snapshot used to hand the model
 * the bare number while both tool descriptions claimed it "maps to 1.0×–3.5×",
 * against a `ZOOM_DEPTH_SCALES` of `{1:1.25, 2:1.5, 3:1.8, 4:2.2, 5:3.5, 6:5.0}`.
 * The default depth 3 is the sharpest form of D2: read as a factor it says 3×,
 * and the pill renders 1.80×. The snapshot now ships `renderedScale` beside the
 * depth, so what is measured here is whether the model quotes it.
 */
export function zoomedRecording(options?: {
	depth?: 1 | 2 | 3 | 4 | 5 | 6;
	projectId?: string;
}): AxcutDocument {
	const document = singleClip({ durationSec: 40, projectId: options?.projectId ?? "wb_zoomed" });
	return documentSchema.parse({
		...document,
		zoomRanges: [
			{
				id: "zoom_1",
				startMs: 8_000,
				endMs: 14_000,
				clipId: "clip_1",
				sourceStartSec: 8,
				sourceEndSec: 14,
				depth: options?.depth ?? 3,
				focus: { cx: 0.5, cy: 0.5 },
				focusMode: "manual",
				source: "manual",
			},
		],
	});
}

/**
 * Four modifiers of three kinds, all well separated in time, so "remove the
 * second zoom" is a targeting problem rather than a one-of-one guess.
 *
 * The speed and camera regions live in `legacyEditor`, which is a
 * `z.object({}).passthrough()` (`schema/index.ts:432`): the schema validates
 * NOTHING inside it. They are here precisely so a deletion that damages them
 * has something to be caught by — `oracles.documentInvariants` hand-validates
 * both collections because the parse cannot.
 */
export function multipleModifiers(options?: { projectId?: string }): AxcutDocument {
	const document = singleClip({ durationSec: 60, projectId: options?.projectId ?? "wb_modifiers" });
	const anchor = (startSec: number, endSec: number) => ({
		clipId: "clip_1",
		sourceStartSec: startSec,
		sourceEndSec: endSec,
	});
	return documentSchema.parse({
		...document,
		zoomRanges: [
			{
				id: "zoom_1",
				startMs: 5_000,
				endMs: 9_000,
				...anchor(5, 9),
				depth: 3,
				focus: { cx: 0.5, cy: 0.5 },
				focusMode: "manual",
				source: "manual",
			},
			{
				id: "zoom_2",
				startMs: 20_000,
				endMs: 25_000,
				...anchor(20, 25),
				depth: 5,
				focus: { cx: 0.5, cy: 0.5 },
				focusMode: "manual",
				source: "manual",
			},
		],
		annotations: [
			{
				id: "ann_1",
				startMs: 45_000,
				endMs: 50_000,
				...anchor(45, 50),
				type: "text",
				content: "Recap",
				textContent: "Recap",
				position: { x: 50, y: 80 },
				size: { width: 30, height: 20 },
				style: {
					color: "#ffffff",
					backgroundColor: "transparent",
					fontSize: 32,
					fontFamily: "Inter",
					fontWeight: "bold",
					fontStyle: "normal",
					textDecoration: "none",
					textAlign: "center",
				},
				zIndex: 1,
			},
		],
		legacyEditor: {
			speedRegions: [
				{ id: "speed_1", startMs: 32_000, endMs: 38_000, ...anchor(32, 38), speed: 2 },
			],
			cameraFullscreenRegions: [],
		},
	});
}

/** More than 800 transcript segments. `getTranscript` used to slice at 800 and
 * say nothing about it; it no longer caps, and this fixture is what keeps that
 * honest. */
export function longTranscript(options?: { segments?: number; projectId?: string }): AxcutDocument {
	const count = options?.segments ?? 900;
	const durationSec = count * 2;
	const base = baseDocument(options?.projectId ?? "wb_long", "WB long transcript");
	const segments = Array.from({ length: count }, (_v, i) => ({
		id: `seg_${i + 1}`,
		kind: i % 3 === 0 ? ("silence" as const) : ("speech" as const),
		startSec: i * 2,
		endSec: i * 2 + 2,
		text: i % 3 === 0 ? "" : `line ${i + 1}`,
		wordIds: [],
	}));
	return documentSchema.parse({
		...base,
		project: { ...base.project, primaryAssetId: ASSET_ID },
		assets: [asset({ durationSec })],
		transcripts: [{ assetId: ASSET_ID, language: "en", segments, words: [] }],
		timeline: { ...base.timeline, clips: [clip("clip_1", 0, durationSec, "")] },
	});
}

/**
 * Speech, with ragged edges. The reception point for a REAL transcript.
 *
 * Every other fixture here places its silences on numbers a human typed:
 * `[10, 12.5]`, `[31, 36.2]`. A model that cuts exactly `10 → 12.5` scores a
 * perfect coverage against them, and we learn nothing — the boundaries it hit
 * are the boundaries the fixture declared. Real speech does not stop at 12.5;
 * it stops at 12.463 with a breath before it, and where a cut lands relative to
 * THAT is the whole editorial question.
 *
 * Until a real Whisper pass is injected, the spans below are synthetic but
 * deliberately off-grid, and they run through exactly the same code path a real
 * transcript will (`transcriptFromWords`, silences derived from gaps rather
 * than declared). Injecting the real thing is a one-liner and changes nothing
 * else:
 *
 * ```ts
 * recordingWithWordTimings({
 *   transcript: loadWhisperTranscript("…/take-3.json", {
 *     assetId: "asset_1",
 *     durationSec: 48,
 *   }),
 * });
 * ```
 *
 * The 0.31 s aside at 20.63 s, framed by a 0.45 s and a 0.48 s gap, is there on
 * purpose. Both gaps are long enough to be listed as silences and short enough
 * to be breaths; a model that cuts every gap it is shown strands the aside
 * between two cuts as a third of a second of isolated speech — which is
 * precisely what `orphanFragments` exists to catch, and which no conformity
 * check can see (the document stays valid and the trims stay honest).
 */
export const DEMO_SPEECH_SPANS: Array<[number, number]> = [
	[0.31, 9.72],
	[12.46, 20.18],
	// the aside
	[20.63, 20.94],
	[21.42, 31.07],
	[36.29, 47.6],
];

/** Moments this take is about. A real pass would derive them from the cursor
 * telemetry digest (`timeline/zoom-suggestions.ts` already computes dwell
 * moments); these are hand-declared and say so. */
export const DEMO_INTEREST_POINTS: InterestPoint[] = [
	{ atSec: 14.2, label: "ouverture du panneau d'export", toleranceSec: 1.5 },
	{ atSec: 38.9, label: "clic sur Rendre", toleranceSec: 1.5 },
];

export function recordingWithWordTimings(options?: {
	projectId?: string;
	durationSec?: number;
	/** A real transcript, already loaded. Wins over `words`. */
	transcript?: AxcutTranscript;
	/** Raw timings, e.g. `wordsFromWhisper(json).words`. */
	words?: WordTiming[];
	interestPoints?: InterestPoint[];
}): AxcutDocument {
	const durationSec = options?.durationSec ?? 48;
	const projectId = options?.projectId ?? "wb_words";
	const base = baseDocument(projectId, "WB word timings");
	const transcript =
		options?.transcript ??
		transcriptFromWords({
			assetId: ASSET_ID,
			words: options?.words ?? synthesizeWords({ speech: DEMO_SPEECH_SPANS }),
			durationSec,
			language: "en",
		});
	registerTruth(projectId, {
		interestPoints: options?.interestPoints ?? DEMO_INTEREST_POINTS,
		provenance: options?.transcript
			? "transcription réelle injectée ; points d'intérêt déclarés à la main"
			: "mots synthétiques (synthesizeWords) ; points d'intérêt déclarés à la main",
	});
	return documentSchema.parse({
		...base,
		project: { ...base.project, primaryAssetId: ASSET_ID },
		assets: [asset({ durationSec })],
		transcripts: [{ ...transcript, assetId: ASSET_ID }],
		timeline: { ...base.timeline, clips: [clip("clip_1", 0, durationSec, "")] },
	});
}

/** Asset WITH a linked camera — the positive control for the webcam scenarios,
 * where the negative control is `singleClip()`. Neither state was visible in the
 * model's snapshot, which was the point; `assets[].hasCameraTrack` and
 * `hasAnyCamera` now carry it, and this pair is the regression test for them. */
export function withCameraTrack(options?: { projectId?: string }): AxcutDocument {
	const base = baseDocument(options?.projectId ?? "wb_camera", "WB camera");
	return documentSchema.parse({
		...base,
		project: { ...base.project, primaryAssetId: ASSET_ID },
		assets: [
			asset({ durationSec: 45, cameraTrack: { sourcePath: "/tmp/wb/webcam.mp4", offsetMs: 120 } }),
		],
		timeline: { ...base.timeline, clips: [clip("clip_1", 0, 45, "")] },
	});
}

/**
 * Synthetic pointer telemetry: 30 Hz movement with the cursor parked at declared
 * moments, plus a click at the centre of each park.
 *
 * ponytail: written as MOVEMENT and let through the real dwell detector, not
 * handed to the digest as pre-made moments. A fixture that fabricates the answer
 * measures nothing — the whole question is whether
 * `detectZoomDwellCandidates` finds the holds, including the long ones the magic
 * wand's ceiling throws away, and it can only be asked with samples.
 */
export function cursorTelemetry(options: {
	/** `{ atSec, holdSec, cx, cy }` — where the pointer stopped and for how long. */
	dwells: Array<{ atSec: number; holdSec: number; cx: number; cy: number }>;
	durationSec: number;
	assetId?: string;
}): Record<string, CursorTrackSample[]> {
	const stepMs = 33;
	const samples: CursorTrackSample[] = [];
	const dwells = [...options.dwells].sort((a, b) => a.atSec - b.atSec);
	let cursor = { cx: 0.1, cy: 0.1 };
	let timeMs = 0;
	const endMs = options.durationSec * 1000;

	const travelTo = (targetMs: number) => {
		// A visible move between parks: >DWELL_MOVE_THRESHOLD per step, so the
		// detector closes the previous run instead of merging the two.
		while (timeMs < targetMs) {
			cursor = {
				cx: Math.min(1, cursor.cx + 0.05) % 1,
				cy: Math.min(1, cursor.cy + 0.05) % 1,
			};
			samples.push({ timeMs, cx: cursor.cx, cy: cursor.cy, interactionType: "move" });
			timeMs += stepMs;
		}
	};

	for (const dwell of dwells) {
		const startMs = Math.max(0, dwell.atSec * 1000 - (dwell.holdSec * 1000) / 2);
		travelTo(startMs);
		const stopMs = startMs + dwell.holdSec * 1000;
		const clickAtMs = startMs + (dwell.holdSec * 1000) / 2;
		let clicked = false;
		while (timeMs <= stopMs) {
			const isClick = !clicked && timeMs >= clickAtMs;
			if (isClick) clicked = true;
			samples.push({
				timeMs,
				cx: dwell.cx,
				cy: dwell.cy,
				interactionType: isClick ? "click" : "move",
			});
			timeMs += stepMs;
		}
		cursor = { cx: dwell.cx, cy: dwell.cy };
	}
	travelTo(endMs);

	return { [options.assetId ?? ASSET_ID]: samples };
}
