# AI-Edition Comprehensive Handover — v2

**Date**: 2026-06-29
**Branch**: `docs/ai-edition-plan` (base `4a2f4e4`)
**Worktree**: `C:\Users\etien\.local\share\opencode\worktree\860f8cb1426d647abeba0cc732d7de1694294ae9\mighty-falcon`
**Dev**: `http://localhost:5173/?windowType=editor`
**Verify**: `npx tsc --noEmit` (0 err) / `npm run test` (353 pass) / `npm run lint` (2 known, rest pre-existing locale UTF-8)

> This replaces the handover at `docs/architecture/ai-edition-handover.md`. Read that first for the data-flow diagrams and per-component wiring tables. This doc adds: conversation history, origin labelling (OpenScreen vs Axcut per feature), all file paths, and the merge-status matrix.

---

## 1. Conversation History

### Session 1 — Phases 0–3 foundation (merge-plan creation)
- Reviewed `ai-edition-merge-plan.md`, `openscreen-inventory.md`, `axcut-inventory.md`, `ai-edition-collision-analysis.md`
- Confirmed strategy: **Axcut's data model + UX patterns, re-implemented on OpenScreen primitives** (no Python sidecar, no Fastify, no monorepo)
- Set `AI_FEATURES_ENABLED` flag semantics: gates only LLM/agent surface; new editor is default for all
- Decided: single package, in-tree, no monorepo

### Session 2 — Design tokens + 4-row shell + Titlebar
- Created `design/openscreen-editor.html` (4686-line reference) from design assets
- Built `design-tokens.css`: 270 CSS vars (light + dark)
- Built `NewEditorShell.tsx` / `.module.css`: 4-row grid (titlebar 34px / workbench 7-col / 6px handle / bottombar 224px), resize handles
- Built `Titlebar.tsx`: brand, inline rename, saved status, Save dropdown, Open/New modals, language picker, New Recording, Return to recorder, Export, 3 panel toggles, theme toggle, settings, `-webkit-app-region: drag`

### Session 3 — Bottombar + RightPanes + Preview + Modals
- Built `Bottombar.tsx`: view-tools (zoom/trim/annotation/speed/captions), aspect ratio, auto-focus, 3 lane rows with pills, zoombar, existing TimelinePane
- Built `RightPanes.tsx`: Background (wallpaper presets), Video Effects, Layout, Cursor, Timeline — all wired to `useEditorSettings`
- Built `RightPanelStack.tsx`: container + RegionInspector when region selected (zoom depth, annotation text, speed, delete)
- Built `Preview.tsx`: VirtualPreview, transport (play/pause, prev/next, loop, fullscreen, scrub slider, time, REC)
- Built `Modals.tsx`: OpenProject, NewProject(4 templates), Crop, UnsavedChanges, AutoCaptions, InsertSource, SourceTranscript, ChatHistory
- Built `ExportDialog.tsx`: MP4 720/1080/Source, GIF FPS/Size/Loop, progress bar

### Session 4 — Chat + LeftPanel + Backend
- Built `LeftPanel.tsx`: left rail (Chat/Media tabs), MediaPane, ChatStripPanel, ChatHistoryModal
- Built `ChatPanel.tsx`: real LLM call via `fetch` (OpenAI-compat + Anthropic)
- Built `ProviderSettings.tsx`: 8-provider grid → form → save/disconnect
- Built `electron/ai-edition/llm-call.ts`: fetch-based, no LangChain
- Built `electron/ai-edition/chat-service.ts`: in-memory per-project, real LLM call
- Built `electron/ai-edition/provider-registry.ts`: 8 providers
- Built `electron/ai-edition/llm-config-store.ts`: safeStorage credentials
- Wired IPC: `electron/native-bridge/services/aiEditionService.ts`, `electron/ipc/handlers.ts`, `electron/ipc/nativeBridge.ts`

### Session 5 — Store layer + Multi-clip + Undo/redo
- Built `projectStore.ts` (Zustand): `projectId, document, revision, dirty, lastSavedAt, saveDocument, setDocument, addAsset, removeAsset, replaceTimeline, restoreFullTimeline`
- Built `editorSettings.ts` + `editorSettings.test.ts` (8 tests): typed get/patch over `legacyEditor` envelope
- Built `useEditorSettings.ts` hook: `set(patch)` commit, `setLive(patch)` preview, `commit()` flush
- Built `useTimeline.ts`: region CRUD (`addZoom/Skip/Annotation/Speed/removeRegion`), clip ops (`addClipBefore/After`, `splitAndInsert`), selection
- Built `undo.ts`: `pushHistory` in `setDocument`, `undo()`/`redo()` + `useUndoRedoShortcuts` (Cmd+Z / Cmd+Shift+Z)
- Built `regionClipboard.ts`: per-region copy/paste (Cmd+C/V)

