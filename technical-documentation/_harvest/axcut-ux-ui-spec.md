# Axcut Web UI — UX/UI Specification

Single-page dark web app at `http://127.0.0.1:5173`. Five-zone resizable grid, no client-side routing, persistent server connection via SSE.

## 1. Layout

CSS grid, full viewport, drag-to-resize on every gutter. Open/closed state for each side panel is persisted in `localStorage`.

```text
┌──────────────────────────────────────────────────────────────────────┐
│                        scene-header (56 px)                          │
├──────────┬───┬─────────────────────────┬───┬─────────────────────────┤
│          │ ↔ │      preview-pane       │ ↔ │    transcript-rail      │
│ left-rail│   │                         │   │                         │
│  (tabs + │   │                         │   │                         │
│   panel) │   │                         │   │                         │
│          │   │                         │   │                         │
├──────────┴───┴─────────────────────────┴───┴─────────────────────────┤
│                       timeline-resizer (1 px)                        │
├──────────────────────────────────────────────────────────────────────┤
│                          timeline-pane                               │
└──────────────────────────────────────────────────────────────────────┘
```

- `chatPanelOpen`, `timelinePanelOpen`, `transcriptPanelOpen` — toggle from header.
- Below 980 px viewport, resize handles are disabled (panels stack).
- Chat width default 610 px, transcript width default 360 px, timeline height default 170 px.

---

## 2. Scene Header (top bar)

Left: **project title** (button → click to rename → inline input; Enter saves, Esc cancels, blur saves). Right: **Export** button + **panel toggle group** (hide/show chat, timeline, transcript — icon swaps between panel-open and panel-closed variants).

- Export is disabled if there are no clips, no session token, or an export job is already running.
- Rename error renders inline under the title.

---

## 3. Left Rail — Tabs

Vertical tab strip on the left edge, 74 px wide. Two tabs:

- **Project** (folder icon) — file and composition browser.
- **Axcut** (mascot icon) — chat.

Selecting a tab auto-opens the chat panel if collapsed.

---

## 4. Project Panel (left rail, "Project" tab)

Scrollable. Two sections.

### 4.1 Compositions
- Up to **4 most recently updated** projects listed, sorted by `updatedAt` desc.
- Active project shows a check mark and "active" highlight.
- Header `+` icon opens the **Projects dialog** (see §10.1).

### 4.2 Files
- **Upload** icon triggers hidden `<input type="file" accept="video/*,.mp4,.mov,.m4v,.webm,.mkv">`.
- Read-only **Search** field (placeholder, not wired).
- **File list**: each row = draggable item, label + duration. Shows one of four transcript-status indicators: `pending` (gray dot), `running` (spinner), `complete` (green dot), `failed` (red dot).
- During upload: row replaced by "Uploading video..." status card with spinner.
- **Click** a file → opens Source Transcript modal (§10.4).
- **Drag** a file into the timeline → drops at pointer time, opens Insert Source dialog (§10.3).
- Hover tooltip clarifies drag vs click.
- Upload errors render inline above the list.

---

## 5. Axcut Panel — Chat (left rail, "Axcut" tab)

Three vertical blocks: header, messages (scrollable), composer (sticky).

### 5.1 Chat header
Header row of icon buttons (icon + tooltip; text on hover via `title`):

- **Context pill** — `% context` fill of the model window; tooltip shows prompt tokens / window.
- **Worktree pill** — current worktree branch or path, click opens Worktrees dialog. Only when a session is active.
- **Worktrees button** — same target.
- **Compact context button** — triggers `compact_context`; disabled when no active session, compaction pending, or chat in flight.
- **Settings (gear)** — opens Provider Settings modal, initial screen = "settings".
- **History** — opens Conversation History dialog.
- **New chat** — creates a fresh session and activates it.

Subheader: active session title (or "New conversation"). Read-only.

### 5.2 Messages area
Auto-scroll to bottom while near bottom. Scroll up = manual mode (auto-scroll suspends).

Each message is one of `user | assistant | system`. Renders:
- Role label (`you`, `Axcut`, or system), timestamp.
- Content paragraph.
- Per-message action row (appears on hover):
  - **Rewind** (back arrow) — only on user messages with a checkpoint. Opens a confirmation popover ("Rewind here? Project, conversation, and agent state will be restored." Cancel / Rewind). Sends a rewind request; on success the prompt is pre-filled with the rewound message and live-run state resets.
  - **Copy** — copies message text to clipboard.

