// Provider definitions for the AI features layer. Static data — no runtime
// deps. Mirrors axcut's apps/server/src/llm/provider-registry.ts.
//
// Each entry carries enough metadata for the ProviderSettingsDialog to render
// without hitting the network. Default model + base URL reflect axcut's
// current defaults (Gemini uses the OpenAI-compatible /v1beta/openai base so
// it shares the OpenAI wire path).

export interface ProviderDefinition {
	id: string;
	label: string;
	defaultModel: string;
	authKind: "api-key" | "oauth-device" | "pat";
	supportsReasoningEffort: boolean;
	/** True when this provider always requires the user to enter a base URL
	 * (e.g. openai-compatible). False when the default is implicit. */
	requiresBaseUrl?: boolean;
	/** Free-text guidance shown beneath the form when a user picks this
	 * provider — mirrors axcut's `setupHint`. */
	setupHint?: string;
	envKeys: string[];
	baseUrl?: string;
	/** Wire protocol the chat/completion call uses. Defaults to "openai" (the
	 * `/chat/completions` SSE shape). MiniMax's base URL is Anthropic's
	 * `/messages` API, so it (like Anthropic itself) needs "anthropic". */
	wireProtocol?: "anthropic" | "openai";
}

export const PROVIDER_DEFINITIONS: ProviderDefinition[] = [
	{
		id: "anthropic",
		label: "Claude API",
		defaultModel: "claude-haiku-4-5",
		authKind: "api-key",
		supportsReasoningEffort: true,
		wireProtocol: "anthropic",
		envKeys: ["ANTHROPIC_LLM_API_KEY", "ANTHROPIC_API_KEY"],
		setupHint: "Use ANTHROPIC_API_KEY or paste a Claude API key.",
	},
	{
		id: "openai",
		label: "OpenAI API",
		defaultModel: "gpt-4o",
		authKind: "api-key",
		supportsReasoningEffort: true,
		baseUrl: "https://api.openai.com/v1",
		envKeys: ["OPENAI_LLM_API_KEY", "OPENAI_API_KEY"],
		setupHint: "Use OPENAI_API_KEY or paste an OpenAI API key.",
	},
	{
		id: "google",
		label: "Gemini API",
		defaultModel: "gemini-3-flash-preview",
		// Gemini is wired through the OpenAI-compatible base so it shares the
		// same code path as OpenAI/OpenRouter. (`.../v1beta` is Google's
		// native Gemini endpoint and uses a different wire format.)
		baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
		authKind: "api-key",
		supportsReasoningEffort: true,
		envKeys: [
			"GOOGLE_GENERATIVE_AI_API_KEY",
			"GEMINI_API_KEY",
			"GOOGLE_API_KEY",
			"GEMINI_LLM_API_KEY",
			"GOOGLE_LLM_API_KEY",
		],
		setupHint: "Use GOOGLE_GENERATIVE_AI_API_KEY, GEMINI_API_KEY, or paste a Gemini API key.",
	},
	{
		id: "mistral",
		label: "Mistral API",
		defaultModel: "mistral-large-latest",
		authKind: "api-key",
		supportsReasoningEffort: false,
		baseUrl: "https://api.mistral.ai/v1",
		envKeys: ["MISTRAL_LLM_API_KEY", "MISTRAL_API_KEY"],
		setupHint: "Use MISTRAL_API_KEY or paste a Mistral API key.",
	},
	{
		id: "openrouter",
		label: "OpenRouter API",
		defaultModel: "anthropic/claude-3.5-sonnet",
		authKind: "api-key",
		supportsReasoningEffort: true,
		baseUrl: "https://openrouter.ai/api/v1",
		envKeys: ["OPENROUTER_LLM_API_KEY", "OPENROUTER_API_KEY"],
		setupHint: "Use OPENROUTER_API_KEY or paste an OpenRouter API key.",
	},
	{
		id: "openai-oauth",
		label: "ChatGPT (OAuth)",
		defaultModel: "gpt-5.4",
		authKind: "oauth-device",
		supportsReasoningEffort: true,
		envKeys: [],
		baseUrl: "https://chatgpt.com/backend-api",
		setupHint: "Connect a ChatGPT account with the device login flow.",
	},
	{
		id: "copilot-proxy",
		label: "GitHub Copilot",
		defaultModel: "gpt-4.1",
		authKind: "pat",
		supportsReasoningEffort: true,
		envKeys: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
		baseUrl: "https://api.individual.githubcopilot.com",
		setupHint: "Use a GitHub Copilot token or connect with the device login flow.",
	},
	{
		id: "minimax",
		label: "MiniMax API",
		defaultModel: "MiniMax-M3",
		authKind: "api-key",
		supportsReasoningEffort: true,
		wireProtocol: "anthropic",
		baseUrl: "https://api.minimax.io/anthropic",
		envKeys: ["MINIMAX_API_KEY"],
		setupHint: "Use MINIMAX_API_KEY or paste a MiniMax API key.",
	},
	{
		id: "minimax-token-plan",
		label: "MiniMax Token Plan",
		defaultModel: "MiniMax-M3",
		authKind: "api-key",
		supportsReasoningEffort: true,
		wireProtocol: "anthropic",
		baseUrl: "https://api.minimax.io/anthropic",
		envKeys: ["MINIMAX_TOKEN_PLAN_API_KEY"],
		setupHint: "Use MINIMAX_TOKEN_PLAN_API_KEY or paste a MiniMax token-plan API key.",
	},
	{
		id: "openai-compatible",
		label: "OpenAI Compatible",
		defaultModel: "",
		authKind: "api-key",
		requiresBaseUrl: true,
		supportsReasoningEffort: false,
		envKeys: ["OPENAI_COMPATIBLE_API_KEY"],
		setupHint: "Use a custom OpenAI-compatible base URL.",
	},
];