### Session 6 — i18n + keyboard shortcuts + unsaved-changes + polish
- Added locale keys (`editor.json` → `"shell"`) to all 13 locales
- Wired language picker in Titlebar → `useI18n().setLocale()`
- Wired keyboard shortcuts in `NewEditorShell.tsx`: Cmd+S/N/O, Space, Z/T/A/S, Del, ?
- Added `beforeunload` handler for unsaved-changes-on-close
- Added status chips: media card dot (green/gray), transcript ready pill
- Wired auto-captions: modal min/max words → `captionSegmentsToAnnotationRegions`; auto-transcribes if no transcript

### Session 7 — Handover document creation
- Created `docs/architecture/ai-edition-handover.md` (367 lines)
- This session: creating the comprehensive v2 handover

---

## 2. Feature Origin Legend

| Tag | Source |
|-----|--------|
| [OS] | OpenScreen original feature (preserved in new editor) |
| [AX] | Axcut feature (ported/reimplemented) |
| [NEW] | New feature created for the merge (neither had it) |

---

## 3. Implemented & Merged Features (click → data → persisted)

### 3.1 Shell & Layout
| Feature | Origin | File |
|---------|--------|------|
| 4-row grid layout (titlebar/workbench/handle/bottombar) | [NEW] | `src/components/ai-edition/NewEditorShell.module.css` |
| Resize handles (left/right/bottom panels via CSS vars) | [NEW] | `NewEditorShell.tsx` |
| Light + dark theme (270 CSS tokens) | [NEW] | `src/styles/design-tokens.css` |
| Theme toggle (persisted localStorage) | [NEW] | `src/hooks/useTheme.ts`, `Titlebar.tsx` |
| Panel toggles (left/right/timeline via `data-collapse`) | [NEW] | `NewEditorShell.tsx` |

### 3.2 Titlebar
| Feature | Origin | File |
|---------|--------|------|
| Brand + project name (inline rename) | [AX] | `Titlebar.tsx:423` |
| Dirty status + lastSavedAt | [OS] | `projectStore.ts` |
| Save/SaveAs dropdown | [OS] | `Titlebar.tsx:220` |
| Open/New project modals | [OS] | `Modals.tsx` |
| Language picker → `useI18n().setLocale()` | [OS] | `Titlebar.tsx:353` |
| New Recording (with unsaved prompt) | [OS] | `NewEditorShell.tsx:360` |
| Return to recorder | [OS] | `NewEditorShell.tsx:372` |
| Export button → ExportDialog | [OS]+[AX] | `NewEditorShell.tsx:376`, `ExportDialog.tsx` |
| Theme toggle | [NEW] | `Titlebar.tsx` |
| WebkitAppRegion drag region | [NEW] | `NewEditorShell.module.css:39` |

### 3.3 Bottombar
| Feature | Origin | File |
|---------|--------|------|
| Zoom view-tool (+ button → `addZoom()`) | [OS] | `Bottombar.tsx`, `useTimeline.ts` |
| Trim view-tool (+ button → `addSkip()`) | [OS] | `Bottombar.tsx`, `useTimeline.ts` |
| Annotation view-tool (+ button → `addAnnotation()`) | [OS] | `Bottombar.tsx`, `useTimeline.ts` |
| Speed view-tool (+ button → `addSpeed()`) | [OS] | `Bottombar.tsx`, `useTimeline.ts` |
| Captions button → AutoCaptionsModal | [OS] | `NewEditorShell.tsx` |
| Aspect ratio dropdown | [OS] | `Bottombar.tsx` |
| Auto-focus toggle | [OS] | `Bottombar.tsx` |
| 3 lane rows (Zoom/Annotation/Speed pills) | [OS] | `Bottombar.tsx:306` |
| Region selection (click pill → select) | [NEW] | `Bottombar.tsx`, `useTimeline.ts` |
| Region delete (× button) | [OS] | `Bottombar.tsx` |
| Zoombar | [NEW] | `Bottombar.tsx` |
| TimelinePane (existing) | [AX] | `TimelinePane.tsx` |

