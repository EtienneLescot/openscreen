# AI Edition Merge — Collision Analysis & Edge Cases

> Cross-references `ai-edition-merge-plan.md`, `openscreen-inventory.md`, `axcut-inventory.md`. Every collision listed here must be resolved before its owning phase starts.
>
> **Severity legend:** 🔴 breaks the merge · 🟠 will cause user-visible regressions · 🟡 polish / nice-to-have.

---

## 1. Schema collisions (Phase 0)

### 1.1 Both projects have `version: 2` but mean different things 🔴
- OpenScreen: `projectPersistence.ts:65` — `PROJECT_VERSION = 2`, denotes the `EditorProjectData` envelope.
- axcut: `axcut-schema/src/index.ts:1` — `axcutSchemaVersion = 2`, denotes the `AxcutDocument` shape.
- **Resolution:** bump everything to v3. Single `SCHEMA_VERSION = 3` constant lives in `src/lib/ai-edition/schema/`. Migration is bidirectional: v2 OpenScreen ↔ v3 ↔ v2 axcut. Document the migration paths in `migrateDocument(value, fromVersion)`:
  - `fromVersion = 2, source = 'openscreen'` → wrap `EditorProjectData` into `AxcutDocument` (single asset, single clip spanning full duration, trimRegions inverted to skipRanges).
  - `fromVersion = 2, source = 'axcut'` → pass-through (already valid).
  - `fromVersion = 3` → no-op.
- Auto-detect source by sniffing for `media.screenVideoPath` (OpenScreen) vs `assets[]` (axcut). No source-of-origin field needed in v3.

### 1.2 Axcut's merged primary `transcript` vs per-asset `transcripts[]` 🟠
- `axcut-schema/src/index.ts:96-100` — `documentSchema` carries **both** a single merged `transcript` and a `transcripts[]` array.
- `document-service.ts:73-83` — every `updateTranscript` call merges all per-asset transcripts into the single primary via `mergeTranscripts`.
- The merge exists because axcut's `VirtualPreview` only consumes one transcript.
- **Collision:** with multi-asset projects, the merge is lossy — you can't tell which words came from which asset.
- **Resolution:** Phase 1 stores only `transcripts[]`; `VirtualPreview` (Phase 2) reads the per-clip `clip.wordRefs[]` instead of a single primary. Drop the `transcript` (singular) field in v3.

### 1.3 OpenScreen's `trimRegions` are inverses of axcut's `skipRanges` 🟠
- OpenScreen: `types.ts:211` — `TrimRegion { id, startMs, endMs }` — regions are **kept**.
- axcut: `axcut-schema/src/index.ts:79` — `skipRangeSchema` — regions are **removed**.
- **Resolution:** migration from v2 OpenScreen inverts: each `trimRegion` becomes a `skipRange` pair (everything outside trim = kept, inside trim = skipped). For the simple case of a single trim region `[a, b]`, you get `skipRanges = [{startSec: 0, endSec: a}, {startSec: b, endSec: duration}]`.
- **Edge case:** when an OpenScreen project has **zero trim regions** (entire recording kept), the migrated project has `skipRanges: []` and **one clip spanning the full duration**. This is the "single-take" baseline — should be the most common migration result.

### 1.4 OpenScreen has fields axcut lacks 🔴
| OpenScreen field | Map to AxcutDocument v3 |
|---|---|
| `editor.trimRegions[]` | invert into `skipRanges[]` |
| `editor.zoomRegions[]` | new `zoomRanges[]` field in `documentSchema` |
| `editor.annotationRegions[]` | new `annotations[]` field in `documentSchema` |
| `editor.speedRegions[]` | already in axcut as `timeline.speedRanges[]` (rangeSchema shape) |
| `editor.{wallpaper, shadowIntensity, showBlur, motionBlurAmount, borderRadius, padding, cropRegion, aspectRatio, webcamLayoutPreset, webcamMaskShape, webcamMirrored, webcamReactiveZoom, webcamSizePreset, webcamPosition, cursorTheme}` | new `legacyEditor` envelope; applied at export time |
| Cursor telemetry (`useScreenRecorder.ts` writes `.cursor.json` next to WebM) | **NOT** in document; stays as sidecar asset metadata. Add `asset.cursorTelemetryPath?` to `assetSchema`. |

