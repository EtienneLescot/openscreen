# 13 — Provider settings (LLM configuration)

**Surface:** `ProviderSettings` (`src/components/ai-edition/ProviderSettings.tsx`), `LeftPanel.tsx` (`AI settings` button), `provider-registry.ts`, `llm-config-store.ts`, `safeStorage` (Electron keychain).
**Prerequisites:** `02-editor-foundation.md`. Chat can be skipped (configure-only path).

**Goal of this block:** prove all 8 provider settings screens work — Models, Providers, Settings, Add Provider, Provider Form. Walk through API-key and OAuth-device-flow connections, model picking, reasoning effort.

**Reference:**
- `provider-registry.ts` — 8 providers: `anthropic`, `openai`, `google`, `mistral`, `openrouter`, `openai-oauth`, `copilot-proxy`, `minimax`, `openai-compatible`.
- `ProviderSettings.tsx:296` — `aria-label="Back"`.
- `ProviderSettings.tsx:306` — `aria-label="Close"`.
- roadmap P1 (Phase 7) — provider registry + LLM call.
- roadmap P2.2 — OAuth device-flow + PAT auth (still partially pending).
- Credentials stored in Electron `safeStorage` (keychain) — locked decision 4.

---

## Scenario 13.1 — Open Provider Settings via the gear icon

**Setup**
1. Open the chat panel (scenario 12.1).
2. Click the **AI settings** button (`aria-label="AI settings"`).

**Steps**
1. The `ProviderSettings` modal opens on the `Settings` screen.

**Expected**
- The modal is centered with a backdrop.
- The Settings screen lists connected providers.
- The `+ Add provider` button is visible.
- A back-arrow button (`aria-label="Back"`) is in the header (greyed on Settings root).

---

## Scenario 13.2 — Navigate to Models screen

**Setup**
1. From scenario 13.1 state.

**Steps**
1. Click `Models` (in the left nav or as a top-level option).

**Expected**
- The Models screen shows the active provider, current model, and a model list.
- A search input is at the top.
- The active model has an `Active` marker.

---

## Scenario 13.3 — Add provider (API-key flow)

**Setup**
1. From scenario 13.1 state.

**Steps**
1. Click `+ Add provider`.
2. The Add Provider screen lists available providers.
3. Pick `OpenAI`.
4. The Provider Form opens.
5. Enter an API key (e.g. `sk-test-...`).
6. Click `Connect`.

**Expected**
- The form shows: provider label, description, model select (disabled until connected), reasoning effort select (for OpenAI o1 family), API key input, base URL input (for OpenAI-compatible), buttons (`Disconnect`, `Connect`, `Use provider`).
- Clicking `Connect` saves the key to Electron `safeStorage`.
- The form's `Update key` button appears (replaces `Connect` after first connection).
- The model list reloads.
- The provider moves to the Connected list.

---

## Scenario 13.4 — Switch active provider

**Setup**
1. Two providers are connected (e.g. OpenAI + Anthropic).

**Steps**
1. In Models screen, click the other provider.
2. Pick a model.
3. Click `Use provider`.

**Expected**
- The active model changes.
- Subsequent chat messages use the new provider.
- The chat composer's model pill updates.

---

## Scenario 13.5 — Reasoning effort selector

**Setup**
1. Active provider is one that supports reasoning (e.g. OpenAI o1).

**Steps**
1. Open the Provider Form (Settings → Edit provider).
2. The Reasoning Effort selector lists: `none / minimal / low / medium / high / xhigh`.
3. Click `high`. Save.

**Expected**
- The reasoning effort is persisted per provider/model.
- The chat composer's reasoning pill updates.

---

## Scenario 13.6 — OAuth device flow (ChatGPT)

**Setup**
1. The app has a ChatGPT account capability.

**Steps**
1. Add Provider → `ChatGPT (OAuth)`.
2. Click `Start login`.
3. A device challenge appears:
   - User code (e.g. `ABCD-1234`).
   - Verification URL (`https://chatgpt.com/auth/device`).
   - `Open login page` external link button.
   - `Copy code` button (turns into check + "Copied" on click).
