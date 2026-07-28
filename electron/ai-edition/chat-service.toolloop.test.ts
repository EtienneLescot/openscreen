// Tool-loop behavior of runChat (P1.2–P1.5, P1.8, P2.5) with a mocked deep
// agent. The deep-agent port routes the loop through LangGraph
// (`createDeepAgent`); rather than mocking the LangChain chat model the
// tests mock `invokeOpenScreenAgent` directly — that's the seam chat-service
// crosses to drive the agentic turn.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AxcutDocument,
	createEmptyDocument,
	documentSchema,
} from "../../src/lib/ai-edition/schema";

vi.mock("./deep-agent/service", () => ({
	invokeOpenScreenAgent: vi.fn(),
}));

import { createSession, rewindToMessage, runChat } from "./chat-service";
import { invokeOpenScreenAgent } from "./deep-agent/service";
import type { LlmConfigStore } from "./llm-config-store";

const invokeMock = vi.mocked(invokeOpenScreenAgent);

function fixtureDocument(): AxcutDocument {
	const base = createEmptyDocument({ title: "Test", projectId: "proj_loop" });
	return documentSchema.parse({
		...base,
		project: { ...base.project, primaryAssetId: "asset_1" },
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "Recording",
				originalPath: "C:/videos/rec.mp4",
				durationSec: 60,
			},
		],
		timeline: {
			...base.timeline,
			clips: [
				{
					id: "clip_1",
					assetId: "asset_1",
					sourceStartSec: 0,
					sourceEndSec: 60,
					timelineStartSec: 0,
					timelineEndSec: 60,
					wordRefs: [],
					origin: "user",
					reason: "",
				},
			],
		},
	});
}

function stubConfig(overrides: Record<string, unknown> = {}): LlmConfigStore {
	return {
		getConfig: () => ({ provider: "openai", model: "gpt-4o", ...overrides }),
		getApiKey: () => "sk-test",
		getCredential: (_id: string, _envKeys: string[]) => ({
			value: "sk-test",
			entry: { kind: "api-key", apiKey: "sk-test" },
		}),
	} as unknown as LlmConfigStore;
}

// ponytail: a tiny stub that simulates the deep agent. It captures the args
// chat-service hands it, emits the sink events a real agent would emit (text
// deltas, tool lifecycle, errors), and returns the simulated result.
//
// Tests compose each scenario by giving `simulate` callbacks that drive the
// sink — that's the public contract the orchestrator cares about, so the
// tests no longer reach inside the LangGraph state machine.
interface CapturedInvoke {
	args: {
		document: AxcutDocument;
		model: { provider: string; model: string };
		history: Array<{ role: "user" | "assistant" | "system"; content: string }>;
		userMessage: string;
	};
}

interface ToolLoopFixture {
	events: { kind: string; payload: unknown }[];
	captured: CapturedInvoke[];
}

function resetFixture(): ToolLoopFixture {
	return { events: [], captured: [] };
}

let fixture: ToolLoopFixture = resetFixture();

beforeEach(() => {
	fixture = resetFixture();
	invokeMock.mockReset();
	// ponytail: default mock — tests override per-scenario.
	invokeMock.mockImplementation(async (args) => {
		fixture.captured.push({ args });
		return { text: "ok", document: args.document, mutated: false };
	});
});

// ponytail: tool chain driven by a generator — each `next()` call resolves to
// the next sink event (text delta / toolStart / toolEnd / error). The
// generator yields `null` to end the loop.
async function streamAgent(
	args: Parameters<typeof invokeOpenScreenAgent>[0],
	events: ReadonlyArray<{ kind: string; payload: unknown }>,
): Promise<{ text: string; document: AxcutDocument; mutated: boolean }> {
	const sink = args.sink;
	for (const event of events) {
		switch (event.kind) {
			case "text":
				sink.text(event.payload as string);
				break;
			case "toolStart":
				sink.toolStart(
					(event.payload as { name: string }).name,
					(event.payload as { args: unknown }).args,
				);
				break;
			case "toolEnd":
				sink.toolEnd(
					(event.payload as { name: string }).name,
					(event.payload as { ok: boolean }).ok,
					(event.payload as { summary?: string }).summary,
				);
				break;
			case "error":
				sink.error(event.payload as string);
				break;
		}
	}
	return {
		text: "Done.",
		document: args.document,
		mutated: false,
	};
}