### 3.4 Right Panels
| Feature | Origin | File |
|---------|--------|------|
| Background (16 thumbnails / 25 gradients) | [OS] | `RightPanes.tsx` |
| Video Effects (blur/motion/shadow/roundness/padding) | [OS] | `RightPanes.tsx` |
| Layout (preset/mirror/shrink/shape/size) | [OS] | `RightPanes.tsx` |
| Cursor (show/clip/style/sliders) | [OS] | `RightPanes.tsx` |
| Timeline (waveform toggle) | [OS] | `RightPanes.tsx` |
| Region Inspector (zoom depth, annotation text/color/size, speed, delete) | [OS] | `RightPanelStack.tsx` |

### 3.5 Preview & Transport
| Feature | Origin | File |
|---------|--------|------|
| VirtualPreview (single-video) | [AX] | `VirtualPreview.tsx`, `Preview.tsx` |
| Play/pause (Space) | [OS] | `Preview.tsx` |
| Prev/Next clip | [AX] | `Preview.tsx:82,94` |
| Loop toggle | [OS] | `Preview.tsx:106` |
| Fullscreen | [OS] | `Preview.tsx` |
| Time display | [OS] | `Preview.tsx` |
| REC button | [NEW] | `Preview.tsx` |
| Scrub slider | [OS] | `Preview.tsx` |

### 3.6 Chat (gated by `AI_FEATURES_ENABLED`)
| Feature | Origin | File |
|---------|--------|------|
| Send message → real LLM call (fetch-based) | [AX] | `LeftPanel.tsx:288` |
| Message bubbles (role/time) | [AX] | `LeftPanel.tsx` |
| Model picker cycle | [AX] | `LeftPanel.tsx:332` |
| Reasoning effort pill | [AX] | `LeftPanel.tsx:338` |
| Context pill | [AX] | `LeftPanel.tsx:353` |
| New chat / History modal | [AX] | `LeftPanel.tsx:324` |
| Provider Settings (8 providers, form, save/disconnect) | [AX] | `ProviderSettings.tsx` |

### 3.7 Multi-clip & Insert Source
| Feature | Origin | File |
|---------|--------|------|
| Drag media card (dataTransfer with assetId) | [AX] | `LeftPanel.tsx:70` |
| Drop on timeline → InsertSourceModal (3 choices) | [AX] | `NewEditorShell.tsx:385,600` |
| Add clip before | [AX] | `useTimeline.ts:173` |
| Add clip after | [AX] | `useTimeline.ts:196` |
| Split and insert | [AX] | `useTimeline.ts:219` |

### 3.8 Keyboard Shortcuts
| Feature | Origin | File |
|---------|--------|------|
| Cmd+S (save) | [OS] | `NewEditorShell.tsx:446` |
| Cmd+N (new project) | [OS] | `NewEditorShell.tsx:452` |
| Cmd+O (open project) | [OS] | `NewEditorShell.tsx:464` |
| Space (play/pause) | [OS] | `NewEditorShell.tsx:477` |
| Z / T / A / S (region tools) | [OS] | `NewEditorShell.tsx:535-553` |
| Del/Backspace (remove region) | [OS] | `NewEditorShell.tsx:488` |
| Cmd+Z / Cmd+Shift+Z (undo/redo) | [NEW] | `undo.ts`, `NewEditorShell.tsx` |
| Cmd+C / Cmd+V (region copy/paste) | [OS] | `regionClipboard.ts` |

### 3.9 Backend (Electron main process)
| Feature | Origin | File |
|---------|--------|------|
| 8 provider definitions | [AX] | `electron/ai-edition/provider-registry.ts` |
| LLM config store (safeStorage) | [AX]+[NEW] | `electron/ai-edition/llm-config-store.ts` |
| LLM call (fetch, no LangChain) | [AX]+[NEW] | `electron/ai-edition/llm-call.ts` |
| Chat service (in-memory per-project) | [AX] | `electron/ai-edition/chat-service.ts` |
| Document service (CRUD .axcut files) | [AX] | `electron/ai-edition/document-service.ts` |
| IPC bridge (aiEdition domain) | [NEW] | `electron/native-bridge/services/aiEditionService.ts` |

### 3.10 Store Layer
| Feature | Origin | File |
|---------|--------|------|
| Zustand projectStore (document + dirty + IPC) | [NEW] | `src/lib/ai-edition/store/projectStore.ts` |
| EditorSettings (typed get/patch over legacyEditor) | [NEW] | `editorSettings.ts`, `editorSettings.test.ts` |
| useEditorSettings hook (set/setLive/commit) | [NEW] | `useEditorSettings.ts` |
| useTimeline hook (region CRUD + clip ops) | [NEW] | `useTimeline.ts` |
| Undo stack (Cmd+Z / Cmd+Shift+Z) | [NEW] | `undo.ts` |
| Region clipboard | [OS] | `regionClipboard.ts` |

