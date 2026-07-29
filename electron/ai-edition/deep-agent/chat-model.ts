// ponytail: port of axcut's createAxcutChatModel (apps/server/src/llm/create-chat-model.ts).
// Picks the right @langchain/* chat model class for the configured provider,
// honoring MiniMax as a "local" provider (Anthropic-SDK shaped) and routing
// native Anthropic/OpenAI/Mistral calls through their first-party SDKs.
//
// The openai-oauth (Codex) and copilot-proxy branches were removed in 1.8.0
// along with their providers — see the note in provider-registry.ts.

import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatMistralAI } from "@langchain/mistralai";
import { ChatOpenAI } from "@langchain/openai";
import { normalizeProviderId } from "../provider-registry";
import {
	buildLangChainReasoningOptions,
	shouldDisableModelStreamingForToolCalling,
} from "./agent-provider-capabilities";

export interface OpenScreenChatModelConfig {
	provider: string;
	model: string;
	apiKey?: string;
	baseUrl?: string;
	reasoningEffort?: string;
}

// ponytail: placeholder API key for self-hosted OpenAI-compatible endpoints
// that don't actually authenticate (same as axcut's OPENAI_COMPATIBLE_NO_AUTH).
export const OPENAI_COMPATIBLE_NO_AUTH_API_KEY = "openscreen-openai-compatible-no-auth";

// ponytail: explicit output budget for the Anthropic-wire providers
// (`anthropic`, `minimax`, `minimax-token-plan`). ChatAnthropic picks its
// default `maxTokens` from a table of known Claude models (16k for 4.x/5.x)
// and falls back to 4096 for anything else — including every MiniMax slug and
// any self-hosted model name. With thinking on, a cold-start turn can spend
// the entire 4096-token budget on reasoning and truncate with
// `stop_reason: "max_tokens"` before emitting a single text block — the
// "first call returns an empty response" bug (#181). 16384 matches what the
// known Claude models get.
//
// This only applies to the Anthropic Messages API path, where `max_tokens`
// is mandatory: the OpenAI-shaped transports (ChatOpenAI, ChatMistralAI)
// send no cap by default, so there is nothing to fix — and imposing one
// would truncate outputs that are uncapped today.
export const ANTHROPIC_API_MAX_OUTPUT_TOKENS = 16_384;

// ponytail: LangChain's default-maxTokens table knows every released
// claude-* slug with its real per-model limit (4096 for claude-3-haiku,
// 16384 for 4.x/5.x) — trust it. Overriding with a flat 16k would exceed a
// legacy model's hard limit and turn the request into a 400. Anything NOT
// claude-shaped on the anthropic branch is a self-hosted Anthropic-compatible
// endpoint behind `baseUrl`, which LangChain can't know — floor those at
// ANTHROPIC_API_MAX_OUTPUT_TOKENS like the MiniMax path.
function isKnownClaudeSlug(model: string): boolean {
	return model.trim().toLowerCase().startsWith("claude-");
}

export function resolveOpenAIChatApiKey(provider: string, apiKey?: string): string | undefined {
	if (apiKey) return apiKey;
	return provider === "openai-compatible" ? OPENAI_COMPATIBLE_NO_AUTH_API_KEY : undefined;
}

/** Flattens LangChain MessageContent (a string, or an array of text and
 * non-text parts) down to plain text. Lives here rather than in
 * deep-agent/service.ts so the one-shot prompt→text callers can reach it
 * without dragging the agent tool graph in behind it. */
export function messageContentToText(content: unknown): string {
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

// ponytail: counterpart to messageContentToText for the Anthropic/MiniMax
// thinking blocks. ChatAnthropic with `thinking: {type: "adaptive"}` (or
// `enabled`) emits streamed `thinking_delta` SSE events that LangChain turns
// into content parts `{type: "thinking", thinking: "..."}`. We strip that
// thinking text out of the final AIMessage content (where it counts against
// max_tokens on the visible text path, but isn't user-visible text) and pipe
// it separately to the renderer so the chat panel can show a live "Thinking…"
// block instead of dead air. `redacted_thinking` parts (encrypted reasoning
// the provider chose not to show us) are skipped — there's nothing to display.
export function messageContentToThinking(content: unknown): string {
	if (!Array.isArray(content)) return "";
	let total = "";
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const p = part as { type?: unknown; thinking?: unknown };
		if (p.type !== "thinking") continue;
		if (typeof p.thinking === "string") total += p.thinking;
	}
	return total;
}

