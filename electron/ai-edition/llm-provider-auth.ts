// Device-flow + GitHub Copilot runtime-token helpers for the AI provider
// feature. Ported from axcut (apps/server/src/llm/provider-runtime/openai-account.ts,
// copilot-account.ts, and the inline functions in services/llm-config-service.ts).
//
// Credentials returned by `complete*` flows land in the same
// `safeStorage` blob as API keys via `LlmConfigStore`. No plain-text auth
// files on disk.
//
// Endpoints are not proxied through OpenScreen itself — the Electron
// main process has direct internet access via `app.requestSingleInstanceLock`.

export interface CodexDeviceChallenge {
	verificationUri: string;
	verificationUriComplete?: string;
	userCode: string;
	deviceAuthId: string;
	intervalMs: number;
	expiresAt: number;
}

export interface GithubDeviceChallenge {
	verificationUri: string;
	userCode: string;
	deviceCode: string;
	intervalMs: number;
	expiresAt: number;
}

export interface CodexTokens {
	accessToken: string;
	refreshToken?: string;
	idToken?: string;
	expiresAt?: number;
	accountId?: string;
}

export interface GithubCopilotRuntimeToken {
	token: string;
	expiresAt: number;
	baseUrl: string;
}

const CODEX_ISSUER = "https://auth.openai.com";
const CODEX_TOKEN_ENDPOINT = `${CODEX_ISSUER}/oauth/token`;
const CODEX_DEVICE_AUTHORIZATION_ENDPOINT = `${CODEX_ISSUER}/api/accounts/deviceauth/usercode`;
const CODEX_DEVICE_TOKEN_ENDPOINT = `${CODEX_ISSUER}/api/accounts/deviceauth/token`;
const CODEX_DEVICE_REDIRECT_URI = `${CODEX_ISSUER}/deviceauth/callback`;
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_DEVICE_POLLING_SAFETY_MARGIN_MS = 3_000;
export const OPENAI_ACCOUNT_BASE_URL = "https://chatgpt.com/backend-api";
const CODEX_MODELS_PATH = "/codex/models";
const GITHUB_DEVICE_CODE_ENDPOINT = "https://github.com/login/device/code";
const GITHUB_DEVICE_TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";
const GITHUB_DEVICE_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const GITHUB_DEVICE_SCOPE = "read:user";
const GITHUB_DEVICE_POLLING_SAFETY_MARGIN_MS = 3_000;
const COPILOT_TOKEN_ENDPOINT = "https://api.github.com/copilot_internal/v2/token";
const GITHUB_COPILOT_USER_AGENT = "GitHubCopilotChat/0.26.7";
const GITHUB_COPILOT_EDITOR_VERSION = "vscode/1.96.2";
const GITHUB_COPILOT_PLUGIN_VERSION = "copilot-chat/0.26.7";

/**
 * Begin the Codex (ChatGPT) device flow. Returns the user code and the
 * polling parameters needed by {@link completeCodexDeviceAuth}.
 */
export async function beginCodexDeviceAuth(): Promise<CodexDeviceChallenge> {
	const response = await fetch(CODEX_DEVICE_AUTHORIZATION_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
	});

	if (!response.ok) {
		const detail = await safeErrorDetail(response);
		throw new Error(
			detail
				? `OpenAI device login failed: ${detail}`
				: `OpenAI device login failed: HTTP ${response.status}`,
		);
	}

	const payload = (await response.json()) as {
		device_auth_id?: string;
		user_code?: string;
		interval?: string;
		expires_in?: number;
	};

	if (!payload.device_auth_id || !payload.user_code) {
		throw new Error("OpenAI device login returned an incomplete challenge.");
	}

	const intervalSeconds = Number.parseInt(payload.interval ?? "5", 10);
	const intervalMs = Math.max(Number.isFinite(intervalSeconds) ? intervalSeconds : 5, 1) * 1000;

	return {
		verificationUri: `${CODEX_ISSUER}/codex/device`,
		userCode: payload.user_code,
		deviceAuthId: payload.device_auth_id,
		intervalMs,
		expiresAt: Date.now() + (payload.expires_in ?? 600) * 1000,
	};
}

