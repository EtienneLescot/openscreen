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

export async function createOpenScreenChatModel(
	config: OpenScreenChatModelConfig,
): Promise<BaseChatModel> {
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
		return createLocalProviderChatModel(config);
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
): Promise<BaseChatModel> {
	switch (config.provider) {
		case "openai-oauth":
			// ponytail: ChatGPT device-flow OAuth (Codex). axcut has a hand-rolled
			// ChatCodexOAuth class for this; for v1 we fall back to a generic
			// ChatOpenAI with the chatgpt.com/backend-api base URL. Streaming
			// + tool calls work on the gateway, so this is enough for the chat.
			return new ChatOpenAI({
				apiKey: config.apiKey,
				model: config.model,
				configuration: {
					baseURL: config.baseUrl || "https://chatgpt.com/backend-api",
				},
			});
		case "copilot-proxy": {
			// ponytail: GitHub Copilot runs through its own runtime-token swap;
			// for v1 we just hit the public Copilot base URL with the PAT. The
			// runtime-token refresh from axcut can land as a follow-up.
			return new ChatOpenAI({
				apiKey: config.apiKey,
				model: config.model,
				configuration: {
					baseURL: config.baseUrl || "https://api.individual.githubcopilot.com",
				},
			});
		}
		case "minimax":
		case "minimax-token-plan":
			// ponytail: MiniMax is Anthropic-API-shaped. The provider-registry
			// already gives us the corrected base URL (`/anthropic/v1`).
			return new ChatAnthropic({
				apiKey: config.apiKey,
				model: config.model,
				anthropicApiUrl: config.baseUrl ?? "https://api.minimax.io/anthropic/v1",
			});
		default:
			// ponytail: providers that should already have been handled by the
			// caller — fail loud instead of falling back to OpenAI-by-default.
			throw new Error(`Unknown local provider: ${config.provider}`);
	}
}
