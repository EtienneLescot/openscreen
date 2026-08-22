# Decision ledger

The choices that shape the architecture, and the ones that were tried and rejected. This file
exists so nobody re-litigates a settled question or re-proposes a route that has already been
measured and lost. It is the only doc here that names things which no longer exist — everywhere
else, the docs describe what is.

A decision leaves this list only when the code stops honouring it.

## In force

| Decision | Why |
|---|---|
| **One document is the single source of truth.** `AxcutDocument` (`src/lib/ai-edition/schema/index.ts`) holds the whole project; the timeline, the preview, the captions pane and the exporter are all projections of it. No pane keeps parallel edit state. | Every desync bug this editor has had came from two surfaces owning the same fact. See [document-model.md](document-model.md). |
| **Modifiers are authored above the timeline and stored down on the clip.** Zoom, speed and annotation ranges are anchored to a clip, not to absolute timeline time. | Trimming or reordering a clip must carry its modifiers with it. Absolute anchoring silently desyncs preview from render. See [timeline-model.md](timeline-model.md). |
| **Clips on the timeline are always contiguous** — no gaps, no overlap. | The export segment loop and the audio junction logic both depend on it; permitting holes would double the state space for no user-visible gain. See [export-pipeline.md](export-pipeline.md). |
| **The model never free-writes the document.** The agent calls a fixed, validated tool schema, and a checkpoint is taken before each tool batch so the batch undoes as one unit. | A model emitting raw JSON patches can corrupt a project in a way the user cannot undo. See [ai-agent.md](ai-agent.md). |
| **Native helpers own capture, timing and encoding; Electron owns session orchestration and persistence.** | Frame timing cannot be made reliable across an IPC boundary. See [recording.md](recording.md). |
| **Windows production recording does not silently fall back to `getDisplayMedia` / `MediaRecorder`.** A native path that fails, fails loudly. | A silent fallback produced recordings that were subtly worse with no signal to the user. |
| **Compositing and encoding run in one native D3D11 engine**, shared by live preview and export. | See [native-compositor.md](native-compositor.md), and [../engineering/rendering-performance.md](../engineering/rendering-performance.md) for the measurements that chose it. |
| **Local transcription is bundled and never gated.** It runs on-device; no audio leaves the machine. | It is the foundation the caption and transcript features stand on, and gating it would make the privacy story conditional. See [transcription-and-captions.md](transcription-and-captions.md). |
| **The AI/LLM surface ships to every user.** The provider settings, chat panel, suggestions and checkpoint-restore UI are always mounted. The editing model itself ships to every user. The LLM is opt-in at the credentials step — without an API key the chat panel is a "no provider connected" welcome view. | The editor has to be complete without an LLM. The chat panel becoming a no-op when no key is set covers the same UX the old flag did, without the binary cutoff. |
| **LLM credentials live in Electron `safeStorage`** (the OS keychain), never in plain JSON on disk. A write fails rather than falling back to plaintext. | `electron/ai-edition/llm-config-store.ts`. See [llm-providers.md](llm-providers.md). |
| **The project file extension is `.openscreen`.** Builds that wrote `.axcut` are read and renamed forward on first open. | Users already recognise the extension; `electron/ai-edition/document-service.ts:23` holds both. |
| **Migrations are forward-only.** A document is migrated up to the current `schemaVersion` on open and never written back down. | Round-tripping through an older schema loses fields silently. |
| **Captions are derived from the transcript, not injected as annotations.** | The earlier design generated annotation objects from captions, which then drifted from the transcript the moment either was edited. The transcript is the SSOT for spoken words. |
| **One package, one repository.** No sidecar process, no local HTTP server, no monorepo. | The editing engine was adopted from a project that had a Python worker and a Fastify server; both were replaced by in-process TypeScript and Electron IPC. Adding a second runtime back is a large, permanent cost. |

## Rejected, with the reason

Each of these was actually built or measured. Do not re-propose one without new evidence that
contradicts the reason given.

| Route | What happened |
|---|---|
| **Rust + wgpu native compositor** | Built as a POC. Zero-copy Vulkan video decode required driver features not available on the target hardware. The principle — a GPU-resident pipeline — was right; D3D11 delivers it without the driver dependency. |
| **Tauri / separate native core** | Would have split the app across two runtimes and two build systems to solve a problem that was measured to be in the compositor, not in Electron. |
| **Encoder pipelining** | Implemented and measured: a *loss* on the target integrated GPU, because encode and composite contend for the same queue. |
| **Software VP9 export** | Worked correctly end to end, but with no hardware VP9 encoder on the target GPU it was far too slow to ship. Removed rather than left as a trap. |
| **Proxy MP4 files for scrubbing** | Dropped in favour of streaming decode. If long-recording scrub latency becomes the top complaint again, the revival path is a per-asset "generate proxy" action, not a background pass over every import. |
| **Server-sent events for project changes** | Meaningless in a single-user desktop app; the document store already notifies every subscriber. |
| **Auto-generating annotations from captions** | See "captions are derived" above. |
| **React Query for the agent layer** | Planned during the merge, never adopted; the dependency is not in `package.json`. Plain IPC plus the document store covers it. |

## Surfaces that were removed

Older docs and code comments still refer to these. They are gone; the second column is where the
behaviour lives now.

| Removed | Replaced by |
|---|---|
| `VideoEditor` (the pre-merge editor) | `src/components/ai-edition/NewEditorShell.tsx` mounting the v4 surfaces |
| `TimelinePane.tsx` | `src/components/ai-edition/v4/V4Timeline.tsx` |
| `Titlebar.tsx`, `Bottombar.tsx` | `src/components/ai-edition/v4/EditorTopBar.tsx` |
| `RightPanelStack.tsx` | `src/components/ai-edition/v4/FloatingInspector.tsx` |
| `TranscriptEditor.tsx` | `src/components/ai-edition/CaptionsPane.tsx` + `src/lib/ai-edition/captions/` |
| `BackgroundPane`, and the `"background"` inspector facet | the **Background** section of `VideoEffectsPane` (`src/components/ai-edition/RightPanes.tsx`). Four of the five "effects" controls were background controls — the blur blurs it, the shadow falls on it, roundness and padding exist to let it show through — so the split put the answer to "how do I remove the background" in the tab that doesn't say background ([#84](https://github.com/getopenscreen/openscreen/issues/84)). |
| The browser-based exporter | the native compositor export path — see [export-pipeline.md](export-pipeline.md) |
| CTranslate2 speech-to-text | whisper.cpp — see [transcription-and-captions.md](transcription-and-captions.md) |
| `LeftRail`, and `LeftPanel`'s `MediaPane` branch (with `MediaList` and `SourceTranscriptModal`) | the Media/Edit/Rec mode switch in `src/components/ai-edition/v4/EditorTopBar.tsx` and the stage it selects, `src/components/ai-edition/v4/MediaStage.tsx`. The v4 refactor (`03972b0e`) moved the Chat/Media choice from a left rail into the top bar and stopped rendering `LeftRail`, pinning the sole `LeftPanel` mount to the literal `active="chat"` — but left the `media` half in the tree. Unreachable code that still *looks* live attracts fixes: two later commits (`493c7917`, `05eb06b4`) landed language-picker work on `SourceTranscriptModal` before anyone noticed no user could open it. `LeftPanel` is gone too — `ChatStripPanel`, the only branch that ever ran, is now exported and mounted directly. |
