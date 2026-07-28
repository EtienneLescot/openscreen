// Per-provider reasoning-effort capabilities. Mirrors axcut's
// apps/server/src/llm/agent-provider-capabilities.ts. We don't use LangChain
// here — direct fetch in llm-call.ts — so the export shape is the bits that
// actually differ in the HTTP wire layer: `extraBody`, `extraHeaders`, plus
// the chosen `strategy` so call sites can branch.
//
// Each provider's reasoning surface area is different:
//   - openai / openai-compatible: only o*-series + gpt-5*; wire `reasoning.effort`
//     via the Responses API (`useResponsesApi = true`).
//   - anthropic: claude 3.7+ + claude-(opus|sonnet|haiku)-4*; wire `thinking`
//     block with adaptive mode for opus/sonnet 4.6/4.7, budget_tokens for the
//     rest. Effort maps to budget tiers; `xhigh` raises the budget.
//   - openrouter: passthrough — wire `reasoning` modelKwargs + include_reasoning
//     for any reasoning-capable model slug.
//   - google (Gemini): wire `thinkingLevel` + `thinkingBudget` in
//     `extra_body.google.thinking_config`.
//   - openai-oauth (Codex): full 6-step effort range via the Responses API.

import { normalizeProviderId, type ReasoningEffort } from "./provider-registry";

export type ReasoningStrategy =
	| "openai-responses"
	| "anthropic-thinking"
	| "minimax-thinking"
	| "openrouter-reasoning"
	| "google-thinking"
	| "custom-openai-account"
	| "none";

export interface ReasoningCapability {
	supported: boolean;
	strategy: ReasoningStrategy;
	/** Effort list the provider actually accepts. */
	efforts: readonly ReasoningEffort[];
	defaultEffort: ReasoningEffort;
}

export interface ReasoningCallOptions {
	strategy: ReasoningStrategy;
	/** Request body bits to merge into the outgoing fetch body. */
	extraBody?: Record<string, unknown>;
	/** Request body bits to merge into the outgoing fetch body. Anthropic's
	 * thinking block goes in `body.thinking` (not `body.reasoning`). */
	requestBodyPatch?: {
		thinking?: Record<string, unknown>;
		outputConfig?: Record<string, unknown>;
	};
	/** Headers to add beyond Authorization (e.g. chatgpt-account-id). */
	extraHeaders?: Record<string, string>;
	/** True when the provider wants the Responses-API endpoint instead of
	 * the OpenAI chat-completions path. */
	useResponsesApi?: boolean;
	/** Effort actually sent downstream after strategy normalization. */
	effort?: ReasoningEffort;
}

const OPENAI_REASONING_EFFORTS: readonly ReasoningEffort[] = ["none", "low", "medium", "high"];
const ANTHROPIC_REASONING_EFFORTS: readonly ReasoningEffort[] = [
	"none",
	"low",
	"medium",
	"high",
	"xhigh",
];
const OPENROUTER_REASONING_EFFORTS: readonly ReasoningEffort[] = ["none", "low", "medium", "high"];
const GOOGLE_REASONING_EFFORTS: readonly ReasoningEffort[] = ["none", "low", "medium", "high"];
const CODEX_REASONING_EFFORTS: readonly ReasoningEffort[] = [
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
];

export function getReasoningCapability(provider: string, model?: string): ReasoningCapability {
	const id = normalizeProviderId(provider);
	if (!id) return { supported: false, strategy: "none", efforts: ["none"], defaultEffort: "none" };
	if (id === "openai-oauth") {
		return {
			supported: true,
			strategy: "custom-openai-account",
			efforts: CODEX_REASONING_EFFORTS,
			defaultEffort: "medium",
		};
	}
	if ((id === "openai" || id === "openai-compatible") && isOpenAIReasoningModel(model)) {
		return {
			supported: true,
			strategy: "openai-responses",
			efforts: OPENAI_REASONING_EFFORTS,
			defaultEffort: "medium",
		};
	}
	if (id === "anthropic" && isAnthropicReasoningModel(model)) {
		return {
			supported: true,
			strategy: "anthropic-thinking",
			efforts: ANTHROPIC_REASONING_EFFORTS,
			defaultEffort: "medium",
		};
	}
	if (id === "openrouter" && isOpenRouterReasoningModel(model)) {
		return {
			supported: true,
			strategy: "openrouter-reasoning",
			efforts: OPENROUTER_REASONING_EFFORTS,
			defaultEffort: "medium",
		};
	}
	if (id === "google" && isGeminiThinkingModel(model)) {
		return {
			supported: true,
			strategy: "google-thinking",
			efforts: GOOGLE_REASONING_EFFORTS,
			defaultEffort: "medium",
		};
	}
	if (id === "minimax" || id === "minimax-token-plan") {
		// MiniMax's thinking block is binary — `{type: "adaptive"}` (on) or
		// `{type: "disabled"}` (off, ignored on M2.x which is always-on) — not
		// the OpenAI `reasoning.effort` field, and no budget_tokens tiers like
		// native Anthropic.
		return {
			supported: true,
			strategy: "minimax-thinking",
			efforts: ANTHROPIC_REASONING_EFFORTS,
			defaultEffort: "medium",
		};
	}
	return { supported: false, strategy: "none", efforts: ["none"], defaultEffort: "none" };
}

/**
 * Build the request-side wiring for a given provider/model/effort. Returned
 * options are merged into `callLlm`'s outgoing body/headers; an empty object
 * means "no reasoning wire-up" and is safe to apply unconditionally.
 */
