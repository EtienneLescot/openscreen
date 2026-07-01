// In-memory chat service. ponytail: no SQLite, no LangGraph, no checkpoints
// for Phase 6 scaffolding. Stores sessions per project in a nested Map. The
// actual LLM call goes through `llm-call.ts` (no LangChain dep — direct fetch
// to the provider's /chat/completions endpoint).
//
// Phase 8 upgrades this to SQLite-backed sessions with checkpoint restore.

import { v4 as uuidv4 } from "uuid";
import type { AiEditionChatMessage, AiEditionChatResult } from "../../src/native/contracts";
import { type ChatMessage, callLlm } from "./llm-call";
import type { LlmConfigStore } from "./llm-config-store";
import { PROVIDER_DEFINITIONS } from "./provider-registry";

const sessionsByProject = new Map<string, Map<string, ChatSession>>();

const SYSTEM_PROMPT =
	"You are an AI video editor. The user is editing a recording in OpenScreen. " +
	"Help them cut silences, tighten pacing, add captions, and rewrite titles. " +
	"Be concise, action-oriented, and reference the timeline or transcript by time when relevant.";

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

export async function runChat(
	projectId: string,
	sessionId: string,
	message: string,
	llmConfig: LlmConfigStore,
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

	const userMessage: AiEditionChatMessage = {
		id: uuidv4(),
		role: "user",
		content: message,
		createdAt: new Date().toISOString(),
	};
	session.messages.push(userMessage);

	const llmMessages: ChatMessage[] = [
		{ role: "system", content: SYSTEM_PROMPT },
		...session.messages.slice(-20).map((m) => ({ role: m.role, content: m.content })),
	];

	const result = await callLlm({
		provider: config.provider,
		model: config.model,
		apiKey: apiKey ?? "",
		baseUrl: config.baseUrl,
		reasoningEffort: config.reasoningEffort,
		messages: llmMessages,
	});

	if (!result.success || !result.content) {
		return { success: false, error: result.error ?? "Empty response from model." };
	}

	const assistantMessage: AiEditionChatMessage = {
		id: uuidv4(),
		role: "assistant",
		content: result.content,
		createdAt: new Date().toISOString(),
	};
	session.messages.push(assistantMessage);

	return {
		success: true,
		assistantMessage,
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
