# AI-Edition Handover — opencode coding agent

**Date**: 2026-06-29
**Branch**: `docs/ai-edition-plan` (commit parent `cf25858`)
**Dev server**: `http://localhost:5173/?windowType=editor` (browser mode with shim)
**Worktree**: `C:\Users\etien\.local\share\opencode\worktree\860f8cb1426d647abeba0cc732d7de1694294ae9\mighty-falcon`

---

## 1. What this is

OpenScreen (free, open-source screen recorder + video editor, Electron + React + Pixi.js) is being merged with Axcut (AI-powered video editor) to create a unified editing experience. The new editor is **default for all users** — no kill switch. AI features (LLM chat) are opt-in via `AI_FEATURES_ENABLED` flag in `src/components/video-editor/featureFlags.ts`.

This handover covers **what's been implemented in the current session** (UI redesign + feature wiring) and **what remains to be connected**.

The canonical design reference is `design/openscreen-editor.html` (4686-line static HTML). The behavior specs are `docs/openscreen-ux-ui-spec.md` (legacy OpenScreen features) and `docs/axcut-ux-ui-spec.md` (Axcut features).

---

## 2. Start here

```bash
cd C:\Users\etien\.local\share\opencode\worktree\860f8cb1426d647abeba0cc732d7de1694294ae9\mighty-falcon
npm install                           # Node 22, npm 10
npm run dev                           # http://localhost:5173/?windowType=editor
# In browser: http://localhost:5173/?windowType=editor
```

The app runs in browser mode (no Electron needed) — shims are auto-installed via `installBrowserShims()` in `src/App.tsx:4`. Projects persist in `localStorage`.

**Verify**:
```bash
npx tsc --noEmit                     # typecheck
npm run lint                          # 367 files, clean
npm run test                          # 353 tests, 44 test files
```

---

## 3. Architecture map

