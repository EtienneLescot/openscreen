import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	beginCodexDeviceAuth,
	beginGithubDeviceAuth,
	completeCodexDeviceAuth,
	completeGithubDeviceAuth,
	exchangeGithubCopilotRuntimeToken,
	listGithubCopilotModels,
	listOpenAiAccountModels,
} from "./llm-provider-auth";

const ORIGINAL_FETCH = globalThis.fetch;

function mockFetchSequence(
	responses: Array<{ ok: boolean; status?: number; body: unknown; delayMs?: number }>,
) {
	const queue = [...responses];
	vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
		const next = queue.shift();
		if (!next) throw new Error("mock fetch: no response queued");
		const init = next.delayMs ? await new Promise<void>((r) => setTimeout(r, next.delayMs)) : null;
		void init;
		const status = next.status ?? (next.ok ? 200 : 500);
		return new Response(JSON.stringify(next.body), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	});
}

afterEach(() => {
	vi.restoreAllMocks();
	globalThis.fetch = ORIGINAL_FETCH;
});

describe("beginCodexDeviceAuth", () => {
	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	it("POSTs to the Codex usercode endpoint and returns a normalized challenge", async () => {
		mockFetchSequence([
			{
				ok: true,
				body: {
					device_auth_id: "codex-id-abc",
					user_code: "ABCD-EFGH",
					interval: "7",
					expires_in: 900,
				},
			},
		]);

		const challenge = await beginCodexDeviceAuth();

		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		const [url, init] = (globalThis.fetch as unknown as { mock: { calls: [unknown, unknown][] } })
			.mock.calls[0]!;
		expect(url).toBe("https://auth.openai.com/api/accounts/deviceauth/usercode");
		expect(init).toMatchObject({ method: "POST" });

		expect(challenge.userCode).toBe("ABCD-EFGH");
		expect(challenge.deviceAuthId).toBe("codex-id-abc");
		expect(challenge.verificationUri).toBe("https://auth.openai.com/codex/device");
		expect(challenge.intervalMs).toBe(7000);
		expect(challenge.expiresAt).toBeGreaterThan(Date.now() + 100_000);
	});
});

describe("completeCodexDeviceAuth", () => {
	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	it("exchanges the device code for tokens via OAuth token endpoint", async () => {
		mockFetchSequence([
			{
				ok: true,
				body: { authorization_code: "auth-code-1", code_verifier: "verifier-1" },
			},
			{
				ok: true,
				body: {
					access_token: "eyJhbGciOiJIUzI1NiJ9.payload.signature",
					refresh_token: "rt-1",
					expires_in: 3600,
				},
			},
		]);

		const tokens = await completeCodexDeviceAuth({
			deviceAuthId: "codex-id",
			userCode: "USER",
			intervalMs: 10,
			expiresAt: Date.now() + 60_000,
		});

		expect(tokens.accessToken).toMatch(/^eyJ/);
		expect(tokens.refreshToken).toBe("rt-1");
		expect(tokens.expiresAt).toBeGreaterThan(Date.now());
	});

	it("throws when the device code expires", async () => {
		mockFetchSequence([{ ok: false, status: 403, body: { error: "expired_token" } }]);

		await expect(
			completeCodexDeviceAuth({
				deviceAuthId: "id",
				userCode: "code",
				intervalMs: 1,
				expiresAt: Date.now() - 1,
			}),
		).rejects.toThrow(/expired/);
	});
});