Empty state: "No messages in this conversation yet." or, with no project, "Start the server with AXCUT_VIDEO_PATH set to a local video file."

### 5.3 Live-run feed (appended below messages while running)
Cards shown only while the agent is active. Disappears when no run is in flight:
- **Thinking** card — agent's streamed reasoning text (Brain icon).
- **Operation card** — one per tool/operation (Brain / Terminal / Wrench icon + label + status pill `Running`/`Done`/`Error`, optional one-line summary, expandable "Show details" with full body).
- **Context compacted** card — short compaction summary + source tag.
- **Streaming assistant draft** — assistant reply as it streams; ends when the final message arrives.
- **Run indicator** — 9-dot animated bar at the bottom while active.

### 5.4 Composer
- Multi-line textarea (2 rows), placeholder "Describe the edit you want." Resize vertical.
- `Enter` sends, `Shift+Enter` inserts newline.
- **Provider pill** (sliders icon + `provider / model`) — click opens Provider Settings popover; opens on "models" if ready, on "providers" otherwise.
- **Reasoning pill** — only shown when the model supports it; shows current level (e.g. "Reasoning medium"). Click opens the Reasoning popover with the six levels (`none / minimal / low / medium / high / xhigh`).
- "Waiting for the agent response…" muted text while the first byte is pending.
- **Send button** (paper plane) — disabled until there is a project, a session token, a configured LLM, non-empty trimmed text, and no in-flight chat. Icon swaps to a spinner mid-send.
- Inline error message under the form when the chat request fails.

---

## 6. Preview Pane (center)

Two stacked `<video>` layers (A/B) for buffer-and-swap at clip boundaries, plus a controls bar. Renders the **playback timeline** (timeline minus skip ranges).

### 6.1 Video frame
- Layers preload the next clip before its boundary (cross-fade by swapping active layer).
- States shown as overlay text:
  - `loading` — "Loading preview media..."
  - `error` — "Video preview could not be loaded."
  - `idle` / no sources — "Attach a video to start previewing." placeholder.
- Click on the frame toggles play/pause.
- Fullscreen toggle via the controls (button); the frame itself responds to the Fullscreen API.

### 6.2 Controls bar (under frame)
- **Play / Pause** (icon swaps), disabled if no clips or not ready.
- **Restart** — seek to 0.
- **Fullscreen** — enter / exit fullscreen on the frame.
- **Time readout** — `MM:SS.mmm / MM:SS.mmm` (current / total virtual duration).
- **Range slider** — scrub through the virtual duration; thumb progress is color-filled; click jumps, drag scrubs. Disabled until ready.

The current playback position drives the transcript cue highlight, the timeline playhead, and the time readout in the timeline header.

---

## 7. Transcript Rail (right)

Header "Current Transcription". Below, one of three states:
- "No timeline clips yet."
- "No transcript is available for timeline clips yet."
- **ContentEditable transcript view** (one block per clip, in timeline order):
  - Per-clip header: numbered badge, asset label, `Clip N · start - end`.
  - Words rendered as `<span data-word-id>`. Per-word class: `kept | cut`, optional `cue` (current playback position) and `silence` (gap tokens shown as `(0.5s)`).
  - **Kept runs** group kept words; **cut runs** group skipped words and show a hover-revealed trash button (Removes skip).
  - Whole region is `contentEditable` (disabled while `busy`); typing/pasting is blocked; only deletions are meaningful.

### 7.1 Interactions
- **Click a word** → seek preview to that source time; auto-scroll to the cue word if it leaves the viewport.
- **Select a range of words** with the mouse → press `Backspace` or `Delete` (or fire the `deleteContent*` input event) → adds a skip range for those words (only kept words; cross-asset selection is ignored).
- **Backspace/Delete at a collapsed caret** deletes the adjacent kept word (Backward = Backspace, Forward = Delete), producing a one-word skip.
- **Trash button** on a cut run → removes that skip.
- **Caret moves with arrow keys** → preview seeks to the new caret's interpolated time.
- Auto-scroll keeps the cue word visible with a 56 px top/bottom margin.

---

## 8. Timeline Pane (bottom)

Header row + viewport + navigator strip.

