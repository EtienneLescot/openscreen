import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	beginCodexDeviceAuth,
	beginGithubDeviceAuth,
	completeCodexDeviceAuth,
	completeGithubDeviceAuth,
	exchangeGithubCopilotRuntimeToken,
	listGithubCopilotModels,
	listOpenAiAccountModels,
	probeMiniMaxModels,
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

/**
 * `probeMiniMaxModels` issues a parallel POST to the OpenAI-compat sibling of
 * the Anthropic base URL. The Anthropic base used to be `…/anthropic` and was
 * later corrected to `…/anthropic/v1` (see provider-registry.ts and
 * `76d823f fix(ai-edition): correct MiniMax base URL to /anthropic/v1`).
 * The earlier URL-construction only handled the no-`/v1` shape, so the
 * registry default produced the malformed `…/anthropic/v1/v1/chat/completions`
 * and every probe 404'd, returning an empty list with no surfaced error.
 *
 * These tests pin the URL construction across both shapes and assert the
 * filtering + error-surfacing behavior.
 */
describe("probeMiniMaxModels", () => {
	/**
	 * Per-model mock: `globalThis.fetch` is called once per candidate model in
	 * parallel. The impl decodes the request body to find the model name and
	 * returns the matching entry from `byModel` (or the default). The default
	 * is `ok: false` so tests that only populate a few models see those as
	 * the only reachable ones.
	 */
	function mockProbeFetch(
		byModel: Record<string, { ok: boolean; status?: number; body?: unknown }>,
		defaultResponse: { ok: boolean; status?: number; body?: unknown } = {
			ok: false,
			status: 404,
			body: { error: "not_found" },
		},
	) {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			const body = JSON.parse(String((init as RequestInit | undefined)?.body ?? "{}")) as {
				model?: string;
			};
			const entry = (body.model && byModel[body.model]) || defaultResponse;
			const status = entry.status ?? (entry.ok ? 200 : 500);
			return new Response(JSON.stringify(entry.body ?? {}), {
				status,
				headers: { "Content-Type": "application/json" },
			});
		});
	}

	function captureProbeUrls(): string[] {
		const calls = (
			globalThis.fetch as unknown as { mock: { calls: [string, RequestInit | undefined][] } }
		).mock.calls;
		return calls.map(([url]) => url);
	}

	it("strips /anthropic/v1 from the registry baseUrl and probes /v1/chat/completions at the origin", async () => {
		mockProbeFetch({ "MiniMax-M3": { ok: true } });

		const models = await probeMiniMaxModels("sk-test", "https://api.minimax.io/anthropic/v1");

		expect(models).toEqual(["MiniMax-M3"]);
		const urls = captureProbeUrls();
		expect(urls.length).toBeGreaterThan(0);
		for (const url of urls) {
			expect(url).toBe("https://api.minimax.io/v1/chat/completions");
		}
	});

	it("also handles the legacy /anthropic-only baseUrl (docs URL)", async () => {
		mockProbeFetch({ "MiniMax-M3": { ok: true } });

		const models = await probeMiniMaxModels("sk-test", "https://api.minimax.io/anthropic");

		expect(models).toEqual(["MiniMax-M3"]);
		for (const url of captureProbeUrls()) {
			expect(url).toBe("https://api.minimax.io/v1/chat/completions");
		}
	});

	it("tolerates trailing slashes on either baseUrl shape", async () => {
		mockProbeFetch({ "MiniMax-M3": { ok: true } });

		await probeMiniMaxModels("sk-test", "https://api.minimax.io/anthropic/v1/");
		for (const url of captureProbeUrls()) {
			expect(url).toBe("https://api.minimax.io/v1/chat/completions");
		}

		mockProbeFetch({ "MiniMax-M3": { ok: true } });
		await probeMiniMaxModels("sk-test", "https://api.minimax.io/anthropic/");
		for (const url of captureProbeUrls()) {
			expect(url).toBe("https://api.minimax.io/v1/chat/completions");
		}
	});

	it("falls back to the hard-coded default baseUrl when none is supplied", async () => {
		mockProbeFetch({ "MiniMax-M3": { ok: true } });

		const models = await probeMiniMaxModels("sk-test");

		expect(models).toEqual(["MiniMax-M3"]);
		for (const url of captureProbeUrls()) {
			expect(url).toBe("https://api.minimax.io/v1/chat/completions");
		}
	});

	it("returns only the candidate slugs that respond ok", async () => {
		mockProbeFetch({
			"MiniMax-M3": { ok: true },
			"MiniMax-M2.7": { ok: true },
			"MiniMax-M2.5": { ok: false, status: 403 },
			"MiniMax-M2.1": { ok: false, status: 404 },
		});

		const models = await probeMiniMaxModels("sk-test", "https://api.minimax.io/anthropic/v1");
		expect(models).toEqual(["MiniMax-M3", "MiniMax-M2.7"]);
	});

	it("throws with the origin and a status hint when no candidate is reachable", async () => {
		mockProbeFetch({}, { ok: false, status: 404, body: { error: "not_found" } });

		await expect(
			probeMiniMaxModels("sk-test", "https://api.minimax.io/anthropic/v1"),
		).rejects.toThrow(/https:\/\/api\.minimax\.io .*HTTP 404/);
	});
});
