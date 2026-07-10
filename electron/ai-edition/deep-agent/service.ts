// ponytail: port of axcut's AxcutDeepAgentService (apps/server/src/services/
// axcut-deep-agent.ts). Wraps `createDeepAgent` from the `deepagents` package
// (LangGraph stateful thread) with our existing document tools and emits
// agent.text / agent.toolStart / agent.toolEnd / agent.error events into a
// sink the chat-service pipes through `webContents.send`.

import { tool } from "langchain";
import { z } from "zod";
import type { AxcutDocument } from "../../../src/lib/ai-edition/schema";
import { documentSnapshotForModel, executeAgentTool, isMutatingTool } from "../agent-tools";
import { createOpenScreenChatModel, type OpenScreenChatModelConfig } from "./chat-model";

export interface OpenScreenAgentSink {
	text: (delta: string) => void;
	toolStart: (name: string, args: unknown) => void;
	toolEnd: (name: string, ok: boolean, summary?: string) => void;
	error: (message: string) => void;
}

// ponytail: minimal-effort zod schemas for each of our agent tools. We had
// JSON-schema specs in agent-tools.ts; here we use Zod because LangChain's
// `tool()` factory wants Zod (one-line in axcut, one-line here). The
// executor below still re-validates via executeAgentTool, so the JSON schema
// stays the source of truth for the UI's "applied: ..." chip.
const secondsSchema = z.number().finite().nonnegative();

const addTrimArgs = z.object({
	startSec: secondsSchema,
	endSec: secondsSchema,
	assetId: z.string().min(1).optional(),
	reason: z.string().default(""),
});

const setTrimArgs = z.object({
	trimRangeId: z.string().min(1),
	startSec: secondsSchema,
	endSec: secondsSchema,
});

const setClipRangeArgs = z.object({
	clipId: z.string().min(1),
	sourceStartSec: secondsSchema,
	sourceEndSec: secondsSchema,
});

const replaceTimelineArgs = z.object({
	intervals: z
		.array(
			z.object({
				startSec: secondsSchema,
				endSec: secondsSchema,
			}),
		)
		.min(1),
	reason: z.string().default(""),
});

// Effects (zoom / speed / annotation) — authored in virtual (edited-timeline)
// seconds, mirroring the JSON-schema specs in agent-tools.ts.
const depthSchema = z.number().int().min(1).max(6);
const focusSchema = z.object({ cx: z.number().min(0).max(1), cy: z.number().min(0).max(1) });

const addZoomArgs = z.object({
	startSec: secondsSchema,
	endSec: secondsSchema,
	depth: depthSchema.default(3),
	focus: focusSchema.default({ cx: 0.5, cy: 0.5 }),
});

const setZoomArgs = z.object({
	zoomId: z.string().min(1),
	startSec: secondsSchema.optional(),
	endSec: secondsSchema.optional(),
	depth: depthSchema.optional(),
	focus: focusSchema.optional(),
});

const addSpeedArgs = z.object({
	startSec: secondsSchema,
	endSec: secondsSchema,
	speed: z.number().positive().default(1.5),
});

const setSpeedArgs = z.object({
	speedId: z.string().min(1),
	startSec: secondsSchema.optional(),
	endSec: secondsSchema.optional(),
	speed: z.number().positive().optional(),
});

const addAnnotationArgs = z.object({
	startSec: secondsSchema,
	endSec: secondsSchema,
	text: z.string().default(""),
	x: z.number().min(0).max(100).default(50),
	y: z.number().min(0).max(100).default(50),
});

const setAnnotationArgs = z.object({
	annotationId: z.string().min(1),
	startSec: secondsSchema.optional(),
	endSec: secondsSchema.optional(),
	text: z.string().optional(),
});

