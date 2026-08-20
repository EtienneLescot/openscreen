// Renderer-side budget helper. Mirrors `electron/ai-edition/chat-compaction.ts`
// but inline so we don't drag electron/ into the renderer bundle.
//
// This is the renderer fallback for the context pill while native usage is loading
// or has never arrived. Desktop builds replace it with the main process's estimate
// of the windowed history it actually sends, which understands compaction.
//
// Either way it feeds the pill and NOTHING else -- no code decides anything from it.
// `DEFAULT_CHAT_BUDGET_TOKENS` is a made-up denominator (the app has no way to ask a
// provider how big its context window is), which is exactly why the automatic
// compaction that used to branch on the main-process twin is gone. Read the pill as
// "the conversation is about this big", never as "you are this close to a limit",
// and do not let this number regain a decision. Understanding compaction does not
// make the denominator any less invented.

const CHARS_PER_TOKEN = 4;

export interface ChatBudget {
	usedTokens: number;
	budgetTokens: number;
	ratio: number;
}

const DEFAULT_CHAT_BUDGET_TOKENS = 80_000;

export interface RenderableChatMessage {
	content: string;
}

// Content only, matching `estimateHistoryTokens` in the main process: tool-call
// names and summaries are rendered in the chat but stripped before the history is
// sent, so counting them here would bill text the model never sees.
function estimateTokens(messages: readonly RenderableChatMessage[]): number {
	let chars = 0;
	for (const m of messages) {
		chars += m.content.length;
	}
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function computeBudget(
	messages: readonly RenderableChatMessage[],
	budgetTokens: number = DEFAULT_CHAT_BUDGET_TOKENS,
): ChatBudget {
	const used = estimateTokens(messages);
	return { usedTokens: used, budgetTokens, ratio: budgetTokens > 0 ? used / budgetTokens : 0 };
}
