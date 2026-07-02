// Real LLM call via fetch — no LangChain dependency. Supports the
// OpenAI-compatible `/chat/completions` endpoint (OpenAI, Mistral,
// OpenRouter, openai-compatible, Gemini via OpenAI-compat), Anthropic's
// `/v1/messages`, the Codex (ChatGPT OAuth) Responses path, and GitHub
// Copilot's runtime-token chat path.
//
// Reasoning-effort transport is per-provider (see
// ./agent-provider-capabilities). Streaming uses SSE on every provider:
//   - OpenAI-compat: parse `data: {…}` deltas; `stream: true` in the body
//   - Anthropic: `message_start`/`content_block_*`/`message_delta`/`message_stop`
//   - Codex: bespoke chatgpt.com dialect, parsed via `consumeCodexStream`
//
// The non-streaming `callLlm` runs `streamLlm` under the hood and discards
// the deltas. Wire-callers should prefer `streamLlm` for live UX.

import { getReasoningCallOptions } from "./agent-provider-capabilities";
import {
	buildCodexUserAgent,
	CODEX_RESPONSES_PATH,
	type CodexToolCallDelta,
	consumeCodexStream,
	toCodexInput,
	toCodexReasoningPayload,
	toCodexTools,
} from "./codex-session";
import { exchangeGithubCopilotRuntimeToken, OPENAI_ACCOUNT_BASE_URL } from "./llm-provider-auth";
import {
	getProviderDefinition,
	normalizeProviderId,
	PROVIDER_DEFINITIONS,
	type ProviderDefinition,
} from "./provider-registry";

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
	/** Provider model id (e.g. `gpt-4o`). Empty string falls back to the
	 * provider's `defaultModel`. */
	model: string;
	/** Bearer credential string (env var, API key, OAuth access token, or
	 * GitHub PAT for Copilot). */
	apiKey: string;
	baseUrl?: string;
	reasoningEffort?: string;
	messages: ChatMessage[];
	tools?: LlmToolSpec[];
	/** OAuth account id (Codex only). When present the call sets the
	 * `chatgpt-account-id` header required by chatgpt.com/backend-api. */
	accountId?: string;
	/** Codex session id (chatgpt.com/backend-api requires a stable per-session
	 * window id). Mints a fresh uuid if not provided. */
	sessionId?: string;
	/** Persistent installation id (Codex only). */
	installationId?: string;
	/** Aborts the in-flight stream. */
	signal?: AbortSignal;
}

export interface CallLlmResult {
	success: boolean;
	content?: string;
	toolCalls?: LlmToolCall[];
	error?: string;
}

export interface LlmStreamCallbacks {
	onTextDelta?: (delta: string) => void;
	onToolCall?: (call: LlmToolCall) => void;
	/** Called once with the response id (Codex / Responses API). */
	onResponseId?: (id: string) => void;
}

interface OpenAiToolCall {
	id?: string;
	type?: string;
	function?: { name?: string; arguments?: string };
	/** Stream-mode delta items carry an `index` and partial fields. */
	index?: number;
}

