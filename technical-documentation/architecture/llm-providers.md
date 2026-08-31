# LLM providers

The provider layer defines model metadata, protects credentials, discovers models, and builds the chat model every AI feature runs on. It lives in:

| File | Role |
|---|---|
| [`electron/ai-edition/provider-registry.ts`](../../electron/ai-edition/provider-registry.ts) | Static `ProviderDefinition[]`, id normalization, reasoning-effort option lists and labels. No runtime deps. |
| [`electron/ai-edition/llm-config-store.ts`](../../electron/ai-edition/llm-config-store.ts) | `LlmConfigStore` — plain JSON for selection, `safeStorage` blob for credentials. |
| [`electron/ai-edition/llm-provider-auth.ts`](../../electron/ai-edition/llm-provider-auth.ts) | Model-list discovery per provider. Despite the filename it performs no authentication any more — see [Known gaps](#known-gaps). |
| [`electron/ai-edition/deep-agent/chat-model.ts`](../../electron/ai-edition/deep-agent/chat-model.ts) | `createOpenScreenChatModel` — the single transport. Picks a `@langchain/*` chat model class per provider. |
| [`electron/ai-edition/deep-agent/chat-model.ts`](../../electron/ai-edition/deep-agent/chat-model.ts) | Per-provider reasoning-effort capability and its LangChain wire options. |
| [`electron/native-bridge/services/aiEditionService.ts`](../../electron/native-bridge/services/aiEditionService.ts) | IPC surface: connect / disconnect, snapshot, `llmListProviderModels`. |
| [`src/components/ai-edition/ProviderSettings.tsx`](../../src/components/ai-edition/ProviderSettings.tsx) | Renders cards and forms directly from `PROVIDER_DEFINITIONS`. `ProviderSettingsDialog`, in the same file, is its one mount — `App.tsx`, beside `ShortcutsConfigDialog`. |
| [`src/contexts/EditorDialogsContext.tsx`](../../src/contexts/EditorDialogsContext.tsx) | Which editor dialog is open (`section`), so every entry point opens the same one. |

> **Two doors, one dialog.** The settings dialog is opened from the AI panel — its gear, the
> welcome card's CTA, the model pill with nothing configured, the quick-pick popover's "full
> settings" row, and a send attempt with no provider — and from the app menu under the
> wordmark. Its open state lives in a context rather than in `ChatStripPanel` because that panel
> mounts only in Edit mode with the chat panel expanded, which would have left the menu item
> dead in Media and Rec (issue #420).

> **There is one transport.** `llm-call.ts` (`streamLlm` / `callLlm`) and
> `codex-session.ts` were deleted in 1.8.0 along with the two account-backed
> providers that needed them. Everything now goes through
> `createOpenScreenChatModel`; neither symbol has any remaining reference in
> the repo. The duplicated fetch-vs-LangChain routing that earlier revisions
> of this document called out as a gap no longer exists.

## The registry

Each `ProviderDefinition` carries a stable id and label, default model, `authKind`, env-var fallbacks, reasoning-effort support, and optional base URL, setup hint, `requiresBaseUrl` marker, and `wireProtocol`.

| ID | Display name | Default model | Wire shape |
|---|---|---|---|
| `anthropic` | Claude API | `claude-haiku-4-5` | Anthropic Messages (`ChatAnthropic`) |
| `openai` | OpenAI API | `gpt-4o` | OpenAI-compatible (`ChatOpenAI`) |
| `google` | Gemini API | `gemini-3-flash-preview` | Google's OpenAI-compatible endpoint (`/v1beta/openai`) |
| `mistral` | Mistral API | `mistral-large-latest` | First-party Mistral (`ChatMistralAI`) |
| `openrouter` | OpenRouter API | `anthropic/claude-3.5-sonnet` | OpenAI-compatible |
| `minimax` | MiniMax API | `MiniMax-M3` | Anthropic-shaped, via `ChatAnthropic` at `https://api.minimax.io/anthropic` |
| `minimax-token-plan` | MiniMax Token Plan | `MiniMax-M3` | Same as `minimax`, different env key |
| `openai-compatible` | OpenAI Compatible | *(user-supplied)* | OpenAI-compatible at a required custom base URL |

`normalizeProviderId` coerces historical aliases before lookup: `claude` and `anthropic-proxy` → `anthropic`, `gemini` → `google`. `createOpenScreenChatModel` normalizes once on entry, so every provider comparison downstream is an exact match against a registry id.

MiniMax's `baseUrl` deliberately omits `/v1`: `ChatAnthropic` wraps `@anthropic-ai/sdk`, which appends `/v1/messages` itself.

### Removed in 1.8.0

`openai-oauth` (ChatGPT) and `copilot-proxy` (GitHub Copilot) were deleted. Both reached a user's subscription by presenting GitHub's and OpenAI's own client IDs and an editor `User-Agent` against endpoints reserved for first-party clients (`api.github.com/copilot_internal`, `chatgpt.com/backend-api`) — from inside a signed installer. Both vendors expose a sanctioned surface instead: GitHub's Copilot SDK (register our own OAuth App, pass the user's `gho_` token) and `codex app-server` (drives the user's own `codex login`, ships no client ID at all). Those are separate integrations rather than a header swap, so they return in their own PR.

The removal note lives at [`provider-registry.ts:92`](../../electron/ai-edition/provider-registry.ts). `authKind` is narrowed to the literal `"api-key"` so the type widens again only when one of those lands.

## Auth

One mode. The user pastes a key in `ProviderSettings`, or the main process resolves the first populated env var listed by the definition — `getCredential` checks `envKeys` **before** the stored blob, so an env var always wins.

A custom OpenAI-compatible endpoint may omit authentication entirely; `resolveOpenAIChatApiKey` substitutes the `OPENAI_COMPATIBLE_NO_AUTH_API_KEY` placeholder so the SDK has something to send.

## Credential storage

`LlmConfigStore` writes non-secret selection data — provider, model, base URL, reasoning effort, and the `allowAgentEdits` toggle — to `llm-config.json`. Credentials never land in that file.

Keys are serialized together, encrypted with Electron `safeStorage`, and written to `llm-credentials.enc`. Electron delegates the encryption to the OS credential store. `saveCredentials` **throws rather than falling back to plaintext** when `safeStorage.isEncryptionAvailable()` is false.

Two compatibility behaviours in the loader are load-bearing:

- A legacy string-only row (`{[providerId]: "sk-…"}`, written before entries were typed) is coerced to `{kind: "api-key", apiKey}`.
- `getCredential` matches on **a usable `apiKey` field, not on `kind`**. A blob written by a pre-1.8.0 build still carries `kind: "codex"` / `"github-device"` / `"github-pat"` rows; narrowing on the current one-member union would make those unreadable and crash the read. They resolve to nothing instead, because no provider claims those ids — so no migration is needed.

Renderer snapshots expose connection summaries, never raw credential values.

## Calling a model

`createOpenScreenChatModel({provider, model, apiKey, baseUrl, reasoningEffort})` normalizes the provider id, builds the reasoning options, and returns a `BaseChatModel`:

- `minimax` / `minimax-token-plan` → `ChatAnthropic` with `anthropicApiUrl` pointed at the MiniMax base and an explicit `maxTokens` (`ANTHROPIC_API_MAX_OUTPUT_TOKENS`, 16384). ChatAnthropic's default-output table only knows Claude slugs (16k) and falls back to 4096 for anything else — with adaptive thinking on, a cold-start MiniMax turn could spend that entire budget on reasoning and truncate before any text block (the "first call returns empty" bug, #181).
- `anthropic` → `ChatAnthropic`, plus `thinking` / `outputConfig` when reasoning is on. Known `claude-*` slugs keep LangChain's per-model `maxTokens` default (overriding it would exceed legacy limits like claude-3-haiku's 4096); non-Claude model names — a self-hosted Anthropic-compatible endpoint behind `baseUrl` — get the same 16384 floor as MiniMax.
- `mistral` → `ChatMistralAI`.
- everything else (`openai`, `google`, `openrouter`, `openai-compatible`) → `ChatOpenAI`, with the base URL defaulted per provider and `disableStreaming` set for Gemini 3, whose OpenAI-compat path cannot stream and tool-call at the same time.

The `maxTokens` floor is Anthropic-wire-only by design: the OpenAI-shaped transports send no `max_tokens` by default (the provider's own limit applies), so there is no 4096 fallback to fix — and adding a cap would truncate outputs that are uncapped today.

An unrecognised provider reaching `createLocalProviderChatModel` throws rather than silently defaulting to OpenAI.

Three call sites share that factory:

| Caller | What it does |
|---|---|
| [`deep-agent/service.ts`](../../electron/ai-edition/deep-agent/service.ts) `invokeOpenScreenAgent` | The chat agent. Builds a fresh `createDeepAgent` per turn with the timeline tools bound; each turn is single-shot (no checkpointer yet). |
| [`chat-service.ts`](../../electron/ai-edition/chat-service.ts) `tryCompactSession` | One-shot summary of older turns for context compaction. A failure here is swallowed — it must not break the chat turn. |
| [`caption-translate.ts`](../../electron/ai-edition/caption-translate.ts) | One-shot caption translation. Deliberately not the agent loop: a pure text transform has no reason to hold document-mutating tools. |

`messageContentToText` flattens LangChain `MessageContent` for the two one-shot callers without dragging in the agent tool graph.

## Reasoning effort

`getReasoningCapability(provider, model)` decides whether the *model* supports reasoning at all, and by which strategy — `openai-responses`, `anthropic-thinking`, `minimax-thinking`, `openrouter-reasoning`, or `google-thinking`. The check is model-shaped, not just provider-shaped: `openai` only reports support for `o*`/`gpt-5*`, `anthropic` for `claude-{opus,sonnet,haiku}-4*`, `google` for `gemini-2.5*`/`gemini-3*`.

`buildLangChainReasoningOptions` then maps the effort onto that provider's wire field: `reasoning.effort` + `useResponsesApi` for OpenAI, `thinking` blocks (adaptive with `outputConfig.effort` on Claude 4.6/4.7, otherwise `budget_tokens`) for Anthropic, `modelKwargs.reasoning` for OpenRouter, `thinkingConfig` for Google.

MiniMax's `thinking` block is binary (`{type: "adaptive"}` or absent), so `getReasoningEffortOptions` shows it only `none` / `medium` and `getReasoningEffortLabel` renders that `medium` as **On** — advertising six tiers would imply a granularity it doesn't have. Both helpers are the SSOT shared by `ProviderSettings.tsx` and the in-chat quick-pick in `LeftPanel.tsx`.

## Model discovery

`aiEditionService.llmListProviderModels(providerId)` resolves the credential, then dispatches per provider:

| Provider | Source |
|---|---|
| `anthropic` | `GET /v1/models` with `x-api-key` |
| `google` | `GET /v1beta/openai/models`, filtered to `gemini-*` |
| `mistral` | `GET /v1/models` |
| `openrouter` | `GET /api/v1/models` (unauthenticated) |
| `openai`, `openai-compatible` | `GET {baseUrl}/models` — errors with "Missing base URL" if unset |
| `minimax`, `minimax-token-plan` | No list endpoint exists: probes nine known slugs with a `max_tokens: 1` completion and keeps the ones that answer |

Everything returns `{models, error?}` rather than throwing, so the settings UI can show a reason instead of an empty list. When every MiniMax probe fails, the first failure's status is surfaced in the message.

## Adding a provider

1. Add a complete `ProviderDefinition` in `provider-registry.ts` (auth kind, env keys, default model, base URL, `wireProtocol`, reasoning support). Widen `authKind` if the provider is not API-key-based.
2. Add a branch in `createOpenScreenChatModel` if none of the three existing adapters fits.
3. Add a capability branch in `chat-model.ts` if the provider exposes reasoning, and constrain `getReasoningEffortOptions` if its scale is not the full six tiers.
4. Add a discovery branch in `aiEditionService.llmListProviderModels`, plus its fetch helper in `llm-provider-auth.ts`.
5. Extend the native-bridge contracts if the provider needs operations the existing IPC surface doesn't cover.
6. Confirm `ProviderSettings.tsx` renders the right fields from the registry metadata alone, then add registry, transport, and UI tests.

## Known gaps

- **`normalizeReasoningEffort` in `provider-registry.ts` is dead.** It is exported but has no caller anywhere in the repo; `normalizeReasoningEffortForCapability` in `chat-model.ts` is the live one. The two also disagree — the dead copy's strategy union knows `custom-openai-account` but not `minimax-thinking`. Delete it rather than fixing it.
- **`custom-openai-account` is a phantom strategy.** It appears in `ReasoningCapability["strategy"]` but no branch of `getReasoningCapability` returns it, and no branch of `buildLangChainReasoningOptions` handles it. Left over from the removed ChatGPT provider.
- **`llm-provider-auth.ts` is misnamed.** It performs no authentication since the device flows were removed — it is purely model-list discovery. `model-discovery.ts` would say what it does.
- **MiniMax discovery spends the user's key.** Nine probe requests per discovery click, uncached, at `max_tokens: 1`. Cache per key if it ever moves to a hot path.
- **No reasoning-effort validation at the IPC boundary.** `LlmConfig.reasoningEffort` is a bare `string` in `llm-config-store.ts` and is cast with `as never` into `buildLangChainReasoningOptions`; an unrecognised value falls through to the capability default rather than being rejected.
- **The agent is stateless per turn.** `invokeOpenScreenAgent` builds a fresh `createDeepAgent` for every message; conversation continuity comes from replaying `history`. Passing a `checkpointer` would make langgraph threads stateful — noted in the code as a later step.
