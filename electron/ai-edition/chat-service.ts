// In-memory chat service. ponytail: chat sessions live in a nested Map; the
// agentic loop itself lives in `deep-agent/service.ts` and is a port of
// axcut's AxcutDeepAgentService (LangGraph stateful thread via
// `createDeepAgent`). The IPC bridge streams `text` deltas + `toolStart` /
// `toolEnd` lifecycle + `error` events into the renderer through the
// ChatEventSink.

import { randomUUID } from "node:crypto";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import {
	type AxcutTimelineOperation,
	applyTimelineOperation,
} from "../../src/lib/ai-edition/document/operations";
import {
	type AxcutDocument,
	createEmptyDocument,
	documentSchema,
} from "../../src/lib/ai-edition/schema";
import type {
	AiEditionChatMessage,
	AiEditionChatResult,
	AiEditionToolCallSummary,
} from "../../src/native/contracts";
import {
	applyCompaction,
	budgetSnapshot,
	buildCompactionPrompt,
	COMPACTION_SYSTEM_PROMPT,
	DEFAULT_BUDGET_TOKENS,
	shouldCompact,
} from "./chat-compaction";
import type { CursorTelemetryReader } from "./deep-agent/service";
import type { DocumentService } from "./document-service";
import type { LlmConfigStore } from "./llm-config-store";
import { PROVIDER_DEFINITIONS } from "./provider-registry";

const sessionsByProject = new Map<string, Map<string, ChatSession>>();

// ponytail: per-message checkpoints, stored as an ordered list per session
// (insertion order == the session's message order). Each entry captures the
// document *right before* the agent runs that user message — same restore
// semantics as axcut's per-user-message checkpoint. The renderer surfaces a
// ↩ button on every user message that has a checkpoint.
interface MessageCheckpoint {
	userMessageId: string;
	document: AxcutDocument;
	createdAt: string;
}
const messageCheckpointsBySession = new Map<string, MessageCheckpoint[]>();

function sessionKey(projectId: string, sessionId: string): string {
	return `${projectId}::${sessionId}`;
}

function checkpointsForSession(projectId: string, sessionId: string): MessageCheckpoint[] {
	return messageCheckpointsBySession.get(sessionKey(projectId, sessionId)) ?? [];
}

function recordMessageCheckpoint(
	projectId: string,
	sessionId: string,
	userMessageId: string,
	document: AxcutDocument,
): void {
	const key = sessionKey(projectId, sessionId);
	const list = messageCheckpointsBySession.get(key) ?? [];
	list.push({
		userMessageId,
		document,
		createdAt: new Date().toISOString(),
	});
	messageCheckpointsBySession.set(key, list);
}

function findCheckpointForMessage(
	projectId: string,
	sessionId: string,
	userMessageId: string,
): MessageCheckpoint | null {
	return (
		checkpointsForSession(projectId, sessionId).find((c) => c.userMessageId === userMessageId) ??
		null
	);
}