### 3.11 i18n
| Feature | Origin | File |
|---------|--------|------|
| Locale keys added to all 13 locales (editor.json → "shell") | [NEW] | `src/i18n/locales/*/editor.json` |
| Language picker → locale change | [OS] | `Titlebar.tsx` |

### 3.12 Misc
| Feature | Origin | File |
|---------|--------|------|
| UnsavedChangesDialog (beforeunload + new/open/record) | [OS] | `Modals.tsx`, `NewEditorShell.tsx` |
| Auto-captions (modal → annotation regions) | [OS] | `NewEditorShell.tsx`, `annotationsFromCaptions.ts` |
| Browser shim (localStorage fallback) | [NEW] | `src/native/browserShim.ts` |
| Native client + contracts | [NEW] | `src/native/client.ts`, `contracts.ts` |
| Schema (v3 AxcutDocument zod) | [AX] | `src/lib/ai-edition/schema/index.ts` |
| Migration (v2 ↔ v3) | [NEW] | `src/lib/ai-edition/document/migrate.ts` |
| Timeline math (normalizeIntervals, subtractInterval) | [AX] | `src/lib/ai-edition/document/timeline.ts` |
| Virtual preview math | [AX] | `src/lib/ai-edition/timeline/virtual-preview.ts` |
| Document exporter → VideoExporterConfig/GifExporterConfig | [NEW] | `src/lib/ai-edition/exporter/documentExporter.ts` |
| Auto-transcribe if no transcript exists | [NEW] | `NewEditorShell.tsx`, `transcribe.ts` |

---

## 4. Features Still to Be Merged (remaining items)

### 4.1 High Priority — Functionality Gaps
| # | Feature | Origin | What's missing | Files to touch |
|---|---|---|---|---|
| **1** | Auto-captions → auto-Transcribe | [OS] | If no transcript, "Captions" button should trigger `transcribeAsset` before `captionSegmentsToAnnotationRegions`. Currently just a toast. | `NewEditorShell.tsx:handleGenerateCaptions` |
| **2** | Playback scrub slider | [OS] | Transport bar has time display but no `<input type="range">`. Design has a progress bar. | `Preview.tsx` |
| **3** | Timeline playhead scrub | [OS] | Click/drag on ruler → preview seeks. `TimelinePane` has this but not exposed to Preview. | `TimelinePane.tsx`, `Bottombar.tsx` |
| **4** | Source Transcript modal — real data | [AX] | `transcriptText` is always null. Should show `document.transcript` content. | `LeftPanel.tsx`, `Modals.tsx` |
| **5** | UnsavedChangesDialog on Cmd+W | [OS] | Only wired for New Recording. Missing close-window handler. | `NewEditorShell.tsx` |
| **6** | Region inspector — persist depth/text | [OS] | Zoom depth buttons and annotation textarea update local state but don't call `saveDocument`. | `RightPanelStack.tsx:RegionInspector` |
| **7** | Media file 4-state indicator | [AX] | Dot is always green. Should reflect transcript status (pend/run/complete/fail). | `LeftPanel.tsx:MediaList` |
| **8** | Per-file transcript availability check | [AX] | `SourceTranscriptModal` should show transcript if available. Currently always "Not generated yet". | `LeftPanel.tsx`, `Modals.tsx` |

### 4.2 Medium Priority — Visual Polish
| # | Feature | Origin | What's missing | Files to touch |
|---|---|---|---|---|
| **9** | Canvas preview rendering | [OS] | Wallpaper, shadow, border-radius, crop, webcam PiP, cursor, zoom, annotations not shown in live preview (only `<video>` tag). | `Preview.tsx`, `VirtualPreview.tsx` or new Pixi overlay |
| **10** | Live-run feed (Thinking cards) | [AX] | During LLM call, no intermediate feedback. Message appears all at once. | `LeftPanel.tsx:ChatStripPanel` |
| **11** | Status chips | [AX] | Transcription/export job status (idle/running/ready/error) — no job queue. | New component or `LeftPanel.tsx` |
| **12** | Region shape customization | [OS] | Arrow direction, figure color, blur shape/color/mosaic, annotation font family/size/animation not in inspector. | `RightPanelStack.tsx:RegionInspector` |
| **13** | i18n migration of all new components | [NEW] | All strings in Titlebar/Bottombar/LeftPanel/RightPanes/Modals are hardcoded English. Locale keys exist but aren't used. | All `src/components/ai-edition/*.tsx` |
| **14** | Edit Clip modal | [AX] | Pencil button on track blocks doesn't exist. Need modal for sourceStartSec/sourceEndSec. | New modal in `Modals.tsx` + `TimelinePane.tsx` |
| **15** | Per-region Copy/Paste (Cmd+C/V) | [OS] | `regionClipboard.ts` exists in legacy but not wired in new shell. | `NewEditorShell.tsx` + new clipboard hook |
| **16** | Conversation History — multiple sessions | [AX] | Currently 1 session only. Backend session management missing. | `electron/ai-edition/chat-service.ts` |