### 8.1 Header
- Left: title "Timeline", subtitle `N clips · M skips · total duration`.
- Right:
  - **Scissors button** — toggles "place-skip" mode. While active, hover shows a vertical placement marker; click anywhere in the timeline creates a skip at that source time. Disabled while busy or no clips.
  - Current timeline time, plus "Clip i/N" or "No active clip".

### 8.2 Viewport (scrollable)
Ruler + clip lane + overlays.
- **Ruler** with major/minor ticks; major ticks labelled with `mm:ss.s`.
- **Clip blocks** — one per timeline clip in playback order. Each shows:
  - A skip strip across the top (small dim segments at skip positions).
  - A body with the asset label, `timeline start - end`, and `source start - end`.
  - **Edit (pencil) button** → opens the Clip Edit modal.
- **Clip selection / drag**: pointer-down on a clip starts a drag-to-reorder. Threshold (6 px) before it engages; once dragging, the clip snaps to the nearest drop position with a vertical reorder marker. Releasing dispatches `move_clip`.
- **Click a clip** → selects it (highlight).
- **Hover a skip** → skip-hover-controls appear above the strip with:
  - `‹` resize handle (only if the skip is not pinned to the clip edge).
  - Trash button (remove skip).
  - `›` resize handle.
  - Drag the handles to adjust start/end (`update_skip_range`).
- **Playhead** — vertical line at the current source time.
- **Pending cut marker** — vertical preview line in scissors mode.
- **Reorder marker** — vertical line during drag-to-reorder.

### 8.3 Interactions on the empty surface
- **Click / drag** → scrub (preview seeks on every move).
- **Alt + drag** or **middle-button drag** → pan horizontally when the visible window is narrower than the source duration.
- **Ctrl + wheel** → zoom (in/out by 1.18×), anchored at the cursor X.
- **Drop an asset** (`application/x-axcut-asset`) → opens Insert Source dialog.
- **Wheel** without Ctrl → default page scroll.

### 8.4 Navigator strip (under viewport)
Horizontal overview with skip markers. A draggable window shows the currently visible range:
- Drag the **body** → pan.
- Drag the **left handle** → resize window from the start.
- Drag the **right handle** → resize window from the end.

### 8.5 Clip Edit modal
- Title "Edit clip", subtitle asset label, close (X) button.
- Left: Virtual preview of the source range only.
- Right: start / end / duration readouts, source-range track with draggable handles (start / end), reset / cancel / apply.
- Apply dispatches `update_clip_range` and closes.
- Esc closes the dialog.

---

## 9. Modals & Popovers

All modals: backdrop click closes; Esc closes (where wired).

### 9.1 Projects dialog (LoadVideoDialog)
Opens from the `+` button next to Compositions.
- Left column: "Recent projects" (up to 8, sorted by `updatedAt`); each row shows title + date, active gets "Open" pill.
- Right column: "New project" with description and `+ New project` button. Inline error on failure. New project becomes the active project, dialog closes.

### 9.2 Conversation History dialog
- Lists every session for the active project: title, message count, last-update date.
- Active session shows "Active" pill.
- Per-row: **Rename** (pencil → inline editor → save), **Delete** (trash, disabled if only one session remains).
- Click on the main body switches to that session and closes.

### 9.3 Worktrees dialog
- "Main workspace" entry (the repo checkout) + each available worktree (branch name, full path, "Locked" pill when applicable, "Active" pill when selected).
- **Create** button → `createWorktree`.
- **Select** → activates that worktree.
- Trash → removes (disabled when locked).

### 9.4 Source Transcript modal
- Header: "Source Transcript" + asset label (or artifact filename).
- Top: source-only video preview (full asset range).
- Toolbar: status pill (`Not generated yet / Generating / Generated / Generation failed`), `Detected language: xx`, language selector for regeneration (`auto / en / fr / de / es / it / pt / nl / ja / ko / zh`), **Regenerate transcript** button (spinner while running).
- Body: `<pre>` showing the raw transcript artifact text, with loading state and error copy.
- Closing clears the modal.

### 9.5 Provider Settings — opening surfaces
Same component, two surfaces:
- **Popover** anchored at the provider pill / gear: starts on `models` or `providers` depending on readiness.
- **Modal**: starts on `settings` (from gear) or `provider-form` (from edit).