### 1.5 Schema fields need asset-scoped addressing 🟠
- In a single-asset OpenScreen project, `zoomRegion.startMs/endMs` are timeline-absolute.
- In a multi-asset project, a zoom region applies to **one source asset** within one **clip**. The simplest model is: zoom regions are clip-scoped, not document-scoped.
- **Resolution:** in v3, `zoomRanges[]`, `annotations[]`, and `speedRanges[]` all carry `clipId?` (optional — null means "apply globally if there's exactly one clip, otherwise error"). OpenScreen's migrated projects (one clip) keep their regions with `clipId: null`. Multi-clip projects require `clipId`.
- This needs a `resolveRegionScope(document, region)` helper.

### 1.6 axcut's `clip_<n>` id generation is fragile 🟡
- `timeline.ts:50-66` — auto-generated ids `clip_1, clip_2, ...`. New clips scan for the next free index. Could collide with user-provided ids.
- **Resolution:** use `crypto.randomUUID()` for all auto-generated clip ids (matching `TimelineEditor.tsx:17` pattern OpenScreen already uses). Update `retimeClips` to skip the numeric generation.

---

## 2. Process model collisions (Phases 0, 6)

### 2.1 Python worker + Faster-Whisper → drop entirely 🔴
- axcut spawns Python as a child process via `PythonWorker` (`apps/server/src/services/python-worker.ts:14`). On Windows, finding `python` on PATH is unreliable; on macOS, codesigning a Python interpreter is a nightmare.
- OpenScreen's `transformers.js` Whisper (`src/lib/captioning/transcribe.ts:44`) runs in a Web Worker, already bundled via `caption-assets/`.
- **Resolution:** axcut's `enqueueTranscription` becomes a renderer-side call to `transcribeMono16kToSegments`. `enqueueAssetIngest` (which calls probe + proxy + transcribe) becomes: renderer reads metadata via `mediabunny` probe; transcribes via Whisper; updates the document.
- **Edge case:** axcut's Whisper defaults to `medium` (1.5 GB); OpenScreen bundles `tiny` (~75 MB). Need a user setting `transcriptionModel` (default `tiny`, opt-in to `medium`). The model download flow must happen in the renderer (transformers.js) — no Python download server.

### 2.2 Fastify + SSE → Electron IPC + `webContents.send` 🔴
- axcut: Fastify listens on `127.0.0.1:4010`, SSE stream at `GET /api/projects/:id/events`.
- OpenScreen: Electron main process + IPC handlers.
- **Resolution:** every axcut route becomes a `native-bridge:invoke` domain action (or a new `ai-edition:invoke` channel). The EventBus stays in the main process; fan-out happens via `webContents.send('ai-edition:event', { projectId, event })`. Renderer subscribes via a new `useAiEditionEvents(projectId)` hook.
- **Edge case:** SSE supports auto-reconnect; raw `webContents.send` does not. If the renderer reloads (e.g. user opens DevTools and hits Cmd+R), it must re-subscribe on mount. Plan accordingly in `VideoEditor.tsx`'s `useEffect`.
- **Edge case:** `webContents.send` only reaches the window it targets. Multiple editor windows? OpenScreen currently has one editor window; verify the renderer doesn't open multiple before assuming fan-out works.

### 2.3 SQLite location `.axcut-data/metadata.sqlite` → `app.getPath('userData')` 🔴
- axcut hardcodes the data dir under the repo.
- OpenScreen uses `app.getPath('userData')` (the OS-standard user data location: `~/Library/Application Support/OpenScreen` on macOS, `%APPDATA%/openscreen` on Windows).
- **Resolution:** move SQLite to `app.getPath('userData')/ai-edition/metadata.sqlite`. WAL mode is fine for Electron.
- **Edge case:** `better-sqlite3` is a native module. OpenScreen already has `@electron/rebuild` in devDeps — verify it's wired in `electron-builder.json5` rebuild step. If not, add `npm rebuild better-sqlite3` to the build script.

### 2.4 axcut's `queueMicrotask` job runner → real cancellation 🔴
- axcut `job-service.ts:18-22` schedules work via `queueMicrotask(() => void runX(...))`. No way to cancel.
- **Edge case:** user closes the editor mid-ingest. axcut's Fastify stays alive, the job keeps running, the renderer never sees the result. User is confused.
- **Resolution:** main-process job runner tracks `Set<JobId>` per window. When the editor window closes, mark all its jobs as `cancelled` and abort the underlying `Worker.terminate()` (caption) or `AbortController.abort()` (HTTP fetch for transcription).

