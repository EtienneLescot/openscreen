import { beforeEach, describe, expect, it } from "vitest";
import {
	createSession,
	deleteSession,
	listSessions,
	renameSession,
	selectSession,
} from "./chat-service";
import type { LlmConfigStore } from "./llm-config-store";

describe("chat-service sessions", () => {
	const projectId = "proj_test";
	beforeEach(() => {
		// ponytail: in-memory store, no teardown needed between tests — just
		// use a fresh projectId per test where isolation matters.
	});

	it("createSession returns a summary with messageCount=0", () => {
		const s = createSession(projectId, "  My chat  ");
		expect(s.title).toBe("My chat");
		expect(s.messageCount).toBe(0);
		expect(s.projectId).toBe(projectId);
		expect(s.id).toMatch(/^sess_/);
	});

	it("listSessions returns an empty array for a fresh project", () => {
		const list = listSessions("proj_empty");
		expect(list).toEqual([]);
	});

	it("selectSession returns the session with a copy of the messages array", () => {
		const s = createSession(projectId);
		const got = selectSession(projectId, s.id);
		expect(got).not.toBeNull();
		expect(got?.id).toBe(s.id);
		expect(got?.messages).toEqual([]);
		// ponytail: messages array is a copy, mutations don't leak.
		if (got) got.messages.push({} as never);
		const got2 = selectSession(projectId, s.id);
		expect(got2?.messages).toEqual([]);
	});

	it("selectSession returns null for an unknown sessionId", () => {
		expect(selectSession(projectId, "nope")).toBeNull();
	});

	it("renameSession updates the title and returns the updated summary", () => {
		const s = createSession(projectId);
		const updated = renameSession(projectId, s.id, "  Renamed  ");
		expect(updated?.title).toBe("Renamed");
		const got = selectSession(projectId, s.id);
		expect(got?.title).toBe("Renamed");
	});

	it("renameSession ignores empty input and keeps the existing title", () => {
		const s = createSession(projectId, "Original");
		const updated = renameSession(projectId, s.id, "   ");
		expect(updated?.title).toBe("Original");
	});

	it("renameSession returns null for an unknown sessionId", () => {
		expect(renameSession(projectId, "nope", "x")).toBeNull();
	});

	it("deleteSession removes the session and returns true", () => {
		const s = createSession(projectId);
		expect(deleteSession(projectId, s.id)).toBe(true);
		expect(selectSession(projectId, s.id)).toBeNull();
		expect(listSessions(projectId).find((x) => x.id === s.id)).toBeUndefined();
	});

	it("deleteSession returns false for an unknown id", () => {
		expect(deleteSession(projectId, "nope")).toBe(false);
	});

	it("listSessions returns sessions sorted by createdAt", async () => {
		const a = createSession("proj_sort", "A");
		await new Promise((r) => setTimeout(r, 5));
		const b = createSession("proj_sort", "B");
		await new Promise((r) => setTimeout(r, 5));
		const c = createSession("proj_sort", "C");
		const list = listSessions("proj_sort");
		expect(list.map((x) => x.id)).toEqual([a.id, b.id, c.id]);
	});

	it("listSessions only includes the requested project", () => {
		createSession("proj_a");
		createSession("proj_b");
		createSession("proj_b");
		expect(listSessions("proj_a").length).toBe(1);
		expect(listSessions("proj_b").length).toBe(2);
	});
});

// ponytail: type-only check that the runChat signature now takes a sessionId.
// We don't exercise the LLM call here — the real provider path needs network
// + API keys, which the integration tests cover elsewhere.
describe("chat-service runChat signature", () => {
	it("accepts (projectId, sessionId, message, llmConfig) and short-circuits without a config", async () => {
		// ponytail: stub LlmConfigStore whose getConfig() returns null, so
		// runChat exits early with the "No LLM provider configured" error.
		const llmConfig = { getConfig: () => null } as unknown as LlmConfigStore;
		const { runChat, createSession } = await import("./chat-service");
		const s = createSession("proj_sig");
		const result = await runChat("proj_sig", s.id, "hi", llmConfig);
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/No LLM provider/);
	});
});
