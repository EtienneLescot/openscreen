import { afterEach, describe, expect, it, vi } from "vitest";

import { probeMiniMaxModels } from "./llm-provider-auth";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
	vi.restoreAllMocks();
	globalThis.fetch = ORIGINAL_FETCH;
});

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
