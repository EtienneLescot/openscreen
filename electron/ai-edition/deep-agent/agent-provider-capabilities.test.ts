// Covers the reasoning-effort matrix that survived the llm-call.ts deletion.
// The capability helpers now live in chat-model.ts (folded from
// agent-provider-capabilities.ts); these keep the per-provider wiring pinned.

import { describe, expect, it } from "vitest";
import {
	buildLangChainReasoningOptions,
	getReasoningCapability,
	normalizeReasoningEffortForCapability,
} from "./chat-model";

describe("getReasoningCapability", () => {
	it("turns reasoning off for non-reasoning OpenAI models", () => {
		expect(getReasoningCapability("openai", "gpt-4o").supported).toBe(false);
		expect(getReasoningCapability("openai", "o3-mini").supported).toBe(true);
		expect(getReasoningCapability("openai", "gpt-5-mini").supported).toBe(true);
	});

	it("uses the thinking strategy for Anthropic 4.x and not for 3.x", () => {
		expect(getReasoningCapability("anthropic", "claude-sonnet-4-5").strategy).toBe(
			"anthropic-thinking",
		);
		expect(getReasoningCapability("anthropic", "claude-3-haiku-20240307").supported).toBe(false);
	});

	it("treats MiniMax thinking as binary, and Gemini 2.5+ as thinking-capable", () => {
		expect(getReasoningCapability("minimax", "MiniMax-M3").strategy).toBe("minimax-thinking");
		expect(getReasoningCapability("google", "gemini-2.5-pro").supported).toBe(true);
		expect(getReasoningCapability("google", "gemini-1.5-pro").supported).toBe(false);
	});

	it("only supports OpenRouter reasoning for reasoning-capable slugs", () => {
		expect(getReasoningCapability("openrouter", "anthropic/claude-3.5-sonnet").supported).toBe(
			false,
		);
		expect(getReasoningCapability("openrouter", "openai/gpt-5").supported).toBe(true);
	});

	it("returns unsupported for unknown providers", () => {
		expect(getReasoningCapability("nope", "x").supported).toBe(false);
		expect(getReasoningCapability("").supported).toBe(false);
	});
});

describe("normalizeReasoningEffortForCapability", () => {
	it("collapses efforts the provider does not expose", () => {
		const openai = getReasoningCapability("openai", "o4-mini");
		expect(normalizeReasoningEffortForCapability("minimal", openai)).toBe("low");
		expect(normalizeReasoningEffortForCapability("xhigh", openai)).toBe("high");
	});

	it("falls back to the default effort when none is selected", () => {
		const openai = getReasoningCapability("openai", "o4-mini");
		expect(normalizeReasoningEffortForCapability(undefined, openai)).toBe("medium");
	});
});

describe("buildLangChainReasoningOptions", () => {
	it("wires OpenAI effort through the Responses API", () => {
		expect(buildLangChainReasoningOptions("openai", "o4-mini", "high")).toEqual({
			reasoning: { effort: "high" },
			useResponsesApi: true,
		});
	});

	it("wires OpenRouter reasoning through modelKwargs", () => {
		expect(buildLangChainReasoningOptions("openrouter", "openai/gpt-5", "medium")).toEqual({
			modelKwargs: {
				reasoning: { effort: "medium" },
				include_reasoning: true,
			},
		});
	});

	it("wires Gemini thinking through thinkingConfig", () => {
		const opts = buildLangChainReasoningOptions("google", "gemini-2.5-pro", "high");
		expect(opts.thinkingConfig).toMatchObject({ includeThoughts: true, thinkingLevel: "HIGH" });
	});

	it("emits an Anthropic thinking block", () => {
		const opts = buildLangChainReasoningOptions("anthropic", "claude-sonnet-4-5", "xhigh");
		expect(opts.thinking).toBeDefined();
	});

	it("returns nothing when the effort is none or the provider has no reasoning", () => {
		expect(buildLangChainReasoningOptions("openai", "o4-mini", "none")).toEqual({});
		expect(buildLangChainReasoningOptions("mistral", "mistral-large-latest", "high")).toEqual({});
	});
});
