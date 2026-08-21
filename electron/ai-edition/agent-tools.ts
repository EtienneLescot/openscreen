// Agent tool layer (P1.1/P1.2): the zod argument schemas — the single source of
// truth, shared with the LangChain `tool()`s built in `deep-agent/service.ts` —
// plus the executor that validates arguments and applies each tool against an
// AxcutDocument snapshot. Pure — no IPC, no fs. The chat-service tool loop owns
// checkpoints and persistence; this module only knows how to turn
// (document, toolName, argsJson) into a new document.
//
// Read tools return JSON the model can reason over; write tools return the
// mutated document plus a human-readable summary line for the chat panel
// ("applied: added trim 0:02.1 – 0:02.4").
//
// The PROSE the model reads lives in `TOOL_DESCRIPTIONS` (deep-agent/service.ts)
// — not here. This header used to claim the file held "the JSON-schema tool
// definitions fed to the LLM as tools[]", which stopped being true when the
// deep-agent landed and stayed on the page for a whole release; the specs it
// described are gone (see `MUTATING_TOOL_NAMES`).

import { z } from "zod";
import { createId } from "../../src/lib/ai-edition/document/ids";
import {
	moveClip,
	planTimelineReplacement,
	type RegionKind,
	removeClip,
	removeRegion,
	replaceTimeline,
	setClipSourceRange,
} from "../../src/lib/ai-edition/document/timeline";
import type { AxcutDocument } from "../../src/lib/ai-edition/schema";
import { hasAnyClipWithCamera } from "../../src/lib/ai-edition/timeline/camera";
import {
	buildCursorTrack,
	type CursorTrackSample,
} from "../../src/lib/ai-edition/timeline/cursor-track";
import {
	anchorRegionsWithDerivedMs,
	coalesceRegionsForRuler,
	replacePillSpan,
	resolvePillIds,
} from "../../src/lib/ai-edition/timeline/timelineMap";
import { trimAppliesToClip } from "../../src/lib/ai-edition/timeline/trim-mapping";
// ponytail: relative, and it has to stay that way — `electron/` never resolves
// the `@/` alias (the main-process build does not declare it), which is why the
// scale table was moved out of `components/video-editor/types.ts` to be
// reachable from here at all.
import {
	effectiveZoomScale,
	ZOOM_DEPTH_LEGEND,
} from "../../src/lib/ai-edition/timeline/zoom-scale";

export interface AgentToolExecution {
	ok: boolean;
	/** JSON payload returned to the model as the tool result. */
	resultJson: string;
	/** Updated document — only set when the tool mutated it. */
	document?: AxcutDocument;
	/** One-line human summary for the chat panel (mutating tools only). */
	summary?: string;
}

function formatSec(sec: number): string {
	if (!Number.isFinite(sec) || sec < 0) return "0:00.0";
	const m = Math.floor(sec / 60);
	const s = (sec % 60).toFixed(1);
	return `${m}:${s.padStart(4, "0")}`;
}

function toMs(sec: number): number {
	return Math.max(0, Math.round(sec * 1000));
}

// For the effect set* tools: keep the stored span unless the caller passes new
// edges, and normalise so start ≤ end. Input seconds are virtual-timeline time.
function resolveSpanMs(
	existing: { startMs: number; endMs: number },
	startSec: number | undefined,
	endSec: number | undefined,
): { startMs: number; endMs: number } {
	if (startSec === undefined && endSec === undefined) {
		return { startMs: existing.startMs, endMs: existing.endMs };
	}
	const s = startSec ?? existing.startMs / 1000;
	const e = endSec ?? existing.endMs / 1000;
	return { startMs: toMs(Math.min(s, e)), endMs: toMs(Math.max(s, e)) };
}

// v5: a modifier is stored as clip-anchored fragment(s), and adjacent regions with the
// same properties read as ONE pill (timelineMap merge rule). The agent reasons in VIRTUAL
// seconds over whole regions, so we present exactly the pills the user sees, keyed by the
// first region under each — which every set*/remove* tool accepts as the id.
function coalesceForAgent<T extends { id: string; startMs: number; endMs: number }>(
	regions: T[],
): T[] {
	return coalesceRegionsForRuler(regions).map((pill) => ({
		...pill.member,
		id: pill.ids[0],
		startMs: Math.round(pill.start * 1000),
		endMs: Math.round(pill.end * 1000),
	}));
}

/** Every agent write anchors the region to the clip(s) it covers, exactly like the UI. */
function anchorForAgent<T extends { id: string; startMs: number; endMs: number }>(
	region: T,
	document: AxcutDocument,
	prefix: string,
) {
	return anchorRegionsWithDerivedMs([region], document.timeline.clips, () => createId(prefix));
}

// ─── What the write actually LANDED ────────────────────────────────────────
//
// ponytail: every add*/set* used to echo back the span it was ASKED for. Three
// ways that is a lie, all reproduced against the real fixtures:
//   • CLAMP — `addZoom {20,40}` on a 24.70 s clip stores 20–24.704 and reported
//     20–40. Ventilation trims the span to the clip, silently.
//   • FRAGMENTATION — `addZoom {25,35}` across two clips stores TWO fragments,
//     the second with a brand-new id (`anchorRawRegionsToClips:74`), and the
//     result named one id and one span.
//   • NOTHING PLACED — `addZoom {90,95}` on a 24.70 s timeline covers no clip.
//     `anchorRegionsWithDerivedMs` passes it through UNANCHORED by design
//     (timelineMap.ts:360-375, so a v2 project with a zero-extent clip does not
//     lose data), and it was stored, reported ok, and can never play.
// The document is the referee; the report is read back off it.

interface Landing {
	/** Every id the write produced — more than one when it straddled a clip. */
	ids: string[];
	startSec: number;
	endSec: number;
	/** False when nothing covered a clip: the region cannot ever play. */
	anchored: boolean;
	fragments: number;
}

function overlapsAClip(
	region: { startMs: number; endMs: number },
	document: AxcutDocument,
): boolean {
	const startSec = region.startMs / 1000;
	const endSec = region.endMs / 1000;
	return document.timeline.clips.some(
		(c) => Math.min(endSec, c.timelineEndSec) - Math.max(startSec, c.timelineStartSec) > 0,
	);
}

/**
 * `anchored` is BOTH structural and positional on purpose. `replacePillSpan`
 * re-anchors from `pill.member`, whose payload still carries the OLD `clipId`
 * even when the new span covers nothing — so a `clipId` alone proves nothing
 * about where the region ended up. The ruler overlap is what decides whether a
 * viewer will ever see it.
 */
function landingOf(
	regions: Array<{ id: string; startMs: number; endMs: number; clipId?: string }>,
	document: AxcutDocument,
): Landing {
	const starts = regions.map((r) => r.startMs);
	const ends = regions.map((r) => r.endMs);
	return {
		ids: regions.map((r) => r.id),
		startSec: regions.length ? Math.min(...starts) / 1000 : 0,
		endSec: regions.length ? Math.max(...ends) / 1000 : 0,
		anchored:
			regions.length > 0 &&
			regions.every((r) => typeof r.clipId === "string" && overlapsAClip(r, document)),
		fragments: regions.length,
	};
}

/** The regions a pill edit produced: everything in `after` that is not an
 * untouched original. `replacePillSpan` re-ventilates the pill, so the count and
 * the ids can both change under a caller that only passed one id. */
function landingAfterPillEdit<T extends { id: string; startMs: number; endMs: number }>(
	before: T[],
	after: T[],
	pillIds: Set<string>,
	document: AxcutDocument,
): Landing {
	const untouched = new Set(before.filter((r) => !pillIds.has(r.id)).map((r) => r.id));
	return landingOf(
		after.filter((r) => !untouched.has(r.id)) as Array<T & { clipId?: string }>,
		document,
	);
}

/**
 * Refuse a full-camera region on footage that carries no webcam.
 *
 * ponytail: `addCameraFullscreen` took a span and nothing else, and answered
 * `ok: true` whether or not any camera existed anywhere in the project — it
 * writes into `legacyEditor.cameraFullscreenRegions`, which the schema does not
 * validate. A pair of scenarios identical but for a linked webcam produced
 * identical turns, because the evidence really was identical. The snapshot now
 * carries `hasCameraTrack`, and this is the other half: a region that can only
 * render nothing is not written, and the refusal names the reason.
 */
function cameraUnderSpan(
	document: AxcutDocument,
	startSec: number,
	endSec: number,
): { clips: number; withCamera: number } {
	const covered = document.timeline.clips.filter(
		(c) => Math.min(endSec, c.timelineEndSec) - Math.max(startSec, c.timelineStartSec) > 0,
	);
	return {
		clips: covered.length,
		withCamera: covered.filter(
			(c) => document.assets.find((a) => a.id === c.assetId)?.cameraTrack != null,
		).length,
	};
}

function noCameraUnderSpan(
	document: AxcutDocument,
	startSec: number,
	endSec: number,
): AgentToolExecution | null {
	const coverage = cameraUnderSpan(document, startSec, endSec);
	if (coverage.clips === 0 || coverage.withCamera > 0) return null;
	const anywhere = hasAnyClipWithCamera(document.assets, document.timeline.clips);
	return failure(
		`No webcam is linked to the footage under ${startSec.toFixed(1)}–${endSec.toFixed(1)} s, ` +
			"so a full-camera region there would render nothing and none was written. " +
			(anywhere
				? "Other clips in this project do carry a camera — check assets[].hasCameraTrack in getCurrentDocument and pick a span over one of those."
				: "No asset in this project carries a cameraTrack at all (assets[].hasCameraTrack is false everywhere): this recording has no webcam. Tell the user instead of placing a region."),
	);
}

/** The span the edited timeline actually occupies, for an actionable refusal. */
function editedExtentSec(document: AxcutDocument): { startSec: number; endSec: number } {
	const clips = document.timeline.clips;
	if (clips.length === 0) return { startSec: 0, endSec: 0 };
	return {
		startSec: Math.min(...clips.map((c) => c.timelineStartSec)),
		endSec: Math.max(...clips.map((c) => c.timelineEndSec)),
	};
}

