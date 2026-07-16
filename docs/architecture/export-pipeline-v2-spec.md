# Export Pipeline v2 — Multi‑Asset Rendering + Performance

Status: **Revised 2026‑07‑16** — multi‑asset shipped; the **perf half was rewritten after measurement disproved its central premise**. Read §3.1 first: the bottleneck is the WebCodecs API (~90 % of wall), not the readback (0.1 %). The plan is now native ffmpeg encode (§7), not GPU‑resident compositing (§4.4, cancelled).
Owners: ai-edition editor team
Scope: the `.axcut` (AI‑edition) export path only. The legacy `components/video-editor` exporter is out of scope.

---

## 1. Goals & non‑goals

### Goals
1. **Multi‑asset export.** Render every clip on the timeline from *its own* source asset, in timeline order — matching what the preview already plays. Today only the primary asset is rendered; clips pointing at other assets are silently dropped.
2. **Performance.** ~~Cut export time by removing the per‑frame GPU→CPU→GPU round‑trips, moving the pipeline off the renderer main thread, and properly pipelining decode/render/encode. Target: ≥2× faster.~~ **Rewritten 2026‑07‑16 after measurement (§3.1):** those targets are ≤2.3 % of wall. Cut export time by **replacing the WebCodecs encoder — ~90 % of wall — with a bundled native LGPL ffmpeg** using the platform's hardware encoder. Target: **≥4×** on the frame pipeline at 1080p (measured end‑to‑end: 8 → **34 fps** BGRA, → **81 fps** with NV12 packing). The encoder alone does 165 fps, but the renderer→main crossing — not the encoder — is what we end up bound by (§4.4.1).
3. **Correct framing.** Output honors the timeline’s selected aspect ratio and is sized to the largest clip. *(Already shipped — see §9.)*

### Constraints
- **The app is MIT and must stay MIT.** No GPL component may end up in what we ship (§7.2).
- **Windows + macOS + Linux**, x64 and arm64 (Apple Silicon). **No platform gets a degraded export.** Native encode ships on all three. *(Etienne, 2026‑07‑16 — see the rejected option below.)*
- Must degrade gracefully where no hardware encoder exists (→ WebCodecs fallback).
- **Bundle size is not a constraint** *(Etienne, 2026‑07‑16)*: ~200 MB per platform is acceptable. Do not trade features, codec coverage or simplicity for bytes. Precedent: the app already ships native binaries (`wgc-capture.exe`, `cursor-sampler.exe`, `whisper.dll`, `ggml-*.dll`).

