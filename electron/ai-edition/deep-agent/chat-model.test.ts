// Provider-alias normalization is invisible to tsc (every branch takes the same
// string type), so it gets a runtime check.
//
// The openai-oauth / copilot-proxy suites that lived here went with those
// providers in 1.8.0 — see provider-registry.ts.

import { describe, expect, it } from "vitest";
import {
	ANTHROPIC_API_MAX_OUTPUT_TOKENS,
	createOpenScreenChatModel,
	messageContentToText,
	messageContentToThinking,
} from "./chat-model";

/** ChatOpenAI keeps the `configuration` bag it was constructed with on
 * `clientConfig`; that is where the base URL and default headers land. */
function clientConfig(model: unknown): Record<string, unknown> {
	return (model as { clientConfig?: Record<string, unknown> }).clientConfig ?? {};
}

describe("createOpenScreenChatModel — provider aliases", () => {
	it("routes the `claude` alias to the Anthropic SDK, not the OpenAI fallback", async () => {
		const model = await createOpenScreenChatModel({
			provider: "claude",
			model: "claude-sonnet-4-5",
			apiKey: "sk-ant-test",
		});
		expect(model.constructor.name).toBe("ChatAnthropic");
	});

	it("routes the `gemini` alias to the Google OpenAI-compat base URL", async () => {
		const model = await createOpenScreenChatModel({
			provider: "gemini",
			model: "gemini-2.5-pro",
			apiKey: "test-key",
		});
		expect(clientConfig(model).baseURL).toBe(
			"https://generativelanguage.googleapis.com/v1beta/openai",
		);
	});
});

describe("createOpenScreenChatModel — Anthropic-wire output budget", () => {
	// Regression for #181: ChatAnthropic's default maxTokens table only knows
	// Claude slugs (16k); anything else — MiniMax-M3 included — falls back to
	// 4096. With adaptive thinking on, a cold-start turn can spend that whole
	// budget on reasoning and truncate before any text block, surfacing as
	// "Empty response from model" on the first call only.
	function maxTokens(model: unknown): number | undefined {
		return (model as { maxTokens?: number }).maxTokens;
	}

	for (const provider of ["minimax", "minimax-token-plan"]) {
		it(`sets an explicit maxTokens on the ${provider} ChatAnthropic`, async () => {
			const model = await createOpenScreenChatModel({
				provider,
				model: "MiniMax-M3",
				apiKey: "test-key",
			});
			expect(model.constructor.name).toBe("ChatAnthropic");
			expect(maxTokens(model)).toBe(ANTHROPIC_API_MAX_OUTPUT_TOKENS);
		});
	}

	it("floors maxTokens for non-Claude models on the anthropic provider", async () => {
		const model = await createOpenScreenChatModel({
			provider: "anthropic",
			model: "some-self-hosted-model",
			apiKey: "sk-ant-test",
			baseUrl: "https://anthropic.example.internal",
		});
		expect(maxTokens(model)).toBe(ANTHROPIC_API_MAX_OUTPUT_TOKENS);
	});

	it("keeps LangChain's per-model default for known Claude slugs", async () => {
		// claude-3-haiku's hard output limit is 4096 — overriding it with 16k
		// would make the API reject every request for this model.
		const legacy = await createOpenScreenChatModel({
			provider: "anthropic",
			model: "claude-3-haiku-20240307",
			apiKey: "sk-ant-test",
		});
		expect(maxTokens(legacy)).toBe(4096);

		const current = await createOpenScreenChatModel({
			provider: "anthropic",
			model: "claude-haiku-4-5",
			apiKey: "sk-ant-test",
		});
		expect(maxTokens(current)).toBe(ANTHROPIC_API_MAX_OUTPUT_TOKENS);
	});
});

describe("messageContentToText", () => {
	it("passes a plain string through", () => {
		expect(messageContentToText("hello")).toBe("hello");
	});

	it("concatenates the text parts of a content array and skips non-text", () => {
		expect(messageContentToText(["a", { type: "text", text: "b" }, { type: "image" }])).toBe("ab");
	});

	it("returns an empty string for anything else", () => {
		expect(messageContentToText(null)).toBe("");
		expect(messageContentToText(42)).toBe("");
	});
});

describe("messageContentToThinking", () => {
	// Anthropic/MiniMax thinking blocks land in AIMessageChunk content arrays
	// as `{type: "thinking", thinking: "..."}` parts (see @langchain/anthropic
	// message_outputs.js — `thinking_delta` SSE events). The extractor has to
	// pull them out so the chat panel can stream them separately; text parts
	// stay on the messageContentToText path.
	it("concatenates thinking parts in array order", () => {
		expect(
			messageContentToThinking([
				{ type: "thinking", thinking: "step one. " },
				{ type: "text", text: "should be ignored" },
				{ type: "thinking", thinking: "step two." },
			]),
		).toBe("step one. step two.");
	});

	it("ignores redacted_thinking blocks (encrypted reasoning the provider hides)", () => {
		// ChatAnthropic surfaces encrypted reasoning as parts of type
		// "redacted_thinking" — we don't have a string to display, so skip.
		expect(
			messageContentToThinking([
				{ type: "thinking", thinking: "visible. " },
				{ type: "redacted_thinking" },
				{ type: "thinking", thinking: "more visible." },
			]),
		).toBe("visible. more visible.");
	});

	it("returns an empty string for a plain string or non-array input", () => {
		expect(messageContentToThinking("not a list")).toBe("");
		expect(messageContentToThinking(null)).toBe("");
		expect(messageContentToThinking(42)).toBe("");
	});

	it("returns an empty string when there are no thinking parts", () => {
		expect(messageContentToThinking([{ type: "text", text: "answer" }])).toBe("");
		expect(messageContentToThinking([])).toBe("");
	});
});
