// Renderer-side budget helper. Mirrors `electron/ai-edition/chat-compaction.ts`
// but inline so we don't drag electron/ into the renderer bundle.
//
// This feeds the context pill and NOTHING else — no code decides anything from
// it. `DEFAULT_CHAT_BUDGET_TOKENS` is a made-up denominator (the app has no way
// to ask a provider how big its context window is), which is exactly why the
// automatic compaction that used to branch on the main-process twin is gone.
// Read the pill as "the conversation is about this big", never as "you are this
// close to a limit", and do not let this number regain a decision.

const CHARS_PER_TOKEN = 4;

export interface ChatBudget {
	usedTokens: number;
	budgetTokens: number;
	ratio: number;
}

const DEFAULT_CHAT_BUDGET_TOKENS = 80_000;

interface RenderableChatMessage {
	content: string;
	toolCalls?: Array<{ name?: string; summary?: string }>;
}

function estimateTokens(messages: RenderableChatMessage[]): number {
	let chars = 0;
	for (const m of messages) {
		chars += m.content.length;
		for (const tc of m.toolCalls ?? []) {
			chars += (tc.name?.length ?? 0) + (tc.summary?.length ?? 0) + 16;
		}
	}
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function computeBudget(
	messages: RenderableChatMessage[],
	budgetTokens: number = DEFAULT_CHAT_BUDGET_TOKENS,
): ChatBudget {
	const used = estimateTokens(messages);
	return { usedTokens: used, budgetTokens, ratio: budgetTokens > 0 ? used / budgetTokens : 0 };
}
