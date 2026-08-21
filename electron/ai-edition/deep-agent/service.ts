// ponytail: port of axcut's AxcutDeepAgentService (apps/server/src/services/
// axcut-deep-agent.ts). Wraps LangChain's `createAgent` (LangGraph ReAct graph)
// with our existing document tools and emits agent.text / agent.toolStart /
// agent.toolEnd / agent.error events into a sink the chat-service pipes through
// `webContents.send`.
//
// It used to wrap `createDeepAgent` from the `deepagents` package. That factory
// stacks three middlewares unconditionally — filesystem, todo-list, sub-agents —
// which handed the model EIGHT extra tools (ls / read_file / write_file /
// edit_file / glob / grep / write_todos / task) bound to an EMPTY in-memory
// backend, plus ~5 800 characters of system prompt promising a filesystem this
// app does not have. Nothing here used any of it, and the cost was not
// cosmetic: asked what cursor telemetry the project holds, the model ran
// `ls {"path":"/"}` then `glob {"pattern":"**/*"}` against that empty sandbox
// and reported, in good faith, that the project contains no pointer data. A
// fabricated proof of absence. `createDeepAgent` has no option to drop those
// middlewares (they are in `REQUIRED_MIDDLEWARE_NAMES`), so the fix is to stop
// going through it: `createAgent` is what it wrapped, minus the sandbox.

import { anthropicPromptCachingMiddleware, createAgent, tool } from "langchain";
import { z } from "zod";
import type { AxcutDocument } from "../../../src/lib/ai-edition/schema";
// ponytail: the legend is DERIVED from the depth→scale table, not retyped. Both
// tool descriptions used to assert "depth 1–6 maps to 1.0×–3.5×" — a formula
// (`depth/2 + 0.5`) that was purged from two rendering sites and survived here,
// wrong at both ends of a table that actually runs 1.25× to 5.0×.
import { ZOOM_DEPTH_LEGEND } from "../../../src/lib/ai-edition/timeline/zoom-scale";
import {
	addAnnotationArgs,
	addCameraFullscreenArgs,
	addSpeedArgs,
	addTrimArgs,
	addTrimsArgs,
	addZoomArgs,
	addZoomsArgs,
	type CursorTelemetryLoad,
	executeAgentTool,
	getCursorTrackArgs,
	getTranscriptArgs,
	isMutatingTool,
	moveClipArgs,
	removeClipArgs,
	removeModifierArgs,
	removeTrimArgs,
	replaceTimelineArgs,
	resolveCursorAssetId,
	setAnnotationArgs,
	setCameraFullscreenArgs,
	setClipRangeArgs,
	setSpeedArgs,
	setTrimArgs,
	setZoomArgs,
} from "../agent-tools";
import {
	createOpenScreenChatModel,
	messageContentToText,
	messageContentToThinking,
	type OpenScreenChatModelConfig,
} from "./chat-model";

export interface OpenScreenAgentSink {
	text: (delta: string) => void;
	/** Streaming delta from the model's reasoning block (Anthropic/MiniMax
	 * thinking). Provider-agnostic — for providers without thinking this is
	 * never called. The chat panel uses it to surface the reasoning phase
	 * that would otherwise be invisible "dead air" while the model thinks. */
	thinking: (delta: string) => void;
	toolStart: (name: string, args: unknown) => void;
	toolEnd: (name: string, ok: boolean, summary?: string) => void;
	error: (message: string) => void;
}

// The tool arg schemas live in agent-tools.ts (imported above) — one source of truth for
// both the executor's validation and the LangChain `tool()`s built here. Only the empty /
// inline read-tool schemas below stay local.

/**
 * The block appended when the user has turned "Project edits" off.
 *
 * ponytail: the executor's refusal is the wall (see `consentRequired` in
 * agent-tools.ts) but a wall alone does not fix the measured defect. The
 * workbench scores `dsl.consent.no-silent-edit` on the tool_calls the model
 * EMITS, not on what the executor did with them, so a turn that fires three
 * writes and has them all refused still reads as a silent-edit attempt — and
 * rightly: the model tried. Only the prompt can stop the emission. Two layers,
 * neither sufficient alone.
 */
