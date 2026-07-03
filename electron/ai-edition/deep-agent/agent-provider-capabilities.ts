// ponytail: port of axcut's agent-provider-capabilities.ts. Drives the
// per-provider reasoning-effort wiring (OpenAI uses `reasoning.effort`,
// Anthropic uses `thinking` blocks, OpenRouter uses `modelKwargs.reasoning`,
// Google uses `thinkingConfig`). Lives behind createOpenScreenChatModel.

import { getProviderDefinition, type ProviderDefinition } from "../provider-registry";

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

export function getReasoningCapability(provider: string, model?: string): ReasoningCapability {
	const def: ProviderDefinition | undefined = getProviderDefinition(provider);
	const normalizedModel = normalizeModelName(model);

	if (provider === "openai-oauth") {
		return {
			supported: true,
			efforts: AGENT_REASONING_EFFORTS,
			defaultEffort: "medium",
			strategy: "custom-openai-account",
		};
	}
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
	if (
		def?.id === "anthropic" &&
		(normalizedModel.startsWith("MiniMax-M3") || isAnthropicReasoningModel(normalizedModel))
	) {
		return {
			supported: true,
			efforts: ANTHROPIC_REASONING_EFFORTS,
			defaultEffort: "medium",
			strategy: "anthropic-thinking",
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
	if (isOpenAIReasoningModel(model)) return true;
	if (
		model.startsWith("anthropic/") &&
		isAnthropicReasoningModel(model.slice("anthropic/".length))
	) {
		return true;
	}
	return /deepseek-r1/i.test(model) || /qwen.*thinking/i.test(model) || /grok-4/i.test(model);
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
