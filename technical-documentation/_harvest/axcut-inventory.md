# Axcut Inventory — Merge into OpenScreen

> Catalog of the axcut codebase at `/home/etienne/repos/axcut/` (in WSL Ubuntu) as it stands for the AI-edition merge. Path notation is `path:line` relative to the axcut repo root.

---

## 1. Schema (`@axcut/schema` package)

`packages/axcut-schema/src/index.ts` (402 lines) is the SSOT Zod schema for the project. Re-exports `axcutSchemaVersion = 2`.

### Core types (every Zod schema → inferred type)
| Schema | Fields | Notes |
|---|---|---|
| `wordSchema` | `id`, `assetId?`, `segmentId`, `startSec`, `endSec`, `text` | Whisper tokens; `assetId` is optional for back-compat with single-asset transcripts. |
| `transcriptSegmentSchema` | `id`, `assetId?`, `kind: 'speech'\|'silence'`, `startSec`, `endSec`, `text`, `wordIds[]` | `kind = 'silence'` is rendered separately by the editor. |
| `transcriptSchema` | `assetId`, `language`, `sourceDslPath?`, `sourceJsonPath?`, `segments[]`, `words[]` | One transcript per asset. |
| `assetSchema` | `id`, `kind: 'video'`, `label`, `originalPath`, `proxyPath?`, `waveformPath?`, `durationSec?`, `video?`, `audio?` | `video`/`audio` populated by Python `probe_media`. |
| `clipSchema` | `id`, `assetId`, `sourceStartSec`, `sourceEndSec`, `timelineStartSec`, `timelineEndSec`, `wordRefs[]`, `origin: 'system'\|'agent'\|'user'`, `reason` | The mounted unit on the timeline. |
| `gapSchema` | `id`, `timelineStartSec`, `timelineEndSec`, `reason` | Placeholder gaps between clips (rarely used). |
| `rangeSchema` | `startSec`, `endSec`, `reason` | Shared shape for `muteRanges`, `speedRanges`, `captionRanges`. |
| `skipRangeSchema` | `id`, `assetId`, `startSec`, `endSec`, `reason`, `origin` | Skips reference source-time on the **asset**, not the timeline. |
| `timelineSchema` | `clips[]`, `gaps[]`, `skipRanges[]`, `muteRanges[]`, `speedRanges[]`, `captionRanges[]` | All ranges in source-time coordinates. |
| `pendingQuestionSchema` | `id`, `question`, `reason`, `startWordId?`, `endWordId?` | Agent asks the user. |
| `suggestionSchema` | `id`, `status: 'pending'\|'approved'\|'rejected'`, `category`, `suggestion`, `reason`, `startWordId?`, `endWordId?`, `startSec?`, `endSec?`, `proposedOperation?` | The agent's pending edits. |
| `agentStateSchema` | `baseIntent?`, `pendingQuestions[]`, `suggestions[]`, `lastAppliedOperations[]`, `lastReasoningSummary?` | Per-project agent memory. |
| `previewSchema` | `strategy: 'seek'\|'mse-proxy'`, `revision: number` | `revision` increments on any change that affects playback. |
| `exportStateSchema` | `preset: 'preview-low'\|'final-balanced'\|'final-high'`, `lastJobId?` | |
| `timelineOperationSchema` | discriminated union of `replace_timeline`, `drop_range`, `drop_word_range`, `add_skip_range`, `update_skip_range`, `remove_skip_range`, `update_clip_range`, `duplicate_clip`, `move_clip`, `restore_full_timeline`, `insert_asset_clip` | Every edit the UI or agent can apply. |
| `revisionSchema` | `id`, `createdAt`, `author`, `summary`, `operations[]` | History entry. |
| `documentSchema` | wraps `project`, `assets[]`, `transcript` (merged primary), `transcripts[]` (per-asset), `timeline`, `agent`, `preview`, `export`, `history` | Full document. |

### Helpers in the schema package
- `createEmptyDocument(input)` — fresh empty doc with empty arrays.
- `ensureDocument(value)` — Zod-parse an unknown, throw on mismatch.
- `normalizeSkipRanges(skipRanges[])` — merge overlapping/adjacent skips, sort, return dedup'd list. Used everywhere.
- `applySkipRangesToClips(clips[], skipRanges[])` — materialize the timeline by walking each clip, splitting on overlapping skip ranges, retiming into a flat clip array (the "kept" segments). **This is the key function the exporter must call.**