// ponytail: drop every checkpoint at or after the given user message id.
// Called after a rewind truncates the message list, so future checkpoints
// stay aligned with the surviving messages. We compare against the
// session's current message order; if the target message is gone we drop
// all checkpoints created after the surviving tail.
function dropCheckpointsFrom(
	projectId: string,
	sessionId: string,
	fromUserMessageId: string,
): void {
	const key = sessionKey(projectId, sessionId);
	const list = messageCheckpointsBySession.get(key);
	if (!list) return;
	const session = sessionsByProject.get(projectId)?.get(sessionId);
	const surviving = session?.messages.find((m) => m.id === fromUserMessageId);
	const cutIndex = surviving ? list.findIndex((c) => c.userMessageId === fromUserMessageId) : -1;
	if (cutIndex === -1) {
		// ponytail: target message vanished (e.g. already rewound past it).
		// Drop the entire session's checkpoints — they all reference a
		// lineage that's no longer valid.
		messageCheckpointsBySession.delete(key);
		return;
	}
	messageCheckpointsBySession.set(
		key,
		list.filter((_c, i) => i < cutIndex),
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
	const id = `sess_${randomUUID()}`;
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

export interface ChatEventSink {
	/** Streamed text delta from the model. */
	text?: (delta: string) => void;
	/** Streamed delta from the model's reasoning block (Anthropic/MiniMax
	 * thinking). Provider-agnostic — never called for providers that don't
	 * expose thinking. The chat panel streams these into a live "Thinking…"
	 * block so the reasoning phase doesn't feel like dead air. */
	thinking?: (delta: string) => void;
	/** A tool call is about to execute. */
	toolStart?: (name: string, args: unknown) => void;
	/** A tool call has finished. `ok=false` carries the model's error message. */
	toolEnd?: (name: string, ok: boolean, summary?: string) => void;
	/** The agent loop hit a fatal error (provider 4xx, network, parse). */
	error?: (message: string) => void;
}

export interface ChatRunEnv {
	/** Reads recorded cursor telemetry for an asset. Built in `electron/ipc/
	 *  handlers.ts`, where the path allow-list lives. */
	cursor?: CursorTelemetryReader;
}

// ponytail: zero-config noop for sink callbacks that the caller did not provide.
const noop = () => undefined;

/** ponytail: zero-config sink that swallows every event. */
const NOOP_SINK: Required<ChatEventSink> = {
	text: noop,
	thinking: noop,
	toolStart: noop,
	toolEnd: noop,
	error: noop,
};

export async function runChat(
	projectId: string,
	sessionId: string,
	message: string,
	llmConfig: LlmConfigStore,
	documentInput?: unknown,
	sink: ChatEventSink = {},
	/** Runtime capabilities the pure chat path cannot build for itself. Optional
	 *  and last so the three existing call sites are unchanged — but note that a
	 *  production caller which forgets to pass `cursor` gets an agent that answers
	 *  "I could not look" every time, which is honest and unhelpful. */
	env: ChatRunEnv = {},
): Promise<AiEditionChatResult> {
	const emit: Required<ChatEventSink> = { ...NOOP_SINK, ...sink };
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

	const credential = llmConfig.getCredential(def.id, def.envKeys);
	const apiKey = credential?.value ?? null;
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
		id: randomUUID(),
		role: "user",
		content: message,
		createdAt: new Date().toISOString(),
	};

	// ponytail: snapshot the document *right before* this user message
	// triggers a turn — same restore semantics as axcut's per-message
	// checkpoint. We hold a stable `workingDocument` ref so this snapshot
	// reflects what the user saw when they hit Send.
	const documentForCheckpoint: AxcutDocument | null = workingDocument
		? structuredClone(workingDocument)
		: null;
	if (documentForCheckpoint) {
		recordMessageCheckpoint(projectId, sessionId, userMessage.id, documentForCheckpoint);
	}
	userMessage.checkpointId = documentForCheckpoint ? userMessage.id : null;

	session.messages.push(userMessage);

	const editsAllowed = config.allowAgentEdits !== false;

	// P3.7 — context compaction: when the session grows past the heuristic
	// budget, summarize the older half into a single "Earlier context"
	// assistant message. The current user turn stays uncompacted, so the
	// model still sees the request verbatim.
	const decision = shouldCompact(session.messages);
	if (decision && decision.compact) {
		await tryCompactSession({
			session,
			splitIndex: decision.splitIndex,
			apiKey: apiKey ?? "",
			provider: config.provider,
			model: config.model,
			baseUrl: config.baseUrl,
			reasoningEffort: config.reasoningEffort,
		});
	}

	const history = session.messages
		.slice(-20)
		.map((m) => ({ role: m.role as "user" | "assistant" | "system", content: m.content }));

	const appliedToolCalls: AiEditionToolCallSummary[] = [];

	const agentSink = {
		text: (delta: string) => emit.text(delta),
		thinking: (delta: string) => emit.thinking(delta),
		toolStart: (name: string, args: unknown) => {
			emit.toolStart(name, args);
		},
		toolEnd: (name: string, ok: boolean, summary?: string) => {
			emit.toolEnd(name, ok, summary);
			if (ok && summary) {
				appliedToolCalls.push({ name, summary });
			}
		},
		error: (message: string) => emit.error(message),
	};

	const { invokeOpenScreenAgent } = await import("./deep-agent/service");

	const result = await invokeOpenScreenAgent({
		document: workingDocument ?? emptyDocumentForTextOnly(projectId),
		model: {
			provider: config.provider,
			model: config.model,
			apiKey: apiKey ?? undefined,
			baseUrl: config.baseUrl,
			reasoningEffort: config.reasoningEffort,
		},
		history,
		userMessage: message,
		sink: agentSink,
		editsAllowed,
		cursor: env.cursor,
	});

	if (!result.text) {
		// ponytail: surface the deep-agent's diagnostic so the user can see
		// *why* the model produced no text (e.g. MiniMax streaming only
		// thinking blocks, or a non-text content shape that our extractor
		// missed). Falls back to the generic message when the agent didn't
		// provide a reason.
		return {
			success: false,
			error: result.reason ?? "Empty response from model.",
		};
	}

	const assistantMessage: AiEditionChatMessage = {
		id: randomUUID(),
		role: "assistant",
		content: result.text,
		createdAt: new Date().toISOString(),
		toolCalls: appliedToolCalls.length ? appliedToolCalls : undefined,
	};
	session.messages.push(assistantMessage);

	return {
		success: true,
		assistantMessage,
		// ponytail: belt and braces on `editsAllowed`. This returned document is
		// the ONLY path to disk (LeftPanel → applyAgentDocument → saveDocument),
		// so it is where a write that somehow escaped the executor's guard would
		// still land. Cheap, and it makes the setting's guarantee structural
		// rather than dependent on one predicate holding everywhere.
		document: result.mutated && editsAllowed ? result.document : undefined,
		toolCalls: appliedToolCalls.length ? appliedToolCalls : undefined,
		userMessageCheckpointId: userMessage.checkpointId ?? undefined,
	};
}

// ponytail: port of axcut's AxcutAgentRuntime.rewindToMessage. Restores the
// document snapshot taken right before the given user message, truncates the
// session's message list (exclusive of the rewound message), drops every
// checkpoint at or after that message id, and returns the rewound message
// content so the renderer can put it back in the composer.
//
// The renderer is responsible for applying the returned document — that
// mirrors axcut's exact "the assistant rewrites itself" flow, including
// the same projectId's local files going back to that state (we hit
// DocumentService in the IPC handler).
export function rewindToMessage(
	projectId: string,
	sessionId: string,
	messageId: string,
):
	| { success: true; prompt: string; document: AxcutDocument; messages: AiEditionChatMessage[] }
	| {
			success: false;
			error: string;
	  } {
	const session = sessionsByProject.get(projectId)?.get(sessionId);
	if (!session) return { success: false, error: "Chat session not found." };
	const messageIndex = session.messages.findIndex((m) => m.id === messageId);
	if (messageIndex === -1) {
		return { success: false, error: "Message not found in this session." };
	}
	const target = session.messages[messageIndex];
	if (target.role !== "user") {
		return { success: false, error: "Rewind must target a user message." };
	}
	if (!target.checkpointId) {
		return { success: false, error: "No checkpoint stored for this message." };
	}
	const cp = findCheckpointForMessage(projectId, sessionId, target.checkpointId);
	if (!cp) {
		return {
			success: false,
			error: "Checkpoint expired — start a fresh chat to recover state.",
		};
	}

	const survived = session.messages.slice(0, messageIndex + 1).map((m) => ({
		...m,
		toolCalls: m.toolCalls ? [...m.toolCalls] : undefined,
	}));
	session.messages = survived;
	dropCheckpointsFrom(projectId, sessionId, target.checkpointId);

	return {
		success: true,
		prompt: target.content,
		document: cp.document,
		messages: [...survived],
	};
}

// ponytail: renderer-initiated timeline operation. Reads the doc from disk,
// applies `op`, saves the result, and records a chat assistant message that
// summarises the change so the conversation history reflects the manual
// edit (axcut's `applyOperation` does the same).
//
// The renderer applies an optimistic copy to its local store before calling
// this; if the call fails we roll back to the previous document by re-reading
// the saved state, so the cache and disk stay aligned.
export interface TimelineOperationResult {
	document: AxcutDocument;
	summary: string;
}

export async function runTimelineOperation(
	projectId: string,
	sessionId: string,
	op: AxcutTimelineOperation,
	conversationMessage: string,
	documents: DocumentService,
): Promise<{ success: true; result: TimelineOperationResult } | { success: false; error: string }> {
	let session = sessionsByProject.get(projectId)?.get(sessionId);
	const created = !session;
	if (created) {
		const summary = createSession(projectId);
		session = selectSession(projectId, summary.id) ?? undefined;
		if (!session) return { success: false, error: "Could not create session." };
	}

	let current: AxcutDocument;
	try {
		current = await documents.getProject(projectId);
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}

	const applied = applyTimelineOperation(current, op);

	let saved: AxcutDocument;
	try {
		saved = await documents.saveProject(applied.document);
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}

	if (conversationMessage.trim() && session) {
		const assistantMessage: AiEditionChatMessage = {
			id: `msg_${randomUUID()}`,
			role: "assistant",
			content: conversationMessage.trim(),
			createdAt: new Date().toISOString(),
		};
		session.messages.push(assistantMessage);
	}

	return {
		success: true,
		result: {
			document: saved,
			summary: applied.summary,
		},
	};
}

// ponytail: port of axcut's compactSession — manual compaction from a button
// press. Returns the latest session snapshot + the inserted summary message
// id, so the renderer can highlight it.
export async function compactSessionNow(
	projectId: string,
	sessionId: string,
	llmConfig: LlmConfigStore,
): Promise<{ summaryMessageId: string | null; summary: string; session: ChatSession } | null> {
	const session = sessionsByProject.get(projectId)?.get(sessionId);
	if (!session) return null;
	const config = llmConfig.getConfig();
	if (!config) return null;
	const def = PROVIDER_DEFINITIONS.find((d) => d.id === config.provider);
	if (!def) return null;
	const credential = llmConfig.getCredential(def.id, def.envKeys);
	const apiKey = credential?.value ?? "";

	const decision = shouldCompact(session.messages);
	if (!decision || !decision.compact) return null;

	const ok = await tryCompactSession({
		session,
		splitIndex: decision.splitIndex,
		apiKey,
		provider: config.provider,
		model: config.model,
		baseUrl: config.baseUrl,
		reasoningEffort: config.reasoningEffort,
	});
	if (!ok) return null;
	return {
		summaryMessageId: ok.summaryMessageId,
		summary: ok.summary,
		session: selectSession(projectId, sessionId) as ChatSession,
	};
}

// ponytail: port of axcut's getContextUsage. Returns the current session's
// token estimate + window budget so the renderer can fill the "% context"
// pill with real numbers (no probe — char-based heuristic matching the
// in-call compaction one).
export function getSessionContextUsage(
	projectId: string,
	sessionId: string,
	budgetTokens: number = DEFAULT_BUDGET_TOKENS,
): { usedTokens: number; budgetTokens: number; ratio: number; fillPercent: number } | null {
	const session = sessionsByProject.get(projectId)?.get(sessionId);
	if (!session) return null;
	const snap = budgetSnapshot(session.messages, budgetTokens);
	const fillPercent = Math.min(100, Math.round(snap.ratio * 100));
	return {
		usedTokens: snap.usedTokens,
		budgetTokens: snap.budgetTokens,
		ratio: snap.ratio,
		fillPercent,
	};
}

// ponytail: when no document snapshot exists the agent has no edit surface.
// We still hand it an empty (schema-valid) document so the LangGraph thread
// can run, and the model simply won't call write tools against it.
function emptyDocumentForTextOnly(projectId: string): AxcutDocument {
	return createEmptyDocument({ title: "Untitled project", projectId });
}

// --- Compaction (P3.7) ---------------------------------------------------

export interface SessionBudgetSnapshot {
	usedTokens: number;
	budgetTokens: number;
	ratio: number;
	fillPercent: number;
}

export function getSessionBudget(
	projectId: string,
	sessionId: string,
	budgetTokens: number = DEFAULT_BUDGET_TOKENS,
): SessionBudgetSnapshot | null {
	const s = sessionsByProject.get(projectId)?.get(sessionId);
	if (!s) return null;
	const snap = budgetSnapshot(s.messages, budgetTokens);
	return {
		usedTokens: snap.usedTokens,
		budgetTokens: snap.budgetTokens,
		ratio: snap.ratio,
		fillPercent: Math.min(100, Math.round(snap.ratio * 100)),
	};
}

/**
 * Force a compaction on the given session. Returns the inserted "Earlier
 * context" message id, or `null` if there isn't enough history yet.
 */
export async function compactSession(
	projectId: string,
	sessionId: string,
	llmConfig: LlmConfigStore,
): Promise<{ summaryMessageId: string | null; summary: string } | null> {
	const session = sessionsByProject.get(projectId)?.get(sessionId);
	if (!session) return null;
	const config = llmConfig.getConfig();
	if (!config) return null;
	const def = PROVIDER_DEFINITIONS.find((d) => d.id === config.provider);
	const credential = def ? llmConfig.getCredential(def.id, def.envKeys) : null;
	const apiKey = credential?.value ?? "";

	const decision = shouldCompact(session.messages);
	if (!decision) return { summaryMessageId: null, summary: "" };

	const ok = await tryCompactSession({
		session,
		splitIndex: decision.splitIndex,
		apiKey,
		provider: config.provider,
		model: config.model,
		baseUrl: config.baseUrl,
		reasoningEffort: config.reasoningEffort,
	});
	return ok;
}

async function tryCompactSession(opts: {
	session: ChatSession;
	splitIndex: number;
	apiKey: string;
	provider: string;
	model: string;
	baseUrl?: string;
	reasoningEffort?: string;
}): Promise<{ summaryMessageId: string | null; summary: string } | null> {
	const { session, splitIndex, apiKey, provider, model, baseUrl, reasoningEffort } = opts;
	const oldMessages = session.messages.slice(0, splitIndex);
	if (oldMessages.length === 0) return null;

	const prompt = buildCompactionPrompt(oldMessages);
	let summary = "";
	try {
		const { createOpenScreenChatModel, messageContentToText } = await import(
			"./deep-agent/chat-model"
		);
		const chatModel = await createOpenScreenChatModel({
			provider,
			model,
			apiKey,
			baseUrl,
			reasoningEffort,
		});
		const result = await chatModel.invoke([
			new SystemMessage(COMPACTION_SYSTEM_PROMPT),
			new HumanMessage(prompt),
		]);
		summary = messageContentToText(result.content);
		if (!summary) {
			return null;
		}
	} catch {
		// ponytail: a failed summarize must not break the chat turn — leave
		// the session as-is and let the next turn try again.
		return null;
	}

	const compacted = applyCompaction(
		session.messages,
		splitIndex,
		summary,
		new Date().toISOString(),
	);
	const inserted = compacted[0];
	session.messages = compacted;
	return {
		summaryMessageId: inserted?.id ?? null,
		summary,
	};
}
