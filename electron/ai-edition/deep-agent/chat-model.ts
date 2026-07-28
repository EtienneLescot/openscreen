// ponytail: port of axcut's createAxcutChatModel (apps/server/src/llm/create-chat-model.ts).
// Picks the right @langchain/* chat model class for the configured provider,
// honoring MiniMax as a "local" provider (Anthropic-SDK shaped) and routing
// native Anthropic/OpenAI/Mistral calls through their first-party SDKs.
//
// The openai-oauth (Codex) and copilot-proxy branches were removed in 1.8.0
// along with their providers — see the note in provider-registry.ts.
//
// ponytail: the per-provider reasoning-effort capability table (was
// ./agent-provider-capabilities.ts) is only consumed by createOpenScreenChatModel,
// so it lives here as a top section. The deep-agent runtime wrapper
// (./service.ts) stays separate because it owns a different concern — the
// LangGraph thread + tool graph, not the chat-model factory.

import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatMistralAI } from "@langchain/mistralai";
import { ChatOpenAI } from "@langchain/openai";
import {
	getProviderDefinition,
	normalizeProviderId,
	type ProviderDefinition,
} from "../provider-registry";

// --- per-provider reasoning-effort capability table -----------------------

export type AgentReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export const AGENT_REASONING_EFFORTS: readonly AgentReasoningEffort[] = [
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
];

export interface ReasoningCapability {
	supported: boolean;
	efforts: readonly AgentReasoningEffort[];
	defaultEffort?: AgentReasoningEffort;
	strategy?:
		| "custom-openai-account"
		| "openai-responses"
		| "anthropic-thinking"
		| "minimax-thinking"
		| "openrouter-reasoning"
		| "google-thinking";
}

export interface LangChainReasoningOptions {
	reasoning?: { effort: "low" | "medium" | "high" };
	thinking?: Record<string, unknown>;
	outputConfig?: Record<string, unknown>;
	thinkingConfig?: Record<string, unknown>;
	modelKwargs?: Record<string, unknown>;
	useResponsesApi?: boolean;
}

const OPENAI_REASONING_EFFORTS: readonly AgentReasoningEffort[] = ["none", "low", "medium", "high"];
const ANTHROPIC_REASONING_EFFORTS: readonly AgentReasoningEffort[] = [
	"none",
	"low",
	"medium",
	"high",
	"xhigh",
];
const OPENROUTER_REASONING_EFFORTS: readonly AgentReasoningEffort[] = [
	"none",
	"low",
	"medium",
	"high",
];
const GOOGLE_REASONING_EFFORTS: readonly AgentReasoningEffort[] = ["none", "low", "medium", "high"];

// Every branch here compares against canonical registry ids —
// createOpenScreenChatModel normalizes the provider before calling in.
export function getReasoningCapability(provider: string, model?: string): ReasoningCapability {
	const def: ProviderDefinition | undefined = getProviderDefinition(provider);
	const normalizedModel = normalizeModelName(model);

	if (
		(provider === "openai" || provider === "openai-compatible") &&
		isOpenAIReasoningModel(normalizedModel)
	) {
		return {
			supported: true,
			efforts: OPENAI_REASONING_EFFORTS,
			defaultEffort: "medium",
			strategy: "openai-responses",
		};
	}
	if (def?.id === "anthropic" && isAnthropicReasoningModel(normalizedModel)) {
		return {
			supported: true,
			efforts: ANTHROPIC_REASONING_EFFORTS,
			defaultEffort: "medium",
			strategy: "anthropic-thinking",
		};
	}
	if (provider === "minimax" || provider === "minimax-token-plan") {
		// MiniMax's thinking block is binary — `{type: "adaptive"}` (on) or
		// `{type: "disabled"}` (off, ignored on M2.x which is always-on) — no
		// budget_tokens tiers like native Anthropic. Any non-"none" effort
		// just turns it on; see buildLangChainReasoningOptions below.
		return {
			supported: true,
			efforts: ANTHROPIC_REASONING_EFFORTS,
			defaultEffort: "medium",
			strategy: "minimax-thinking",
		};
	}
	if (provider === "openrouter" && isOpenRouterReasoningModel(normalizedModel)) {
		return {
			supported: true,
			efforts: OPENROUTER_REASONING_EFFORTS,
			defaultEffort: "medium",
			strategy: "openrouter-reasoning",
		};
	}
	if (provider === "google" && isGeminiThinkingModel(normalizedModel)) {
		return {
			supported: true,
			efforts: GOOGLE_REASONING_EFFORTS,
			defaultEffort: "medium",
			strategy: "google-thinking",
		};
	}
	return { supported: false, efforts: ["none"] };
}

export function normalizeReasoningEffortForCapability(
	effort: AgentReasoningEffort | undefined,
	capability: ReasoningCapability,
): AgentReasoningEffort | undefined {
	if (!capability.supported) return undefined;
	if (!effort) return capability.defaultEffort;
	if (capability.efforts.includes(effort)) return effort;
	if (effort === "minimal" && capability.efforts.includes("low")) return "low";
	if (effort === "xhigh" && capability.efforts.includes("high")) return "high";
	return capability.defaultEffort;
}

