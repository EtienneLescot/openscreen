// Tool-loop behavior of runChat (P1.2–P1.5, P1.8, P2.5) with a mocked LLM.
// The mock drives multi-turn tool chaining without network or API keys.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AxcutDocument,
	createEmptyDocument,
	documentSchema,
} from "../../src/lib/ai-edition/schema";
import type { CallLlmOptions, CallLlmResult } from "./llm-call";

vi.mock("./llm-call", () => ({
	callLlm: vi.fn(),
}));

import { createSession, runChat, undoLastToolBatch } from "./chat-service";
import { callLlm } from "./llm-call";
import type { LlmConfigStore } from "./llm-config-store";

const callLlmMock = vi.mocked(callLlm);

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
	} as unknown as LlmConfigStore;
}

beforeEach(() => {
	callLlmMock.mockReset();
});

describe("runChat tool loop", () => {
	it("executes tool calls, chains turns, and returns the mutated document", async () => {
		callLlmMock
			.mockResolvedValueOnce({
				success: true,
				content: "",
				toolCalls: [
					{
						id: "call_1",
						name: "addSkip",
						arguments: JSON.stringify({ startSec: 5, endSec: 8, reason: "silence" }),
					},
				],
			})
			.mockResolvedValueOnce({ success: true, content: "Trimmed the silence at 0:05." });

		const s = createSession("proj_loop");
		const result = await runChat(
			"proj_loop",
			s.id,
			"cut the silence",
			stubConfig(),
			fixtureDocument(),
		);

		expect(result.success).toBe(true);
		expect(result.assistantMessage?.content).toBe("Trimmed the silence at 0:05.");
		expect(result.toolCalls).toHaveLength(1);
		expect(result.toolCalls?.[0].summary).toMatch(/added skip/);
		const doc = documentSchema.parse(result.document);
		expect(doc.timeline.skipRanges).toHaveLength(1);
		expect(doc.timeline.skipRanges[0]).toMatchObject({ startSec: 5, endSec: 8, origin: "agent" });

		// The second LLM call must see the tool result message.
		const secondCall = callLlmMock.mock.calls[1][0] as CallLlmOptions;
		const toolMsg = secondCall.messages.find((m) => m.role === "tool");
		expect(toolMsg).toBeDefined();
		expect(secondCall.tools?.map((t) => t.name)).toContain("addSkip");
	});

	it("saves a pre-batch checkpoint that undoLastToolBatch restores", async () => {
		callLlmMock
			.mockResolvedValueOnce({
				success: true,
				content: "",
				toolCalls: [
					{
						id: "call_1",
						name: "addSkip",
						arguments: JSON.stringify({ startSec: 1, endSec: 2 }),
					},
				],
			})
			.mockResolvedValueOnce({ success: true, content: "Done." });

		const s = createSession("proj_loop_undo");
		const original = fixtureDocument();
		const result = await runChat("proj_loop_undo", s.id, "cut", stubConfig(), original);
		expect(documentSchema.parse(result.document).timeline.skipRanges).toHaveLength(1);

		const undo = undoLastToolBatch("proj_loop_undo", s.id);
		expect(undo.success).toBe(true);
		const restored = documentSchema.parse(undo.document);
		expect(restored.timeline.skipRanges).toHaveLength(0);
	});

	it("undoLastToolBatch fails cleanly when nothing was edited", () => {
		const s = createSession("proj_no_edits");
		const undo = undoLastToolBatch("proj_no_edits", s.id);
		expect(undo.success).toBe(false);
		expect(undo.error).toMatch(/Nothing to undo/);
	});

	it("refuses write tools when allowAgentEdits is false (P2.5)", async () => {
		callLlmMock
			.mockResolvedValueOnce({
				success: true,
				content: "",
				toolCalls: [
					{
						id: "call_1",
						name: "addSkip",
						arguments: JSON.stringify({ startSec: 1, endSec: 2 }),
					},
				],
			})
			.mockResolvedValueOnce({
				success: true,
				content: "I need you to enable project edits first.",
			});

		const s = createSession("proj_gated");
		const result = await runChat(
			"proj_gated",
			s.id,
			"cut",
			stubConfig({ allowAgentEdits: false }),
			fixtureDocument(),
		);

		expect(result.success).toBe(true);
		expect(result.document).toBeUndefined();
		expect(result.toolCalls).toBeUndefined();
		const secondCall = callLlmMock.mock.calls[1][0] as CallLlmOptions;
		const toolMsg = secondCall.messages.find((m) => m.role === "tool");
		expect(toolMsg?.content).toMatch(/edits are disabled/i);
	});

	it("still allows read tools when edits are disabled", async () => {
		callLlmMock
			.mockResolvedValueOnce({
				success: true,
				content: "",
				toolCalls: [{ id: "call_1", name: "getCurrentDocument", arguments: "{}" }],
			})
			.mockResolvedValueOnce({ success: true, content: "You have 1 clip." });

		const s = createSession("proj_read_only");
		const result = await runChat(
			"proj_read_only",
			s.id,
			"what's in my project?",
			stubConfig({ allowAgentEdits: false }),
			fixtureDocument(),
		);
		expect(result.success).toBe(true);
		const secondCall = callLlmMock.mock.calls[1][0] as CallLlmOptions;
		const toolMsg = secondCall.messages.find((m) => m.role === "tool");
		expect(toolMsg?.content).toContain("asset_1");
	});

	it("caps the loop at MAX_TOOL_ITERATIONS and reports applied edits", async () => {
		callLlmMock.mockResolvedValue({
			success: true,
			content: "",
			toolCalls: [
				{
					id: "call_x",
					name: "addSkip",
					arguments: JSON.stringify({ startSec: 1, endSec: 2 }),
				},
			],
		} satisfies CallLlmResult);

		const s = createSession("proj_cap");
		const result = await runChat("proj_cap", s.id, "loop forever", stubConfig(), fixtureDocument());
		expect(result.success).toBe(true);
		expect(callLlmMock).toHaveBeenCalledTimes(8);
		expect(result.assistantMessage?.content).toMatch(/tool-call limit/);
		expect(documentSchema.parse(result.document).timeline.skipRanges).toHaveLength(8);
	});

	it("runs text-only (no tools) when no document snapshot is provided", async () => {
		callLlmMock.mockResolvedValueOnce({ success: true, content: "Hi!" });
		const s = createSession("proj_text_only");
		const result = await runChat("proj_text_only", s.id, "hello", stubConfig());
		expect(result.success).toBe(true);
		expect(result.document).toBeUndefined();
		const call = callLlmMock.mock.calls[0][0] as CallLlmOptions;
		expect(call.tools).toBeUndefined();
	});

	it("embeds the document snapshot in the system prompt (P1.5)", async () => {
		callLlmMock.mockResolvedValueOnce({ success: true, content: "ok" });
		const s = createSession("proj_prompt");
		await runChat("proj_prompt", s.id, "hello", stubConfig(), fixtureDocument());
		const call = callLlmMock.mock.calls[0][0] as CallLlmOptions;
		const system = call.messages.find((m) => m.role === "system");
		expect(system?.content).toContain("Current document snapshot:");
		expect(system?.content).toContain("clip_1");
	});
});
