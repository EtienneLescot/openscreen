# 12 — Chat panel + AI agent

**Surface:** `LeftPanel.tsx` (chat tab + composer + messages + live-run feed), `chat-service` (`electron/ai-edition/chat-service.ts`).
**Prerequisites:** `02-editor-foundation.md`, `13-provider-settings.md` (a provider must be configured), `05-clip-operations.md` (a project with clips for the agent to edit).

**Goal of this block:** prove the AI chat panel works end-to-end: open it, send a message, receive a streamed response, watch live-run cards (thinking / operation / compaction), see tool-call "applied: …" summaries, undo an agent batch.

**Reference:**
- design `openscreen-editor.html` — `.chat-strip`, `.msg-card-top`, `.msg`, `.model-card`, `.send-btn`, `.model-picker`.
- `LeftPanel.tsx:594` — `aria-label="Compact"`.
- `LeftPanel.tsx:613` — `aria-label="AI settings"`.
- `LeftPanel.tsx:635` — `aria-label="History"`.
- `LeftPanel.tsx:656` — `aria-label="New conversation"`.
- `LeftPanel.tsx:916` — `aria-label="Send"`.
- roadmap P1.1–P1.8 (`55372df`) — tool schema, dispatch, checkpoint, multi-turn loop, applied-line, undo.
- tool schema: `getCurrentDocument`, `getTranscript`, `addSkip`, `setSkipRange`, `setClipRange`, `replaceTimeline`.

---

## Scenario 12.1 — Open the chat panel

**Setup**
1. From the previous block. `AI_FEATURES_ENABLED = true` (default in development).

**Steps**
1. Click the **Chat** button on the left rail.
2. The left panel switches to the Chat tab.