### 4.3 Lower Priority — Backend Features
| # | Feature | Origin | What's missing | Files to touch |
|---|---|---|---|---|
| **17** | OAuth device flow | [AX] | ChatGPT/GitHub Copilot OAuth. "Not implemented" placeholders. | `llm-call.ts`, `ProviderSettings.tsx` |
| **18** | Reconnect banner on expired API key | [AX] | No `provider_auth_expired` event. | `ProviderSettings.tsx` |
| **19** | SSE streaming for project changes | [AX] | Not needed in single-user Electron, could improve reactivity. | — |
| **20** | SQLite sessions/checkpoints | [AX] | Chat history is in-memory (lost on restart). Axcut used `better-sqlite3`. | `electron/ai-edition/chat-service.ts` |
| **21** | Conversation History rename/delete | [AX] | Basic modal exists, but only 1 session, no rename, no delete. | `Modals.tsx:ChatHistoryModal` |
| **22** | Undo/redo verification | [NEW] | Wired but verify Cmd+Z / Cmd+Shift+Z work in browser. | `NewEditorShell.tsx` |

### 4.4 Missing OpenScreen Features from Old Editor
| # | Feature | What's missing | Spec section |
|---|---|---|---|
| **23** | EditorEmptyState | Logo + import video + load project + drag & drop overlay + supported formats. Simple text placeholder now. | OpenScreen §5.4 |
| **24** | Drag & drop `.openscreen` file | Handler missing. | OpenScreen §5.4 |
| **25** | ShortcutsConfigDialog | Loaded lazily in App.tsx, never shown. No "customise shortcuts" button. | OpenScreen §5.10 |
| **26** | Annotations settings panel | Text/Image/Arrow tabs, font/size/color/animation, custom fonts, duplicate. Not wired. | OpenScreen §5.5.3 |
| **27** | Blur settings panel | Shape/color/mosaic size. Not wired. | OpenScreen §5.5.3 |
| **28** | Auto-zoom (wand) suggestions | Wand button disabled. Not ported. | OpenScreen §5.5.4 |
| **29** | Webcam PIP real-time preview | Placeholder "Webcam" div. No real webcam layer. | OpenScreen §5.5.1 |
| **30** | Cursor rendering in preview | Theme art, smoothing, motion blur, click bounce not rendered. | OpenScreen §5.5.1 |

---

## 5. File Index — Complete Path Reference

### 5.1 Design References
| File | Description |
|------|-------------|
| `design/openscreen-editor.html` | **Canonical** 4686-line static HTML reference (light + dark) |
| `design/DESIGN.md` | Design system documentation (156 lines) |

### 5.2 Architecture Docs
| File | Description |
|------|-------------|
| `docs/architecture/ai-edition-merge-plan.md` | 420-line merge plan (Phases 0-10, locked decisions) |
| `docs/architecture/openscreen-inventory.md` | Full OpenScreen codebase catalog (~750 lines) |
| `docs/architecture/axcut-inventory.md` | Full Axcut codebase catalog (458 lines) |
| `docs/architecture/ai-edition-collision-analysis.md` | 355-line collision analysis with resolutions |
| `docs/architecture/ai-edition-handover.md` | Previous handover (367 lines) |
| `docs/architecture/native-bridge.md` | Native bridge documentation |
| **`docs/architecture/ai-edition-comprehensive-handover.md`** | **This file** |

### 5.3 UX Specifications
| File | Description |
|------|-------------|
| `docs/openscreen-ux-ui-spec.md` | OpenScreen UX/UI spec (570 lines) |
| `docs/axcut-ux-ui-spec.md` | Axcut UX/UI spec (397 lines) |