const CONSENT_PROMPT_BLOCK = [
	"",
	"PROJECT EDITS ARE CURRENTLY DISABLED by the user, who asked to be consulted before the timeline changes.",
	"- Read freely: getCurrentDocument and getTranscript work as usual.",
	"- Do NOT call any tool that writes (addTrim, setTrim, setClipRange, moveClip, replaceTimeline, add*/set* effects, remove*). Every one of them will be refused, so calling them wastes the turn and tells the user nothing.",
	"- Instead: say precisely what you would change — which tool, which times, which ids — and ask the user to confirm. Be specific enough that they can say yes to it.",
	"- Never state or imply that an edit was applied. If the user confirms and you are still refused, tell them the 'Project edits' setting in Settings → AI has to be re-enabled first.",
].join("\n");

// ponytail: exported so a test can assert that what the model receives is this
// string and NOTHING else — the deepagents regression was invisible precisely
// because the middlewares appended their prompts downstream of this constant.
const BASE_SYSTEM_PROMPT = [
	"You are an AI video editor working inside OpenScreen. The user is editing a recording.",
	"Help them cut silences, tighten pacing, add captions, and rewrite titles.",
	"Be concise, action-oriented, and reference the timeline or transcript by time when relevant.",
	"You can call the tools below against the live document snapshot; the runtime executes each edit and feeds the result back into the loop.",
	"The AxcutDocument is the single source of truth. The timeline, the transcript editor, and the chat panel are all direct editors of the same document — when the user places a clip on the timeline, the document updates immediately, and when the timeline is empty, the document has no clips. Your edits operate on the live document, so preserve the user's placed clips.",
	"",
	"Time-bases (do not mix them up): clips and trims are in SOURCE-time seconds of an asset; zooms, speed regions, annotations and camera-fullscreen regions are in VIRTUAL (edited-timeline) seconds — the position on the ruler after clips + trims are applied. getCurrentDocument returns all of them, clearly labelled.",
	"",
	// ponytail: these describe what each tool is FOR, deliberately without quoting
	// user phrasings. A phrase→tool table reads as helpful and is not: it swaps the
	// model's language understanding for a lookup, so it covers the wordings we
	// happened to list and silently misses every paraphrase — and every language
	// other than English. Say what the tool does; let the model do the matching.
	"How the tools map to intent — pick the most specific one, and prefer the smallest edit that satisfies the request:",
	"- Silences, pauses and dead stretches are removed as trims INSIDE the placed clip. Send them together with addTrims once you know the ranges; addTrim is for a single cut or a correction. The placed clip stays the canonical cut; it is not rebuilt to drop them.",
	"- Changing where a clip starts or ends within its source is setClipRange — the clip's in/out, distinct from a trim.",
	`- addZoom takes a virtual-timeline span (depth is an ordinal 1–6 selecting from a fixed table — ${ZOOM_DEPTH_LEGEND} — never a multiplier; focus in 0–1 frame fractions). addSpeed changes pacing over a span. addAnnotation puts text on screen. addCameraFullscreen enlarges the webcam, and only does something where assets[].hasCameraTrack is true.`,
	"- moveClip changes the order of placed clips, one call per clip that moves, preserving ids, source ranges, trims and anchored effects. replaceTimeline rebuilds the timeline from kept intervals and sorts them, so it cannot reorder anything.",
	"- Deleting is a first-class action, not a workaround: removeTrim, removeModifier, removeClip. Never fake a deletion by re-adding an element or zeroing it out (span 0, speed 1×) — that leaves it in the document and misreports what you did.",
	"If nothing in the list does what was asked, say so; do not approximate it with a bigger tool.",
	"",
	"Cursor telemetry: while the screen was captured, OpenScreen recorded where the pointer went. assets[].hasCursorTelemetry in getCurrentDocument says which assets carry it, and getCursorTrack returns the recorded track for one of them — positions over time, and the pointer shape at each moment. What it means is yours to read.",
	"Blindness is not evidence. When a tool reports it could not read something (reason 'unavailable'), that is a limit of your runtime, not a fact about the project. Only an explicit negative — reason 'no-sidecar', or a false flag — supports telling the user the data is not there.",
	"",
	"Honesty rules: if a request has NO matching tool (e.g. deleting an asset/recording, exporting), say so plainly — do not substitute a different edit and report it as the requested one. After your edits, if you are at all unsure the document ended up as intended, call getCurrentDocument and reconcile what you claim with the real state; each tool result already tells you exactly what it did, so never report a change the results don't support.",
].join("\n");

/** The system prompt for a turn, which depends on ONE thing: whether the user
 *  currently allows the agent to write. Exported so the consent wording can be
 *  tested without a provider. */