Screens (deep-linking via `initialScreen`, back-arrow on top-left):
- **Models** — provider label, current model, model search input, scrollable model list (`Active` marker on the selected one). If the saved login is expired, shows **Reconnect**. If a device challenge is open: code card with the user code, copy button (turns into check + "Copied"), "Open login page" external link.
- **Providers** — grid of connected providers; pick one → Models screen. `Provider settings` button at the bottom.
- **Provider Settings (settings screen)** — list of connected providers with per-row edit; `+ Add provider` button.
- **Add Provider (provider-create-select)** — list of available providers; pick one → provider form (create mode).
- **Provider form** — provider label, description (e.g. "Sign in with your ChatGPT account."), Model select (populated when connected; shows "Connect this provider to load…" otherwise), Reasoning effort select (when supported), Base URL input (when required), API key input (password; placeholder notes "Leave blank to keep stored key" when connected). Buttons:
  - `Disconnect` (danger, only when connected).
  - `Connect` / `Update key` / `Start login` / `Reconnect login` (label depends on whether the provider uses OAuth and whether it is connected).
  - `Use provider` (commits the selected model and closes the modal/popover).
  - Device challenge panel appears in-form for OAuth providers, identical to the Models screen card.

Backdrop click on the popover closes; on the modal, click on the backdrop also closes.

### 9.6 Reasoning popover
Anchored at the reasoning pill. Lists the six reasoning-effort options with the current one marked `Active`. Selecting dispatches an update and closes.

### 9.7 Insert Source modal
Triggered by dropping an asset onto the timeline. Header shows source label and insertion time. Three choices:
- **Add before** — insert the whole source before the target clip.
- **Add after** — insert the whole source after the target clip.
- **Split here and insert** — split the target clip at the drop point and insert the source in between.

### 9.8 Rewind confirmation popover
Anchor-below the rewind button. "Rewind here?" + warning copy. Cancel / Rewind.

---

## 10. Status & Feedback Surfaces

### 10.1 Status chips
Inline chips for two jobs:
- **Transcription** — `idle | running | ready | error`; label + detail (e.g. "120 segments · 1840 words · en"); progress fill on the dot.
- **Export** — `idle | running | ready | error`; on `ready` adds a **MP4 download** button (anchored `<a download>`).

### 10.2 File transcript indicators
Four-state dot in the Files list (see §4.2).

### 10.3 Live-run visual signals
Thinking/operation/compaction cards + streaming draft + run indicator (see §5.3).

### 10.4 Errors
- Per-mutation inline error message under the relevant form / button.
- Provider Settings surfaces a `reconnectRequired` banner when the saved credential no longer works.

---

## 11. Conversation Lifecycle (end-to-end flow)

1. User lands on the app → first project auto-selected if any.
2. Empty state: chat shows "Start the server with AXCUT_VIDEO_PATH set to a local video file." if no project; otherwise the chat says "No messages in this conversation yet."
3. If LLM is not configured: send button is disabled, provider pill shows "LLM not configured". User clicks it → Provider Settings popover.
4. User configures a provider (API key or OAuth device flow), selects a model, closes popover.
5. User opens the Project tab → uploads a file (drag-and-drop or button). File appears with `running` indicator; ffmpeg probes + creates proxy + Whisper transcribes.
6. User can switch to the file's transcript modal to inspect / regenerate it.
7. User drags the file into the timeline, or asks the agent to "Add this file to the timeline." Drop → Insert Source dialog → timeline now has a clip.
8. User asks the agent to edit: e.g. "Remove silences and hesitations." → live-run feed streams thinking + operations → final assistant message + applied timeline edits.
9. User reviews transcript; selects words and presses Backspace to add manual skips; drags skip edges in the timeline to fine-tune; clicks the pencil on a clip to retune its source range.
10. User scrubs the preview, watches it, adjusts again.
11. User clicks **Export** → render job queued → progress chip → MP4 download button.
12. User opens History, switches to a previous session, or **Rewinds** to an earlier user message to undo a chain of edits.
13. User closes the panel group via header toggles; positions persist.

---

## 12. Models (LLM Providers)

Configured from the UI; stored credentials live in the `axcut-data` volume (Docker) or `.env` (manual). Source for the live key shown in the provider card (`stored` vs `environment`).

| Provider | Auth | Notes |
|---|---|---|
| OpenAI | API key | Optional base URL for compat. |
| Anthropic | API key | |
| Google (Gemini) | API key | |
| Mistral | API key | |
| OpenRouter | API key | |
| OpenAI-compatible | API key + base URL | Required base URL. |
| GitHub Copilot | OAuth (device flow) | "Sign in with your GitHub account." |
| MiniMax | API key | |
| ChatGPT / OpenAI account | OAuth (device flow) | "Sign in with your ChatGPT account." |

