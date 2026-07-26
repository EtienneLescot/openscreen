// The Codex account header and the provider-alias normalization are both
// invisible to tsc (an optional field that nothing reads still typechecks),
// so they get a runtime check.

import { describe, expect, it, vi } from "vitest";
import { createOpenScreenChatModel, messageContentToText } from "./chat-model";

vi.mock("../llm-provider-auth", () => ({
	exchangeGithubCopilotRuntimeToken: vi.fn(async () => ({
		token: "runtime-token",
		expiresAt: Date.now() + 60_000,
		baseUrl: "https://api.business.githubcopilot.com",
	})),
	GITHUB_COPILOT_USER_AGENT: "GitHubCopilotChat/0.26.7",
	GITHUB_COPILOT_EDITOR_VERSION: "vscode/1.96.2",
	GITHUB_COPILOT_PLUGIN_VERSION: "copilot-chat/0.26.7",
}));

/** ChatOpenAI keeps the `configuration` bag it was constructed with on
 * `clientConfig`; that is where the base URL and default headers land. */
function clientConfig(model: unknown): Record<string, unknown> {
	return (model as { clientConfig?: Record<string, unknown> }).clientConfig ?? {};
}

describe("createOpenScreenChatModel — openai-oauth (Codex)", () => {
	it("sends chatgpt-account-id, which the gateway requires for an OAuth token", async () => {
		const model = await createOpenScreenChatModel({
			provider: "openai-oauth",
			model: "gpt-5",
			apiKey: "oauth-access-token",
			accountId: "acct_123",
		});
		expect(clientConfig(model).defaultHeaders).toMatchObject({
			"chatgpt-account-id": "acct_123",
		});
	});

	it("omits the header entirely when there is no account id", async () => {
		const model = await createOpenScreenChatModel({
			provider: "openai-oauth",
			model: "gpt-5",
			apiKey: "oauth-access-token",
		});
		expect(clientConfig(model).defaultHeaders).toBeUndefined();
	});
});

describe("createOpenScreenChatModel — copilot-proxy", () => {
	it("uses the exchanged runtime token and the base URL it names", async () => {
		const model = await createOpenScreenChatModel({
			provider: "copilot-proxy",
			model: "gpt-4.1",
			apiKey: "github-pat",
		});
		expect(clientConfig(model).baseURL).toBe("https://api.business.githubcopilot.com");
		expect(clientConfig(model).defaultHeaders).toMatchObject({
			"Editor-Version": "vscode/1.96.2",
			"Openai-Intent": "copilot-gpt-chat-completions",
		});
	});
});

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
