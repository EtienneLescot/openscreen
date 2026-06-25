// Real LLM call via fetch — no LangChain dependency. Supports the
// OpenAI-compatible `/chat/completions` endpoint (OpenAI, Mistral,
// OpenRouter, openai-compatible). Anthropic and OAuth providers stay
// stubbed for now and return a clear "not yet implemented" error.
//
// ponytail: keep this file small and dependency-free so it works in both
// Electron and the browser-mode shim. Streaming is not supported in this
// pass — the chat panel does request/response.

import { PROVIDER_DEFINITIONS, type ProviderDefinition } from "./provider-registry";

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface CallLlmOptions {
	provider: string;
	model: string;
	apiKey: string;
	baseUrl?: string;
	reasoningEffort?: string;
	messages: ChatMessage[];
}

export interface CallLlmResult {
	success: boolean;
	content?: string;
	error?: string;
}

const REASONING_BY_PROVIDER: Record<string, "low" | "medium" | "high"> = {
	low: "low",
	medium: "medium",
	high: "high",
};

function findProvider(id: string): ProviderDefinition | undefined {
	return PROVIDER_DEFINITIONS.find((p) => p.id === id);
}

function defaultBaseUrl(providerId: string): string {
	switch (providerId) {
		case "openai":
			return "https://api.openai.com/v1";
		case "anthropic":
			return "https://api.anthropic.com/v1";
		case "google":
			return "https://generativelanguage.googleapis.com/v1beta";
		case "mistral":
			return "https://api.mistral.ai/v1";
		case "openrouter":
			return "https://openrouter.ai/api/v1";
		default:
			return "https://api.openai.com/v1";
	}
}

export async function callLlm(opts: CallLlmOptions): Promise<CallLlmResult> {
	const def = findProvider(opts.provider);
	if (!def) {
		return { success: false, error: `Unknown provider: ${opts.provider}` };
	}
	if (!opts.apiKey && def.authKind === "api-key") {
		return { success: false, error: `Missing API key for ${def.label}` };
	}
	// OAuth + PAT providers are not yet wired. Return a clear error.
	if (def.authKind === "oauth-device") {
		return {
			success: false,
			error: `Provider "${def.label}" uses OAuth — device-flow is not implemented yet.`,
		};
	}
	if (def.authKind === "pat") {
		return {
			success: false,
			error: `Provider "${def.label}" uses a personal access token — wire it via env var.`,
		};
	}

	// Anthropic has its own /v1/messages endpoint with a different schema.
	// Wire it separately so the OpenAI-compatible path stays small.
	if (opts.provider === "anthropic") {
		return callAnthropic(opts);
	}

	const baseUrl = (opts.baseUrl || def.baseUrl || defaultBaseUrl(opts.provider)).replace(
		/\/+$/,
		"",
	);
	const url = `${baseUrl}/chat/completions`;

	const body: Record<string, unknown> = {
		model: opts.model || def.defaultModel,
		messages: opts.messages,
	};
	if (def.supportsReasoningEffort && opts.reasoningEffort) {
		body.reasoning_effort = REASONING_BY_PROVIDER[opts.reasoningEffort] ?? opts.reasoningEffort;
	}

	try {
		const res = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${opts.apiKey}`,
			},
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			const text = await res.text();
			return { success: false, error: `${res.status} ${res.statusText}: ${text.slice(0, 200)}` };
		}
		const json = (await res.json()) as {
			choices?: Array<{ message?: { content?: string } }>;
		};
		const content = json.choices?.[0]?.message?.content;
		if (!content) {
			return { success: false, error: "Empty response from model." };
		}
		return { success: true, content };
	} catch (err) {
		return { success: false, error: err instanceof Error ? err.message : String(err) };
	}
}

async function callAnthropic(opts: CallLlmOptions): Promise<CallLlmResult> {
	const baseUrl = (opts.baseUrl || defaultBaseUrl("anthropic")).replace(/\/+$/, "");
	const url = `${baseUrl}/messages`;
	const systemMessage = opts.messages.find((m) => m.role === "system")?.content;
	const conversation = opts.messages
		.filter((m) => m.role !== "system")
		.map((m) => ({ role: m.role, content: m.content }));

	const body: Record<string, unknown> = {
		model: opts.model || "claude-haiku-4-5",
		max_tokens: 1024,
		messages: conversation,
	};
	if (systemMessage) body.system = systemMessage;
	if (opts.reasoningEffort === "high") {
		body.thinking = { type: "enabled", budget_tokens: 4096 };
	}

	try {
		const res = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": opts.apiKey,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			const text = await res.text();
			return { success: false, error: `${res.status} ${res.statusText}: ${text.slice(0, 200)}` };
		}
		const json = (await res.json()) as {
			content?: Array<{ type: string; text?: string }>;
		};
		const text = json.content?.find((b) => b.type === "text")?.text;
		if (!text) {
			return { success: false, error: "Empty response from Anthropic." };
		}
		return { success: true, content: text };
	} catch (err) {
		return { success: false, error: err instanceof Error ? err.message : String(err) };
	}
}