/**
 * Poll the Codex device-token endpoint until we get an authorization code,
 * exchange it at the OAuth token endpoint, and return the access + refresh
 * tokens. The caller persists them via `LlmConfigStore.setCredential`.
 */
export async function completeCodexDeviceAuth(
	challenge: Omit<CodexDeviceChallenge, "verificationUri" | "verificationUriComplete">,
): Promise<CodexTokens> {
	const intervalMs = Math.max(1000, challenge.intervalMs);

	while (Date.now() < challenge.expiresAt) {
		const response = await fetch(CODEX_DEVICE_TOKEN_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				device_auth_id: challenge.deviceAuthId,
				user_code: challenge.userCode,
			}),
		});

		if (response.ok) {
			const deviceToken = (await response.json()) as {
				authorization_code?: string;
				code_verifier?: string;
			};

			if (!deviceToken.authorization_code || !deviceToken.code_verifier) {
				throw new Error("OpenAI device login returned an incomplete authorization result.");
			}

			const body = new URLSearchParams();
			body.set("grant_type", "authorization_code");
			body.set("code", deviceToken.authorization_code);
			body.set("redirect_uri", CODEX_DEVICE_REDIRECT_URI);
			body.set("client_id", CODEX_CLIENT_ID);
			body.set("code_verifier", deviceToken.code_verifier);

			const tokenResponse = await fetch(CODEX_TOKEN_ENDPOINT, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: body.toString(),
			});

			if (!tokenResponse.ok) {
				const detail = await safeErrorDetail(tokenResponse);
				throw new Error(
					detail
						? `OpenAI token exchange failed: ${detail}`
						: `OpenAI token exchange failed: HTTP ${tokenResponse.status}`,
				);
			}

			const tokens = (await tokenResponse.json()) as {
				access_token?: string;
				refresh_token?: string;
				id_token?: string;
				expires_in?: number;
			};

			if (!tokens.access_token) {
				throw new Error("OpenAI device login returned no access_token.");
			}

			const expiresAt = tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined;

			return {
				accessToken: tokens.access_token,
				refreshToken: tokens.refresh_token,
				idToken: tokens.id_token,
				expiresAt,
				accountId: extractChatgptAccountId(tokens.access_token, tokens.id_token),
			};
		}

		if (response.status !== 403 && response.status !== 404) {
			const detail = await safeErrorDetail(response);
			throw new Error(detail || `OpenAI device flow failed: HTTP ${response.status}`);
		}

		await delay(intervalMs + CODEX_DEVICE_POLLING_SAFETY_MARGIN_MS);
	}

	throw new Error("OpenAI device code expired. Retry setup.");
}

/**
 * Begin the GitHub Device Flow. Same shape as {@link beginCodexDeviceAuth}
 * but the next step is {@link completeGithubDeviceAuth}, which returns
 * a Copilot-personal-access-token-style string stored as the user's
 * GitHub PAT against the `copilot-proxy` provider.
 */
export async function beginGithubDeviceAuth(): Promise<GithubDeviceChallenge> {
	const response = await fetch(GITHUB_DEVICE_CODE_ENDPOINT, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({ client_id: GITHUB_DEVICE_CLIENT_ID, scope: GITHUB_DEVICE_SCOPE }),
	});

	if (!response.ok) {
		throw new Error(`GitHub device code failed: HTTP ${response.status}`);
	}

	const payload = (await response.json()) as Record<string, unknown>;
	const verificationUri =
		typeof payload.verification_uri === "string"
			? payload.verification_uri
			: "https://github.com/login/device";
	const userCode = typeof payload.user_code === "string" ? payload.user_code : "";
	const deviceCode = typeof payload.device_code === "string" ? payload.device_code : "";
	const intervalSeconds = Number(payload.interval ?? 5);
	const expiresInSeconds = Number(payload.expires_in ?? 900);

	if (!userCode || !deviceCode) {
		throw new Error("GitHub device code returned an incomplete challenge.");
	}

	return {
		verificationUri,
		userCode,
		deviceCode,
		intervalMs: Math.max(1000, Number.isFinite(intervalSeconds) ? intervalSeconds * 1000 : 5_000),
		expiresAt: Date.now() + (Number.isFinite(expiresInSeconds) ? expiresInSeconds : 900) * 1000,
	};
}

