# Document model

The single source of truth for an OpenScreen project is `AxcutDocument`, a Zod-typed
JSON object defined in `src/lib/ai-edition/schema/index.ts` and persisted as one file
per project on disk. The renderer holds one instance in a Zustand store
(`src/lib/ai-edition/store/projectStore.ts`); the main process owns persistence
(`electron/ai-edition/document-service.ts`); and every editor surface — timeline,
preview, floating inspector, captions, LLM agent — reads and writes that one
document. The model is the contract the rest of the editor hangs off; this page is
the contract.

## `schemaVersion` and top-level shape

`axcutSchemaVersion` is **7** — exported as a literal at the top of
`src/lib/ai-edition/schema/index.ts`. Every document on disk carries
`schemaVersion: 7`; anything older is upgraded on parse (see [Migrations](#migrations))
and anything unknown is rejected by the `z.literal(axcutSchemaVersion)` check in
`documentSchemaShape`.

| Field | Holds | Notes |
|---|---|---|
| `schemaVersion` | `7` | Bumping requires a migration; see the chain below. |
| `project` | `{ id, title, createdAt, updatedAt, primaryAssetId? }` | One project per file. |
| `assets[]` | `AxcutAsset` (one per recorded/imported media file) | Carries `originalPath`, `cameraTrack`, `durationSec` (renderer probes). |
| `transcript` | `AxcutTranscript \| null` | Legacy primary transcript; left for back-compat, no longer the source of truth. |
| `transcripts[]` | `AxcutTranscript[]` | Per-asset transcripts; what the captions layer actually reads. |
| `timeline` | `{ clips[], gaps[], trimRanges[], muteRanges[], speedRanges[], captionRanges[] }` | Clips carry their own in/out (`sourceStartSec`/`sourceEndSec`); trims are anchored to a clip (`clipId?`) since v7. See [timeline-model.md](timeline-model.md). |
| `annotations[]` | `AxcutAnnotationRegion[]` | Text/image/figure/blur overlays, anchored to a clip (`clipId?`). |
| `zoomRanges[]` | `AxcutZoomRegion[]` | Zoom-in effects, depth 1–6, anchored to a clip (`clipId?`). |
| `audioRanges[]` | `AxcutAudioRegion[]` | Imported audio (voiceover / music, issue #350) mixed over the programme. Clip-anchored like `zoomRanges` and `annotations`; the region's span is the out-point and `offsetSec` its in-point into the file. The referenced asset (`audioAssetId`) has `kind: "audio"` and never becomes a clip. See [timeline-model.md](timeline-model.md#audio-is-a-region-over-continuous-media). |
| `legacyEditor` | OpenScreen v2 `ProjectEditorState` passthrough | Appearance/cursor settings not yet first-class in the AI-edition schema. |
| `agent` | `{ baseIntent?, pendingQuestions[], suggestions[], lastAppliedOperations[], lastReasoningSummary? }` | LLM agent state. |
| `preview` | `{ strategy: "seek" \| "mse-proxy", revision: number }` | `revision` is the bump used to invalidate cached frames after an edit. |
| `export` | `{ preset, lastJobId }` | The last export run. |
| `history` | `{ revisions: AxcutRevision[] }` | Append-only revision log; declared by the schema (line 506) and currently populated only by tests. Undo/redo in the editor uses the in-memory `pushHistory` snapshot stack in `src/lib/ai-edition/store/undo.ts` rather than the persisted revision list — see [Undo / history](#undo--history). |

## Migrations

Migrations are **one-way and forward-only**. There is no version downgrade path: a
newer document that lands on an older build is rejected by the `schemaVersion`
literal, not silently truncated. The chain runs **at load time** through
`migrateRawDocumentToCurrent` (`src/lib/ai-edition/document/migrate.ts`) — the
upgraders compose the chain and `documentSchema.parse` is a pure v7 validator.
Every JSON-read site (`DocumentService`, the browser shim, the renderer's
`handleBrowseProject` / `openLoadedProject` disk-load paths) must call the
helper before `documentSchema.parse`. The pre-hoist implementation wrapped this
chain in a `z.preprocess`, so it ran on every `setDocument` / `saveDocument` /
`loadProject` parse — measurable per-parse overhead on documents that were
already current. Hoisting it to load time makes the in-memory parse a single
`z.literal(7)` + shape check on already-upgraded data.

### v3 → v4 (`upgradeV3DocumentToV4`, `schema/index.ts`)

v3 documents carried a single project-level `cameraTrack`; v4 moves it onto the
owning asset. The upgrader pulls the legacy `cameraTrack` field off the
document root and copies it onto the asset identified by `project.primaryAssetId`
(or the first asset if that is unset), then strips the root field and rewrites
`schemaVersion: 4`. v2 documents are not touched by this upgrader — they are
handled by the separate `migrateProjectDataToAxcutDocument` pure function
described below — and unknown versions pass through unchanged so the caller's
`documentSchema.parse` can reject them via the `schemaVersion` literal.

### v4 → v5 (`upgradeV4DocumentToV5`, `schema/index.ts`)

v5 makes modifiers (zoom, annotation, speed, camera-fullscreen) clip-anchored:
each region is split into one fragment per covered clip, with the source-time
window (`clipId`, `sourceStartSec`, `sourceEndSec`) as the source of truth and
`startMs`/`endMs` re-derived as a transition cache. The upgrader reads the RAW
clip layout out of `timeline.clips` and runs every region array through
`anchorRegionsWithDerivedMs` (`src/lib/ai-edition/timeline/timelineMap.ts:376`):

- `document.zoomRanges`
- `document.annotations`
- `document.legacyEditor.speedRegions`
- `document.legacyEditor.cameraFullscreenRegions`

A region that covers no clip — zero-length, or off the end of the timeline — is
dropped, because it could never play. A document with no clips has nothing to
anchor to, so its regions pass through untouched (the anchor is optional during
the transition). The v4→v5 migration lives **only** in this upgrader —
`document/migrate.ts` deliberately emits a v4 draft (see the v2→current
section below) so the same code path is reused for the legacy import.

### v5 → v6 (`upgradeV5DocumentToV6`, `schema/index.ts`)

v6 retires the `"native"` AspectRatio, a runtime-only sentinel that resolved to
the timeline's largest clip. The upgrader bakes the concrete `"W:H"` token into
`legacyEditor.aspectRatio` so the resolution is permanent, matching the answer
the runtime gave yesterday. It is **opportunistic**: baking needs real source
dimensions, and a project imported from v1.7 has none until the renderer probes
its media, so when they are unknown the sentinel is left in place (it keeps
resolving dynamically) and converts on a later load. Guessing `"16:9"` there
would permanently reframe every portrait v1.7 project on its first open.

### v6 → v7 (`upgradeV6DocumentToV7`, `schema/index.ts`)

v7 finishes what v5 started: **trims** become clip-anchored too. They were the
last ruler region addressed by `assetId` alone. `AxcutTrimRange.startSec` /
`endSec` already *are* a source-time window, so the only missing piece was
`clipId` — no `sourceStartSec`/`sourceEndSec` pair is added, which would only
create two fields that can drift.

Source time is per **asset**, so a v6 trim is unambiguous exactly while one asset
backs one clip. Duplicate a clip (or place the same recording twice) and the two
clips share a coordinate space: a cut authored on the second was indistinguishable
from one on the first, and each reader guessed differently — the transcript pane
showed the cut on **both** clips, the ruler drew it on the **first**, and
playback/export removed the span from **both**. `trimAppliesToClip`
(`src/lib/ai-edition/timeline/trim-mapping.ts`) is now the single definition every
reader routes through.

The upgrader **ventilates** rather than picks: a stored trim is replaced by one
anchored row per clip it covers, each clamped to that clip's source window, the
first keeping the original id. A v6 trim genuinely did cut every clip of its
asset, so this restates the document without moving its output — but the rows are
now separately addressable, which is what lets a user delete the copy on the clip
they did not mean. A trim covering no clip is kept **unchanged** rather than
dropped (`replaceTimeline` mints exactly those: the complement of the kept
intervals, outside every clip by construction), and an unprobed clip has no real
window to clamp against so its trims stay un-anchored. Un-anchored trims keep the
pre-v7 asset-wide meaning, which is what makes the fallback lossless.

### Legacy v2 → current (`migrateProjectDataToAxcutDocument`, `document/migrate.ts`)

OpenScreen's pre-merge editor stored projects as `EditorProjectData` (an envelope
versioned `PROJECT_VERSION = 2`, defined at
`src/components/video-editor/projectPersistence.ts:66`). On first open in the new
editor, the renderer calls this function to produce a current-shape document. The
migration is **pure** — no DOM, no fs, no network — and maps each `EditorProjectData`
field into the equivalent current slot:

- The single recorded screen video becomes one asset plus one clip spanning its
  source, with the webcam path lifted into `asset.cameraTrack`.
- `editor.trimRegions` (kept ranges) invert into `timeline.trimRanges` (kept ranges
  in source seconds). v2 semantics matched here — both are "kept", not "cut". The
  trims are anchored to the single minted clip right in this function rather than
  left to `upgradeV6DocumentToV7`: a v2 project has exactly one clip so the answer
  is unambiguous, and the upgrader could not do it anyway — the clip it mints has
  no source extent until the renderer probes the media.
- `editor.speedRegions`, `editor.zoomRegions`, and `editor.annotationRegions` carry
  over into `legacyEditor.speedRegions`, `document.zoomRanges`, and
  `document.annotations` respectively (with v4→v5 anchoring applied during the
  parse at the end).
- The full `editor` blob — wallpaper, cursor theme, webcam layout, blur settings,
  and the other ~20 fields without a first-class home — round-trips through
  `legacyEditor` so toggling AI-edition off then back on is lossless.

The function returns the current result by emitting a v4-shaped draft and running
it through `migrateRawDocumentToCurrent` (the whole `upgradeV3DocumentToV4` →
`upgradeV6DocumentToV7` chain) before `documentSchema.parse`. That is why the
draft is labelled `schemaVersion: 4` and not `axcutSchemaVersion`: labelling it
already-current would make the v4→v5 upgrader skip the anchoring and leave the
imported regions without clip anchors.

## Persistence

There are exactly two owners of the document bytes: the renderer store and the
main-process service. They never duplicate fields and never diverge on shape — the
service stores exactly what `JSON.stringify(document, null, 2)` produces.

| | Renderer | Main process |
|---|---|---|
| Code | `src/lib/ai-edition/store/projectStore.ts` | `electron/ai-edition/document-service.ts` |
| Role | Live editor state, transport (`playing`, `currentTimeSec`, `sourceDurationSec`), `dirty`/`lastSavedAt` | Read, write, list, add asset, remove asset |
| Transport | `nativeBridgeClient.aiEdition.*` IPC | — |
| On disk | — | `userData/projects/<id>.openscreen` (one JSON per project) |
| Extension | — | **`.openscreen`**. Older builds wrote the same v3/v4 documents under `.axcut`; the service renames them to `.openscreen` on first access (`migrateLegacyExtensions`, lines 119-145). The file content is unchanged — the extension migration is a pure rename keyed off the schema version in the JSON, not the file name. |
| Atomicity | — | Temp + rename per save (`writeProjectNow`, lines 354-394), with a per-project write queue (`writeQueues`, line 106) so two concurrent saves serialise and an interrupted write cannot leave a half-written document behind. |

Both layers run every read through `migrateRawDocumentToCurrent` then
`documentSchema.parse` so an on-disk document of any supported version comes out
as the current `AxcutDocument` shape; the renderer never holds a stale
`schemaVersion: 3` snapshot.

## Undo / history

The schema declares a `history.revisions[]` field (`schema/index.ts:506-510`) for
an append-only revision log, populated by tests today and reserved for future
revision browsing. The interactive undo/redo in the editor uses a different,
lighter mechanism so the user can undo any edit, including one made by the LLM,
without growing the persisted document.

The mechanism lives in `src/lib/ai-edition/store/undo.ts`:

- A bounded snapshot stack (`past[]`, `future[]`, `MAX_HISTORY = 50`) holds the
  previous document JSON per project.
- Every call to `setDocument` in the project store (`projectStore.ts:218-232`)
  pushes the outgoing document onto `past` before swapping in the new one
  (`pushHistory`, `undo.ts:18-25`). The push is deferred via a dynamic
  `import("./undo")` so the store does not load the undo module at module-init
  time.
- `undo()` and `redo()` (`undo.ts:30-66`) swap snapshots back through
  `setDocument`, with an `enabled` flag that suppresses a recursive push during
  the swap itself.
- `useUndoRedoShortcuts` (`undo.ts:68-103`) wires Cmd+Z / Cmd+Shift+Z / Ctrl+Y to
  the snapshot stack, ignoring key events whose target is a text input or
  contenteditable so typing in the transcript or rename field does not get
  intercepted.

A whole LLM agent batch undoes as one unit because every tool mutation goes
through `setDocument`. The chat service applies each tool call by computing the
next document and calling `saveDocument`; the snapshot is taken at the
`setDocument` boundary of each call, so undoing a batch of N tool calls means N
Cmd+Z presses, and each one unwinds one tool's effect in reverse order. The
batch atomicity a single undo button would need lives in the chat UI's "undo last
agent turn" affordance (not yet wired — see [Known gaps](#known-gaps)).

## Known gaps

- `history.revisions` is declared by the schema but only the renderer snapshot
  stack is populated today. A persisted revision log would let "undo" survive
  app restarts and give users a history view; both are deferred.
- The chat-service undo of a full agent turn is not implemented. The undo button
  undoes one tool call at a time; a per-turn undo would require checkpointing
  the document at the start of each chat turn (one push per turn, not per tool
  call).
- The `agent.baseIntent` field is persisted but not yet populated by the chat
  runtime; the LLM tool loop fills `lastReasoningSummary` only after the v6
  compaction step lands.