```text
src/
├── styles/
│   └── design-tokens.css              # light + dark CSS vars (:root / :root[data-theme="dark"])
├── hooks/
│   └── useTheme.ts                    # light/dark toggle, persisted in localStorage
├── App.tsx                            # imports design-tokens.css, installs browser shims
├── components/ai-edition/
│   ├── NewEditorShell.tsx             # TOP-LEVEL: 4-row grid, all state, IPC handlers
│   ├── NewEditorShell.module.css      # layout (titlebar 34px / workbench 7-col / handle / bottombar)
│   ├── Titlebar.tsx                   # brand, rename, save, open/new, lang, recorder, panel toggles, theme
│   ├── Bottombar.tsx                  # view-tools (zoom/trim/annot/speed) + 3 lane rows + TimelinePane + zoombar
│   ├── Preview.tsx                    # preview frame + PIP placeholder + transport (play/prev/next/loop/fullscreen/REC)
│   ├── LeftPanel.tsx                  # left rail (Chat/Media) + MediaPane + ChatStripPanel + ChatHistoryModal
│   ├── RightPanelStack.tsx            # right panel container + RegionInspector when a region is selected
│   ├── RightPanes.tsx                 # 6 individual panes: Background, Transcript, Video Effects, Layout, Cursor, Timeline
│   ├── Modals.tsx                     # all modals: ModalShell, OpenProject, NewProject, Crop, UnsavedChanges,
│   │                                  #   AutoCaptions, InsertSource, SourceTranscript, ChatHistory
│   ├── ExportDialog.tsx               # MP4 (720/1080/Source) + GIF (FPS/Size/Loop) + progress + write to disk
│   ├── ProviderSettings.tsx           # 8-provider grid → form (API key/model/baseUrl/reasoning) → save/disconnect
│   ├── VirtualPreview.tsx             # single-video preview component (ported from axcut)
│   ├── TimelinePane.tsx              # 837-line timeline: ruler, clips, skip strips, navigator (ported from axcut)
│   ├── TranscriptEditor.tsx           # click-word → seek, shift-click-range → "Cut" button, strikethrough
│   ├── ProjectPanel.tsx              # OLD project picker (kept for reference, not used in the new layout)
│   ├── ChatPanel.tsx                 # OLD chat panel (replaced by ChatStripPanel in LeftPanel)
│   └── AiEditionShell.tsx            # lazy-load entrypoint
│
├── lib/ai-edition/
│   ├── schema/index.ts                # v3 AxcutDocument schema (zod)
│   ├── document/
│   │   ├── timeline.ts                # pure interval math: normalizeIntervals, subtractInterval, etc.
│   │   ├── migrate.ts                 # v2 EditorProjectData ↔ v3 AxcutDocument (bidirectional)
│   │   ├── transcribe.ts              # wraps existing captioning pipeline
│   │   └── ids.ts                     # createId(prefix) → uuid
│   ├── store/
│   │   ├── projectStore.ts            # Zustand: projectId, document, dirty, lastSavedAt, IPC-backed mutations
│   │   ├── editorSettings.ts          # pure get/patch over document.legacyEditor (typed, type-guarded)
│   │   ├── editorSettings.test.ts     # 8 tests
│   │   ├── useEditorSettings.ts       # React hook: set(patch) → save, setLive(patch) → preview
│   │   └── useTimeline.ts             # React hook: addZoom/Skip/Annotation/Speed, addClipBefore/After, splitAndInsert, selection
│   ├── exporter/
│   │   └── documentExporter.ts        # AxcutDocument → VideoExporterConfig / GifExporterConfig
│   └── timeline/
│       └── virtual-preview.ts         # pure time-mapping: totalVirtualDuration, locateVirtualPosition, etc.
│
├── lib/captioning/                    # EXISTING OpenScreen captioning pipeline (used by auto-captions)
│   ├── annotationsFromCaptions.ts     # captionSegmentsToAnnotationRegions(segments, id, z, layout)
│   ├── transcribe.ts                  # transcribeMono16kToSegments (local Whisper)
│   └── ...
│
└── native/
    ├── browserShim.ts                 # auto-installs stubs for window.electronAPI + nativeBridgeClient in browser
    ├── client.ts                      # nativeBridgeClient with aiEdition, project, cursor domains
    └── contracts.ts                   # TypeScript types for the IPC bridge

electron/
├── ai-edition/
│   ├── document-service.ts            # CRUD on .axcut JSON files under userData/projects/
│   ├── chat-service.ts               # in-memory chat, real LLM call via llm-call.ts
│   ├── llm-call.ts                   # NEW: fetch-based LLM call (OpenAI-compat + Anthropic, no LangChain dep)
│   ├── llm-config-store.ts           # credentials in safeStorage, config in plain JSON
│   └── provider-registry.ts          # 8 provider definitions (static)
└── native-bridge/services/
    └── aiEditionService.ts           # wraps DocumentService + LlmConfigStore into IPC

design/
├── openscreen-editor.html            # CANONICAL design reference (4686 lines, light + dark)
└── DESIGN.md                         # design system documentation
```

---

## 4. Deleted files (confirm before cleaning)

| File | Why |
|---|---|
| `src/components/ai-edition/IconRail.tsx` | Replaced by `LeftPanel.tsx::LeftRail` |
| `src/components/ai-edition/EditorSettings.tsx` | Bridge to legacy SettingsPanel — removed; new panes use `useEditorSettings` directly |

---

## 5. Features fully wired (click → data → persisted)

### 5.1 Titlebar

