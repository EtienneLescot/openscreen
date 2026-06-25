// Provider definitions for the AI features layer. Static data — no runtime
// deps. Mirrors axcut's apps/server/src/llm/provider-registry.ts.
//
// ponytail: the full provider set (10 providers in axcut). Each entry carries
// enough metadata for the ProviderSettingsDialog to render without hitting the
// network. Actual model creation (create-chat-model) needs @langchain/* deps.

export interface ProviderDefinition {
	id: string;
	label: string;
	defaultModel: string;
	authKind: "api-key" | "oauth-device" | "pat";
	supportsReasoningEffort: boolean;
	envKeys: string[];
	baseUrl?: string;
}

export const PROVIDER_DEFINITIONS: ProviderDefinition[] = [
	{
		id: "anthropic",
		label: "Claude API",
		defaultModel: "claude-haiku-4-5",
		authKind: "api-key",
		supportsReasoningEffort: true,
		envKeys: ["ANTHROPIC_API_KEY"],
	},
	{
		id: "openai",
		label: "OpenAI API",
		defaultModel: "gpt-4o",
		authKind: "api-key",
		supportsReasoningEffort: true,
		envKeys: ["OPENAI_API_KEY"],
	},
	{
		id: "google",
		label: "Gemini API",
		defaultModel: "gemini-2.5-flash",
		authKind: "api-key",
		supportsReasoningEffort: true,
		envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
	},
	{
		id: "mistral",
		label: "Mistral API",
		defaultModel: "mistral-large-latest",
		authKind: "api-key",
		supportsReasoningEffort: false,
		envKeys: ["MISTRAL_API_KEY"],
	},
	{
		id: "openrouter",
		label: "OpenRouter",
		defaultModel: "anthropic/claude-3.5-sonnet",
		authKind: "api-key",
		supportsReasoningEffort: true,
		envKeys: ["OPENROUTER_API_KEY"],
		baseUrl: "https://openrouter.ai/api/v1",
	},
	{
		id: "openai-compatible",
		label: "OpenAI-compatible endpoint",
		defaultModel: "",
		authKind: "api-key",
		supportsReasoningEffort: false,
		envKeys: ["OPENAI_COMPATIBLE_API_KEY"],
	},
	{
		id: "openai-oauth",
		label: "ChatGPT (OAuth)",
		defaultModel: "gpt-4o",
		authKind: "oauth-device",
		supportsReasoningEffort: true,
		envKeys: [],
	},
	{
		id: "copilot-proxy",
		label: "GitHub Copilot",
		defaultModel: "gpt-4o",
		authKind: "pat",
		supportsReasoningEffort: true,
		envKeys: ["GITHUB_TOKEN", "GH_TOKEN"],
	},
];

export const REASONING_EFFORT_OPTIONS = ["none", "minimal", "low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORT_OPTIONS)[number];