### Schema migration story
- Only v1 → v2 is documented in code. There are no migration functions — `ensureDocument` just parses whatever version it finds.
- **For OpenScreen, this is a problem.** Phase 0 must add a real `migrateDocument(value, fromVersion)` function so legacy `EditorProjectData` (v2) and axcut `AxcutDocument` (also v2, different shape) both round-trip cleanly into the new v3 `AxcutDocument`.

### Things missing from axcut's schema (OpenScreen has them)
- `annotations[]` (text/image/figure/blur overlay regions) — `types.ts:287`.
- `zoomRegions[]` (zoom regions with depth, focus, rotation preset) — `types.ts:71`.
- `legacyEditor` envelope (wallpaper, aspect ratio, padding, crop, cursor, webcam, etc.) — `projectPersistence.ts:67`.
- Cursor telemetry data (raw points) — `types.ts:178`.
- Speed regions (`SpeedRegion[]`) — already in axcut's schema (`rangeSchema`-shaped `speedRanges`).
- Trim regions — **NOT in axcut's schema** (replaced by `skipRanges`).

---

## 2. Server services (`apps/server/src/services/`)

### `document-service.ts` — DocumentService
- Owns the on-disk `.axcut` document; `readDocument / writeDocument / mutateDocument / appendRevision`.
- `addAsset(projectId, input)` resolves `path` to absolute, validates extension set `{mp4, mov, m4v, webm, mkv}`, creates `AxcutAsset`, sets `project.primaryAssetId` if first asset.
- `updateTranscript` normalizes + re-sorts transcripts per asset, **merges to a single primary transcript** (used by VirtualPreview which only consumes one), calls `retimeClips`.
- `applyOperation` (the workhorse) — applies any `AxcutOperation`, appends a `revision`, returns `{ document, revisionId }`.
- `replaceTimeline(projectId, intervals[], summary, author)` — full structural rebuild of clips from normalized intervals (used by `replace_timeline` op and the manual "Restore" button).
- `setSuggestions` — replaces `agent.suggestions[]`.
- `updateExportState` — toggles preset/lastJobId.

### `agent-session-service.ts` — AgentSessionService
- Per-session records persisted under `.axcut-data/deepagent-sessions/records/` (one JSON file per session).
- Per-session checkpoints persisted under `.axcut-data/deepagent-sessions/checkpoints/` (langgraph checkpoint tuples).
- `PersistentFileCheckpointSaver` (custom) implements `BaseCheckpointSaver` against `langgraph-checkpoint`. Uses `WRITES_IDX_MAP` from `@langchain/langgraph-checkpoint`.
- `CheckpointReason` = `'manual' | 'auto' | 'before-message' | 'after-run' | 'before-compaction' | 'after-compaction'`.
- `SessionCheckpointPayload { version: 1, projectId, document, messages, compactedContext? }` is the snapshot of full state at checkpoint time. **This is the rollback unit.**
- `restoreCheckpoint(sessionId, checkpointId)` returns `{ checkpoint, payload?, langGraphRestored, warnings }`. Two restore paths: langgraph state (for runtime thread) + document state (for user-visible timeline).
- `compactedContext` is the post-compaction summary that the agent sees instead of the raw message history.

### `axcut-deep-agent.ts` — AxcutDeepAgentService
- Wraps `createDeepAgent(...)` from `deepagents` (LangGraph-based) with six tools:
  - `transcriptSearch` (query, limit)
  - `suggestCuts` (kind: filler|pause, minDurationSec, limit)
  - `applyTimelineOperation` — dispatches to all 11 timeline ops
  - `approveSuggestion` / `rejectSuggestion`
- `AXCUT_DEEP_AGENT_PROMPT` is hardcoded — system prompt defining Axcut's editorial rules (prefer skip ops for cleanup, structural ops for montage, never invent timestamps).
- Streaming via `agent.streamEvents()` parses `on_chat_model_start|stream|end`, `on_tool_start|end|error`, `on_chain_end` to emit `agent.operation`, `agent.message.delta` events on the `EventBus`.
- Per-session langgraph thread keyed by `sessions.buildSessionConfig(sessionId)`.

