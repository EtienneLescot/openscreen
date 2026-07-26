# Export pipeline

The MP4 export drives the same Rust + Direct3D 11 compositor that powers the
live preview ([preview.md](preview.md) /
[native-compositor.md](native-compositor.md)), one segment at a time. The
Electron renderer turns the project document into a `RenderPlan`, the
renderer hands the plan and the per-segment source files to the napi addon
through the `compositor` IPC domain, and the addon drives `poc-d3d`'s
`Player` + `Compositor::compose_frame` + AMF encoder + muxer to write one
`.mp4`. The renderer only watches progress; the actual rendering does not
leave the native process. Performance numbers, the bench, and the rejected
alternatives that drove the design live in
[engineering/rendering-performance.md](../engineering/rendering-performance.md).

GIF and the legacy browser-side path are out of scope here: GIF has no native
encoder yet (it has its own dedicated code path in
`src/lib/exporter/gifExporter.ts`); the legacy path is the one the
`RenderPlan` is being migrated away from.

```mermaid
flowchart LR
    DOC["AxcutDocument"]
    TSD["src/lib/ai-edition/exporter/renderPlan.ts<br/>buildRenderPlan / buildDocumentRenderPlan"]
    RP["RenderPlan<br/>output + segments + virtual-time effects + appearance + cursor + webcam"]
    ADDON["compositor_view.node addon<br/>exportMulti (Electron IPC)"]
    NATIVE["poc-d3d::live::Player<br/>Compositor::compose_frame<br/>h264_amf encoder + mux"]
    FILE["output.mp4"]
    DOC --> TSD --> RP --> ADDON --> NATIVE --> FILE
```

## The `RenderPlan`

`src/lib/ai-edition/exporter/renderPlan.ts` is the pure-logic data model that
turns an `AxcutDocument` into an ordered, per-clip plan. `documentExporter`'s
[`buildDocumentRenderPlan`](../../src/lib/ai-edition/exporter/documentExporter.ts)
is the single boundary that builds it; `ExportDialog` and the bench both go
through it. Every length that crosses the boundary is in seconds or
fractions, every output is in fractions of the output frame, and the plan
itself is JSON-serialisable.

```ts
interface RenderSegment {
  clipId: string;
  assetId: string;
  videoUrl: string;             // toFileUrl(asset.originalPath) — the doc is self-contained
  sourceStartSec: number;       // clip in-point in the asset's media time
  sourceEndSec: number;
  timelineStartSec: number;     // position on the (1:1-with-source, pre-speed) virtual timeline
  timelineEndSec: number;
  intraTrims: Interval[];       // trimRanges of THIS asset inside [start,end)
  cropRegion: CropRegion;       // per-clip screen crop, fractions of the source
  sourceWidth: number;
  sourceHeight: number;
  camera: { videoUrl: string; offsetMs: number } | null;  // per-asset webcam
  cursorSamples: CursorRecordingSample[];                  // partitioned by assetId
}

interface RenderPlan {
  output: { width, height, frameRate, bitrate, codec };
  aspectRatioValue: number;
  segments: RenderSegment[];                  // sorted by timelineStartSec
  zoomRegions: ZoomRegion[];                  // VIRTUAL (output) time, no projection
  annotationRegions: AnnotationRegion[];      // same — captions are derived + joined here
  speedRegions: SpeedRegion[];                // same
  appearance: RenderPlanAppearance;           // wallpaper, padding, radius, shadow, blur, motion
  cursor: RenderPlanCursor | null;            // shared atlas + style; per-segment samples above
  webcam: RenderPlanWebcam;                   // shared layout/style; per-segment source above
}
```

Effects (`zoomRegions`, `annotationRegions`, `speedRegions`) live on the
plan in **virtual** (output) time. The segment loop already tracks the
virtual-time cursor that an earlier design tried to compute up-front by
projecting every region onto source time — that projection is what the TS
exporter still does for the legacy single-source renderer; the segment
loop does not need it.

The plan also carries the `codec` as a WebCodecs encoder string per
user-facing choice (`avc1.640033` for H.264, `hvc1.1.6.L120.90` for H.265,
`vp09.00.10.08` for VP9). The native side's AMF encoder takes those
strings and produces the matching mp4 track family.