### 2.5 axcut credentials in plain JSON → `safeStorage` 🟠
- axcut: `llm-credentials.json` is plain JSON, written under `.axcut-data/`.
- **Security regression:** OpenScreen should not store credentials as plain JSON. Use Electron's `safeStorage.encryptString()` (OS keychain: Keychain on macOS, DPAPI on Windows, libsecret on Linux).
- **Resolution:** `LlmConfigService` (Phase 7) encrypts keys with `safeStorage` before write; decrypts on read. Keys migrate: on first run, detect plain JSON and re-encrypt.
- **Edge case:** `safeStorage.isEncryptionAvailable()` may return false on Linux without a desktop session. Fallback: `electron-store` with a user-set passphrase, or warn + opt-out.

---

## 3. UX / UI collisions (Phases 1, 5)

### 3.1 Single recording vs multi-take workflow 🔴
- Today: `useScreenRecorder.ts:621` `stopRecording` → `switchToEditor()` is unconditional.
- Plan said: stay-in-recorder with prompt. **Conflict with the existing flow.** Need a decision:
  - **Stay-in-recorder** (Screen Studio feel): every stop → toast "Saved to project X. Record another or open editor?" → two buttons.
  - **Auto-open-editor** (today's feel): every stop → editor opens. The user's mental model matches existing.
- **Recommendation:** default to **stay-in-recorder** when `aiEdition` flag is on and there's an active project; default to **auto-open-editor** when there's no active project. The HUD needs a "Switch project" / "New project" affordance.
- **Edge case:** if the user starts recording without an active project, axcut's flow says "create a new project first." OpenScreen today has no project concept on the HUD. Need a quick-create button.
- **Edge case:** what if recording fails (stream error)? Plan path: don't create the asset; don't switch window; show toast.

### 3.2 `Ctrl+C / Ctrl+V` clip duplicate collides with Electron Edit menu 🔴
- Inventory §9 already flagged this. **Resolution:**
  - Override the application menu's `Edit > Copy` / `Edit > Paste` roles to call `webContents.send('editor:clipboard', { op: 'copy' | 'paste' })` when the editor window is focused. The editor's React handler intercepts and triggers clip duplicate.
  - In text inputs (`<input>`, `<textarea>`, `[contenteditable]`), let the default behavior happen.
  - Existing `Ctrl+D` (`deleteSelected`) collision: rename to `Ctrl+Backspace` for delete (less common) OR keep `Ctrl+D` and pick another binding for duplicate-clip (`Cmd+Shift+D`?).
- **Edge case:** axcut's web app has no system menu to override. The Electron-native approach is new to axcut's clip-dup UX. Test on all three platforms.

### 3.3 Modals stack: axcut uses many modals; OpenScreen uses dialogs + sonner 🟠
- axcut has `ProviderSettingsDialog`, `LoadVideoDialog`, `SessionHistoryDialog`, `WorktreeDialog`, `TranscriptDialog`, `InsertAssetDialog`. All rendered as `modal-backdrop` divs.
- OpenScreen uses `@radix-ui/react-dialog` (`src/components/ui/dialog.tsx`, z-index 9999/10000) and `@radix-ui/react-select` (z-index 100000).
- **Collision:** z-index wars. axcut's CSS uses `.modal` and `.modal-backdrop` classes; mixing with Radix's portal-based stacking is fragile.
- **Resolution:** rewrite axcut's modals to use Radix `Dialog` primitive. Keep the surface (`models / providers / settings` screens) but back them with Radix's portal.
- **Edge case:** the `ProviderSettingsDialog` has a "popover" mode (anchored to a button) and a "modal" mode (full screen). Map popover → Radix `Popover`, modal → Radix `Dialog`. Single component, two surfaces.

### 3.4 Window model: 4 OpenScreen windows vs 1 axcut web app 🟠
- OpenScreen: HUD-overlay, SourceSelector, CountdownOverlay, Editor. They coordinate via IPC + main-process singletons.
- axcut: one web page with everything.
- **Resolution:** the AI-edition view is part of the Editor window. When AI-edition is enabled and a project is open, the editor renders the new layout (resources + preview + transcript + chat + timeline). No new window.
- **Edge case:** during recording, the HUD is open. Should the chat be visible? **No.** Chat is editor-only. Plan accordingly.

### 3.5 i18n: axcut has none; OpenScreen has 13 locales × 7 namespaces 🔴
- axcut: every UI string is hardcoded English.
- OpenScreen: 91 JSON files; `npm run i18n:check` enforces parity.
- **Resolution:** every AI-edition string must go through `useScopedT(namespace)` from `I18nContext.tsx`. Two new namespaces: `ai-edition.editor`, `ai-edition.transcript`, `ai-edition.chat`, `ai-edition.providers`. Run `npm run i18n:check` before each PR.
- **Edge case:** axcut has lots of long descriptive text ("Click a word, then shift-click another..."). Translation to 13 languages will require a translator pass — not just machine translation, since some of these are domain-specific. Plan a translator round before Phase 9 ships.

### 3.6 Markdown rendering for chat bubbles 🟡
- axcut's `CurrentTranscriptView` likely renders assistant messages as markdown (verify by reading the file in detail). OpenScreen has no markdown renderer.
- **Resolution:** add `react-markdown` + `remark-gfm` to deps. Bundle cost ~30 KB gzipped.
- **Edge case:** markdown content from the LLM can be hostile (XSS, prompt injection). Sanitize with `rehype-sanitize`. Do NOT use `dangerouslySetInnerHTML`.

### 3.7 React Query vs plain IPC 🟠
- axcut uses `@tanstack/react-query` extensively. OpenScreen has no React Query.
- **Resolution:** add React Query as a dependency, OR replace with `useEffect` + `useState` + an event subscription. React Query is 13 KB gzipped but adds value (caching, retries, optimistic updates). **Recommendation:** add React Query. Phase 6 (agent runtime) leans on it heavily for the message list + project snapshot queries.

### 3.8 Radix `Select` z-index 100000 vs Dialog z-index 9999 🟡
- OpenScreen's `select.tsx:86` uses z-index 100000 to sit above dialog.
- axcut's modals don't use Radix. After rewriting modals to Radix Dialog (z-index 9999), the Select z-index is correct (above dialog content but below modal backdrop is not quite right — select should close when dialog opens).
- **Resolution:** in the new Radix-backed modals, use `Dialog.Close` to dismiss on outside interaction. Select inside Dialog should work normally.

### 3.9 The `Cursor` recorder is not in axcut 🟠
- OpenScreen has cursor telemetry → editable overlay cursor in preview/export.
- axcut's `clips[]` and `skipRanges[]` don't model cursor at all. In a multi-asset timeline, when a clip replays, the cursor must replay the asset's telemetry for the clip's source-time range.
- **Resolution:** extend `axcut-schema` v3 `clipSchema` with `cursorEnabled?: boolean` (default `true` if the asset has cursor telemetry). Phase 3 (exporter) reads this and applies `getSmoothedCursorPath` per clip.
- **Edge case:** axcut's `applySkipRangesToClips` clones the clip and changes its `id` (e.g. `clip_1__skip_part_1`). The clone needs to inherit cursorEnabled.

---

## 4. Feature collisions (each phase)

### 4.1 OpenScreen-only features to preserve
- **Auto-caption annotation injection** (`annotationsFromCaptions.ts`). After Phase 4 (transcription), the renderer should write to **both** `transcripts[]` (axcut-style) **and** auto-create `AnnotationRegion[]` from the same words (OpenScreen-style). Or: pick one. **Recommendation:** drop the auto-caption annotation flow in favor of axcut's TranscriptDialog; lower-third captions are a different feature (user-added annotations), not auto-captions. Users who want captions-on-video can add them manually or via a "render captions as overlay" export preset (future).
- **3D rotation presets** (`Rotation3D`, `types.ts:34`). Stay in v3 schema.
- **GIF export** (`gifExporter.ts`). Keep; out of scope for AI-edition but harmless to preserve.
- **Native capture helpers** (Swift/CMake). Frozen; no changes.
- **Single-instance lock + tray** (`singleInstanceLock.ts`, `main.ts:304-360`). Keep.
- **Shortcuts file** (`userData/shortcuts.json`). Keep — extend for clip-dup, move-clip, etc.

### 4.2 axcut-only features to drop or rewrite
- **`worktreeService`** — drop entirely. Video projects don't need git worktrees.
- **`proxy.mp4` per asset** — axcut generates a low-res proxy during ingest for fast preview scrubbing. OpenScreen already has the streaming decoder. **Decision (locked 2026-06-25):** no proxy files; rely on `StreamingVideoDecoder` (WebCodecs) to seek the source on demand. **Known concern:** users have reported scrubbing lag on long recordings (>30 min). Documented in `ai-edition-merge-plan.md §8.1` with a revival path (per-asset "Generate proxy" button + auto-enable threshold at 30 min duration).
- **`.axcut-data/` directory tree** — replaced by `app.getPath('userData')/ai-edition/` and `app.getPath('userData')/projects/`.
- **ChatGPT device-flow OAuth** (`openai-account.ts`) — keep; it works in Electron main process.
- **GitHub Copilot token exchange** (`copilot-account.ts`) — keep.
- **`@axcut/schema` package as a separate package** — fold into `src/lib/ai-edition/schema/`. No monorepo.

### 4.3 Recording format collisions 🟠
- OpenScreen outputs: `.webm` (browser), `.mp4` (native Windows), `.mp4` + separate `.mp4` (native macOS for screen + webcam).
- axcut accepts: `.mp4, .mov, .m4v, .webm, .mkv`.
- **Resolution:** the AI-edition asset validator accepts the same set. Macos webcam `.mp4` from native recording flows in fine. Browser recording `.webm` flows in fine.

### 4.4 Cursor file sidecar format 🟠
- OpenScreen writes `<screenFileName>.session.json` (manifest) + `<screenFileName>.cursor.json` (telemetry v2 format).
- axcut doesn't know about these.
- **Resolution:** when ingesting an OpenScreen-recorded asset, copy the `.cursor.json` into `app.getPath('userData')/projects/<id>/assets/<assetId>.cursor.json` (or symlink). Reference it from `asset.cursorTelemetryPath`.

### 4.5 Webcam-as-separate-file (macOS) vs muxed (Windows) 🟠
- macOS native: screen WebM/MP4 + webcam MP4 as two separate files. `attachNativeMacWebcamRecording` (`handlers.ts:2141`) binds them into a session.
- Windows native: muxed.
- **Resolution:** an AI-edition "Recording" asset is logically one recording session that may produce two physical files (screen + webcam). Model as: `RecordingSessionAsset { screenAsset: AxcutAsset, webcamAsset?: AxcutAsset, sessionManifestPath: string }`. The composite is opaque to the timeline; the renderer/exporter reads both.
- **Edge case:** user records without webcam (browser-only or native screen-only). Webcam asset is absent. Renderer handles null.

---

## 5. Edge cases the plan didn't cover

### 5.1 Chat session per project, not global 🔴
- axcut: each project has N sessions; `projectId × sessionId` is the unit.
- OpenScreen's `currentRecordingSession` is a single value, replaced wholesale.
- **Resolution:** introduce `ai-edition:projects:list` IPC, `ai-edition:projects:set-active` to switch the active project. The Editor window always renders the active project. Chat is per-active-project.

### 5.2 What if the recording file is moved/deleted? 🟠
- axcut trusts absolute paths. If the file is moved, ops referencing `startSec/endSec` still work but rendering breaks (file not found).
- **Resolution:** on every render of VirtualPreview or export, check `await fetch(asset.originalPath)` for 200/404. On 404, show a "file missing" banner with a "Locate file" button. `electron/dialog.showOpenDialog` to pick the replacement. Update `asset.originalPath` via `updateAsset`.

### 5.3 Migration of v2 project opened in AI-edition mode, then user toggles back off 🟡
- Project is migrated to v3 on first AI-edition save. If the user toggles AI-edition off, the project has already been saved as v3. The legacy `EditorProjectData` reader can't open v3.
- **Resolution:** either (a) never migrate in place — keep a v2 copy next to v3; or (b) the legacy reader learns to read v3 and discard unknown fields. **(b)** is simpler and the right call: extend `projectPersistence.ts` `validateProjectData` to accept v3 and ignore `clips/skipRanges` etc.

### 5.4 Undo/redo across checkpoints 🟠
- OpenScreen has `useEditorHistory.ts` (80-step ring buffer) for UI-driven undo.
- axcut has `document.history.revisions[]` for full restoration.
- **Resolution:** pick one as SSOT. **Recommendation:** `revisions[]` is the SSOT. UI undo = pop the last revision, restore document. The 80-step ring buffer goes away. Existing OpenScreen undo history migrates to a single `revision` with `operations[]` of the diff (compute via `JSON.parse(JSON.stringify(prev))` for now, optimize later).

### 5.5 Auto-caption annotation regeneration after timeline edits 🟠
- OpenScreen's `captionSegmentsToAnnotationRegions` is idempotent; the editor merges new regions with existing.
- After AI-edition timeline edits (clips added, skips added), the captions are still in `transcripts[]` but the annotations are stale (referring to times that no longer exist in the timeline).
- **Resolution:** clear `annotations[]` of `annotationSource = 'auto-caption'` on any timeline op. Re-run auto-caption generation. Or: skip auto-caption entirely (recommendation in §4.1).

### 5.6 Multiple sequential recordings append to the same project 🔴
- Today: each `stopRecording` overwrites the current pointer.
- Post-merge: each stop appends to active project.
- **Edge case:** the user records take 1, takes a break, records take 2 (after pause/resume → 2 segments, 1 file) → 1 new asset, 1 new clip. Records take 3 (after switching source) → 1 new asset, 1 new clip. Project has 3 assets, 3 clips.
- **Edge case:** what if the user does NOT want to add to the current project? Need a "Save to project..." picker or "New project" button in the HUD. Today there's none.

### 5.7 Recording while a chat run is in flight 🟠
- New recording → new asset → document updates → agent's next tool call sees the new asset → op might apply to the wrong asset.
- **Resolution:** at the start of every chat turn, snapshot the document. At the end, check if any `assetId` referenced by applied ops still exists. If not, the op is dropped with a warning logged.
- Alternatively: lock the document during chat run (UI shows "Editing in progress"). **Recommendation:** snapshot + verify, not lock. Locks feel slow.

### 5.8 Provider config in env vs UI 🔴
- axcut reads env keys (`OPENAI_API_KEY` etc.) and they win over stored keys.
- OpenScreen currently has no LLM provider; doesn't matter.
- **Resolution:** port axcut's env precedence. Document in the AI-edition settings UI: "Detected OPENAI_API_KEY in environment — using that." with an option to override.

### 5.9 ChatGPT OAuth device flow in Electron 🟠
- axcut's `chat-codex-oauth.ts` uses `https://chatgpt.com/backend-api/codex/responses`. The device-flow challenge shows a code + URL the user opens in a browser.
- **Resolution:** show the code in a Radix Dialog. On completion, optionally open the URL via `electron.shell.openExternal`. Store the refresh token in `safeStorage`-encrypted JSON.
- **Edge case:** the `codex_cli_rs` originator header is hardcoded. If OpenAI rate-limits the originator, the auth still works but the chat completion fails. Need a retry + clear error.

### 5.10 Reasoning effort persistence 🟠
- axcut stores `reasoningEffort` per project.
- OpenScreen has no equivalent.
- **Resolution:** Phase 7 adds `reasoningEffort` to `UserPreferences` (global default) + `AxcutLocalConfig` (per-provider) + `AxcutDocument.export` (last-used).

### 5.11 App quit during in-flight LLM stream 🔴
- User starts chat → 30s into the LLM response → closes the window.
- axcut's Fastify stays alive; the run completes; user sees no result.
- **Resolution:** the main process `before-quit` waits up to N seconds for in-flight runs to finish (saving the final assistant message + checkpoint). After timeout, force-quit. Use Electron's `app.on('before-quit', e => e.preventDefault(); await drain(); app.quit())`.

### 5.12 Concurrent edits: agent + user 🟠
- User clicks "Add skip" while agent is mid-run.
- axcut's `DocumentService.applyOperation` reads + writes; no locking.
- **Resolution:** serialize via a per-project async lock (a simple promise chain). User ops get queued. After agent run, queued ops apply.

### 5.13 Transcript quality vs project scale 🟠
- A 1-hour screen recording × `medium` Whisper model = ~30 minutes transcription + 1.5 GB model download.
- **Resolution:** show a warning when transcription is starting on a long file. Allow cancellation (`AbortController` on the caption worker). Allow user to pick model size before transcription starts.

### 5.14 Cross-platform path handling 🟠
- axcut: pure POSIX path semantics in `paths.ts`.
- OpenScreen: Windows uses `\` or `/` depending on context. `fromFileUrl` / `toFileUrl` (`projectPersistence.ts:148-184`) handles this.
- **Resolution:** all axcut paths in `electron/ai-edition/` use Node `path.join` (already cross-platform). The renderer receives `file://` URLs via the existing pattern.

### 5.15 File watcher on `app.getPath('userData')` 🟡
- AI-edition writes to userData frequently. If a backup tool or `git init` runs in there, things break.
- **Resolution:** no fix needed; document that the userData dir is managed by Electron.

### 5.16 Schema v3 → v4 in the future 🟡
- If we change the schema again, we need migration code.
- **Resolution:** Phase 0 introduces `migrateDocument(value, fromVersion): { document: AxcutDocument, fromVersion: number }`. Set the bar for future migrations now.

---

## 6. Performance / scaling

### 6.1 VirtualPreview with many clips 🟠
- Two `<video>` layers with crossfade. For 2 clips, perfect. For 10 clips, the next clip must preload in the inactive layer. If the user seeks across 5 clips rapidly, you get 5 sequential seek+play cycles.
- **Resolution:** keep the two-layer design but add a "smart preload" — preload the next 2 clips when within 0.5s of a boundary. For 10+ clips, consider adding a single-frame "thumbnail strip" seek bar.

### 6.2 Export with mediabunny across multiple sources 🟠
- Each source clip needs a separate demuxer instance. mediabunny supports this but each demuxer has its own decoder pool.
- **Resolution:** prototype in Phase 3 PR 3.1 with a 3-clip fixture. If memory blows up (>2 GB), consider a sequential approach: render each clip to an intermediate file, then concat via `mp4box.js`.

### 6.3 Project file size 🟡
- A 5-clip project with full transcripts (each ~30 KB JSON) + zoom + annotation + cursor telemetry refs = ~500 KB JSON. Per-save JSON.stringify on 500 KB is fast but not free.
- **Resolution:** debounce saves to 250ms after last edit. Or write incrementally (only the changed slice). For Phase 0, debounce is enough.

---

## 7. Testing strategy additions

### 7.1 E2E for AI-edition happy path 🟠
- New `tests/e2e/ai-edition-happy-path.spec.ts`: launch Electron → record 5s → editor opens → add asset → trigger transcription (mock LLM) → chat "remove silences" (mock LLM) → preview → export → ffprobe the output.
- **Edge case:** ffprobe may not be on CI. Mark assertion as conditional.

### 7.2 Mock LLM responses 🟠
- axcut doesn't mock LLMs in tests (relies on canned transcripts).
- OpenScreen tests don't involve LLMs.
- **Resolution:** create a `MockChatModel` class that returns canned `AIMessage`s from fixtures. Used in agent-runtime unit tests + e2e. Lives in `electron/ai-edition/__mocks__/`.

### 7.3 SQLite migration test 🟡
- `database.ts` migrations are inline ALTER TABLEs. Need a test that creates a v1 schema, applies v2 + v3 migrations, asserts final schema.
- **Resolution:** add a `database.test.ts` that uses an in-memory `:memory:` SQLite db.

### 7.4 Cursor telemetry replay test 🟡
- A multi-clip timeline with cursor telemetry must replay the right cursor per clip's source-time range.
- **Resolution:** fixture: 3 clips × cursor telemetry. Assert: at virtual time 0:05 (inside clip 1), cursor reads from clip 1's telemetry; at virtual time 0:30 (inside clip 2), from clip 2's.

---

## 8. Phase ordering adjustments (delta from the plan)

Based on the above, two phase adjustments:

### Phase 0 needs to grow
- ✅ Schema v3 with `annotations`, `zoomRanges`, `legacyEditor`, `cursorTelemetryPath`.
- ✅ Real `migrateDocument(value, fromVersion, source)` — bidirectional v2 ↔ v3.
- ✅ Drop axcut's `transcript` (singular) field — only `transcripts[]` in v3.
- ✅ Add `clipSchema.cursorEnabled` and region `clipId?` scoping.
- ✅ `crypto.randomUUID()` for all auto-generated clip ids.

### Phase 6 (agent runtime) needs to split
- 6.1: document + chat-service + event-bus + IPC channels + SQLite (no LLM yet).
- 6.2: LLM config + provider-registry port.
- 6.3: agent-runtime + deepagent integration + streaming events + suggestion approval flow.
- 6.4: checkpoints + restore (depends on 6.1 + 6.3).

Reasoning: the streaming agent code is hard to test without a working chat pipeline underneath. Splitting lets 6.1 land first and provide the IPC contract that 6.3 builds on.

### New Phase 2.5: cursor in multi-clip
- After Phase 2 (VirtualPreview) but before Phase 3 (exporter), add cursor-aware clip playback.
- This is a small phase (~200 LOC) but important for parity with OpenScreen's existing cursor editing.

---

## 9. Locked decisions (resolved 2026-06-25)

All questions resolved with the user before Phase 0. Decisions are also recorded in `ai-edition-merge-plan.md §5`.

1. **Stop behavior** — ✅ first recording = auto-open (current behavior); second-and-later recordings in an active AI-edition project = stay-in-recorder with "Open editor / Record another" prompt. Preserves existing UX for users who don't use AI Edition. Decision §3.1.
2. **Auto-caption annotations** — ✅ drop entirely. AI-edition's transcript is richer; users add overlay annotations manually if needed. Decision §4.1.
3. **React Query** — ✅ add `@tanstack/react-query` as a dependency. Phase 6 leans on it. Decision §3.7.
4. **Credential storage** — ✅ use Electron's `safeStorage` (OS keychain). Plain JSON is a security regression. Decision §2.5.
5. **Whisper model default** — ✅ bundle OpenScreen's existing smaller model. Add a "Transcription model" picker in settings with download size + speed hints; user opts into larger. Decision §2.1 + §5.13.
6. **Proxy MP4 generation** — ✅ drop. Rely on `StreamingVideoDecoder`. **Documented limitation:** users have reported scrubbing lag on long recordings (>30 min). Revival path in `ai-edition-merge-plan.md §8.1`. Decision §4.2.
7. **File extension** — ✅ keep `.openscreen`. No rename. Decision §3 of the merge plan + §6.3.
8. **Repository / packaging model** — ✅ **single package, in-tree.** AI-edition lives inside the openscreen repo at `src/lib/ai-edition/`, `electron/ai-edition/`, `src/components/ai-edition/`, `src/i18n/locales/<locale>/ai-edition.*`. One `package.json`, one CI, one release. No monorepo, no separate npm package, no separate repo. Decision §4.2 + §6 of the merge plan.

---

## 10. Summary of deltas to the original plan

| Original plan | This analysis recommends | Why |
|---|---|---|
| Phase 0: vendor schema, add v3 fields | Phase 0+: real `migrateDocument`, drop primary transcript field, add `clipId?` scoping | The original was too light on migration; primary transcript is lossy. |
| Phase 1: 3 PRs | Phase 1: 3 PRs as planned | Same. |
| Phase 2: VirtualPreview | Phase 2 + 2.5: VirtualPreview + cursor-aware playback | Cursor in multi-clip is a small but important addition. |
| Phase 3: Exporter | Phase 3: as planned, with explicit perf testing on 3-clip fixture | Same. |
| Phase 4: Transcription | Phase 4: as planned + drop auto-caption annotation flow | Auto-caption collides with axcut's transcript model. |
| Phase 5: Recorder preservation | Phase 5: as planned, with the "first recording auto-opens editor" carve-out | Preserves existing UX. |
| Phase 6: Agent runtime (2 PRs) | Phase 6: split into 6.1/6.2/6.3/6.4 | Testability + ordering. |
| Phase 7: Providers | Phase 7: as planned + `safeStorage` | Security. |
| Phase 8: History + checkpoints | Phase 8: as planned + revisions become the SSOT (replace useEditorHistory) | Single source of truth. |
| Phase 9: Polish | Phase 9: as planned + add `ai-edition.*` i18n namespaces | i18n. |
| Phase 10: Cut-over | Phase 10: as planned | Same. |