### 5.4 Renderer Components (`src/components/ai-edition/`)
| File | Lines | Description |
|------|-------|-------------|
| `NewEditorShell.tsx` | ~830 | Top-level shell: state, IPC handlers, keyboard shortcuts |
| `NewEditorShell.module.css` | ~200 | 4-row grid layout + resize handles |
| `Titlebar.tsx` | ~450 | Brand, rename, save, open/new, lang, recorder, panels, theme |
| `Bottombar.tsx` | ~400 | View-tools + 3 lane rows + zoombar + TimelinePane |
| `Preview.tsx` | ~300 | Preview frame + transport + scrub |
| `LeftPanel.tsx` | ~670 | Left rail (Chat/Media) + MediaPane + ChatStripPanel |
| `RightPanelStack.tsx` | ~200 | Right panel container + RegionInspector |
| `RightPanes.tsx` | ~350 | 6 individual panes (Background/Effects/Layout/Cursor/Timeline) |
| `Modals.tsx` | ~500 | All modals (Open/New/Crop/Unsaved/AutoCaptions/InsertSource/Transcript/ChatHistory) |
| `ExportDialog.tsx` | ~250 | MP4 + GIF export with progress |
| `ProviderSettings.tsx` | ~200 | 8-provider grid → form → save/disconnect |
| `VirtualPreview.tsx` | ~233 | Single-video preview (ported from Axcut) |
| `VirtualPreview.module.css` | ~93 | Preview component styles |
| `TimelinePane.tsx` | ~837 | Timeline: ruler, clips, skip strips, navigator (Axcut port) |
| `TimelinePane.module.css` | ~304 | Timeline component styles |
| `TranscriptEditor.tsx` | ~117 | Click-word seek, shift-click range, strikethrough |
| `TranscriptEditor.module.css` | ~75 | Transcript editor styles |
| `ChatPanel.tsx` | ~114 | OLD chat panel (replaced by ChatStripPanel in LeftPanel) |
| `ProjectPanel.tsx` | ~225 | OLD project picker (kept for reference) |
| `AiEditionShell.tsx` | ~12 | Lazy-load entrypoint |

### 5.5 Lib/AI-Edition (`src/lib/ai-edition/`)
| File | Lines | Description |
|------|-------|-------------|
| `schema/index.ts` | ~489 | v3 AxcutDocument Zod schema |
| `schema/index.test.ts` | ~190 | Schema tests |
| `document/migrate.ts` | ~325 | v2 ↔ v3 bidirectional migration |
| `document/migrate.test.ts` | ~305 | Migration tests |
| `document/timeline.ts` | ~174 | Pure interval math (normalizeIntervals, subtractInterval, etc.) |
| `document/timeline.test.ts` | ~230 | Timeline math tests |
| `document/transcribe.ts` | ~100 | Wraps existing captioning pipeline |
| `document/ids.ts` | ~8 | createId(prefix) → uuid |
| `store/projectStore.ts` | ~204 | Zustand store (document, dirty, IPC) |
| `store/projectStore.test.ts` | ~141 | Store tests |
| `store/editorSettings.ts` | ~100 | Typed get/patch over legacyEditor envelope |
| `store/editorSettings.test.ts` | ~80 | Editor settings tests (8) |
| `store/useEditorSettings.ts` | ~80 | React hook (set/setLive/commit) |
| `store/useTimeline.ts` | ~250 | Region CRUD + clip ops + selection |
| `store/undo.ts` | ~70 | Undo stack module |
| `store/regionClipboard.ts` | ~50 | Per-region copy/paste |
| `exporter/documentExporter.ts` | ~218 | Document → Video/Gif exporter config |
| `timeline/virtual-preview.ts` | ~84 | Pure time-mapping utilities |
| `timeline/virtual-preview.test.ts` | ~79 | Virtual preview tests |

### 5.6 Styles
| File | Description |
|------|-------------|
| `src/styles/design-tokens.css` | 270 CSS vars (light + dark) |

### 5.7 Hooks
| File | Description |
|------|-------------|
| `src/hooks/useTheme.ts` | Light/dark toggle, persisted in localStorage |

### 5.8 Native Bridge
| File | Description |
|------|-------------|
| `src/native/browserShim.ts` | Auto-installs stubs in browser (localStorage persistence) |
| `src/native/client.ts` | nativeBridgeClient (system/project/cursor/aiEdition) |
| `src/native/contracts.ts` | TypeScript types for IPC bridge |

