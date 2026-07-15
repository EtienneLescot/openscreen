# Export Pipeline v2 — Multi‑Asset Rendering + Performance

Status: **Draft / for review**
Owners: ai-edition editor team
Scope: the `.axcut` (AI‑edition) export path only. The legacy `components/video-editor` exporter is out of scope.

---

## 1. Goals & non‑goals

### Goals
1. **Multi‑asset export.** Render every clip on the timeline from *its own* source asset, in timeline order — matching what the preview already plays. Today only the primary asset is rendered; clips pointing at other assets are silently dropped.
2. **Performance.** Cut export time by removing the per‑frame GPU→CPU→GPU round‑trips, moving the pipeline off the renderer main thread, and properly pipelining decode/render/encode. Target: **≥2× faster** on 1080p/4K, UI stays responsive during export.
3. **Correct framing.** Output honors the timeline’s selected aspect ratio and is sized to the largest clip. *(Already shipped — see §9.)*

### Non‑goals (this spec)
- Overlapping/mixed audio tracks (we assume **sequential** per‑clip audio).
- Compositing multiple assets **simultaneously** (picture‑in‑picture of two screen recordings). The webcam overlay is the only simultaneous second source and stays as‑is.
- Replacing WebCodecs with a native ffmpeg binary as the primary encoder (see §7 — WebCodecs already *is* the hardware path; native ffmpeg is only a fallback).
- GIF export changes beyond what falls out of the shared render plan.

---

## 2. Current architecture (as‑is)

### 2.1 Data flow

```
ExportDialog.handleStart()                         (renderer MAIN thread)
  └─ exportAxcutDocument(document, options)         src/lib/ai-edition/exporter/documentExporter.ts
       ├─ pick primaryAsset; videoUrl = toFileUrl(primaryAsset.originalPath)
       ├─ trimRegions   = complement of primary-asset clips + trimRanges   (single asset!)
       ├─ cropSchedule  = per-clip crop (primary asset only)
       ├─ zoom/annotation/speed → projected to SOURCE time of the primary asset
       └─ new VideoExporter(config).export()        src/lib/exporter/videoExporter.ts
            ├─ StreamingVideoDecoder.loadMetadata(videoUrl)     (WebCodecs VideoDecoder)
            ├─ (optional) source-copy fast path (identity export → remux, no re-encode)
            ├─ FrameRenderer(width,height, …)                    (PixiJS/WebGL + Canvas2D)
            ├─ VideoMuxer + AudioProcessor                        (WebCodecs audio + mp4 mux)
            └─ streamingDecoder.decodeAll(fps, trimRegions, speedRegions, perFrame)
                 perFrame(videoFrame, …):
                   renderer.setCropRegion(resolveCropAt(cropSchedule, t))
                   renderer.renderFrame(videoFrame)              ← WebGL render
                   canvas = renderer.getCanvas()                 ← Canvas2D composite
                   exportFrame = new VideoFrame(canvas)          ← re-upload to GPU
                   encoder.encode(exportFrame)                   ← WebCodecs VideoEncoder (HW)
```

### 2.2 Key types & files
- `DocumentExportOptions` — `src/lib/ai-edition/exporter/documentExporter.ts`
- `VideoExporterConfig extends ExportConfig` — `src/lib/exporter/videoExporter.ts` (`videoUrl`, `trimRegions`, `speedRegions`, `cropSchedule`, `zoomRegions`, `annotationRegions`, webcam*, cursor*, `width`/`height`/`frameRate`/`bitrate`/`codec`).
- `FrameRenderer` — `src/lib/exporter/frameRenderer.ts`. PixiJS/WebGL for the video layer + filters (`pixi-filters/motion-blur`, `threeDPass.ts`); **Canvas2D** for background/shadow/foreground compositing.
- `StreamingVideoDecoder` — `src/lib/exporter/streamingDecoder.ts`. `loadMetadata()`, `decodeAll(fps, trims, speeds, cb)`, `getDemuxer()`.
- `AudioProcessor` / `VideoMuxer` — `src/lib/exporter/audioEncoder.ts`, `src/lib/exporter/muxer.ts`.
- Preview (the behavioral reference) — `src/components/ai-edition/preview-compositor/PreviewCompositor.tsx` (`videoSources[]`, `sourceIndex`, `locateSourcePosition`, switches active `<video>` per clip’s `assetId`).