const SYSTEM_PROMPT = [
	"You are an AI video editor working inside OpenScreen. The user is editing a recording.",
	"Help them cut silences, tighten pacing, add captions, and rewrite titles.",
	"Be concise, action-oriented, and reference the timeline or transcript by time when relevant.",
	"You can call the tools below against the live document snapshot; the runtime executes each edit and feeds the result back into the loop.",
	"The AxcutDocument is the single source of truth. The timeline, the transcript editor, and the chat panel are all direct editors of the same document — when the user places a clip on the timeline, the document updates immediately, and when the timeline is empty, the document has no clips. Your edits operate on the live document, so preserve the user's placed clips.",
	"",
	"Time-bases (do not mix them up): clips and trims are in SOURCE-time seconds of an asset; zooms, speed regions and annotations are in VIRTUAL (edited-timeline) seconds — the position on the ruler after clips + trims are applied. getCurrentDocument returns both, clearly labelled.",
	"",
	"Tool-selection rules (these are non-negotiable):",
	"- 'remove silences' / 'cut pauses' / 'cut the silence' / 'kill the silence' / 'tighten pacing': call addTrim ONCE PER SILENT RANGE. Do NOT call setClipRange, do NOT call replaceTimeline. The placed clip is the canonical cut, the silence becomes a trim inside it.",
	"- 'trim this clip to 0-30' / 'cut the end of this clip' / 'shorten this clip': call setClipRange with the new sourceStartSec/sourceEndSec (this is the clip's in/out, distinct from a trim).",
	"- 'zoom in on …' / smart zooms: call addZoom over the virtual-timeline span (depth 1–6, focus in 0–1 frame fractions). 'speed through …': addSpeed. 'add a caption/label': addAnnotation.",
	"- 'replace the timeline' / 'rebuild the timeline' / 'start over with these intervals': call replaceTimeline. Only when the user explicitly asks for a full rebuild.",
	"Anything else (move a clip, resize a trim, restyle a zoom, change a clip's order, etc.) — pick the most specific tool. If the request is ambiguous, prefer the smallest edit that satisfies it.",
].join("\n");

const TOOL_DESCRIPTIONS: Record<string, string> = {
	getCurrentDocument:
		"Read a compact snapshot of the current project: assets (with durations), timeline clips and trim ranges (source-time), and the zoom / speed / annotation effects (virtual, edited-timeline time). Call this before editing if the snapshot in the system prompt may be stale. The AxcutDocument is the single source of truth — your edits should preserve the user's placed clips and any timeline state they have already set up.",
	getTranscript:
		"Read the transcript segments (speech and silence, with start/end seconds and text) for an asset. Omit assetId to read the primary asset's transcript.",
	addTrim:
		"Add a trim range: a cut of a span inside a clip (this source-time span will not be played or exported) that does NOT split the clip. Times are in seconds of the asset's source time. This is the preferred (and for 'remove silences' requests, the only) way to handle silences; it preserves the user's placed clips and only adds a cut. Call this once per silent range.",
	setTrim: "Move or resize an existing trim range by id. Times are source-time seconds.",
	setClipRange:
		"Set a clip's in/out points (source-time seconds) to shorten its head or tail — distinct from a trim (which cuts a span inside the clip). All clips are re-laid back-to-back afterwards, so downstream clips shift automatically. Use this ONLY when the user explicitly asks to shorten or extend a user-placed clip. Do NOT use this for 'remove silences' or 'cut pauses' — for those, use addTrim.",
	replaceTimeline:
		"Replace the whole timeline with the given kept intervals of the primary asset's source time. Everything outside the intervals becomes a trim. DO NOT use this for 'cut silences' or 'remove pauses' — the user has likely placed clips on the timeline that you'd be discarding. Use this ONLY when the user explicitly asks you to rebuild the timeline from scratch (e.g. 'start over with the kept intervals from the transcript' or 'replace everything with these intervals').",
	addZoom:
		"Add a zoom-in over a span of the edited timeline (virtual seconds). depth 1–6 maps to 1.0×–3.5× (default 3). focus is the zoom centre in 0–1 fractions of the frame (default centre). Use for 'zoom in on …' and the smart-zoom pass.",
	setZoom:
		"Move, resize, or restyle an existing zoom by id (virtual-timeline seconds). Only the fields you pass are changed.",
	addSpeed:
		"Add a speed-change region over a span of the edited timeline (virtual seconds). speed > 1 fast-forwards, < 1 slows down (default 1.5×). Use to speed through slow stretches without cutting them.",
	setSpeed:
		"Move, resize, or change the multiplier of an existing speed region by id (virtual-timeline seconds). Only the fields you pass are changed.",
	addAnnotation:
		"Add a text annotation over a span of the edited timeline (virtual seconds). x/y are frame percentages (0–100, default centre). Use for callouts and labels.",
	setAnnotation:
		"Move, resize, or edit the text of an existing annotation by id (virtual-timeline seconds). Only the fields you pass are changed.",
};

// ponytail: mutable document holder so a write-tool that updates the snapshot
// is observed by the NEXT tool call inside the same agent turn. LangChain's
// `tool()` factory captures the document by reference via the holder, so
// each tool sees the latest mutated snapshot.
type DocumentHolder = { current: AxcutDocument };

