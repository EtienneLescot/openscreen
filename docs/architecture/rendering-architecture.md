# OpenScreen — Target rendering architecture

**Self-contained edition.** This document assumes **no prior knowledge** of the codebase, the previous specs, or the conversation that produced them. Everything an implementing agent needs is inlined: what the product does, how the current pipeline works, what was measured, what to build, and in what order.

**Date:** 2026-07-17
**Source tree referenced:** `getopenscreen/openscreen@a159121` (branch `feat/ai-edition`)
**Priorities, in order:** (1) preview fluidity, (2) export speed
**Supersedes:** `export-pipeline-v2-spec.md` Phase 3/Phase 4 conclusions; incorporates `native-encode-measured-e2e.md` (2026-07-16) and the layer bench.

---

## Part I — Context

### 1. What OpenScreen is

OpenScreen is an open-source (MIT) desktop app for turning raw screen recordings into polished demo videos — an alternative to Screen Studio. Electron app (Chromium renderer + Node main process), shipped on Windows, macOS and Linux, x64 and arm64.

A user records their screen (plus webcam, microphone, and a cursor trace), then edits on a timeline: they cut, speed up boring parts, add zooms that follow the cursor, captions from an auto-transcript, and annotations. The app styles the result — wallpaper background, padding, rounded corners, drop shadow, webcam bubble — and exports an MP4 (or GIF).

**The product promise: what you see in the preview is exactly what the export produces.** The entire value of the tool is that styling and motion design require zero skill — you scrub, you tweak, you export, and it looks right.

### 2. The feature inventory (functional spec)

This is the complete set of behaviours the rendering architecture must support. If a feature is not in this list, it does not constrain the architecture.

**Sources (inputs):**

| source | nature | notes |
|---|---|---|
| screen recording | H.264/VP8/VP9 video file | high resolution, low motion (screen content), long GOPs |
| webcam | second video stream | composited as a PiP bubble or fullscreen |
| cursor trace | recorded positions + click events | rendered **synthetically** (drawn each frame from data, not baked into pixels) |
| audio | mic / system | waveform peaks shown in the timeline UI |
| transcript | whisper-generated timed text | becomes captions |

**Timeline edits (the document):**

- **cuts** — remove time ranges
- **speed regions** — e.g. 3× (audio is time-stretched with WSOLA so pitch is preserved)
- **zoom regions** — animated zoom-in, eased and spring-smoothed, optional auto-focus that pans with the cursor
- **camera-fullscreen regions** — the webcam grows to cover the stage
- **captions** — timed text with progressive reveal (words appear as spoken)
- **annotations** — `text | image | blur` regions, with arrows

**Per-frame appearance (all deterministic given the document and a time `t`):**

- layout presets (picture-in-picture, vertical-stack), padding that reveals the background
- background: solid colour, gradient, or image; optional blur
- rounded corners + mask on the screen video; webcam mask in several shapes
- drop shadow under the video (intensity-scaled, soft cascaded falloff)
- motion blur on fast camera moves, and on the cursor
- cursor click-bounce and shadow
- optional 3D rotation of the foreground
- webcam shrinks reactively during zooms

**Sinks (outputs):**

- **preview** — the editor viewport: scrubbing, playback, live tweaking
- **MP4 export** — H.264 + AAC, reference target 1080p 60 fps
- **GIF export** — exists today (`src/lib/exporter/gifExporter.ts`)
- plausible future: HEVC/AV1 export

### 3. Primer — the vocabulary of this document

Skip if you know real-time graphics. Everything later depends on these five ideas.

**Frame budget.** A 60 fps video has one frame every 16.7 ms. Export doesn't need to hit 60 fps in real time — it can run as fast as the machine allows — so the metric is *milliseconds per frame*, and fps = 1000 / ms:

```
ms/frame :   4.7    9.0    16.7    20.7    54.0   125
fps      :   213    111     60      48      18.5    8
             ▲              ▲       ▲               ▲
          encoder      realtime  today's        where this
           alone       playback  pipeline     project started
```

**GPU vs CPU, and "the descent".** Video frames are big: one 1080p RGBA frame is 8.3 MB; at 60 fps that's ~500 MB/s of pixels. GPUs handle this easily *as long as the pixels stay in GPU-managed memory*. Copying a frame from GPU to CPU memory ("readback", or in this doc **the descent**) is slow — not because of raw bandwidth, but because reading pixels back forces the GPU to **finish all queued work first** (a pipeline stall). The single most important measured fact in this project: *forcing every frame to descend to CPU RAM costs more than the entire rest of the export combined* (§7).