### 2.3 Confirmed characteristics
- **Single stream.** `config.videoUrl` is one asset. Multi‑asset timelines lose every non‑primary clip.
- **Runs on the renderer main thread.** `exportAxcutDocument` is `await`‑ed directly from the dialog; it yields between frames but competes with the UI for the thread and the GPU.
- **Per‑frame readback.** WebGL render → `getCanvas()` (Canvas2D) → `new VideoFrame(canvas)`. On Linux there is an *explicit* `getImageData()` CPU readback (EGL/Ozone workaround). A 4K RGBA frame is ~33 MB; at 60 fps this is ~2 GB/s of avoidable copying.
- **Serial pipeline.** Only encoder‑queue backpressure (`waitForEncoderQueueSpace`, `encodeQueueSize`) exists; decode/render/encode are not otherwise decoupled.
- **Encoder is already hardware.** `VideoEncoder` with `hardwareAcceleration: "prefer-hardware"`, falling back to software. This is the OS hardware codec (Media Foundation / VideoToolbox / VA‑API) — the same path native ffmpeg uses.

---

## 3. Problem statement

| # | Problem | Impact |
|---|---------|--------|
| P1 | Only the primary asset is rendered | Multi‑recording timelines export wrong/partial video (**correctness bug**) |
| P2 | Per‑frame GPU↔CPU readback + re‑upload | Dominant time sink; scales badly with resolution |
| P3 | Whole export on the renderer main thread | UI stutters; no parallelism headroom |
| P4 | Serial decode→render→encode | Under‑utilizes decoder/encoder overlap |
| P5 | Aspect ratio hardcoded 16:9 | Wrong framing for non‑16:9 timelines — **fixed, see §9** |

Research backing the perf direction (WebCodecs already ≈ native; the wins are readback + threading; ~2–3× reported by Descript from removing the copies): see the linked sources in the PR/discussion.

---

## 4. Target architecture (to‑be)

Both the multi‑asset feature and the perf rework converge on one idea: **a `RenderPlan` of ordered segments, consumed by a worker‑hosted pipeline that keeps frames on the GPU.**

```
documentExporter                     builds a RenderPlan (ordered segments, virtual-time effects)
      │  postMessage(plan)  ─────────────────────────────────────────────►  Export Worker
      │                                                                       (OffscreenCanvas + WebGL/WebGPU)
      │                                             ┌─ for each segment in plan.segments:
      │                                             │    decoder = StreamingVideoDecoder(segment.videoUrl)
      │                                             │    decode [sourceStart,sourceEnd) − intraTrims
      │                                             │    render into ONE output surface (virtual time)
      │                                             │    VideoFrame(gpuSurface) → encoder            (no readback)
      │                                             └─ audio: decode each segment, concat → muxer
      ◄─ progress / result (transferred ArrayBuffer) ◄──────────────────────
```

### 4.1 The `RenderPlan` (new shared data model)

