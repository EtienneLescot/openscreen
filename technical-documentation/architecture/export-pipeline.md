# Export pipeline

The MP4 export drives the same Rust + Direct3D 11 compositor that powers the
live preview ([preview.md](preview.md) /
[native-compositor.md](native-compositor.md)), one segment at a time. The
Electron renderer turns the project document into the same `SceneDescription`
the live preview uses plus an ordered clip list, hands both to the napi addon
through the `compositor` IPC domain, and the addon drives `openscreen-compositor`'s
`Player` + `Compositor::compose_frame` + AMF encoder + muxer to write one
`.mp4`. The renderer only watches progress; the actual rendering does not
leave the native process. Performance numbers, the bench, and the rejected
alternatives that drove the design live in
[engineering/rendering-performance.md](../engineering/rendering-performance.md).

GIF is out of scope here: it has no native encoder yet, so it keeps its own
dedicated code path in `src/lib/exporter/gifExporter.ts` — the one format
the document adapter still renders in the renderer.

```mermaid
flowchart LR
    DOC["AxcutDocument"]
    TSD["src/native/sceneDescription.ts<br/>resolveVisibleClips / buildSceneDescription"]
    RP["clips + SceneDescription JSON<br/>layout + effects + background + zoom + cursor + webcam"]
    ADDON["compositor_view.node addon<br/>exportMulti (Electron IPC)"]
    NATIVE["openscreen_compositor::live::Player<br/>Compositor::compose_frame<br/>h264_amf encoder + mux"]
    FILE["output.mp4"]
    DOC --> TSD --> RP --> ADDON --> NATIVE --> FILE
```

## Segment loop

The renderer hands the addon `exportMulti(clips, outPath, sceneJson, params)`
through `compositorViewService.exportMulti`
([`compositorViewService.ts:425`](../../electron/native-bridge/services/compositorViewService.ts)).
The service resolves the same asset paths the renderer used (wallpaper
images, cursor theme sprite) and forwards the call to the addon
([`compositorViewService.ts:437`](../../electron/native-bridge/services/compositorViewService.ts)).
The addon loads `openscreen-compositor`'s `Player` with the clip list and the shared
`SceneDescription` JSON, then walks the segments with **one** compositor
and **one** encoder + muxer pair:

- Per segment: load metadata, hand the asset to the `Player` (so screen
  and webcam decode land on `openscreen-compositor`'s shared `ID3D11Device`), drive
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

- **Audio and video junctions are seamless.** Audio is decoded per clip
  (`audio.rs::decode_clip_audio`), a libavfilter `atempo` chain stretches
  each speed sub-segment to its output sample count, and
  `assemble_concatenated_pcm` concatenates the per-segment PCM at the
  integer sample offsets the video loop just produced — never
  `round(cumulativeSec * sampleRate)`, because that compounds per-segment
  rounding error into audible A/V drift across a long multi-segment
  timeline. A short equal-power fade (`cos` on the tail, `sin` on the
  head, `cos² + sin² = 1`) covers each internal boundary to suppress the
  click where two recordings meet butt-joined, without shifting timing.
  The in-tree WSOLA stretcher is still there, but only as the fallback
  `stretch_pcm_to_length` takes when the filter chain cannot be built,
  negotiates a format the drain does not read, or still comes up short of
  the target after the corrected pass (see
  [Audio](native-compositor.md#audio)).

- **The stretch is not overlapped with the encode.** Decode and stretch
  run inside `walk_composited_timeline`'s `on_clip_end` callback
  (`pipeline.rs`), which fires once per clip *after* that clip's frames
  have been composed and submitted to the encoder, on the same thread —
  so the stretch time is added to the export wall, not hidden behind it.
  `progress()` counts composed frames as they are handed to the encoder,
  and nothing calls it during the audio phase, so a long clip parks the
  export at whatever percentage its last frame reported. (The encoder's
  own flush comes later still, after the timeline walk.) That reporting
  gap is why the `atempo` path matters so much here: WSOLA is
  O(grain × radius) per rendered sample, which on a long clip meant
  minutes of an apparently frozen export. Reporting progress across the
  audio phase would fix the symptom rather than the cost, and is tracked
  separately.

- **Output** honours the timeline's selected aspect ratio
  (`resolveAspectRatioValue` over `getEditorSettings(document).aspectRatio` —
  the same typed façade `buildSceneDescription` reads, so the dialog cannot
  drift from the compositor). `ExportDialog`'s `tierOutputDims` feeds the
  crop-aware **smallest** clip on the timeline to
  [`calculateMp4ExportSettings`](../../src/lib/exporter/mp4ExportSettings.ts),
  which maps quality + source dims + aspect ratio to the encoder
  width / height / bitrate, and passes `width` / `height` to `exportMulti`.
  Only "Source" quality targets those source dims; 720p / 1080p target a
  fixed short side regardless.

## Output formats and codecs

The native MP4 export takes `width`, `height`, `frameRate`, and `codec` as
parameters on `exportMulti` and writes H.264 (AMF) by default. The
user-facing codec choice crosses as the plain `ExportVideoCodec` string
(`"h264"` / `"h265"` / `"vp9"`) in those params; VP9
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
9. **A second instance of the same build quits silently.** The lock keys
   on the `userData` path, so another dev build already running makes a
   launch exit 0 and report nothing. The installed app
   (`openscreen.exe`) resolves a different `userData` path and does not
   conflict.

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