| Control | Action | File |
|---|---|---|
| Project name | Click → inline edit → Enter/Esc/Blur → `saveDocument` with renamed title | `Titlebar.tsx:423` |
| Language picker | Click language → `useI18n().setLocale(code)` → i18n locale changes + persisted | `Titlebar.tsx:353` |
| Save button + dropdown | Save → `saveDocument(doc)`, Save As → `window.prompt(rename)` + `saveDocument` | `Titlebar.tsx:220`, `NewEditorShell.tsx:254` |
| Open/New project | Open modal → select/create → `loadProject`/`createProject` | `Modals.tsx` |
| New Recording | `promptUnsaved("record")` → `startNewRecording()` | `NewEditorShell.tsx:360` |
| Return to recorder | `switchToHud()` | `NewEditorShell.tsx:372` |
| Export | Opens `ExportDialog` (MP4 720/1080/Source + GIF FPS/Size/Loop) | `NewEditorShell.tsx:376` |
| Panel toggles (left/right/timeline) | Toggle CSS vars `--panel-w-left/right/bottom` via `data-collapse` | `NewEditorShell.tsx` |
| Theme toggle | `useTheme().toggle()` → `data-theme="dark"` on `:root`, persisted | `Titlebar.tsx`, `useTheme.ts` |
| Dirty status | `dirty` bool + `lastSavedAt` timestamp in Zustand store | `projectStore.ts` |
| WebkitAppRegion | `drag` on titlebar, `no-drag` on buttons | `NewEditorShell.module.css:39` |

### 5.2 Bottombar (view-tools + lanes)

| Button | Action | File |
|---|---|---|
| Zoom (+) | `addZoom()` → 2s region at playhead in `document.zoomRanges[]` | `Bottombar.tsx`, `useTimeline.ts` |
| Auto-focus | Toggle → `set({ autoFocusAll })` | `Bottombar.tsx` |
| Trim (scissors) | `addSkip()` → 2s skip at playhead in `document.timeline.skipRanges[]` | `Bottombar.tsx`, `useTimeline.ts` |
| Annotation | `addAnnotation()` → 2s annotation at playhead in `document.annotations[]` | `Bottombar.tsx`, `useTimeline.ts` |
| Speed | `addSpeed()` → 2s region at playhead in `legacyEditor.speedRegions[]` | `Bottombar.tsx`, `useTimeline.ts` |
| Captions | Opens `AutoCaptionsModal` → `captionSegmentsToAnnotationRegions()` → regenerated `annotations[]` | `NewEditorShell.tsx` |
| Aspect ratio | Dropdown wired to `set({ aspectRatio })` → persisted in `legacyEditor` | `Bottombar.tsx` |
| **3 lane rows** (Zoom/Annotation/Speed) | Pill per region, click → select, × button → delete | `Bottombar.tsx:306` |
| **Region inspector** | When selected → right panel shows depth buttons (zoom), text area (annotation), speed label, delete | `RightPanelStack.tsx:118` |

### 5.3 Right panes (Background/Effects/Layout/Cursor/Timeline)

All writable via `useEditorSettings` → `editorSettings.ts` pure functions → `legacyEditor` envelope:

| Pane | Control | Field |
|---|---|---|
| Background | 16 thumbnails / 25 gradients | `wallpaper` |
| Video Effects | Toggle + 4 sliders | `showBlur`, `motionBlurAmount`, `shadowIntensity`, `borderRadius`, `padding` |
| Layout | Preset select + toggles + shape + slider | `webcamLayoutPreset`, `webcamMaskShape`, `webcamMirrored`, `webcamReactiveZoom`, `webcamSizePreset` |
| Cursor | Toggles + 5 styles + 4 sliders | `cursorShow`, `cursor.clipToBounds`, `cursorTheme`, `cursor.size/smoothing/motionBlur/clickBounce` |
| Timeline | Toggle waveform | `showTrimWaveform` |

### 5.4 Preview + playback

| Control | Action | File |
|---|---|---|
| Play/pause | Toggle `video.play()`/`pause()` (also `Space` global) | `Preview.tsx` |
| Prev/Next clip | Seek to boundary of previous/next timeline clip | `Preview.tsx:82,94` |
| Loop | `videoElement.loop = true/false` | `Preview.tsx:106` |
| Fullscreen | `requestFullscreen()` on video parent | `Preview.tsx` |
| Time display | `formatTC(currentTimeSec)` / `formatTC(sourceDurationSec)` | `Preview.tsx` |
| REC button | Toggle play (placeholder for real recording) | `Preview.tsx` |

