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
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
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

	it("keeps the transcript estimate when native usage is unavailable", async () => {
		chatBudgetMock.mockResolvedValue(undefined);
		const visibleMessages = message("x".repeat(400));
		const { result } = renderHook(() =>
			useChatBudget({ projectId: "project_1", sessionId: "session_1", messages: visibleMessages }),
		);

		await waitFor(() => expect(chatBudgetMock).toHaveBeenCalledTimes(1));
		await act(async () => Promise.resolve());
		expect(result.current.usedTokens).toBe(100);
	});

	it("keeps the transcript estimate when native usage rejects", async () => {
		chatBudgetMock.mockRejectedValue(new Error("native budget unavailable"));
		const visibleMessages = message("x".repeat(400));
		const { result } = renderHook(() =>
			useChatBudget({ projectId: "project_1", sessionId: "session_1", messages: visibleMessages }),
		);

		await waitFor(() => expect(chatBudgetMock).toHaveBeenCalledTimes(1));
		await act(async () => Promise.resolve());
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
