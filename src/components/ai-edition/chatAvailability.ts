// "Can the user actually send a chat message right now?"
//
// Both inputs come from the `aiEdition.llmGetSnapshot` IPC: the selected
// LLM config (may be null, or carry an empty-string provider after a
// disconnect) and the list of providers that currently have valid
// credentials. The chat composer is usable only when those two agree — a
// stale config that points at a provider with no credentials should look
// the same as "nothing set up yet" to the UI.
//
// Kept as a tiny pure function so the welcome-vs-composer gating in
// <LeftPanel /> can be tested in isolation.

import type { AiEditionLlmConfig } from "@/native/contracts";

export function canSendChat(
	llmConfig: AiEditionLlmConfig | null,
	connectedProviders: string[],
): boolean {
	if (llmConfig === null) return false;
	if (llmConfig.provider === "") return false;
	return connectedProviders.includes(llmConfig.provider);
}