function resolveProvider(rawId: string): ProviderDefinition | undefined {
	const id = normalizeProviderId(rawId) ?? rawId;
	return getProviderDefinition(id);
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

function defaultBaseUrl(providerId: string): string | undefined {
	return PROVIDER_DEFINITIONS.find((p) => p.id === providerId)?.baseUrl;
}

function isOauth(providerId: string): boolean {
	return providerId === "openai-oauth";
}

function isPat(providerId: string): boolean {
	return providerId === "copilot-proxy";
}

// ─── Public API ─────────────────────────────────────────────────────────

export async function callLlm(opts: CallLlmOptions): Promise<CallLlmResult> {
	let text = "";
	const toolCalls: LlmToolCall[] = [];
	const cb: LlmStreamCallbacks = {
		onTextDelta: (d) => (text = `${text}${d}`),
		onToolCall: (call) => toolCalls.push(call),
	};
	const result = await streamLlm(opts, cb);
	if (!result.success) return result;
	return {
		success: true,
		content: text,
		toolCalls: toolCalls.length ? toolCalls : undefined,
	};
}

/**
 * Streaming entrypoint. `callbacks.onTextDelta` fires for every text delta;
 * `callbacks.onToolCall` fires once per complete tool call. Returns a
 * `CallLlmResult` indicating overall success/failure and any tool calls
 * observed.
 */
export async function streamLlm(
	opts: CallLlmOptions,
	callbacks: LlmStreamCallbacks = {},
): Promise<CallLlmResult> {
	const def = resolveProvider(opts.provider);
	if (!def) {
		return { success: false, error: `Unknown provider: ${opts.provider}` };
	}
	if (!opts.apiKey && def.authKind === "api-key") {
		return { success: false, error: `Missing API key for ${def.label}` };
	}
	if (def.authKind === "oauth-device") {
		if (!isOauth(def.id)) {
			return { success: false, error: `Provider "${def.label}" uses OAuth — not implemented.` };
		}
		return streamCodex(opts, callbacks);
	}
	if (def.authKind === "pat") {
		if (!isPat(def.id)) {
			return {
				success: false,
				error: `Provider "${def.label}" uses a personal access token — not implemented.`,
			};
		}
		return streamCopilot(opts, callbacks);
	}
	if (def.wireProtocol === "anthropic") return streamAnthropic(opts, callbacks);
	return streamOpenAiCompatible(opts, callbacks);
}

// ─── OpenAI-compatible ──────────────────────────────────────────────────

async function streamOpenAiCompatible(
	opts: CallLlmOptions,
	cb: LlmStreamCallbacks,
): Promise<CallLlmResult> {
	const def = getProviderDefinition(opts.provider);
	const baseUrl = (opts.baseUrl || def?.baseUrl || defaultBaseUrl(opts.provider) || "").replace(
		/\/+$/,
		"",
	);
	const url = `${baseUrl}/chat/completions`;

	const body: Record<string, unknown> = {
		model: opts.model || def?.defaultModel,
		messages: opts.messages.map(toOpenAiMessage),
		stream: true,
		stream_options: { include_usage: false },
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
	const reasoning = getReasoningCallOptions(
		opts.provider,
		opts.model,
		opts.reasoningEffort as never,
	);
	if (reasoning.extraBody) Object.assign(body, reasoning.extraBody);

	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
		body: JSON.stringify(body),
		signal: opts.signal,
	});
	if (!res.ok || !res.body) {
		return { success: false, error: `Upstream ${res.status} ${res.statusText}` };
	}

	const toolCalls: OpenAiToolCall[] = [];
	let text = "";
	for await (const chunk of parseSse(res.body)) {
		const choice = (chunk.choices?.[0] ?? {}) as Record<string, unknown>;
		const delta = (choice.delta ?? {}) as Record<string, unknown>;
		if (typeof delta.content === "string" && delta.content.length > 0) {
			text += delta.content;
			cb.onTextDelta?.(delta.content);
		}
		const tcDelta = (delta.tool_calls ?? []) as OpenAiToolCall[];
		for (const d of tcDelta) {
			accumulateOpenAiToolCall(toolCalls, d);
		}
	}
	const finalCalls: LlmToolCall[] = toolCalls
		.filter((t) => t.function?.name)
		.map((t, i) => ({
			id: t.id ?? `call_${i}`,
			name: t.function?.name ?? "",
			arguments: t.function?.arguments ?? "{}",
		}));
	for (const c of finalCalls) cb.onToolCall?.(c);
	if (!text && finalCalls.length === 0) {
		return { success: false, error: "Empty response from model." };
	}
	return {
		success: true,
		content: text,
		toolCalls: finalCalls.length ? finalCalls : undefined,
	};
}

function accumulateOpenAiToolCall(acc: OpenAiToolCall[], incoming: OpenAiToolCall): void {
	const idx = typeof incoming.index === "number" ? incoming.index : acc.length;
	while (acc.length <= idx) acc.push({});
	const cur = acc[idx]!;
	if (incoming.id) cur.id = incoming.id;
	if (incoming.type) cur.type = incoming.type;
	if (incoming.function?.name) {
		cur.function = { ...(cur.function ?? {}), name: incoming.function.name };
	}
	if (typeof incoming.function?.arguments === "string") {
		const prev = cur.function?.arguments ?? "";
		cur.function = { ...(cur.function ?? {}), arguments: `${prev}${incoming.function.arguments}` };
	}
}

