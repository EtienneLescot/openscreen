import { describe, expect, it } from "vitest";
import { getReasoningCallOptions, getReasoningCapability } from "./agent-provider-capabilities";

describe("getReasoningCapability", () => {
	it("returns the 6-step Codex effort range for openai-oauth", () => {
		const cap = getReasoningCapability("openai-oauth", "gpt-5");
		expect(cap.supported).toBe(true);
		expect(cap.strategy).toBe("custom-openai-account");
		expect(cap.efforts).toEqual(["none", "minimal", "low", "medium", "high", "xhigh"]);
	});

	it("turns off reasoning for non-reasoning OpenAI models", () => {
		expect(getReasoningCapability("openai", "gpt-4o").supported).toBe(false);
		expect(getReasoningCapability("openai", "gpt-3.5-turbo").supported).toBe(false);
	});

	it("matches o-series and gpt-5* OpenAI reasoning models", () => {
		expect(getReasoningCapability("openai", "o3-mini").supported).toBe(true);
		expect(getReasoningCapability("openai", "o4-mini").supported).toBe(true);
		expect(getReasoningCapability("openai", "gpt-5").supported).toBe(true);
		expect(getReasoningCapability("openai", "gpt-5-mini").supported).toBe(true);
	});

	it("Anthropic haiku/sonnet/opus 4.x reasoning models use thinking strategy", () => {
		const cap = getReasoningCapability("anthropic", "claude-sonnet-4-5");
		expect(cap.strategy).toBe("anthropic-thinking");
		expect(cap.efforts).toContain("xhigh");
	});

	it("Anthropic 3.x stays unsupported", () => {
		expect(getReasoningCapability("anthropic", "claude-3-haiku-20240307").supported).toBe(false);
	});

	it("Google Gemini 2.5/3.x models use thinking strategy", () => {
		expect(getReasoningCapability("google", "gemini-2.5-pro").supported).toBe(true);
		expect(getReasoningCapability("google", "gemini-3-flash-preview").supported).toBe(true);
		expect(getReasoningCapability("google", "gemini-1.5-pro").supported).toBe(false);
	});

	it("OpenRouter only supports reasoning for known reasoning-capable slug prefixes", () => {
		expect(getReasoningCapability("openrouter", "anthropic/claude-3.5-sonnet").supported).toBe(
			false,
		);
		expect(getReasoningCapability("openrouter", "anthropic/claude-sonnet-4-5").supported).toBe(
			true,
		);
		expect(getReasoningCapability("openrouter", "openai/gpt-5").supported).toBe(true);
		expect(getReasoningCapability("openrouter", "deepseek/deepseek-r1").supported).toBe(true);
	});

	it("aliases `claude` → `anthropic` and `gemini` → `google` for capability lookups", () => {
		expect(getReasoningCapability("claude", "claude-sonnet-4-5").supported).toBe(true);
		expect(getReasoningCapability("gemini", "gemini-2.5-flash").supported).toBe(true);
	});

	it("returns unsupported for unknown providers", () => {
		expect(getReasoningCapability("nope", "x").supported).toBe(false);
		expect(getReasoningCapability("").supported).toBe(false);
	});
});

describe("getReasoningCallOptions", () => {
	it("returns strategy=none when capability is unsupported", () => {
		expect(getReasoningCallOptions("mistral", "mistral-large-latest", "high").strategy).toBe(
			"none",
		);
	});

	it("openai-responses strategy maps effort to `{reasoning:{effort}}` and turns on Responses API", () => {
		const opt = getReasoningCallOptions("openai", "o4-mini", "high");
		expect(opt.strategy).toBe("openai-responses");
		expect(opt.useResponsesApi).toBe(true);
		expect(opt.extraBody).toEqual({ reasoning: { effort: "high" } });
	});

	it("openai-responses collapses `xhigh` to `high` (OpenAI has no xhigh tier)", () => {
		const opt = getReasoningCallOptions("openai", "o4-mini", "xhigh");
		expect(opt.effort).toBe("high");
	});

	it("openai-responses collapses `minimal` to `low`", () => {
		const opt = getReasoningCallOptions("openai", "o4-mini", "minimal");
		expect(opt.effort).toBe("low");
	});

	it("Anthropic adaptive-thinking mode for opus/sonnet 4.6/4.7", () => {
		const opt = getReasoningCallOptions("anthropic", "claude-opus-4-6", "high");
		expect(opt.strategy).toBe("anthropic-thinking");
		expect(opt.requestBodyPatch?.thinking).toEqual({
			type: "adaptive",
			display: "summarized",
		});
		expect(opt.requestBodyPatch?.outputConfig).toEqual({ effort: "high" });
	});

	it("Anthropic legacy-thinking mode (budget_tokens) for older 4.x models", () => {
		const opt = getReasoningCallOptions("anthropic", "claude-sonnet-4-5", "xhigh");
		expect(opt.requestBodyPatch?.thinking).toMatchObject({
			type: "enabled",
			budget_tokens: 16_000,
		});
	});

	it("OpenRouter uses `modelKwargs`-style reasoning + include_reasoning", () => {
		const opt = getReasoningCallOptions("openrouter", "openai/gpt-5", "medium");
		expect(opt.strategy).toBe("openrouter-reasoning");
		expect(opt.extraBody).toEqual({
			reasoning: { effort: "medium" },
			include_reasoning: true,
		});
	});

	it("Google Gemini wires thinking_level + thinking_budget through thinkingConfig + extra_body.google", () => {
		const opt = getReasoningCallOptions("google", "gemini-3-flash-preview", "high");
		expect(opt.strategy).toBe("google-thinking");
		expect(opt.extraBody).toEqual({
			thinkingConfig: {
				includeThoughts: true,
				thinkingLevel: "HIGH",
				thinkingBudget: 8_192,
			},
			google: {
				thinking_config: {
					include_thoughts: true,
					thinking_budget: 8_192,
				},
			},
		});
	});

	it("Codex effort round-trips through `reasoning_effort` and keeps the Responses-API flag", () => {
		const opt = getReasoningCallOptions("openai-oauth", "gpt-5", "minimal");
		expect(opt.strategy).toBe("custom-openai-account");
		expect(opt.effort).toBe("minimal");
		expect(opt.useResponsesApi).toBe(true);
		expect(opt.extraBody).toEqual({ reasoning_effort: "minimal" });
	});

	it("returns strategy with no body bits when effort is `none` (caller can still send it)", () => {
		const opt = getReasoningCallOptions("openai", "o4-mini", "none");
		expect(opt.strategy).toBe("openai-responses");
		expect(opt.extraBody).toBeUndefined();
	});
});
