# Provider feature parity plan (axcut → OpenScreen)

Goal: ship OpenScreen's AI provider feature at axcut parity, plus GitHub
Device Flow + Codex Device Flow + PAT for the existing providers, then
loop CUA e2e to verify.

Scope is fixed to the 6 deliverables below; everything outside is out.

## What exists today
- `electron/ai-edition/provider-registry.ts` — 8 provider definitions
  (anthropic, openai, google, mistral, openrouter, openai-compatible,
   openai-oauth, copilot-proxy).
- `electron/ai-edition/llm-config-store.ts` — `LlmConfigStore` with
  `safeStorage` for secrets and a JSON `LlmConfig` on disk.
- `electron/native-bridge/services/aiEditionService.ts` — IPC handlers
  `llmGetSnapshot`, `llmSetConfig`, `llmSetApiKey`, `llmRemoveApiKey`.
- `src/components/ai-edition/ProviderSettings.tsx` — modal with list/form
  modes. Works for `api-key` auth; `oauth-device` and `pat` show
  "connect flow not implemented yet".
- `electron/ai-edition/chat-service.ts` — chat routing already exists but
  the "Configure AI Model" CTA still shows because nothing wires the
  selected `LlmConfig` into `runChat`'s modelId/baseUrl/apiKey resolution.

## Plan

### D1. Provider auth flows in main process (Electron)
New file `electron/ai-edition/llm-provider-auth.ts`:
- `beginCodexDeviceAuth(): Promise<CodexDeviceChallenge>` — copy of axcut
  `apps/server/src/llm/provider-runtime/openai-account.ts::beginCodexDeviceAuth`
  (`https://auth.openai.com/api/accounts/deviceauth/usercode`,
  client_id `app_EMoamEEZ73f0CkXaXp7hrann`).