```ts
// src/lib/ai-edition/exporter/renderPlan.ts  (new)
interface RenderSegment {
  clipId: string;
  assetId: string;
  videoUrl: string;             // toFileUrl(asset.originalPath)
  sourceStartSec: number;       // clip in-point in the asset's media time
  sourceEndSec: number;         // clip out-point
  intraTrims: Interval[];       // trimRanges of THIS asset inside [start,end)
  cropRegion: CropRegion;       // per-clip crop (identity when absent)
  sourceWidth: number;          // asset.video.width  (for the renderer)
  sourceHeight: number;         // asset.video.height
  camera?: { videoUrl: string; offsetMs: number } | null; // per-asset webcam
}

interface RenderPlan {
  output: { width: number; height: number; frameRate: number; bitrate: number; codec: string };
  aspectRatioValue: number;     // timeline ratio (see §9)
  segments: RenderSegment[];    // timeline order == output order
  // Effects keyed in VIRTUAL (output) time — NOT per-asset source time:
  zoomRegions: ZoomRegion[];
  annotationRegions: AnnotationRegion[];
  speedRegions: SpeedRegion[];
  cursor: CursorPlan;           // see §6.4
  appearance: { wallpaper: string; padding: number; borderRadius: number;
                shadowIntensity: number; showBlur: boolean; motionBlurAmount: number; };
}
```

**Why virtual time.** Today `documentExporter` projects timeline‑authored effects onto each asset’s *source* time (`projectRegionsToSourceTime`) because there is a single source stream. With a segment loop that already tracks a running **output/virtual‑time cursor**, effects can be keyed directly in virtual time — this is *simpler*, removes the projection round‑trip, and is exactly how the editor authors them.

### 4.2 Segment loop (replaces the single `decodeAll`)

`VideoExporter.export()` becomes:

1. Compute `output` + create **one** `FrameRenderer`, **one** `VideoEncoder`, **one** `VideoMuxer`.
2. `outputCursorSec = 0`.
3. For each `segment`:
   a. `decoder = new StreamingVideoDecoder(); await decoder.loadMetadata(segment.videoUrl)`.
   b. `renderer.setSource(segment.sourceWidth, segment.sourceHeight, segment.camera)` — reconfigure the renderer’s input dims/crop/webcam for this asset.
   c. `decoder.decodeAll(fps, complementOf(segment.intraTrims within [start,end)), speedForSegment, perFrame)`, where `perFrame` renders at `timestamp = outputCursorSec + localOffset` and looks up zoom/annotation/cursor by **virtual time**.
   d. Advance `outputCursorSec` by the segment’s rendered virtual duration.
   e. Dispose the decoder before the next segment (bounded memory: one active decoder at a time in Phase 2; see §6.6 for prefetch).
4. Audio (§6.3), finalize muxer, return buffer.

### 4.3 Worker + OffscreenCanvas

- New `src/lib/ai-edition/exporter/exportWorker.ts` (module worker). It owns the `FrameRenderer` (constructed on an `OffscreenCanvas`), the decoders, the encoder, and the muxer.
- The dialog posts `{ plan }` and a `MessagePort`; the worker streams `{ type: "progress", … }` and finally `{ type: "done", buffer }` (transferred).
- `FrameRenderer` must accept an `OffscreenCanvas`; PixiJS supports WebGL on `OffscreenCanvas` in a worker. The Canvas2D composite canvases become `OffscreenCanvas` too. (This is the main portability task — see Risk R2.)

### 4.4 Keep frames on the GPU (kill the readback)

- Do the **final composite in WebGL/WebGPU**, not Canvas2D. Today the video is WebGL (Pixi) but background/shadow/foreground are Canvas2D with a `drawImage(webglCanvas)`/`getImageData` bridge. Move background + shadow + foreground into the GPU stage (Pixi sprites/filters, or a WebGPU pass) so the output surface is already a GPU texture.
- Feed `new VideoFrame(gpuOutputCanvas, { timestamp, duration })` straight to the encoder. Chromium keeps this GPU‑resident for the hardware encoder (zero‑copy). **Remove `getImageData` on non‑Linux.** Keep the Linux `getImageData` branch only, gated behind the existing platform check.

---

## 5. Phasing

Each phase is independently shippable and independently verifiable.

### Phase 0 — Measure & de‑risk (S)
- Add a dev‑only timing harness around **decode / render / readback / encode** and log per‑stage ms + fps on a real export; log `hardwareAcceleration` actually granted.
- **Exit criteria:** we can state, with numbers, that readback and/or main‑thread contention dominate (validates P2/P3 before the big refactor). No user‑visible change.