// One mutating document tool: run it through the shared executor, advance the
// holder so the next tool in the turn sees the edit, and emit start/end chips.
// (All write tools share this exact flow — factored out so adding a tool is one
// line instead of a 20-line copy.)
function mutatingTool<S extends z.ZodType>(
	holder: DocumentHolder,
	sink: OpenScreenAgentSink,
	name: string,
	schema: S,
) {
	return tool(
		async (args: z.infer<S>) => {
			sink.toolStart(name, args);
			const execution = executeAgentTool(holder.current, name, JSON.stringify(args));
			if (execution.document) holder.current = execution.document;
			sink.toolEnd(name, execution.ok, execution.summary);
			return execution.resultJson;
		},
		{ name, description: TOOL_DESCRIPTIONS[name], schema },
	);
}

function buildTools(holder: DocumentHolder, sink: OpenScreenAgentSink) {
	return [
		tool(async () => JSON.stringify(documentSnapshotForModel(holder.current)), {
			name: "getCurrentDocument",
			description: TOOL_DESCRIPTIONS.getCurrentDocument,
			schema: z.object({}),
		}),
		tool(
			async (args: { assetId?: string }) => {
				const execution = executeAgentTool(holder.current, "getTranscript", JSON.stringify(args));
				return execution.resultJson;
			},
			{
				name: "getTranscript",
				description: TOOL_DESCRIPTIONS.getTranscript,
				schema: z.object({ assetId: z.string().min(1).optional() }),
			},
		),
		mutatingTool(holder, sink, "addTrim", addTrimArgs),
		mutatingTool(holder, sink, "setTrim", setTrimArgs),
		mutatingTool(holder, sink, "setClipRange", setClipRangeArgs),
		mutatingTool(holder, sink, "replaceTimeline", replaceTimelineArgs),
		mutatingTool(holder, sink, "addZoom", addZoomArgs),
		mutatingTool(holder, sink, "setZoom", setZoomArgs),
		mutatingTool(holder, sink, "addSpeed", addSpeedArgs),
		mutatingTool(holder, sink, "setSpeed", setSpeedArgs),
		mutatingTool(holder, sink, "addAnnotation", addAnnotationArgs),
		mutatingTool(holder, sink, "setAnnotation", setAnnotationArgs),
	];
}

export interface InvokeArgs {
	document: AxcutDocument;
	model: OpenScreenChatModelConfig;
	history: Array<{ role: "user" | "assistant" | "system"; content: string }>;
	userMessage: string;
	sink: OpenScreenAgentSink;
}

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

	const holder: DocumentHolder = { current: document };
	const initialDocumentJSON = JSON.stringify(document);

	// ponytail: build a fresh agent per turn (same pattern as axcut). The
	// runtime side-effects (langgraph thread, sandbox) are tied to the agent
	// instance — checkpoint-based stateful threads can land later by passing
	// a `checkpointer` to createDeepAgent; for v1 each turn is single-shot.
	const { createDeepAgent } = await import("deepagents");
	const chatModel = await createOpenScreenChatModel(model);
	const tools = buildTools(holder, sink);
	const agent = await createDeepAgent({
		model: chatModel,
		tools,
		systemPrompt: SYSTEM_PROMPT,
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
				const delta = extractDelta(content);
				if (delta) {
					sink.text(delta);
					finalText += delta;
				}
			} else if (eventType === "on_tool_start") {
				const input = data?.input;
				sink.toolStart(name, input ?? {});
			} else if (eventType === "on_tool_end") {
				sink.toolEnd(name, true);
			} else if (eventType === "on_tool_error") {
				sink.toolEnd(name, false, extractError(data));
			} else if (eventType) {
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
			// wire format, the parser, or our `extractDelta` shape. Capped at
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

function extractDelta(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		let total = "";
		for (const part of content) {
			if (typeof part === "string") {
				total += part;
			} else if (part && typeof part === "object") {
				const text = (part as { text?: unknown }).text;
				if (typeof text === "string") total += text;
			}
		}
		return total;
	}
	return "";
}

function extractError(data: Record<string, unknown> | undefined): string | undefined {
	if (!data) return undefined;
	const error = data.error;
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	return undefined;
}

// ponytail: keep `isMutatingTool` reachable via this module so future
// importers don't need to cross into agent-tools directly.
export { isMutatingTool };