### 5.5 Chat (left rail, gated by `AI_FEATURES_ENABLED`)

| Feature | Status | File |
|---|---|---|
| Send message | `chatRun(projectId, text)` → real fetch LLM call (OpenAI compat + Anthropic) | `LeftPanel.tsx:288` |
| Message bubbles | Role (You/OpenScreen) + time + content | `LeftPanel.tsx` |
| Model picker | Cycles through 3 alternatives (visual placeholder, no model switch) | `LeftPanel.tsx:332` |
| Reasoning pill | Shows active reasoning effort level | `LeftPanel.tsx:338` |
| Provider Settings gear | Opens `ProviderSettings` modal → 8 providers → form (API key/model/baseUrl/reasoning) → save/disconnect | `LeftPanel.tsx`, `ProviderSettings.tsx` |
| History button | Opens `ChatHistoryModal` (1 session for now, in-memory) | `LeftPanel.tsx` |
| New chat | Clears messages, increments session counter | `LeftPanel.tsx:324` |
| Context pill | "0% context" (static, no real token tracking) | `LeftPanel.tsx:353` |

### 5.6 Multi-clip + Insert Source

| Feature | Action | File |
|---|---|---|
| Drag media card | `dragstart` sets `dataTransfer` with `assetId` | `LeftPanel.tsx:70` |
| Drop on timeline | Opens `InsertSourceModal` with 3 choices | `NewEditorShell.tsx:385`, `NewEditorShell.tsx:600` |
| Add before | `addClipBefore(assetId)` → shifts all clips forward | `useTimeline.ts:173` |
| Add after | `addClipAfter(assetId)` → appends clip at end | `useTimeline.ts:196` |
| Split and insert | `splitAndInsert(assetId, splitTime)` → splits target clip, inserts between halves | `useTimeline.ts:219` |

### 5.7 Keyboard shortcuts

| Key | Action | File |
|---|---|---|
| `Cmd+S` | Save document | `NewEditorShell.tsx:446` |
| `Cmd+N` | New project (with unsaved prompt) | `NewEditorShell.tsx:452` |
| `Cmd+O` | Open project (with unsaved prompt) | `NewEditorShell.tsx:464` |
| `Space` | Play/pause video | `NewEditorShell.tsx:477` |
| `Z` | Add zoom region | `NewEditorShell.tsx:535` |
| `T` | Add trim/skip region | `NewEditorShell.tsx:545` |
| `A` | Add annotation | `NewEditorShell.tsx:549` |
| `S` | Add speed region | `NewEditorShell.tsx:553` |
| `Del / Backspace` | Remove selected region | `NewEditorShell.tsx:488` |

### 5.8 Backend (Electron main process)

| Feature | Status | File |
|---|---|---|
| 8 provider definitions | Static, fully defined | `electron/ai-edition/provider-registry.ts` |
| LLM config store | `safeStorage` encrypted credentials, plain JSON config | `electron/ai-edition/llm-config-store.ts` |
| LLM call (fetch-based) | OpenAI compat `POST /chat/completions` + Anthropic `POST /messages`, no LangChain | `electron/ai-edition/llm-call.ts` |
| Chat service | In-memory per-project message store, uses real LLM call | `electron/ai-edition/chat-service.ts` |
| Document service | CRUD on `.axcut` JSON files under `userData/projects/` | `electron/ai-edition/document-service.ts` |
| IPC bridge | `aiEdition` domain with `document.*`, `llm.*`, `chat.*` actions | `electron/native-bridge/services/aiEditionService.ts` |

---

## 6. Remaining items — exhaustive list

### 6.1 High priority — functionality gaps