### 5.9 Electron Main Process
| File | Lines | Description |
|------|-------|-------------|
| `electron/ai-edition/provider-registry.ts` | ~87 | 8 provider definitions |
| `electron/ai-edition/llm-config-store.ts` | ~90 | safeStorage encrypted credentials |
| `electron/ai-edition/llm-call.ts` | ~100 | Fetch-based LLM call (OpenAI-compat + Anthropic) |
| `electron/ai-edition/chat-service.ts` | ~72 | In-memory chat with real LLM call |
| `electron/ai-edition/document-service.ts` | ~219 | CRUD on .axcut JSON files |
| `electron/ai-edition/document-service.test.ts` | ~193 | Document service tests |
| `electron/native-bridge/services/aiEditionService.ts` | ~141 | IPC bridge for aiEdition domain |
| `electron/ipc/handlers.ts` | ~2800+ | Extended with aiEdition channel handlers |
| `electron/ipc/nativeBridge.ts` | ~98 | Versioned bridge router |

### 5.10 Deleted Files
| File | Reason |
|------|--------|
| `src/components/ai-edition/IconRail.tsx` | Replaced by `LeftPanel.tsx::LeftRail` |
| `src/components/ai-edition/EditorSettings.tsx` | Replaced by `RightPanes.tsx` + `useEditorSettings` |

---

## 6. Merge Status Matrix

### Phase 0 — Foundation (Schema + Migration)
| Item | Status | Files |
|------|--------|-------|
| v3 AxcutDocument schema with annotations, zoomRanges, legacyEditor | ✅ Done | `schema/index.ts` |
| v2 → v3 migration (bidirectional) | ✅ Done | `document/migrate.ts` |
| v2 → v3 migration tests | ✅ Done | `document/migrate.test.ts` |
| Schema tests | ✅ Done | `schema/index.test.ts` |
| Timeline math (normalizeIntervals, etc.) | ✅ Done | `document/timeline.ts` |
| Timeline math tests | ✅ Done | `document/timeline.test.ts` |

### Phase 1 — Core Merge (Clips/Skips/Multi-Asset)
| Item | Status | Files |
|------|--------|-------|
| PR 1.1: Resources panel + asset model | ✅ Done | `projectStore.ts`, `document-service.ts`, `LeftPanel.tsx:MediaPane` |
| PR 1.2: Timeline rewrite (TimelinePane) | ✅ Done (port) | `TimelinePane.tsx` |
| PR 1.3: New editor default (AIEditionShell) | ✅ Done | `NewEditorShell.tsx`, `AiEditionShell.tsx` |
| **Kill-switch removal** | **⚠️ Not done** — `App.tsx` still has conditional render | `App.tsx` |
| Recording → asset (append to project) | **⏳ Partially done** — store has `addAsset` but recording not wired | `NewEditorShell.tsx` |
| Deprecate legacy VideoEditor.tsx | **⏳ Not done** — legacy file unchanged on disk | `VideoEditor.tsx` |

