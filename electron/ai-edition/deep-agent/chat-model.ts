// ponytail: port of axcut's createAxcutChatModel (apps/server/src/llm/create-chat-model.ts).
// Picks the right @langchain/* chat model class for the configured provider,
// honoring MiniMax/OpenAI-OAuth/GitHub Copilot as "local" providers (Anthropic-
// SDK or OpenAI-SDK shaped) and routing native Anthropic/OpenAI/Mistral calls
// through their first-party SDKs.

import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatMistralAI } from "@langchain/mistralai";
import { ChatOpenAI } from "@langchain/openai";
import {
	exchangeGithubCopilotRuntimeToken,
	GITHUB_COPILOT_EDITOR_VERSION,
	GITHUB_COPILOT_PLUGIN_VERSION,
	GITHUB_COPILOT_USER_AGENT,
} from "../llm-provider-auth";
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
	accountId?: string;
}

// ponytail: placeholder API key for self-hosted OpenAI-compatible endpoints
// that don't actually authenticate (same as axcut's OPENAI_COMPATIBLE_NO_AUTH).
export const OPENAI_COMPATIBLE_NO_AUTH_API_KEY = "openscreen-openai-compatible-no-auth";

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

	// ponytail: OpenAI-OAuth (Codex), GitHub Copilot, and MiniMax all ride
	// their non-default SDK path (or a base-URL swap). Anthropic-shaped wire
	// for MiniMax, ChatGPT-OAuth-shaped for Codex, runtime-token swap for
	// Copilot. axcut has the same split.
	if (
		config.provider === "openai-oauth" ||
		config.provider === "copilot-proxy" ||
		config.provider === "minimax" ||
		config.provider === "minimax-token-plan"
	) {
		return createLocalProviderChatModel(config, reasoningOptions);
	}

	if (config.provider === "anthropic") {
		return new ChatAnthropic({
			apiKey: config.apiKey,
			model: config.model,
			// ponytail: ChatAnthropic accepts `anthropicApiUrl` for self-hosted
			// Anthropic-compatible endpoints — MiniMax uses this on the wire path.
			...(config.baseUrl ? { anthropicApiUrl: config.baseUrl } : {}),
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
		case "openai-oauth":
			// ponytail: ChatGPT device-flow OAuth (Codex). axcut has a hand-rolled
			// ChatCodexOAuth class for this; for v1 we fall back to a generic
			// ChatOpenAI with the chatgpt.com/backend-api base URL. Streaming
			// + tool calls work on the gateway, so this is enough for the chat.
			// `chatgpt-account-id` is not optional — the gateway rejects an
			// OAuth token without the account it was minted for. The rest of
			// the Codex header set (originator, x-codex-window-id, the
			// OpenAI-Beta Responses opt-in) belongs to the Responses dialect
			// this path does not speak; add it with a real ChatCodexOAuth.
			return new ChatOpenAI({
				apiKey: config.apiKey,
				model: config.model,
				configuration: {
					baseURL: config.baseUrl || "https://chatgpt.com/backend-api",
					...(config.accountId
						? { defaultHeaders: { "chatgpt-account-id": config.accountId } }
						: {}),
				},
			});
		case "copilot-proxy": {
			// Copilot does not accept the PAT directly: it is exchanged for a
			// short-lived runtime token, which also names the base URL to use.
			// The editor-identifying headers are part of the contract — the
			// endpoint rejects requests without them.
			const runtime = await exchangeGithubCopilotRuntimeToken(config.apiKey ?? "");
			return new ChatOpenAI({
				apiKey: runtime.token,
				model: config.model,
				configuration: {
					baseURL: config.baseUrl || runtime.baseUrl || "https://api.individual.githubcopilot.com",
					defaultHeaders: {
						"User-Agent": GITHUB_COPILOT_USER_AGENT,
						"Editor-Version": GITHUB_COPILOT_EDITOR_VERSION,
						"Editor-Plugin-Version": GITHUB_COPILOT_PLUGIN_VERSION,
						"Openai-Intent": "copilot-gpt-chat-completions",
					},
				},
			});
		}
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
				...(reasoningOptions.thinking ? { thinking: reasoningOptions.thinking as never } : {}),
			});
		default:
			// ponytail: providers that should already have been handled by the
			// caller — fail loud instead of falling back to OpenAI-by-default.
			throw new Error(`Unknown local provider: ${config.provider}`);
	}
}