| # | Feature | What's missing | Spec section | Files to touch |
|---|---|---|---|---|
| 1 | **Auto captions when no transcript** | If the user hasn't transcribed yet, the "Captions" button just shows a toast. It should trigger `transcribeAsset` automatically before calling `captionSegmentsToAnnotationRegions`. | OpenScreen §5.6 | `NewEditorShell.tsx:handleGenerateCaptions` |
| 2 | **Playback scrub slider** | The transport bar shows time but has no range input. The design's transport has a progress bar. | Design HTML: `.transport` | `Preview.tsx` |
| 3 | **Timeline playhead scrub** | Click/drag on the ruler → preview seeks. The existing `TimelinePane` has this, but it's not exposed to the Preview component. | OpenScreen §5.5.4 | `TimelinePane.tsx`, `Bottombar.tsx` |
| 4 | **Source Transcript modal — real data** | Currently `transcriptText` is always `null`. Should show `document.transcript` text content. | Axcut §9.4 | `LeftPanel.tsx`, `Modals.tsx` |
| 5 | **UnsavedChangesDialog on Cmd+W (close window)** | Only wired for `New Recording`. Missing for close. Needs `window.onbeforeunload` or `electronAPI`. | OpenScreen §5.9 | `NewEditorShell.tsx` |
| 6 | **Region inspector — persist depth/text** | The zoom depth buttons and annotation textarea update local state but don't call `saveDocument`. | OpenScreen §5.5.3 | `RightPanelStack.tsx:RegionInspector` |
| 7 | **Media file 4-state indicator** | The dot on media cards is always green. Should reflect transcript status (pend/run/complete/fail). | Axcut §4.2 | `LeftPanel.tsx:MediaList` |
| 8 | **Per-file transcript availability check** | The `SourceTranscriptModal` should show the transcript if available. Currently always "Not generated yet". | Axcut §9.4 | `LeftPanel.tsx`, `Modals.tsx` |

### 6.2 Medium priority — visual polish

| # | Feature | What's missing | Spec section | Files to touch |
|---|---|---|---|---|
| 9 | **Canvas preview rendering** (wallpaper, shadow, border-radius, crop, webcam PiP, cursor, zoom, annotations) | The export pipeline renders all of these via Pixi.js, but the live preview doesn't show them. The `VirtualPreview` is a plain `<video>` tag. | OpenScreen §5.5.1 | `Preview.tsx`, `VirtualPreview.tsx`, or a new Pixi overlay |
| 10 | **Live-run feed** (Thinking/Operation/Draft cards) | During LLM call, there's no intermediate feedback. The assistant's message appears all at once. | Axcut §5.3 | `LeftPanel.tsx:ChatStripPanel` |
| 11 | **Status chips** (Transcription `idle|running|ready|error`, Export `idle|running|ready|error`) | No job queue → no status chips. These would appear in the project panel or as a floating pill. | Axcut §10.1 | New component or `LeftPanel.tsx` |
| 12 | **Region shape customization** (crop frame resize, annotation position/size/style) | The region inspector shows basic controls but not: arrow direction, figure color, blur shape/color/mosaic, annotation font family/size/animation, etc. | OpenScreen §5.5.3 | `RightPanelStack.tsx:RegionInspector` |
| 13 | **i18n on new components** | All strings in `Titlebar.tsx`, `Bottombar.tsx`, `LeftPanel.tsx`, `RightPanes.tsx`, `Modals.tsx`, etc. are hardcoded English. The 13 locale files exist under `src/i18n/locales/<locale>/` but the new components don't use `useScopedT`. | Spec §8 | All `src/components/ai-edition/*.tsx` |
| 14 | **Edit Clip modal** | The pencil icon on track blocks (design HTML) doesn't exist in the current `TimelinePane`. Need a modal to edit `sourceStartSec`/`sourceEndSec`. | Axcut §8.5, OpenScreen §5.5.4 | New modal in `Modals.tsx` + `TimelinePane.tsx` |
| 15 | **Per-region Copy/Paste** (Cmd+C/V between regions) | `regionClipboard.ts` exists in the legacy editor but isn't wired in the new shell. | OpenScreen §5.10 | `NewEditorShell.tsx` + new clipboard hook |
| 16 | **Conversation History — multiple sessions** | Currently 1 session only (stored messages + session counter). No backend session management. | Axcut §9.2 + §11 | `electron/ai-edition/chat-service.ts` (needs sessions) |