/**
 * Poll the GitHub access-token endpoint and return the PAT. Axcut's
 * `copilot-account.ts` is a thin wrapper around the same `completeGitHubDeviceAuth`,
 * which is what we expose here.
 */
export async function completeGithubDeviceAuth(
	challenge: Omit<GithubDeviceChallenge, "verificationUri">,
): Promise<string> {
	while (Date.now() < challenge.expiresAt) {
		const response = await fetch(GITHUB_DEVICE_TOKEN_ENDPOINT, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				client_id: GITHUB_DEVICE_CLIENT_ID,
				device_code: challenge.deviceCode,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			}),
		});

		const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
		const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
		if (accessToken) {
			return accessToken;
		}

		const error = typeof payload.error === "string" ? payload.error : "";
		if (error && error !== "authorization_pending" && error !== "slow_down") {
			const description =
				typeof payload.error_description === "string" ? payload.error_description : error;
			throw new Error(description);
		}

		await delay(challenge.intervalMs + GITHUB_DEVICE_POLLING_SAFETY_MARGIN_MS);
	}

	throw new Error("GitHub device login expired.");
}

/**
 * Exchange a long-lived GitHub PAT (or OAuth-derived token) for the
 * short-lived Copilot API bearer used to call the models endpoint.
 * Caller is responsible for caching this; we do not persist the
 * Copilot runtime token here.
 */