### `axcut-agent-runtime.ts` — AxcutAgentRuntime
- Thin façade over `AxcutDeepAgentService`. Exposes `getOrCreateSession`, `createSession`, `getSession`, `listSessions`, `renameSession`, `deleteSession`, `listCheckpoints`, `saveCheckpoint`, `restoreCheckpoint`, `runTurn`.
- `runTurn(projectId, sessionId, userMessage, history)` — runs the agent and returns `{ text, state, document }`.
- Checkpoint orchestration: every user message creates a `before-message` checkpoint; every agent response creates an `after-run` checkpoint.
- **Critical**: `restoreCheckpoint` rewrites the `AxcutDocument` AND truncates messages AND resets the langgraph thread.

### `chat-service.ts` — ChatService
- Single public method `run(projectId, input)`: validates `ChatInput`, gets/creates session, saves `before-message` checkpoint, inserts user message, calls runtime, inserts assistant message, saves `after-run` checkpoint, emits events.
- Returns `{ assistantMessage, document, sessionId }`.

### `database.ts` — DatabaseService (better-sqlite3)
- File: `.axcut-data/metadata.sqlite` (WAL mode).
- Tables: `projects (id, title, document_path, created_at, updated_at)`, `messages (id, project_id, session_id, role, content, revision_id, checkpoint_id, created_at)`, `jobs (id, project_id, kind, status, progress, message, payload_json, result_json, created_at, updated_at)`.
- Indexes: `idx_messages_project_created`, `idx_messages_project_session_created`, `idx_jobs_project_updated`.
- Schema migrations inline (no migration framework). Notable: `messages.session_id` and `messages.checkpoint_id` were added later via `ALTER TABLE`.

### `event-bus.ts` — EventBus
- Simple per-project Node `EventEmitter`. Topics keyed by `project:<projectId>`.
- Events emitted by axcut: `agent.message.user`, `agent.message.assistant`, `agent.message.delta`, `agent.operation`, `agent.checkpoint.saved`, `agent.checkpoint.restored`, `project.revision.created`, `project.asset.updated`, `preview.ready`, `job.queued`, `job.completed`, `job.failed`.
- Renderer subscribes via Fastify SSE endpoint (`/api/projects/:id/events`).
- **For OpenScreen**: replace the EventEmitter fan-out with `webContents.send` so each renderer window receives events. Reuse the existing `NativeBridgeEventName` (`src/native/contracts.ts:230-238`) as the event-channel union.

### `job-service.ts` — JobService
- Long-running async operations queue: `enqueueAssetIngest`, `enqueueTranscription`, `enqueueExport`.
- For asset ingest: probe → proxy → optional transcribe. Each step emits `project.asset.updated`, `preview.ready`, etc.
- Uses `queueMicrotask` to schedule work — no real worker pool. **Edge case**: if the user closes the editor mid-ingest, the job keeps running. axcut handles this implicitly because the Fastify process stays alive; OpenScreen needs explicit "cancel on editor close" logic.

### `llm-config-service.ts` — LlmConfigService
- Wraps `LlmConfigStore` (config on disk + credentials).
- `getSnapshot()` returns `ready, source, stored, effective, providers, connectedProviders, availableProviders` — the shape `ProviderSettingsDialog` consumes.
- Handles `connectProvider`, `selectModel`, OAuth device-flow for ChatGPT (`beginCodexDeviceAuth`, `completeCodexDeviceAuth`), GitHub Copilot (`fetchGitHubCopilotModels`).

### `python-worker.ts` — PythonWorker
- Spawns the Python CLI as a child process: `python -m axcut_worker.cli <args>`.
- Args: `probe`, `proxy`, `transcribe`, `export`, `export-sequence`.
- JSON in, JSON out (`{ ok, data }` or stderr).
- `PYTHONPATH` set to `py/axcut-core/src:py/axcut-worker/src`.
- Uses `pythonExecutable = path.join(repoRoot, '.venv', 'bin', 'python')` — assumes local venv. **Drop with the Python worker in the merge.**

### `worktree-service.ts` — WorktreeService
- Spawns `git worktree add` / `git worktree list --porcelain` / `git worktree remove`.
- Stores worktrees under `.axcut-data/worktrees/<branch>`.
- **Why it exists**: axcut's earlier design (now superseded) let the agent edit *project source files* in an isolated git worktree. The current UX still exposes a "Worktrees" dialog but most users don't use it. **Drop entirely in OpenScreen merge** — video projects don't need git isolation.