// ─── Anthropic ──────────────────────────────────────────────────────────

async function streamAnthropic(
	opts: CallLlmOptions,
	cb: LlmStreamCallbacks,
): Promise<CallLlmResult> {
	const def = getProviderDefinition(opts.provider) ?? getProviderDefinition("anthropic");
	const baseUrl = (opts.baseUrl || def?.baseUrl || "https://api.anthropic.com/v1").replace(
		/\/+$/,
		"",
	);
	const systemMessage = opts.messages.find((m) => m.role === "system")?.content;
	const conversation = opts.messages.filter((m) => m.role !== "system");

	const body: Record<string, unknown> = {
		model: opts.model || def?.defaultModel || "claude-haiku-4-5",
		max_tokens: 8192,
		messages: conversation.map(toAnthropicMessage),
		stream: true,
	};
	if (systemMessage) body.system = systemMessage;
	if (opts.tools?.length) {
		body.tools = opts.tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			input_schema: tool.parameters,
		}));
	}

	const reasoning = getReasoningCallOptions(
		opts.provider,
		opts.model,
		opts.reasoningEffort as never,
	);
	if (reasoning.requestBodyPatch) {
		if (reasoning.requestBodyPatch.thinking) body.thinking = reasoning.requestBodyPatch.thinking;
		if (reasoning.requestBodyPatch.outputConfig) {
			body.output_config = reasoning.requestBodyPatch.outputConfig;
		}
	}
	// MiniMax rides this same Anthropic-shaped wire path but takes its
	// reasoning knob as a plain extraBody field (see agent-provider-capabilities.ts).
	if (reasoning.extraBody) Object.assign(body, reasoning.extraBody);

	const res = await fetch(`${baseUrl}/messages`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": opts.apiKey,
			"anthropic-version": "2023-06-01",
		},
		body: JSON.stringify(body),
		signal: opts.signal,
	});
	if (!res.ok || !res.body) {
		return { success: false, error: `Upstream ${res.status} ${res.statusText}` };
	}

	let text = "";
	const toolCalls: LlmToolCall[] = [];
	const inFlight = new Map<string, { name: string; args: string; index: number }>();

	for await (const event of parseAnthropicEvents(res.body)) {
		if (event.type === "content_block_start") {
			const block = (event.content_block ?? {}) as Record<string, unknown>;
			if (block.type === "tool_use") {
				const toolId = typeof block.id === "string" ? block.id : "";
				inFlight.set(toolId, {
					name: typeof block.name === "string" ? block.name : "",
					args: "",
					index: toolCalls.length,
				});
			}
		} else if (event.type === "content_block_delta") {
			const delta = (event.delta ?? {}) as Record<string, unknown>;
			if (delta.type === "text_delta" && typeof delta.text === "string") {
				text += delta.text;
				cb.onTextDelta?.(delta.text);
			} else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
				const toolId =
					typeof event.index === "number" ? findToolUseIdByIndex(inFlight, event.index) : undefined;
				if (toolId) {
					const entry = inFlight.get(toolId);
					if (entry) {
						entry.args += delta.partial_json;
					}
				}
			}
		} else if (event.type === "content_block_stop") {
			const idx = typeof event.index === "number" ? event.index : -1;
			for (const [toolId, entry] of inFlight) {
				if (entry.index === idx) {
					const call: LlmToolCall = { id: toolId, name: entry.name, arguments: entry.args };
					toolCalls.push(call);
					cb.onToolCall?.(call);
					inFlight.delete(toolId);
				}
			}
		}
	}

	if (!text && toolCalls.length === 0) {
		return { success: false, error: "Empty response from Anthropic." };
	}
	return {
		success: true,
		content: text,
		toolCalls: toolCalls.length ? toolCalls : undefined,
	};
}

function findToolUseIdByIndex(
	inFlight: Map<string, { index: number }>,
	idx: number,
): string | undefined {
	for (const [id, entry] of inFlight) if (entry.index === idx) return id;
	return undefined;
}

function toAnthropicMessage(message: ChatMessage): Record<string, unknown> {
	if (message.role === "tool") {
		return {
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: message.toolCallId,
					content: message.content,
				},
			],
		};
	}
	if (message.role === "assistant" && message.toolCalls?.length) {
		const blocks: unknown[] = [];
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
		return { role: "assistant", content: blocks };
	}
	return { role: message.role, content: message.content };
}