- **Reasoning effort**: shown as a pill next to the provider pill when the active model supports it. Values: `none, minimal, low, medium, high, xhigh`. Selection persists for that provider/model.
- **Device flow** sequence: user clicks Connect → server returns `userCode`, `verificationUri(Complete)`, `intervalMs`, `expiresAt` → UI shows code card → user copies the code, opens the verification URL, approves → UI polls until complete → provider becomes Connected, models load, user picks one.
- **Reconnect**: when the server reports `provider_auth_expired` / `reconnectRequired`, the Models screen shows a **Reconnect** button and the provider-form banner explains that the saved credential no longer works.

---

## 13. Keyboard Shortcuts & Gestures

| Where | Input | Action |
|---|---|---|
| Chat composer | `Enter` | Send message |
| Chat composer | `Shift+Enter` | Newline |
| Transcript view | `Backspace` / `Delete` | Skip selected / adjacent kept word |
| Transcript view | Arrow keys | Move caret → preview seeks |
| Transcript view | `Cmd/Ctrl + A` then type/paste | Blocked (only deletion is allowed) |
| Timeline viewport | Click / drag | Scrub preview |
| Timeline viewport | `Alt` + drag or middle-button drag | Pan |
| Timeline viewport | `Ctrl/Cmd` + wheel | Zoom around cursor |
| Timeline ruler / clip / drop | Drop asset | Open Insert Source dialog |
| Clip block | Drag | Reorder clip |
| Skip strip | Drag `‹` / `›` | Resize skip |
| Skip strip | Hover, click trash | Remove skip |
| Skip strip | Click | (no action; selection is in transcript) |
| Clip edit pencil | Click | Open Clip Edit modal |
| Header toggles | Click | Show/hide chat / timeline / transcript panels |
| Resize gutters | Drag | Resize panels (persisted) |
| Modals | `Esc` / backdrop click | Close |
| Rewind popover | `Esc` / outside click | Cancel |
| Rename title | `Enter` save / `Esc` cancel | Rename project |

---

## 14. Persistence

- Panel open/closed flags and widths/heights: `localStorage` (`axcut.workbench.*`).
- Provider credentials, selected provider/model, reasoning effort: server-side (`.axcut-data` volume) with `.env` override.
- Project state, transcripts, jobs, sessions, checkpoints, worktrees: server-side JSON under `.axcut-data`.
- The UI revalidates on a 5-second poll and via SSE stream (`/api/projects/:id/stream`) for live updates.

---

## 15. Streaming Events (UX-visible effects)

The UI subscribes to the project SSE stream. Visible behaviours:
- `job.progress` / `job.completed` / `job.failed` → status chips and file-list indicators update.
- `project.transcript.updated` → transcript modal reloads, source-transcript query invalidates.
- `project.revision.created` → timeline re-renders (clip / skip changes).
- `preview.ready` → preview reloads the affected layer.
- `agent.message.user / assistant / delta` → messages list and live-run draft update.
- `agent.thinking.delta` → Thinking card text streams.
- `agent.operation` → operation card enters/updates/exits.
- `agent.compaction` → Context-compacted card appears; live-run state resets.
- `agent.checkpoint.*` → rewind availability per user message updates.
- `agent.session.*` → header session title and History list update.

---

## 16. Empty / Failure / Disabled States

- No project → chat empty copy + disabled send; Project panel shows "No compositions yet." / "No files in this project."
- No LLM configured → provider pill says "LLM not configured"; send disabled.
- No clips → timeline shows "No virtual clips yet."; export disabled; preview shows placeholder; transcript shows empty copy.
- Transcription not ready → status chip `Transcription waiting` / `Preparing transcription`; transcript view shows "No transcript is available…".
- Transcription failed → status chip `Transcription failed` + reason; file list shows red dot.
- Export queued / running → button label "Exporting", disabled until the job completes or fails.
- Export failed → status chip `Export failed` + reason.
- Models loading → list shows "Loading models..."; search input disabled.
- Reconnect required → Reconnect button on Models screen; banner in provider form.
- OAuth pending → device challenge card replaces the connect button until complete or expired.
- Drop on empty timeline (no clips) → still opens Insert Source modal, but the three buttons disable when the asset has no probed duration yet.