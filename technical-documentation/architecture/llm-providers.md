# LLM providers

The provider layer lives in `electron/ai-edition/provider-registry.ts`, `llm-config-store.ts`, `llm-provider-auth.ts`, `llm-call.ts`, and `codex-session.ts`, with settings in `src/components/ai-edition/ProviderSettings.tsx`. It defines model metadata, protects credentials, authenticates account-backed providers, discovers models, and translates chat and tool calls to provider wire formats.

## The registry

Each `ProviderDefinition` contains a stable ID and label, default model, authentication kind, environment-variable fallbacks, reasoning-effort support, and optional base URL, setup hint, required-base-URL marker, and wire protocol. `ProviderSettings` renders its cards and forms directly from `PROVIDER_DEFINITIONS`.

The registered definitions are:

| ID | Display name | Default model | Wire shape |
|---|---|---|---|
| `anthropic` | Claude API | `claude-haiku-4-5` | Anthropic Messages |
| `openai` | OpenAI API | `gpt-4o` | OpenAI-compatible |
| `google` | Gemini API | `gemini-3-flash-preview` | Google's OpenAI-compatible endpoint |
| `mistral` | Mistral API | `mistral-large-latest` | OpenAI-compatible in `llm-call.ts`; first-party Mistral in the deep-agent model factory |
| `openrouter` | OpenRouter API | `anthropic/claude-3.5-sonnet` | OpenAI-compatible |
| `openai-oauth` | ChatGPT (OAuth) | `gpt-5.4` | Codex/ChatGPT account path |
| `copilot-proxy` | GitHub Copilot | `gpt-4.1` | OpenAI-compatible after Copilot token exchange |
| `minimax` | MiniMax API | `MiniMax-M3` | Anthropic-compatible |
| `minimax-token-plan` | MiniMax Token Plan | `MiniMax-M3` | Anthropic-compatible |
| `openai-compatible` | OpenAI Compatible | User-supplied | OpenAI-compatible at a required custom base URL |

Historical aliases normalize before lookup: `claude` and `anthropic-proxy` map to `anthropic`, while `gemini` maps to `google`.

## Auth modes

| Mode | How it works | Providers |
|---|---|---|
| API key | The user pastes a key, or the main process resolves the first populated environment variable listed by the definition. A custom OpenAI-compatible endpoint may omit authentication; the deep-agent adapter supplies an internal placeholder key. | `anthropic`, `openai`, `google`, `mistral`, `openrouter`, `minimax`, `minimax-token-plan`, `openai-compatible` |
| OAuth device flow | The main process requests a ChatGPT device challenge, polls for authorization, exchanges the authorization code, extracts the account ID, and stores access and refresh tokens. The UI displays only the code and verification URL. | `openai-oauth` |
| PAT | The user can paste a GitHub token, which is exchanged for a short-lived Copilot runtime bearer at call time. The same provider also implements GitHub's device flow and stores its resulting token as a `github-device` credential. | `copilot-proxy` |

The three modes are wired through the renderer and native bridge. There is no registry auth mode that is merely a UI stub. However, the deep-agent model factory's local-provider comments lag the fetch path: it sends the stored ChatGPT token to a generic `ChatOpenAI` backend and sends the stored GitHub token directly to the Copilot base URL, rather than using `llm-call.ts`'s bespoke Codex transport and Copilot runtime-token exchange.

## Credential storage

`LlmConfigStore` writes non-secret selection data—provider, model, base URL, reasoning effort, and the edit toggle—to `llm-config.json`. Credentials never land in that plain JSON file.

API keys, ChatGPT tokens and refresh tokens, account IDs, expiries, GitHub device tokens, and GitHub PATs are serialized together, encrypted with Electron `safeStorage`, and written to `llm-credentials.enc`. Electron delegates encryption to the operating system's credential protection. Writes fail rather than falling back to plaintext when encryption is unavailable. The loader still accepts legacy string-only encrypted entries and normalizes them to typed API-key credentials.

The main process may use provider-specific environment variables instead of the encrypted entry. Renderer snapshots expose connection and credential-kind summaries, not raw credential values.

## Calling a model

`streamLlm` resolves a registry entry, checks its credential requirements, and dispatches to a fetch-based transport:

- OpenAI-compatible providers send streaming `POST {baseUrl}/chat/completions` requests. Messages, fixed function schemas, tool-call deltas, and provider-specific reasoning fields are translated to the OpenAI shape.
- Anthropic-shaped providers send streaming `POST {baseUrl}/v1/messages` requests with `x-api-key`, Anthropic content blocks, `input_schema` tools, and provider-appropriate thinking fields.
- ChatGPT OAuth sends the Codex Responses dialect to `/codex/responses`, including account/session identity headers, transformed tools, reasoning options, and an SSE parser for text and function calls.
- GitHub Copilot first exchanges the stored GitHub token at GitHub's Copilot token endpoint, derives the account-specific API base URL, then uses the OpenAI-compatible streaming path with the short-lived bearer.

`callLlm` is the buffered convenience wrapper around `streamLlm`; it collects text and complete tool calls. The active chat editor currently invokes the LangChain-backed deep-agent model factory, which selects `ChatAnthropic`, `ChatMistralAI`, or `ChatOpenAI` adapters and maps reasoning options separately.

## Adding a provider

1. Add a complete `ProviderDefinition` in `electron/ai-edition/provider-registry.ts`, including auth kind, environment keys, default model, base URL, protocol, and reasoning support.
2. Add or extend credential and authentication helpers in `llm-config-store.ts` and `llm-provider-auth.ts` when the existing credential kinds do not fit.
3. Route the provider in `llm-call.ts`, including request/response transformations, streaming parser behavior, model discovery, and reasoning fields.
4. Add the corresponding deep-agent adapter and capability mapping under `electron/ai-edition/deep-agent/` so chat and direct fetch paths agree.
5. Extend the native bridge model-list or auth handlers and their contracts when the provider requires new operations.
6. Verify `ProviderSettings.tsx` renders the right fields and connection action from registry metadata, then add registry, auth, transport, and UI tests.

## Known gaps

- The fetch transport and the LangChain deep-agent transport duplicate provider routing and reasoning logic, and the ChatGPT/Copilot deep-agent paths do not yet use the more complete token/session handling implemented by `llm-call.ts`.
- Copilot runtime bearers are exchanged on demand and are not cached despite carrying an expiry.
- Token refresh exists for Codex sessions, but the active chat service does not refresh an expired stored ChatGPT credential before creating its deep-agent model.
