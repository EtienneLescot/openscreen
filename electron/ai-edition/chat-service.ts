// In-memory chat service. ponytail: no SQLite, no LangGraph, no checkpoints
// for Phase 6 scaffolding. Stores sessions per project in a nested Map. The
// actual LLM call goes through `llm-call.ts` (no LangChain dep — direct fetch
// to the provider's /chat/completions endpoint).
//
// Phase 8 upgrades this to SQLite-backed sessions with checkpoint restore.

import { v4 as uuidv4 } from "uuid";
import { type AxcutDocument, documentSchema } from "../../src/lib/ai-edition/schema";
import type {
	AiEditionChatMessage,
	AiEditionChatResult,
	AiEditionToolCallSummary,
} from "../../src/native/contracts";
import {
	AGENT_TOOL_SPECS,
	documentSnapshotForModel,
	executeAgentTool,
	isMutatingTool,
} from "./agent-tools";
import { type ChatMessage, callLlm } from "./llm-call";
import type { LlmConfigStore } from "./llm-config-store";
import { PROVIDER_DEFINITIONS } from "./provider-registry";

const sessionsByProject = new Map<string, Map<string, ChatSession>>();

// P1.3/P1.8 — pre-batch document snapshot per session, taken right before the
// first write tool of a chat turn runs. undoLastToolBatch() re-applies it.
const checkpointsBySession = new Map<string, { document: AxcutDocument; createdAt: string }>();

// P1.4 — the model may chain tools (getTranscript → replaceTimeline → …).
// Cap iterations so a confused model can't loop forever.
const MAX_TOOL_ITERATIONS = 8;

const SYSTEM_PROMPT =
	"You are an AI video editor. The user is editing a recording in OpenScreen. " +
	"Help them cut silences, tighten pacing, add captions, and rewrite titles. " +
	"Be concise, action-oriented, and reference the timeline or transcript by time when relevant.";

// P1.5 — tool-aware prompt: lists what the tools do and embeds a compact
// document snapshot the model can edit against without a read round-trip.
function buildToolSystemPrompt(document: AxcutDocument): string {
	return (
		`${SYSTEM_PROMPT}\n\n` +
		"You can edit the project directly with tools. Times are seconds in the asset's " +
		"source time. Read the transcript with getTranscript before cutting speech. " +
		"Prefer addSkip/setSkipRange for local cuts and replaceTimeline for bulk re-cuts. " +
		"After editing, tell the user in one or two sentences what you changed.\n\n" +
		`Current document snapshot:\n${JSON.stringify(documentSnapshotForModel(document))}`
	);
}

export interface ChatSession {
	id: string;
	projectId: string;
	title: string;
	createdAt: string;
	messages: AiEditionChatMessage[];
}

export interface ChatSessionSummary {
	id: string;
	projectId: string;
	title: string;
	createdAt: string;
	messageCount: number;
}

function toSummary(s: ChatSession): ChatSessionSummary {
	return {
		id: s.id,
		projectId: s.projectId,
		title: s.title,
		createdAt: s.createdAt,
		messageCount: s.messages.length,
	};
}

function getProjectSessions(projectId: string): Map<string, ChatSession> {
	let m = sessionsByProject.get(projectId);
	if (!m) {
		m = new Map();
		sessionsByProject.set(projectId, m);
	}
	return m;
}

function defaultSessionTitle(index: number): string {
	return `Conversation ${index}`;
}