describe("beginGithubDeviceAuth", () => {
	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	it("POSTs to GitHub /login/device/code with client_id and read:user scope", async () => {
		mockFetchSequence([
			{
				ok: true,
				body: {
					device_code: "gh-device-1",
					user_code: "GH-USER",
					verification_uri: "https://github.com/login/device",
					interval: 5,
					expires_in: 900,
				},
			},
		]);

		const challenge = await beginGithubDeviceAuth();

		const [url, init] = (globalThis.fetch as unknown as { mock: { calls: [unknown, unknown][] } })
			.mock.calls[0]!;
		expect(url).toBe("https://github.com/login/device/code");
		expect(init).toMatchObject({ method: "POST" });

		const fetchBody = (init as RequestInit).body as URLSearchParams;
		expect(fetchBody.get("client_id")).toBe("Iv1.b507a08c87ecfe98");
		expect(fetchBody.get("scope")).toBe("read:user");

		expect(challenge.userCode).toBe("GH-USER");
		expect(challenge.deviceCode).toBe("gh-device-1");
	});

	it("falls back to the GitHub login URL when the server omits verification_uri", async () => {
		mockFetchSequence([
			{
				ok: true,
				body: {
					device_code: "d-2",
					user_code: "X",
					interval: 5,
					expires_in: 900,
				},
			},
		]);

		const challenge = await beginGithubDeviceAuth();
		expect(challenge.verificationUri).toBe("https://github.com/login/device");
	});
});

describe("completeGithubDeviceAuth", () => {
	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	it("returns the access token on the first poll", async () => {
		mockFetchSequence([{ ok: true, body: { access_token: "ghp_token_1" } }]);

		const token = await completeGithubDeviceAuth({
			deviceCode: "d-1",
			userCode: "U",
			intervalMs: 1,
			expiresAt: Date.now() + 60_000,
		});
		expect(token).toBe("ghp_token_1");
	});

	it("throws an error for non-pending failures", async () => {
		mockFetchSequence([
			{ ok: true, body: { error: "access_denied", error_description: "User rejected" } },
		]);

		await expect(
			completeGithubDeviceAuth({
				deviceCode: "d-3",
				userCode: "U",
				intervalMs: 1,
				expiresAt: Date.now() + 60_000,
			}),
		).rejects.toThrow(/User rejected/);
	});
});

describe("exchangeGithubCopilotRuntimeToken", () => {
	it("exchanges the long-lived GitHub PAT for the short-lived Copilot bearer", async () => {
		mockFetchSequence([
			{
				ok: true,
				body: {
					token: "tid=copilot;exp=2026",
					expires_at: Math.floor(Date.now() / 1000) + 1800,
				},
			},
		]);

		const out = await exchangeGithubCopilotRuntimeToken("ghp_x");
		expect(out.token).toMatch(/^tid=copilot;exp=/);
		expect(out.expiresAt).toBeGreaterThan(Date.now());
		expect(out.baseUrl).toBe("https://api.individual.githubcopilot.com");
	});
});

describe("listOpenAiAccountModels", () => {
	const jwtForAccount = (accountId: string): string => {
		const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
		const payload = Buffer.from(
			JSON.stringify({
				"https://api.openai.com/auth": { chatgpt_account_id: accountId },
			}),
		).toString("base64url");
		return `${header}.${payload}.signature`;
	};

	it("returns the slug list visible to the account, sorted by priority", async () => {
		mockFetchSequence([
			{
				ok: true,
				body: {
					models: [
						{ slug: "gpt-5.4", visibility: "list", priority: 10 },
						{ slug: "gpt-4o", visibility: "list", priority: 1 },
						{ slug: "secret", visibility: "private" },
						{ slug: "internal", visibility: "hidden" },
					],
				},
			},
		]);

		const models = await listOpenAiAccountModels(jwtForAccount("acc-1"));
		expect(models).toEqual(["gpt-4o", "gpt-5.4"]);
	});
});

describe("listGithubCopilotModels", () => {
	it("exchanges the PAT, lists the Copilot catalog, and sorts alphabetically", async () => {
		// 1) Copilot token exchange
		// 2) GET {baseUrl}/models
		mockFetchSequence([
			{
				ok: true,
				body: {
					token: "copilot-bearer",
					expires_at: Math.floor(Date.now() / 1000) + 1800,
				},
			},
			{
				ok: true,
				body: {
					data: [{ id: "gpt-4o" }, { id: "claude-3.5-sonnet" }, { id: "gpt-3.5-turbo" }],
				},
			},
		]);

		const models = await listGithubCopilotModels("ghp_x");
		expect(models).toEqual(["claude-3.5-sonnet", "gpt-3.5-turbo", "gpt-4o"]);
	});
});
