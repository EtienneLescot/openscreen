// Real LLM call via fetch — no LangChain dependency. Supports the
// OpenAI-compatible `/chat/completions` endpoint (OpenAI, Mistral,
// OpenRouter, openai-compatible) and Anthropic's `/v1/messages`, both with
// tool calling (P1). OAuth providers stay stubbed and return a clear
// "not yet implemented" error.
//
// ponytail: keep this file small and dependency-free so it works in both
// Electron and the browser-mode shim. Streaming is not supported in this
// pass — the chat panel does request/response.

import { PROVIDER_DEFINITIONS, type ProviderDefinition } from "./provider-registry";

export interface LlmToolSpec {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface LlmToolCall {
	id: string;
	name: string;
	/** Raw JSON string of the arguments, exactly as the provider returned it. */
	arguments: string;
}

export type ChatMessage =
	| { role: "system" | "user"; content: string }
	| { role: "assistant"; content: string; toolCalls?: LlmToolCall[] }
	| { role: "tool"; content: string; toolCallId: string };

export interface CallLlmOptions {
	provider: string;
	model: string;
	apiKey: string;
	baseUrl?: string;
	reasoningEffort?: string;
	messages: ChatMessage[];
	tools?: LlmToolSpec[];
}

export interface CallLlmResult {
	success: boolean;
	content?: string;
	toolCalls?: LlmToolCall[];
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

// --- OpenAI-compatible wire mapping -------------------------------------

interface OpenAiToolCall {
	id?: string;
	type?: string;
	function?: { name?: string; arguments?: string };
}

function toOpenAiMessage(message: ChatMessage): Record<string, unknown> {
	if (message.role === "tool") {
		return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
	}
	if (message.role === "assistant" && message.toolCalls?.length) {
		return {
			role: "assistant",
			content: message.content || null,
			tool_calls: message.toolCalls.map((call) => ({
				id: call.id,
				type: "function",
				function: { name: call.name, arguments: call.arguments },
			})),
		};
	}
	return { role: message.role, content: message.content };
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
		messages: opts.messages.map(toOpenAiMessage),
	};
	if (opts.tools?.length) {
		body.tools = opts.tools.map((tool) => ({
			type: "function",
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			},
		}));
	}
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
			choices?: Array<{
				message?: { content?: string | null; tool_calls?: OpenAiToolCall[] };
			}>;
		};
		const message = json.choices?.[0]?.message;
		const toolCalls = (message?.tool_calls ?? [])
			.filter((call) => call.function?.name)
			.map((call, index) => ({
				id: call.id ?? `call_${index}`,
				name: call.function?.name ?? "",
				arguments: call.function?.arguments ?? "{}",
			}));
		const content = message?.content ?? "";
		if (!content && toolCalls.length === 0) {
			return { success: false, error: "Empty response from model." };
		}
		return { success: true, content, toolCalls: toolCalls.length ? toolCalls : undefined };
	} catch (err) {
		return { success: false, error: err instanceof Error ? err.message : String(err) };
	}
}

// --- Anthropic wire mapping ----------------------------------------------

type AnthropicContentBlock =
	| { type: "text"; text: string }
	| { type: "tool_use"; id: string; name: string; input: unknown }
	| { type: "tool_result"; tool_use_id: string; content: string };

function toAnthropicMessages(
	messages: ChatMessage[],
): Array<{ role: "user" | "assistant"; content: string | AnthropicContentBlock[] }> {
	const out: Array<{ role: "user" | "assistant"; content: string | AnthropicContentBlock[] }> = [];
	for (const message of messages) {
		if (message.role === "system") continue;
		if (message.role === "tool") {
			// Anthropic wants tool results as user-role tool_result blocks.
			out.push({
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content },
				],
			});
			continue;
		}
		if (message.role === "assistant" && message.toolCalls?.length) {
			const blocks: AnthropicContentBlock[] = [];
			if (message.content) blocks.push({ type: "text", text: message.content });
			for (const call of message.toolCalls) {
				let input: unknown = {};
				try {
					input = call.arguments ? JSON.parse(call.arguments) : {};
				} catch {
					input = {};
				}
				blocks.push({ type: "tool_use", id: call.id, name: call.name, input });
			}
			out.push({ role: "assistant", content: blocks });
			continue;
		}
		out.push({ role: message.role, content: message.content });
	}
	return out;
}

async function callAnthropic(opts: CallLlmOptions): Promise<CallLlmResult> {
	const baseUrl = (opts.baseUrl || defaultBaseUrl("anthropic")).replace(/\/+$/, "");
	const url = `${baseUrl}/messages`;
	const systemMessage = opts.messages.find((m) => m.role === "system")?.content;

	const body: Record<string, unknown> = {
		model: opts.model || "claude-haiku-4-5",
		max_tokens: 4096,
		messages: toAnthropicMessages(opts.messages),
	};
	if (systemMessage) body.system = systemMessage;
	if (opts.tools?.length) {
		body.tools = opts.tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			input_schema: tool.parameters,
		}));
	}
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
			content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
		};
		const blocks = json.content ?? [];
		const text = blocks
			.filter((b) => b.type === "text" && b.text)
			.map((b) => b.text)
			.join("\n");
		const toolCalls = blocks
			.filter((b) => b.type === "tool_use" && b.name)
			.map((b, index) => ({
				id: b.id ?? `toolu_${index}`,
				name: b.name ?? "",
				arguments: JSON.stringify(b.input ?? {}),
			}));
		if (!text && toolCalls.length === 0) {
			return { success: false, error: "Empty response from Anthropic." };
		}
		return { success: true, content: text, toolCalls: toolCalls.length ? toolCalls : undefined };
	} catch (err) {
		return { success: false, error: err instanceof Error ? err.message : String(err) };
	}
}
