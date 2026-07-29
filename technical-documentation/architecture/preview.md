# Preview

The preview is the editor's frame-at-the-playhead surface. It is composited by the same
Rust + Direct3D 11 native crate that drives MP4 export — `crates/compositor/` reached via the
`compositor_view.node` napi-rs addon — and pulled into the renderer as an RGBA8
bitmap that paints onto an HTML `<canvas>`. The DOM around the canvas hosts the
interactive-only layers (zoom gimbal, annotation selection, PiP webcam drag) that
need real hitboxes. Everything visible in the preview comes out of the same
compositor that writes the export; parity is the property of one renderer, not a
discipline across two.

This document describes the live composition path. The export pipe
([architecture/export-pipeline.md](export-pipeline.md)) shares the same compositor
and scene contract; the GPU-resident path it builds on is documented in
[architecture/native-compositor.md](native-compositor.md). Performance numbers
(preview fluidity, bench methodology, the trade-offs that drove this design) live
in [engineering/rendering-performance.md](../engineering/rendering-performance.md).

## The compositor path

One compositor exists in the source tree, and it is the live one. A Pixi/WebGL
single-canvas screen compositor was tried alongside it and removed once it was
established that nothing mounted it.

### Native D3D compositor overlay (live)

Mounted as the first child of `.previewFrame` by
[`NativeCompositorOverlay.tsx`](../../src/components/ai-edition/NativeCompositorOverlay.tsx).
It owns the `<canvas>`, drives a `useNativeCompositorView` hook that allocates an
offscreen `compositor_view` view sized to the canvas's device-pixel rect
([`useNativeCompositorView.ts:73`](../../src/native/hooks/useNativeCompositorView.ts:73)),
and pushes a `SceneDescription` JSON every time the document or the editor
settings change. Wallpaper, screen video, webcam, cursor, zoom regions, annotations
— every visible pixel comes from this view. The DOM neighbours it (the `.screenStage`
wrapper, the `<video>` for screen decode, the `WebcamOverlay` `<video>`, the
`AnnotationLayer`, the `ZoomFocusOverlay`, the webcam drag hitbox) are *interactive
overlays*: their pixels are hidden in CSS, only their pointer-event geometry counts.

The path is enabled by the *presence of the native addon* — there is no flag,
no capability probe, no per-document switch. The compositing service loads
`compositor_view.node` at startup via
[`compositorViewService.ts`](../../electron/native-bridge/services/compositorViewService.ts:271)
(`ensureAddon`); when the binary is missing the service logs once
(`[compositor-view] native addon not present; running as no-op`,
[`compositorViewService.ts:288`](../../electron/native-bridge/services/compositorViewService.ts:288))
and returns synthetic negative view ids whose `readFrame` always returns `null`, so
the whole overlay stays inert. In that mode the renderer's own `<video>` element
keeps playing (decode is the responsibility of the DOM, not the compositor), but
nothing composites a frame — the canvas stays empty. The editor ships like this
on platforms where the addon isn't built; the dev build brings the addon in.

The renderer→addon IPC goes through `native-bridge:invoke` with a single
`compositor` domain
([`compositorViewClient.ts:24`](../../src/native/compositorViewClient.ts:24)). The
service in the main process loads the addon from
`electron/native/bin/<platform>-<arch>/compositor_view.node` (packaged) or
`electron/native/compositor-view/build/compositor_view.node` (dev), with an
`OPENSCREEN_COMPOSITOR_VIEW_NODE` env override for the standalone builds. The
ffmpeg shared-DLL directory is prepended to `PATH` before the require so the
addon's `LoadLibrary("avcodec-NN.dll")` resolves against the same pinned build the
crate links against
([`compositorViewService.ts:206`](../../electron/native-bridge/services/compositorViewService.ts:206)).

There is no fallback to a CPU/Canvas2D legacy compositor: before the native view
ships a frame, only the wallpaper painted by CSS is visible, and the cursor / zoom
DOM layers depend on the layout math (not the compositor) to know where to land.
That is a product gap, not a fallback path. The native preview is the only
compositor in service.

## Scene description

`document → SceneDescription → JSON` is the contract the app hands the native
compositor so it can compute the composed frame itself; the renderer does no
per-frame math.

[`buildSceneDescription`](../../src/native/sceneDescription.ts:419)
(`src/native/sceneDescription.ts`) is a pure data mapping from an `AxcutDocument` plus the
current editor settings to a `SceneDescription` JSON string. It resolves:

