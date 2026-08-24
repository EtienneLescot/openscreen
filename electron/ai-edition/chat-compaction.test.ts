import { describe, expect, it } from "vitest";
import type { AiEditionChatMessage } from "../../src/native/contracts";
import {
	applyCompaction,
	budgetSnapshot,
	buildCompactionPrompt,
	compactionReducesHistory,
	compactionSplitIndex,
	estimateHistoryTokens,
} from "./chat-compaction";

function msg(
	role: AiEditionChatMessage["role"],
	content: string,
	id = `${role}-${content.length}`,
): AiEditionChatMessage {
	return { id, role, content, createdAt: "2026-01-01T00:00:00.000Z" };
}

describe("estimateHistoryTokens", () => {
	it("returns 0 for an empty history", () => {
		expect(estimateHistoryTokens([])).toBe(0);
	});

	it("rounds char count to a token estimate (4 chars/token)", () => {
		const tokens = estimateHistoryTokens([msg("user", "x".repeat(400))]);
		expect(tokens).toBe(100);
	});

	it("does not bill tool calls, which are never sent", () => {
		// `chat-service` maps the history to `{role, content}` before handing it to the
		// provider, so a message's tool-call names and summaries are rendered in the
		// chat and then dropped. Counting them inflated the context pill with text
		// nobody pays for.
		const withTool = estimateHistoryTokens([
			{
				id: "a",
				role: "assistant",
				content: "x".repeat(400),
				createdAt: "2026-01-01T00:00:00.000Z",
				toolCalls: [{ name: "addTrim", summary: "y".repeat(400) }],
			},
		]);
		expect(withTool).toBe(100);
	});
});

describe("budgetSnapshot", () => {
	it("computes ratio clamped to >0", () => {
		const snap = budgetSnapshot([msg("user", "x".repeat(40_000))], 10_000);
		expect(snap.usedTokens).toBe(10_000);
		expect(snap.ratio).toBe(1);
	});
});

describe("compactionSplitIndex", () => {
	it("returns null for very short histories", () => {
		expect(compactionSplitIndex([msg("user", "hi")])).toBeNull();
	});

	it("compacts on a user-message boundary near the midpoint", () => {
		const msgs: AiEditionChatMessage[] = [];
		for (let i = 0; i < 10; i += 1) {
			msgs.push(msg(i % 2 ? "assistant" : "user", `turn-${i}-${"x".repeat(800)}`));
		}
		const out = compactionSplitIndex(msgs);
		expect(out).not.toBeNull();
		// boundary must be a user message
		expect(msgs[out as number]?.role).toBe("user");
	});

	it("does not consult any token budget — a tiny history still splits", () => {
		// The regression this pins: compaction used to refuse below 70% of a
		// guessed 80k-token budget, which gated the manual button too, so
		// pressing Compact on a short conversation did nothing at all and said
		// nothing about why. The app cannot know a model's context window, so
		// there is no threshold left to be wrong about.
		const tiny = Array.from({ length: 6 }, (_, i) => msg(i % 2 ? "assistant" : "user", "hi"));
		expect(estimateHistoryTokens(tiny)).toBeLessThan(100);
		expect(compactionSplitIndex(tiny)).not.toBeNull();
	});
});

describe("applyCompaction", () => {
	it("replaces the summarized prefix with the summary message", () => {
		const msgs = [
			msg("user", "x".repeat(4_000), "u1"),
			msg("assistant", "y".repeat(4_000), "a1"),
			msg("user", "3", "u2"),
			msg("assistant", "4", "a2"),
		];
		const out = applyCompaction(msgs, 2, "summary text", "2026-02-01T00:00:00.000Z");
		expect(out).toHaveLength(3);
		expect(out[0]?.content).toBe("summary text");
		expect(out[0]?.id).toMatch(/^summary_\d+$/);
		expect(out[1]?.id).toBe("u2");
		expect(out.at(-1)?.id).toBe("a2");
		expect(estimateHistoryTokens(out)).toBeLessThan(estimateHistoryTokens(msgs));
		expect(compactionReducesHistory(msgs, out)).toBe(true);
	});

	it("rejects a summary that does not reduce estimated context use", () => {
		const msgs = [
			msg("user", "small", "u1"),
			msg("assistant", "reply", "a1"),
			msg("user", "recent", "u2"),
			msg("assistant", "tail", "a2"),
		];
		const oversized = applyCompaction(msgs, 2, "x".repeat(1_000), "2026-02-01T00:00:00.000Z");

		expect(compactionReducesHistory(msgs, oversized)).toBe(false);
	});
});

describe("buildCompactionPrompt", () => {
	it("quotes each user/assistant/tool message with a label", () => {
		const prompt = buildCompactionPrompt([
			msg("user", "cut the silence"),
			msg("assistant", "Done."),
		]);
		expect(prompt).toContain("User: cut the silence");
		expect(prompt).toContain("Assistant: Done.");
	});

	it("embeds tool-call summaries in the user message", () => {
		const prompt = buildCompactionPrompt([
			{
				id: "a",
				role: "assistant",
				content: "applied",
				createdAt: "2026-01-01T00:00:00.000Z",
				toolCalls: [{ name: "addTrim", summary: "5-8s" }],
			},
		]);
		expect(prompt).toContain("tools: addTrim (5-8s)");
	});
});
