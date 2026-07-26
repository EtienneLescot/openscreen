# Timeline coordinate model — clip-anchored modifiers

A modifier (zoom, speed, annotation, full-camera) in the project document is **anchored
to a clip in that clip's own source time**, not to an absolute timeline position. The
single module that knows how the three coordinate frames relate —
[`src/lib/ai-edition/timeline/timelineMap.ts`](../../src/lib/ai-edition/timeline/timelineMap.ts) —
is the only place that translates between them. Every consumer — the timeline UI, the
native preview, the export, the agent LLM, the captions layer — reads the modifier
through that module and never mixes the frames by hand. The v4→v5 migration that
introduced the clip anchor is documented in
[document-model.md](document-model.md); this file is about the model in force and the
contract of `timelineMap`.

## Two time reference frames

The document carries three coordinate systems. A raw clip is identity between
source-time and raw-virtual-time (no speed is baked into its geometry), so within a
clip raw↔source is a plain shift by the clip's own start offset. The interesting
boundary is between the **RAW** ruler and the **COMPRESSED** playback sequence:

| Frame | Definition | Who works in it |
|---|---|---|
| **RAW virtual** (`currentTimeSec`, the ruler, the playhead, `document.timeline.clips[].timelineStartSec`/`timelineEndSec`) | The ruler the user manipulates. **Trims still occupy their space.** Region authoring, clip drag/resize/reorder, and the timeline ruler all happen here. | `NewEditorShell` (transport, seek), `V4Timeline` (drag/resize of clips and pills), `useTimeline` (every region mutation), `document.timeline` ops |
| **SOURCE** (a clip's own media time: `assetId` + `sourceStartSec`/`sourceEndSec`) | What the decoders and the native compositor actually advance. Region anchors (`clipId` + `sourceStartSec` + `sourceEndSec`) live here. | `NativeCompositorOverlay`, `useNativePlaybackSync`, `sceneDescription` (→ native preview), `documentExporter` (multi-clip export) |
| **COMPRESSED** (the trim-narrowed `resolvePlaybackSegments` laid out back-to-back from 0) | What the native free-run stream and the export frame counter walk through. Indexed by `clipIndex` into `SceneDescription.clips`. | `buildSceneDescription` (`sceneDescription.ts`), the native compositor's `clip_index` field, `exportMultiNative` |

The model splits the two so each consumer can read what it cares about without having
to translate. Mixing them desyncs preview from render on zoom and trim: a region
authored against the RAW ruler but projected against the COMPRESSED segment layout
slips by exactly the trimmed duration, fires on the wrong clip, and pairs with the
wrong camera. `timelineMap` is the single line that keeps that line of code from
existing.

## Clip-anchored modifiers

Every region (zoom / speed / annotation / cameraFullscreen) is stored as one or more
**clip-anchored fragments** — `{clipId, sourceStartSec, sourceEndSec, …payload}` — keyed
to the clip it lives on, in that clip's source media time. A region the user drew
across a clip boundary is stored as one fragment per covered clip; the fragments carry
no marker tying them together, but the ruler still renders them as one pill because
they share the same properties (see rule 1 below). Trims narrow a clip's kept source
ranges, so an anchored fragment is hidden/clipped by the same interval math with no
reprojection; reorder carries the fragment with its `clipId`, again with no
reprojection. The schema field `startMs`/`endMs` is a **derived cache** of the
fragment's current RAW ruler span — it is present so that un-migrated consumers and
the agent LLM (which reasons in virtual seconds) keep reading the shape they always
did, but the anchor is the source of truth. A structural op (move/duplicate/trim)
re-derives `startMs`/`endMs` from the anchor; if the cache ever disagrees with the
anchor, the anchor wins.

This is the data-level expression of the authoring-levels diagram in
[overview.md](overview.md#authoring-levels): modifiers are presented above the timeline
in the UX but stored down on the clip in the data.

## The `timelineMap` contract

Every public export of
[`src/lib/ai-edition/timeline/timelineMap.ts`](../../src/lib/ai-edition/timeline/timelineMap.ts).
"Direction" is what flows in vs what flows out.

| Function | What it converts | Direction |
|---|---|---|
| `anchorRawRegionsToClips` (`:51`) | v4 RAW-virtual-ms region → one anchored fragment per covered clip (drops zero-length / off-timeline regions) | RAW-virtual → clip-anchored |
| `anchorRegionsWithDerivedMs` (`:376`) | Same as above but never drops user data: emits `{…fragment, startMs, endMs}` for anchored regions and passes un-anchorable regions through with their original ms | RAW-virtual → v5 stored shape |
| `anchoredToRawSpanSec` (`:92`) | One anchored fragment → its current RAW-virtual span on the ruler | clip-anchored → RAW-virtual |
| `regionIdentityKey` (`:163`) | A region → canonical identity key (properties minus position/provenance); equal keys = "same kind, same look" | region → identity string |
| `coalesceByIdentity` (`:193`) | Set of identified spans → merged runs that touch and share an identity | spans → pills |
| `clampSpanAgainstNeighbours` (`:223`) | A desired span clamped against different-identity neighbours (no cascade) | desired → clamped span |
| `coalesceRegionsForRuler` (`:251`) | Region array → ruler pills (one entry per merged run, payload carried by `member`) | regions → pills |
| `resolvePillIds` (`:275`) | Region id → every region id under its pill (recomputed, not stored) | id → ids |
| `dropPillById` / `dropPillsByIds` (`:290` / `:299`) | Delete every region under a pill (resolved from the merge rule) | regions → regions |
| `replacePillSpan` (`:316`) | Move/resize a pill: clamp against different-identity neighbours, then re-anchor to the clamped span | pill + clip layout → re-anchored fragments |
| `segmentRawSpanSec` (`:401`) | One kept playback segment → its RAW-virtual extent | segment → RAW span |
| `projectRegionsToSource` (`:452`) | Region array → source-ms entries with `clipIndex` for native (anchored path uses anchor; unanchored path falls back to RAW mapping through each segment's own raw extent — never drops an un-anchorable region onto an unrelated clip) | RAW/anchored → source + `clipIndex` |
| `resolveNativePosition` (`:556`) | RAW-virtual playhead → `{clip, clipIndex, sourceTimeSec}` for the active native decoder + paired camera (snaps to the next kept segment when the playhead sits over a trimmed-out stretch) | RAW-virtual → source + `clipIndex` |

The two **universal region rules** every region kind obeys are expressed once in this
file rather than re-derived per kind:

1. **Merge** (`coalesceByIdentity`) — two regions of the same kind with the same
   identity that touch are one pill. How they became adjacent (authored side by side,
   split by a reorder then rejoined, …) is irrelevant; identity is what a region *is*,
   not where it came from.
2. **Repel** (`clampSpanAgainstNeighbours`) — two regions of the same kind with
   different identities may not overlap. An edit clamps to the neighbour's edge; the
   neighbour never moves (no cascade).

A kind with no properties (trim, full-camera) collapses to a constant identity, so its
regions always merge — the long-standing trim behaviour, now derived from the general
rule.

## Invariants

A change that breaks one of these is wrong even if every test passes; treat them as
the contract a reviewer can grade against. Each is asserted in
[`timelineMap.test.ts`](../../src/lib/ai-edition/timeline/timelineMap.test.ts).

- **Anchor wins over the cache.** A region with a complete `{clipId, sourceStartSec,
  sourceEndSec}` lands on its source span regardless of what `startMs`/`endMs` say.
  (`projectRegionsToSource`, anchored path — see the "places an anchored region from
  its anchor, ignoring a stale startMs/endMs" test.)
- **RAW ↔ source within one clip is identity.** A region's anchor `[a, b]` on a clip
  whose `sourceStartSec = 0` lands on source `[a, b]`. Speed is not baked into the
  geometry — the clip is a flat re-mapping, never a stretch.
- **A trim is invisible to a region's source moment.** Identity clip `src[0,10]` with a
  trim at `[2,4]`: a region authored at RAW `[6,8]` lands on source `[6,8]`, not
  `[8,10]`. (`resolveNativePosition` / `projectRegionsToSource` "keeps a region on its
  source moment despite a trim before it".)
- **A region fully under a trim is dropped, never leaked.** Two clips of *different*
  assets whose source windows overlap numerically: a zoom fully trimmed away on its
  own clip must not re-appear on the later clip. (`projectRegionsToSource` "drops a
  region a trim removes entirely rather than leaking it onto a later clip".)
- **Same-identity, same-clip stays one pill; different-identity does not merge.** Two
  regions of equal properties that touch → one pill; touch with one property
  changed → two pills, with no memory of ever having been one. (`coalesceByIdentity`
  and `replacePillSpan` "clamps a resize at a neighbouring pill of different
  properties (magnet)".)
- **Repel never cascades.** A different-identity neighbour acts as a wall — the
  edited span stops at its edge and the neighbour never moves. (`clampSpanAgainst
  Neighbours` "stops at a different-identity neighbour on the right" / "left".)
- **Identity ignores provenance.** `id`, `clipId`, `sourceStartSec`, `reason`,
  `origin`, `source`, `annotationSource`, and the legacy `groupId` are *not* part of
  the identity key. Two regions that differ only in any of those still merge when
  adjacent. (`regionIdentityKey` "ignores position and provenance entirely" and the
  regression test "merges two independently authored regions that carry DIFFERENT
  legacy groupIds".)
- **Re-anchoring drops `groupId`.** A v4 import may carry a `groupId`; after a write
  or migration it is gone. (`anchorRegionsWithDerivedMs` "drops groupId when
  re-anchoring, so it stops propagating".)
- **`visibleSegments` ordering matches `SceneDescription.clips`.** The `clipIndex`
  emitted by `projectRegionsToSource` / `resolveNativePosition` lines up with the
  native stream because both consume the same array in the same order. Passing a
  different array (e.g. already-sorted segments) to the projection while sending the
  original to the native bridge silently desyncs the mapping.
- **A region that covers no clip is dropped by ventilation** (`anchorRawRegionsToClips`
  / `ventilateSpanAcrossClips`), and `anchorRegionsWithDerivedMs` passes it through
  unanchored so the data is not lost. The two layers disagree on purpose — the
  low-level primitive is for explicit projection, the migration wrapper is for
  preserving user data.
- **A region authored on a clip that was later deleted disappears** (anchor resolves
  to null, the fragment is not shown). Its id is preserved in the document so undo
  restores it with its anchor.

## SSOT façades

When the timeline shape changes — a new field on a region, a new region kind, a
change to the anchor contract — every one of these readers/writers must be updated
in the same commit, or the project round-trips into an inconsistent state:

| Consumer | File | What it reads / writes |
|---|---|---|
| **Document layer (ops)** | `src/lib/ai-edition/document/timeline.ts` | Region CRUD; calls `rederiveRegionMs` (cache-only) and `reanchorRegions` (rebuilds identities); routes every mutation through `timelineMap`. |
| **Schema v4→v5 preprocess** | `src/lib/ai-edition/schema/index.ts` (`documentSchema` v4→v5 preprocess, `:555-595`) | Re-anchors `zoomRanges`, `annotations`, `legacyEditor.speedRegions`, `legacyEditor.cameraFullscreenRegions` on every parse. The single disk-load site. |
| **Timeline UI** | `src/components/ai-edition/v4/V4Timeline.tsx` | Reads lanes through `coalesceRegionsForRuler` (`:321, :329, :337, :347`) and `coalescedTrimGroups` (`:363`); pill edit hits the pill resolved by `resolvePillIds` via the store. |
| **Inspector selection pane** | `src/components/ai-edition/v4/FloatingInspector.tsx` (`SelectionPane`, `:444`) | Edits a selected region by pill id; routes through `useTimeline` and therefore through `replacePillSpan`. |
| **Store / authoring (UI)** | `src/lib/ai-edition/store/useTimeline.ts` | Every `add*`, `update*Span`, `removeRegion` goes through `anchorRegionsWithDerivedMs` (`:134, :163, :278, :305, :329`) and `replacePillSpan` / `dropPillsByIds` / `resolvePillIds`. |
| **Native preview scene** | `src/native/sceneDescription.ts` (`:489, :508, :517, :531`) | Calls `projectRegionsToSource` for every region kind before serialising to the native compositor. |
| **Native playback sync** | `src/native/useNativePlaybackSync.ts` (`:22, :39`) | Resolves the RAW playhead through `resolveNativePosition` to feed `setActiveClip` / `presentTime`. |
| **Native compositor overlay** | `src/components/ai-edition/NativeCompositorOverlay.tsx` (`:3, :70`) | Same — `resolveNativePosition(currentTimeSec, nativeClips, document.timeline.clips)` — to keep preview in sync with the timeline ruler. |
| **Multi-clip export** | `src/lib/ai-edition/exporter/documentExporter.ts` | Projects regions to source per-clip through `region-ventilation`'s `projectRegionsToSourceTime`; identity single-clip projects are unchanged. |
| **Captions layer** | `src/lib/ai-edition/captions/cues.ts` (`:14-15` and `captionCuesToTextRegions`) | Caption cues are a derived view of the transcript; the projection to source at export goes through `projectRegionsToSourceTime` from `region-ventilation`, matching the multi-clip export path so preview and file agree. |
| **Agent LLM tools** | `electron/ai-edition/agent-tools.ts` (`:22-26, :80-95, :560-575, :772-820, :835-880, :952, :1025`) | Writes the same shape via `anchorRegionsWithDerivedMs` / `replacePillSpan` / `resolvePillIds`; reads it through `coalesceRegionsForRuler` (`coalesceForAgent`, `:77-86`) so the model reasons in virtual seconds over whole pills. |

## Known gaps

- `legacyEditor.speedRegions` and `legacyEditor.cameraFullscreenRegions` are migrated
  on every parse via the schema preprocess, but a project whose `legacyEditor` blob
  is rewritten by an older code path before the v5 preprocess runs may briefly carry
  the un-anchored form downstream. The single parse-time entry point keeps the
  surface small but does not make it impossible; the regression is caught by
  `migrate.test.ts`.