- **Visible clips.** [`resolveVisibleClips`](../../src/native/sceneDescription.ts:411)
  is the single shared clip list: `resolvePlaybackSegments(document.timeline.clips, document.timeline.trimRanges)`
  (trim-narrowed, so word-level cuts from the transcript editor actually reach the
  compositor instead of only affecting the transcript panel's own strikethrough)
  sorted by `timelineStartSec` and filtered to clips whose asset has a resolvable
  `originalPath`. The same call backs `buildSceneDescription`, the native-export
  clip list in `ExportDialog`, and the active-clip lookup in
  `NativeCompositorOverlay` — three previously-divergent sites that are now the
  same expression.
- **Scene regions.** Zoom, Full Camera, speed, annotations, and captions are stored
  in *RAW document* time (trims still occupy their place) but applied at each
  frame's *source time* (the compositor matches each decoded frame's PTS, not a
  timeline counter). [`projectRegionsToSource`](../../src/lib/ai-edition/timeline/timelineMap.ts)
  bridges the two reference frames by resolving each region against every visible
  segment's own raw extent and emitting one entry per source-time span it covers,
  tagged with the segment's `clipIndex`. Captions piggyback on annotations
  (`captionCuesToTextRegions` produces text annotations at the same zIndex layer)
  so the compositor draws them with the same path; deliberately no separate
  caption layer in the native code.
- **Layout.** The webcam rect is resolved by the same
  [`computeCompositeLayout`](../../src/lib/compositeLayout.ts) call the legacy
  `frameRenderer` runs and shipped to the addon as `layout.webcamRect` /
  `layout.screenRect` in fractions of the output frame. The native side consumes
  those verbatim and applies the padding-slider and reactive-zoom adjustments on
  top, so preview/export never disagree on placement. Per-clip screen resolutions
  and crops mean a multi-clip document that mixes recording shapes (e.g. a 16:9
  screen crop clipped to 9:16 beside another native 9:16 clip) lays out exactly
  like a single recorded ratio; `layout.layoutByClip` is index-aligned with
  `clips` and `cropByClip` and the Rust `for_clip_window` selects the entry for
  the clip being composed.
- **Lengths as fractions.** Every length that crosses the contract is a fraction
  of its own reference box — `roundnessFrac` of the output frame's short side,
  `screenRadiusFrac` of the screen box's short side, annotation `x/y/w/h` of the
  screen rect, `padding` 0..1. There are no render-target pixels in the payload:
  the native compositor rasterises the preview into a small contain-fitted frame
  and the export at full output size, so a pixel meant two different things on
  the two sides of the boundary; a fraction has no unit to get wrong. The slider
  itself stays in pixels for the user — the division happens once, here.

The descriptor mirrors the Rust struct in
[`crates/compositor/src/scene.rs`](../../crates/compositor/src/scene.rs); field rename is `camelCase`
on both sides. The Rust consumer (`compositor.rs::compose_frame`,
[`crates/compositor/src/compositor.rs:1421`](../../crates/compositor/src/compositor_windows.rs:1421)) reads
the JSON per frame, derives the per-clip and per-frame values it needs (zoom
state from `regions.rs::zoom_state_at`, camera-fullscreen progress from
`regions.rs::camera_fullscreen_progress_at`, screen crop from
`SceneCrop::belongs`), and only then issues GPU draw calls. Region visibility is
expressed as `[startSec, endSec)` intervals and matched against `t = source_time`;
a region straddling a clip boundary emits one entry per covered clip via
`projectRegionsToSource`.

## Frame delivery

The native compositor runs *off-screen* (no OS window, no HWND ever crosses
IPC), and the renderer pulls composed frames out of it. The protocol is the load-bearing
contract between the two:

```ts
readFrame(id: number, sinceGen: number): { gen, width, height, data } | null
```

(`addons.d.ts` declares it as `CompositorViewAddon.readFrame`,
[`electron/native/compositor-view/addon.d.ts:93`](../../electron/native/compositor-view/addon.d.ts:93);
the renderer-facing type is `CompositorFramePacket`,
[`contracts.ts:120`](../../src/native/contracts.ts:120).)

The contract, with the invariant on the consumer side:

1. **Self-describing packet.** A returned object carries its own
   `width`/`height`/`data`. The drawing buffer is resized to those values
   *before* `putImageData` runs
   ([`useNativeCompositorView.ts:195`](../../src/native/hooks/useNativeCompositorView.ts:195)),
   so pixels and canvas can never drift apart: there is no separate source of
   truth for "how big the bitmap is right now" — every packet carries it.
