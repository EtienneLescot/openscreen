// "Can the user actually send a chat message right now?"
//
// Both inputs come from the `aiEdition.llmGetSnapshot` IPC: the selected
// LLM config (may be null, or carry an empty-string provider after a
// disconnect) and the list of providers that currently have valid
// credentials. The chat composer is usable only when those two agree — a
// stale config that points at a provider with no credentials should look
// the same as "nothing set up yet" to the UI.
//
// This mirrors `runChat`'s own preflight in electron/ai-edition/chat-service.ts
// (config present → provider known → credential resolves), so the composer is
// disabled exactly when a send would have failed.
//
// Kept as a tiny pure function so the welcome-vs-composer gating in
// <LeftPanel /> can be tested in isolation.

import type { AiEditionLlmConfig } from "@/native/contracts";

export function canSendChat(
	llmConfig: AiEditionLlmConfig | null,
	connectedProviders: string[] | null,
): boolean {
	// null = the snapshot has not landed yet, which is "unknown", not "none".
	// Treating it as none flashed the welcome view at every user on every mount
	// and, since refreshLlm() swallows its errors, locked the panel behind an
	// undismissable welcome whenever the IPC call failed. Staying optimistic
	// degrades to the pre-welcome behaviour instead: type, send, get the real
	// error from the main process.
	if (connectedProviders === null) return true;
	if (llmConfig === null) return false;
	if (llmConfig.provider === "") return false;
	return connectedProviders.includes(llmConfig.provider);
}
