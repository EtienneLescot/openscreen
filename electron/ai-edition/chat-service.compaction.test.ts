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

// Deliberately huge: these used to be sized against the 70%-of-80k trip point,
// and they stay huge for the opposite reason — a history this big is the case
// that USED to compact itself, so it is the one that proves nothing does now.
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

describe("compaction", () => {
	it("NEVER runs on its own, however big the history gets", async () => {
		// The headline rule. A turn used to measure the history against a
		// guessed 80k-token budget and, past 70% of it, block on a whole extra
		// summarizer call before the user's request was even sent. The app has
		// no way to ask a provider how big its context window is, so that number
		// could not be right for anything — it threw away context at 5% fill on
		// a 1M-token Gemini. Six turns here estimate at ~90k tokens, comfortably
		// past the old trip point.
		const summarizer = stubSummarizer("EARLIER CONTEXT");
		const session = createSession("proj_no_auto");
		for (let i = 0; i < 6; i += 1) {
			await runChat("proj_no_auto", session.id, `${LONG}#${i}`, stubConfig());
		}

		expect(getSessionContextUsage("proj_no_auto", session.id)?.usedTokens).toBeGreaterThan(56_000);
		expect(summarizer).not.toHaveBeenCalled();
		// And nothing was folded away behind the user's back.
		const history = histories.at(-1) ?? [];
		expect(history.some((m) => m.content === `${LONG}#0`)).toBe(true);
		expect(history.at(-1)?.content).toBe(`${LONG}#5`);
	});

	it("compacts on the button, and leaves the transcript whole", async () => {
		stubSummarizer("EARLIER CONTEXT");
		const session = createSession("proj_compact_transcript");
		for (let i = 0; i < 4; i += 1) {
			await runChat("proj_compact_transcript", session.id, `${LONG}#${i}`, stubConfig());
		}
		await compactSessionNow("proj_compact_transcript", session.id, stubConfig());

		// Four user turns, four replies, nothing deleted: this array is what the
		// renderer shows, and the user never asked for half of it to go away.
		const transcript = selectSession("proj_compact_transcript", session.id)?.messages ?? [];
		expect(transcript).toHaveLength(8);
		expect(transcript[0]?.content).toBe(`${LONG}#0`);
		expect(transcript.filter((m) => m.role === "user")).toHaveLength(4);

		// The next turn gets the summary in place of the older half.
		await runChat("proj_compact_transcript", session.id, "and then?", stubConfig());
		const history = histories.at(-1) ?? [];
		expect(history[0]?.content).toBe("EARLIER CONTEXT");
		expect(history.some((m) => m.content === `${LONG}#0`)).toBe(false);
		expect(history.at(-1)?.content).toBe("and then?");

		// The context pill measures the payload, so compaction shows up there.
		const usage = getSessionContextUsage("proj_compact_transcript", session.id);
		expect(usage?.usedTokens).toBeLessThan(40_000);
	});

	it("measures the WINDOW the model is sent, not the whole post-compaction list", async () => {
		// The model gets `MODEL_HISTORY_WINDOW` (20) messages, not everything after the
		// compaction boundary. Measuring the wider list made the pill report roughly
		// double on a long session, and made pressing Compact halve the number while
		// what actually reaches the provider barely moved -- the same class of wrong
		// number this pill exists to avoid.
		const session = createSession("proj_window");
		// 12 turns = 24 messages, so 4 fall outside the window.
		for (let i = 0; i < 12; i += 1) {
			await runChat("proj_window", session.id, `${LONG}#${i}`, stubConfig());
		}

		const transcript = selectSession("proj_window", session.id)?.messages ?? [];
		expect(transcript).toHaveLength(24);
		const sentToTheModel = histories.at(-1) ?? [];
		// The last turn's payload is what the pill has to describe.
		const sentChars = sentToTheModel.reduce((acc, m) => acc + m.content.length, 0);
		const transcriptChars = transcript.reduce((acc, m) => acc + m.content.length, 0);
		expect(sentChars).toBeLessThan(transcriptChars);

		const usage = getSessionContextUsage("proj_window", session.id);
		// Within one turn of the payload (the pill is read after the reply lands, the
		// payload was built before it), and nowhere near the whole transcript.
		expect(usage?.usedTokens).toBeLessThan(Math.ceil(transcriptChars / 4));
		expect(usage?.usedTokens).toBeGreaterThanOrEqual(Math.ceil(sentChars / 4));
	});

	it("compacts an ORDINARY conversation — the button is not gated by a budget", async () => {
		// The same guessed budget gated the manual path: `compactSessionNow`
		// went through the same heuristic, so below 70% of 80k the button did
		// nothing at all, silently. This session is ~3k tokens — a perfectly
		// normal chat, roughly 5% of the old trip point, and exactly the size at
		// which the button used to be a no-op. Pressing it is the decision now;
		// there is no number left to overrule it.
		const summarizer = stubSummarizer("EARLIER CONTEXT");
		const session = createSession("proj_compact_short");
		const paragraph = "a".repeat(2_000);
		for (let i = 0; i < 3; i += 1) {
			await runChat("proj_compact_short", session.id, `${paragraph}#${i}`, stubConfig());
		}
		const used = getSessionContextUsage("proj_compact_short", session.id)?.usedTokens ?? 0;
		expect(used).toBeLessThan(56_000 / 10);

		const manual = await compactSessionNow("proj_compact_short", session.id, stubConfig());
		expect(summarizer).toHaveBeenCalledTimes(1);
		expect(manual?.summary).toBe("EARLIER CONTEXT");
	});

	it("keeps the summary in the payload when the tail is longer than the window", async () => {
		stubSummarizer("EARLIER CONTEXT");
		const session = createSession("proj_compact_window");
		for (let i = 0; i < 30; i += 1) {
			await runChat("proj_compact_window", session.id, `turn ${i}`, stubConfig());
		}
		await compactSessionNow("proj_compact_window", session.id, stubConfig());
		const huge = LONG.repeat(4);
		await runChat("proj_compact_window", session.id, huge, stubConfig());

		// 31 messages survive the boundary — a plain slice(-20) would drop the
		// summary we just paid a model call to produce.
		const history = histories.at(-1) ?? [];
		expect(history).toHaveLength(20);
		expect(history[0]?.content).toBe("EARLIER CONTEXT");
		expect(history.at(-1)?.content).toBe(huge);
	});

	it("refuses a summary that does not shrink the payload, and keeps the session", async () => {
		const oversized = stubSummarizer("z".repeat(400_000));
		const session = createSession("proj_compact_blocked");
		for (let i = 0; i < 5; i += 1) {
			await runChat("proj_compact_blocked", session.id, `${LONG}#${i}`, stubConfig());
		}

		// Adopting a summary longer than what it replaces would grow the payload.
		// The session is left exactly as it was. (There is no "stop retrying"
		// flag any more: nothing retries on its own, so the only next attempt is
		// another press, which is the user asking again knowingly.)
		expect(await compactSessionNow("proj_compact_blocked", session.id, stubConfig())).toBeNull();
		expect(oversized).toHaveBeenCalledTimes(1);
		expect(selectSession("proj_compact_blocked", session.id)?.messages).toHaveLength(10);

		await runChat("proj_compact_blocked", session.id, "and then?", stubConfig());
		expect(histories.at(-1)?.some((m) => m.content === "EARLIER CONTEXT")).toBe(false);

		// A second press with a usable summary lands.
		const usable = stubSummarizer("EARLIER CONTEXT");
		const manual = await compactSessionNow("proj_compact_blocked", session.id, stubConfig());
		expect(usable).toHaveBeenCalledTimes(1);
		expect(manual?.summary).toBe("EARLIER CONTEXT");
		expect(manual?.session.messages).toHaveLength(12);

		await runChat("proj_compact_blocked", session.id, "and after that?", stubConfig());
		expect(histories.at(-1)?.[0]?.content).toBe("EARLIER CONTEXT");
	});

	// `splitIndex` comes back as an index INTO WHAT WAS MEASURED, and it is then
	// applied to the payload. Measure the transcript instead — which compaction
	// never shrinks — and the index runs off the end of the much shorter
	// payload, so `payload.slice(0, splitIndex)` swallows the whole thing, the
	// current user turn included, and the model is asked to answer a question it
	// was never shown. Repeated compactions are what make the two lists diverge,
	// so the button is pressed between every turn here.
	it("never summarizes away the turn the user just sent", async () => {
		stubSummarizer("EARLIER CONTEXT");
		const session = createSession("proj_compact_current_turn");
		for (let i = 0; i < 10; i += 1) {
			await runChat("proj_compact_current_turn", session.id, `${LONG}#${i}`, stubConfig());
			await compactSessionNow("proj_compact_current_turn", session.id, stubConfig());
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