2. **Generation-gated.** `gen` is a monotonic per-frame generation (≥ 1). The
   renderer holds the last one it painted and passes it back as `sinceGen`; the
   addon returns `null` whenever `gen <= sinceGen`. An idle preview pays
   nothing: no buffer clone, no IPC crossing, no canvas copy, no `putImageData`.
   The null return is the dominant case while the preview sits still (paused
   editing). One in-flight `readFrame` at a time
   ([`useNativeCompositorView.ts:155`](../../src/native/hooks/useNativeCompositorView.ts:155))
   so two responses can't land out of order and rewind `lastGen`.
3. **`data` is RGBA8, `width * height * 4` bytes.** The renderer wraps it via
   `new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength)` —
   `ImageData` rejects `SharedArrayBuffer`-backed arrays, and the IPC binary is
   never shared, so the cast is safe. `createImageBitmap` decodes off the main
   thread (UI stays at 60/120 Hz) and snapshots the view, then `putImageData` is
   the synchronous fallback if bitmap creation is unavailable.
4. **Verify before trusting.** `data.byteLength !== width * height * 4 || width === 0 || height === 0`
   is a hard bail
   ([`useNativeCompositorView.ts:190`](../../src/native/hooks/useNativeCompositorView.ts:190)):
   a mismatch would corrupt the image silently. The consumer never assumes a
   size — every draw is preceded by a resize of the canvas's drawing buffer to
   the packet's declared `width`/`height`.
5. **Pull loop cadence.** The renderer pulls on every other rAF tick (`PULL_LOOP_TICK_DIVISOR = 2`,
   [`useNativeCompositorView.ts:70`](../../src/native/hooks/useNativeCompositorView.ts:70)),
   so IPC + GPU readback + `putImageData` run at roughly 30 fps on 60/120 Hz
   displays without changing perceived smoothness.

The renderer-side wrapper mirrors this verbatim in the Electron main process
([`compositorViewService.ts:339`](../../electron/native-bridge/services/compositorViewService.ts:339)),
so when the addon is absent the IPC layer returns `null` too — the renderer
never has to special-case "addon missing".

## Playback sync

The native view runs its own clock while playing, so the renderer only pushes a
seek when the user actually *moves* the playhead (scrub, step, or wrap-around to
a new clip). The mapping sits in
[`useNativePlaybackSync.ts`](../../src/native/useNativePlaybackSync.ts).

- **Play / pause → free-run.** `setNativePlaying` toggles the addon's free-run
  decoder. While playing, `currentTimeSec` ticks every rAF in the renderer;
  pushing that per tick would force a rewind+seek seek each frame *and* fight
  the addon's free-run (the render thread prioritises app-requested frames over
  free-run). So `useNativePlaybackSync` only pushes `setNativeTime` while the
  transport is paused.
- **RAW → native source.** The playhead `currentTimeSec` is in *RAW virtual*
  time (trims still occupy their space on the ruler — same reference the V4
  timeline and the webcam overlay use), but the native stream plays *compressed*
  segments (`resolveVisibleClips`, trims removed). `resolveNativePosition`
  bridges the two: it maps the RAW playhead via `document.timeline.clips` (the
  raw layout) to find the segment that contains it, then returns the segment's
  `clipIndex` + source time. Without this bridge a RAW playhead against a
  compressed clip list pointed at the wrong clip after a trim — wrong camera,
  misaligned screen.
- **Drift re-anchor.** During free-run the two clocks can drift; once the
  additive error exceeds 100 ms (`Math.abs(sourceTimeSec - expectedSourceTimeSec) > 0.1`,
  [`useNativePlaybackSync.ts:94`](../../src/native/useNativePlaybackSync.ts:94))
  the hook re-issues `setNativeTime`. `useNativePlaybackSync:18` calls this a
  known limitation acceptable for the ~6 s fixture it's measured on; a pause
  resets the drift by construction.

The overlay's rect is kept aligned with the DOM via the same primitives used
elsewhere in the renderer:

- `computeDeviceRect` (`src/native/nativeViewRect.ts`) turns
  `getBoundingClientRect()` into a device-pixel `CompositorViewRect`,
  rounding every axis to dodge the truncated / off-by-one windows the addon
  produces on non-integer inputs.
- `rectsEqual` skips the `setRect` push when nothing has changed
  ([`nativeViewRect.ts:33`](../../src/native/nativeViewRect.ts:33)) — the
  the ResizeObserver (`useNativeCompositorView.ts:259`) and a coalesced rAF
  schedule steady-state scrolling and resizes without re-pushing the rect.
