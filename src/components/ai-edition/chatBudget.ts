// Renderer-side budget helper. Mirrors `electron/ai-edition/chat-compaction.ts`
// but inline so we don't drag electron/ into the renderer bundle.
//
// ponytail: 4 chars per token is plenty accurate for a "should we compact yet"
// gate. The estimation lives in the main process too (chat-service
// `getSessionBudget`); this duplicate is a small price for keeping the
// renderer free of electron/ imports.

const CHARS_PER_TOKEN = 4;

export interface ChatBudget {
	usedTokens: number;
	budgetTokens: number;
	ratio: number;
}

export const DEFAULT_CHAT_BUDGET_TOKENS = 80_000;

export interface RenderableChatMessage {
	content: string;
	toolCalls?: Array<{ name?: string; summary?: string }>;
}

export function estimateTokens(messages: RenderableChatMessage[]): number {
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