describe("runChat tool loop", () => {
	it("executes tool calls, chains turns, and returns the mutated document", async () => {
		invokeMock.mockImplementationOnce(async (args) => {
			args.sink.toolStart("addTrim", { startSec: 5, endSec: 8, reason: "silence" });
			args.sink.toolEnd("addTrim", true, "added trim 0:05.0 – 0:08.0");
			return { text: "Done.", document: args.document, mutated: true };
		});

		const session = createSession("proj_loop");
		const result = await runChat(
			"proj_loop",
			session.id,
			"cut the silence",
			stubConfig(),
			fixtureDocument(),
		);

		expect(result.success).toBe(true);
		expect(result.assistantMessage?.content).toBe("Done.");
		expect(result.toolCalls).toHaveLength(1);
		expect(result.toolCalls?.[0].summary).toMatch(/added trim/);
	});

	it("rewinds to before the user message, restoring the document", async () => {
		invokeMock.mockImplementationOnce(async (args) => {
			args.sink.toolStart("addTrim", { startSec: 1, endSec: 2 });
			args.sink.toolEnd("addTrim", true, "added trim 0:01.0 – 0:02.0");
			return { text: "Done.", document: args.document, mutated: true };
		});

		const session = createSession("proj_rewind");
		const result = await runChat(
			"proj_rewind",
			session.id,
			"cut the silence",
			stubConfig(),
			fixtureDocument(),
		);
		expect(result.success).toBe(true);
		const userMessage = result.assistantMessage; // ignored; we want the user message id
		void userMessage;

		const sessionMessages = (await import("./chat-service")).selectSession(
			"proj_rewind",
			session.id,
		);
		expect(sessionMessages?.messages).toHaveLength(2);
		const user = sessionMessages?.messages[0];
		expect(user?.role).toBe("user");
		expect(user?.checkpointId).toBe(user?.id);

		const undo = rewindToMessage("proj_rewind", session.id, user!.id);
		expect(undo.success).toBe(true);
		if (!undo.success) return;
		const restored = documentSchema.parse(undo.document);
		expect(restored.timeline.trimRanges).toHaveLength(0);
		expect(undo.prompt).toBe("cut the silence");
	});

	it("rewindToMessage refuses when the target has no checkpoint", async () => {
		const { createSession, selectSession, runChat } = await import("./chat-service");
		const session = createSession("proj_rewind_no_cp");
		await runChat(
			"proj_rewind_no_cp",
			session.id,
			"hi",
			stubConfig(),
			// text-only: no document → no checkpoint
		);
		const userId = selectSession("proj_rewind_no_cp", session.id)?.messages[0].id;
		const result = rewindToMessage("proj_rewind_no_cp", session.id, userId!);
		expect(result.success).toBe(false);
	});

	it("rewindToMessage rejects targeting an assistant message", async () => {
		const { createSession, listSessions, selectSession, runChat } = await import("./chat-service");
		const session = createSession("proj_rewind_aimessage");
		await runChat("proj_rewind_aimessage", session.id, "hi", stubConfig(), fixtureDocument());
		const assistant = selectSession("proj_rewind_aimessage", session.id)?.messages.find(
			(m) => m.role === "assistant",
		);
		const result = rewindToMessage("proj_rewind_aimessage", session.id, assistant!.id);
		expect(result.success).toBe(false);
		void listSessions;
	});

	it("runs text-only when no document snapshot is provided", async () => {
		invokeMock.mockImplementationOnce(async (args) => ({
			text: "Hi!",
			document: args.document,
			mutated: false,
		}));
		const s = createSession("proj_text_only");
		const result = await runChat("proj_text_only", s.id, "hello", stubConfig());
		expect(result.success).toBe(true);
		expect(result.assistantMessage?.content).toBe("Hi!");
		expect(result.document).toBeUndefined();
	});

	it("forwards text deltas, tool lifecycle, and errors through the ChatEventSink", async () => {
		const events: { kind: string; payload: unknown }[] = [];
		invokeMock.mockImplementationOnce(async (args) => {
			events.push({ kind: "captured", payload: args.userMessage });
			args.sink.text("Hi ");
			args.sink.text("there.");
			args.sink.toolStart("addTrim", { startSec: 1, endSec: 2 });
			args.sink.toolEnd("addTrim", true, "added trim 0:01.0 – 0:02.0");
			return { text: "Done.", document: args.document, mutated: true };
		});

		const sink = {
			text: (delta: string) => fixture.events.push({ kind: "text", payload: delta }),
			toolStart: (name: string, args: unknown) =>
				fixture.events.push({ kind: "toolStart", payload: { name, args } }),
			toolEnd: (name: string, ok: boolean, summary?: string) =>
				fixture.events.push({ kind: "toolEnd", payload: { name, ok, summary } }),
			error: (message: string) => fixture.events.push({ kind: "error", payload: message }),
		};

		const s = createSession("proj_sink");
		const result = await runChat("proj_sink", s.id, "cut", stubConfig(), fixtureDocument(), sink);
		expect(result.success).toBe(true);
		expect(fixture.events.map((e) => e.kind)).toEqual(["text", "text", "toolStart", "toolEnd"]);
		expect((fixture.events[0].payload as string) + (fixture.events[1].payload as string)).toBe(
			"Hi there.",
		);
		expect(fixture.events[2].payload).toMatchObject({ name: "addTrim" });
		expect(fixture.events[3].payload).toMatchObject({
			name: "addTrim",
			ok: true,
			summary: expect.stringMatching(/added trim/),
		});

		// ponytail: empty-result path. When the deep agent returns no text,
		// runChat surfaces "Empty response from model." — this is the second
		// major behavior we want a regression test for.
		fixture.events.length = 0;
		invokeMock.mockReset();
		invokeMock.mockImplementationOnce(async (args) => {
			args.sink.error("Upstream 404 404 Page not found");
			return { text: "", document: args.document, mutated: false };
		});
		const sinkErr = {
			text: (delta: string) => fixture.events.push({ kind: "text", payload: delta }),
			toolStart: (name: string, args: unknown) =>
				fixture.events.push({ kind: "toolStart", payload: { name, args } }),
			toolEnd: (name: string, ok: boolean, summary?: string) =>
				fixture.events.push({ kind: "toolEnd", payload: { name, ok, summary } }),
			error: (message: string) => fixture.events.push({ kind: "error", payload: message }),
		};
		const errResult = await runChat(
			"proj_sink_err",
			createSession("proj_sink_err").id,
			"x",
			stubConfig(),
			fixtureDocument(),
			sinkErr,
		);
		expect(errResult.success).toBe(false);
		expect(errResult.error).toMatch(/Empty response/);
		expect(fixture.events.map((e) => e.kind)).toEqual(["error"]);
		expect(fixture.events[0].payload).toMatch(/Upstream 404/);

		// ponytail: keep TS happy about `events` — the variable is used above.
		void events;
		void streamAgent;
	});
});