export async function exchangeGithubCopilotRuntimeToken(
	githubToken: string,
): Promise<GithubCopilotRuntimeToken> {
	const response = await fetch(COPILOT_TOKEN_ENDPOINT, {
		method: "GET",
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${githubToken}`,
			"User-Agent": "GitHubCopilotChat/0.26.7",
		},
	});

	if (!response.ok) {
		throw new Error(`Copilot token exchange failed: HTTP ${response.status}`);
	}

	const payload = (await response.json()) as {
		token?: string;
		expires_at?: number;
		expires_in?: number;
	};
	if (!payload.token) {
		throw new Error("Copilot token exchange returned no token.");
	}

	const expiresAt =
		typeof payload.expires_at === "number"
			? payload.expires_at * 1000
			: Date.now() + (typeof payload.expires_in === "number" ? payload.expires_in : 300) * 1000;

	return {
		token: payload.token,
		expiresAt,
		baseUrl: deriveCopilotApiBaseUrl(payload.token) ?? "https://api.individual.githubcopilot.com",
	};
}

function deriveCopilotApiBaseUrl(token: string): string | undefined {
	try {
		const [, payload] = token.split(".");
		if (!payload) return undefined;
		const json = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as {
			endpoints?: { api?: string };
		};
		const api = json.endpoints?.api;
		return typeof api === "string" ? api : undefined;
	} catch {
		return undefined;
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch the model list for an already-authenticated ChatGPT (Codex) account.
 * Returns the slug list visible to the account, sorted by ascending priority.
 * On any error, returns an empty list (the caller should fall back to the
 * default model in the form).
 */
export async function listOpenAiAccountModels(accessToken: string): Promise<string[]> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
	};
	try {
		const accountId = extractChatgptAccountId(accessToken);
		if (accountId) headers["chatgpt-account-id"] = accountId;
	} catch {
		// best effort
	}

	const response = await fetch(
		`${OPENAI_ACCOUNT_BASE_URL}${CODEX_MODELS_PATH}?client_version=1.0.0`,
		{
			headers,
		},
	);

	if (!response.ok) {
		throw new Error(`Codex model discovery failed: HTTP ${response.status}`);
	}

	const data = (await response.json()) as {
		models?: Array<{
			slug?: string;
			visibility?: string;
			supported_in_api?: boolean;
			priority?: number;
		}>;
	};

	return (data.models ?? [])
		.filter((model) => typeof model.slug === "string" && model.slug!.trim().length > 0)
		.filter((model) => (model.visibility ?? "list") === "list")
		.sort(
			(left, right) =>
				(left.priority ?? Number.MAX_SAFE_INTEGER) - (right.priority ?? Number.MAX_SAFE_INTEGER),
		)
		.map((model) => model.slug!.trim());
}

/**
 * Fetch the model list for an already-authenticated GitHub Copilot account.
 * Exchanges the stored PAT for a short-lived Copilot API bearer, then calls
 * `{baseUrl}/models`. The result is sorted alphabetically for stable rendering.
 */
export async function listGithubCopilotModels(githubToken: string): Promise<string[]> {
	const runtime = await exchangeGithubCopilotRuntimeToken(githubToken);
	const response = await fetch(`${runtime.baseUrl}/models`, {
		headers: {
			Authorization: `Bearer ${runtime.token}`,
			Accept: "application/json",
			"User-Agent": GITHUB_COPILOT_USER_AGENT,
			"Editor-Version": GITHUB_COPILOT_EDITOR_VERSION,
			"Editor-Plugin-Version": GITHUB_COPILOT_PLUGIN_VERSION,
		},
	});

	if (!response.ok) {
		throw new Error(`Copilot model discovery failed: HTTP ${response.status}`);
	}

	const payload = (await response.json()) as { data?: Array<{ id?: string }> };
	return (payload.data ?? [])
		.map((entry) => entry.id?.trim() ?? "")
		.filter((id) => id.length > 0)
		.sort((left, right) => left.localeCompare(right));
}

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
 */
export async function probeMiniMaxModels(apiKey: string, baseUrl?: string): Promise<string[]> {
	const resolvedBaseUrl = baseUrl || "https://api.minimax.io/anthropic";
	const discoveryUrl = resolvedBaseUrl.endsWith("/anthropic")
		? resolvedBaseUrl.replace(/\/anthropic\/?$/, "/v1/chat/completions")
		: `${resolvedBaseUrl.replace(/\/$/, "")}/v1/chat/completions`;

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
				return response.ok ? model : undefined;
			} catch {
				return undefined;
			}
		}),
	);
	return checks.filter((model): model is (typeof MINIMAX_DISCOVERY_CANDIDATE_MODELS)[number] =>
		Boolean(model),
	);
}

async function safeErrorDetail(response: Response): Promise<string | undefined> {
	try {
		const data = (await response.json()) as {
			error?: string;
			error_description?: string;
			message?: string;
		};
		return data.error_description ?? data.message ?? data.error;
	} catch {
		try {
			return (await response.text()).trim() || undefined;
		} catch {
			return undefined;
		}
	}
}

/**
 * Pull the `chatgpt_account_id` claim from a ChatGPT JWT (access token or
 * id token). Returns undefined if the claim is missing — model discovery
 * then omits the `chatgpt-account-id` header.
 */
export function extractChatgptAccountId(accessToken: string, idToken?: string): string | undefined {
	for (const token of [accessToken, idToken ?? ""]) {
		if (!token) continue;
		const segments = token.split(".");
		if (segments.length !== 3) continue;
		try {
			const json = Buffer.from(segments[1]!, "base64").toString("utf8");
			const payload = JSON.parse(json) as Record<string, unknown>;
			const claim = payload["https://api.openai.com/auth"];
			if (claim && typeof claim === "object") {
				const accountId = (claim as Record<string, unknown>).chatgpt_account_id;
				if (typeof accountId === "string" && accountId) {
					return accountId;
				}
			}
		} catch {
			// fall through and try next token
		}
	}
	return undefined;
}