export function listSessions(projectId: string): ChatSessionSummary[] {
	const m = sessionsByProject.get(projectId);
	if (!m) return [];
	return Array.from(m.values())
		.map(toSummary)
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function createSession(projectId: string, title?: string): ChatSessionSummary {
	const m = getProjectSessions(projectId);
	const id = `sess_${uuidv4()}`;
	const now = new Date().toISOString();
	const session: ChatSession = {
		id,
		projectId,
		title: title?.trim() || defaultSessionTitle(m.size + 1),
		createdAt: now,
		messages: [],
	};
	m.set(id, session);
	return toSummary(session);
}

export function selectSession(projectId: string, sessionId: string): ChatSession | null {
	const m = sessionsByProject.get(projectId);
	const s = m?.get(sessionId);
	if (!s) return null;
	// ponytail: shallow-copy messages so the caller can't mutate the live array.
	return { ...s, messages: [...s.messages] };
}

export function renameSession(
	projectId: string,
	sessionId: string,
	title: string,
): ChatSessionSummary | null {
	const m = sessionsByProject.get(projectId);
	const s = m?.get(sessionId);
	if (!s) return null;
	const trimmed = title.trim();
	if (trimmed) s.title = trimmed;
	return toSummary(s);
}

export function deleteSession(projectId: string, sessionId: string): boolean {
	const m = sessionsByProject.get(projectId);
	if (!m?.has(sessionId)) return false;
	m.delete(sessionId);
	return true;
}

function sessionKey(projectId: string, sessionId: string): string {
	return `${projectId}::${sessionId}`;
}

// P1.8 — return the pre-batch checkpoint document so the renderer can
// re-apply it. The checkpoint survives the undo (re-undo is idempotent).
export function undoLastToolBatch(projectId: string, sessionId: string): AiEditionChatResult {
	const checkpoint = checkpointsBySession.get(sessionKey(projectId, sessionId));
	if (!checkpoint) {
		return { success: false, error: "Nothing to undo — the agent has not edited this project." };
	}
	return { success: true, document: checkpoint.document };
}

export async function runChat(
	projectId: string,
	sessionId: string,
	message: string,
	llmConfig: LlmConfigStore,
	documentInput?: unknown,
): Promise<AiEditionChatResult> {
	const config = llmConfig.getConfig();
	if (!config) {
		return {
			success: false,
			error: "No LLM provider configured. Open Settings → AI to configure.",
		};
	}

	const def = PROVIDER_DEFINITIONS.find((d) => d.id === config.provider);
	if (!def) {
		return { success: false, error: `Unknown provider: ${config.provider}` };
	}

	const apiKey = llmConfig.getApiKey(def.id, def.envKeys);
	if (!apiKey && def.authKind === "api-key") {
		return {
			success: false,
			error: `No API key for ${def.label}. Add one in Settings → AI.`,
		};
	}

	const sessions = getProjectSessions(projectId);
	let session = sessions.get(sessionId);
	if (!session) {
		// ponytail: tolerate a stale/missing session id by recreating one. The
		// renderer should keep these in sync, but a missing session should
		// never break the chat run path.
		const summary = createSession(projectId, defaultSessionTitle(sessions.size + 1));
		session = sessions.get(summary.id);
	}
	if (!session) {
		return { success: false, error: "Chat session unavailable." };
	}

	// Tools only run against a valid document snapshot; a missing or invalid
	// snapshot degrades to text-only chat instead of failing the turn.
	let workingDocument: AxcutDocument | null = null;
	if (documentInput !== undefined && documentInput !== null) {
		const parsed = documentSchema.safeParse(documentInput);
		if (parsed.success) workingDocument = parsed.data;
	}

	const userMessage: AiEditionChatMessage = {
		id: uuidv4(),
		role: "user",
		content: message,
		createdAt: new Date().toISOString(),
	};
	session.messages.push(userMessage);

	const systemPrompt = workingDocument ? buildToolSystemPrompt(workingDocument) : SYSTEM_PROMPT;
	const loopMessages: ChatMessage[] = [
		{ role: "system", content: systemPrompt },
		...session.messages.slice(-20).map((m): ChatMessage => ({ role: m.role, content: m.content })),
	];

	// P2.5 — write tools are gated behind the allowAgentEdits flag. Undefined
	// means enabled (edits are checkpointed and undoable).
	const editsAllowed = config.allowAgentEdits !== false;

	const appliedToolCalls: AiEditionToolCallSummary[] = [];
	let documentChanged = false;
	let checkpointSaved = false;
	let finalContent = "";

	for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
		const result = await callLlm({
			provider: config.provider,
			model: config.model,
			apiKey: apiKey ?? "",
			baseUrl: config.baseUrl,
			reasoningEffort: config.reasoningEffort,
			messages: loopMessages,
			tools: workingDocument ? AGENT_TOOL_SPECS : undefined,
		});

		if (!result.success) {
			return { success: false, error: result.error ?? "Empty response from model." };
		}

		if (!result.toolCalls?.length) {
			finalContent = result.content ?? "";
			break;
		}

		loopMessages.push({
			role: "assistant",
			content: result.content ?? "",
			toolCalls: result.toolCalls,
		});

		for (const call of result.toolCalls) {
			if (!workingDocument) {
				loopMessages.push({
					role: "tool",
					toolCallId: call.id,
					content: JSON.stringify({ error: "No document available." }),
				});
				continue;
			}
			if (isMutatingTool(call.name) && !editsAllowed) {
				loopMessages.push({
					role: "tool",
					toolCallId: call.id,
					content: JSON.stringify({
						error:
							"Project edits are disabled in the AI settings. Ask the user to enable " +
							"'Allow the agent to edit the project', then try again.",
					}),
				});
				continue;
			}
			// P1.3 — checkpoint the pre-batch document before the first write.
			if (isMutatingTool(call.name) && !checkpointSaved) {
				checkpointsBySession.set(sessionKey(projectId, sessionId), {
					document: workingDocument,
					createdAt: new Date().toISOString(),
				});
				checkpointSaved = true;
			}
			const execution = executeAgentTool(workingDocument, call.name, call.arguments);
			if (execution.ok && execution.document) {
				workingDocument = execution.document;
				documentChanged = true;
				if (execution.summary) {
					appliedToolCalls.push({ name: call.name, summary: execution.summary });
				}
			}
			loopMessages.push({ role: "tool", toolCallId: call.id, content: execution.resultJson });
		}

		// The loop continues: the model sees the tool results and either chains
		// more tools or produces the final text answer.
		if (iteration === MAX_TOOL_ITERATIONS - 1) {
			finalContent =
				result.content ||
				"I hit the tool-call limit for one message. The edits so far have been applied.";
		}
	}

	if (!finalContent && appliedToolCalls.length === 0) {
		return { success: false, error: "Empty response from model." };
	}

	const assistantMessage: AiEditionChatMessage = {
		id: uuidv4(),
		role: "assistant",
		content: finalContent || "Done.",
		createdAt: new Date().toISOString(),
		toolCalls: appliedToolCalls.length ? appliedToolCalls : undefined,
	};
	session.messages.push(assistantMessage);

	return {
		success: true,
		assistantMessage,
		document: documentChanged && workingDocument ? workingDocument : undefined,
		toolCalls: appliedToolCalls.length ? appliedToolCalls : undefined,
	};
}

// ponytail: legacy single-session compatibility for the simpler ChatPanel
// consumers. Picks the most recent session (or auto-creates one) so a stale
// caller keeps working. The multi-session UI is the supported path.
function getOrCreateDefaultSession(projectId: string): ChatSession {
	const m = getProjectSessions(projectId);
	if (m.size > 0) {
		const arr = Array.from(m.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		return arr[0];
	}
	const created = createSession(projectId);
	const s = m.get(created.id);
	if (!s) throw new Error("Chat session unavailable.");
	return s;
}

export async function runChatDefault(
	projectId: string,
	message: string,
	llmConfig: LlmConfigStore,
): Promise<AiEditionChatResult> {
	const session = getOrCreateDefaultSession(projectId);
	return runChat(projectId, session.id, message, llmConfig);
}

export function getDefaultChatHistory(projectId: string): AiEditionChatMessage[] {
	const m = sessionsByProject.get(projectId);
	if (!m || m.size === 0) return [];
	const arr = Array.from(m.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	return [...arr[0].messages];
}

export function clearDefaultChatHistory(projectId: string): void {
	const m = sessionsByProject.get(projectId);
	if (!m) return;
	for (const s of m.values()) s.messages = [];
}