/**
 * Refuse rather than store a region that covers no clip. The message carries the
 * real bounds so the model can retry once with a usable span instead of looping
 * — there is no AbortSignal and no timeout on the product path.
 */
function coversNoClip(
	kind: string,
	requestedStartSec: number,
	requestedEndSec: number,
	document: AxcutDocument,
): AgentToolExecution {
	const extent = editedExtentSec(document);
	return failure(
		`The span ${requestedStartSec.toFixed(1)}–${requestedEndSec.toFixed(1)} s covers no clip, ` +
			`so no ${kind} was placed (it could never play). The edited timeline runs ` +
			`${extent.startSec.toFixed(1)}–${extent.endSec.toFixed(1)} s. ` +
			`Pick a span inside it, or place a clip there first.`,
	);
}

// The landing fields shared by every add / set result, so the model reads the
// same three things everywhere: what it asked for, what it got, and whether the
// two differ. `clamped` and `fragments` are omitted when there is nothing to
// say — an unconditional `clamped: false` on every result trains a reader to
// stop looking at it.
function landingReport(
	landing: Landing,
	requestedStartSec: number,
	requestedEndSec: number,
): Record<string, unknown> {
	const clamped =
		Math.abs(landing.startSec - requestedStartSec) > 0.001 ||
		Math.abs(landing.endSec - requestedEndSec) > 0.001;
	return {
		startSec: landing.startSec,
		endSec: landing.endSec,
		ids: landing.ids,
		...(clamped ? { clamped: true, requestedStartSec, requestedEndSec } : {}),
		...(landing.fragments > 1 ? { fragments: landing.fragments } : {}),
	};
}

function landingSuffix(
	landing: Landing,
	requestedStartSec: number,
	requestedEndSec: number,
): string {
	const parts: string[] = [];
	if (
		Math.abs(landing.startSec - requestedStartSec) > 0.001 ||
		Math.abs(landing.endSec - requestedEndSec) > 0.001
	) {
		parts.push(
			`clamped from ${formatSec(requestedStartSec)} – ${formatSec(requestedEndSec)} to fit the clips`,
		);
	}
	if (landing.fragments > 1) parts.push(`split across ${landing.fragments} clips`);
	return parts.length ? ` (${parts.join(", ")})` : "";
}

/** Ids of every modifier in the document, all four families at once — the basis
 * for naming what a destructive edit took with it. */
function modifierIdsOf(document: AxcutDocument): string[] {
	const legacy = (document.legacyEditor as Record<string, unknown>) ?? {};
	const speedRegions = (legacy.speedRegions as Array<{ id: string }> | undefined) ?? [];
	const cameraFullscreenRegions =
		(legacy.cameraFullscreenRegions as Array<{ id: string }> | undefined) ?? [];
	return [
		...document.zoomRanges.map((r) => r.id),
		...document.annotations.map((r) => r.id),
		...speedRegions.map((r) => r.id),
		...cameraFullscreenRegions.map((r) => r.id),
	];
}

/** ponytail: `setClipRange` and `removeClip` both delete anchored modifiers as a
 * side effect (`setClipSourceRange` drops the pills the new window no longer
 * covers; `removeClip` takes everything anchored to the clip). Both used to
 * report only what was asked — "trimmed clip to 0:00.0 – 0:03.0" while a zoom
 * ceased to exist. Nothing in the result NAMED the casualty, which is what made
 * "the zoom is preserved" an easy thing for a model to say. */
function droppedByEdit(before: AxcutDocument, after: AxcutDocument) {
	const survivingModifiers = new Set(modifierIdsOf(after));
	const survivingTrims = new Set(after.timeline.trimRanges.map((t) => t.id));
	return {
		droppedModifierIds: modifierIdsOf(before).filter((id) => !survivingModifiers.has(id)),
		droppedTrimIds: before.timeline.trimRanges
			.map((t) => t.id)
			.filter((id) => !survivingTrims.has(id)),
	};
}

// Zod arg schemas — the SINGLE source of truth for every tool's arguments. The executor
// below validates against them, and the deep-agent (LangChain) layer imports the same
// objects to build its `tool()`s, so the two can never advertise a different shape than the
// one we actually validate. (The primitives `secondsSchema`/`depthSchema`/`focusSchema` stay
// private — callers only ever need the composed `*Args`.)
const secondsSchema = z.number().finite().nonnegative();

export const addTrimArgs = z.object({
	startSec: secondsSchema,
	endSec: secondsSchema,
	assetId: z.string().min(1).optional(),
	// A cut belongs to ONE clip. Without this, a project where two clips draw from the same
	// asset (a duplicated clip) cannot say which of them the model meant, and the cut lands
	// on both. Resolved from the source range when the model omits it and only one clip
	// matches; ambiguity is reported back rather than guessed.
	clipId: z.string().min(1).optional(),
	reason: z.string().default(""),
});

/**
 * ponytail: the element schema is `addTrimArgs` itself, not a copy of it.
 *
 * A batch is N unitary calls and nothing else — same validation, same clip
 * resolution, same refusal wording — so the two can never drift into meaning
 * different things. A separate element schema would be one more place to forget
 * `clipId` the next time the unitary one grows a field.
 *
 * The `union(…, unknown)` is what makes "each item stands or falls alone" true for
 * MALFORMED items too, not just unplaceable ones. A bare `z.array(addTrimArgs)`
 * rejects the whole call the moment one entry is bad — and it rejects it in
 * LangChain, before `applyBatch` runs — so nine good cuts would be thrown away
 * with the tenth and `refused[index]` could never name it. Advertising the
 * union keeps the element shape in the JSON schema the model reads (it shows up
 * as `anyOf: [addTrim, {}]`) while letting a bad entry through to the unitary
 * executor, which refuses it by itself with the wording it always uses.
 *
 * No cap on the array. A half-hour recording has hundreds of silences, and the
 * point of this tool is precisely that it should not have to guess how many are
 * too many. Picking a number here would repeat the mistake `getTranscript` made
 * with its 800.
 */
export const addTrimsArgs = z.object({
	ranges: z.array(z.union([addTrimArgs, z.unknown()])).min(1),
});

export const setTrimArgs = z.object({
	trimRangeId: z.string().min(1),
	startSec: secondsSchema,
	endSec: secondsSchema,
});

export const setClipRangeArgs = z.object({
	clipId: z.string().min(1),
	sourceStartSec: secondsSchema,
	sourceEndSec: secondsSchema,
});

export const replaceTimelineArgs = z.object({
	intervals: z.array(z.object({ startSec: secondsSchema, endSec: secondsSchema })).min(1),
	reason: z.string().default(""),
});

/**
 * ponytail: `beforeClipId`, never an index.
 *
 * `moveClip` (document/timeline.ts) takes an `insertIndex` interpreted against
 * the array AFTER the moved clip is removed — V4Timeline does the `-1` by hand
 * at its call site, with a comment about it. That is a fine internal contract
 * and a terrible one to hand a language model: off by one is silent here, and
 * "put the demo first" would land it second. A neighbour's id has no such
 * ambiguity. Null (or omitted) means last, which is the only position no
 * existing clip can name.
 *
 * There is deliberately NO `reason` field: `reason` is the clip's label ("intro",
 * "demo"), the only thing in the snapshot that lets the model tell two clips
 * apart. A reorder must not be able to overwrite it.
 */
export const moveClipArgs = z.object({
	clipId: z.string().min(1),
	beforeClipId: z.string().min(1).nullish(),
});

export const getTranscriptArgs = z.object({
	assetId: z.string().min(1).optional(),
});

// ponytail: an assetId, never a path. The model names a row of the document and
// the runtime resolves it to `asset.originalPath` behind the allow-list; letting
// it name a file instead would turn a read-only reporting tool into an arbitrary
// JSON reader on the user's disk.
export const getCursorTrackArgs = z.object({
	assetId: z.string().min(1).optional(),
});

// Effects (zoom / speed / annotation) are authored in *virtual* (edited-
// timeline) seconds — the position on the ruler the user sees — unlike clips
// and trims, which are source-time. The executor converts to the stored ms.
const depthSchema = z.number().int().min(1).max(6);
const focusSchema = z.object({ cx: z.number().min(0).max(1), cy: z.number().min(0).max(1) });

export const addZoomArgs = z.object({
	startSec: secondsSchema,
	endSec: secondsSchema,
	depth: depthSchema.default(3),
	focus: focusSchema.default({ cx: 0.5, cy: 0.5 }),
});

/** Same contract as `addTrimsArgs`: the element schema IS the unitary one, and
 *  it is advertised rather than enforced so a bad region is refused by itself. */
export const addZoomsArgs = z.object({
	regions: z.array(z.union([addZoomArgs, z.unknown()])).min(1),
});

export const setZoomArgs = z.object({
	zoomId: z.string().min(1),
	startSec: secondsSchema.optional(),
	endSec: secondsSchema.optional(),
	depth: depthSchema.optional(),
	focus: focusSchema.optional(),
});

export const addSpeedArgs = z.object({
	startSec: secondsSchema,
	endSec: secondsSchema,
	speed: z.number().positive().default(1.5),
});

export const setSpeedArgs = z.object({
	speedId: z.string().min(1),
	startSec: secondsSchema.optional(),
	endSec: secondsSchema.optional(),
	speed: z.number().positive().optional(),
});

export const addAnnotationArgs = z.object({
	startSec: secondsSchema,
	endSec: secondsSchema,
	text: z.string().default(""),
	x: z.number().min(0).max(100).default(50),
	y: z.number().min(0).max(100).default(50),
});

export const setAnnotationArgs = z.object({
	annotationId: z.string().min(1),
	startSec: secondsSchema.optional(),
	endSec: secondsSchema.optional(),
	text: z.string().optional(),
});

