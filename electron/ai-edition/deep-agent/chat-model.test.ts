// Provider-alias normalization is invisible to tsc (every branch takes the same
// string type), so it gets a runtime check.
//
// The openai-oauth / copilot-proxy suites that lived here went with those
// providers in 1.8.0 — see provider-registry.ts.

import { describe, expect, it } from "vitest";
import { createOpenScreenChatModel, messageContentToText } from "./chat-model";

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
