// In-memory chat service. ponytail: no SQLite, no LangGraph, no checkpoints
// for Phase 6 scaffolding. Stores messages per project in a Map. The actual
// LLM call goes through `llm-call.ts` (no LangChain dep — direct fetch to
// the provider's /chat/completions endpoint).
//
// Phase 8 upgrades this to SQLite-backed sessions with checkpoint restore.

import { v4 as uuidv4 } from "uuid";
import type { AiEditionChatMessage, AiEditionChatResult } from "../../src/native/contracts";
import { type ChatMessage, callLlm } from "./llm-call";
import type { LlmConfigStore } from "./llm-config-store";
import { PROVIDER_DEFINITIONS } from "./provider-registry";

const messagesByProject = new Map<string, AiEditionChatMessage[]>();

const SYSTEM_PROMPT =
	"You are an AI video editor. The user is editing a recording in OpenScreen. " +
	"Help them cut silences, tighten pacing, add captions, and rewrite titles. " +
	"Be concise, action-oriented, and reference the timeline or transcript by time when relevant.";

export async function runChat(
	projectId: string,
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

	const history = messagesByProject.get(projectId) ?? [];
	const userMessage: AiEditionChatMessage = {
		id: uuidv4(),
		role: "user",
		content: message,
		createdAt: new Date().toISOString(),
	};
	history.push(userMessage);
	messagesByProject.set(projectId, history);

	const llmMessages: ChatMessage[] = [
		{ role: "system", content: SYSTEM_PROMPT },
		...history.slice(-20).map((m) => ({ role: m.role, content: m.content })),
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
	history.push(assistantMessage);
	messagesByProject.set(projectId, history);

	return {
		success: true,
		assistantMessage,
	};
}

export async function getChatHistory(projectId: string): Promise<AiEditionChatMessage[]> {
	return messagesByProject.get(projectId) ?? [];
}

export function clearChatHistory(projectId: string): void {
	messagesByProject.delete(projectId);
}