export const addCameraFullscreenArgs = z.object({
	startSec: secondsSchema,
	endSec: secondsSchema,
});

export const setCameraFullscreenArgs = z.object({
	cameraFullscreenId: z.string().min(1),
	startSec: secondsSchema.optional(),
	endSec: secondsSchema.optional(),
});

export const removeTrimArgs = z.object({
	trimRangeId: z.string().min(1),
});

export const removeModifierArgs = z.object({
	id: z.string().min(1),
});

export const removeClipArgs = z.object({
	clipId: z.string().min(1),
});

/**
 * Every tool the model is handed, in the order `buildTools` builds them.
 *
 * The roster lives here, beside `MUTATING_TOOL_NAMES`, rather than in
 * `deep-agent/service.ts` where `buildTools` is: the workbench needs to name the
 * surface from its L0 layer, and importing the service would drag LangChain into
 * a layer that deliberately runs on zod and pure document helpers alone.
 *
 * It is hand-written — the schemas differ per tool, so nothing can generate it —
 * but it is not free-floating: `deep-agent/service.test.ts` asserts it equals
 * `buildTools(...).map(t => t.name)`, and that test runs in CI. Adding a tool
 * without adding it here fails the suite.
 *
 * ponytail: there used to be two more copies of this list, one in that test and
 * one in `workbench/lib/prompts.ts`, neither derived from anything. The
 * workbench's copy sat at 19 entries from the day it was written while the agent
 * grew to 21 (`addTrims`/`addZooms`, commit 560d368e). Nothing caught it,
 * because `npm run wb` is not part of CI — so the bench asserted a surface the
 * product had not had for some time.
 */
export const OPENSCREEN_TOOL_NAMES = [
	"getCurrentDocument",
	"getTranscript",
	"getCursorTrack",
	"addTrim",
	"addTrims",
	"setTrim",
	"setClipRange",
	"moveClip",
	"replaceTimeline",
	"addZoom",
	"addZooms",
	"setZoom",
	"addSpeed",
	"setSpeed",
	"addAnnotation",
	"setAnnotation",
	"addCameraFullscreen",
	"setCameraFullscreen",
	"removeTrim",
	"removeModifier",
	"removeClip",
] as const;

/**
 * The tools `createDeepAgent` used to inject on top of ours, over an in-memory
 * backend that was EMPTY and that the model was not told was empty — the
 * mechanical cause of D1, where the agent ran `ls`/`glob` against that sandbox
 * and reported in good faith that the project held no cursor telemetry.
 *
 * The surface is gone, so this is no longer "tools we also get": it is the list
 * of names that must never appear again. A call to one of them now means the
 * model is hallucinating a filesystem it was never offered, which is a rarer but
 * still exact D1 tell — which is why the workbench scores it as well as pinning
 * it here.
 *
 * `execute` is included even though it vanished at runtime: it is in the
 * middleware's list too and only disappeared because the default backend is not
 * a sandbox. A sandbox backend would have made it a 26th tool. The workbench's
 * own copy of this list omitted it, so `isPhantomTool` could not flag the one
 * name a sandbox backend would have brought back.
 */
export const PHANTOM_TOOL_NAMES = [
	"ls",
	"read_file",
	"write_file",
	"edit_file",
	"glob",
	"grep",
	"execute",
	"write_todos",
	"task",
] as const;

/**
 * The tools that change the document. A LIST, not an inference: it gates the
 * checkpoint the chat-service takes before a write and the mutating/non-mutating
 * split the workbench scores its DSL axis on, and neither should quietly change
 * because someone edited a switch case.
 *
 * ponytail: this replaces `AGENT_TOOL_SPECS`, ~300 lines of JSON schema whose
 * own comment said "sent verbatim to the provider". It has not been sent
 * anywhere since the deep-agent landed: the model receives the zod schemas
 * built in `deep-agent/service.ts` and the prose in `TOOL_DESCRIPTIONS`. Two
 * descriptions of the same tools, only one of them reaching the model — and it
 * was the other one that humans read and kept up to date. The surviving
 * documentation duty is `TOOL_DESCRIPTIONS`; `service.test.ts` pins the three
 * remaining surfaces (descriptions, built tools, executor cases) to each other.
 */
export const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set([
	"addTrim",
	"addTrims",
	"addZooms",
	"setTrim",
	"setClipRange",
	"moveClip",
	"replaceTimeline",
	"addZoom",
	"setZoom",
	"addSpeed",
	"setSpeed",
	"addAnnotation",
	"setAnnotation",
	"addCameraFullscreen",
	"setCameraFullscreen",
	"removeTrim",
	"removeModifier",
	"removeClip",
]);

export function isMutatingTool(name: string): boolean {
	return MUTATING_TOOL_NAMES.has(name);
}

function roundSec(ms: number): number {
	return Math.round(ms) / 1000;
}

// Compact projection of the document for the model: everything it needs to
// reference ids and times, nothing it doesn't (no waveform paths, no history).
//
// Three clearly-separated groups, each with its OWN time-base spelled out so the
// model never has to guess:
//   • clips   — arranged segments; source-time in/out + their timeline position.
//   • trims   — source-time cuts inside a clip (do not split the clip).
//   • effects — zoom / speed / annotation, in *virtual* (edited-timeline)
//     seconds, i.e. positions on the ruler after clips + trims are applied.
//
// ponytail: what a projection LEAVES OUT is a claim too, and two omissions here
// were being read by the model as facts about the project.
//   • `cameraTrack` — the assets went out as `{id, label, durationSec}`, so two
//     projects identical except for a linked webcam were literally
//     indistinguishable. `addCameraFullscreen` answered ok either way, and the
//     model placed a full-camera region on a project with no camera and
//     reported it done. `hasCameraTrack` is the exact parity of `hasTranscript`
//     below, which had already solved the same problem for the transcript.
//   • the zoom's real strength — `depth` went out bare. It is an ORDINAL, so a
//     reader turns "3" into "3×" while the frame renders 1.80×; and when a
//     migrated v1.7 project carries `customScale`, `depth` is inert and nothing
//     said so. `renderedScale` is `effectiveZoomScale`, the renderer's own
//     function, so the number the model reports is the number the viewer sees.
export function documentSnapshotForModel(
	document: AxcutDocument,
	cursorTelemetry?: CursorTelemetryContext,
): Record<string, unknown> {
	const availability = cursorTelemetry?.availableByAssetId;
	const legacy = document.legacyEditor as Record<string, unknown> | null;
	const speedRegions =
		(legacy?.speedRegions as
			| Array<{ id: string; startMs: number; endMs: number; speed: number }>
			| undefined) ?? [];
	const cameraFullscreenRegions =
		(legacy?.cameraFullscreenRegions as
			| Array<{ id: string; startMs: number; endMs: number }>
			| undefined) ?? [];
	// The global Auto-Focus toggle OVERRIDES each region's own focusMode at
	// render (sceneDescription.ts:703) and the inspector disables the per-region
	// control while it is on. Reporting the stored mode would hand the model a
	// second thing to be confidently wrong about, so the projection reports the
	// EFFECTIVE mode and the flag that decides it.
	const autoFocusAll = legacy?.autoFocusAll === true;
	return {
		timeBaseNote:
			"clips and trims are in source-time seconds; zooms, speedRegions, annotations and cameraFullscreenRegions are in virtual (edited-timeline) seconds.",
		zoomNote:
			`renderedScale is what the viewer sees (depth is an ordinal, not a factor: ${ZOOM_DEPTH_LEGEND}). ` +
			"When a zoom carries customScale it wins over depth and depthIsOverridden is true — " +
			"a setZoom that only changes depth on such a zoom clears customScale so the depth takes effect.",
		project: { id: document.project.id, title: document.project.title },
		primaryAssetId: document.project.primaryAssetId ?? document.assets[0]?.id ?? null,
		autoFocusAll,
		hasAnyCamera: hasAnyClipWithCamera(document.assets, document.timeline.clips),
		cursorNote:
			"assets[].hasCursorTelemetry says whether recorded pointer telemetry exists for that " +
			"asset. true — call getCursorTrack to read the recorded pointer track. " +
			"false — this asset was checked and has none (imported footage, or a recording made " +
			"without the cursor recorder). null — it was NOT checked from here; say that, and do " +
			"not report it as the project having no cursor data.",
		assets: document.assets.map((a) => ({
			id: a.id,
			label: a.label,
			durationSec: a.durationSec ?? null,
			hasCameraTrack: a.cameraTrack != null,
			cameraVisible: a.cameraTrack?.visible ?? false,
			// Three-valued on purpose (see `CursorTelemetryContext`): `null` is
			// "not checked", and it must never render as `false`. The whole defect
			// was a runtime that could not look being read as a project that has
			// nothing — same field, same three states, one honest projection.
			//
			// `?? null`, not `?? false`: an asset MISSING from the map is one whose
			// probe threw. Defaulting that to `false` would put our failure back in
			// the answer as their fact, one layer lower down.
			hasCursorTelemetry: availability?.[a.id] ?? null,
		})),
		// ponytail: `index`, `reason` and `origin` are here because without them a
		// clip cannot be DESIGNATED. "Put the demo first" is unanswerable when the
		// only handles are `clip_1`/`clip_2` and two indistinguishable source
		// windows — the label the user sees lives in `reason`, and it was not being
		// sent. A reorder tool without this is a tool the model cannot aim.
		clips: document.timeline.clips.map((c, index) => ({
			id: c.id,
			index,
			assetId: c.assetId,
			reason: c.reason,
			origin: c.origin,
			sourceStartSec: c.sourceStartSec,
			sourceEndSec: c.sourceEndSec ?? null,
			timelineStartSec: c.timelineStartSec,
			timelineEndSec: c.timelineEndSec,
		})),
		trimRanges: document.timeline.trimRanges.map((s) => ({
			id: s.id,
			assetId: s.assetId,
			// The clip the cut is on — the only thing separating two cuts over the same
			// media. `null` is a pre-v7 cut that still applies to every clip of its asset.
			clipId: s.clipId ?? null,
			startSec: s.startSec,
			endSec: s.endSec,
			reason: s.reason,
		})),
		zoomRanges: coalesceForAgent(document.zoomRanges).map((z) => ({
			id: z.id,
			startSec: roundSec(z.startMs),
			endSec: roundSec(z.endMs),
			depth: z.depth,
			renderedScale: effectiveZoomScale(z),
			// Emitted only when set: an unconditional `customScale: null` on every
			// zoom of every snapshot is noise the reader learns to skip, which is
			// how the field would go unnoticed again.
			...(z.customScale != null ? { customScale: z.customScale, depthIsOverridden: true } : {}),
			...(z.rotationPreset ? { rotationPreset: z.rotationPreset } : {}),
			focus: z.focus,
			focusMode: autoFocusAll ? "auto" : (z.focusMode ?? "manual"),
			source: z.source ?? "manual",
		})),
		speedRegions: coalesceForAgent(speedRegions).map((s) => ({
			id: s.id,
			startSec: roundSec(s.startMs),
			endSec: roundSec(s.endMs),
			speed: s.speed,
		})),
		annotations: coalesceForAgent(document.annotations).map((a) => ({
			id: a.id,
			startSec: roundSec(a.startMs),
			endSec: roundSec(a.endMs),
			type: a.type,
			text: a.textContent ?? a.content ?? "",
		})),
		cameraFullscreenRegions: coalesceForAgent(cameraFullscreenRegions).map((c) => ({
			id: c.id,
			startSec: roundSec(c.startMs),
			endSec: roundSec(c.endMs),
		})),
		hasTranscript: document.transcripts.length > 0 || document.transcript !== null,
	};
}