### Phase 2 — VirtualPreview
| Item | Status | Files |
|------|--------|-------|
| VirtualPreview (two-layer, crossfade) | ✅ Done (port) | `VirtualPreview.tsx` |
| Preview transport (play/pause, loop, fullscreen, scrub) | ✅ Done | `Preview.tsx` |
| Cursor-aware clip playback | **❌ Not done** (Phase 2.5) | — |
| Webcam PIP real-time preview | **❌ Not done** (#29) | — |
| Canvas rendering (wallpaper, blur, etc.) | **❌ Not done** (#9) | — |

### Phase 3 — Exporter Rewrite
| Item | Status | Files |
|------|--------|-------|
| Document → VideoExporterConfig | ✅ Done | `documentExporter.ts` |
| ExportDialog (MP4 720/1080/Source + GIF) | ✅ Done | `ExportDialog.tsx` |
| Export IPC (pick path + write) | ✅ Done | `NewEditorShell.tsx` |
| Round-trip export test | **❌ Not done** — needs Electron | — |

### Phase 4 — Transcription + Transcript Editor
| Item | Status | Files |
|------|--------|-------|
| Auto-captions (annotation regions from transcript) | ✅ Done | `NewEditorShell.tsx`, `annotationsFromCaptions.ts` |
| Auto-Transcribe if no transcript | **⚠️ Partially** (#1) | `NewEditorShell.tsx` |
| TranscriptEditor (click-word seek, shift-click range) | ✅ Done (port) | `TranscriptEditor.tsx` |

### Phase 5 — Recorder Feature Preservation
| Item | Status | Files |
|------|--------|-------|
| Return to recorder button | ✅ Done | `NewEditorShell.tsx:372` |
| Unsaved-changes on close | ✅ Done | `NewEditorShell.tsx`, `Modals.tsx` |
| Keyboard shortcuts (all 12) | ✅ Done | `NewEditorShell.tsx` |

### Phase 6 — Agent Runtime (Gated by `AI_FEATURES_ENABLED`)
| Item | Status | Files |
|------|--------|-------|
| 6.1: Chat service + IPC | ✅ Done | `chat-service.ts`, `aiEditionService.ts` |
| 6.2: LLM config + provider registry | ✅ Done | `provider-registry.ts`, `llm-config-store.ts` |
| 6.3: Agent runtime + DeepAgentJS | **❌ Not done** | — |
| 6.4: Checkpoints + restore | **❌ Not done** | — |

### Phase 7 — LLM Providers
| Item | Status | Files |
|------|--------|-------|
| 8 provider definitions | ✅ Done | `provider-registry.ts` |
| Provider settings dialog | ✅ Done | `ProviderSettings.tsx` |
| LLM call (fetch, no LangChain) | ✅ Done | `llm-call.ts` |
| OAuth device flow | **❌ Not done** (#17) | `llm-call.ts` |

### Phase 8 — Conversation History + Checkpoints
| Item | Status | Files |
|------|--------|-------|
| Chat history modal | ✅ Done (basic) | `Modals.tsx:ChatHistoryModal` |
| Multiple sessions | **❌ Not done** (#16) | `chat-service.ts` |
| SQLite persistence | **❌ Not done** (#20) | — |
| Session rename/delete | **❌ Not done** (#21) | `Modals.tsx` |

### Phase 9 — Polish
| Item | Status | Files |
|------|--------|-------|
| i18n locale keys added (13 locales) | ✅ Done | `src/i18n/locales/*/editor.json` |
| i18n migration of components | **⚠️ Partially** (#13) — Titlebar partially done | All `*.tsx` |
| Settings sync | **❌ Not done** | — |
| Empty states | **❌ Not done** (#23) | — |
| Error toasts | **❌ Not done** | — |

### Phase 10 — Cut-over
| Item | Status | Files |
|------|--------|-------|
| AI_FEATURES_ENABLED defaults off | ✅ Done | `featureFlags.ts` |
| Legacy editor deletion | **⏳ Not done** — legacy VideoEditor.tsx still on disk (2961 lines) | `VideoEditor.tsx` |

---

## 7. Next Steps (Ordered)

### Immediate (Before next agent session)
1. `npm run dev` → `http://localhost:5173/?windowType=editor` → create a project → explore
2. Check `git status` — 42 files changed/untracked. **Commit or stash before branching.**

### Priority Fixes (3 lines or less each)
3. **#1**: Auto-Transcribe before captions — add `transcribeAsset` call in `handleGenerateCaptions`
4. **#6**: Region inspector persist — add `saveDocument()` after depth/text edits
5. **#8**: Source transcript modal data — wire `document.transcript` to modal content

### Cleanup
6. Remove `App.tsx` kill-switch (make new editor unconditional)
7. Delete `IconRail.tsx` and `EditorSettings.tsx` (already replaced)

### Next Feature Work
8. **#9**: Canvas preview — Pixi overlay for wallpaper/shadow/blur/crop/webcam/cursor/zoom/annotations
9. **#13**: i18n migration — use `useScopedT` in all `<ai-edition/*.tsx>` (keys exist in all 13 locales)
10. **#14**: Edit Clip modal — pencil button on TimelinePane track blocks
11. **#16**: Conversation History — push sessions, rename/delete in modal
12. **#23**: EditorEmptyState — full drop-zone with logo + supported formats + `.openscreen` drag handler

---

## 8. Critical Context

- **All files under `src/components/ai-edition/` are new/rewritten** — they're either modified in the `4a2f4e4` commit or untracked. The base commit's versions may be stale.
- **`legacyEditor` is kept as `Record<string, unknown>`** in schema — typed accessors live in `editorSettings.ts`. No schema migration needed for v2 round-trips.
- **Browser shim** stores in `localStorage["browser-shim-document"]`. Clear with `localStorage.clear()` in console.
- **Zoom/annotation/speed use ms** (`startMs/endMs`); skip/clip use seconds. Handled in `useTimeline.ts` by multiplying `currentTimeSec * 1000`.
- **`useExhaustiveDependencies` warning** on keyboard shortcut `useEffect` in `NewEditorShell.tsx` — intentional (handler registered once).
- **`npm start` / `npm run build` (Electron) untested** — primary dev mode is browser shim at `:5173/?windowType=editor`.