export function buildSystemPrompt(options: { editsAllowed: boolean }): string {
	return options.editsAllowed ? BASE_SYSTEM_PROMPT : BASE_SYSTEM_PROMPT + CONSENT_PROMPT_BLOCK;
}

/** The prompt of a normal (edits-allowed) turn — the overwhelmingly common
 *  case, and the string the surface tests measure the wire against. */
export const SYSTEM_PROMPT = buildSystemPrompt({ editsAllowed: true });

export const TOOL_DESCRIPTIONS: Record<string, string> = {
	getCurrentDocument:
		"Read a compact snapshot of the current project: assets (with durations), timeline clips and trim ranges (source-time), and the zoom / speed / annotation effects (virtual, edited-timeline time). Call this before editing if the snapshot in the system prompt may be stale. The AxcutDocument is the single source of truth — your edits should preserve the user's placed clips and any timeline state they have already set up.",
	getTranscript:
		"Read the transcript segments (speech and silence, with start/end seconds and text) for an asset. Omit assetId to read the primary asset's transcript.",
	getCursorTrack:
		"Read the recorded pointer track for an asset: where the cursor was over time, downsampled to a readable rate. Each point carries atSec (the asset's own source clock), virtualSec (the same instant on the edited timeline — the coordinate addZoom takes, null when no clip carries it), cx/cy as 0–1 fractions of the frame, and `shape`, an index into the pointer bitmaps the recording used (equal values are the same pointer; a change means the pointer changed, e.g. arrow to text caret). Points that are not plain moves carry `kind`; points a trim cuts out of playback carry `trimmed`. These are real samples, not a summary — reading what the pointer was doing is yours. Omit assetId for the primary asset. It answers `available:false` in two DIFFERENT ways you must not confuse: reason 'no-sidecar' means this asset was checked and genuinely has no telemetry, while reason 'unavailable' means it could not be read from here.",
	addTrim:
		"Add ONE trim range: a cut of a span inside a clip (this source-time span will not be played or exported) that does NOT split the clip. Times are in seconds of the asset's source time. This is the preferred (and for 'remove silences' requests, the only) way to handle silences; it preserves the user's placed clips and only adds a cut. When you have several cuts to make, use addTrims and send them together — this one is for a single cut or a later correction. A cut belongs to ONE clip: `clipId` is inferred when a single clip covers the range, but when several clips draw on the same asset over it the call FAILS and lists them — pass the `clipId` you mean (ids come from getCurrentDocument).",
	addTrims:
		"Add MANY trim ranges in one call: `ranges` is a list, each entry taking exactly the fields addTrim takes. Use this whenever you have more than one cut to make — 'remove the silences' on a half-hour recording is hundreds of cuts, and sending them one at a time costs one round trip each. Each range stands or falls ALONE: one that cannot be placed is refused by itself and listed in `refused` with its index and the reason, while every other range is still applied. Nothing is rolled back, so a single bad bound never costs you the rest. The result leads with requested / appliedCount / refusedCount so you can see a partial outcome without re-reading the document — report what was refused rather than claiming the whole list landed.",
	setTrim:
		"Move or resize an existing trim range by id. Times are source-time seconds. The cut follows to whichever clip the new range lands in, when that clip is unambiguous.",
	setClipRange:
		"Set a clip's in/out points (source-time seconds) to shorten its head or tail — distinct from a trim (which cuts a span inside the clip). All clips are re-laid back-to-back afterwards, so downstream clips shift automatically. Use this ONLY when the user explicitly asks to shorten or extend a user-placed clip. Do NOT use this for 'remove silences' or 'cut pauses' — for those, use addTrim.",
	moveClip:
		"Reorder a placed clip: move `clipId` so it plays just before `beforeClipId` (pass null, or omit it, to move it last). Ids come from getCurrentDocument, where each clip carries its `index` and its label in `reason`. This preserves every clip id, every source range, every trim, and the zooms / speed regions / annotations anchored to each clip. This is the tool for 'swap these clips', 'put X first' and 'change the clip order' — replaceTimeline cannot reorder anything.",
	replaceTimeline:
		"Replace the whole timeline with the given kept intervals of the primary asset's source time. Everything outside the intervals becomes a trim. The intervals are SORTED, so this can never reorder clips — use moveClip for that. DO NOT use this for 'cut silences' or 'remove pauses' — the user has likely placed clips on the timeline that you'd be discarding. Use this ONLY when the user explicitly asks you to rebuild the timeline from scratch (e.g. 'start over with the kept intervals from the transcript'). It is refused when it would merge away, shorten or drop an existing clip; the refusal names them and the tool to use instead.",
	addZoom: `Add a zoom-in over a span of the edited timeline (virtual seconds). depth is an ORDINAL 1–6, not a factor: it selects a magnification from a fixed table (${ZOOM_DEPTH_LEGEND}), so the default depth 3 renders at 1.80×. The result reports renderedScale — quote that, never the depth, when telling the user how strong the zoom is. focus is the zoom centre in 0–1 fractions of the frame (default centre). When the recording's pointer telemetry can be read for the footage under the span, the result also carries \`cursorAnchor\`: \`focus\` echoes the value this call used (including the default, if you left it out), \`cursor\` is where the pointer ACTUALLY was over the span the zoom landed on — the median of the recorded samples, \`spread\` being how far the farthest one strays from it — and \`offset\` is the distance between the two, in frame fractions. It is a measurement, not a correction: nothing is moved and no call is refused over it, and a zoom framing a slide, a face, or a region the pointer never enters is a legitimate choice. \`available:false\` names what it found instead (\`no-samples\`, \`trimmed-out\`). Its ABSENCE means no telemetry was read for that footage — never that the recording has none; assets[].hasCursorTelemetry and getCursorTrack are what answer that. Use for 'zoom in on …' and the smart-zoom pass.`,
	addZooms: `Add MANY zooms in one call: \`regions\` is a list, each entry taking exactly the fields addZoom takes (same depth table, ${ZOOM_DEPTH_LEGEND}). Use this for the smart-zoom pass, where you have decided every zoom before emitting the first one — sending them one at a time costs one round trip each. Each region stands or falls ALONE: one that covers no clip is refused by itself and listed in \`refused\` with its index and the reason, while the others are still applied. The result leads with requested / appliedCount / refusedCount, and each applied entry carries its renderedScale — quote that, never the depth — plus the same \`cursorAnchor\` addZoom reports, whenever the footage under that region has readable pointer telemetry.`,
	setZoom: `Move, resize, or restyle an existing zoom by id (virtual-timeline seconds). Only the fields you pass are changed. depth selects from the same table (${ZOOM_DEPTH_LEGEND}); if the zoom carries a customScale (getCurrentDocument shows it as depthIsOverridden), that custom value is what renders, and passing depth clears it so the depth takes effect — the result says so. The result reports the resulting renderedScale, and — when the footage under the span has readable pointer telemetry — the same \`cursorAnchor\` addZoom reports, measured against the zoom's EFFECTIVE focus, so a call that moved only the span still learns what its unchanged focus is now looking at.`,
	addSpeed:
		"Add a speed-change region over a span of the edited timeline (virtual seconds). speed > 1 fast-forwards, < 1 slows down (default 1.5×). Use to speed through slow stretches without cutting them.",
	setSpeed:
		"Move, resize, or change the multiplier of an existing speed region by id (virtual-timeline seconds). Only the fields you pass are changed.",
	addAnnotation:
		"Add a text annotation over a span of the edited timeline (virtual seconds). x/y are frame percentages (0–100, default centre). Use for callouts and labels.",
	setAnnotation:
		"Move, resize, or edit the text of an existing annotation by id (virtual-timeline seconds). Only the fields you pass are changed.",
	addCameraFullscreen:
		"Add a camera-fullscreen region over a span of the edited timeline (virtual seconds): the webcam fills the frame for that span. This only does something when the footage under that span comes from an asset with a linked webcam — check assets[].hasCameraTrack (or hasAnyCamera) in getCurrentDocument first. On footage with no camera the call is refused rather than storing a region that would render nothing; say so instead of retrying.",
	setCameraFullscreen:
		"Move or resize an existing camera-fullscreen region by id (virtual-timeline seconds). Only the fields you pass are changed. Refused if the new span lands on footage with no linked webcam.",
	removeTrim:
		"Delete a trim range by id — the cut is undone and that span plays/exports again. This is how you 'remove a trim'; never re-add a trim to undo one.",
	removeModifier:
		"Delete a modifier (zoom / speed / annotation / camera-fullscreen) by id; the kind is resolved from the id. This is how you 'remove'/'delete' one — never neutralise it (span 0, speed 1×), which leaves it in the document. For a trim use removeTrim; for a clip use removeClip.",
	removeClip:
		"Delete a placed clip by id; remaining clips close the gap and effects anchored to it are dropped. Use only when the user asks to remove a clip — to shorten one, use setClipRange.",
};