function failure(message: string): AgentToolExecution {
	return { ok: false, resultJson: JSON.stringify({ error: message }) };
}

/**
 * Runs `unitName` once per item, folding the document forward.
 *
 * ponytail: the batch tools exist to save ROUND TRIPS, not to mean something new.
 * Replaying the unitary executor is what guarantees that — anchoring, clip
 * resolution, clamping, the wording of every refusal, all identical by
 * construction rather than by a second implementation staying in step. A batch
 * of N is exactly N unitary calls minus N-1 round trips, and `agent-tools.test`
 * asserts that against a document built the long way.
 *
 * ponytail: PARTIAL application, deliberately. `replaceTimeline` is the repo's
 * other array-taking tool and it refuses in one block — "Refused … Nothing was
 * modified" — which is right for a tool that rebuilds the whole timeline and
 * ruinous for one that adds ten independent cuts: a single bad bound would throw
 * away nine good ones and the model would have to guess which. So each item
 * stands or falls alone, and the result says which did what. `ok:false` is kept
 * for the case where NOTHING landed, because that is the only one where the
 * document did not move.
 */
function applyBatch(
	document: AxcutDocument,
	unitName: "addTrim" | "addZoom",
	items: unknown[],
	options: AgentToolOptions | undefined,
	noun: string,
): AgentToolExecution {
	let current = document;
	const applied: Array<Record<string, unknown>> = [];
	const refused: Array<{ index: number; error: string }> = [];

	items.forEach((item, index) => {
		const execution = executeAgentTool(current, unitName, JSON.stringify(item), options);
		let payload: Record<string, unknown> = {};
		try {
			payload = JSON.parse(execution.resultJson) as Record<string, unknown>;
		} catch {
			payload = { error: execution.resultJson };
		}
		if (execution.ok && execution.document) {
			current = execution.document;
			applied.push({ index, ...payload });
		} else {
			refused.push({ index, error: String(payload.error ?? "refused") });
		}
	});

	// Nothing landed: the document is untouched, so say so the way every other
	// refusal does rather than reporting a success with an empty list.
	if (applied.length === 0) {
		return failure(
			`No ${noun} was added. ` +
				refused.map((r) => `[${r.index}] ${r.error}`).join(" | ") +
				" Nothing was modified.",
		);
	}

	const refusedSuffix = refused.length ? `, ${refused.length} refused` : "";
	return {
		ok: true,
		document: current,
		// The counts come first on purpose: the model must be able to see that one
		// of ten was refused WITHOUT re-reading the document, and know which one.
		resultJson: JSON.stringify({
			requested: items.length,
			appliedCount: applied.length,
			refusedCount: refused.length,
			applied,
			...(refused.length ? { refused } : {}),
		}),
		summary: `added ${applied.length} ${noun}${applied.length === 1 ? "" : "s"}${refusedSuffix}`,
	};
}

/** The clips as the model would have to name them, for an error about an id it
 *  got wrong — a bare "Unknown clip: demo" leaves it guessing twice. */
function clipRoster(document: AxcutDocument): string {
	const clips = document.timeline.clips;
	if (clips.length === 0) return "The timeline has no clips.";
	return `The timeline is: ${clips.map((c) => `${c.id}${c.reason ? ` (${c.reason})` : ""}`).join(", ")}.`;
}

/**
 * The refusal the model gets for every write while `allowAgentEdits` is off.
 *
 * ponytail: it has to be ACTIONABLE, not merely negative. There is no
 * AbortSignal and no timeout anywhere on the product path, and the agent runs
 * at recursionLimit 1000: a bare "refused" invites a model to try the next
 * write tool, and the next, for as long as the provider will answer. So the
 * payload says what to do instead (state the edit, ask), that retrying is
 * pointless (every write is refused, not just this one), that claiming the edit
 * happened is forbidden, and where the user turns the setting back on. The
 * arguments are echoed back so the model can quote the exact edit it wanted
 * without a second round trip.
 *
 * The `{error}` envelope is the shape the workbench's wire oracle already
 * recognises as a failed tool result — a new one would read as a success.
 */
function consentRequired(name: string, args: unknown): AgentToolExecution {
	return {
		ok: false,
		resultJson: JSON.stringify({
			error:
				"Project edits are turned off for this project: the user asked to be consulted " +
				"before the timeline changes. Nothing was modified.",
			code: "consent_required",
			tool: name,
			requestedArgs: args,
			howToProceed:
				"Describe the exact edit you would make — the tool, the times, the ids — and ask the " +
				"user to confirm it. Do NOT retry this call and do NOT reach for another write tool: " +
				"every one of them is refused while the setting is off. Never say an edit was applied. " +
				"If they want you to go ahead, they can re-enable 'Project edits' in Settings → AI.",
		}),
	};
}

export interface AgentToolOptions {
	/**
	 * `allowAgentEdits` from the LLM config, threaded down as an explicit
	 * argument rather than read from a module global so this stays pure and
	 * testable. Only `false` refuses; `undefined` is "allowed", which keeps the
	 * three-argument call sites (and ~40 test assertions) working unchanged and
	 * mirrors `config.allowAgentEdits !== false`.
	 */
	editsAllowed?: boolean;
	/** Cursor telemetry resolved for THIS turn — see `CursorTelemetryContext`.
	 *  Absent means the runtime has no telemetry reader wired at all, which the
	 *  executor reports as "could not look", never as "there is none". */
	cursorTelemetry?: CursorTelemetryContext;
}

/**
 * What the runtime managed to find out about cursor telemetry this turn.
 *
 * ponytail: the three states are the whole point, and collapsing any two of them
 * is the defect. "There is no telemetry for this asset" is a fact about the
 * project. "I have no way to look" is a fact about me. The measured failure was
 * the model reporting the second as the first — it probed an empty sandbox and
 * concluded the recording had no pointer data — so the payloads keep them apart
 * and the prompt tells the model to keep them apart too.
 */
export interface CursorTelemetryContext {
	/** assetId → whether a sidecar exists. A MISSING key means "not checked",
	 *  which the snapshot reports as null, never false. */
	availableByAssetId?: Record<string, boolean>;
	/** The samples the async tool wrapper loaded before entering the executor.
	 *  `executeAgentTool` is synchronous — deliberately, it is the pure gate every
	 *  mutation passes through — so the IO happens outside and the verdict comes
	 *  in as data. */
	load?: CursorTelemetryLoad;
}

export type CursorTelemetryLoad =
	| { status: "ok"; assetId: string; samples: CursorTrackSample[]; durationSec?: number }
	/** We looked; this asset has no sidecar. */
	| { status: "no-sidecar"; assetId: string }
	/** We could NOT look: no reader wired, path refused, file unreadable. */
	| { status: "unavailable"; assetId: string | null; note?: string };

/** Resolves the asset a cursor/transcript question is about: the argument if it
 *  names one, otherwise the project's primary asset. Shared so the async wrapper
 *  in `deep-agent/service.ts` loads telemetry for exactly the asset the executor
 *  will then report on. */
export function resolveCursorAssetId(
	document: AxcutDocument,
	assetId?: string | null,
): string | null {
	return assetId ?? document.project.primaryAssetId ?? document.assets[0]?.id ?? null;
}

// ─── What the pointer was doing where the zoom landed ──────────────────────
//
// ponytail: `focus` is the one thing a zoom write says that nothing ever
// checked. A span covering no clip is refused, a depth outside the table is
// refused, and the result reports the span that really landed — but a focus on
// the pointer and a focus half a frame off it produced byte-identical results,
// so a caller had no way to find out which of the two it had just written. The
// result now carries where the pointer ACTUALLY was over the window the zoom
// landed on, beside the focus the call used.
//
// It informs; it decides nothing. Framing a slide, a face, or a corner the
// pointer never visits is a legitimate zoom: nothing is moved, nothing is
// refused, and this is a measurement the caller is free to disagree with. The
// only thing that changes is that the difference is on the page instead of
// nowhere.

/** Per-axis median, not the mean. A pointer that crosses the frame and comes
 *  back averages to the middle of a path it spent no time on, while the median
 *  lands where it actually sat. `spread` is what says whether either number
 *  describes anything. */