// ─── Codex ──────────────────────────────────────────────────────────────

async function streamCodex(opts: CallLlmOptions, cb: LlmStreamCallbacks): Promise<CallLlmResult> {
	const def = getProviderDefinition("openai-oauth");
	const model = opts.model || def?.defaultModel || "gpt-5.4";
	const baseUrl = (opts.baseUrl || OPENAI_ACCOUNT_BASE_URL).replace(/\/+$/, "");
	const url = `${baseUrl}${CODEX_RESPONSES_PATH}`;

	const headers = buildCodexHeaders(opts, model);
	const body = buildCodexBody(opts, model);

	const res = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: opts.signal,
	});
	if (!res.ok || !res.body) {
		const text = await res.text().catch(() => "");
		return {
			success: false,
			error: text
				? `${res.status} ${res.statusText}: ${text.slice(0, 200)}`
				: `Upstream ${res.status}`,
		};
	}

	let text = "";
	const toolCalls: LlmToolCall[] = [];
	const seen = new Set<string>();
	try {
		for await (const event of consumeCodexStream(res.body)) {
			if (event.kind === "text") {
				text += event.delta;
				cb.onTextDelta?.(event.delta);
			} else if (event.kind === "tool") {
				const tc: CodexToolCallDelta = event.delta;
				if (!seen.has(tc.id)) {
					seen.add(tc.id);
					toolCalls.push({ id: tc.id, name: tc.name, arguments: "" });
				}
				const slot = toolCalls.find((c) => c.id === tc.id)!;
				slot.name = tc.name || slot.name;
				slot.arguments = `${slot.arguments}${tc.args}`;
			} else if (event.kind === "response_id") {
				cb.onResponseId?.(event.id);
			} else if (event.kind === "done") {
				break;
			}
		}
	} catch (err) {
		return { success: false, error: err instanceof Error ? err.message : String(err) };
	}

	for (const c of toolCalls) cb.onToolCall?.(c);
	if (!text && toolCalls.length === 0) {
		return { success: false, error: "Empty response from Codex." };
	}
	return {
		success: true,
		content: text,
		toolCalls: toolCalls.length ? toolCalls : undefined,
	};
}

