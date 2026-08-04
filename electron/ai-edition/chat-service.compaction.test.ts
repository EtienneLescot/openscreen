// Compaction as seen from chat-service: what the user keeps versus what the
// model is handed. Both seams are mocked — `invokeOpenScreenAgent` for the
// turn itself (so we can read the history it was given) and the chat model
// behind the summarizer, so no test here needs a provider or a key.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./deep-agent/service", () => ({
	invokeOpenScreenAgent: vi.fn(),
}));

vi.mock("./deep-agent/chat-model", () => ({
	createOpenScreenChatModel: vi.fn(),
	messageContentToText: (content: unknown) => String(content),
}));

import {
	compactSessionNow,
	createSession,
	getSessionContextUsage,
	runChat,
	selectSession,
} from "./chat-service";
import { createOpenScreenChatModel } from "./deep-agent/chat-model";
import { invokeOpenScreenAgent } from "./deep-agent/service";
import type { LlmConfigStore } from "./llm-config-store";

const invokeMock = vi.mocked(invokeOpenScreenAgent);
const chatModelMock = vi.mocked(createOpenScreenChatModel);

type ModelHistory = Array<{ role: "user" | "assistant" | "system"; content: string }>;

let histories: ModelHistory[] = [];

function stubConfig(): LlmConfigStore {
	return {
		getConfig: () => ({ provider: "openai", model: "gpt-4o" }),
		getApiKey: () => "sk-test",
		getCredential: () => ({ value: "sk-test", entry: { kind: "api-key", apiKey: "sk-test" } }),
	} as unknown as LlmConfigStore;
}

/** Point the summarizer at a fixed reply and return its call spy. */
function stubSummarizer(reply: string) {
	const invoke = vi.fn(async () => ({ content: reply }));
	chatModelMock.mockImplementation(
		async () => ({ invoke }) as unknown as Awaited<ReturnType<typeof createOpenScreenChatModel>>,
	);
	return invoke;
}

// Long enough that four of them clear the 70%-of-80k-tokens trip point, short
// enough that three of them do not.
const LONG = "x".repeat(60_000);

beforeEach(() => {
	histories = [];
	invokeMock.mockReset();
	chatModelMock.mockReset();
	invokeMock.mockImplementation(async (args) => {
		histories.push([...args.history]);
		return { text: "ok", document: args.document, mutated: false };
	});
});

describe("auto-compaction", () => {
	it("leaves the transcript whole and compacts only what the model is given", async () => {
		stubSummarizer("EARLIER CONTEXT");
		const session = createSession("proj_compact_transcript");
		for (let i = 0; i < 4; i += 1) {
			await runChat("proj_compact_transcript", session.id, `${LONG}#${i}`, stubConfig());
		}

		// Four user turns, four replies, nothing deleted: this array is what the
		// renderer shows, and the user never asked for half of it to go away.
		const transcript = selectSession("proj_compact_transcript", session.id)?.messages ?? [];
		expect(transcript).toHaveLength(8);
		expect(transcript[0]?.content).toBe(`${LONG}#0`);
		expect(transcript.filter((m) => m.role === "user")).toHaveLength(4);

		// The fourth turn is the one that tripped the budget: the model got the
		// summary in place of the older half, not the whole conversation.
		const history = histories.at(-1) ?? [];
		expect(history[0]?.content).toBe("EARLIER CONTEXT");
		expect(history).toHaveLength(4);
		expect(history.some((m) => m.content === `${LONG}#0`)).toBe(false);
		expect(history.at(-1)?.content).toBe(`${LONG}#3`);

		// The context pill measures the payload, so compaction actually shows up:
		// the whole transcript estimates at ~60k tokens, the payload at half.
		const usage = getSessionContextUsage("proj_compact_transcript", session.id);
		expect(usage?.usedTokens).toBeLessThan(40_000);
	});

	it("keeps the summary in the payload when the tail is longer than the window", async () => {
		stubSummarizer("EARLIER CONTEXT");
		const session = createSession("proj_compact_window");
		for (let i = 0; i < 30; i += 1) {
			await runChat("proj_compact_window", session.id, `turn ${i}`, stubConfig());
		}
		const huge = LONG.repeat(4);
		await runChat("proj_compact_window", session.id, huge, stubConfig());

		// 31 messages survive the boundary — a plain slice(-20) would drop the
		// summary we just paid a model call to produce.
		const history = histories.at(-1) ?? [];
		expect(history).toHaveLength(20);
		expect(history[0]?.content).toBe("EARLIER CONTEXT");
		expect(history.at(-1)?.content).toBe(huge);
	});

	it("stops retrying after a summary that does not shrink the payload", async () => {
		const oversized = stubSummarizer("z".repeat(400_000));
		const session = createSession("proj_compact_blocked");
		for (let i = 0; i < 5; i += 1) {
			await runChat("proj_compact_blocked", session.id, `${LONG}#${i}`, stubConfig());
		}

		// Two more turns tripped the heuristic after the failure; neither paid
		// for another summarizer call.
		expect(oversized).toHaveBeenCalledTimes(1);
		const history = histories.at(-1) ?? [];
		expect(history.some((m) => m.content === "EARLIER CONTEXT")).toBe(false);
		expect(selectSession("proj_compact_blocked", session.id)?.messages).toHaveLength(10);

		// The Compact button is an explicit request, so it tries again — and a
		// success unblocks the automatic path.
		const usable = stubSummarizer("EARLIER CONTEXT");
		const manual = await compactSessionNow("proj_compact_blocked", session.id, stubConfig());
		expect(usable).toHaveBeenCalledTimes(1);
		expect(manual?.summary).toBe("EARLIER CONTEXT");
		expect(manual?.session.messages).toHaveLength(10);

		await runChat("proj_compact_blocked", session.id, "and then?", stubConfig());
		expect(histories.at(-1)?.[0]?.content).toBe("EARLIER CONTEXT");
	});

	// The regression this guards is `planCompaction` measuring the wrong list.
	// `splitIndex` comes back from `shouldCompact` as an index INTO WHAT IT WAS
	// GIVEN, and it is then applied to the payload. Measure the transcript
	// instead — which never shrinks, so it keeps tripping — and the index runs
	// off the end of the much shorter payload, so `payload.slice(0, splitIndex)`
	// swallows the whole thing, current user turn included. The model is then
	// asked to answer a question it was never shown.
	//
	// Three turns is not enough to see it: the collapse needs a payload that has
	// already been compacted at least once, so the two lists have diverged.
	it("never summarizes away the turn the user just sent", async () => {
		stubSummarizer("EARLIER CONTEXT");
		const session = createSession("proj_compact_current_turn");
		for (let i = 0; i < 10; i += 1) {
			await runChat("proj_compact_current_turn", session.id, `${LONG}#${i}`, stubConfig());
		}

		// Every turn, not just the last: the collapse is intermittent, so a
		// spot-check on `histories.at(-1)` walks straight past it. When it bites,
		// the payload is `[summary]` alone, so the last entry is the summary
		// rather than the message the user just typed — which is exactly what
		// this asserts. (Turn 0 is legitimately a one-message payload, so length
		// is the wrong thing to check.)
		expect(histories).toHaveLength(10);
		histories.forEach((history, turn) => {
			expect(
				history.at(-1)?.content,
				`turn ${turn} was handed a payload that did not end with the user's message`,
			).toBe(`${LONG}#${turn}`);
		});
	});
});