4. Copy the code.
5. Open the verification URL in the system browser.
6. Enter the code and authorize.
7. Return to the app.
8. Wait for the polling to detect completion.

**Expected**
- The app polls the OAuth endpoint until completion.
- Once complete, the provider is marked connected.
- Models load.
- The user can pick a model and use it.

---

## Scenario 13.7 — OAuth device flow (GitHub Copilot)

**Setup**
1. Add Provider → `GitHub Copilot`.

**Steps**
1. Same as scenario 13.6 but for GitHub PAT.
2. Enter a GitHub Personal Access Token with `copilot` scope.
3. The app exchanges the PAT for a Copilot token.
4. Models load.

**Expected**
- The provider is connected.
- Models are loaded from the Copilot API.

---

## Scenario 13.8 — Reconnect after expiry

**Setup**
1. A provider's saved credential has expired.

**Steps**
1. Open Models screen for that provider.
2. A `Reconnect` button is visible.
3. Click it.

**Expected**
- The form re-opens (with the existing config).
- The user can re-enter credentials.
- The provider reconnects.

---

## Scenario 13.9 — Disconnect a provider

**Setup**
1. A provider is connected.

**Steps**
1. Open the Provider Form for that provider.
2. Click `Disconnect`.

**Expected**
- The provider is removed from the Connected list.
- The saved credential is deleted from `safeStorage`.
- The provider can be re-added via `+ Add provider`.

---

## Scenario 13.10 — Search models

**Setup**
1. A provider has many models loaded.

**Steps**
1. Type in the model search input.

**Expected**
- The model list filters by name (case-insensitive, substring match).

---

## Scenario 13.11 — Refresh model list

**Setup**
1. Models screen is open.

**Steps**
1. Click `Refresh` (if available).

**Expected**
- The app re-fetches the model list from the provider.
- New models appear.

---

## Scenario 13.12 — Custom base URL (OpenAI-compatible)

**Setup**
1. Add Provider → `OpenAI-compatible`.

**Steps**
1. Enter the base URL (e.g. `http://localhost:11434/v1` for Ollama).
2. Enter an API key (or leave blank for no-auth).
3. Click `Connect`.

**Expected**
- The provider connects.
- Models load from the custom endpoint.
- Subsequent chat messages route through the custom URL.

---

## Scenario 13.13 — Provider settings open as popover vs modal

**Setup**
1. From the chat composer's model picker → the settings open as a popover.
2. From the gear icon → the settings open as a modal.

**Steps**
1. Verify both opening surfaces work.
2. The popover is anchored to the model picker.
3. The modal is centered with a backdrop.

**Expected**
- Both surfaces start on the appropriate screen:
  - Popover: `models` or `providers` (depending on readiness).
  - Modal: `settings` (from gear) or `provider-form` (from edit).
- Backdrop click closes the popover; backdrop click also closes the modal.

---

## Scenario 13.14 — Close provider settings

**Setup**
1. Provider Settings modal is open.

**Steps**
1. Click the **Close** button (`aria-label="Close"`).
2. Re-open. Then press `Esc`.

**Expected**
- Both close the modal.

---

## Scenario 13.15 — Provider state persists across app restarts

**Setup**
1. A provider is connected.

**Steps**
1. Quit and re-launch the app.

**Expected**
- The provider is still in the Connected list.
- The selected model is preserved.
- No re-authentication required.

---

## Scenario 13.16 — API key not stored in plain JSON

**Setup**
1. Connect a provider with an API key.

**Steps**
1. Inspect the userData directory. Verify the credentials file (if any) does NOT contain the API key in plain text.

**Expected**
- The credentials are stored in Electron `safeStorage` (encrypted via OS keychain).
- The `llm-config.json` only stores the provider ID + model ID + reasoning effort.

---

## Cross-cutting checks for this block

- The chat panel's `provider pill` reflects the connected provider.
- The Provider Settings modal is the only path to configure providers.

**Next:** proceed to [`14-sessions-and-history.md`](14-sessions-and-history.md).