// ponytail: mutable document holder so a write-tool that updates the snapshot
// is observed by the NEXT tool call inside the same agent turn. LangChain's
// `tool()` factory captures the document by reference via the holder, so
// each tool sees the latest mutated snapshot.
type DocumentHolder = { current: AxcutDocument };

/**
 * The runtime's door onto recorded cursor telemetry.
 *
 * ponytail: an INTERFACE, injected, because everything that can actually read a
 * sidecar lives behind Electron's path allow-list, and `electron/ai-edition/`
 * deliberately imports nothing from `electron`. It takes an assetId plus the
 * path the DOCUMENT already holds — never a path the model chose.
 *
 * When no reader is injected the tool answers "unavailable", which is honest and
 * useless; a reader that is wired everywhere except production would be a
 * quieter version of the bug being fixed, so `handlers.ts` is the one caller
 * that matters and there is a test for the unwired case.
 */
export interface CursorTelemetryReader {
	read(input: { assetId: string; originalPath: string | null }): Promise<CursorTelemetryLoad>;
	/** Cheap "is there a sidecar?" check, run once per turn for every asset so
	 *  `getCurrentDocument` can report `hasCursorTelemetry` without reading the
	 *  file. A reader may omit it; the snapshot then reports null (not checked). */
	probe?(input: { assetId: string; originalPath: string | null }): Promise<boolean>;
}