function buildCodexHeaders(opts: CallLlmOptions, _model: string): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${opts.apiKey}`,
		Accept: "text/event-stream",
		originator: "codex_cli_rs",
		"OpenAI-Beta": "responses=experimental",
		"User-Agent": opts.sessionId
			? `${buildCodexUserAgent()} session/${opts.sessionId}`
			: buildCodexUserAgent(),
		"x-client-request-id": cryptoRandomUuid(),
		"x-codex-window-id": opts.sessionId ?? cryptoRandomUuid(),
		...(opts.installationId ? { "x-codex-installation-id": opts.installationId } : {}),
	};
	if (opts.accountId) headers["chatgpt-account-id"] = opts.accountId;
	if (opts.sessionId) headers["session_id"] = opts.sessionId;
	return headers;
}

function buildCodexBody(opts: CallLlmOptions, model: string): Record<string, unknown> {
	const conversation = opts.messages.filter((m) => m.role !== "system");
	const system = opts.messages.find((m) => m.role === "system")?.content;

	const reasoningPayload = toCodexReasoningPayload(
		model,
		((opts.reasoningEffort as never) ?? "medium") as never,
	);

	const body: Record<string, unknown> = {
		model,
		store: false,
		stream: true,
		input: toCodexInput(conversation),
		include: ["reasoning.encrypted_content"],
		parallel_tool_calls: true,
		tool_choice: "auto",
		...(reasoningPayload ?? {}),
		...(opts.sessionId ? { session_id: opts.sessionId } : {}),
	};
	if (system) body.instructions = system;
	if (opts.tools?.length) body.tools = toCodexTools(opts.tools);
	return body;
}

// ponytail: minimalist UUID — keeps the Codex identity headers non-uniform without pulling crypto.randomUUID into renderer.
function cryptoRandomUuid(): string {
	if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
	// Math.random fallback is acceptable here; the field is just a request id.
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		const v = c === "x" ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}

// ─── Copilot ────────────────────────────────────────────────────────────

async function streamCopilot(opts: CallLlmOptions, cb: LlmStreamCallbacks): Promise<CallLlmResult> {
	const def = getProviderDefinition("copilot-proxy");
	let runtime: { token: string; baseUrl: string };
	try {
		runtime = await exchangeGithubCopilotRuntimeToken(opts.apiKey);
	} catch (err) {
		return { success: false, error: err instanceof Error ? err.message : String(err) };
	}

	const baseUrl = (opts.baseUrl || runtime.baseUrl || def?.baseUrl || "").replace(/\/+$/, "");
	const body: Record<string, unknown> = {
		model: opts.model || def?.defaultModel,
		messages: opts.messages.map(toOpenAiMessage),
		stream: true,
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
	const reasoning = getReasoningCallOptions(
		"copilot-proxy",
		opts.model,
		opts.reasoningEffort as never,
	);
	if (reasoning.extraBody) Object.assign(body, reasoning.extraBody);

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${runtime.token}`,
		Accept: "text/event-stream",
		"User-Agent": "GitHubCopilotChat/0.26.7",
		"Editor-Version": "vscode/1.96.2",
		"Editor-Plugin-Version": "copilot-chat/0.26.7",
		"Openai-Intent": "copilot-gpt-chat-completions",
	};
	if (opts.reasoningEffort && opts.reasoningEffort !== "none") {
		headers["X-Initiator"] = "user";
	}

	const res = await fetch(`${baseUrl}/chat/completions`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: opts.signal,
	});
	if (!res.ok || !res.body) {
		return { success: false, error: `Upstream ${res.status} ${res.statusText}` };
	}

	let text = "";
	const toolCalls: OpenAiToolCall[] = [];
	for await (const chunk of parseSse(res.body)) {
		const choice = (chunk.choices?.[0] ?? {}) as Record<string, unknown>;
		const delta = (choice.delta ?? {}) as Record<string, unknown>;
		if (typeof delta.content === "string" && delta.content.length > 0) {
			text += delta.content;
			cb.onTextDelta?.(delta.content);
		}
		for (const d of (delta.tool_calls ?? []) as OpenAiToolCall[])
			accumulateOpenAiToolCall(toolCalls, d);
	}
	const finalCalls: LlmToolCall[] = toolCalls
		.filter((t) => t.function?.name)
		.map((t, i) => ({
			id: t.id ?? `call_${i}`,
			name: t.function?.name ?? "",
			arguments: t.function?.arguments ?? "{}",
		}));
	for (const c of finalCalls) cb.onToolCall?.(c);
	if (!text && finalCalls.length === 0) {
		return { success: false, error: "Empty response from Copilot." };
	}
	return {
		success: true,
		content: text,
		toolCalls: finalCalls.length ? finalCalls : undefined,
	};
}

// ─── Generic SSE / Anthropic event parser ────────────────────────────────

async function* parseSse(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ choices?: Array<Record<string, unknown>>; [k: string]: unknown }> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let idx = buffer.indexOf("\n\n");
		while (idx !== -1) {
			const chunk = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 2);
			const data = chunk
				.split("\n")
				.filter((l) => l.startsWith("data:"))
				.map((l) => l.slice(5).trim())
				.join("\n")
				.trim();
			if (data && data !== "[DONE]") {
				try {
					yield JSON.parse(data) as Record<string, unknown>;
				} catch {
					/* skip malformed */
				}
			}
			idx = buffer.indexOf("\n\n");
		}
	}
}

export async function* parseAnthropicEvents(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ type: string; [k: string]: unknown }> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let idx = buffer.indexOf("\n\n");
		while (idx !== -1) {
			const chunk = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 2);
			const eventLine = chunk.split("\n").find((l) => l.startsWith("event:"));
			const dataLine = chunk
				.split("\n")
				.filter((l) => l.startsWith("data:"))
				.map((l) => l.slice(5).trim())
				.join("\n");
			const eventName = eventLine ? eventLine.slice(6).trim() : "";
			if (dataLine) {
				try {
					const parsed = JSON.parse(dataLine) as Record<string, unknown>;
					yield { ...parsed, type: eventName || parsed.type || "message" } as never;
				} catch {
					/* skip */
				}
			}
			idx = buffer.indexOf("\n\n");
		}
	}
}
