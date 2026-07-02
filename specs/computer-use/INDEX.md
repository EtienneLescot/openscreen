# OpenScreen — Computer-Use E2E Test Roadmap (master index)

> **Audience:** the `open-computer-use` MCP driving a Windows desktop.
> **Goal:** give the agent an unambiguous, sequenced list of granular end-to-end
> scenarios to run against the **real Electron app** — not the browser-shim.
> **Authoring inputs:** `docs/architecture/openscreen-inventory.md`,
> `docs/architecture/axcut-inventory.md`, `docs/architecture/ai-edition-roadmap.md`,
> `\\wsl.localhost\Ubuntu\home\etienne\repos\axcut\docs\UX-UI-SPEC.md`,
> `design/openscreen-editor.html`, `design/DESIGN.md`,
> the AI-edition source under `src/components/ai-edition/*`, and the
> legacy openscreen source under `electron/`, `src/components/launch/`,
> `src/components/video-editor/`.

---

## How to drive these tests

1. Launch the real app once with `npm run dev` and **leave the launch/HUD window open**. From then on, every spec assumes that window is the foreground window unless it explicitly says "open the editor" or "open the source selector".
2. Each spec file is **self-contained** but references its **prerequisites** at the top — only run it once every prerequisite has passed.
3. Each numbered scenario has three blocks: **Setup** (preconditions), **Steps** (what the MCP must do), **Expected** (what the MCP must observe).
4. The MCP should **read a step, perform it, verify it, then move on**. Do not batch steps. If an Expected fails, stop the scenario and report.
5. Selectors follow three conventions:
   - `data-testid="…"` (preferred — already wired in the renderer),
   - `aria-label="…"` (secondary — wired on icon buttons and toolbars),
   - visible text (last resort — text is i18n'd; use `CommonJS X` pattern or copy from `src/i18n/locales/en/*.json`).
6. The agent must **always close any open modal / popover** between scenarios unless the next scenario explicitly opens another one. `Esc` is the universal close.

---

## Sequencing rationale

The numbered prefix is the run order. Each block depends on the previous one being green:

- **00 → 01** — recording pipeline. Without a recording or imported asset, every later spec is unrunnable.
- **02 → 03 → 04** — editor shell, then preview, then timeline navigation. Timeline is the canvas every other region operation paints on.
- **05 → 06 → 07 → 08 → 09** — clip lifecycle first (because skips live *inside* a clip), then skip ranges, then zoom, speed, annotation. Annotation goes last because it is the most layout-fragile.
- **10** — right-rail properties; depends on regions existing so the inspector is non-empty.
- **11** — transcript editor; needs a recording + transcription result.
- **12 → 13 → 14** — chat + provider settings + session history; provider settings gates chat, chat drives history.
- **15** — export; needs a complete timeline + preview to be meaningful.
- **16 → 17** — modals, shortcuts, i18n, theme; cross-cutting, run after every behaviour is in place.
- **18** — final QA checklist; smoke pass against the whole product.

---

## File map

| # | File | Scope | Surface | Prerequisites |
|---|---|---|---|---|
| 00 | [`00-launch-and-hud.md`](00-launch-and-hud.md) | Launch window, language picker, HUD tray layout, mic/webcam/cursor toggles, record/cancel | LaunchWindow | none |
| 01 | [`01-source-selection-and-record.md`](01-source-selection-and-record.md) | Source selector (screen / window tabs), countdown, recording lifecycle, stop → editor | SourceSelector + CountdownOverlay + useScreenRecorder | 00 |
| 02 | [`02-editor-foundation.md`](02-editor-foundation.md) | Editor opens, panels toggle, project list, new/open/rename project, save/unsaved, layout, theme | NewEditorShell, Titlebar, LeftPanel, RightPanelStack, Modals | 01 |
| 03 | [`03-transport-and-preview.md`](03-transport-and-preview.md) | Play/pause/restart, scrub, fullscreen, time readout, REC toggle on transport, webcam PiP, dual layout | Preview + PreviewCanvas + VirtualPreview | 02 |
| 04 | [`04-timeline-pan-zoom-scrub.md`](04-timeline-pan-zoom-scrub.md) | Ruler hover-scrub, click-to-seek, Ctrl+wheel zoom-at-cursor, Alt+drag pan, middle-button pan, navigator strip, fit-to-width, MAX zoom bound | TimelinePane + Bottombar | 02, 03 |
| 05 | [`05-clip-operations.md`](05-clip-operations.md) | Drag media into timeline, clip select, clip reorder, Edit Clip dialog, Remove clip, Ctrl+C/V duplicate, properties panel for selected clip | TimelinePane + Bottombar + Modals (EditClip) | 02, 04 |
| 06 | [`06-skip-regions.md`](06-skip-regions.md) | Place-skip mode (scissors button + `T`), skip resize (left/right handles), skip delete (trash), trim row hover-controls, snap-guide, floating tooltip, keyboard delete | TimelinePane + Bottombar + RegionTimeline | 02, 04, 05 |
| 07 | [`07-zoom-regions.md`](07-zoom-regions.md) | Add zoom region, depth cycle (1→6), focus point drag, rotation preset (iso/left/right), Magic Wand suggestions, Auto-Focus toggle | TimelinePane + Bottombar + RightPanes | 02, 04, 05 |
| 08 | [`08-speed-regions.md`](08-speed-regions.md) | Add speed region, speed slider (0.1×–16×), delete speed region, behavior during playback | TimelinePane + Bottombar | 02, 04, 05, 06 |
| 09 | [`09-annotation-regions.md`](09-annotation-regions.md) | Add text annotation (font family, animation), image annotation, figure (rect/circle/arrow), blur (rect/freehand, intensity), inspector fields | TimelinePane + Bottombar + RightPanes | 02, 04, 05, 06 |
| 10 | [`10-properties-right-panel.md`](10-properties-right-panel.md) | Right rail panes: Background (image/gradient/color/custom), Layout (aspect, padding, radius, shadow, blur, motion-blur), Camera (shape, size, position, mirrored, reactive), Cursor (theme, size, smoothing, motion-blur, click-bounce, clip), Effects, Help popover | RightPanes + RightPanelStack | 02 |
| 11 | [`11-transcript-editor.md`](11-transcript-editor.md) | Auto-captions modal (Whisper model picker), transcript word seek, click-to-jump, Backspace/Delete to add skip, caret arrow keys, cut run trash, regenerate transcript | TranscriptEditor + Modals (AutoCaptions) | 01, 02, 03 |
| 12 | [`12-chat-panel.md`](12-chat-panel.md) | Open chat tab, send message, model picker popover, reasoning pill, live-run feed, "applied: …" line per tool call, undo button | LeftPanel + chat-service | 02, 13 |
| 13 | [`13-provider-settings.md`](13-provider-settings.md) | Settings → Models / Providers / Settings screens, Connect API key, OAuth device-flow card (ChatGPT, GitHub Copilot), reasoning effort selector | ProviderSettings | 02 |
| 14 | [`14-sessions-and-history.md`](14-sessions-and-history.md) | New conversation, rename, delete, switch session, Conversation History modal, Rewind confirmation popover | LeftPanel + Modals (History) | 12, 13 |
| 15 | [`15-export-dialog.md`](15-export-dialog.md) | Open Export dialog, quality preset (preview-low/final-balanced/final-high), format (MP4/GIF), fps (24/30/60), codec (h264/h265/vp9), GIF size + frame rate, export → MP4 download | ExportDialog + exporter pipeline | 02, 03, 05–09 |
| 16 | [`16-modal-shortcuts-i18n.md`](16-modal-shortcuts-i18n.md) | Crop modal, OpenProject modal, NewProject modal, UnsavedChanges modal, ShortcutsConfig dialog, language switcher (13 locales), keyboard shortcut bindings | Modals + ShortcutsContext + I18nContext | 02 |
| 17 | [`17-themes-and-settings.md`](17-themes-and-settings.md) | Dark/light theme toggle, Settings dialog (general/export/recording/audio tabs), user preferences persistence | NewEditorShell + Settings | 02 |
| 18 | [`18-final-qa-checklist.md`](18-final-qa-checklist.md) | Cross-cutting smoke pass: open app → record → edit → export → close; full happy-path with assertions per major surface | whole app | 00–17 |

---

## What "expected" looks like in each scenario

The Expected block uses these patterns:

- **State assertion** — a `data-*` attribute or text change the MCP reads.
- **Visual assertion** — a colored pixel sample, an element visibility, a transition that the MCP takes a screenshot of and inspects.
- **No console error** — the MCP's persistent console listener is on for the whole session; any `error` console message in a scenario's window is a fail.

If a step has no observable effect (e.g. a transition that lasts < 120 ms), the MCP should screenshot **before and after** and diff the bounding boxes of the affected element.

---

## What "stop the run" looks like

- A scenario's Expected block fails → MCP stops, logs the step + observed state, marks the scenario ❌, moves on to the next spec. The failing spec must be debugged, not retried.
- A console error not previously classified → MCP stops, captures the stack, and asks the human.
- A modal blocks input for > 2 steps of a non-modal scenario → MCP presses `Esc` once, then re-tries; if still blocked, the scenario fails.

---

## Sample-fixture philosophy

The recording pipeline is hard to drive deterministically from the MCP (it requires a real screen source). The computer-use driver should:

- For **00–01**: drive the actual flow on the developer's primary monitor.
- For **02 onwards**: load a fixture recording via the **Open Project** dialog (file picker → `tests/fixtures/sample.webm`). The fixture is also what `tests/e2e/seed.spec.ts` uses for browser-shim coverage.
- For **12 onwards** (chat): pre-configure a provider via `OpenProject` → `Settings` → `Provider Settings` once. Re-use that provider across chat scenarios.

This keeps the recording window's failure modes out of the AI-edition test matrix.