function medianOf(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round3(value: number): number {
	return Math.round(value * 1000) / 1000;
}

/**
 * Where the recorded pointer was over the span a zoom write LANDED on.
 *
 * A zoom is authored in VIRTUAL seconds and the pointer is recorded on the
 * asset's SOURCE clock, so something has to map between them — and that map
 * already exists, computed once by `anchorRawRegionsToClips`, which writes
 * `sourceStartSec`/`sourceEndSec` onto every fragment as it ventilates a span
 * across clips. So the source windows are read back OFF THE FRAGMENTS the write
 * just stored, never re-derived from `timelineStartSec`. A second derivation
 * would be free to drift, and it would drift on exactly the cases that make this
 * report worth having: a CLAMPED span and a span SPLIT across two clips both
 * land on source windows that are not the ones asked for, and both are already
 * right in the anchors. A fragment whose clip draws on another asset contributes
 * nothing — this telemetry does not describe that media.
 *
 * Absence is never a claim. The field is left OFF when the runtime holds no
 * telemetry for the footage under the span, which covers "no reader wired",
 * "this asset has no sidecar" and "the zoom landed on another asset's clip"
 * alike; none of those is evidence about the recording, and the tool description
 * says so. `available: false` is emitted only for the two things that ARE
 * findings about this span: nothing was recorded over it, or everything recorded
 * over it is cut out of playback.
 */
function cursorAnchorReport(
	// `id` is not read; it is what makes this a fragment of a stored region rather
	// than an all-optional bag TypeScript would let any object satisfy.
	regions: Array<{ id: string; clipId?: string; sourceStartSec?: number; sourceEndSec?: number }>,
	document: AxcutDocument,
	focus: { cx: number; cy: number },
	telemetry: CursorTelemetryContext | undefined,
): Record<string, unknown> | undefined {
	const load = telemetry?.load;
	if (load?.status !== "ok") return undefined;
	const byId = new Map(document.timeline.clips.map((c) => [c.id, c]));
	const windows = regions.flatMap((region) => {
		const clip = region.clipId ? byId.get(region.clipId) : undefined;
		if (!clip || clip.assetId !== load.assetId) return [];
		if (region.sourceStartSec === undefined || region.sourceEndSec === undefined) return [];
		return [{ clip, startSec: region.sourceStartSec, endSec: region.sourceEndSec }];
	});
	if (windows.length === 0) return undefined;

	const xs: number[] = [];
	const ys: number[] = [];
	let cutOut = 0;
	for (const sample of load.samples) {
		if (
			!Number.isFinite(sample.timeMs) ||
			!Number.isFinite(sample.cx) ||
			!Number.isFinite(sample.cy)
		) {
			continue;
		}
		const atSec = sample.timeMs / 1000;
		const covering = windows.find((w) => atSec >= w.startSec && atSec <= w.endSec);
		if (!covering) continue;
		// `trimAppliesToClip` is THE rule for "is this cut on this clip", and the
		// fragment names its clip, so the question is answered exactly once here.
		// A trimmed instant is one the viewer never reaches: a position argued from
		// frames that do not play would be the same kind of untruth as a span that
		// reports the edges it was asked for rather than the ones it got.
		if (
			document.timeline.trimRanges.some(
				(t) => trimAppliesToClip(t, covering.clip) && atSec >= t.startSec && atSec <= t.endSec,
			)
		) {
			cutOut += 1;
			continue;
		}
		xs.push(sample.cx);
		ys.push(sample.cy);
	}

	if (xs.length === 0) {
		return cutOut > 0
			? {
					available: false,
					reason: "trimmed-out",
					note:
						"The pointer WAS recorded over this span, but a trim cuts every one of those " +
						"instants out of playback, so none of them describes what a viewer sees here.",
				}
			: {
					available: false,
					reason: "no-samples",
					note:
						"This recording's pointer telemetry covers no instant of this span. That is a " +
						"fact about this span, not about the recording.",
				};
	}

	const cx = medianOf(xs);
	const cy = medianOf(ys);
	let spread = 0;
	for (let i = 0; i < xs.length; i += 1) {
		spread = Math.max(spread, Math.hypot(xs[i] - cx, ys[i] - cy));
	}
	return {
		available: true,
		// Echoed, including the default a call that omitted `focus` silently got:
		// "you asked for the centre" is the half of the comparison the caller
		// cannot reconstruct from its own arguments.
		focus: { cx: focus.cx, cy: focus.cy },
		cursor: { cx: round3(cx), cy: round3(cy) },
		offset: round3(Math.hypot(cx - focus.cx, cy - focus.cy)),
		spread: round3(spread),
		samples: xs.length,
	};
}

export function executeAgentTool(
	document: AxcutDocument,
	name: string,
	rawArgs: string,
	options?: AgentToolOptions,
): AgentToolExecution {
	let args: unknown = {};
	if (rawArgs.trim()) {
		try {
			args = JSON.parse(rawArgs);
		} catch {
			return failure(`Tool arguments are not valid JSON: ${rawArgs.slice(0, 120)}`);
		}
	}

	// ponytail: THE guard for `allowAgentEdits`. It sits here, in front of the
	// switch, because this function is the single gate every document mutation
	// passes through — the two production callers (`documentTool` for the main
	// agent and, through it, any sub-agent) and the workbench alike. A guard in
	// the event sink could not work: the sink is an observer, called from inside
	// the tool body, and by the time it fires the edit has happened.
	//
	// Reads stay open on purpose. A model that cannot call getCurrentDocument or
	// getTranscript cannot describe the edit it is asking permission for, and
	// would answer "I have no tool for that" — false, and worse than silence.
	if (options?.editsAllowed === false && isMutatingTool(name)) {
		return consentRequired(name, args);
	}

	switch (name) {
		case "getCurrentDocument": {
			return {
				ok: true,
				resultJson: JSON.stringify(documentSnapshotForModel(document, options?.cursorTelemetry)),
			};
		}

		case "getCursorTrack": {
			const parsed = getCursorTrackArgs.safeParse(args);
			if (!parsed.success) return failure(parsed.error.message);
			const assetId = resolveCursorAssetId(document, parsed.data.assetId);
			if (!assetId)
				return failure("Project has no assets — there is nothing to read telemetry for.");
			if (!document.assets.some((a) => a.id === assetId)) {
				return failure(`Unknown asset: ${assetId}`);
			}
			const load = options?.cursorTelemetry?.load;
			// ponytail: `ok: true` on all three branches, including the two that
			// return nothing. None of them is a failure of the CALL — the question
			// was answered, and the answer is "none" or "I could not look". Marking
			// them ok:false would push the model to retry a tool whose verdict will
			// not change, and there is no timeout anywhere on this path.
			if (!load || load.status === "unavailable") {
				return {
					ok: true,
					resultJson: JSON.stringify({
						available: false,
						reason: "unavailable",
						assetId,
						note:
							load?.note ??
							"Cursor telemetry cannot be read in this run — no reader is wired to this " +
								"runtime. This says nothing about whether the recording has any: report " +
								"the limit as yours, and do not tell the user the project has no cursor data.",
					}),
				};
			}
			if (load.status === "no-sidecar") {
				return {
					ok: true,
					resultJson: JSON.stringify({
						available: false,
						reason: "no-sidecar",
						assetId: load.assetId,
						note:
							"Checked: this asset has no cursor-telemetry sidecar. That normally means it " +
							"was imported rather than recorded with OpenScreen's cursor recorder. This is " +
							"a fact about the asset, not a limit of yours.",
					}),
				};
			}
			const asset = document.assets.find((a) => a.id === load.assetId);
			const track = buildCursorTrack({
				assetId: load.assetId,
				samples: load.samples,
				durationSec: load.durationSec ?? asset?.durationSec ?? 0,
				clips: document.timeline.clips,
				trimRanges: document.timeline.trimRanges,
			});
			return { ok: true, resultJson: JSON.stringify({ available: true, ...track }) };
		}

		case "getTranscript": {
			const parsed = getTranscriptArgs.safeParse(args);
			if (!parsed.success) return failure(parsed.error.message);
			const assetId =
				parsed.data.assetId ?? document.project.primaryAssetId ?? document.assets[0]?.id;
			const transcript =
				document.transcripts.find((t) => t.assetId === assetId) ??
				(document.transcript?.assetId === assetId ? document.transcript : null);
			if (!transcript) {
				return failure(`No transcript for asset ${assetId ?? "(none)"}.`);
			}
			// ponytail: no cap. There used to be a `.slice(0, 800)` here, guarded by
			// "words would blow the context" — written believing a segment was a
			// phrase. On the production path a segment IS one word
			// (src/lib/captioning/transcribe.ts: whisper's word timings are mapped
			// one-to-one), so the cap cut the transcript at the 800th WORD — around
			// five minutes of speech — and said nothing about it. The model read a
			// fifth of a half-hour recording, cut the silences it could see, and
			// reported the job done, because nothing in the payload told it otherwise.
			//
			// A whole 30-minute transcript is ~285k characters, ~70k tokens: large,
			// and well inside every model this app talks to. If a recording ever does
			// get near a window, the honest fix is to know the window — the app has no
			// per-model context budget today — not to guess a number here and drop the
			// rest in silence.
			const segments = transcript.segments.map((s) => ({
				id: s.id,
				kind: s.kind,
				startSec: s.startSec,
				endSec: s.endSec,
				text: s.text,
			}));
			return {
				ok: true,
				resultJson: JSON.stringify({ assetId, language: transcript.language, segments }),
			};
		}

		case "addTrim": {
			const parsed = addTrimArgs.safeParse(args);
			if (!parsed.success) return failure(parsed.error.message);
			const assetId =
				parsed.data.assetId ?? document.project.primaryAssetId ?? document.assets[0]?.id;
			if (!assetId) return failure("Project has no assets — nothing to trim.");
			if (!document.assets.some((a) => a.id === assetId)) {
				return failure(`Unknown asset: ${assetId}`);
			}
			const startSec = Math.min(parsed.data.startSec, parsed.data.endSec);
			const endSec = Math.max(parsed.data.startSec, parsed.data.endSec);

			// Which clip the cut sits on. Named explicitly when the model says so; otherwise
			// inferred from the source range — but only when the answer is unique. Two clips
			// over the same asset covering that range is a real question the model has to
			// answer (their ids are in the snapshot), not one to settle by picking the first.
			const covering = document.timeline.clips.filter(
				(c) =>
					c.assetId === assetId &&
					endSec > c.sourceStartSec &&
					startSec < (c.sourceEndSec ?? Number.POSITIVE_INFINITY),
			);
			let clipId = parsed.data.clipId;
			if (clipId) {
				const target = document.timeline.clips.find((c) => c.id === clipId);
				if (!target) return failure(`Unknown clip: ${clipId}`);
				if (target.assetId !== assetId) {
					return failure(`Clip ${clipId} does not use asset ${assetId}.`);
				}
			} else if (covering.length === 1) {
				clipId = covering[0].id;
			} else if (covering.length > 1) {
				return failure(
					`${covering.length} clips use asset ${assetId} over ${formatSec(startSec)} – ${formatSec(
						endSec,
					)} (${covering.map((c) => c.id).join(", ")}). Pass clipId to say which one to trim.`,
				);
			}

			const trim = {
				id: createId("trim"),
				assetId,
				...(clipId ? { clipId } : {}),
				startSec,
				endSec,
				reason: parsed.data.reason,
				origin: "agent" as const,
			};
			const next: AxcutDocument = {
				...document,
				timeline: {
					...document.timeline,
					trimRanges: [...document.timeline.trimRanges, trim],
				},
			};
			return {
				ok: true,
				document: next,
				resultJson: JSON.stringify({ trimRangeId: trim.id, startSec, endSec }),
				summary: `added trim ${formatSec(startSec)} – ${formatSec(endSec)}`,
			};
		}

		case "addTrims": {
			const parsed = addTrimsArgs.safeParse(args);
			if (!parsed.success) return failure(parsed.error.message);
			return applyBatch(document, "addTrim", parsed.data.ranges, options, "trim");
		}

		case "setTrim": {
			const parsed = setTrimArgs.safeParse(args);
			if (!parsed.success) return failure(parsed.error.message);
			const { trimRangeId } = parsed.data;
			if (!document.timeline.trimRanges.some((r) => r.id === trimRangeId)) {
				return failure(`Unknown trim range: ${trimRangeId}`);
			}
			const startSec = Math.min(parsed.data.startSec, parsed.data.endSec);
			const endSec = Math.max(parsed.data.startSec, parsed.data.endSec);
			// Moving a cut out of the clip it is anchored to would leave it storing a range
			// nothing plays — silently inert. Re-point it at the clip the new range actually
			// lands in, but only when that clip is unique: with several candidates the old
			// anchor is the better guess than an arbitrary one.
			const reanchor = (trim: AxcutDocument["timeline"]["trimRanges"][number]) => {
				if (!trim.clipId) return undefined;
				const covers = (c: { sourceStartSec: number; sourceEndSec?: number }) =>
					endSec > c.sourceStartSec && startSec < (c.sourceEndSec ?? Number.POSITIVE_INFINITY);
				const current = document.timeline.clips.find((c) => c.id === trim.clipId);
				if (current && covers(current)) return trim.clipId;
				const candidates = document.timeline.clips.filter(
					(c) => c.assetId === trim.assetId && covers(c),
				);
				return candidates.length === 1 ? candidates[0].id : trim.clipId;
			};
			const next: AxcutDocument = {
				...document,
				timeline: {
					...document.timeline,
					trimRanges: document.timeline.trimRanges.map((r) =>
						r.id === trimRangeId ? { ...r, clipId: reanchor(r), startSec, endSec } : r,
					),
				},
			};
			return {
				ok: true,
				document: next,
				resultJson: JSON.stringify({ trimRangeId, startSec, endSec }),
				summary: `moved trim to ${formatSec(startSec)} – ${formatSec(endSec)}`,
			};
		}

		case "setClipRange": {
			const parsed = setClipRangeArgs.safeParse(args);
			if (!parsed.success) return failure(parsed.error.message);
			const { clipId } = parsed.data;
			if (!document.timeline.clips.some((c) => c.id === clipId)) {
				return failure(`Unknown clip: ${clipId}`);
			}
			const sourceStartSec = Math.min(parsed.data.sourceStartSec, parsed.data.sourceEndSec);
			const sourceEndSec = Math.max(parsed.data.sourceStartSec, parsed.data.sourceEndSec);
			// One shared mutator with the modale + op dispatcher: recomputes the clip's
			// width from the new source window AND clamps/drops the anchored pills the
			// trim removed. Hand-rolling it here is exactly what left this façade orphaning
			// stale pills the other two didn't.
			const next = setClipSourceRange(document, clipId, sourceStartSec, sourceEndSec);
			const dropped = droppedByEdit(document, next);
			const casualties = dropped.droppedModifierIds.length + dropped.droppedTrimIds.length;
			return {
				ok: true,
				document: next,
				resultJson: JSON.stringify({ clipId, sourceStartSec, sourceEndSec, ...dropped }),
				summary:
					`trimmed clip to ${formatSec(sourceStartSec)} – ${formatSec(sourceEndSec)}` +
					(casualties > 0
						? ` — dropped ${[...dropped.droppedModifierIds, ...dropped.droppedTrimIds].join(", ")}`
						: ""),
			};
		}

		case "moveClip": {
			const parsed = moveClipArgs.safeParse(args);
			if (!parsed.success) return failure(parsed.error.message);
			const { clipId } = parsed.data;
			const beforeClipId = parsed.data.beforeClipId ?? null;
			const clips = document.timeline.clips;
			const moving = clips.find((c) => c.id === clipId);
			if (!moving) return failure(`Unknown clip: ${clipId}. ${clipRoster(document)}`);
			if (beforeClipId === clipId) {
				return failure(
					`beforeClipId must name a different clip than clipId (both were ${clipId}); ` +
						`pass null to move it last.`,
				);
			}
			const remaining = clips.filter((c) => c.id !== clipId);
			let insertIndex = remaining.length;
			if (beforeClipId !== null) {
				insertIndex = remaining.findIndex((c) => c.id === beforeClipId);
				if (insertIndex < 0) {
					return failure(`Unknown clip: ${beforeClipId}. ${clipRoster(document)}`);
				}
			}
			let next: AxcutDocument;
			try {
				// The clip's OWN origin is passed back in: `moveClip` stamps whatever it
				// is given onto the clip, and a reorder is not a change of provenance —
				// a user's clip stays the user's. Empty reason keeps its label.
				next = moveClip(document, clipId, insertIndex, moving.origin, "");
			} catch (err) {
				return failure(err instanceof Error ? err.message : String(err));
			}
			const order = next.timeline.clips.map((c) => c.id);
			return {
				ok: true,
				document: next,
				resultJson: JSON.stringify({
					clipId,
					beforeClipId,
					clipOrder: order,
					// Nothing is destroyed by a reorder — say so, since the alternative
					// tool the model used to reach for destroyed plenty in silence.
					trimCount: next.timeline.trimRanges.length,
					...droppedByEdit(document, next),
				}),
				summary:
					`moved ${clipId} ${beforeClipId ? `before ${beforeClipId}` : "to the end"} ` +
					`(order: ${order.join(" → ")})`,
			};
		}

		case "replaceTimeline": {
			const parsed = replaceTimelineArgs.safeParse(args);
			if (!parsed.success) return failure(parsed.error.message);
			// ponytail: refuse on the DAMAGE, not on the provenance. The old guard
			// tested `origin === "user"`, which missed every clip the agent itself had
			// placed — and disarmed itself, since a rebuild stamps its own output
			// `origin: "agent"`. `planTimelineReplacement` answers the question that
			// actually matters: what would this call cost?
			const plan = planTimelineReplacement(document, parsed.data.intervals);
			const objections: string[] = [];
			if (plan.reorderRequested) {
				objections.push(
					"- the intervals are not in ascending order, so this reads as a REORDER. " +
						"replaceTimeline sorts and merges its intervals, so the swap could not happen " +
						"at all: use moveClip (it preserves ids, trims and anchored effects).",
				);
			}
			if (plan.lostClipIds.length > 0) {
				objections.push(
					`- these clips would be merged away or dropped: ${plan.lostClipIds.join(", ")}. ` +
						"To shorten one, use setClipRange; to delete one, removeClip; to change the " +
						"order, moveClip; to cut a span inside one, addTrim.",
				);
			}
			if (plan.slidRegionIds.length > 0) {
				objections.push(
					`- these effects are anchored to those clips and would be re-anchored onto ` +
						`whatever footage moved under them: ${plan.slidRegionIds.join(", ")}.`,
				);
			}
			if (objections.length > 0) {
				return {
					ok: false,
					resultJson: JSON.stringify({
						error:
							"Refused: replaceTimeline would destroy work you were not asked to touch. " +
							"Nothing was modified.\n" +
							`${objections.join("\n")}\n` +
							"replaceTimeline rebuilds the whole timeline and is only for an explicit " +
							"'start over with these intervals' on a timeline with nothing to lose.",
						code: "would_destroy",
						reorderRequested: plan.reorderRequested,
						lostClipIds: plan.lostClipIds,
						slidRegionIds: plan.slidRegionIds,
					}),
				};
			}
			let next: AxcutDocument;
			try {
				next = replaceTimeline(document, parsed.data.intervals, parsed.data.reason, "agent");
			} catch (err) {
				return failure(err instanceof Error ? err.message : String(err));
			}
			const kept = parsed.data.intervals.length;
			return {
				ok: true,
				document: next,
				resultJson: JSON.stringify({
					clipCount: next.timeline.clips.length,
					trimCount: next.timeline.trimRanges.length,
					// What survived, by name. The old result reported two counts, and a
					// model reading `trimCount: 0` after a rebuild had nothing telling it
					// WHICH cut had ceased to exist — which is what made "the silence trim
					// is preserved" so easy to write.
					preservedClipIds: plan.slots.map((s) => s.keepClipId).filter((id): id is string => !!id),
					...(plan.absorbedTrimIds.length ? { absorbedTrimIds: plan.absorbedTrimIds } : {}),
					...(plan.clippedTrimIds.length ? { clippedTrimIds: plan.clippedTrimIds } : {}),
				}),
				summary:
					`rebuilt timeline from ${kept} interval${kept === 1 ? "" : "s"} ` +
					`(${next.timeline.clips.length} clips, ${next.timeline.trimRanges.length} trims)` +
					(plan.absorbedTrimIds.length
						? ` — ${plan.absorbedTrimIds.join(", ")} now fall outside the kept spans`
						: ""),
			};
		}

		case "addZoom": {
			const parsed = addZoomArgs.safeParse(args);
			if (!parsed.success) return failure(parsed.error.message);
			const startMs = toMs(Math.min(parsed.data.startSec, parsed.data.endSec));
			const endMs = toMs(Math.max(parsed.data.startSec, parsed.data.endSec));
			const zoom = {
				id: createId("zoom"),
				startMs,
				endMs,
				depth: parsed.data.depth as 1 | 2 | 3 | 4 | 5 | 6,
				focus: parsed.data.focus,
				focusMode: "manual" as const,
				source: "manual" as const,
			};
			const placed = anchorForAgent(zoom, document, "zoom");
			const landing = landingOf(placed, document);
			if (!landing.anchored) return coversNoClip("zoom", startMs / 1000, endMs / 1000, document);
			const next: AxcutDocument = {
				...document,
				zoomRanges: [...document.zoomRanges, ...placed] as AxcutDocument["zoomRanges"],
			};
			// Measured over what was STORED, never over what was asked for: `placed`
			// is the clamped, ventilated truth, so the report cannot end up
			// describing a window the zoom does not occupy.
			const anchor = cursorAnchorReport(placed, document, zoom.focus, options?.cursorTelemetry);
			return {
				ok: true,
				document: next,
				resultJson: JSON.stringify({
					zoomId: landing.ids[0],
					depth: zoom.depth,
					// The depth alone is an ordinal; reported on its own it is what the
					// model turns into "3×" for a frame that renders 1.80×.
					renderedScale: effectiveZoomScale(zoom),
					...landingReport(landing, startMs / 1000, endMs / 1000),
					...(anchor ? { cursorAnchor: anchor } : {}),
				}),
				summary:
					`added zoom ${formatSec(landing.startSec)} – ${formatSec(landing.endSec)} ` +
					`at ${effectiveZoomScale(zoom).toFixed(2)}×` +
					landingSuffix(landing, startMs / 1000, endMs / 1000),
			};
		}

		case "addZooms": {
			const parsed = addZoomsArgs.safeParse(args);
			if (!parsed.success) return failure(parsed.error.message);
			return applyBatch(document, "addZoom", parsed.data.regions, options, "zoom");
		}

		case "setZoom": {
			const parsed = setZoomArgs.safeParse(args);
			if (!parsed.success) return failure(parsed.error.message);
			const { zoomId } = parsed.data;
			const existing = document.zoomRanges.find((z) => z.id === zoomId);
			if (!existing) return failure(`Unknown zoom: ${zoomId}`);
			const { startMs, endMs } = resolveSpanMs(existing, parsed.data.startSec, parsed.data.endSec);
			const zoomPill = new Set(resolvePillIds(document.zoomRanges, zoomId));
			// ponytail: a depth write CLEARS customScale, and that is the whole
			// point. `effectiveZoomScale` returns customScale when it is set, so on a
			// migrated v1.7 zoom (`migrate.ts:185` keeps both fields) a `setZoom
			// {depth: 6}` used to store the 6, answer ok, and leave the picture at
			// 1.10× forever — a write that could not do what every layer involved
			// believed it did. Dropping the override is destructive of a fine-tuned
			// value, so it happens only on an explicit depth write (which IS a
			// request to change the strength) and is named in the result and the
			// summary rather than done quietly.
			const clearsCustomScale =
				parsed.data.depth !== undefined &&
				document.zoomRanges.some((z) => zoomPill.has(z.id) && z.customScale != null);
			const rebuiltZooms = replacePillSpan(
				// payload edits first, applied to every region under the pill…
				document.zoomRanges.map((z) => {
					if (!zoomPill.has(z.id)) return z;
					const { customScale, ...rest } = z;
					return {
						...(clearsCustomScale ? rest : z),
						...(parsed.data.depth !== undefined
							? { depth: parsed.data.depth as 1 | 2 | 3 | 4 | 5 | 6 }
							: {}),
						...(parsed.data.focus ? { focus: parsed.data.focus } : {}),
					};
				}),
				// …then the span: clamped against different-property pills, then re-ventilated.
				zoomId,
				startMs,
				endMs,
				document.timeline.clips,
				() => createId("zoom"),
			) as AxcutDocument["zoomRanges"];
			const landing = landingAfterPillEdit(document.zoomRanges, rebuiltZooms, zoomPill, document);
			if (!landing.anchored) return coversNoClip("zoom", startMs / 1000, endMs / 1000, document);
			const next: AxcutDocument = { ...document, zoomRanges: rebuiltZooms };
			// Read back off the document, not off the request: the pill may have been
			// re-ventilated, and `renderedScale` is the only number the viewer sees.
			const landed = new Set(landing.ids);
			const strength = rebuiltZooms.find((z) => landed.has(z.id));
			// The EFFECTIVE focus, read off the document exactly like `renderedScale`
			// is: a setZoom that moved only the span still gets told what its
			// untouched focus now looks at, which is most of the reason to reshape a
			// zoom at all.
			const anchor = strength
				? cursorAnchorReport(
						rebuiltZooms.filter((z) => landed.has(z.id)),
						document,
						strength.focus,
						options?.cursorTelemetry,
					)
				: undefined;
			return {
				ok: true,
				document: next,
				resultJson: JSON.stringify({
					zoomId: landing.ids[0] ?? zoomId,
					...(strength
						? { depth: strength.depth, renderedScale: effectiveZoomScale(strength) }
						: {}),
					...(clearsCustomScale ? { clearedCustomScale: true } : {}),
					...landingReport(landing, startMs / 1000, endMs / 1000),
					...(anchor ? { cursorAnchor: anchor } : {}),
				}),
				summary:
					`updated zoom ${formatSec(landing.startSec)} – ${formatSec(landing.endSec)}` +
					(strength ? ` at ${effectiveZoomScale(strength).toFixed(2)}×` : "") +
					(clearsCustomScale ? " (cleared its custom scale so the depth applies)" : "") +
					landingSuffix(landing, startMs / 1000, endMs / 1000),
			};
		}

		case "addSpeed": {
			const parsed = addSpeedArgs.safeParse(args);
			if (!parsed.success) return failure(parsed.error.message);
			const startMs = toMs(Math.min(parsed.data.startSec, parsed.data.endSec));
			const endMs = toMs(Math.max(parsed.data.startSec, parsed.data.endSec));
			const legacy = (document.legacyEditor as Record<string, unknown>) ?? {};
			const prev = (legacy.speedRegions as unknown[] | undefined) ?? [];
			const region = { id: createId("speed"), startMs, endMs, speed: parsed.data.speed };
			const placed = anchorForAgent(region, document, "speed");
			const landing = landingOf(placed, document);
			if (!landing.anchored) {
				return coversNoClip("speed region", startMs / 1000, endMs / 1000, document);
			}
			const next: AxcutDocument = {
				...document,
				legacyEditor: { ...legacy, speedRegions: [...prev, ...placed] },
			};
			return {
				ok: true,
				document: next,
				resultJson: JSON.stringify({
					speedId: landing.ids[0],
					speed: region.speed,
					...landingReport(landing, startMs / 1000, endMs / 1000),
				}),
				summary:
					`added ${parsed.data.speed}× speed ${formatSec(landing.startSec)} – ${formatSec(landing.endSec)}` +
					landingSuffix(landing, startMs / 1000, endMs / 1000),
			};
		}

		case "setSpeed": {
			const parsed = setSpeedArgs.safeParse(args);
			if (!parsed.success) return failure(parsed.error.message);
			const legacy = (document.legacyEditor as Record<string, unknown>) ?? {};
			const prev =
				(legacy.speedRegions as
					| Array<{ id: string; startMs: number; endMs: number; speed: number }>
					| undefined) ?? [];
			const existing = prev.find((s) => s.id === parsed.data.speedId);
			const speedPill = new Set(resolvePillIds(prev, parsed.data.speedId));
			if (!existing) return failure(`Unknown speed region: ${parsed.data.speedId}`);
			const { startMs, endMs } = resolveSpanMs(existing, parsed.data.startSec, parsed.data.endSec);
			const speed = parsed.data.speed ?? existing.speed;
			const rebuiltSpeeds = replacePillSpan(
				prev.map((s) => (speedPill.has(s.id) ? { ...s, speed } : s)),
				parsed.data.speedId,
				startMs,
				endMs,
				document.timeline.clips,
				() => createId("speed"),
			);
			const landing = landingAfterPillEdit(prev, rebuiltSpeeds, speedPill, document);
			if (!landing.anchored) {
				return coversNoClip("speed region", startMs / 1000, endMs / 1000, document);
			}
			const next: AxcutDocument = {
				...document,
				legacyEditor: { ...legacy, speedRegions: rebuiltSpeeds },
			};
			return {
				ok: true,
				document: next,
				resultJson: JSON.stringify({
					speedId: landing.ids[0] ?? parsed.data.speedId,
					speed,
					...landingReport(landing, startMs / 1000, endMs / 1000),
				}),
				summary:
					`updated speed to ${speed}× over ${formatSec(landing.startSec)} – ${formatSec(landing.endSec)}` +
					landingSuffix(landing, startMs / 1000, endMs / 1000),
			};
		}

		case "addAnnotation": {
			const parsed = addAnnotationArgs.safeParse(args);
			if (!parsed.success) return failure(parsed.error.message);
			const startMs = toMs(Math.min(parsed.data.startSec, parsed.data.endSec));
			const endMs = toMs(Math.max(parsed.data.startSec, parsed.data.endSec));
			const ann = {
				id: createId("ann"),
				startMs,
				endMs,
				type: "text" as const,
				content: parsed.data.text,
				textContent: parsed.data.text,
				position: { x: parsed.data.x, y: parsed.data.y },
				size: { width: 30, height: 20 },
				style: {
					color: "#ffffff",
					backgroundColor: "transparent",
					fontSize: 32,
					fontFamily: "Inter",
					fontWeight: "bold" as const,
					fontStyle: "normal" as const,
					textDecoration: "none" as const,
					textAlign: "center" as const,
				},
				zIndex: document.annotations.length + 1,
			};
			const placed = anchorForAgent(ann, document, "ann");
			const landing = landingOf(placed, document);
			if (!landing.anchored) {
				return coversNoClip("annotation", startMs / 1000, endMs / 1000, document);
			}
			const next: AxcutDocument = {
				...document,
				annotations: [...document.annotations, ...placed] as AxcutDocument["annotations"],
			};
			return {
				ok: true,
				document: next,
				resultJson: JSON.stringify({
					annotationId: landing.ids[0],
					...landingReport(landing, startMs / 1000, endMs / 1000),
				}),
				summary:
					`added annotation "${parsed.data.text.slice(0, 24)}" ${formatSec(landing.startSec)} – ${formatSec(landing.endSec)}` +
					landingSuffix(landing, startMs / 1000, endMs / 1000),
			};
		}

		case "setAnnotation": {
			const parsed = setAnnotationArgs.safeParse(args);
			if (!parsed.success) return failure(parsed.error.message);
			const { annotationId } = parsed.data;
			const existing = document.annotations.find((a) => a.id === annotationId);
			const annPill = new Set(resolvePillIds(document.annotations, annotationId));
			if (!existing) return failure(`Unknown annotation: ${annotationId}`);
			const { startMs, endMs } = resolveSpanMs(existing, parsed.data.startSec, parsed.data.endSec);
			const rebuiltAnnotations = replacePillSpan(
				document.annotations.map((a) =>
					annPill.has(a.id)
						? {
								...a,
								...(parsed.data.text !== undefined
									? { content: parsed.data.text, textContent: parsed.data.text }
									: {}),
							}
						: a,
				),
				annotationId,
				startMs,
				endMs,
				document.timeline.clips,
				() => createId("ann"),
			);
			const landing = landingAfterPillEdit(
				document.annotations,
				rebuiltAnnotations,
				annPill,
				document,
			);
			if (!landing.anchored) {
				return coversNoClip("annotation", startMs / 1000, endMs / 1000, document);
			}
			const next: AxcutDocument = { ...document, annotations: rebuiltAnnotations };
			return {
				ok: true,
				document: next,
				resultJson: JSON.stringify({
					annotationId: landing.ids[0] ?? annotationId,
					...landingReport(landing, startMs / 1000, endMs / 1000),
				}),
				summary:
					`updated annotation ${formatSec(landing.startSec)} – ${formatSec(landing.endSec)}` +
					landingSuffix(landing, startMs / 1000, endMs / 1000),
			};
		}

		case "addCameraFullscreen": {
			const parsed = addCameraFullscreenArgs.safeParse(args);
			if (!parsed.success) return failure(parsed.error.message);
			const startMs = toMs(Math.min(parsed.data.startSec, parsed.data.endSec));
			const endMs = toMs(Math.max(parsed.data.startSec, parsed.data.endSec));
			const legacy = (document.legacyEditor as Record<string, unknown>) ?? {};
			const prev = (legacy.cameraFullscreenRegions as unknown[] | undefined) ?? [];
			const region = { id: createId("camfull"), startMs, endMs };
			const placed = anchorForAgent(region, document, "camfull");
			const landing = landingOf(placed, document);
			if (!landing.anchored) {
				return coversNoClip("full-camera region", startMs / 1000, endMs / 1000, document);
			}
			const blind = noCameraUnderSpan(document, landing.startSec, landing.endSec);
			if (blind) return blind;
			const next: AxcutDocument = {
				...document,
				legacyEditor: { ...legacy, cameraFullscreenRegions: [...prev, ...placed] },
			};
			return {
				ok: true,
				document: next,
				resultJson: JSON.stringify({
					cameraFullscreenId: landing.ids[0],
					...landingReport(landing, startMs / 1000, endMs / 1000),
				}),
				summary:
					`full-camera ${formatSec(landing.startSec)} – ${formatSec(landing.endSec)}` +
					landingSuffix(landing, startMs / 1000, endMs / 1000),
			};
		}

		case "setCameraFullscreen": {
			const parsed = setCameraFullscreenArgs.safeParse(args);
			if (!parsed.success) return failure(parsed.error.message);
			const legacy = (document.legacyEditor as Record<string, unknown>) ?? {};
			const prev =
				(legacy.cameraFullscreenRegions as
					| Array<{ id: string; startMs: number; endMs: number }>
					| undefined) ?? [];
			const existing = prev.find((r) => r.id === parsed.data.cameraFullscreenId);
			if (!existing)
				return failure(`Unknown full-camera region: ${parsed.data.cameraFullscreenId}`);
			const { startMs, endMs } = resolveSpanMs(existing, parsed.data.startSec, parsed.data.endSec);
			const camPill = new Set(resolvePillIds(prev, parsed.data.cameraFullscreenId));
			const rebuiltCamera = replacePillSpan(
				prev,
				parsed.data.cameraFullscreenId,
				startMs,
				endMs,
				document.timeline.clips,
				() => createId("camfull"),
			);
			const landing = landingAfterPillEdit(prev, rebuiltCamera, camPill, document);
			if (!landing.anchored) {
				return coversNoClip("full-camera region", startMs / 1000, endMs / 1000, document);
			}
			const blindMove = noCameraUnderSpan(document, landing.startSec, landing.endSec);
			if (blindMove) return blindMove;
			const next: AxcutDocument = {
				...document,
				legacyEditor: { ...legacy, cameraFullscreenRegions: rebuiltCamera },
			};
			return {
				ok: true,
				document: next,
				resultJson: JSON.stringify({
					cameraFullscreenId: landing.ids[0] ?? parsed.data.cameraFullscreenId,
					...landingReport(landing, startMs / 1000, endMs / 1000),
				}),
				summary:
					`moved full-camera to ${formatSec(landing.startSec)} – ${formatSec(landing.endSec)}` +
					landingSuffix(landing, startMs / 1000, endMs / 1000),
			};
		}

		case "removeTrim": {
			const parsed = removeTrimArgs.safeParse(args);
			if (!parsed.success) return failure(parsed.error.message);
			const { trimRangeId } = parsed.data;
			if (!document.timeline.trimRanges.some((s) => s.id === trimRangeId)) {
				return failure(`Unknown trim range: ${trimRangeId}`);
			}
			const next = removeRegion(document, "trim", trimRangeId);
			return {
				ok: true,
				document: next,
				resultJson: JSON.stringify({ removed: trimRangeId, kind: "trim" }),
				summary: `removed trim ${trimRangeId}`,
			};
		}

		case "removeModifier": {
			const parsed = removeModifierArgs.safeParse(args);
			if (!parsed.success) return failure(parsed.error.message);
			const { id } = parsed.data;
			const legacy = (document.legacyEditor as Record<string, unknown>) ?? {};
			const speedRegions = (legacy.speedRegions as Array<{ id: string }> | undefined) ?? [];
			const cameraFullscreenRegions =
				(legacy.cameraFullscreenRegions as Array<{ id: string }> | undefined) ?? [];
			let kind: RegionKind | null = null;
			if (document.zoomRanges.some((z) => z.id === id)) kind = "zoom";
			else if (document.annotations.some((a) => a.id === id)) kind = "annotation";
			else if (speedRegions.some((s) => s.id === id)) kind = "speed";
			else if (cameraFullscreenRegions.some((c) => c.id === id)) kind = "cameraFullscreen";
			if (!kind) {
				return failure(
					`No zoom / speed / annotation / full-camera modifier with id ${id}. ` +
						`For a trim use removeTrim; for a clip use removeClip.`,
				);
			}
			const next = removeRegion(document, kind, id);
			return {
				ok: true,
				document: next,
				resultJson: JSON.stringify({ removed: id, kind }),
				summary: `removed ${kind} ${id}`,
			};
		}

		case "removeClip": {
			const parsed = removeClipArgs.safeParse(args);
			if (!parsed.success) return failure(parsed.error.message);
			const { clipId } = parsed.data;
			if (!document.timeline.clips.some((c) => c.id === clipId)) {
				return failure(`Unknown clip: ${clipId}`);
			}
			const next = removeClip(document, clipId);
			const dropped = droppedByEdit(document, next);
			const casualties = dropped.droppedModifierIds.length + dropped.droppedTrimIds.length;
			return {
				ok: true,
				document: next,
				resultJson: JSON.stringify({
					removed: clipId,
					clipCount: next.timeline.clips.length,
					...dropped,
				}),
				summary:
					`removed clip ${clipId}` +
					(casualties > 0
						? ` — dropped ${[...dropped.droppedModifierIds, ...dropped.droppedTrimIds].join(", ")}`
						: ""),
			};
		}

		default:
			return failure(`Unknown tool: ${name}`);
	}
}
