// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatBudget } from "./useChatBudget";

const chatBudgetMock = vi.hoisted(() => vi.fn());

vi.mock("@/native/client", () => ({
	nativeBridgeClient: {
		aiEdition: { chatBudget: chatBudgetMock },
	},
}));

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

const message = (content: string) => [{ content }];

describe("useChatBudget", () => {
	beforeEach(() => chatBudgetMock.mockReset());

	it("uses the transcript estimate until native model-context usage arrives", async () => {
		const native = deferred<{
			usedTokens: number;
			budgetTokens: number;
			ratio: number;
			fillPercent: number;
		}>();
		chatBudgetMock.mockReturnValue(native.promise);
		const visibleMessages = message("x".repeat(400));

		const { result } = renderHook(() =>
			useChatBudget({ projectId: "project_1", sessionId: "session_1", messages: visibleMessages }),
		);
		expect(result.current.usedTokens).toBe(100);

		act(() =>
			native.resolve({ usedTokens: 12, budgetTokens: 80_000, ratio: 0.00015, fillPercent: 0.015 }),
		);
		await waitFor(() => expect(result.current.usedTokens).toBe(12));
	});

	it("keeps the transcript estimate when no session is selected", () => {
		const visibleMessages = message("x".repeat(400));
		const { result } = renderHook(() =>
			useChatBudget({ projectId: "project_1", sessionId: null, messages: visibleMessages }),
		);

		expect(result.current.usedTokens).toBe(100);
		expect(chatBudgetMock).not.toHaveBeenCalled();
	});

	it("tracks the transcript while native usage has never arrived", async () => {
		// The transcript has to keep MOVING, not just happen to match: asserting 100
		// before and after a null answer cannot tell "fell back correctly" apart from
		// "the effect never ran".
		chatBudgetMock.mockResolvedValue(undefined);
		const { result, rerender } = renderHook(
			({ messages }) => useChatBudget({ projectId: "project_1", sessionId: "session_1", messages }),
			{ initialProps: { messages: message("x".repeat(400)) } },
		);
		await waitFor(() => expect(chatBudgetMock).toHaveBeenCalledTimes(1));
		expect(result.current.usedTokens).toBe(100);

		rerender({ messages: message("x".repeat(800)) });
		await waitFor(() => expect(result.current.usedTokens).toBe(200));
		expect(chatBudgetMock).toHaveBeenCalledTimes(2);
	});

	it("keeps the last native number when a refresh fails, instead of swapping quantity", async () => {
		// The two numbers are not interchangeable. After a compaction the native one is
		// roughly half the transcript estimate, so silently substituting the transcript
		// on a failed refresh made the compaction visibly un-happen -- the PR's own
		// premise turned against it. A stale native number is the honest answer here.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {
			// swallowed: the point is that it is CALLED, not what it prints
		});
		chatBudgetMock
			.mockResolvedValueOnce({
				usedTokens: 12,
				budgetTokens: 80_000,
				ratio: 0.00015,
				fillPercent: 0.015,
			})
			.mockRejectedValueOnce(new Error("native budget unavailable"));
		const { result, rerender } = renderHook(
			({ messages }) => useChatBudget({ projectId: "project_1", sessionId: "session_1", messages }),
			{ initialProps: { messages: message("x".repeat(400)) } },
		);
		await waitFor(() => expect(result.current.usedTokens).toBe(12));

		rerender({ messages: message("x".repeat(800)) });
		await waitFor(() => expect(chatBudgetMock).toHaveBeenCalledTimes(2));
		await act(async () => Promise.resolve());
		expect(result.current.usedTokens).toBe(12);
		// And it is not silent: renaming the bridge action must leave a trace.
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("drops a native number when the session changes", async () => {
		// The kept-on-failure number belongs to one conversation. Session 2's first
		// refresh never answering must not leave session 1's number on screen.
		const pending = deferred<never>();
		chatBudgetMock
			.mockResolvedValueOnce({
				usedTokens: 12,
				budgetTokens: 80_000,
				ratio: 0.00015,
				fillPercent: 0.015,
			})
			.mockReturnValueOnce(pending.promise);
		const visibleMessages = message("x".repeat(400));
		const { result, rerender } = renderHook(
			({ sessionId }) =>
				useChatBudget({ projectId: "project_1", sessionId, messages: visibleMessages }),
			{ initialProps: { sessionId: "session_1" } },
		);
		await waitFor(() => expect(result.current.usedTokens).toBe(12));

		rerender({ sessionId: "session_2" });
		expect(result.current.usedTokens).toBe(100);
	});

	it("ignores a late response from the previously selected session", async () => {
		const first = deferred<{
			usedTokens: number;
			budgetTokens: number;
			ratio: number;
			fillPercent: number;
		}>();
		const second = deferred<{
			usedTokens: number;
			budgetTokens: number;
			ratio: number;
			fillPercent: number;
		}>();
		chatBudgetMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const visibleMessages = message("visible transcript");

		const { result, rerender } = renderHook(
			({ sessionId }) =>
				useChatBudget({ projectId: "project_1", sessionId, messages: visibleMessages }),
			{ initialProps: { sessionId: "session_1" } },
		);
		rerender({ sessionId: "session_2" });
		act(() =>
			second.resolve({ usedTokens: 20, budgetTokens: 80_000, ratio: 0.00025, fillPercent: 0.025 }),
		);
		await waitFor(() => expect(result.current.usedTokens).toBe(20));

		act(() =>
			first.resolve({ usedTokens: 999, budgetTokens: 80_000, ratio: 0.012, fillPercent: 1.2 }),
		);
		await act(async () => Promise.resolve());
		expect(result.current.usedTokens).toBe(20);
	});

	it("refreshes native usage when compaction returns a new transcript array", async () => {
		chatBudgetMock
			.mockResolvedValueOnce({
				usedTokens: 500,
				budgetTokens: 80_000,
				ratio: 0.00625,
				fillPercent: 0.625,
			})
			.mockResolvedValueOnce({
				usedTokens: 40,
				budgetTokens: 80_000,
				ratio: 0.0005,
				fillPercent: 0.05,
			});
		const visibleMessages = message("the transcript remains visible");
		const { result, rerender } = renderHook(
			({ messages }) => useChatBudget({ projectId: "project_1", sessionId: "session_1", messages }),
			{ initialProps: { messages: visibleMessages } },
		);
		await waitFor(() => expect(result.current.usedTokens).toBe(500));

		rerender({ messages: [...visibleMessages] });
		await waitFor(() => expect(result.current.usedTokens).toBe(40));
		expect(chatBudgetMock).toHaveBeenCalledTimes(2);
	});
});
