// Model-list discovery for the API-key providers in the registry.
//
// This file used to also carry the Codex (ChatGPT) and GitHub Copilot device
// flows. They were removed for 1.8.0: reaching a user's subscription that way
// meant shipping GitHub's and OpenAI's own OAuth client IDs and an
// `Editor-Version: vscode/…` User-Agent against endpoints reserved for
// first-party clients, inside a signed installer. Both vendors now expose a
// sanctioned surface instead — GitHub's Copilot SDK (we register our own OAuth
// App and pass the user's `gho_` token) and `codex app-server` (we drive the
// user's own `codex login`, so no client ID ships at all). Those are separate
// integrations, not a header swap, so they land in their own PR.
//
// Credentials still live in the `safeStorage` blob via `LlmConfigStore`.

/**
 * Generic `GET {url}` model-list fetch shared by the OpenAI-shaped
 * (`{data: [{id}]}`) and Anthropic-shaped (`{data: [{id}]}`) list endpoints.
 * `apiKey` is sent as a Bearer token unless `extraHeaders` overrides
 * Authorization. Ported from axcut's `fetchModelIds`.
 */
async function fetchModelIds(
	url: string,
	apiKey?: string,
	extraHeaders?: Record<string, string>,
): Promise<string[]> {
	const headers: Record<string, string> = { Accept: "application/json", ...extraHeaders };
	if (apiKey && !extraHeaders?.Authorization && !extraHeaders?.["x-api-key"]) {
		headers.Authorization = `Bearer ${apiKey}`;
	}
	const response = await fetch(url, { headers });
	if (!response.ok) {
		throw new Error(`Model discovery failed: HTTP ${response.status}`);
	}
	const payload = (await response.json()) as { data?: Array<{ id?: string }> };
	return (payload.data ?? [])
		.map((entry) => entry.id?.trim() ?? "")
		.filter((id) => id.length > 0)
		.sort((left, right) => left.localeCompare(right));
}

export async function listAnthropicModels(apiKey: string): Promise<string[]> {
	return fetchModelIds("https://api.anthropic.com/v1/models", undefined, {
		"x-api-key": apiKey,
		"anthropic-version": "2023-06-01",
	});
}

export async function listGoogleModels(apiKey: string): Promise<string[]> {
	const models = await fetchModelIds(
		"https://generativelanguage.googleapis.com/v1beta/openai/models",
		apiKey,
	);
	return models
		.map((model) => model.replace(/^models\//, ""))
		.filter((model) => /^gemini-/i.test(model));
}

export async function listMistralModels(apiKey: string): Promise<string[]> {
	return fetchModelIds("https://api.mistral.ai/v1/models", apiKey);
}

export async function listOpenRouterModels(): Promise<string[]> {
	return fetchModelIds("https://openrouter.ai/api/v1/models");
}

export async function listOpenAiCompatibleModels(
	baseUrl: string,
	apiKey?: string,
): Promise<string[]> {
	return fetchModelIds(`${baseUrl.replace(/\/+$/, "")}/models`, apiKey);
}

const MINIMAX_DISCOVERY_CANDIDATE_MODELS = [
	"MiniMax-M3",
	"MiniMax-M3-highspeed",
	"MiniMax-M2.7",
	"MiniMax-M2.7-highspeed",
	"MiniMax-M2.5",
	"MiniMax-M2.5-highspeed",
	"MiniMax-M2.1",
	"MiniMax-M2.1-highspeed",
	"MiniMax-M2",
] as const;

/**
 * MiniMax has no `/models` list endpoint, so — like axcut — probe each known
 * model slug with a 1-token completion call and keep the ones that don't
 * error. Uses the OpenAI-compatible `/v1/chat/completions` path (a sibling of
 * the Anthropic-shaped `/anthropic` base actually used for chat) purely as a
 * cheap existence check.
 *
 * ponytail: these probes spend the user's own key — 9 requests at max_tokens 1,
 * once per discovery click. Cache per key if it ever runs on a hot path.
 */
export async function probeMiniMaxModels(apiKey: string, baseUrl?: string): Promise<string[]> {
	const resolvedBaseUrl = baseUrl || "https://api.minimax.io/anthropic";
	// `baseUrl` is the Anthropic-shaped sibling — either the docs URL
	// (`/anthropic`) or the real one (`/anthropic/v1`). The OpenAI-compat
	// `/v1/chat/completions` path lives at the origin, not under `/anthropic`,
	// so strip that segment (and an optional trailing `/v\d+`) before appending
	// the probe path. Strips a trailing slash too, to keep the URL tidy.
	const origin = resolvedBaseUrl.replace(/\/anthropic(\/v\d+)?\/?$/, "").replace(/\/$/, "");
	const discoveryUrl = `${origin}/v1/chat/completions`;

	let firstFailure: { status: number; model: string } | undefined;
	const checks = await Promise.all(
		MINIMAX_DISCOVERY_CANDIDATE_MODELS.map(async (model) => {
			try {
				const response = await fetch(discoveryUrl, {
					method: "POST",
					headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
					body: JSON.stringify({
						model,
						messages: [{ role: "user", content: "ping" }],
						max_tokens: 1,
					}),
				});
				if (response.ok) return model;
				if (!firstFailure) firstFailure = { status: response.status, model };
				return undefined;
			} catch (error) {
				if (!firstFailure) {
					firstFailure = {
						status: 0,
						model: `${model} (${error instanceof Error ? error.message : String(error)})`,
					};
				}
				return undefined;
			}
		}),
	);
	const reachable = checks.filter(
		(model): model is (typeof MINIMAX_DISCOVERY_CANDIDATE_MODELS)[number] => Boolean(model),
	);
	if (reachable.length === 0 && firstFailure) {
		// All probes failed — surface the first failure so the UI can show a
		// meaningful reason instead of a silent empty list. A status of 0
		// indicates a network-level error (DNS, TLS, refused, …).
		const reason =
			firstFailure.status === 0
				? `network error probing ${firstFailure.model}`
				: `HTTP ${firstFailure.status} probing ${firstFailure.model}`;
		throw new Error(`No MiniMax models reachable at ${origin} (${reason})`);
	}
	return reachable;
}