**Asynchronous GPU APIs — the trap this project fell into three times.** When code calls a draw function, the GPU hasn't drawn anything yet — the call just *queues* work and returns immediately. The work actually executes later, and its cost lands on **whichever operation first needs the result** (the "sync point"). Consequence: a timer around a draw call measures ~0 ms even if the draw costs 15 ms, and the 15 ms shows up in some *other* stage's timer. Three confident wrong conclusions in this project came from exactly this (§7.4).

**Compositing.** Assembling the final frame from its parts: draw the background, the shadow, the masked screen video, the webcam bubble, the cursor, the captions — in order, into one image. This can be done with the 2D canvas API (CPU-flavoured, easy, slow) or with GPU shaders (one program that computes every output pixel in parallel).

**Encoding.** Compressing raw frames into H.264 (~8.3 MB/frame → ~17 KB/frame at 8 Mbps). Modern chips have a dedicated hardware block for this. In Chromium it's reached through the **WebCodecs** API (`VideoEncoder`); natively through ffmpeg or the OS APIs (Media Foundation, VideoToolbox, VAAPI).

### 4. Hard constraints

- App stays MIT-licensed (no GPL contamination; an LGPL ffmpeg binary pinned by `scripts/fetch-ffmpeg.mjs` exists and is licence-clean, but see §7 — it is currently shelved).
- Windows + macOS + Linux, x64 + arm64.
- The Chromium **sandbox stays on** for anything that demuxes/decodes user media (untrusted input; this is the renderer's attack surface).
- Export output must remain pixel-faithful to the preview.
- App size is not a constraint (≤ ~200 MB per platform is fine).

---

## Part II — The system today, and what was measured

### 5. The current export pipeline

Everything runs in the Chromium renderer process:

```
 ┌─────────┐   ┌──────────────┐   ┌──────────────┐   ┌───────────┐   ┌──────┐
 │ demux    │──▶│ decode        │──▶│ COMPOSITE     │──▶│ encode     │──▶│ mux  │
 │ (WASM    │   │ WebCodecs     │   │ Pixi/WebGL    │   │ WebCodecs  │   │ mp4  │
 │ ffmpeg)  │   │ VideoDecoder  │   │ + 4× Canvas2D │   │ VideoEnc.  │   │(JS)  │
 └─────────┘   │ (hardware)    │   │ + 2nd WebGL   │   │ (hardware) │   └──────┘
               └──────────────┘   └──────────────┘   └───────────┘
                                       ▲ this box is the problem
```

Audio is decoded, WSOLA-stretched per speed region, AAC-encoded, and muxed by timestamp. It never touches the pixel path — keep it that way.

**The composite box in detail** (`src/lib/exporter/frameRenderer.ts`). The frame walks across **six surfaces and two independent GL contexts** per frame:

```
                Pixi/WebGL (GL#1)                    Canvas2D surfaces
                ┌────────────────┐
 VideoFrame ───▶│ video sprite    │
                │ + zoom + mask   │──drawImage──▶ shadowCanvas ──▶ foregroundCanvas
                │ + motion blur   │              (3× gaussian        │ + webcam
                └────────────────┘               drop-shadow!)       │ + cursor
                                                                     │ + annotations
   threeDPass (GL#2, own context) ◀──texImage2D──────────────────────┤ (if 3D)
        │ rotate quad                                                │
        └──drawImage back─────────────────────────────────────────▶  ▼
                                                              compositeCanvas
                                              wallpaper ──▶  (final; wallpaper
                                              re-blurred      re-drawn every
                                              every frame     frame)
                                                                     │
                                                       new VideoFrame(canvas)
                                                                     ▼
                                                                  encoder
```

**The preview is a *different* compositor** (`src/components/ai-edition/preview-compositor/PreviewCompositor.tsx`): Pixi composites *only* the screen recording; the **webcam stays a plain `<video>` DOM element** with its own sync logic; the cursor is a separate DOM layer that measures the sibling `<video>`. Preview/export parity is maintained **by hand across two divergent implementations** — it is a discipline today, not a property.

### 6. The measurement record

All on the reference machine: Ryzen 5 7520U laptop, integrated AMD Radeon GPU, Windows 11. This is deliberately the *weak* case. (Caveat: it is also the *only* fully-measured machine.)

**Bench methodology** (`npm run bench:export`): opens the real editor window, loads a real saved project, calls the real export entry point. Arms interleave A/B/A/B; same-arm spread is reported; a run above 10 % spread declares itself VOID. Two earlier runs were discarded because battery/thermal drift (up to 62 % spread) *inverted the conclusion* — treat any un-gated benchmark on this hardware as noise.

**M1 — the starting point.** Export ran at **~8 fps** (94.6 s for a 9.1 s clip). 90 % of wall time sat in `encodeWait` (blocked on the encoder queue). Conclusion drawn at the time: *"the encoder is the wall."* (Wrong — see §7.4.)

**M2 — native ffmpeg, fed from the renderer.** A bundled LGPL ffmpeg with the AMD hardware encoder (`h264_amf`) measured **165 fps** encoding pre-materialised frames. So it was wired in: composite in the renderer → copy pixels to CPU → IPC to the main process → pipe into ffmpeg. Result, end-to-end, same project:

| arm | wall | fps | readback time |
|---|---:|---:|---:|
| WebCodecs (status quo) | 38.5 s | **36.9** | 0.16 s |
| native ffmpeg | 80.8 s | 17.5 | **55.2 s** |

**2.1× slower.** ffmpeg itself consumed frames *faster* than WebCodecs (`encodeWait` −29 %) — the loss is entirely the **descent**: `copyTo()` measured 1.43 ms in an isolated probe, but **38.9 ms** inside the real loop (the probe hit an idle GPU; the loop forces a pipeline stall — see "the trap", §3).

**M3 — the ceiling arm.** To bound *every* "make the crossing cheaper" idea at once (removing the sandbox, shared memory, zero-copy IPC): descend every frame and **throw it away** — no IPC, no encoder, no muxer, no audio. Result: **40.5 fps**, vs **44.0 fps** for WebCodecs *doing the whole export including writing the file*. The descent alone, with nothing behind it, loses to the complete shipping pipeline. Every architecture that routes frames through renderer CPU RAM is dead on this machine, and none of them had to be built.

**M4 — the layer bench.** Rebuild the pipeline layer by layer and measure each addition:

| layer | fps | ms/frame | Δ ms |
|---|---:|---:|---:|
| L0 — decode + encode only | **213** | 4.7 | — |
| L1 — + flat background, scale, webcam | 111 | 9.0 | **+4.3** |
| L2 — + wallpaper image | 75 | 13.3 | **+4.3** |
| L4 — + rounded corners | 68 | 14.7 | +1.4 |
| L5 — + drop shadow | 53 | 18.9 | **+4.2** |
| L6 — + circular webcam mask | 52 | 19.2 | +0.3 |
| L7 — + animated zoom | *not yet measured* | | |

Read the first row again. **The full WebCodecs decode→encode loop runs at 213 fps** on this machine. The encoder was never slow.

### 7. What the measurements mean

#### 7.1 The wall was the compositor all along

```
compositing (L1→L6):        14.5 ms
encoder (h264_amf, alone):   6.1 ms
                            ───────
                            20.6 ms  →  48.5 fps
observed WebCodecs export:  20.7 ms  →  48.4 fps      ← the numbers close
```

Why it hid: `new VideoFrame(canvas)` is lazy and `encoder.encode()` is the first operation that forces the GPU/canvas work to finish (`src/lib/exporter/videoExporter.ts:477–519`). So the compositor's 14.5 ms was **billed to the encoder's timer**. The `render` timer (1.7 ms) measured *submission*, not execution.

> **Gate G0 — run this before implementing anything else in this document.**
> Insert a fence (`gl.finish()` or equivalent) after compositing, *before* the `encodeWait` timer starts. If `encodeWait` collapses from ~18.9 ms to ~6 ms, §7.1 is confirmed. If it does not, this document's premise is wrong — stop and re-derive. (~10 lines.)

#### 7.2 Where the 14.5 ms goes — and why it's recoverable

The three +4 ms layers are not paying for content; each opens a **full-frame Canvas2D operation on static or geometry-only data**:

| cost | what actually happens | why it's waste | site |
|---|---|---|---|
| +4.2 ms | **three chained gaussian `drop-shadow` filters over 2.07 Mpx of video, every frame** | `drop-shadow` reads only the alpha channel. The video is opaque and masked by a rounded rect — its alpha *is* the rounded-rect silhouette. The result depends only on `(x, y, w, h, radius, intensity)`, not on a single video pixel. | `frameRenderer.ts:1045` (dup at `:533`) |
| +4.3 ms | **the wallpaper — a static image — is cleared, re-blurred (`blur(6px)`) and re-blitted every frame** | it never changes; blur it once at init | `frameRenderer.ts:1007–1017` |
| +4.3 ms (L1) | a `BlurFilter` that is **always zero** (all four writes to `.blur` in the export path set 0) sits permanently in `videoContainer.filters`, forcing Pixi into render-to-texture + a full-screen pass per filter, per frame; plus a GL texture is created and destroyed per frame | dead filter; texture churn | `frameRenderer.ts:235/238/240`, `:409–415` |

Also rebuilt per frame for no reason: the mask tessellation (`:769–771`). The correct patterns already exist elsewhere in the same tree: conditional filter attachment in `pixiCursorRenderer.ts:568`; texture reuse in `threeDPass.ts`.

#### 7.3 Verdicts on the previously-considered options

| option | verdict | why |
|---|---|---|
| WebCodecs pipeline | **stays — fastest path measured** | M2/M3 |
| native ffmpeg fed from the renderer | **dead** | M2: ×0.48 |
| `sandbox: false` + direct pipe to ffmpeg | **dead** | M3 bounds it; also sacrifices the sandbox for ~1.2× on one leg |
| GPU→NV12 packing to shrink the descent | **withdrawn** | best case parity, against a compositor about to get 3× faster |
| full Tauri/Rust rewrite ("option C") | **deferred, gated** | its premise (composited texture → encoder with zero descent, via wgpu↔D3D11/VideoToolbox interop) is *unmeasured*; spike required before any migration (§12) |

#### 7.4 The trap, named once for the whole document

**An isolated component benchmark cannot price the cost of connecting the component.** Three confident wrong answers came from probes that didn't force the work the real loop forces: the pipe probe (489 MB/s "≈3 %" — frames materialised outside the loop), the `copyTo` probe (1.43 ms idle vs 38.9 ms in-loop), and the `render` timer (1.7 ms submission vs 14.5 ms execution). Any new benchmark an agent writes for this project must answer: *what sync point am I including, and does the real loop include the same one?*

---

## Part III — The target architecture

### 8. Three structural conclusions

**(a) The frame is a pure function.** Every §2 appearance feature is deterministic given `(document, t)`. So extract:

```
evaluate : (Document, t) → FrameState
FrameState = { sourceTimes, rects, transforms, velocity, maskParams,
               shadowGeom, activeCaptions, annotations }
```

CPU, microseconds, testable without a GPU. **Parity lives here**: preview and export call the *same* `evaluate`, so they cannot drift on layout, easing, timing, or reveal logic. (The geometry code already exists, smeared across `compositeLayout.ts`, `zoomTransform.ts`, `updateAnimationState` — this is an extraction, not a rewrite.)

**(b) The compositor is tiny.** The entire feature set compiles to:

```
4 textures      screen · webcam · background · glyph/annotation atlas
1 uniform block ~200 bytes: rects, matrices, velocity, radii, shadow
                params, mask selector, reveal progress
2 passes        P1: directional motion blur   (only when |velocity| > 0)
                P2: composite — one draw call
                (P3: 3D rotation — folds into P2's vertex stage)
caches          wallpaper 1× · shadow per-geometry · masks per-shape ·
                caption rasters per-segment · cursor sprites 1×
```

Any 2015-class GPU runs this in **< 2 ms** at 1080p. Compositing cost therefore justifies **no** stack choice. Text is the one thing that stays CPU-rasterised (glyphs → offscreen → texture, cached per segment, raster only the caption's ~1920×200 rect).

**(c) Only two seams matter.** With (a) at ~0 ms and (b) at ≤2 ms, the architecture is decided by two data handoffs:

```
S1 : decoded frame ──▶ compositor texture   (decode → GPU)
S2 : composited target ──▶ encoder          (GPU → encode)
```

Every measured disaster in §6 happened at a seam. **Design rule: both seams stay on the GPU device and are crossed exactly once per frame.** The web platform's S1 (`VideoFrame` → texture import) and S2 (`VideoFrame(canvas)` → `VideoEncoder`) are the designed fast paths and are what L0's 213 fps already includes.

### 9. The reference diagram

```
┌──────────────────────────────────────────────────────────────────┐
│  UI shell — timeline, panels, inspector (React/DOM)              │
│  never touches pixels                                            │
└──────────────┬───────────────────────────────────────────────────┘
               │ edits (pure data operations)
┌──────────────▼───────────────┐
│  Document store               │   atomic writes: temp + rename,
│  undo/redo = data             │   serialised saves (§13 — bug)
└──────────────┬───────────────┘
               │ (Document, t)
┌──────────────▼───────────────┐      ┌───────────────────────────┐
│  EVALUATOR — pure CPU fn      │      │  AUDIO ENGINE             │
│  (Document, t) → FrameState   │      │  decode · WSOLA · mix     │
└──────────────┬───────────────┘      │  playback: MASTER CLOCK   │
               │ uniforms              │  export:   AAC → mux      │
┌──────────────▼───────────────┐      └─────────────┬─────────────┘
│  MEDIA I/O                    │                    │
│  demux · HW decode · seek     │                    │
│  decode-ahead ring        S1  │                    │
└──────────────┬───────────────┘                    │
               │ GPU-resident textures               │
┌──────────────▼───────────────┐                    │
│  COMPOSITOR — one WGSL prog   │                    │
│  P1? · P2 · (P3)  + caches    │                    │
└──────┬───────────────┬───────┘                    │
       │ swapchain     │ offscreen  S2               │
┌──────▼──────┐  ┌─────▼───────────┐                │
│  PREVIEW    │  │  ENCODER         │◀── mux by ─────┘
│  vsync/rAF  │  │  HW, pipelined,  │    timestamp
│  viewport   │  │  queue depth ≥ 2 │
└─────────────┘  └─────────────────┘
```

Sinks differ by **three parameters only** — target, clock, resolution:

| sink | target | clock | resolution |
|---|---|---|---|
| preview | swapchain | display (rAF/vsync) | viewport |
| MP4 | offscreen texture | frame index | output |
| GIF | offscreen texture | frame index (low fps) | output (+ palette pass) |

One pixel path, N sinks ⇒ the "two divergent compositors" problem of §5 becomes *unconstructible*. This also means the unified compositor must absorb the **preview's** webcam and cursor (currently DOM), not just the export path.

### 10. Preview fluidity — priority 1, engineered as three separate problems

| mode | requirement | mechanism |
|---|---|---|
| **tweak** — drag a slider, move the webcam | ≤ 1 frame latency at display Hz | parameter changes are **uniform-only**: no re-layout, no re-decode, no cache invalidation except the touched cache (shadow on geometry change). Redraw = pass P2 alone ⇒ 120 Hz is trivial |
| **play** | 60 fps with A/V lock | audio is the master clock; decode-ahead ring of 3–4 frames per stream; late *video* frames drop, audio never skips |
| **scrub** | perceived-instant seek | (a) keyframe-aware seek + decode-forward; (b) a **pre-generated low-res proxy strip** (thumbnail keyframes every N ms) displayed instantly while the exact frame decodes; (c) seek coalescing — only the last requested time is decoded |

The proxy strip is the one genuinely new component: screen recordings have long GOPs, so exact-seek latency is decode-bound and irreducible — the proxy is what makes scrubbing *feel* instant anyway. No prior spec addressed scrubbing at all.

### 11. Export speed — priority 2

With both seams on-device and the compositor ≤2 ms, the pipeline is **encoder-bound by construction** — the correct steady state. Pipeline, don't await: keep encoder queue depth ≥ 2; never sync the device per frame; the only backpressure is the encoder's own.

Projection on the weakest measured machine: 213 fps encoder ceiling ⇒ a 546-frame export in **~2.6–3.3 s** (vs 94.6 s at the start of this project, ×30). Parallel GOP-segment encoding stays in the drawer — at 213 fps it buys nothing at 1080p.

### 12. Stack — decided last, and made reversible

Evaluated against the seams, the three preview modes, one-compositor parity, a small OSS team, and full platform coverage:

| candidate | seams | verdict |
|---|---|---|
| **A. Web platform done right** (Electron, one WebGPU context, WebCodecs) | S1+S2 measured at 213 fps — *faster than the native encode leg (165 fps) on the same machine* | **launch host** |
| B. Rust core (wgpu) + Tauri webview UI | S2 better in principle (texture → AMF/VideoToolbox directly), **but** a new seam appears — composited frames must reach the webview viewport — and the wgpu(D3D12)↔AMF(D3D11) interop is unmeasured | open, behind a spike gate |
| C. Full native per platform | optimal seams, three compositors, three CI matrices | eliminated on cost for this team, not on merit |

**The reversibility mechanism — the one instruction that shapes code written today:**

> **Write the compositor in WGSL (WebGPU), not GLSL/Pixi. Keep `evaluate` pure and host-agnostic.**

WGSL runs unmodified in the browser (WebGPU) *and* natively (wgpu). The evaluator and the shader — the product's actual substance — become portable by construction. Only the shell, the Media I/O bindings and the encoder binding are host-locked. Electron-vs-Tauri stops being an architectural bet and becomes a bindings swap behind pre-committed triggers:

| gate | trigger | response |
|---|---|---|
| G-A | after the §8b compositor ships, export < 100 fps on the reference machine *and* profiling pins the loss inside Chromium's S1/S2 | run the B spike: wgpu renders a triangle → native texture handle → AMF → mp4 (~200 lines, no compositor, no UI). If the handoff holds, move Media I/O + encode to a Rust core; WGSL + evaluator move unchanged |
| G-B | tweak mode can't hold display Hz with uniform-only updates | same |
| G-C | a platform ships hardware codecs Chromium won't expose | per-codec encoder *sidecar* — no host change |
| none | — | host question stays closed |

### 13. Ship order

**Step 0 — the data-loss bug, before any of this.** `writeProject` (`src/lib/.../document-service.ts`) allows two concurrent saves to interleave (`O_TRUNC` + offset writes), which has already destroyed a real project file (valid JSON prefix + tail of a longer version; effects unrecoverable). Fix: serialise saves + atomic write (temp file + rename). Audit every writer in the file. **A performance spec is worthless next to projects that destroy themselves on save.**

**Step 1 — G0** (§7.1): the fence. 10 lines. If it fails, stop.

**Step 2 — exact fixes, ~50 lines total, byte-identical output, no parity review** (details §7.2):

| fix | site |
|---|---|
| pre-blur wallpaper at init; per-frame draw = plain blit with `globalCompositeOperation='copy'` | `frameRenderer.ts:1007–1017` |
| shadow: render the same 3-filter chain **once per geometry** onto a white rounded-rect silhouette, cache by `(rect, radius, intensity)`, per-frame = 2 `drawImage` | `:1045` (and `:533`) |
| delete the always-zero `BlurFilter`; attach `motionBlurFilter` only when `velocity > 0` (pattern: `pixiCursorRenderer.ts:568`) | `:235/238/240` |
| reuse one GL texture, stop create/destroy per frame (pattern: `threeDPass.ts`) | `:409–415` |
| rebuild mask only on layout change | `:769–771` |

Do **not** replace the shadow with an SDF/`smoothstep` approximation: the cascaded falloff is exact-cached instead, because this codebase has already been burned twice by shadow-falloff/corner-AA approximations (see the comments in `threeDPass.ts`).

Projected result: 14.5 → ~4 ms compositing ⇒ **~90 fps export**, still inside Electron, zero architecture change. *Projection, not measurement* — hence:

**Step 3 — measure.** Re-run the layer bench (G1). Measure **L7 (animated zoom)** — the missing row — because it decides everything downstream: the shadow cache misses during zooms (geometry changes every frame), so the fraction of zoomed frames determines whether Step 4 exists.

- zoom frames ≲ 20 % of a typical timeline → the cache captured ~90 % of the win → **stop here**; ship
- zoom frames ≳ 50 % → the per-frame shadow is still the wall where it matters → Step 4

Also owed: one bench run on a discrete GPU and on Intel QSV (G3) — every number in this document is from a single iGPU laptop.

**Step 4 (conditional) — the unified WGSL compositor** (§8b + §9): one context, two passes, caches; absorbs the preview's webcam + cursor; text via cached atlas textures. Built inside Electron/WebGPU, where a working baseline exists to measure against — and where the WGSL is already the portable artifact if gate G-A ever fires.

**Step 5 (gated) — host swap**, only if a §12 gate fires, only after its spike passes.

### 14. Non-goals

Audio internals (WSOLA/AAC/sync — orthogonal, untouched) · cuts & speed regions (they select source frames; not compositing) · the `.axcut` document format · the React shell · HEVC/AV1 (behind the sink decision) · parallel segment encoding (nothing to gain at current ceilings).

---

*Provenance: every number in Part II is a gated measurement on the reference machine; §7.1's closing arithmetic is a deduction with G0 as its named falsifier; the 213-fps-beats-165-fps comparison is same-machine, same-frames. The two prior specs' full measurement reports remain the source of record for methodology details.*

---

## Annex A — Gate G0: PASSED (measured 2026-07-17)

Run on the reference machine, real bench harness (`npm run bench:export`), four arms
interleaved, 2 runs each, effects `shadow,blur,radius`, 1080p60, 820 frames.
Project: `proj_5b3ac6bc` ("Recording 15/07/2026 18:38:53") — **not** the record's
`os_parity`, which was found destroyed by the §13 Step-0 bug (see note below).
This project is heavier than the record's: two clips, both with a visible webcam
track — absolute numbers are therefore not comparable with §6; the arm-vs-arm
attribution, which is all G0 claims, is.

| arm | wall | fps | spread | encodeWait total | fence total |
|---|---:|---:|---:|---:|---:|
| webcodecs-legacy | 83.3 s | 9.8 | 5 % | 58 305 ms | — |
| webcodecs-legacy-fence | 64.4 s | 12.8 | 8 % | **3 181 ms** | 44 538 ms |
| webcodecs | 56.6 s | 14.6 | 5 % | 32 368 ms | — |
| webcodecs-fence | 50.1 s | 16.4 | 9 % | **3 013 ms** | 28 199 ms |

Per frame (820 frames): legacy `encodeWait` 71.1 → **3.9 ms** (×18 collapse), the
difference reappearing under `fence` (54.3 ms/frame); shipping compositor 39.5 →
**3.7 ms** (×10.7), `fence` 34.4 ms/frame. `encode` itself is ~0.03 ms/frame.

**§7.1 is confirmed.** `encodeWait` was billing the compositor's GPU execution;
the encoder's own residual wait is ~3.7–3.9 ms/frame on this machine. The wall is
the compositor — here even more so than §7.1 estimated, because this project
composites a webcam bubble on every frame of both clips.

Two additional findings the gate did not ask for:

1. **The fenced arms are FASTER end-to-end** (legacy −23 %, shipping −11 %).
   Draining the GPU once per frame beats letting Chromium queue unboundedly —
   deep uncontrolled pipelining is actively harmful here. §11's "pipeline, don't
   await" needs the nuance: *bounded* in-flight work, not maximal.
2. **The Step-2 fixes are confirmed in-run**: legacy 9.8 → shipping 14.6 fps
   (+49 %) on a project whose per-frame webcam compositing they never touched.

---

## Annex B — Step 3: the L7 row, and what it decides (measured 2026-07-17)

Same machine, same harness, `--clip=4` (122 frames), 4 runs per arm plus one
discarded warm-up, four arms interleaved. **Spread 2–4 %** — the run is valid.
All arms fenced (Annex A), so the compositor's cost is billed to `fence` and not
to the encoder. Shadow is isolated by *pairs*: an arm's twin sets
`shadowIntensity: 0`, because omitting the effect still renders the project's own.

| arm | camera | shadow | wall | ms/frame |
|---|---|---|---:|---:|
| webcodecs-fence | still | on | 4144 ms | 34.0 |
| webcodecs-fence-noshadow | still | off | 3990 ms | 32.7 |
| webcodecs-fence-zoom | moving | on | 5835 ms | 47.8 |
| webcodecs-fence-zoom-noshadow | moving | off | 4659 ms | 38.2 |

Shadow cache: **0.8 % miss** with a still camera (121 hits / 1 miss), **54.1 %
miss** during the zoom (56 / 66) — byte-identical across all four runs, so the
miss rate is a property of the timeline, not of the machine.

**The arithmetic, per frame:**

| item | cost |
|---|---:|
| shadow, cache HOLDING (still camera) | **1.3 ms** |
| shadow, cache MISSING (moving camera) | **16.7 ms** |
| everything else the zoom adds (motion-blur filter, transform) | ~10.1 ms |
| a still frame, all in | 34.0 ms |
| a moving frame, all in | ~59 ms |

So the Step-2 cache is doing exactly what it was built for — it takes the shadow
to ~0 on still frames — and it cannot help on a moving one, by construction. On a
moving frame the shadow alone costs half again as much as the *entire rest* of the
compositor (16.7 vs 32.7 ms). It is the single largest per-frame item there.

**Two findings the ship order did not anticipate:**

1. **§13's decision rule cannot be answered by fps.** It asks for the share of
   *zoom* frames; the cost tracks the share of **moving** frames — the eased
   in/out, not the plateau. A settled zoom holds the cache (that is why 56 of the
   zoom arm's frames still hit). The expensive case is therefore not "a timeline
   with zooms" but auto-focus, which pans with the cursor and moves *every* frame
   of its region. The product question — "how much of a typical timeline has a
   MOVING camera" — is the user's, not the bench's.
   **Answered, 2026-07-17 (product owner): a moving camera is the norm.** Screen
   presentations carry zooms by nature; the webcam is commonly set to resize
   reactively *during* those zooms; and Full Camera animates the webcam across the
   whole stage. That is §13's "≳ 50 %" branch — **Step 4 is warranted**, subject
   to B.1 below.
2. **Step 4 as specified does not fix this.** §8b lists the compositor's caches as
   "wallpaper 1× · **shadow per-geometry** · masks per-shape · …" — the same
   geometry key, hence the same 54 % miss during motion. The unified WGSL
   compositor only removes this cost if the shadow is *computed* per frame in the
   shader rather than cached — and §13 explicitly forbids the SDF/`smoothstep`
   approximation that would make that cheap, because the cascaded falloff has
   burned this codebase twice. **Unresolved: a shader that reproduces the exact
   3-pass cascade at 1080p, and its cost.** That, not the fps, is Step 4's real
   gate.

### B.1 — What the 16.7 ms actually is, and therefore what fixes it

A cache miss is two stacked things: the three chained gaussians, and the
full-frame Canvas2D plumbing feeding them (silhouette copy, `source-in` fill,
filtered blit — 2 Mpx each). They have different fixes, so they were priced apart
with a third arm that runs the whole miss path with the filter chain switched off
(`openscreen.shadowNoFilter` — renders no shadow; diagnostic only). Timing the
ops individually would have answered nothing: Canvas2D is as lazy as the GPU, so
a timer around a `drawImage` measures submission and bills the work to whatever
syncs next (§7.4). Hence an arm pair, both fenced.

`fence` totals, 122 frames, 66 of them missing the cache — two independent runs:

| arm | run A | run B |
|---|---:|---:|
| zoom + shadow | 3668 ms | 4086 ms |
| zoom + shadow, no gaussians | 2734 ms | 2964 ms |
| zoom, no shadow at all | 2513 ms | 2730 ms |
| **⇒ gaussians** | **934 ms** | **1122 ms** |
| **⇒ plumbing** | **221 ms** | **234 ms** |

**The gaussian chain is ~81 % of the miss** (~14.2 ms per moving frame, against
~3.3 ms of plumbing). Run B is VOID on its own spread gate (31 %; the machine had
been benching continuously for ten minutes and was drifting) — but it is reported
because the two runs agree on the *ratio* (4.2 : 1 and 4.8 : 1) while disagreeing
on the absolute, which is exactly what interleaved arms under drift should do.
A 4 : 1 ratio does not turn over inside that noise.

**So: touching less of the frame recovers ~3 ms; the fix has to be the filter.**
Which is where §13's prohibition needs a distinction it does not currently make:

> **The ban is on a different falloff, not on a different implementation.** §13
> forbids replacing the shadow with an SDF/`smoothstep` — rightly: that is an
> *approximation of a different shape*, and it has burned this codebase twice.
> But CSS `drop-shadow` is not a black box. It is `feGaussianBlur` on SourceAlpha,
> and the SVG filter spec **defines** that blur, for our radii, as three
> successive box blurs of a specified width. Reimplementing that cascade in a
> shader is the same algorithm on a different device — not an approximation.
> Box blurs are separable and O(1) per pixel; this is the cheap case on a GPU.
>
> That claim is falsifiable and must be falsified before it is built: the spike is
> a GPU pass rendering the same silhouette, pixel-diffed against the Canvas2D
> output. If they do not match, this paragraph is wrong. Skia's real path may not
> follow the spec's letter.

**Consequence for the ship order.** The spike stands alone — it replaces
`cachedShadowLayer`'s filter with a GPU pass and needs no architecture change, so
it pays off inside Electron today *and* is exactly the shadow §8b's compositor
needs. It should be measured before Step 4 is committed to, not during it.

**Bench corrections this measurement forced** (each was silently wrong before):

- The `zoom` effect injected `depth: "medium"`; `ZOOM_DEPTH_SCALES` keys on 1–6,
  so the lookup returned `undefined` and **the zoom never ran**. Every previous
  zoom arm reported a clean number for an effect that did nothing. The injected
  region is now parsed through `zoomRegionSchema` — the pipeline's own contract.
- The session's **first export** pays for shader compilation, decoder setup and
  JIT (9.3 s vs 5.6/6.6/5.8 s for its own repeats) and lands on whichever arm ran
  first: a 60 % same-arm spread that voided two runs by itself. One discarded
  warm-up per arm brings the spread to 2–4 %.
- Effects are now per-arm (`addEffects`), so an effect is A/B'd inside ONE
  interleaved run. `--effects` alone is one value per session, which turns any
  effect comparison into a cross-session one — the mistake this bench exists to
  prevent.

**Reference-project caveat.** `proj_5b3ac6bc`'s first clip declares
`durationSec: 4.03` but holds ~2.03 s of decodable video (its own zooms, authored
at 3163 ms, are past the end and never fire — which is why the still arms sit at
0.8 % miss). The measurement stands on the injected zoom; the stale duration is
its own bug, unrelated to rendering.

---

**Step-0 note (data loss, §13).** The record's reference project `os_parity`
(`proj_de6ffaaa…openscreen`) was found corrupted with exactly the §13 signature:
a complete, valid save (updatedAt 2026-07-16T18:00:26Z) followed by the tail of a
longer, older version — `JSON.parse` fails at byte 3485 and the app can no longer
list it. A byte-identical backup was taken (`….openscreen.corrupt.bak`, alongside
an older victim `proj_05a4bb1c….corrupt.bak`). Recovery is mechanical — truncate
to the valid 3485-byte prefix — pending the user's go-ahead. That is **two**
destroyed project files; Step 0 stays the first line of the ship order.