### Non‑goals (this spec)
- Overlapping/mixed audio tracks (we assume **sequential** per‑clip audio).
- Compositing multiple assets **simultaneously** (picture‑in‑picture of two screen recordings). The webcam overlay is the only simultaneous second source and stays as‑is.
- ~~Replacing WebCodecs with a native ffmpeg binary as the primary encoder (WebCodecs already *is* the hardware path; native ffmpeg is only a fallback).~~ **Inverted — this is now Goal 2.** WebCodecs reaches the same silicon but at **8 fps vs 165 fps** for native ffmpeg (§3.1). It becomes the *fallback*; native ffmpeg is the primary encoder (§7).
- Shipping a **GPL** ffmpeg build (x264/x265). We build LGPL only, so the app stays MIT (§7.2).
- **Keeping WebCodecs as the primary encoder on macOS** because the gap is smaller there. **Rejected — do not reintroduce this.** It is a tempting argument and it will come back, so here it is with its rebuttal: WebCodecs *is* closer to native on VideoToolbox (~3.5× off, per [w3c/webcodecs#492](https://github.com/w3c/webcodecs/issues/492)) than on our Windows/AMD reference (~20×), and skipping the macOS ffmpeg build would dodge real work — BtbN publishes prebuilt LGPL binaries for Windows and Linux but **not macOS**, so macOS is the one platform we must build (and notarise) ourselves. We are still not doing it: "3.5× slower, but only on Macs" is a degraded export on a platform where our users edit, sold as an engineering convenience. Native encode ships on all three, or the plan is wrong.
- Rewriting the compositor. The Canvas2D composite stays; only the encoder changes (§4.4).
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
- **Encoder is WebCodecs, and that is the bottleneck.** `VideoEncoder` with `hardwareAcceleration: "prefer-hardware"`. ~~This is the OS hardware codec — the same path native ffmpeg uses.~~ **Wrong:** it reaches the same silicon but through Chromium's wrapper, and measures **~8 fps @1080p vs 165 fps** for native ffmpeg on the same GPU (§3.1). Hardware encode *is* enabled (`video_encode=enabled`, no blocklist) — the loss is Chromium's per‑frame overhead.

---

## 3. Problem statement

| # | Problem | Impact | Status |
|---|---------|--------|--------|
| P1 | Only the primary asset is rendered | Multi‑recording timelines export wrong/partial video (**correctness bug**) | **fixed** (segment loop) |
| P2 | ~~Per‑frame GPU↔CPU readback + re‑upload — dominant time sink~~ | **DISPROVEN.** Measured 0.2 ms/frame = **0.1 %** of wall. | closed, see §3.1 |
| P3 | Whole export on the renderer main thread | UI stutters. Real, but a **responsiveness** issue, not throughput | deferred |
| P4 | Serial decode→render→encode | Real but small: the audio half is fixed; the rest is masked by P6 | partly fixed |
| P5 | Aspect ratio hardcoded 16:9 | Wrong framing for non‑16:9 timelines | **fixed, see §9** |
| **P6** | **WebCodecs caps the encoder at ~8 fps @1080p** | **~90 % of export wall time.** The actual bottleneck. | **open — §7** |

### 3.1 What Phase‑0 measurement actually found (2026‑07‑16)

The original perf direction here ("WebCodecs already ≈ native; the wins are readback + threading; ~2–3× reported by Descript from removing the copies") **did not survive measurement.** Instrumenting `runSegmentLoop` (`StageTimings`) on **os_parity** (2 assets, 2×3× speed, 1.80× zoom, webcam; MP4/1080p/60/H.264; 546 output frames):

| stage | software | hardware | GPU‑resident composite |
|-------|---------:|---------:|-----------------------:|
| **encodeWait** | **75.5 s (89 %)** | **52.8 s (92 %)** | **55.1 s (90.6 %)** |
| audioEncode | 6.9 s | 3.2 s | 4.1 s |
| render | 1.9 s (2.2 %) | 1.2 s | 1.3 s |
| **readback** | **0.12 s (0.1 %)** | 0.07 s | **0.10 s** |
| **wall** | **94.6 s** | **72.7 s** | **97.9 s** |

Then an **isolated encoder probe** (120 synthetic frames — no decode, no render, no composite) settled the cause:

```
gl: ANGLE (AMD, AMD Radeon(TM) Graphics, Direct3D11)   ← real GPU, not SwiftShader
video_encode = enabled                                  ← no blocklist, HW encode available
hw/canvas-frame     22.8 fps      hw/cpu-rgba-frame   35.6 fps
sw/canvas-frame     31.4 fps      hw/canvas@720p      48.4 fps
```

versus **native ffmpeg on the same machine, same 546 real frames**:

```
h264_amf (AMD hardware)   165 fps      ← 20× WebCodecs
libx264 -preset ultrafast 198 fps      ← 25× WebCodecs
node -> ffmpeg stdin pipe: 489-589 MB/s, costs ~3%
```

Conclusions that redirect this spec:

- **The encoder is the wall, and the wall is the API.** Hardware encode is enabled and reachable; Chromium's WebCodecs pipeline still yields 8–36 fps where the same silicon does 165. The loss is Chromium's per‑frame overhead (renderer↔GPU‑process IPC, format conversion), not our feeding of it.
- **GPU‑backed frames are *slower* into the encoder than CPU ones** (22.8 vs 35.6 fps). The premise behind §4.4 was false. The GPU‑resident composite was implemented, measured (no gain), and **reverted** (`e6cbb45`).
- **The "CPU bridge" is a non‑issue** — 3 %. (An earlier 8× penalty was an artefact of MSYS's emulated pipe, not a real Windows pipe.)
- Everything except the encoder — readback, `latencyMode`, Worker/OffscreenCanvas, compositing — is **≤2.3 % combined**. Optimising any of it is noise.

**Beware two measurement traps** we fell into: `app.getGPUFeatureStatus()` from a **windowless** Electron script reports everything `disabled_software` (meaningless — always probe with a real window), and piping via `cat` under Git Bash caps at ~70 MB/s (MSYS emulation, not Windows).

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

### 4.3 Worker + OffscreenCanvas — *deferred to Phase 5 (2026‑07‑16)*

> Kept for reference. Measurement (§3.1) showed the main thread is **not** the throughput limit — it sits idle in `encodeWait` ~90 % of the time. This buys **UI responsiveness**, not speed, so it is no longer part of the perf programme and waits behind Phase 3.

- New `src/lib/ai-edition/exporter/exportWorker.ts` (module worker). It owns the `FrameRenderer` (constructed on an `OffscreenCanvas`), the decoders, the encoder, and the muxer.
- The dialog posts `{ plan }` and a `MessagePort`; the worker streams `{ type: "progress", … }` and finally `{ type: "done", buffer }` (transferred).
- `FrameRenderer` must accept an `OffscreenCanvas`; PixiJS supports WebGL on `OffscreenCanvas` in a worker. The Canvas2D composite canvases become `OffscreenCanvas` too. (This is the main portability task — see Risk R2.)

### 4.4 ~~Keep frames on the GPU (kill the readback)~~ → **Native encode** *(rewritten 2026‑07‑16)*

> **Abandoned.** This section proposed moving the whole composite onto the GPU so `new VideoFrame(gpuCanvas)` would reach the hardware encoder zero‑copy. It was **implemented, measured, and reverted** (`a31cf49` → `e6cbb45`): the readback it removed was 0.1 % of wall, and GPU‑backed frames turned out to be **slower** into the encoder than CPU ones (22.8 vs 35.6 fps). Keep the proven Canvas2D composite. See §3.1.

The frame path stays as it is (Pixi/WebGL for the video, Canvas2D composite, `getCanvas()`). Only the **encoder** changes:

```
FrameRenderer.getCanvas()  →  read pixels (~0.2 ms, measured, negligible)
      │
      ▼  NV12/RGBA frame  (renderer → main; 489–589 MB/s over a real pipe, ~3 % cost)
native ffmpeg subprocess  -c:v h264_nvenc | h264_qsv | h264_amf | h264_videotoolbox | h264_vaapi
      │
      ▼  writes the .mp4 directly to disk
```

This also deletes three things we currently pay for: the WebCodecs encoder, the JS muxer (`mediabunny`), and the whole in‑memory `Blob` + final save IPC — ffmpeg muxes and writes the file itself.

### 4.4.1 The upstream chain, measured (2026‑07‑16)

The 165 fps figure is `node → ffmpeg` **in one process**. The real path adds a renderer→main process crossing per frame, so the whole chain was measured end‑to‑end. **The encoder is no longer the bottleneck — the IPC crossing is.**

**Stage 1 — canvas → bytes (mandatory: the renderer is sandboxed, so bytes must cross a process boundary):**

| method | ms/frame | ceiling |
|--------|---------:|--------:|
| **`new VideoFrame(canvas2D).copyTo(buf)`** | **1.43** | **698 fps** ← use this |
| `getImageData` → RGBA | 7.00 | 143 fps |
| `gl.readPixels` → RGBA | 8.18 | 122 fps |
| `new VideoFrame(**GL** canvas).copyTo(buf)` | 11.23 | 89 fps |

Two consequences. First, `copyTo` on a **2D** canvas is 5× cheaper than `getImageData` — it is the extraction method, and it takes extraction off the critical path. Second, reading back a **WebGL** canvas is **8× slower than a 2D one** — which is the retroactive explanation for why the GPU‑resident composite (§4.4) never paid off. That revert was right for a reason we only learned here.

**Format constraint:** `VideoFrame(canvas).format` is **BGRA**, and `copyTo({format:"NV12"})` / `{format:"I420"}` throw `NotSupportedError` — Chromium will not convert. Only RGBA/BGRA come out. So we ship **BGRA at 7.9 MB/frame** and let ffmpeg's swscale convert. We cannot get the 3.0 MB NV12 frame from the renderer.

**Stage 2 — renderer → main (the new bottleneck):**

| transport | fps | throughput |
|-----------|----:|-----------:|
| `ipcRenderer.send`, window=1 (stop‑and‑wait) | 84 | 249 MB/s |
| **`ipcRenderer.send`, credit window=8** | **130** | **387 MB/s** |
| `ipcRenderer.send`, credit window=32 | 131 | 389 MB/s |
| MessagePort zero‑copy transfer | ❌ **impossible** | — |

A **credit window** (N frames in flight) is worth **+56 %** over stop‑and‑wait; window=8 already saturates it, 32 adds nothing. Use 8.

**Zero‑copy to main does not exist in Electron.** `MessagePortMain.postMessage(message, [transfer])` accepts `MessagePortMain[]` **only**; transferring an ArrayBuffer from renderer to main silently loses the entire message (measured: `ev.data === null`; known bug [electron#34905](https://github.com/electron/electron/issues/34905) — it works renderer→renderer, not renderer→main). Every frame is structured‑cloned, i.e. copied. That caps the crossing at ~390–420 MB/s, which at 7.9 MB/frame is **53 fps** for the crossing alone (measured).

**Stage 3 — end‑to‑end, measured (not extrapolated):**

| pipeline | fps | throughput |
|----------|----:|-----------:|
| IPC alone · NV12 3.0 MB | 130 | 387 MB/s |
| IPC alone · BGRA 7.9 MB | 53 | 418 MB/s |
| **IPC + ffmpeg · NV12 3.0 MB** | **81** | 240 MB/s |
| **IPC + ffmpeg · BGRA 7.9 MB** | **34** | 268 MB/s |

Two facts fall out, and both matter:

1. **The crossing is bandwidth‑bound, not per‑message‑bound** (387 vs 418 MB/s at wildly different frame sizes). So halving the bytes really does double the fps — Phase 4 is worth it, and this is what justifies it.
2. **Main is a serialisation point.** Attaching ffmpeg costs ~40 % of the crossing throughput (418 → 268 MB/s) because the same process both receives the IPC message and writes stdin. Moving ffmpeg to a `utilityProcess` does **not** fix this — the receiving process still does both halves; it only moves which process pays.

Also: `Buffer.from(typedArray)` **copies**. In the main‑process sink, wrap instead — `Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)`. Measured worth **+31 %** (26 → 34 fps BGRA); at 7.9 MB × 546 frames a stray copy is 4.3 GB of pure waste.

**The chain, and what to expect:**

| stage | ceiling |
|-------|--------:|
| composite (Pixi) | 377 fps |
| extract (`VideoFrame(2D).copyTo`) | 698 fps |
| **renderer → main → ffmpeg stdin (BGRA)** | **34 fps** ← bottleneck |
| ffmpeg `h264_amf` | 165 fps (3× headroom) |

**Phase 3 target: 8 → 34 fps (≈4.3× on the frame pipeline).** Ship it first: most of the win, low risk.
**Phase 4 (GPU NV12 packing): 34 → 81 fps (≈10× vs today).** Now clearly justified by fact 1 above — but still gated on the packing not reintroducing the slow GL readback (11.23 ms).

---

## 5. Phasing

Each phase is independently shippable and independently verifiable.

### Phase 0 — Measure & de‑risk (S) — ✅ **DONE**
- `StageTimings` harness + isolated encoder probe in `videoExporter.ts`.
- **Outcome:** it did its job — it *invalidated* the plan it was meant to validate. Readback is 0.1 %, not dominant; the encoder API is 90 %. See §3.1. This is why Phase 0 exists.

### Phase 1 — Multi‑asset correctness (L) — ✅ **DONE**
- `RenderPlan`, segment loop, per‑segment audio/cursor/webcam/speed, seamless junctions. Shipped and verified in the dev app.

### Phase 2 — ~~Worker + GPU‑resident compositing~~ — ❌ **CANCELLED**
- GPU‑resident composite: built, measured, **reverted** (§4.4) — target was 2.3 % of wall.
- Worker + OffscreenCanvas: **demoted to Phase 5**. It buys UI responsiveness, not throughput, and is not worth its portability risk (R2) until the encoder is fixed.

### Phase 3 — **Native ffmpeg encode (L) — the actual win** ← *next*
Replace the WebCodecs encoder + JS muxer with a bundled LGPL ffmpeg subprocess (§7).

1. **Build & bundle.** ffmpeg per platform, built **without** `--enable-gpl` and without `--enable-nonfree` — that is what makes it LGPL, and it is the *only* control that matters (those flags are what pull x264/x265; absent them ffmpeg simply won't build a GPL component, whatever else is enabled). **Binary size is not a constraint** (~200 MB/platform is fine), so do **not** strip for size — enable the codecs we may want next (HEVC, AV1, VP9, ProRes) so a future format doesn't need a rebuild + re‑qualification. Ship next to the existing native binaries in `electron/native/bin/<platform>-<arch>/`. Add the LGPL notice + source offer.

   **Where each platform's binary comes from:**

   | platform | source | effort |
   |---|---|---|
   | Windows x64 + arm64 | **[BtbN prebuilt LGPL](https://github.com/BtbN/FFmpeg-Builds)** — daily builds, `h264_amf`/`h264_nvenc`/`h264_qsv` compiled in | just verify + vendor |
   | Linux x64 + arm64 | **BtbN prebuilt LGPL** | just verify + vendor |
   | **macOS x64 + arm64** | **we build it** — BtbN has no macOS target | **real work: build + sign + notarise** |

   macOS is the one we own end‑to‑end, and skipping it is not on the table (§1 non‑goals). A VideoToolbox‑only macOS build is inherently x264‑free, which makes the LGPL gate easy there — the cost is the build/notarisation pipeline, not the licence.

   **Verify every binary before vendoring it**, whatever the source: `ffmpeg -version` must print `License: LGPL version 2.1 or later`, its `configuration:` line must contain neither `--enable-gpl` nor `--enable-nonfree`, and `ffmpeg -encoders` must not list `libx264`/`libx265`. `isLgplBuild()` in `electron/media/ffmpegCapabilities.ts` encodes exactly this check — wire it into CI so a "just add x264" patch cannot silently relicense the app.
2. **Capability probe** (§7.1), cached per machine.
3. **Encode service** (main process): spawn ffmpeg, stream **BGRA** frames to stdin **honouring `drain`** (the measured 489–589 MB/s depends on it), parse progress from stderr, handle cancel (kill the tree) and non‑zero exit.
4. **Renderer side:** after `renderFrame`, extract with `new VideoFrame(canvas).copyTo(buf)` (**not** `getImageData` — 1.43 ms vs 7.00, §4.4.1) and ship the frame to the service over a **credit window of 8**. Keep the WebCodecs path behind the capability probe as the fallback.
5. **Delete on success:** the `mediabunny` video muxing path and the in‑memory `Blob` → ffmpeg writes the file.

- **Exit criteria:** the frame pipeline reaches **≥30 fps** (measured ceiling 34, §4.4.1) vs 8 today with frame‑diff parity vs the current output and A/V still locked; WebCodecs fallback still produces a correct file when no hardware encoder is present; cancel leaves no orphan process.

### Phase 4 — Halve the crossing: GPU BGRA→NV12 packing (M, measure‑gated)
- The renderer→main crossing is the bottleneck at **34 fps**, purely because Chromium only hands us **7.9 MB BGRA** (it refuses NV12, §4.4.1) and Electron cannot transfer buffers zero‑copy. The crossing is **bandwidth‑bound** — measured 387 MB/s at 3.0 MB/frame vs 418 MB/s at 7.9 MB/frame — so halving the bytes really does double the rate: NV12 measures **81 fps** end‑to‑end (≈10× vs today).
- **Gate:** GL‑canvas readback measured 8× slower than 2D (11.23 vs 1.43 ms) — the packing must not reintroduce that. Prototype and measure the packing + readback together before committing.

### Phase 5 — Parallel segments (M, measure‑gated)
- Only if the above leaves us *encoder*‑bound (it currently does not — the encoder has 3× headroom over the crossing). Consumer NVENC/AMF expose 3–8 sessions; needs DTS‑ordered stitching.

### Phase 5 — Worker + OffscreenCanvas (M, optional)
- UI responsiveness during export. Independent of throughput; do it when it's worth it, not before.

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

## 7. Encoder strategy — native ffmpeg primary, WebCodecs fallback

> **This section was inverted on 2026‑07‑16.** It used to read *"a native ffmpeg swap would not beat it"*. Measured on the same machine, same GPU, same 546 frames: **WebCodecs ≈ 8 fps, native ffmpeg `h264_amf` = 165 fps.** The claim was wrong by ~20×. See §3.

- **Primary: native ffmpeg subprocess** (main process), hardware encoder selected per platform. This is what After Effects / CapCut / Resolve do, and it is the only lever that touches the 90 %.
- **Fallback: WebCodecs** (`prefer-hardware`, software fallback) — today's path, kept verbatim for machines with no usable hardware encoder. No regression, no extra work.

### 7.1 Encoder selection (runtime probe, first that works wins)

| OS | Order | ffmpeg encoder |
|----|-------|----------------|
| Windows | NVIDIA › Intel › AMD | `h264_nvenc` › `h264_qsv` › `h264_amf` |
| macOS | Apple Media Engine (every Apple Silicon) | `h264_videotoolbox` |
| Linux | NVIDIA › Intel/AMD | `h264_nvenc` › `h264_vaapi` |
| any | *(none of the above)* | fall back to WebCodecs |

Probe once per machine (`ffmpeg -encoders` + a 1‑frame smoke encode), cache the result, re‑probe on driver/version change.

### 7.2 Licensing — LGPL build, no compromise (why this is safe for an MIT app)

Three layers people conflate:

1. **ffmpeg's own licence.** LGPL 2.1+ **by default**. It only becomes GPL if built with `--enable-gpl` (which pulls x264/x265) — and it is all‑or‑nothing: one GPL component makes the whole binary GPL.
2. **What binds us.** We build ffmpeg **ourselves, LGPL** (no `--enable-gpl`, no `--enable-nonfree`). Obligations: dynamic linking **or a separate executable** (a subprocess trivially satisfies this), ship ffmpeg's source for the exact version (or a written offer), include the LGPL text + attribution, don't forbid reverse‑engineering for debugging. **Our code stays MIT. Zero contamination.**
3. **Patents ≠ copyright.** An LGPL/GPL licence grants **no** patent rights; H.264 sits in a patent pool (Via LA). Hardware encoders inherit the vendor/OS licence. Not a *new* exposure: the app already ships H.264 export via WebCodecs today. *(Not legal advice — worth a real review before commercialising.)*

**What we give up: x264 only.** Measured cost of that: `libx264 -preset ultrafast` 201 fps vs `h264_amf` 165 fps — and x264's number is misleading, because it saturates every CPU core and would then contend with the renderer, while a hardware encoder runs on dedicated silicon and leaves the CPU free. In the real pipeline hardware is likely *ahead*. Giving up x264 costs us ~nothing.

**Rejected alternatives** (all evaluated 2026‑07‑16):

| Option | Why not |
|--------|---------|
| `@napi-rs/webcodecs` | MIT wrapper, zero‑copy, same API (near‑zero migration) — but **no AMF**: AMD‑on‑Windows falls back to software. Its docs also reference `libx265` ⇒ likely a GPL build. The wrapper's MIT does **not** cover the bundled binary. |
| `node-av` | MIT wrapper but exposes `FF_ENCODER_LIBX264` ⇒ ships a GPL ffmpeg build. |
| `beamcoder` | GPL v3. |
| GStreamer | No official Node binding; no perf edge over ffmpeg. *(We also called it "heavier" — that no longer counts against it, since size is not a constraint. It still loses on the binding.)* |
| Own N‑API addon on OS APIs (Media Foundation / VideoToolbox / VAAPI) | Theoretical max — buys **+3 %** (the measured pipe cost) for three native codebases and three toolchains. *(Its "ships nothing extra" upside is moot: size is not a constraint, so it has no advantage left.)* |
| Chromium GPU flags / blocklist | Dead end: `video_encode=enabled` already, with a real window. No blocklist to lift. |

Building ffmpeg ourselves is the **only** path that simultaneously guarantees LGPL, covers AMD/AMF, and stays one integration for three OSes.

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
- `StageTimings` in `runSegmentLoop` logs `[export perf]` per‑stage ms + fps (via `console.warn`, so the app's `rendererConsoleForwarder` forwards it to the Electron stdout — **`console.log` is not forwarded**). `ENCODER_PROBE` in `videoExporter.ts` benchmarks the encoder in isolation.
- Record before/after each phase in the PR. Reference fixture: **os_parity**, MP4/1080p/60/H.264, 546 output frames.
- **Baselines to beat (same machine, 2026‑07‑16):** WebCodecs software 94.6 s · WebCodecs hardware **72.7 s** · native `h264_amf` ceiling **~10 s**.

**Benchmarking natives without the app** (how §3.1's numbers were produced — reuse this before implementing):
```bash
# encode-only: materialise real frames once, then time the encoder alone
ffmpeg -i export.mp4 -an -f rawvideo -pix_fmt nv12 raw.nv12
ffmpeg -f rawvideo -pix_fmt nv12 -s 1920x1080 -r 60 -i raw.nv12 -c:v h264_amf -b:v 8000k out.mp4
# the real architecture: Node streams NV12 into ffmpeg's stdin (respect `drain`)
node pipebench.cjs     # measured 165 fps @ 489 MB/s
```
**Measurement traps this spec was burned by — all three produced false conclusions:**
1. `cat | ffmpeg` under **Git Bash** caps at ~70 MB/s (MSYS emulated pipe) and fabricates an 8× penalty. Use Node → stdin (489–589 MB/s).
2. `app.getGPUFeatureStatus()` from a **windowless** Electron script reports everything `disabled_software`. Meaningless — always probe with a real `BrowserWindow` (then: all `enabled`).
3. **`new VideoFrame(canvas)` is lazy.** Timing it measures ~0.2 ms and tells you nothing; the GPU→CPU descent only happens at `copyTo()`/`getImageData()` (1.43–11.23 ms, §4.4.1). The old "readback is 0.1 % of wall" line came from exactly this mistake.

**General rule this spec keeps re‑learning: benchmark the stage you are about to optimise, in the process topology it will really run in.** Every wrong turn here came from measuring a stage in isolation and assuming the surrounding chain was free.

---

## 9. Already shipped (aspect ratio)

`documentExporter` reads `document.legacyEditor.aspectRatio` and converts via `getAspectRatioValue` (`"native"` → `getNativeAspectRatioValue(sourceW, sourceH)`), replacing the hardcoded `16/9`. `ExportDialog` computes the same value so the per‑tier size labels (`W × H`, `· Upscale` when a tier exceeds the largest clip) match the actual output. Output is sized to the **largest** clip on the timeline (`referenceSource`, by pixel count). Covered by existing tests; `tsc`/Biome clean.

---

## 10. Risks & mitigations

| ID | Risk | Mitigation |
|----|------|-----------|
| ~~R1~~ | ~~GPU‑resident composite is a large rewrite~~ | **Moot** — cancelled and reverted (§4.4) |
| R2 | PixiJS on OffscreenCanvas in a worker has platform quirks (esp. Linux EGL/Ozone) | Deferred with Phase 5; not on the critical path |
| R3 | Per‑segment cursor data may not exist for imported (non‑OpenScreen) media | Render no cursor for such segments (§6.4); acceptable and correct |
| R4 | Parallel HW encode doesn’t scale | Phase 4 is measure‑gated; ship serial if numbers are flat |
| R5 | Audio resample drift across many segments | Single common rate chosen up‑front; accumulate sample counts as integers |
| **R6** | **Bundling ffmpeg: 3 build matrices + macOS signing/notarisation of a shipped binary** | Precedent exists: the app already ships `wgc-capture.exe`, `cursor-sampler.exe`, `whisper.dll`, `ggml-*.dll` — the packaging/signing path is solved. **Size is explicitly not a risk** (~200 MB/platform accepted), so no stripping and no size/feature trade‑off |
| **R7** | **LGPL compliance slips** (someone rebuilds with `--enable-gpl` for "just x264")| Pin the configure flags in the build script + CI assertion that `ffmpeg -L` reports no GPL component. One GPL component relicenses the whole binary (§7.2) |
| **R8** | **Hardware encoder quality/compat varies by vendor** (AMF historically the weakest; driver bugs) | Frame‑diff parity gate per encoder in Phase 3; WebCodecs fallback always available; allow forcing the fallback via a setting |
| **R9** | **ffmpeg subprocess lifecycle** (orphans on crash/cancel, stdin backpressure deadlock) | Kill the process tree on cancel/quit; respect `stdin.write()` backpressure (the measured 489–589 MB/s assumes honouring `drain`) |

---

## 11. Open decisions (need product/eng sign‑off)

- ~~**D1 — Cursor across recordings**~~ — **signed off 2026‑07‑15:** per‑segment cursor, from each clip's own recording. Shipped.
- ~~**D2 — Audio model**~~ — **signed off:** sequential concat only.
- ~~**D3 — Gaps between clips**~~ — **signed off:** clips are always contiguous (the timeline reposes them); cuts are trims laid on top. No gaps to fill.
- ~~**D4 — Phase 3 parallelism / perf programme**~~ — **RESOLVED 2026‑07‑16, and not as written.**

  D4 originally read *"do everything: kill the readback, Worker + OffscreenCanvas, pipeline, parallel encode"*. Phase‑0 measurement killed that framing: those targets are **≤2.3 %** of wall combined, while **WebCodecs alone is ~90 %** (§3.1). The GPU‑resident composite was built, measured at ~0 gain, and reverted.

  **D4 is now: replace the WebCodecs encoder with a bundled LGPL native ffmpeg (§7), Phase 3.** The encoder alone goes 8 → 165 fps (20×), but end‑to‑end we land at **34 fps (≈4.3×)** because the renderer→main crossing becomes the new bottleneck; **81 fps (≈10×)** once Phase 4 halves the bytes (§4.4.1 — all measured). **No licensing compromise** (LGPL build, we control the flags; we give up only x264, worth ~0 in‑pipeline).

  Parallel encode survives as **Phase 4, still measure‑gated** — but now it is gated on whether *native* encode leaves us encoder‑bound, which is a very different question.

  **Shipped from the old D4** (kept, they're real): hardware‑first encoder selection (`a31cf49`, ~23 % on the fallback path) and overlapping the WSOLA audio stretch with the video loop (`09db50f`, ~4 s, free — the loop is idle in `encodeWait`).