interface ToolRuntime {
	cursor?: CursorTelemetryReader;
	availableByAssetId?: Record<string, boolean>;
}

/**
 * The tools whose RESULT depends on the recorded pointer track, so the async
 * wrapper knows to do the read before entering the synchronous executor.
 *
 * ponytail: the zoom writes are on this list, not only the reader. A `focus`
 * that nothing reports back on is a `focus` nobody can check — the write
 * answered `ok` whether it framed the pointer or the opposite corner. They pass
 * no assetId, so the read resolves to the primary asset and the executor reports
 * the anchor ONLY for fragments whose clip draws on that same asset: measured
 * against the right media, or left off, never inferred from the wrong one.
 *
 * No cache. The read is a local JSON parse, `addZooms` is what keeps a whole
 * zoom pass to one call rather than N, and nothing on this path memoises today —
 * a cache here would be one more thing to invalidate for a saving nobody has
 * measured.
 */
const TOOLS_READING_CURSOR: ReadonlySet<string> = new Set([
	"getCursorTrack",
	"addZoom",
	"addZooms",
	"setZoom",
]);

// One document tool: run it through the shared executor, advance the holder so
// the next tool in the turn sees the edit, and emit exactly ONE start/end pair
// carrying the executor's REAL verdict.
//
// ponytail: reads go through here too, and that is the point. The read tools
// used to emit nothing of their own and be announced only by the `on_tool_end`
// branch of the stream loop, which hard-coded `ok: true` — so a `getTranscript`
// that came back `{"error":"No transcript for asset …"}` was reported as a
// success, and every write was announced twice (once truthfully here, once as
// `ok: true` there). One factory, one pair, one verdict. `executeAgentTool`
// never throws, so `execution.ok` is the only honest signal available.
function documentTool<S extends z.ZodType>(
	holder: DocumentHolder,
	sink: OpenScreenAgentSink,
	name: string,
	schema: S,
	editsAllowed: boolean,
	runtime: ToolRuntime,
) {
	return tool(
		async (args: z.infer<S>) => {
			sink.toolStart(name, args);
			// ponytail: the ONE async step the pure executor cannot take. Reading a
			// sidecar is IO; `executeAgentTool` is synchronous by design (it is the
			// gate every mutation passes through, and it has to stay testable
			// without a filesystem). So the load happens here and its verdict —
			// including "I could not look" — goes in as data.
			const load = TOOLS_READING_CURSOR.has(name)
				? await loadCursorTelemetry(holder.current, args, runtime)
				: undefined;
			const execution = executeAgentTool(holder.current, name, JSON.stringify(args), {
				editsAllowed,
				cursorTelemetry: { availableByAssetId: runtime.availableByAssetId, load },
			});
			if (execution.document) holder.current = execution.document;
			sink.toolEnd(name, execution.ok, execution.summary);
			return execution.resultJson;
		},
		{ name, description: TOOL_DESCRIPTIONS[name], schema },
	);
}