export function buildLangChainReasoningOptions(
	provider: string,
	model: string | undefined,
	effort: AgentReasoningEffort | undefined,
): LangChainReasoningOptions {
	const capability = getReasoningCapability(provider, model);
	const normalizedEffort = normalizeReasoningEffortForCapability(effort, capability);
	if (!capability.supported || !normalizedEffort || normalizedEffort === "none") {
		return {};
	}

	switch (capability.strategy) {
		case "openai-responses":
			return {
				reasoning: { effort: toOpenAIReasoningEffort(normalizedEffort) },
				useResponsesApi: true,
			};
		case "anthropic-thinking":
			return buildAnthropicReasoningOptions(model, normalizedEffort);
		case "minimax-thinking":
			// No "none" case needed — normalizedEffort === "none" already
			// short-circuits to {} above, which omits `thinking` (= off).
			return { thinking: { type: "adaptive" } };
		case "openrouter-reasoning":
			return {
				modelKwargs: {
					reasoning: { effort: toOpenAIReasoningEffort(normalizedEffort) },
					include_reasoning: true,
				},
			};
		case "google-thinking":
			return {
				thinkingConfig: {
					includeThoughts: true,
					thinkingLevel: toGoogleThinkingLevel(normalizedEffort),
					thinkingBudget: toGoogleThinkingBudget(normalizedEffort),
				},
			};
		default:
			return {};
	}
}

export function shouldDisableModelStreamingForToolCalling(
	provider: string,
	model?: string,
): boolean {
	return provider === "google" && normalizeModelName(model).startsWith("gemini-3");
}

function buildAnthropicReasoningOptions(
	model: string | undefined,
	effort: AgentReasoningEffort,
): LangChainReasoningOptions {
	if (isAnthropicAdaptiveThinkingModel(model)) {
		return {
			thinking: { type: "adaptive", display: "summarized" },
			outputConfig: { effort: toAnthropicEffort(effort) },
		};
	}
	return {
		thinking: {
			type: "enabled",
			budget_tokens: toAnthropicBudgetTokens(effort),
			display: "summarized",
		},
	};
}

function isOpenAIReasoningModel(model: string): boolean {
	return /^(o\d|o\d-|o\d\.|gpt-5|gpt-5-|gpt-5\.)/.test(model);
}

function isAnthropicReasoningModel(model: string): boolean {
	return /^claude-(opus|sonnet|haiku)-4/.test(model);
}

function isAnthropicAdaptiveThinkingModel(model: string | undefined): boolean {
	if (!model) return false;
	return /^claude-(opus|sonnet)-4-[67]/.test(model);
}

function isGeminiThinkingModel(model: string): boolean {
	return model.startsWith("gemini-2.5") || model.startsWith("gemini-3");
}

function isOpenRouterReasoningModel(model: string): boolean {
	// OpenRouter slugs are `vendor/model`, and both vendor matchers are
	// anchored at the start — so the prefix has to come off first or
	// `openai/gpt-5` never matches.
	if (isOpenAIReasoningModel(stripVendorPrefix(model, "openai/"))) return true;
	if (isAnthropicReasoningModel(stripVendorPrefix(model, "anthropic/"))) return true;
	return /deepseek-r1/i.test(model) || /qwen.*thinking/i.test(model) || /grok-4/i.test(model);
}

function stripVendorPrefix(model: string, prefix: string): string {
	return model.startsWith(prefix) ? model.slice(prefix.length) : model;
}

function toOpenAIReasoningEffort(effort: AgentReasoningEffort): "low" | "medium" | "high" {
	if (effort === "high" || effort === "xhigh") return "high";
	if (effort === "medium") return "medium";
	return "low";
}

function toAnthropicEffort(effort: AgentReasoningEffort): "low" | "medium" | "high" | "xhigh" {
	if (effort === "high" || effort === "xhigh") return effort;
	if (effort === "medium") return "medium";
	return "low";
}

function toAnthropicBudgetTokens(effort: AgentReasoningEffort): number {
	if (effort === "xhigh") return 16_000;
	if (effort === "high") return 10_000;
	if (effort === "medium") return 4_000;
	return 1_024;
}

function toGoogleThinkingLevel(effort: AgentReasoningEffort): "LOW" | "MEDIUM" | "HIGH" {
	if (effort === "high" || effort === "xhigh") return "HIGH";
	if (effort === "medium") return "MEDIUM";
	return "LOW";
}

function toGoogleThinkingBudget(effort: AgentReasoningEffort): number {
	if (effort === "high" || effort === "xhigh") return 8_192;
	if (effort === "medium") return 4_096;
	return 1_024;
}

function normalizeModelName(model?: string): string {
	return model?.trim().toLowerCase() || "";
}

// --- chat-model factory ----------------------------------------------------

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
	// comparison below is an exact match against a registry id.
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