`isIdentityFastPathEligible(plan)` is a single boolean: one segment, no
intra-trims, identity crop, no zoom/annotation, no cursor overlay, no
speed, and `output.size === segment.source.size` → the renderer can take a
stream-copy / remux-only fast path. Everything else goes through the full
decode → composite → encode round trip.

## Segment loop

The renderer hands the addon `exportMulti(clips, outPath, sceneJson, params)`
through `compositorViewService.exportMulti`
([`compositorViewService.ts:425`](../../electron/native-bridge/services/compositorViewService.ts)).
The service resolves the same asset paths the renderer used (wallpaper
images, cursor theme sprite) and forwards the call to the addon
([`compositorViewService.ts:437`](../../electron/native-bridge/services/compositorViewService.ts)).
The addon loads `poc-d3d`'s `Player` with the clip list and the shared
`SceneDescription` JSON, then walks the segments with **one** compositor
and **one** encoder + muxer pair:

- Per segment: load metadata, hand the asset to the `Player` (so screen
  and webcam decode land on `poc-d3d`'s shared `ID3D11Device`), drive
  `compose_frame` at the segment's source time, and let the AMF encoder
  consume the rendered RT. The compositor is paused on the live preview
  for the duration of the export (`set_playing(false)` on every active
  preview view), which the addon does automatically — the only cost of
  running export against a live preview is GPU contention from the preview
  still composing; the bench measures that overhead at ~10 % of wall time
  in the measurement scenario, recovered by the auto-pause.

- **Time projection.** The encoder timestamp is contiguous **output**
  time, so junctions between segments are seamless. `compose_frame`
  receives **source** time (`source_t = frame / FPS`), so
  zoom / annotation / cursor match the frame's content even when a speed
  region retimes the segment. An earlier draft proposed keying effects in
  virtual time throughout; that does not survive speed regions, and the
  two-clock split is why.

- **Clips are contiguous** — no gaps, no overlap. The renderer sums
  per-segment rounded frame counts into a single output frame counter;
  audio follows the same integer accumulation (`AudioConcatPlan`).

- **Audio and video junctions are seamless.** Audio is decoded per
  segment up front (`audio.rs::decode_clip_audio`), WSOLA stretches each
  speed sub-segment to its output sample count, and
  `assemble_concatenated_pcm` concatenates the per-segment PCM at the
  integer sample offsets the video loop just produced — never
  `round(cumulativeSec * sampleRate)`, because that compounds per-segment
  rounding error into audible A/V drift across a long multi-segment
  timeline. A short equal-power fade (`cos` on the tail, `sin` on the
  head, `cos² + sin² = 1`) covers each internal boundary to suppress the
  click where two recordings meet butt-joined, without shifting timing.
  The WSOLA stretch is kicked off before the video loop so it overlaps
  the encode and does not add to the wall.

- **Output** is sized to the largest clip and honours the timeline's
  selected aspect ratio. `pickReferenceDimensions` (in `renderPlan.ts`)
  picks the largest source area, then `calculateMp4ExportSettings` maps
  quality + source dims + aspect ratio to the encoder width / height /
  bitrate.

## Per-segment cursor

`CursorRecordingSample.assetId` tags each sample, so the plan partitions
the shared recording per segment (`cursorSamplesForAsset`,
[`renderPlan.ts:178`](../../src/lib/ai-edition/exporter/renderPlan.ts)).
Samples with no `assetId` belong to the primary asset — the convention that
keeps single-asset projects rendering their cursor exactly as before.
Untagged samples were the format before multi-asset cursor tagging
landed; the fallback is the documented behaviour, not a heuristic.

The shared parts of the cursor render — the sprite atlas and the style
knobs (`scale`, `smoothing`, `motionBlur`, `clickBounce`, `clipToBounds`,
`theme`) — live on `plan.cursor` once. The time-varying samples live per
segment on `segment.cursorSamples`. A segment with no cursor samples
renders with no cursor overlay, which is correct (the asset had no
recording), not a gap.

## Output formats and codecs

The native MP4 export takes `width`, `height`, `frameRate`, and `codec` as
parameters on `exportMulti` and writes H.264 (AMF) by default. The user-
facing codec choice (H.264 / H.265 / VP9) is mapped by `renderPlan.ts` to
the WebCodecs encoder string the addon's AMF encoder consumes; VP9
falls back to the same H.264 path on machines without a hardware VP9
encoder (software VP9 was measured too slow and removed — see
[native-compositor.md](native-compositor.md#known-gaps)). GIF is a
separate path through `GifExporter` and does not use the native addon.

## Licensing

The app is MIT and stays MIT. Any bundled ffmpeg must be built **without**
`--enable-gpl` and without `--enable-nonfree` — those flags pull
x264/x265/xvid and fdk-aac, and licensing is all-or-nothing. The same
rule applies to the BtbN build the addon links against (see
[native-compositor.md](native-compositor.md#build)): LGPL-shared
`*lgpl-shared`, not GPL. `scripts/fetch-ffmpeg.mjs` vendors a pinned,
checksum-verified BtbN LGPL build and gates it on three independent
signals (`-L` says "Lesser General Public License"; no GPL flags or GPL
libs in `-buildconf`/`-version`; no `libx264` / `libx265` in
`-encoders`). It fails closed.

Note `ffmpeg -version` has **no** `License:` line — only `configuration:`.
The licence text is behind `-L`. An early gate looked for the former,
found nothing, and refused to vendor anything; failing closed is why that
was a bug and not an incident.

## Traps this pipeline has actually fallen into

Each cost hours and each produced a confident, wrong conclusion.

1. **`app.getGPUFeatureStatus()` from a windowless script** reports
   everything `disabled_software`. Always probe with a real window.
2. **Piping via `cat` under Git Bash** caps at ~70 MB/s — MSYS emulation,
   not Windows.
3. **`new VideoFrame(canvas)` is lazy.** Timing the constructor measures
   nothing.
4. **Isolated component benchmarks cannot price the cost of connecting
   the component.** A `node → ffmpeg` probe measured 489–589 MB/s by
   materialising frames **once**, outside the timed loop — a true
   statement about the pipe that said nothing about the pipeline.
5. **`-encoders` lists what was compiled in, not what the machine can
   run.** A portable build lists nvenc/qsv/amf everywhere; on this AMD
   laptop nvenc dies with "Cannot load nvcuda.dll". Only a one-frame
   smoke encode settles it — and the unit tests passed *because the
   fixtures encoded the same wrong assumption as the code*.
6. **Electron cannot transfer an `ArrayBuffer` renderer→main.** The
   transfer list takes `MessagePort[]`; transferring a buffer silently
   drops the whole message
   ([electron#34905](https://github.com/electron/electron/issues/34905)) —
   it works renderer→renderer.
7. **`Buffer.from(typedArray)` copies.** Wrapping
   (`Buffer.from(buf.buffer, byteOffset, byteLength)`) measured +31 %.
8. **A stale `dist-electron` bundle** runs the *previous* main process
   against the new renderer. It read as "export IPC not registered" once
   and as "the bench flag does nothing" once. The bench now refuses to
   run against one.
9. **The installed app (`openscreen.exe`) holds the same single-instance
   lock as the dev build.** A launch exits 0 and reports nothing —
   silently.

## A truncated project file is unopenable, not partially readable

`listProjects` skips a project whose JSON does not parse, so a truncated file
presents as a project that has vanished rather than as an error. Worth knowing
when a bench fixture disappears.

Two concurrent saves used to be able to produce exactly that. They no longer can:
`DocumentService` serialises saves through a per-project write queue and writes
atomically (unique temp file → `fsync` → rename, `electron/ai-edition/document-service.ts:354`).
One fixture from before the fix is still corrupt — see the Known gaps in
[../engineering/rendering-performance.md](../engineering/rendering-performance.md).

The reason that one was never repaired is the useful part: its recoverable prefix
had `speedRegions: 0, zoomRegions: 0` while the real timeline held two 3× speed
regions and a 1.80× zoom. Truncating to the valid prefix would have returned a
project that opened cleanly and was silently stripped of its effects. **A partial
document that parses is more dangerous than one that does not** — which is why the
loader rejects rather than salvages.