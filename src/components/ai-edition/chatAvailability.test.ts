import { describe, expect, it } from "vitest";
import type { AiEditionLlmConfig } from "@/native/contracts";
import { canSendChat } from "./chatAvailability";

function cfg(provider: string, model = "gpt-4o-mini"): AiEditionLlmConfig {
	return { provider, model };
}

describe("canSendChat", () => {
	it("stays optimistic while the snapshot is still in flight", () => {
		// null connectedProviders = not loaded yet. Returning false here would
		// flash the welcome view on every mount, and leave it up for good when
		// llmGetSnapshot fails (refreshLlm swallows the error).
		expect(canSendChat(null, null)).toBe(true);
		expect(canSendChat(cfg("openai"), null)).toBe(true);
	});

	it("returns false when there is no config at all", () => {
		expect(canSendChat(null, [])).toBe(false);
	});

	it("returns false when the config is the post-disconnect reset (provider: '')", () => {
		// The disconnect flow in aiEditionService.llmDisconnect writes an
		// empty-string provider to the active config. We treat that the same
		// as "nothing selected" so the welcome view shows immediately.
		expect(canSendChat(cfg(""), ["minimax"])).toBe(false);
	});

	it("returns false when the active provider has no credentials", () => {
		// The user selected MiniMax-M3 then disconnected it. `connectedProviders`
		// is empty but the stale config still references minimax.
		expect(canSendChat(cfg("minimax"), [])).toBe(false);
	});

	it("returns false when other providers are connected but not the active one", () => {
		// Active config points at openai; only anthropic has credentials.
		// The user needs to switch the active provider via the model picker
		// (or reconnect openai) before they can chat.
		expect(canSendChat(cfg("openai"), ["anthropic"])).toBe(false);
	});

	it("returns true when the active provider is in the connected list", () => {
		expect(canSendChat(cfg("minimax"), ["minimax"])).toBe(true);
		expect(canSendChat(cfg("openai"), ["openai", "anthropic"])).toBe(true);
	});
});
