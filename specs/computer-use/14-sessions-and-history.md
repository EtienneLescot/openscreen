# 14 — Chat sessions, history, rewind

**Surface:** `LeftPanel.tsx` (chat header, session list), `Modals.tsx` (History dialog), `chat-service.ts` (session persistence), `axcut-agent-runtime.ts`.
**Prerequisites:** `12-chat-panel.md`, `13-provider-settings.md`.

**Goal of this block:** prove multi-session chat works — new conversation, rename, switch, delete, history dialog, rewind to a previous checkpoint.

**Reference:**
- design `openscreen-editor.html` — `.msg-head`, `.msg-actions`, etc.
- `LeftPanel.tsx:714` — `aria-label="Rename conversation"`.
- `LeftPanel.tsx:746` — `aria-label="Delete conversation"`.
- roadmap P2.1 — Chat persistence (sqlite).
- roadmap Phase 8 — multi-session chat history.

---

## Scenario 14.1 — New conversation

**Setup**
1. Chat panel open. A session is active.

**Steps**
1. Click the **New conversation** button (`aria-label="New conversation"`).
2. The chat panel switches to a new, empty session.

**Expected**
- The chat messages area is empty (the previous messages are no longer visible).
- The session title in the subheader reads `New conversation` (or `Untitled`).
- The session is now the active session.

---

## Scenario 14.2 — Send a message in the new session

**Setup**
1. From scenario 14.1 state.

**Steps**
1. Send a message (`Hello, what's in this project?`).
2. Wait for the response.

**Expected**
- The new session now has messages.
- The session title may have updated (if the agent has a self-naming behaviour).

---

## Scenario 14.3 — Open History dialog

**Setup**
1. From scenario 14.2 state. At least 2 sessions exist (the original + the new one).

**Steps**
1. Click the **History** button (`aria-label="History"`).
2. The Conversation History dialog opens.

**Expected**
- The dialog lists all sessions for the project:
  - Title.
  - Message count.
  - Last-update date.
- The active session has an `Active` pill.

---

## Scenario 14.4 — Switch to a previous session

**Setup**
1. From scenario 14.3 state. The dialog is open.

**Steps**
1. Click on the first session in the list (a non-active one).
2. The dialog closes.

**Expected**
- The chat panel switches to the clicked session.
- The session's messages are restored.
- The session is now the active one.

---

## Scenario 14.5 — Rename a session

**Setup**
1. From scenario 14.4 state. A session is active.

**Steps**
1. Click the **Rename conversation** button (`aria-label="Rename conversation"`).
2. An inline input appears.
3. Type a new name. Press `Enter`.

**Expected**
- The session title updates.
- The change is persisted.

---

## Scenario 14.6 — Delete a session

**Setup**
1. From scenario 14.5 state. The active session has at least one other session in the list.

**Steps**
1. Click the **Delete conversation** button (`aria-label="Delete conversation"`).
2. A confirmation prompt appears.
3. Confirm.

**Expected**
- The session is removed.
- If it was the last session, the action is disabled.
- If it was the active session, the chat switches to another session.

---

## Scenario 14.7 — Rewind to a user message

**Setup**
1. From scenario 14.6 state. The active session has multiple user messages with checkpoints.

**Steps**
1. Hover over an older user message.
2. Click the **Rewind** button.
3. The Rewind confirmation popover appears.

**Expected**
- The popover reads: `Rewind here? Project, conversation, and agent state will be restored.`
- Two buttons: `Cancel` and `Rewind`.

---

## Scenario 14.8 — Confirm rewind

**Setup**
1. From scenario 14.7 state. The rewind popover is open.

**Steps**
1. Click `Rewind`.

**Expected**
- The project state reverts to the pre-message checkpoint.
- The chat is truncated to the rewound message.
- The composer is pre-filled with the rewound message.
- The agent runtime is reset.

---

## Scenario 14.9 — Cancel rewind

**Setup**
1. Trigger the rewind popover.

**Steps**
1. Click `Cancel` (or press `Esc`).

**Expected**
- The popover closes.
- No state change.

---

## Scenario 14.10 — Session count display

**Setup**
1. From any chat state.

**Steps**
1. Open the History dialog.
2. Count the sessions.

**Expected**
- The dialog shows the exact number of sessions for the project.
- The list is sorted by last-update date desc.

---

## Scenario 14.11 — Sessions persist across app restarts

**Setup**
1. Create 3 sessions with messages.

**Steps**
1. Quit the app.
2. Re-launch.
3. Open the History dialog.

**Expected**
- All 3 sessions are still listed.
- The messages are preserved.

---

## Scenario 14.12 — Session switch preserves the model picker

**Setup**
1. Two sessions exist. Session A used model `gpt-4o`. Session B used `claude-haiku-4-5`.

**Steps**
1. Switch from session A to session B.
2. Read the chat composer's model pill.

**Expected**
- The model pill shows the model of the active session (each session remembers its own model choice).

---

## Scenario 14.13 — Cannot delete the last remaining session

**Setup**
1. Only 1 session remains in the project.

**Steps**
1. Try to delete it.

**Expected**
- The Delete button is disabled.
- A tooltip explains "Cannot delete the last session".

---

## Scenario 14.14 — New conversation resets the composer

**Setup**
1. The composer has typed text from a previous draft (not yet sent).

**Steps**
1. Click **New conversation**.

**Expected**
- The composer's text is cleared.
- The model picker is preserved.

---

## Scenario 14.15 — Switch session via keyboard (if wired)

**Setup**
1. From any state.

**Steps**
1. Press `Ctrl+Shift+[` and `Ctrl+Shift+]` to switch sessions.

**Expected**
- The chat switches to the previous / next session in the list.
- (If not wired, skip — the keyboard shortcuts are not required.)

---

## Cross-cutting checks for this block

- Session data is stored in `~/.config/openscreen/chat.db` (sqlite) — per roadmap P2.1.
- The History dialog is dismissable via `Esc` or backdrop click.

**Next:** proceed to [`15-export-dialog.md`](15-export-dialog.md).