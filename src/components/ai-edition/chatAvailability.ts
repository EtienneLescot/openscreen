// "Can the user actually send a chat message right now?"
//
// Mirrors runChat's preflight (electron/ai-edition/chat-service.ts), so the
// composer is disabled exactly when a send would have failed.

import type { AiEditionLlmConfig } from "@/native/contracts";

export function canSendChat(
	llmConfig: AiEditionLlmConfig | null,
	connectedProviders: string[] | null,
): boolean {
	// Snapshot not landed yet: unknown, not none. refreshLlm() swallows its
	// errors, so pessimism here would strand the panel behind the welcome view.
	if (connectedProviders === null) return true;
	if (llmConfig === null) return false;
	// llmDisconnect resets the active config to provider: "".
	if (llmConfig.provider === "") return false;
	return connectedProviders.includes(llmConfig.provider);
}
