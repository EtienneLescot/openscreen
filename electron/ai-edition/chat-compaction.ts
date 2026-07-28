// Context-budget heuristic + message-history compaction. Mirrors axcut's
// "compact-on-overflow" approach in spirit (sliding window with summary),
// but kept simple: char-based token estimate + a manual Compact button.
//
// Chat-service calls `shouldCompact` before each new turn; when the heuristic
// trips, `compactHistory` summarizes the older half of the conversation and
// returns a new history list to feed the model. The summary itself is an
// LLM call (no tools, plain text → JSON summary) using the active provider.

import type { AiEditionChatMessage } from "../../src/native/contracts";

// ponytail: rough 4-chars-per-token heuristic. Models vary, but for a
// "should we compact yet" gate this is plenty accurate enough. Ceiling:
// replace with the provider's tokenizer when we hit the 2nd-order regression
// where users notice.
const CHARS_PER_TOKEN = 4;

export interface CompactionBudget {
	usedTokens: number;
	budgetTokens: number;
	ratio: number;
}

/**
 * Default budget. Real providers run 100k+ contexts, but we leave headroom
 * for tool-call payload + system prompt. Adjust per provider if needed.
 */
export const DEFAULT_BUDGET_TOKENS = 80_000;

/** Estimate token count for a flat list of messages. */
export function estimateHistoryTokens(messages: AiEditionChatMessage[]): number {
	let chars = 0;
	for (const m of messages) {
		// 4 chars per token + 4 tokens per message overhead (rough).
		chars += m.content.length;
		for (const tc of m.toolCalls ?? [])
			chars += (tc.name?.length ?? 0) + (tc.summary?.length ?? 0) + 16;
	}
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function budgetSnapshot(
	messages: AiEditionChatMessage[],
	budgetTokens: number = DEFAULT_BUDGET_TOKENS,
): CompactionBudget {
	const used = estimateHistoryTokens(messages);
	return {
		usedTokens: used,
		budgetTokens,
		ratio: budgetTokens > 0 ? used / budgetTokens : 0,
	};
}

/**
 * Decide whether the chat history should be compacted before the next turn.
 * Returns the boundary index where compaction should cut (older half).
 */
export function shouldCompact(
	messages: AiEditionChatMessage[],
	budgetTokens: number = DEFAULT_BUDGET_TOKENS,
	thresholdRatio = 0.7,
): { compact: boolean; splitIndex: number } | null {
	if (messages.length < 4) return null;
	const budget = budgetSnapshot(messages, budgetTokens);
	if (budget.ratio < thresholdRatio) return null;

	// Split roughly in half. Snap to a user-message boundary so the model
	// doesn't see a half-turn after compaction.
	const split = Math.floor(messages.length / 2);
	for (let i = split; i < messages.length; i += 1) {
		if (messages[i]?.role === "user") return { compact: true, splitIndex: i };
	}
	return { compact: true, splitIndex: split };
}

/**
 * Build a new history: leading "Earlier context" summary + tail of recent
 * messages. Returns the messages array the chat-service should keep.
 */
export function applyCompaction(
	messages: AiEditionChatMessage[],
	splitIndex: number,
	summary: string,
	summaryAt: string,
): AiEditionChatMessage[] {
	const head = messages.slice(0, splitIndex);
	const tail = messages.slice(splitIndex);
	const summaryMessage: AiEditionChatMessage = {
		id: `summary_${Date.now()}`,
		role: "assistant",
		content: summary,
		createdAt: summaryAt,
	};
	return [...head, summaryMessage, ...tail];
}

/** System-prompt addendum to ask the LLM to compact its own history. */
export const COMPACTION_SYSTEM_PROMPT = [
	"Summarize the conversation so far in 8 short bullet points and 2 short paragraphs.",
	"Keep user goals, decisions, todos, and any document edits that were agreed on.",
	"Drop empty pleasantries; preserve concrete numbers, timecodes, and names.",
	"Reply with plain text. No JSON, no headings.",
].join(" ");

/**
 * Build the user-prompt that asks the model to summarize `messages` and
 * produce the body for the "Earlier context" message.
 */
export function buildCompactionPrompt(messages: AiEditionChatMessage[]): string {
	const dialogue = messages
		.map((m) => {
			const label = m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : "Tool";
			const tools = m.toolCalls?.length
				? `\n  tools: ${m.toolCalls.map((t) => `${t.name} (${t.summary})`).join("; ")}`
				: "";
			return `${label}: ${m.content}${tools}`;
		})
		.join("\n\n");
	return `Summarize the conversation below for a follow-up assistant that only sees the recent turns.\n\n${dialogue}`;
}