- `completeCodexDeviceAuth({ deviceAuthId, userCode, intervalMs, expiresAt })`
  polling `https://auth.openai.com/api/accounts/deviceauth/token` then
  `oauth/token`. Persist to `app.getPath("userData")/openai-codex-auth.json`
  (mirrors axcut's `accountAuthRoot`).
- `beginGithubDeviceAuth(): Promise<GithubDeviceChallenge>` and
  `completeGithubDeviceAuth(...)` — polling
  `https://github.com/login/device/code` +
  `https://github.com/login/oauth/access_token` with client
  `Iv1.b507a08c87ecfe98`, scope `read:user`. Persist to
  `userData/copilot-auth.json`.
- `validateGithubCopilotToken(token: string): Promise<boolean>` —
  exchange for a Copilot API token via
  `https://api.github.com/copilot_internal/v2/token`. Returns the
  token + `expiresAt` (axcut `copilot-account.ts::resolveCopilotApiToken`).
  Caller is responsible for caching; in this codebase the cache lives
  inside the existing `safeStorage` blob (see D1a below) instead of a
  plain-json file like axcut.

D1a. OAuth tokens go through `safeStorage` (not plain JSON on disk).
We keep the single `userData/llm-credentials.enc` blob used by
`LlmConfigStore`, but expand the JSON shape from
`{ [providerId]: string }` to
`{ [providerId]: { kind: "api-key" | "codex" | "github-device" | "github-pat", apiKey, refreshToken?, expiresAt?, accountId?, email? } }`.
Existing rows (plain-string keys) keep working — the loader coerces
them to `{ kind: "api-key", apiKey }`. The store also gets:
- `getCredential(providerId)` — returns the typed entry.
- `setCredential(providerId, entry)` — persists the entry.
- `clearCredential(providerId)` — drop that provider's creds.

### D2. IPC bridge surface
Add to `AiEditionLlmSnapshot` (contracts):
- `oauthTokens: Record<providerId, "codex" | "github-device" | "github-pat">`
  so the renderer can show "Connected via OAuth" vs "via API key" without
  leaking the token.

Add to `aiEditionService.ts`:
- `llmBeginDeviceAuth(providerId: 'openai-oauth' | 'copilot-proxy')`
- `llmCompleteDeviceAuth(providerId, challenge: DeviceChallenge)`
- `llmCheckDeviceAuth(providerId)` — polling probe used by UI
- (unchanged) `llmSetApiKey` is now used for the GitHub PAT kind only.

Add new device-flow shapes to `contracts.ts`:
```ts
interface DeviceChallenge {
  verificationUri: string;
  verificationUriComplete?: string;
  userCode: string;
  deviceCode?: string;       // github only
  deviceAuthId?: string;      // codex only
  intervalMs: number;
  expiresAt: number;
}
```

### D3. ProviderSettings.tsx rewrite (axcut parity)
- Three screens stacked in the modal, navigated by URL-less state:
  1. **list** — read axcut `provider-grid`: 2-col cards, each shows
     label, default model pill, `CONNECTED` / `OAUTH` / `TOKEN` / `API KEY`
     badge. Active provider gets `accent` ring.
  2. **connect-form** — single form per provider: model (free text + small
     "Use provider default" hint), baseUrl (only providers with
     `baseUrl` set or `id === "openai-compatible"`), reasoning effort
     (only when `supportsReasoningEffort`).
  3. **device-challenge** — when the user clicks **Connect** for an
     oauth/pat provider, show: provider label, copyable `<code>` block
     with the user code, "Copy code" button (icon swap to Check for 1.4 s),
     "Open login page" external link, and a "Completing sign-in…"
     affordance that runs `llmCompleteDeviceAuth` then refreshes the
     snapshot.
- All buttons get aria-labels (axcut uses `<IconButton icon label />`
  everywhere).
- Save flow: `Save & use` writes config + key, closes the form, refreshes
  the snapshot; on failure shows the error inline (no toast).
- Disconnect flow: wipes `safeStorage` entry for the provider, clears
  any cached `config.provider`, refreshes snapshot.

### D4. Wire chat routing
`chat-service.ts` already accepts `modelId`, `baseUrl`, `apiKey`
individually. Add a small resolver at the top of `runChat` that reads
`LlmConfigStore` for the configured provider and surfaces a clear
error if no provider is configured (instead of the bland "Configure AI
Model" CTA). The "applied: …" line is already produced by
`agent-tools.ts`'s wrapped tool invocation — verify it renders in the
chat history once a real provider answers.

### D5. CUA e2e loop
For each iteration:
1. Rebuild + restart the desktop app (or trigger Vite HMR).
2. `get_app_state` for `electron`, then run a sequence:
   - Open chat strip → click `AI settings`.
   - Pick `OpenAI API`, paste a dummy key → save → expect "configured"
     toast + provider shows CONNECTED.
   - Pick `ChatGPT (OAuth)`, click Connect → assert the challenge card
     opens with a `userCode` and "Open login page" link (no actual login).
   - Pick `GitHub Copilot`, click Connect → same assertion for the
     GitHub device challenge.
3. Send the message `trim a silence from 1 to 2 seconds` in chat, wait
   for a response, check for the `applied: …` tool-call line.
4. Re-run the relevant specs from the previous hunt (`p1.7`, `p3.3`,
   etc.) to confirm parity or surface regressions.

We loop until either the 7 pre-existing specs report PASS / CANNOT-TEST
(no new FAILs introduced) and the device-flow UI is reachable end-to-end.

## Files I'll touch (and only these)
- `electron/ai-edition/provider-registry.ts` — small additions to
  descriptions; `baseUrl` for `openai-oauth` & `copilot-proxy`.
- `electron/ai-edition/llm-config-store.ts` — `oauth` helpers.
- `electron/ai-edition/llm-provider-auth.ts` — **new**, device flow +
  GitHub PAT exchange.
- `electron/native-bridge/services/aiEditionService.ts` — new handlers.
- `electron/preload.ts` — expose the new handlers on the bridge.
- `src/native/contracts.ts` — new `DeviceChallenge` type + snapshot
  augmentation.
- `src/components/ai-edition/ProviderSettings.tsx` — full rewrite to
  axcut parity.
- `electron/ai-edition/chat-service.ts` — wire `LlmConfigStore` into
  `runChat`.

## Explicitly out of scope
- Codex/GitHub backing chat-model invocation (we only wire the
  credential side; LLM message generation still uses the existing
  Anthropic adapter or stubbed model).
- Server-side `provider-registry.ts` aliases (axcut uses 9 ids; we keep
  8 — no need to mint a `copilot-oauth` separate id, the same
  `copilot-proxy` covers both PAT and device-flow paths).
- Mobile / Linux packaging of this feature.
- Translation i18n keys (we only have English on this surface).

## Verification
- `npm run lint`, `npx tsc --noEmit`, `npm run test` before CUA loop.
- CUA loop ends when the 7 pre-existing specs report PASS /
  CANNOT-TEST and GitHub + Codex device flows open a challenge card in
  the rendered app, or when a clear blocking bug is found.

## Iteration log

### Dynamic model list for OAuth/PAT providers
The first CUA pass surfaced that the Model field was a plain text
input, so ChatGPT (OAuth) and GitHub Copilot (PAT) only ever showed
the hard-coded `gpt-4o` / `gpt-4o` default — no live fetch from the
account. Fixed in this commit:

- `electron/ai-edition/llm-provider-auth.ts`
  - `listOpenAiAccountModels(accessToken)` — `GET {OPENAI_ACCOUNT_BASE_URL}/codex/models`
    with `chatgpt-account-id` header derived from the JWT, filters to
    `visibility === "list"`, sorts by `priority`.
  - `listGithubCopilotModels(githubToken)` — exchanges the stored PAT for
    a short-lived Copilot bearer via `exchangeGithubCopilotRuntimeToken`,
    then `GET {runtime.baseUrl}/models` (baseUrl pulled from the JWT's
    `endpoints.api` claim, with `api.individual.githubcopilot.com` as the
    fallback), sorts alphabetically.
  - `GithubCopilotRuntimeToken` now also exposes `baseUrl` so the
    model list can use the per-account endpoint.
- `electron/native-bridge/services/aiEditionService.ts` — new
  `llmListProviderModels(providerId)` IPC handler. Reads the credential
  from `LlmConfigStore`, calls the right fetcher, returns
  `{ models: string[]; error?: string }`.
- `electron/ipc/nativeBridge.ts` + `src/native/contracts.ts` +
  `src/native/client.ts` — wire the new IPC action and the
  `AiEditionLlmProviderModelsResult` contract.
- `src/components/ai-edition/ProviderSettings.tsx`
  - `ProviderForm` gains a `listProviderModels` prop.
  - When `isConnected && supportsDynamicModels`, a `useEffect` kicks off
    the IPC call on mount. While pending, the Model field shows a
    small "Loading models…" hint.
  - If the result is non-empty, the Model field renders a `<select>` with
    one `<option>` per model, plus an extra "saved" entry if the current
    `config.model` is not in the list (so a stale saved value still
    round-trips).
  - If the result is empty or errors, it falls back to the existing free-text
    input and shows the error in the hint.
- Two new unit tests in `llm-provider-auth.test.ts` exercise the Codex
  filter/sort and the Copilot exchange-then-list flow.

### Verified end-to-end
- Codex device flow still produces a real OpenAI user code (`JR44-3PCM0`)
  and the "Open login page" link points at `https://auth.openai.com/codex/device`.
  Sending `trim a silence from 1 to 2 seconds` then puts the editor into
  `addSkip` placement mode ("Click to place · Esc to cancel") with the
  `openai-oauth / gpt-4o` provider pill underneath the input.
- Provider card with `CONNECTED` pill now appears for `openai-oauth` and
  `copilot-proxy` after the user completes the device flow manually.
- The modal opens via the chat panel's "Configure AI Model" button (CUA
  click was the reliable path; the editor's top-right Settings button
  still lands on the Shortcuts dialog when clicked via element_index).
