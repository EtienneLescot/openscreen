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

const addSkipArgs = z.object({
	startSec: secondsSchema,
	endSec: secondsSchema,
	assetId: z.string().min(1).optional(),
	reason: z.string().default(""),
});

const setSkipRangeArgs = z.object({
	skipRangeId: z.string().min(1),
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

const SYSTEM_PROMPT = [
	"You are an AI video editor working inside OpenScreen. The user is editing a recording.",
	"Help them cut silences, tighten pacing, add captions, and rewrite titles.",
	"Be concise, action-oriented, and reference the timeline or transcript by time when relevant.",
	"You can call the tools below against the live document snapshot; the runtime executes each edit and feeds the result back into the loop.",
].join(" ");

const TOOL_DESCRIPTIONS: Record<string, string> = {
	getCurrentDocument:
		"Read a compact snapshot of the current project: assets (with durations), timeline clips, skip ranges, and counts of annotations/zoom regions. Call this before editing if the snapshot in the system prompt may be stale.",
	getTranscript:
		"Read the transcript segments (speech and silence, with start/end seconds and text) for an asset. Omit assetId to read the primary asset's transcript.",
	addSkip:
		"Add a skip range (a cut — this source-time span will not be played or exported). Times are in seconds of the asset's source time.",
	setSkipRange: "Move or resize an existing skip range by id. Times are source-time seconds.",
	setClipRange:
		"Trim a clip: set its source in/out points (seconds). All clips are re-laid back-to-back afterwards, so downstream clips shift automatically.",
	replaceTimeline:
		"Replace the whole timeline with the given kept intervals of the primary asset's source time. Everything outside the intervals becomes a skip. Use for bulk edits like 'cut all silences'.",
};

// ponytail: mutable document holder so a write-tool that updates the snapshot
// is observed by the NEXT tool call inside the same agent turn. LangChain's
// `tool()` factory captures the document by reference via the holder, so
// each tool sees the latest mutated snapshot.
type DocumentHolder = { current: AxcutDocument };

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
		tool(
			async (args: z.infer<typeof addSkipArgs>) => {
				sink.toolStart("addSkip", args);
				const execution = executeAgentTool(holder.current, "addSkip", JSON.stringify(args));
				if (execution.document) {
					holder.current = execution.document;
					sink.toolEnd("addSkip", execution.ok, execution.summary);
				} else {
					sink.toolEnd("addSkip", execution.ok, execution.summary);
				}
				return execution.resultJson;
			},
			{
				name: "addSkip",
				description: TOOL_DESCRIPTIONS.addSkip,
				schema: addSkipArgs,
			},
		),
		tool(
			async (args: z.infer<typeof setSkipRangeArgs>) => {
				sink.toolStart("setSkipRange", args);
				const execution = executeAgentTool(holder.current, "setSkipRange", JSON.stringify(args));
				if (execution.document) {
					holder.current = execution.document;
					sink.toolEnd("setSkipRange", execution.ok, execution.summary);
				} else {
					sink.toolEnd("setSkipRange", execution.ok, execution.summary);
				}
				return execution.resultJson;
			},
			{
				name: "setSkipRange",
				description: TOOL_DESCRIPTIONS.setSkipRange,
				schema: setSkipRangeArgs,
			},
		),
		tool(
			async (args: z.infer<typeof setClipRangeArgs>) => {
				sink.toolStart("setClipRange", args);
				const execution = executeAgentTool(holder.current, "setClipRange", JSON.stringify(args));
				if (execution.document) {
					holder.current = execution.document;
					sink.toolEnd("setClipRange", execution.ok, execution.summary);
				} else {
					sink.toolEnd("setClipRange", execution.ok, execution.summary);
				}
				return execution.resultJson;
			},
			{
				name: "setClipRange",
				description: TOOL_DESCRIPTIONS.setClipRange,
				schema: setClipRangeArgs,
			},
		),
		tool(
			async (args: z.infer<typeof replaceTimelineArgs>) => {
				sink.toolStart("replaceTimeline", args);
				const execution = executeAgentTool(holder.current, "replaceTimeline", JSON.stringify(args));
				if (execution.document) {
					holder.current = execution.document;
					sink.toolEnd("replaceTimeline", execution.ok, execution.summary);
				} else {
					sink.toolEnd("replaceTimeline", execution.ok, execution.summary);
				}
				return execution.resultJson;
			},
			{
				name: "replaceTimeline",
				description: TOOL_DESCRIPTIONS.replaceTimeline,
				schema: replaceTimelineArgs,
			},
		),
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

		for await (const event of stream) {
			const eventType = typeof event.event === "string" ? event.event : "";
			const data = event.data as Record<string, unknown> | undefined;
			const name = typeof event.name === "string" ? (event.name as string) : "";

			if (eventType === "on_chat_model_stream") {
				const chunk = data?.chunk as Record<string, unknown> | undefined;
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
			}
		}

		const mutated = JSON.stringify(holder.current) !== initialDocumentJSON;
		if (!finalText.trim()) {
			sink.error("Empty response from model.");
			return { text: "", document: holder.current, mutated };
		}
		return { text: finalText.trim(), document: holder.current, mutated };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		sink.error(message);
		return {
			text: "",
			document: holder.current,
			mutated: JSON.stringify(holder.current) !== initialDocumentJSON,
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
