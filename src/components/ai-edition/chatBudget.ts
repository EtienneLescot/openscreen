// Renderer-side budget helper. Mirrors `electron/ai-edition/chat-compaction.ts`
// but inline so we don't drag electron/ into the renderer bundle.
//
// This is the renderer fallback for the context pill while native usage is
// loading or unavailable. Desktop builds replace it with the main process's
// model-message estimate, which understands compaction; no code makes an
// automatic compaction decision from either value.

const CHARS_PER_TOKEN = 4;

export interface ChatBudget {
	usedTokens: number;
	budgetTokens: number;
	ratio: number;
}

const DEFAULT_CHAT_BUDGET_TOKENS = 80_000;

export interface RenderableChatMessage {
	content: string;
	toolCalls?: Array<{ name?: string; summary?: string }>;
}

function estimateTokens(messages: readonly RenderableChatMessage[]): number {
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
	messages: readonly RenderableChatMessage[],
	budgetTokens: number = DEFAULT_CHAT_BUDGET_TOKENS,
): ChatBudget {
	const used = estimateTokens(messages);
	return { usedTokens: used, budgetTokens, ratio: budgetTokens > 0 ? used / budgetTokens : 0 };
}