---

## 3. Server libs (`apps/server/src/lib/`)

### `timeline.ts` (~200 lines)
- `normalizeIntervals(durationSec, intervals)` — clamp + sort + merge overlapping → flat kept intervals.
- `timelineIntervals(document)` — derives current kept intervals from `document.timeline.clips` filtered to primary asset.
- `buildTimelineFromIntervals(assetId, intervals, { origin, reason, transcript })` — creates clips with retimed `timelineStartSec/EndSec` and collected `wordRefs`.
- `retimeClips(clips, transcript)` — re-flows `timelineStartSec/EndSec` and regenerates `clip_N` ids for new clips.
- `subtractInterval(intervals, cut)` — used by `editable-transcript.ts` LCS deletion.
- `resolveWordRange(document, startWordId, endWordId)` — throws if cross-asset ambiguous; prefers mounted clips over all transcripts.
- `applySourceCutToAsset(clips, assetId, cut, origin, reason)` — internal split helper.
- `applyTimelineOperation(document, operation, origin)` — the big dispatcher (every timeline op).

### `document-operations.ts`
- `applyDocumentOperation(document, operation, origin)` — top-level dispatch (timeline ops + approve/reject_suggestion).
- `replaceSuggestions(document, suggestions, lastReasoningSummary)`.
- `clearExecutedSuggestions(suggestions, operation)` — when an op matches a pending suggestion, mark it `approved`.
- **Uses `JSON.stringify` to compare operations** (`sameOperation`). Fast and works for primitive ops; risk if any op carries non-JSON fields.

### `document-history.ts`
- `appendRevision(document, input, createRevisionId, createdAt?)` — appends a `revision` to `document.history.revisions[]`.
- `refreshProjectUpdatedAt(document, updatedAt?)` — bumps `project.updatedAt`.

### `structured-agent.ts`
- `searchTranscript(document, query, limit)` — tokenized BM25-lite scoring across all transcripts.
- `buildFillerSuggestions(document, minDurationSec, limit)` — finds filler-word runs ("uh", "um", etc.) and emits `AxcutSuggestion[]` with proposed `add_skip_range` ops.
- `buildPauseSuggestions(document, minDurationSec, limit)` — finds long silence pauses similarly.
- Filler lexicon hardcoded at `:11-21`.
- These run **without LLM** — they're cheap pre-LLM suggestions.

### `ids.ts`
- `createId(prefix)` — `prefix_<random>` via `crypto.randomUUID()`.

### `paths.ts` (66 lines)
- `repoRoot`, `dataRoot = '.axcut-data'`, `runtimeRoot`, `projectsRoot`, `agentSessionsRoot`, `llmConfigPath`, `llmCredentialsPath`, `accountAuthRoot`, `databasePath`, `serverRuntimePath`.
- `projectRoot(projectId)`, `projectArtifactsRoot(projectId)`, `projectDocumentPath(projectId)` = `projectRoot/projectId/project.axcut`.
- **No `app.getPath('userData')`** — axcut lives in the repo. **For OpenScreen, swap to `app.getPath('userData')`** (the standard Electron user-data path).