**Expected**
- The chat panel shows:
  - A context pill (current model's context window fill).
  - Action icons: Compact, AI settings, History, New conversation.
  - The active session title.
  - A scrollable messages area.
  - A composer with a model picker, a reasoning pill (if model supports), and a send button.

---

## Scenario 12.2 — Empty chat state

**Setup**
1. From scenario 12.1 state.

**Steps**
1. The messages area is empty.

**Expected**
- The empty state copy reads: `No messages in this conversation yet.` (or localized equivalent).
- The send button is disabled until the user types text.

---

## Scenario 12.3 — Send a message

**Setup**
1. From scenario 12.2 state.

**Steps**
1. Type `Trim silence from 1 to 2 seconds.` in the composer textarea.
2. Click the **Send** button (`aria-label="Send"`).
3. Wait for the agent's response.

**Expected**
- The user message appears in the messages area.
- The send button shows a spinner while waiting.
- The agent's response streams in (or arrives as a single message in non-streaming mode).
- The send button returns to its idle state.

---

## Scenario 12.4 — Live-run feed (thinking card)

**Setup**
1. From scenario 12.3 state. The agent is responding.

**Steps**
1. While the response is in flight, observe the chat panel.

**Expected**
- A "thinking" card appears below the messages (Brain icon + streamed reasoning text).
- A 9-dot animated run indicator at the bottom.
- An operation card appears per tool call (Brain / Terminal / Wrench icon + label + status pill `Running` → `Done` | `Error`).

---

## Scenario 12.5 — Applied-line for a tool call

**Setup**
1. From scenario 12.4 state. The agent called `addSkip` or `setSkipRange`.

**Steps**
1. Look at the assistant message after the tool call completes.

**Expected**
- Below the message, a compact line reads `applied: <description of the tool call>`.
- Format examples: `applied: trimmed 0:02.1 → 0:02.4`, `applied: skipped 0:01.0 → 0:02.0`.
- The line is visually distinct (smaller, dimmer).

---

## Scenario 12.6 — Multiple tool calls in one response

**Setup**
1. From scenario 12.5 state. The agent returned 2 tool calls in the same response.

**Steps**
1. Read the messages area.

**Expected**
- Two `applied: …` lines appear under the assistant message.
- Each describes a different operation.

---

## Scenario 12.7 — Plain text answer (no tool call)

**Setup**
1. Send a message that doesn't require any tool call (e.g. `What does this clip say?`).

**Steps**
1. Wait for the response.

**Expected**
- The assistant message is a plain text answer.
- No `applied: …` line appears.

---

## Scenario 12.8 — Model picker popover

**Setup**
1. From scenario 12.7 state.

**Steps**
1. Click the **model picker** pill in the composer (shows `provider / model`).
2. The Provider Settings modal opens on the `models` screen.
3. Pick a different model.
4. Close the modal.

**Expected**
- The pill updates to the new model.
- Subsequent messages use the new model.

---

## Scenario 12.9 — Reasoning pill (for models that support reasoning)

**Setup**
1. The active model supports reasoning effort (e.g. `o1`, `claude-opus-thinking`).

**Steps**
1. Click the **reasoning pill** (shows the current level, e.g. `Reasoning medium`).
2. A popover appears with the 6 levels: `none / minimal / low / medium / high / xhigh`.

**Expected**
- The current level is marked `Active`.
- Selecting another level updates the pill.

---

## Scenario 12.10 — Compact context (button)

**Setup**
1. The chat has accumulated messages.

**Steps**
1. Click the **Compact** button (`aria-label="Compact"`).
2. The agent runs a compaction pass.

**Expected**
- A `Context compacted` card appears in the live-run feed.
- After compaction, the context pill drops in fill percentage.
- The chat is still usable.

---

## Scenario 12.11 — Undo an agent batch

**Setup**
1. The last agent response added a skip range.

**Steps**
1. Click the **Undo** button (in the chat panel header or somewhere accessible).

**Expected**
- The skip range is removed.
- The agent batch is reverted (checkpoint restore).
- The chat history is preserved (no message is deleted).

---

## Scenario 12.12 — Auto-scroll in messages area

**Setup**
1. The chat has many messages.

**Steps**
1. Scroll up in the messages area.
2. Send a new message.
3. Wait for the response.

**Expected**
- The new message + response is added at the bottom.
- Auto-scroll does NOT engage (because the user scrolled up).
- When the user scrolls back down, auto-scroll resumes.

---

## Scenario 12.13 — Message action: copy

**Setup**
1. A message exists. Hover over it.

**Steps**
1. Click the **Copy** button (appears on hover).

**Expected**
- The message text is copied to the clipboard.

---

## Scenario 12.14 — Message action: rewind (user message with checkpoint)

**Setup**
1. A user message has a checkpoint (any user message does by default).

**Steps**
1. Hover over the user message.
2. Click the **Rewind** (back-arrow) button.
3. A confirmation popover appears: `Rewind here? Project, conversation, and agent state will be restored.`
4. Click `Rewind`.

**Expected**
- The project state reverts to the pre-message checkpoint.
- The chat is truncated (the messages after the rewound message are removed).
- The langgraph thread is reset.
- The composer is pre-filled with the rewound message.

---

## Scenario 12.15 — Cancel rewind

**Setup**
1. From scenario 12.14 state. Trigger the rewind popover.

**Steps**
1. Click `Cancel` (or press `Esc`).

**Expected**
- The popover closes.
- No state change.

---

## Scenario 12.16 — Send button disabled states

**Setup**
1. The chat composer.

**Steps**
1. Verify the send button is disabled when:
   - No project loaded.
   - No LLM provider configured.
   - The text is empty.
   - A message is in flight.

**Expected**
- The button has reduced opacity and `cursor: not-allowed`.

---

## Scenario 12.17 — Inline error on send failure

**Setup**
1. Trigger a send failure (e.g. invalid LLM response, network error).

**Steps**
1. Observe the composer.

**Expected**
- An inline error message appears below the composer.
- The send button returns to its idle state.

---

## Scenario 12.18 — Provider not configured

**Setup**
1. No provider is configured.

**Steps**
1. The model picker pill shows `LLM not configured`.
2. The send button is disabled.

**Expected**
- Clicking the model picker opens the Provider Settings popover.
- The user can configure a provider.

---

## Cross-cutting checks for this block

- The chat panel preserves scroll position across panel collapses.
- The send button's spinner is visible during in-flight requests.
- The reasoning pill is hidden for models that don't support it.

**Next:** proceed to [`13-provider-settings.md`](13-provider-settings.md).