### Phase 1 — Off the main thread (M)
- Move the *existing* single‑asset pipeline into the Worker + OffscreenCanvas unchanged in behavior.
- **Exit criteria:** identical output bytes (or visually identical) vs current; UI no longer stutters during export; progress still reported.

### Phase 2 — Segment sequence + GPU‑resident compositing (L) — *the big one*
- Introduce `RenderPlan`; rewrite `documentExporter` to emit segments; rewrite `VideoExporter.export()` as the segment loop; virtual‑time effects; per‑segment audio concat; per‑segment cursor (§6.4).
- Remove the non‑Linux readback; composite on the GPU.
- **Exit criteria:** a 2+asset timeline exports all clips in order, audio in sync; single‑asset output unchanged; measured render throughput ≥2× Phase 0 baseline at 1080p.

### Phase 3 — Parallel segments (M, optional, measure‑gated)
- Encode independent segments on multiple workers; concatenate at the container level (GOP‑aligned) in the muxer.
- **Gate:** only if Phase 0/2 numbers show spare hardware‑encode capacity. Hardware encoders often expose 1–2 sessions and don’t scale linearly; document the measured speedup or shelve.

---

## 6. Detailed design notes

### 6.1 Building segments (documentExporter)
- `segments = timeline.clips` sorted by `timelineStartSec`. For each clip: resolve its asset, `videoUrl`, `[sourceStartSec, sourceEndSec]`, `cropRegion ?? IDENTITY`, and the clip’s asset dims.
- `intraTrims`: the subset of `timeline.trimRanges` whose `assetId === clip.assetId` intersected with `[sourceStart, sourceEnd)` — these are cuts *inside* a clip (existing `computeExportTrimRegions` logic, but scoped per segment instead of one global complement).
- Gaps between clips are simply absent segments (no black frames unless we choose to insert them — **decision D3**).

### 6.2 Renderer reconfiguration per segment
- `FrameRenderer` currently takes `videoWidth/videoHeight` once. Add `setSource({ videoWidth, videoHeight, webcam })` to rebuild the source‑dependent sprites/filter sizes between segments. Output size stays fixed for the whole export.

### 6.3 Audio
- Per segment, decode `[sourceStart, sourceEnd)` of that asset’s audio (reuse `AudioProcessor`), append PCM to a running timeline, resampling to a **common** sample rate/channel layout chosen up‑front (from the first segment with audio, or 48 kHz stereo default). Encode once at the end and mux.
- Segments with no audio track contribute silence of their virtual duration (keeps A/V aligned).
- `selectSupportedExportCodecForSource` is chosen from the **first** segment’s demuxer; heterogeneous source codecs are fine because we re‑encode to one output codec.

### 6.4 Cursor (per‑segment) — **decision D1**
- Cursor telemetry (`CursorRecordingData`) is recorded per recording and currently taken from the primary asset. Proposal: carry cursor data **per segment** on the asset (`asset.cursor…`) and have the renderer switch cursor source at segment boundaries, offset into the segment’s source time.
- If a segment’s asset has no cursor data, that segment renders with no cursor overlay. This is the smallest correct behavior and avoids inventing cursor motion.

### 6.5 Speed regions
- `speedRegions` remain virtual‑time. Within a segment, the local decode→output time map applies the covering speed factor (existing `decodeAll` speed handling, but the *timestamp* handed to the renderer/encoder is the virtual cursor, so cross‑segment continuity holds).

### 6.6 Memory & backpressure
- One active decoder per segment in Phase 2. Optionally **prefetch** the next segment’s `loadMetadata` while the current one drains (bounded to 2 in flight) to hide seek/demux latency — add only if Phase 0 shows boundary stalls.
- Keep the three WebCodecs bottleneck signals bounded: `decoder.decodeQueueSize`, count of open `VideoFrame`s, `encoder.encodeQueueSize`. Close every `VideoFrame` in a `finally`.