export async function createOpenScreenChatModel(
	input: OpenScreenChatModelConfig,
): Promise<BaseChatModel> {
	// Canonicalise once, here: stored configs can still carry historical
	// aliases (`claude`, `gemini`, `anthropic-proxy`), and every provider
	// comparison below — and in agent-provider-capabilities — is an exact
	// match against a registry id.
	const config: OpenScreenChatModelConfig = {
		...input,
		provider: normalizeProviderId(input.provider) ?? input.provider,
	};

	const reasoningOptions = buildLangChainReasoningOptions(
		config.provider,
		config.model,
		config.reasoningEffort as never,
	);

	// ponytail: MiniMax rides a non-default SDK path — its wire format is
	// Anthropic's, not OpenAI's, despite the OpenAI-looking model names.
	if (config.provider === "minimax" || config.provider === "minimax-token-plan") {
		return createLocalProviderChatModel(config, reasoningOptions);
	}

	if (config.provider === "anthropic") {
		return new ChatAnthropic({
			apiKey: config.apiKey,
			model: config.model,
			// ponytail: ChatAnthropic accepts `anthropicApiUrl` for self-hosted
			// Anthropic-compatible endpoints — MiniMax uses this on the wire path.
			...(config.baseUrl ? { anthropicApiUrl: config.baseUrl } : {}),
			...(isKnownClaudeSlug(config.model) ? {} : { maxTokens: ANTHROPIC_API_MAX_OUTPUT_TOKENS }),
			...(reasoningOptions.thinking ? { thinking: reasoningOptions.thinking as never } : {}),
			...(reasoningOptions.outputConfig
				? { outputConfig: reasoningOptions.outputConfig as never }
				: {}),
		});
	}

	if (config.provider === "mistral") {
		return new ChatMistralAI({
			apiKey: config.apiKey,
			model: config.model,
		});
	}

	// Default: OpenAI-compatible path (openai, google, openrouter, openai-compatible).
	const baseURL =
		config.provider === "openrouter"
			? config.baseUrl || "https://openrouter.ai/api/v1"
			: config.provider === "google"
				? config.baseUrl || "https://generativelanguage.googleapis.com/v1beta/openai"
				: config.baseUrl;
	const apiKey = resolveOpenAIChatApiKey(config.provider, config.apiKey);
	return new ChatOpenAI({
		...(apiKey ? { apiKey } : {}),
		model: config.model,
		...(reasoningOptions.reasoning ? { reasoning: reasoningOptions.reasoning } : {}),
		...(reasoningOptions.useResponsesApi ? { useResponsesApi: true } : {}),
		...(reasoningOptions.modelKwargs ? { modelKwargs: reasoningOptions.modelKwargs } : {}),
		// ponytail: Gemini's OpenAI-compat path can't stream + tool-call at once
		// — disable streaming so the ChatOpenAI compat layer buffers and returns
		// cleanly. axcut does the same.
		...(shouldDisableModelStreamingForToolCalling(config.provider, config.model)
			? { disableStreaming: true }
			: {}),
		...(baseURL ? { configuration: { baseURL } } : {}),
	});
}

async function createLocalProviderChatModel(
	config: OpenScreenChatModelConfig,
	reasoningOptions: ReturnType<typeof buildLangChainReasoningOptions>,
): Promise<BaseChatModel> {
	switch (config.provider) {
		case "minimax":
		case "minimax-token-plan":
			// ponytail: MiniMax is Anthropic-API-shaped. ChatAnthropic wraps
			// @anthropic-ai/sdk, which appends `/v1/messages` itself, so the
			// base URL here must be the bare `/anthropic` origin (matching
			// provider-registry.ts's baseUrl) — not `/anthropic/v1`.
			return new ChatAnthropic({
				apiKey: config.apiKey,
				model: config.model,
				anthropicApiUrl: config.baseUrl ?? "https://api.minimax.io/anthropic",
				maxTokens: ANTHROPIC_API_MAX_OUTPUT_TOKENS,
				...(reasoningOptions.thinking ? { thinking: reasoningOptions.thinking as never } : {}),
			});
		default:
			// ponytail: providers that should already have been handled by the
			// caller — fail loud instead of falling back to OpenAI-by-default.
			throw new Error(`Unknown local provider: ${config.provider}`);
	}
}