### 6.3 Lower priority — backend features

| # | Feature | What's missing | Spec section | Files to touch |
|---|---|---|---|---|
| 17 | **OAuth device flow** (ChatGPT/GitHub Copilot) | Currently returns "not implemented yet". Needs token endpoint polling + device code UI. | Axcut §12 | `electron/ai-edition/llm-call.ts`, `ProviderSettings.tsx` |
| 18 | **Reconnect banner** on Provider Settings when API key expires | No `provider_auth_expired` event → no banner. | Axcut §12 | `ProviderSettings.tsx` |
| 19 | **SSE streaming** for project changes | The old Axcut app used `/api/projects/:id/stream` for live updates. Not needed in single-user Electron, but could improve reactivity. | Axcut §15 | Not urgent |
| 20 | **SQLite sessions/checkpoints** | Chat history is in-memory (lost on restart). Axcut used `better-sqlite3` + `PersistentFileCheckpointSaver`. | Axcut §14 | `electron/ai-edition/chat-service.ts` |
| 21 | **Conversation History** with rename/delete | Basic modal exists, but only 1 session, no rename, no delete. | Axcut §9.2 | `Modals.tsx:ChatHistoryModal` |
| 22 | **Undo/redo** (Cmd+Z, Cmd+Shift+Z) | The keyboard handler skips Cmd+Z. No undo stack exists in the store. | OpenScreen §5.10 | `projectStore.ts` (needs undo stack) |

### 6.4 Missing OpenScreen features from the old editor

| # | Feature | What's missing | Spec section |
|---|---|---|---|
| 23 | **EditorEmptyState** (logo + import video + load project + drag & drop overlay + supported formats) | The new editor shows a simple text placeholder, not the full dashboard. | OpenScreen §5.4 |
| 24 | **Drag and drop `.openscreen` file** on the empty state | Handler missing. | OpenScreen §5.4 |
| 25 | **ShortcutsConfigDialog** (customizable shortcuts) | Loaded in `App.tsx` via lazy import, but never shown. No "customise shortcuts" button. | OpenScreen §5.10 |
| 26 | **Annotations settings panel** (Text/Image/Arrow tabs, font family/size/color/animation, custom fonts, duplicate) | The new editor has no annotation settings panel. The legacy `AnnotationSettingsPanel` exists but isn't wired. | OpenScreen §5.5.3 |
| 27 | **Blur settings panel** (shape/color/mosaic size) | Not wired. | OpenScreen §5.5.3 |
| 28 | **Auto-zoom (wand) suggestions** | The wand button in the bottombar is disabled. The legacy editor's `auto-suggest zone` feature isn't ported. | OpenScreen §5.5.4 |
| 29 | **Webcam PIP real-time preview** | The preview shows a placeholder "Webcam" div. No real webcam layer. | OpenScreen §5.5.1 |
| 30 | **Cursor rendering** (theme art, smoothing, motion blur, click bounce) | Not rendered in the preview. The legacy `cursorRenderer.ts` handles it. | OpenScreen §5.5.1 |

---

## 7. State management summary

### Zustand store (`src/lib/ai-edition/store/projectStore.ts`)
```ts
{
  projectId: string | null,
  document: AxcutDocument | null,
  revision: number,
  dirty: boolean,         // true when setDocument() was called without saveDocument()
  lastSavedAt: Date | null, // timestamp of last successful saveDocument()
  // Actions: loadProject, createProject, saveDocument, setDocument, addAsset,
  //          removeAsset, replaceTimeline, restoreFullTimeline, setTranscript,
  //          markClean, clear
}
```

### Editor settings (`src/lib/ai-edition/store/editorSettings.ts`)
- `getEditorSettings(doc) → EditorSettingsSnapshot` (typed, type-guarded)
- `patchEditorSettings(doc, patch) → AxcutDocument` (immutable)