### `media-stream.ts`
- Helpers for video source URL construction (asset-id → file:// URL).

### `utils.ts`
- Generic helpers (`safeStringify`, `truncate`).

---

## 4. LLM provider layer (`apps/server/src/llm/`)

### `provider-registry.ts` — `PROVIDER_DEFINITIONS`
10 providers with full metadata:
| ID | Label | Default model | Auth | Reasoning effort |
|---|---|---|---|---|
| `anthropic` | Claude API | `claude-haiku-4-5` | API key | Yes |
| `openai` | OpenAI API | `gpt-4o` | API key | Yes (gpt-5 family) |
| `google` | Gemini API | `gemini-3-flash-preview` | API key | Yes (gemini-thinking) |
| `mistral` | Mistral API | (uses model name) | API key | No |
| `openrouter` | OpenRouter | (configurable) | API key | Yes |
| `openai-oauth` | ChatGPT (OAuth) | `gpt-5.4` | Device-flow OAuth | Yes |
| `copilot-proxy` | GitHub Copilot | `gpt-4.1` | GitHub PAT | Yes |
| `minimax` | MiniMax API | `MiniMax-M2.7` | API key | No (per axcut) |
| `minimax-token-plan` | MiniMax token-plan | (configurable) | API key | No |
| `openai-compatible` | OpenAI-compatible endpoint | (configurable) | Optional | (model-dep) |

Each definition carries `envKeys[]` (env vars to auto-pick the API key).

### `create-chat-model.ts`
- Returns a LangChain `BaseChatModel` based on `LlmConfigStore.getRuntimeConfig()`.
- Routes by `provider`: `ChatAnthropic`, `ChatMistralAI`, `ChatOpenAI`, or `createLocalProviderLangChainModel` for the four OAuth/special providers.
- For `openrouter/google/openai-compatible` it picks the right `baseURL`.

### `create-langchain-model.ts` — `createLocalProviderLangChainModel`
- `openai-oauth` → `ChatCodexOAuth` (custom subclass of `BaseChatModel`).
- `copilot-proxy` → `ChatOpenAI` with token exchanged from GitHub PAT (`resolveCopilotApiToken`), `defaultHeaders` spoofing VS Code Copilot Chat UA. Custom `CopilotCompletionsModel` extracts `reasoning_text` deltas.
- `minimax` / `minimax-token-plan` → also routes through `ChatOpenAI` against MiniMax's OpenAI-compatible endpoint.

### `openai-account.ts` — ChatGPT OAuth
- `OPENAI_ACCOUNT_BASE_URL = 'https://chatgpt.com/backend-api'`.
- `CODEX_ORIGINATOR = 'codex_cli_rs'` — device-flow origin (matches Codex CLI so backend attributes usage).
- `CODEX_RESPONSES_PATH = '/codex/responses'`, `CODEX_MODELS_PATH = '/codex/models'`.
- `CODEX_REASONING_EFFORT_OPTIONS = ['none','minimal','low','medium','high','xhigh']`.
- `ModelDiscoveryCache` — ETag-cached `/codex/models` response.
- Per-account JSON file under `accountAuthRoot/<id>.json` (refresh tokens).

### `copilot-account.ts`
- Token exchange: `POST https://api.github.com/copilot_internal/v2/token` with `Authorization: Bearer <github_pat>`.
- Caches resolved Copilot token + base URL to `accountAuthRoot/copilot-token.json` with `expiresAt`.
- Reads token, derives base URL via base64-decoding `proxy-ep=` claim in JWT.

### `chat-codex-oauth.ts`
- `ChatCodexOAuth extends BaseChatModel` — implements LangChain v1 chat-model contract.
- Per-session state: `previousPrompt`, `previousResponseId` — supports response-id chaining for efficient multi-turn.
- `CODEX_DEFAULT_INSTRUCTIONS` — system prompt prefix sent on the first turn (Codex identity).

### `tool-schema.ts`
- `normalizeFunctionToolParametersSchema` — turns Zod schemas into OpenAI function-calling JSON schema.

### `agent-provider-capabilities.ts`
- `getReasoningCapability(provider, model)` returns `{ supported, efforts[], defaultEffort?, strategy? }`.
- Strategies: `'custom-openai-account'`, `'openai-responses'`, `'anthropic-thinking'`, `'openrouter-reasoning'`, `'google-thinking'`.
- `buildLangChainReasoningOptions(provider, model, effort)` — translates effort into LangChain options (`{ reasoning, thinking, outputConfig, modelKwargs, useResponsesApi }`).
- `shouldDisableModelStreamingForToolCalling(provider, model)` — for tool-calling models where streaming tool deltas break.

### `llm-config-store.ts` — LlmConfigStore
- File-backed JSON config: `.axcut-data/llm-config.json`.
- API keys stored separately: `.axcut-data/llm-credentials.json` (encrypted? **no — plain JSON**).
- Environment-variable precedence: if `envKeys[i]` is set in `process.env`, it wins over the stored key.
- `getApiKey(provider)` returns the active key (env or stored).

### `utils.ts`
- `withRetry(fn, config)`, `timeoutSignal(ms)`, `CODEX_UPSTREAM_TIMEOUT_MS`, `RETRY_CONFIG`.

---

## 5. Python worker (`py/`)

### `pyproject.toml`
- Python ≥ 3.12 required.
- Dependencies: `faster-whisper>=1.1.1,<2.0.0`, `huggingface-hub>=1.0.0,<2.0.0`, `pydantic>=2.11.0,<3.0.0`, `python-dotenv>=1.1.1,<2.0.0`.

### `axcut_worker/cli.py`
Five subcommands:
- `probe --video <path>` → `{durationSec, video: {codec, width, height, fps}, audio: {codec, sampleRate, channels}}` via `ffprobe`.
- `proxy --video <path> --output <path>` → runs ffmpeg to produce a low-res proxy MP4.
- `transcribe --video <path> --asset-id <id> --dsl-output <dsl> --json-output <json> --model <name> --language <code?>` → runs `faster-whisper` with word timestamps, writes both a custom DSL text format and a JSON payload.
- `export --video <path> --intervals <json> --output <path>` → cuts a single source by intervals.
- `export-sequence --clips <json> --output <path>` → concatenates multiple clips into one MP4.

### `axcut_core/transcribe.py`
- Models: `MODEL_REPOS = { tiny, base, small, medium, large-v3 }` from `Systran/faster-whisper-*` on Hugging Face.
- `transcribe_video(video_path, *, model_name, device, compute_type, language)` → `Transcript`.
- `beam_size=5`, `word_timestamps=True`, `vad_filter=False`.
- Returns pydantic `Transcript` (see models.py).

### `axcut_core/models.py`
Pydantic models mirror the Zod schema but in Python:
- `WordToken (id, segment_id, start, end, text)`
- `Segment (id, kind, start, end, text, words[])`
- `Transcript (source_video, duration, language, kind, edit_prompt, segments[])`
- `DeleteRange (start_word_id, end_word_id, reason)`
- `FollowUpQuestion`, `EditSuggestion`, `EditPlan`
- `KeepInterval (start, end)`

### `axcut_core/dsl.py`
- `write_transcript(path, transcript)` writes a custom plain-text format `AXCUT_TRANSCRIPT v1` with `META`, `SEGMENT`, `WORD`, `ENDSEGMENT`, `SILENCE` lines.
- `read_transcript(path)` round-trips. **This format is the "ingest/export artifact" the README mentions.** Not used by the runtime — only by Python.

### `axcut_core/render.py`
- `create_proxy_video(video_path, output_path)` — ffmpeg command for proxy.
- `render_cut_video(video_path, output_path, keep_intervals)` — ffmpeg concat with negative filter expressions.
- `render_clip_sequence(clips_path, output_path)` — multi-clip sequence.
- `compute_keep_intervals_from_cleaned(source, cleaned)` — derives intervals from a "cleaned" transcript.
- **No high-level effects** (zoom, annotations, blur, cursor). Pure ffmpeg cut/concat. Visual polish is left to a future iteration.

### `axcut_worker/__init__.py` — empty.

---

## 6. Web app (`apps/web/src/`)

### `App.tsx` (top-level — ~1500 lines)
Layout (top-down, all on a single page):
1. **Header** — title, project picker, history dialog toggle, worktree dialog toggle, provider settings toggle, load video dialog.
2. **Status chips** — model status, export status with download button, transcription jobs.
3. **Left sidebar** — ProjectPanel: compositions (recent projects) + files (asset list with drag-source handles).
4. **Center** — VirtualPreview + TranscriptEditor stacked.
5. **Right sidebar** — CurrentTranscriptView (chat panel + suggestions).
6. **Bottom** — TimelinePane with skip ranges, drag-drop assets, clip editing, navigation.
- State from `@tanstack/react-query`: `useQuery(['project', projectId])`, `useMutation` for all ops.
- Local state: `activeSessionId`, `selectedProjectId`, `transcriptLanguage`, `currentTimeSec`, `transcriptModalAssetId`, `sourcePreviewTarget`.
- ~20 modal/dialog components mounted conditionally (history, worktree, provider settings, load video, insert asset, transcript, etc.).

### `components/TimelinePane.tsx` (~1500 lines — longest file in the repo)
The full timeline component. Key features:
- **Clips**: drawn as colored blocks per source, multi-asset layout.
- **Skip ranges**: rendered as gaps between kept segments, with left+right resize handles.
- **Resize modes**:
  - Always-on: skip-handle resize.
  - Pencil-button mode: clip-handle resize (changes `sourceStartSec`/`sourceEndSec`).
- **Pan/zoom** via `NavigatorDragState` (mini-map at top).
- **Asset drop** via HTML5 DnD — sets `pendingAssetInsert` for the InsertAssetDialog.
- **Clip reorder** via `ClipReorderState` (ghost + insert marker).
- **Clip duplicate** via Ctrl+C/V (intercepted at `window.addEventListener('keydown')`).
- **Skip pointer-drag** via `startGlobalPointerDrag` (in `lib/pointer-drag.ts`).
- Calls `onAddSkipRange / onUpdateSkipRange / onRemoveSkipRange / onUpdateClipRange / onDuplicateClip / onMoveClip / onAssetDrop` props.

### `components/VirtualPreview.tsx`
- Two `<video>` elements (`videoARef`, `videoBRef`), crossfade at clip boundary.
- `locateVirtualPosition(clips, virtualTimeSec)` returns `{ clip, clipIndex, virtualTimeSec, sourceTimeSec }`.
- Layer A and layer B swap on clip transitions: when crossing a clip boundary, seek the inactive layer to the next clip's source time, then swap.
- Pending seek queue (`pendingSourceSeekRef`) to avoid race between user seek + clip-boundary seek.
- Preloads next clip's source when within `CLIP_END_LOOKAHEAD_SEC = 0.04` of the end.
- Subscribes to `seekTarget` and `sourcePreviewTarget` props.

### `components/TranscriptEditor.tsx`
- Click a word, shift-click another word → range → "Cut" → `dropWordRange` op.
- "Restore" button → `restore_full_timeline` op.
- Word styling: kept = default, in-skip = red.

### `components/CurrentTranscriptView.tsx`
- Chat panel + suggestions list.
- Renders agent's "operations" (thinking, tool runs) as they stream.
- Markdown rendering for assistant messages (presumably `react-markdown`).

### `components/SuggestionList.tsx`
- Pending suggestions with proposed operation preview; Approve / Reject buttons.

### `components/LlmSetupPanel.tsx`
- The "first-run" provider setup (smaller version of `ProviderSettingsDialog`).

### `components/ProviderSettingsDialog.tsx` (1300+ lines — huge)
- Models screen (per-provider model picker, search, refresh).
- Providers screen (connected provider list).
- Settings screen (edit / add providers).
- Provider-create-select screen (choose which provider to add).
- Provider-form screen (per-provider credentials: API key, base URL, reasoning effort, OAuth device challenge).
- Device challenge UI for OAuth flows (verification URL, user code, copy button).

### Other modals
- `LoadVideoDialog` — recent projects + new-project button.
- `InsertAssetDialog` — when dropping a source on the timeline.
- `TranscriptDialog` — view raw transcript for an asset, regenerate in different language.
- `SessionHistoryDialog` — list, rename, delete sessions.
- `WorktreeDialog` — list/create/remove worktrees (drop in OpenScreen merge).

### `lib/virtual-preview.ts`
Pure-function library used by both React components and server-side timeline math:
- `totalVirtualDuration(clips)` — `clips.at(-1)?.timelineEndSec ?? 0`.
- `clampVirtualTime(clips, value)`.
- `locateVirtualPosition(clips, virtualTimeSec)` — binary search.
- `locateSourcePosition(clips, sourceTimeSec, assetId?, epsilon?)`.
- `resolvePlaybackPosition(clips, currentClip, currentSourceTimeSec, playState)` — `{ inside | next | ended | empty }`.
- `keptWordIdSet(clips)` — for highlighting kept vs. skipped words.
- `selectWordRange(words[], anchorWordId, focusWordId)` — transcript range selection.

### `lib/pointer-drag.ts`
- `startGlobalPointerDrag(target, event, onDelta, onEnd?)` — captures pointer and dispatches `onDelta(dx, dy, event)`.

### `lib/editable-transcript.ts`
- LCS-based deletion algorithm: `deriveEditableTranscriptUpdate(document, editedText)` → returns `{ intervals, deletedWordIds }`.
- Tokenizes by line (`# Clip X` prefixes excluded) → split by whitespace → normalize (`toLocaleLowerCase`, strip non-letter/non-digit punctuation).
- Returns intervals after subtracting the deleted-word ranges.

### `lib/optimistic-timeline.ts`
- Optimistic UI updates for timeline ops.

### `lib/live-run.ts`
- Live-run state for an in-progress agent run (tool-call status, partial deltas).

### Tests
- `lib/{editable-transcript,virtual-preview,optimistic-timeline,live-run}.test.ts` (Vitest).
- `components/{CurrentTranscriptView,TranscriptEditor}.test.ts` (testing-library).
- **No Playwright / browser tests** — everything is jsdom or Node.

---

## 7. Worktree service

Already covered in §2. `WorktreeService` exists for axcut's "agent edits source files in an isolated git worktree" feature, which is **not relevant to a video-editing project**. Drop entirely.

---

## 8. Tests in axcut

- `apps/server/src/services/{document-operations,document-history,agent-session-service,axcut-deep-agent,timeline,chat-service}.test.ts`.
- `apps/server/src/lib/{timeline,document-operations,structured-agent}.test.ts`.
- `apps/server/src/llm/{create-chat-model,llm-config-store}.test.ts`.
- `apps/web/src/components/{CurrentTranscriptView,TranscriptEditor}.test.tsx` + `lib/{editable-transcript,virtual-preview,optimistic-timeline,live-run}.test.ts`.
- `packages/axcut-schema/src/index.test.ts`.
- **No Playwright / browser tests**.
- Total: ~15 test files.

---

## 9. Documentation in axcut

- `README.md` (6759 bytes) — quickstart, architecture, env vars, commands.
- `clip-skip.md` (9597 bytes) — **the conceptual spec** for the clips/skip model. Read when implementing Phase 1.
- `Dockerfile`, `docker-compose.yml`, `.env.example`, `pyproject.toml` — already covered.
- No `AGENTS.md`, no `ROADMAP.md`, no `docs/` folder.

---

## 10. Anything else

### `Dockerfile`, `docker-compose.yml`
- Image installs Python 3.12, Node, ffmpeg, runs `npm install` + `uv pip install -e .`.
- Volumes: `axcut-data` (persisted), `axcut-credentials`, `axcut-cache` (Whisper models).
- Mounts repo at `/workspace` (read-only) so recordings can be imported by absolute path inside the container.
- **For OpenScreen: completely irrelevant** — Electron app, no container.

### `.env.example`
- Common env keys: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_COMPATIBLE_API_KEY`, `AXCUT_MODEL_CACHE`, server ports.

### `scripts/`
- `clean-processes.mjs` — kills leftover dev servers.
- `generate-assets.mjs` — generates `assets/generated/logo_full_h_readme.png` (README logo).

### `.kilo/`
- Empty or near-empty. Kilo is an AI-agent IDE config; not relevant.

### Settings & state shape (`LlmConfigSnapshot`)
```ts
{
  ready: boolean,
  source: { homeDir, configPath, credentialsPath, accountAuthRoot },
  stored: { provider, model, baseUrl, reasoningEffort, apiKeyStored },
  effective: { provider, providerLabel, model, baseUrl, reasoningEffort,
               supportsReasoningEffort, apiKeyAvailable, apiKeySource },
  providers: ProviderState[],
  connectedProviders: ProviderState[],
  availableProviders: ProviderState[],
}
```

### `apps/server/src/app.ts`
Fastify server with routes:
- `GET /api/projects` (list), `POST /api/projects` (create).
- `GET /api/projects/:id` (snapshot: document + messages + jobs).
- `POST /api/projects/:id/operations` (apply op).
- `POST /api/projects/:id/timeline/replace` (full replace).
- `POST /api/projects/:id/chat` (run chat turn).
- `POST /api/projects/:id/assets` (add asset by path).
- `GET /api/projects/:id/transcript/:assetId` (raw transcript artifact).
- `POST /api/projects/:id/assets/:assetId/transcribe` (transcription job).
- `POST /api/projects/:id/sessions` (create), `GET` (list), `PATCH` (rename), `DELETE`.
- `POST /api/projects/:id/sessions/:sessionId/checkpoints` (save), `GET` (list), `POST :restore`.
- `POST /api/projects/:id/worktrees` (create), `GET` (list), `POST :select`, `DELETE`.
- `GET /api/llm/providers` (snapshot), `POST /api/llm/providers/:id/connect`, `POST :device/complete`, `POST :select`, `DELETE`, `GET :/models`.
- `GET /api/projects/:id/events` (SSE).
- `POST /api/exports` (enqueue export job).

**For OpenScreen**: replace all of this with `native-bridge:invoke` handlers in the main process. The SSE pub-sub becomes a `webContents.send` event stream. Each axcut service becomes a TypeScript module in `electron/ai-edition/`.