export function getReasoningCallOptions(
	provider: string,
	model: string | undefined,
	selected: ReasoningEffort | undefined,
): ReasoningCallOptions {
	const cap = getReasoningCapability(provider, model);
	if (!cap.supported) {
		return { strategy: "none" };
	}
	const effort = normalizeEffortForCapability(selected, cap);
	if (!effort || effort === "none") {
		return { strategy: cap.strategy };
	}
	switch (cap.strategy) {
		case "openai-responses":
			return {
				strategy: cap.strategy,
				effort,
				extraBody: { reasoning: { effort: toOpenAIEffort(effort) } },
				useResponsesApi: true,
			};
		case "anthropic-thinking": {
			const adaptive = isAnthropicAdaptiveThinkingModel(model);
			return {
				strategy: cap.strategy,
				effort,
				requestBodyPatch: adaptive
					? {
							thinking: { type: "adaptive", display: "summarized" },
							outputConfig: { effort: toAnthropicEffort(effort) },
						}
					: {
							thinking: {
								type: "enabled",
								budget_tokens: toAnthropicBudgetTokens(effort),
								display: "summarized",
							},
						},
			};
		}
		case "minimax-thinking":
			return {
				strategy: cap.strategy,
				effort,
				requestBodyPatch: { thinking: { type: "adaptive" } },
			};
		case "openrouter-reasoning":
			return {
				strategy: cap.strategy,
				effort,
				extraBody: {
					reasoning: { effort: toOpenAIEffort(effort) },
					include_reasoning: true,
				},
			};
		case "google-thinking":
			return {
				strategy: cap.strategy,
				effort,
				extraBody: {
					thinkingConfig: {
						includeThoughts: true,
						thinkingLevel: toGoogleThinkingLevel(effort),
						thinkingBudget: toGoogleThinkingBudget(effort),
					},
					google: {
						thinking_config: {
							include_thoughts: true,
							thinking_budget: toGoogleThinkingBudget(effort),
						},
					},
				},
			};
		case "custom-openai-account":
			// Codex speaks its own Responses dialect; the chat path handles the
			// effort directly. `useResponsesApi` is set so the Codex transport
			// can branch on it.
			return {
				strategy: cap.strategy,
				effort,
				extraBody: { reasoning_effort: effort },
				useResponsesApi: true,
			};
		default:
			return { strategy: cap.strategy };
	}
}

function normalizeEffortForCapability(
	selected: ReasoningEffort | undefined,
	cap: ReasoningCapability,
): ReasoningEffort | undefined {
	if (!cap.supported) return undefined;
	if (!selected) return cap.defaultEffort;
	if (cap.efforts.includes(selected)) return selected;
	if (selected === "minimal" && cap.efforts.includes("low")) return "low";
	if (selected === "xhigh" && cap.efforts.includes("high")) return "high";
	return cap.defaultEffort;
}

function isOpenAIReasoningModel(model?: string): boolean {
	const normalized = normalizeModelName(model);
	return /^(o\d|o\d-|o\d\.|gpt-5|gpt-5-|gpt-5\.)/.test(normalized);
}

function isAnthropicReasoningModel(model?: string): boolean {
	const normalized = normalizeModelName(model);
	return (
		/^claude-(opus|sonnet|haiku)-4/.test(normalized) ||
		/^claude-3-7/.test(normalized) ||
		normalized.includes("claude-3.7")
	);
}

function isAnthropicAdaptiveThinkingModel(model?: string): boolean {
	const normalized = normalizeModelName(model);
	return (
		/^claude-(opus|sonnet)-4-[67]/.test(normalized) ||
		/^claude-(opus|sonnet)-4\.(6|7)/.test(normalized)
	);
}

function isGeminiThinkingModel(model?: string): boolean {
	const normalized = normalizeModelName(model);
	return normalized.startsWith("gemini-2.5") || normalized.startsWith("gemini-3");
}

function isOpenRouterReasoningModel(model?: string): boolean {
	const normalized = normalizeModelName(model);
	return (
		isOpenAIReasoningModel(normalized.replace(/^openai\//, "")) ||
		isAnthropicReasoningModel(normalized.replace(/^anthropic\//, "")) ||
		normalized.includes("/deepseek-r1") ||
		normalized.includes("deepseek/deepseek-r1") ||
		(normalized.includes("/qwen") && normalized.includes("thinking")) ||
		normalized.includes("/grok-4") ||
		normalized.includes("grok-4")
	);
}

function toOpenAIEffort(effort: ReasoningEffort): "low" | "medium" | "high" {
	if (effort === "high" || effort === "xhigh") return "high";
	if (effort === "medium") return "medium";
	return "low";
}

function toAnthropicEffort(effort: ReasoningEffort): "low" | "medium" | "high" | "xhigh" {
	if (effort === "xhigh") return "xhigh";
	if (effort === "high") return "high";
	if (effort === "medium") return "medium";
	return "low";
}

function toAnthropicBudgetTokens(effort: ReasoningEffort): number {
	if (effort === "xhigh") return 16_000;
	if (effort === "high") return 10_000;
	if (effort === "medium") return 4_000;
	return 1_024;
}

function toGoogleThinkingLevel(effort: ReasoningEffort): "LOW" | "MEDIUM" | "HIGH" {
	if (effort === "high" || effort === "xhigh") return "HIGH";
	if (effort === "medium") return "MEDIUM";
	return "LOW";
}

function toGoogleThinkingBudget(effort: ReasoningEffort): number {
	if (effort === "high" || effort === "xhigh") return 8_192;
	if (effort === "medium") return 4_096;
	return 1_024;
}

function normalizeModelName(model?: string): string {
	return model?.trim().toLowerCase() ?? "";
}