/** Reads the sidecar for whichever asset the call names, defaulting to the
 *  primary one — the same resolution the executor will use to report it. */
async function loadCursorTelemetry(
	document: AxcutDocument,
	args: unknown,
	runtime: ToolRuntime,
): Promise<CursorTelemetryLoad> {
	const requested = (args as { assetId?: unknown } | null)?.assetId;
	const assetId = resolveCursorAssetId(document, typeof requested === "string" ? requested : null);
	if (!assetId) return { status: "unavailable", assetId: null };
	if (!runtime.cursor) {
		return { status: "unavailable", assetId };
	}
	const asset = document.assets.find((a) => a.id === assetId);
	try {
		return await runtime.cursor.read({ assetId, originalPath: asset?.originalPath ?? null });
	} catch (error) {
		// A reader that throws is still "we could not look" — never "there is
		// none". Collapsing the two is the exact failure this tool exists to stop.
		return {
			status: "unavailable",
			assetId,
			note: `Cursor telemetry could not be read: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * The complete tool surface handed to the model. Exported so a test can assert
 * its exact shape — the count is the cheapest tripwire for a dependency that
 * starts injecting tools of its own again.
 *
 * ponytail: the write tools are built even when `editsAllowed` is false, and
 * that is deliberate. Withholding them would make the model answer "I have no
 * tool for that" — a lie, and one that hides the setting instead of surfacing
 * it. It has to be able to NAME the edit it is asking permission for.
 */
export function buildTools(
	holder: DocumentHolder,
	sink: OpenScreenAgentSink,
	editsAllowed = true,
	runtime: ToolRuntime = {},
) {
	const build = <S extends z.ZodType>(name: string, schema: S) =>
		documentTool(holder, sink, name, schema, editsAllowed, runtime);
	return [
		build("getCurrentDocument", z.object({})),
		build("getTranscript", getTranscriptArgs),
		build("getCursorTrack", getCursorTrackArgs),
		build("addTrim", addTrimArgs),
		build("addTrims", addTrimsArgs),
		build("setTrim", setTrimArgs),
		build("setClipRange", setClipRangeArgs),
		build("moveClip", moveClipArgs),
		build("replaceTimeline", replaceTimelineArgs),
		build("addZoom", addZoomArgs),
		build("addZooms", addZoomsArgs),
		build("setZoom", setZoomArgs),
		build("addSpeed", addSpeedArgs),
		build("setSpeed", setSpeedArgs),
		build("addAnnotation", addAnnotationArgs),
		build("setAnnotation", setAnnotationArgs),
		build("addCameraFullscreen", addCameraFullscreenArgs),
		build("setCameraFullscreen", setCameraFullscreenArgs),
		build("removeTrim", removeTrimArgs),
		build("removeModifier", removeModifierArgs),
		build("removeClip", removeClipArgs),
	];
}

/**
 * Prompt caching for the Anthropic-wire providers, which `createDeepAgent`
 * used to add for us (`isAnthropicModel` → `anthropicPromptCachingMiddleware`).
 * Dropping it silently would have made every Anthropic and MiniMax turn re-pay
 * for the full prompt — a cost and latency regression invisible to the offline
 * tests, which all run on the OpenAI-compatible path.
 *
 * The class-name probe is deepagents' own test, kept verbatim so MiniMax (which
 * rides `ChatAnthropic` because its wire format is Anthropic's) keeps caching.
 * `unsupportedModelBehavior: "ignore"` means a model that turns out not to
 * support cache breakpoints degrades instead of throwing.
 */
export function anthropicCachingMiddleware(chatModel: { getName?: () => string }) {
	if (chatModel.getName?.() !== "ChatAnthropic") return [];
	return [
		anthropicPromptCachingMiddleware({
			unsupportedModelBehavior: "ignore",
			minMessagesToCache: 1,
		}),
	];
}

export interface InvokeArgs {
	document: AxcutDocument;
	model: OpenScreenChatModelConfig;
	history: Array<{ role: "user" | "assistant" | "system"; content: string }>;
	userMessage: string;
	sink: OpenScreenAgentSink;
	/** `config.allowAgentEdits !== false`, resolved by the chat-service. When
	 *  false the write tools refuse and the prompt tells the model to ask.
	 *  Defaults to allowed so a caller that predates the flag behaves as before. */
	editsAllowed?: boolean;
	/** Injected by `chat-service` from the Electron layer. Absent in tests and in
	 *  the workbench unless one is supplied on purpose. */
	cursor?: CursorTelemetryReader;
}

/** One cheap probe per asset, run before the tools are built so the very first
 *  `getCurrentDocument` can already say whether telemetry exists. */
async function probeCursorTelemetry(
	document: AxcutDocument,
	cursor: CursorTelemetryReader | undefined,
): Promise<Record<string, boolean> | undefined> {
	if (!cursor?.probe) return undefined;
	const entries = await Promise.all(
		document.assets.map(async (asset) => {
			try {
				return [
					asset.id,
					await cursor.probe!({ assetId: asset.id, originalPath: asset.originalPath ?? null }),
				] as const;
			} catch {
				// A probe that throws leaves the asset OUT of the map, which the
				// snapshot renders as null — "not checked". Recording it as `false`
				// would turn our failure into a claim about the user's project.
				return null;
			}
		}),
	);
	const map: Record<string, boolean> = {};
	for (const entry of entries) {
		if (entry) map[entry[0]] = entry[1];
	}
	return map;
}

/**
 * ponytail: `on_tool_start` / `on_tool_end` are observed and DROPPED, not
 * forwarded to the sink. `documentTool` already announced the call with the
 * real arguments and the executor's real verdict; this branch has no access to
 * the tool's return value, so it could only ever invent `ok: true` — which is
 * exactly how a REFUSED `replaceTimeline` and a `getTranscript` that returned
 * `{"error":"No transcript…"}` both came out green. Every write was announced
 * twice, the second time as a success. A stream branch must never fabricate a
 * verdict: a tool built outside `documentTool` should be silent here (and get
 * caught by the "one pair per call" test) rather than quietly mislabelled.
 *
 * They are excluded from `nonChatEvents` as well, so the empty-response
 * diagnostic keeps listing only genuinely unhandled events.
 */
const SILENT_TOOL_EVENTS: ReadonlySet<string> = new Set(["on_tool_start", "on_tool_end"]);

export interface InvokeResult {
	text: string;
	document: AxcutDocument;
	mutated: boolean;
	/** Set when the stream finished without producing a final text (e.g. all
	 * chunks had empty `content`, or the provider returned no
	 * `content_block_delta` events). Carries a short diagnostic describing
	 * what the LangChain layer actually saw. */
	reason?: string;
}

export async function invokeOpenScreenAgent(args: InvokeArgs): Promise<InvokeResult> {
	const { document, model, history, userMessage, sink } = args;
	const editsAllowed = args.editsAllowed !== false;

	const holder: DocumentHolder = { current: document };
	const initialDocumentJSON = JSON.stringify(document);

	// ponytail: build a fresh agent per turn (same pattern as axcut). The
	// runtime side-effects (langgraph thread) are tied to the agent instance —
	// checkpoint-based stateful threads can land later by passing a
	// `checkpointer`; for v1 each turn is single-shot.
	const chatModel = await createOpenScreenChatModel(model);
	const availableByAssetId = await probeCursorTelemetry(document, args.cursor);
	const tools = buildTools(holder, sink, editsAllowed, {
		cursor: args.cursor,
		availableByAssetId,
	});
	const agent = createAgent({
		model: chatModel,
		tools,
		systemPrompt: buildSystemPrompt({ editsAllowed }),
		middleware: anthropicCachingMiddleware(chatModel),
	}).withConfig({
		// ponytail: NOT optional. LangGraph's default is 25 steps, and an
		// auto-enhance turn spends one step per silence — it would die mid-turn
		// with a GraphRecursionError, which this file's catch block relabels
		// "Empty response from model" (the same words a mute provider gets).
		// `createDeepAgent` used 1e4; that is reckless while there is still no
		// AbortSignal and no timeout anywhere on the product path — a looping
		// model would be indistinguishable from a hang. 1000 is far above any
		// real turn and still bounded.
		recursionLimit: 1000,
	});

	const messages = [...history, { role: "user" as const, content: userMessage }];

	// ponytail: declared outside the try block so the catch handler can
	// include any chunks we already saw in the diagnostic when the stream
	// throws partway through.
	let chatModelChunks: unknown[] = [];

	try {
		// ponytail: streamEvents (legacy mode, no `version: "v3"`) returns the
		// same on_chat_model_stream / on_tool_start / on_tool_end / on_chain_end
		// event stream axcut consumes. We use it both for live text deltas and
		// to know when the run has produced its final assistant message.
		const stream = (
			agent as unknown as {
				streamEvents: (state: unknown, config?: unknown) => AsyncIterable<Record<string, unknown>>;
			}
		).streamEvents({ messages }, undefined);

		let finalText = "";
		const nonChatEvents: Array<{ event: string; name: string }> = [];

		for await (const event of stream) {
			const eventType = typeof event.event === "string" ? event.event : "";
			const data = event.data as Record<string, unknown> | undefined;
			const name = typeof event.name === "string" ? (event.name as string) : "";

			if (eventType === "on_chat_model_stream") {
				const chunk = data?.chunk as Record<string, unknown> | undefined;
				if (chunk) chatModelChunks.push(chunk);
				const content = chunk?.content;
				const thinkingDelta = messageContentToThinking(content);
				if (thinkingDelta) {
					sink.thinking(thinkingDelta);
				}
				const delta = messageContentToText(content);
				if (delta) {
					sink.text(delta);
					finalText += delta;
				}
			} else if (eventType === "on_tool_error") {
				// Kept as a safety net rather than as a live path. `executeAgentTool`
				// never throws, and LangChain's ToolNode catches what does (an unknown
				// tool name, arguments the zod binding rejects) and feeds it back as
				// the tool RESULT instead of raising. This branch only fires for a
				// failure that escapes both — and then the stream is the only witness,
				// so it reports `ok: false` from evidence, never a fabricated verdict.
				sink.toolEnd(name, false, extractError(data));
			} else if (eventType && !SILENT_TOOL_EVENTS.has(eventType)) {
				nonChatEvents.push({ event: eventType, name });
			}
		}

		const mutated = JSON.stringify(holder.current) !== initialDocumentJSON;
		if (!finalText.trim()) {
			// ponytail: surface the upstream payload so we can see why MiniMax
			// (or any other anthropic-shaped provider) is producing no text.
			// The chat-model chunks are the post-parse LangChain views of
			// each SSE event; their `content`/`additional_kwargs`/
			// `response_metadata` fields tell us whether the issue is in the
			// wire format, the parser, or our `messageContentToText` shape.
			// Capped at
			// 1 chunk + a 1kB slice to keep the toast readable.
			const lastChunk = chatModelChunks[chatModelChunks.length - 1];
			const sample = lastChunk
				? JSON.stringify(lastChunk).slice(0, 1024)
				: "(no on_chat_model_stream events)";
			const reason =
				`Empty response from model (provider=${model.provider}, ` +
				`model=${model.model}, chat_model_chunks=${chatModelChunks.length}, ` +
				`other_events=${nonChatEvents.length}:${nonChatEvents
					.slice(0, 5)
					.map((e) => e.event)
					.join(",")}). Last chunk: ${sample}`;
			sink.error(reason);
			return { text: "", document: holder.current, mutated, reason };
		}
		return { text: finalText.trim(), document: holder.current, mutated };
	} catch (err) {
		// ponytail: surface the LangChain/HTTP error (with name + truncated
		// stack) so we can tell whether the stream threw (e.g. MiniMax
		// returning a non-Anthropic JSON envelope that the SDK rejects) or
		// completed with empty content. Mirrors the diagnostic shape used in
		// the success-but-empty path above.
		const e = err instanceof Error ? err : new Error(String(err));
		const stackHead = (e.stack ?? "").split("\n").slice(0, 3).join(" | ");
		const reason =
			`Empty response from model (provider=${model.provider}, ` +
			`model=${model.model}, error=${e.name}: ${e.message}` +
			(stackHead ? ` stack=${stackHead}` : "") +
			`). Last chunk: ${(
				chatModelChunks[chatModelChunks.length - 1]
					? JSON.stringify(chatModelChunks[chatModelChunks.length - 1])
					: "(no on_chat_model_stream events)"
			).slice(0, 1024)}`;
		sink.error(reason);
		return {
			text: "",
			document: holder.current,
			mutated: JSON.stringify(holder.current) !== initialDocumentJSON,
			reason,
		};
	}
}

function extractError(data: Record<string, unknown> | undefined): string | undefined {
	if (!data) return undefined;
	const error = data.error;
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	return undefined;
}

// ponytail: re-exported for the agent-facing surface, but be honest about who
// uses it — no production code calls it. Its only real consumers are the
// workbench (`lib/wire.ts`, `lib/oracles.ts`), which import it straight from
// agent-tools anyway, and the tests. It is kept because the mutating/non-mutating
// split is a property of the agent surface, and this module is that surface.
export { isMutatingTool };
