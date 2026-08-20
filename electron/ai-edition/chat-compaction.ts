// Message-history compaction: fold the older half of a conversation into one
// "Earlier context" summary. The summary is an LLM call (no tools, plain text)
// using the active provider.
//
// ponytail: compaction is MANUAL ONLY, and there is no overflow heuristic.
// There used to be one — compact automatically once the history passed 70% of
// `DEFAULT_BUDGET_TOKENS = 80_000`. That 80k was invented: the app has no
// per-model context window, so the number could not be right for anything. It
// was far too small for Gemini's 1M window (throwing away context at 5% fill,
// and paying a blocking summarizer call to do it) and would be too large for
// something small. It is the same mistake `getTranscript` made with its 800
// segments, and it gets the same answer: a guessed limit is deleted, not
// retuned. Until the app can ask a provider for the real window, the only
// honest trigger is a person deciding they want it, which is the button.

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
 * The denominator of the context pill in the chat panel, and nothing else —
 * no code branches on it any more. It is still a made-up number, so it must
 * never regain a decision: read it as "the conversation is about this big",
 * not as "you are this close to a limit".
 */
export const DEFAULT_BUDGET_TOKENS = 80_000;

/** Estimate token count for a flat list of messages. */
export function estimateHistoryTokens(messages: AiEditionChatMessage[]): number {
	let chars = 0;
	for (const m of messages) {
		// Content only. `chat-service` maps the history to `{role, content}` before it
		// sends it, so a message's tool-call names and summaries never reach the model --
		// billing them here inflated the pill with text nobody pays for. The two
		// compaction comparisons are unaffected: both sides were counted the same way.
		chars += m.content.length;
	}
	// 4 chars per token (rough).
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
 * Where a compaction should cut, or `null` when there is nothing to fold.
 *
 * The only refusal left is "fewer than 4 messages": that is not a guess about
 * anyone's context window, it is that summarizing one exchange into a summary
 * cannot make it shorter. Everything else is the caller's decision.
 */
export function compactionSplitIndex(messages: AiEditionChatMessage[]): number | null {
	if (messages.length < 4) return null;

	// Split roughly in half. Snap to a user-message boundary so the model
	// doesn't see a half-turn after compaction.
	const split = Math.floor(messages.length / 2);
	for (let i = split; i < messages.length; i += 1) {
		if (messages[i]?.role === "user") return i;
	}
	return split;
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
	const tail = messages.slice(splitIndex);
	const summaryMessage: AiEditionChatMessage = {
		id: `summary_${Date.now()}`,
		role: "assistant",
		content: summary,
		createdAt: summaryAt,
	};
	return [summaryMessage, ...tail];
}

/** True only when a proposed compaction strictly reduces estimated context use. */
export function compactionReducesHistory(
	original: AiEditionChatMessage[],
	compacted: AiEditionChatMessage[],
): boolean {
	return estimateHistoryTokens(compacted) < estimateHistoryTokens(original);
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
