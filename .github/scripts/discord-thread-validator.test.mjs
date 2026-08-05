import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateThreadChannel } from "./discord-thread-validator.mjs";

beforeEach(() => {
	vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("validateThreadChannel", () => {
	const botToken = "bot-token";
	const number = 42;

	it("fails closed when botToken is unset", async () => {
		const result = await validateThreadChannel("123", number, { botToken: "" });
		expect(result).toBe(false);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("rejects a forged marker pointing at a random thread (wrong parent)", async () => {
		vi.mocked(fetch).mockResolvedValue({
			ok: true,
			json: async () => ({
				id: "111",
				parent_id: "999999999999999999",
				name: `PR #${number} - Some PR`,
			}),
		});

		const result = await validateThreadChannel("111", number, {
			botToken,
			forumChannelId: "888888888888888888",
		});

		expect(result).toBe(false);
	});

	it("rejects a marker pointing at a sibling PR thread in the same forum", async () => {
		vi.mocked(fetch).mockResolvedValue({
			ok: true,
			json: async () => ({
				id: "222",
				parent_id: "888888888888888888",
				name: `PR #99 - Other PR`,
			}),
		});

		const result = await validateThreadChannel("222", number, {
			botToken,
			forumChannelId: "888888888888888888",
		});

		expect(result).toBe(false);
	});

	it("accepts a valid bot-created thread for PR #N", async () => {
		vi.mocked(fetch).mockResolvedValue({
			ok: true,
			json: async () => ({
				id: "333",
				parent_id: "888888888888888888",
				name: `PR #${number} - My feature`,
			}),
		});

		const result = await validateThreadChannel("333", number, {
			botToken,
			forumChannelId: "888888888888888888",
		});

		expect(result).toBe(true);
	});

	it("returns false when Discord API returns non-ok", async () => {
		vi.mocked(fetch).mockResolvedValue({
			ok: false,
			status: 404,
		});

		const result = await validateThreadChannel("404", number, { botToken });
		expect(result).toBe(false);
	});

	it("passes an AbortSignal with timeout to fetch", async () => {
		vi.mocked(fetch).mockResolvedValue({
			ok: true,
			json: async () => ({
				id: "777",
				parent_id: "888888888888888888",
				name: `PR #${number} - gated`,
			}),
		});

		await validateThreadChannel("777", number, {
			botToken,
			forumChannelId: "888888888888888888",
		});

		const call = vi.mocked(fetch).mock.calls[0];
		expect(call[1].signal).toBeInstanceOf(AbortSignal);
	});

	it("returns false when fetch throws", async () => {
		vi.mocked(fetch).mockRejectedValue(new Error("network error"));

		const result = await validateThreadChannel("500", number, { botToken });
		expect(result).toBe(false);
	});

	it("leaves no timer armed once it has returned, on either path", async () => {
		vi.useFakeTimers();
		try {
			vi.mocked(fetch).mockRejectedValue(new Error("network error"));
			await validateThreadChannel("500", number, { botToken });
			// The failing path is the one that used to leak: `clearTimeout` sat after
			// the `await`, so a rejected fetch skipped it and left the 5s abort timer
			// running past the end of the test.
			expect(vi.getTimerCount()).toBe(0);

			vi.mocked(fetch).mockResolvedValue({ ok: false, status: 404 });
			await validateThreadChannel("404", number, { botToken });
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});
