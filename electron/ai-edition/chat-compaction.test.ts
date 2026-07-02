import { beforeEach, describe, expect, it } from "vitest";
import type { AiEditionChatMessage } from "../../src/native/contracts";
import {
	applyCompaction,
	budgetSnapshot,
	buildCompactionPrompt,
	estimateHistoryTokens,
	shouldCompact,
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

	it("adds 4 tokens per tool call", () => {
		const base = estimateHistoryTokens([msg("user", "hi")]);
		const withTool = estimateHistoryTokens([
			{
				id: "a",
				role: "assistant",
				content: "done",
				createdAt: "2026-01-01T00:00:00.000Z",
				toolCalls: [{ name: "addSkip", summary: "skip 5-8s" }],
			},
		]);
		// tool adds roughly: 16 + 4-chars-per-token of name+summary
		expect(withTool).toBeGreaterThan(base);
	});
});

describe("budgetSnapshot", () => {
	it("computes ratio clamped to >0", () => {
		const snap = budgetSnapshot([msg("user", "x".repeat(40_000))], 10_000);
		expect(snap.usedTokens).toBe(10_000);
		expect(snap.ratio).toBe(1);
	});
});

describe("shouldCompact", () => {
	beforeEach(() => undefined);

	it("returns null for very short histories", () => {
		expect(shouldCompact([msg("user", "hi")])).toBeNull();
	});

	it("returns null when under the threshold", () => {
		const small = Array.from({ length: 6 }, (_, i) =>
			msg(i % 2 ? "assistant" : "user", `short-${i}`),
		);
		expect(shouldCompact(small, 1_000_000)).toBeNull();
	});

	it("compacts on a user-message boundary near the midpoint", () => {
		const msgs: AiEditionChatMessage[] = [];
		for (let i = 0; i < 10; i += 1) {
			msgs.push(msg(i % 2 ? "assistant" : "user", `turn-${i}-${"x".repeat(800)}`));
		}
		const out = shouldCompact(msgs, 50);
		expect(out).not.toBeNull();
		expect(out?.compact).toBe(true);
		// boundary must be a user message
		expect(msgs[out!.splitIndex]?.role).toBe("user");
	});
});

describe("applyCompaction", () => {
	it("inserts the summary message at the split point", () => {
		const msgs = [
			msg("user", "1", "u1"),
			msg("assistant", "2", "a1"),
			msg("user", "3", "u2"),
			msg("assistant", "4", "a2"),
		];
		const out = applyCompaction(msgs, 2, "summary text", "2026-02-01T00:00:00.000Z");
		expect(out.length).toBe(5);
		expect(out[2]?.content).toBe("summary text");
		expect(out[0]?.id).toBe("u1");
		expect(out.at(-1)?.id).toBe("a2");
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
				toolCalls: [{ name: "addSkip", summary: "5-8s" }],
			},
		]);
		expect(prompt).toContain("tools: addSkip (5-8s)");
	});
});