export const REASONING_EFFORT_OPTIONS = [
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORT_OPTIONS)[number];

/**
 * Coerce free-form provider strings (including historical aliases and the
 * legacy `yagr` ids) to a known registry entry. Mirrors axcut's
 * `normalizeProviderId`.
 */
export function normalizeProviderId(provider?: string): string | undefined {
	const normalized = provider?.trim().toLowerCase();
	if (!normalized) return undefined;
	if (normalized === "claude") return "anthropic";
	if (normalized === "anthropic-proxy") return "anthropic";
	if (normalized === "gemini") return "google";
	const def = PROVIDER_DEFINITIONS.find((p) => p.id === normalized);
	return def?.id;
}

export function getProviderDefinition(id: string): ProviderDefinition | undefined {
	return PROVIDER_DEFINITIONS.find((p) => p.id === id);
}

/**
 * ponytail: minimal-effort aliases collapse to `low` for strategies that
 * don't expose `minimal`; `xhigh` collapses to `high`. Mirrors axcut's
 * `normalizeReasoningEffortForCapability`. Use after picking a strategy.
 */
const OPENAI_REASONING_EFFORTS: readonly ReasoningEffort[] = ["none", "low", "medium", "high"];
const ANTHROPIC_REASONING_EFFORTS: readonly ReasoningEffort[] = [
	"none",
	"low",
	"medium",
	"high",
	"xhigh",
];
const OPENROUTER_REASONING_EFFORTS: readonly ReasoningEffort[] = ["none", "low", "medium", "high"];
const GOOGLE_REASONING_EFFORTS: readonly ReasoningEffort[] = ["none", "low", "medium", "high"];

export function normalizeReasoningEffort(
	effort: ReasoningEffort | undefined,
	strategy:
		| "openai-responses"
		| "anthropic-thinking"
		| "openrouter-reasoning"
		| "google-thinking"
		| "custom-openai-account"
		| "none",
): ReasoningEffort | undefined {
	if (strategy === "none") return undefined;
	if (!effort) return "medium";
	if (effort === "minimal") {
		return [
			"openai-responses",
			"anthropic-thinking",
			"openrouter-reasoning",
			"google-thinking",
		].includes(strategy)
			? "low"
			: "medium";
	}
	if (effort === "xhigh") {
		return strategy === "anthropic-thinking" ? "xhigh" : "high";
	}
	const supported =
		strategy === "openai-responses"
			? OPENAI_REASONING_EFFORTS
			: strategy === "anthropic-thinking"
				? ANTHROPIC_REASONING_EFFORTS
				: strategy === "openrouter-reasoning"
					? OPENROUTER_REASONING_EFFORTS
					: GOOGLE_REASONING_EFFORTS;
	return supported.includes(effort) ? effort : "medium";
}