- The overlay reuses the canvas's CSS `width: 100%; height: 100%` for its
  display box (`NativeCompositorOverlay.tsx:217`); the addon's `rect.x`/`rect.y`
  are vestigial (ignored native-side per
  [`addon.d.ts:18`](../../electron/native/compositor-view/addon.d.ts:18) and
  kept on the wire for source compatibility).

Clip changes across the playhead boundary are atomic at the
`setActiveClip(viewId, screenPath, webcamPath, webcamOffsetSec, clipIndex, sourceTimeSec)`
RPC
([`compositorViewClient.ts:93`](../../src/native/compositorViewClient.ts:93)):
when the playhead crosses into a clip whose `assetId` / `webcamPath` differs
from the previous one, `NativeCompositorOverlay.tsx:175-203` pauses native across
the decoder swap, awaits `setActiveClip`, and re-reads the live transport *now*
(not from a captured `isPlaying`) before resuming — so a user pause that lands
in the middle of a clip transition is honoured, not silently undone.

## Known gaps

- **Live preview is video-only.** `crates/compositor/src/live.rs` (1628 lines) handles only
  the video packet stream; audio is decoded and mixed in
  [`audio.rs::decode_clip_audio`](../../crates/compositor/src/audio.rs) for the export
  path and not for the live view. Editing playback is therefore silent against
  the exported file; users hear audio only when the export runs. There is no
  flag in this branch that re-routes live audio.
- **Long-recording scrub drift.** `useNativePlaybackSync:18` documents the
  accepted-at-fixture-time drift between the app's rAF playhead and the addon's
  free-run clock as a known limitation; a pause re-aligns them. A scrub further
  than 100 ms past expected position triggers an explicit re-anchor; below that
  the two clocks run independently until something forces a sync. Long recordings
  measured at the bench in
  [engineering/rendering-performance.md](../engineering/rendering-performance.md)
  stay below the threshold in practice, but no systematic measurement exists.
- **Add-on absent = blank frame.** When `compositor_view.node` is missing
  (development with the addon not yet built, or a packaged build for an
  unsupported architecture) the overlay renders no pixels: only the DOM/CSS
  wallpaper and the interactive layers show. There is no CPU/Canvas2D fallback
  path; the live preview is gated on the addon being present.

## A single frame, end-to-end

The labelled arrows are the IPC + state edges; everything inside one box is in-process.

```mermaid
sequenceDiagram
    participant Doc as AxcutDocument
    participant TSD as src/native/sceneDescription.ts
    participant Overlay as NativeCompositorOverlay.tsx
    participant Hook as useNativeCompositorView.ts
    participant IPC as native-bridge:invoke<br/>(compositor domain)
    participant Svc as compositorViewService.ts
    participant Addon as compositor_view.node
    participant Canvas as renderer <canvas>

    Doc->>TSD: buildSceneDescription(doc, settings)
    TSD-->>Overlay: SceneDescription JSON
    Overlay->>IPC: setScene(viewId, json)
    IPC->>Svc: dispatch
    Svc->>Addon: setScene(id, json)

    Overlay->>Hook: ResizeObserver on canvas
    Hook->>IPC: setRect(viewId, deviceRect)
    IPC->>Svc: dispatch
    Svc->>Addon: setRect(id, rect)
    Addon-->>Svc: ok

    Note over Addon,Canvas: compositing thread runs off-screen<br/>(D3D11VA decode → compositor → RGBA8 staging)

    loop every other rAF tick (~30 fps)
        Hook->>IPC: readFrame(viewId, lastGen)
        IPC->>Svc: dispatch
        Svc->>Addon: readFrame(id, sinceGen)
        alt same generation or no frame
            Addon-->>Svc: null
            Svc-->>Hook: null
            Hook-->>Canvas: (canvas untouched, idle path costs nothing)
        else new generation
            Addon-->>Svc: { gen, width, height, data }
            Svc-->>Hook: { gen, width, height, data }
            Hook->>Hook: validate byteLength === width*height*4
            Hook->>Canvas: canvas.width = width; canvas.height = height<br/>createImageBitmap → drawImage
            Hook->>Hook: lastGen = gen
        end
    end

    Overlay->>IPC: setActiveClip(viewId, screenPath, webcamPath,<br/>webcamOffsetSec, clipIndex, sourceTimeSec)
    IPC->>Svc: dispatch
    Svc->>Addon: setActiveClip(...)
    Overlay->>IPC: setPlaying(viewId, playing) (per play/pause)
    IPC->>Svc: dispatch
```