### 6.7 Fast path
- The source‑copy fast path (`trySourceCopyFastPath`) stays, but only qualifies when `segments.length === 1` **and** identity (no effects/crop/speed, output size == source, matching fps/codec). Multi‑segment always re‑encodes.

---

## 7. Encoder strategy / native fallback

- **Primary: WebCodecs**, `prefer-hardware`, software fallback (unchanged). This already hits the OS hardware encoder; a native ffmpeg swap would not beat it and adds a binary + IPC surface.
- **Native ffmpeg fallback (main process), only for gaps:** codecs/containers WebCodecs can’t do on a given OS (e.g. some HEVC/AV1), or systems where `VideoEncoder.isConfigSupported` reports no support. Route: renderer produces raw frames → main‑process ffmpeg with `-c:v h264_nvenc/hevc_qsv/h264_videotoolbox`. Treat as a **safety net**, behind capability detection, not the perf lever.

---

## 8. Testing & verification

**Unit / vitest** (no GPU needed):
- `renderPlan` builder: N clips across M assets → correct ordered segments, intraTrims scoping, gaps, identity fast‑path eligibility. Table‑driven, mirrors `documentExporter` test style.
- Audio concat timing: segment durations → sample offsets; silence padding for audio‑less segments.
- Aspect/size math (already covered by `mp4ExportSettings.test.ts`).

**Integration (Electron dev app, manual + scripted):**
- 1 asset identity export == byte/visual parity with pre‑refactor (Phase 1 gate).
- 2‑asset A→B timeline: both clips present, in order, A/V synced, cursor switches correctly.
- Non‑16:9 timeline framing matches preview.
- Cancel mid‑export releases decoders/encoder/frames (no leak; watch `VideoFrame` count).

**Perf harness (Phase 0, kept):**
- Fixed 1080p and 4K fixtures; assert render fps and total wall‑time; record before/after each phase in the PR.

---

## 9. Already shipped (aspect ratio)

`documentExporter` reads `document.legacyEditor.aspectRatio` and converts via `getAspectRatioValue` (`"native"` → `getNativeAspectRatioValue(sourceW, sourceH)`), replacing the hardcoded `16/9`. `ExportDialog` computes the same value so the per‑tier size labels (`W × H`, `· Upscale` when a tier exceeds the largest clip) match the actual output. Output is sized to the **largest** clip on the timeline (`referenceSource`, by pixel count). Covered by existing tests; `tsc`/Biome clean.

---

## 10. Risks & mitigations

| ID | Risk | Mitigation |
|----|------|-----------|
| R1 | GPU‑resident composite is a large rewrite of `FrameRenderer`’s Canvas2D stages | Do it *inside* Phase 2, behind the same renderer API; keep Canvas2D path available under a flag until parity is proven |
| R2 | PixiJS on OffscreenCanvas in a worker has platform quirks (esp. Linux EGL/Ozone) | Phase 1 validates worker rendering on all 3 OSes first; retain the Linux `getImageData` fallback |
| R3 | Per‑segment cursor data may not exist for imported (non‑OpenScreen) media | Render no cursor for such segments (§6.4); acceptable and correct |
| R4 | Parallel HW encode doesn’t scale | Phase 3 is measure‑gated; ship serial if numbers are flat |
| R5 | Audio resample drift across many segments | Single common rate chosen up‑front; accumulate sample counts as integers |

---

## 11. Open decisions (need product/eng sign‑off)

- **D1 — Cursor across recordings:** per‑segment cursor from each clip’s own recording (proposed), vs. primary‑only (today). *Recommend per‑segment.*
- **D2 — Audio model:** sequential concat only (proposed) vs. future overlapping/mixed tracks. *Recommend sequential for v2.*
- **D3 — Gaps between clips:** skip (tight concat, proposed) vs. insert black/silence for the gap duration. *Recommend skip.*
- **D4 — Phase 3 parallelism:** attempt after Phase 0/2 measurements, or shelve. *Recommend measure‑gated.*