### Hook layer (`src/lib/ai-edition/store/useEditorSettings.ts`)
- `set(patch)` → `setDocument` + `saveDocument` (commit)
- `setLive(patch)` → `setDocument` only (preview, no persist)
- `commit()` → `saveDocument` (flush)

### Timeline hook (`src/lib/ai-edition/store/useTimeline.ts`)
- Region CRUD: `addZoom`, `addSkip`, `addAnnotation`, `addSpeed`, `removeRegion`
- Clip operations: `addClipBefore`, `addClipAfter`, `splitAndInsert`
- Selection: `selectRegion(kind, id)`, `clearSelection()`, `selection: { kind, id }`

---

## 8. Data flow — how a click hits the document

```text
User clicks "Add zoom" in Bottombar
  → Bottombar calls tl.addZoom()                 [useTimeline.ts]
    → useTimeline reads currentTimeSec from store [projectStore.ts]
    → Creates a ZoomRegion at playhead
    → Calls saveDocument(next)                    [projectStore.ts]
      → nativeBridgeClient.aiEdition.save(doc)    [client.ts]
        → IPC → aiEditionService                  [electron/native-bridge/]
          → DocumentService.saveProject           [electron/ai-edition/document-service.ts]
            → writes .axcut JSON to disk
      → set({ document: parsed, dirty: false, lastSavedAt: now })

React re-renders:
  → Bottombar reads updated zoomRegions
  → Timeline lanes show new pill
  → User clicks pill → selectRegion("zoom", id)
  → RightPanelStack sees selection → shows RegionInspector
  → User clicks depth button → updates zoomRegion.depth → setDocument() → saves
```

---

## 9. Dev server quick-ref

```bash
# Start (from worktree root)
npm run dev
# Opens at http://localhost:5173/?windowType=editor

# Stop
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*vite*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# Logs
Get-Content "$env:TEMP\openscreen-dev.err" -Tail 20
Get-Content "$env:TEMP\openscreen-dev.out" -Tail 20
```

The shim in `src/native/browserShim.ts` auto-installs when `window.electronAPI` is absent. Projects are stored in `localStorage["browser-shim-document"]`. To clear: `localStorage.clear()` in the browser console.

---

## 10. Known rough edges

1. **`useExhaustiveDependencies` warning** on the keyboard shortcut `useEffect` in `NewEditorShell.tsx:466` — intentional (the handler is registered once, not on every state change).
2. **Zoom region timing**: zoom/annotation/speed use **ms** units (`startMs`/`endMs`), but skip/clip use **seconds**. Handled in `useTimeline.ts` by multiplying `currentTimeSec * 1000`.
3. **`legacyEditor` is loosely typed** — `Record<string, unknown>` in the schema. The `editorSettings.ts` module provides typed accessors, but if a v2 `.openscreen` project has unexpected shapes, they'll fall back to defaults.
4. **Browser shim doesn't persist** to disk — `saveDocument` writes to `localStorage` only. Real Electron writes to `.axcut` files.
5. **No Electron window open** in dev mode — the renderer renders in a browser tab without the native recorder/export pipeline. For export testing, use the SourceTranscript dummy or wait for Electron.

---

## 11. Suggested first actions for the next agent

1. `npm run dev` → open `http://localhost:5173/?windowType=editor` → create a project → add a video → explore all the wired features
2. Fix item #1 (auto-Transcribe before captions) — it's a 3-line change in `handleGenerateCaptions`
3. Fix item #6 (region inspector persist) — add `saveDocument` call after depth/text edits
4. Fix item #8 (source transcript modal data) — wire `document.transcript` to the modal
5. Fix item #12 (region inspector customization) — expand `RegionInspector` in `RightPanelStack.tsx` to include: annotation font/color/size, arrow direction, blur shape/color, zoom focus X/Y
6. Pick up items #13–#16 for visual polish
7. If Electron build is needed: `npm run build` (typecheck + Vite + electron-builder)
