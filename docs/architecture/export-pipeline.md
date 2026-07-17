# Export pipeline — architecture and performance

Status: **Current as of 2026‑07‑17.** Multi‑asset export is shipped. The performance work is measured.
Scope: the `.axcut` (AI‑edition) export path. The legacy `components/video-editor` exporter is out of scope.
Owners: ai-edition editor team

> **This file replaces three.** `export-pipeline-v2-spec.md`, `native-core-tauri-spec.md` and
> `export-native-encode-measurement.md` are deleted. They disagreed with each other and, on the
> performance half, with reality — each was written on top of the previous one's wrong conclusion.
> What was true in them is here; what was refuted is in §5, with the evidence, so nobody proposes it
> again.

---

## 1. The short version

**The compositor is 79 % of an export's wall time.** Not the encoder, not the readback, not the IPC
crossing. Everything else this pipeline has chased was a measurement artefact of one fact: the
compositor *submits* GPU work and returns immediately, so whatever forces the first synchronisation
gets billed for it.

Fixing what the compositor rebuilt every frame — a drop shadow that depends only on a rectangle, a
still wallpaper re‑blurred 1418 times, a GPU texture allocated and freed per frame, a mask
retessellated per frame — made exports **~1.6–2.0× faster with byte‑identical output**.

Three architectural rewrites were proposed, built or costed before that. All three lost (§5).

---

## 2. Architecture as shipped

### 2.1 The `RenderPlan`

`src/lib/ai-edition/exporter/renderPlan.ts` turns an `AxcutDocument` into an ordered, per‑clip plan.
`documentExporter.exportAxcutDocument()` is the single entry point — `ExportDialog` and the bench
both go through it.

```ts
interface RenderSegment {
  clipId: string;
  assetId: string;
  videoUrl: string;             // toFileUrl(asset.originalPath) — the doc is self-contained
  sourceStartSec: number;       // clip in-point in the asset's media time
  sourceEndSec: number;
  intraTrims: Interval[];       // trimRanges of THIS asset inside [start,end)
  cropRegion: CropRegion;
  sourceWidth: number;
  sourceHeight: number;
  camera?: { videoUrl: string; offsetMs: number } | null;  // per-asset webcam
}
```

### 2.2 Segment loop

`VideoExporter.runSegmentLoop()` walks the segments with one `FrameRenderer`, one encoder and one
muxer. Per segment: load metadata, `renderer.setSource(...)` for this asset's dims/crop/webcam,
decode, render, encode; dispose the decoder before the next (one active decoder at a time).

**Time projection.** The encoder timestamp is contiguous **output** time, so junctions are seamless.
`renderFrame` receives **source** time, so zoom/annotation/cursor match the frame's content even when
a speed region retimes the segment. An earlier draft proposed keying effects in virtual time
throughout; that does not survive speed regions, and the two-clock split is why.

### 2.3 Decisions in force

- **Per-segment cursor.** `CursorRecordingSample.assetId` tags each sample, so the plan partitions
  the shared recording per segment.
- **Clips are contiguous** — no gaps, no overlap.
- **Audio and video junctions are seamless.** Audio is decoded per segment up front, retimed
  per speed sub-region (WSOLA, pitch preserved), then concatenated at offsets sized from the **real**
  per-segment frame counts — not the estimate — so A/V stays locked. An equal-power fade covers each
  join. The WSOLA stretch is kicked off before the video loop so it overlaps it.
- **Output** is sized to the largest clip and honours the timeline's aspect ratio.

### 2.4 Licensing

The app is MIT and stays MIT. Any bundled ffmpeg must be built **without** `--enable-gpl` and
without `--enable-nonfree` — those flags are what pull x264/x265 and fdk-aac, and licensing is
all-or-nothing. `scripts/fetch-ffmpeg.mjs` vendors a **pinned, checksum-verified** BtbN LGPL build
and gates it on three independent signals (`-L` says "Lesser General Public License"; no GPL flags
or GPL libs in `-buildconf`/`-version`; no `libx264`/`libx265` in `-encoders`). It fails closed.

Note `ffmpeg -version` has **no** `License:` line — only `configuration:`. The licence text is behind
`-L`. An early gate looked for the former, found nothing, and refused to vendor anything; failing
closed is why that was a bug and not an incident.

---

## 3. Performance: what the wall actually is

Measured with `npm run bench:export` (§4) on `proj_a7468696` (2 assets, 2 clips, webcam;
MP4/1080p/60/H.264; 1418 frames), AMD Ryzen 5 7520U + integrated Radeon.

### 3.1 The compositor, unmasked

Three arms in one run, each adding one stage to the one above:

| arm | ms/frame | what it does |
|-----|---------:|--------------|
| `composite-ceiling` | **24.6** | decode + composite, **nothing downstream** |
| `readback-ceiling` | **24.6** | the same **+ a full `copyTo()`** |
| `webcodecs` | 31.1 | the same + encode + mux + file |

**Adding the entire GPU→CPU descent moves the wall by 0.03 ms/frame.** The compositor is 79 % of the
export. The encoder is 4.5.

### 3.2 Why every earlier measurement lied

`renderFrame` **submits** GPU work and returns; `new VideoFrame(canvas)` is **lazy**; nothing has
executed yet. The first stage to force a synchronisation is billed for everything queued before it.

So `render` reported **2.06 ms/frame** for work costing **24.6** — under by **13×** (with a shadow
on: 1.55 vs 63.7, under by **41×**). The cost surfaced downstream, under whatever name that stage
had: `encodeWait` at "90 % of wall", a "readback" of 32 seconds, a "descent" of 38.9 ms/frame. One
wall, three disguises — and each disguise launched an architecture programme against the wrong thing.

**This retires "≈13 ms/frame of Chromium overhead on a path we do not control."** It is our
compositor, and we control all of it.

**Any stage timer in this pipeline measures submission, not execution, unless something forces a
sync.** Trust the ceiling arms, not `StageTimings`.

### 3.3 What the compositor was rebuilding every frame

| what | why it was free to fix | measured |
|------|------------------------|---------:|
| **drop shadow** | three chained `drop-shadow` over the full frame. `drop-shadow` reads **SourceAlpha only**, and `videoCanvas`'s alpha is just the sprite masked by a roundRect — so it blurred 2M pixels of *video* to compute a function of `(rect, radius, intensity)`. The video never reached the result. | **~30 ms/frame** |
| **wallpaper blur** | a still image, rasterised once at load, then re-blurred 1418 times | ~5 ms/frame |
| **video texture** | `Texture.from(videoFrame)` + `oldTexture.destroy(true)`: allocate, upload and free a 1080p GPU texture per frame (every `VideoFrame` is a new object, so nothing caches) | — |
| **rounded mask** | `clear()/roundRect()/fill()` retessellates a shape identical from frame to frame | — |

Per-effect cost on the real compositor, isolated (spread 3–4 %): **shadow 43.5 ms/frame**, blur 17.9,
radius 13.3. Radius is ~free — it draws inside a pass that already exists.

### 3.4 The fix, and its shape

**Classify by what invalidates it, not by layer:**

| never | on geometry | every frame |
|-------|-------------|-------------|
| wallpaper blur | drop shadow, rounded mask, video texture | video, cursor, webcam, annotations |

The shadow now runs against a **silhouette** — taken from `videoCanvas`'s own alpha
(`drawImage` + `source-in` over black), not re-derived from the layout, so nothing has to stay in
sync as layout code evolves. Its output *is* `silhouette OVER shadow`, so drawing `videoCanvas` on
top covers the silhouette exactly, **including the anti-aliased corners**. Cached on the geometry:
**1417 hits / 1 miss** over 1418 frames.

Also: `clearRect(w,h)` before a `drawImage(w,h)` that covers the canvas is two full-frame passes
where `globalCompositeOperation = "copy"` is one.

### 3.5 What it bought

Within-run ratios only (§4.2 explains why):

| run | before | after | ratio |
|-----|-------:|------:|------:|
| `composite-ceiling`, shadow+radius | 39.45 ms/frame | 20.22 | **1.95×** |
| `webcodecs`, blur+shadow+radius | 67 717 ms | 33 707 | **2.01×** |
| `webcodecs`, shadow+radius | 63 825 ms | 39 839 | **1.60×** |

**Output is byte-identical.** Same timeline, same encoder, old compositor vs new → the files are
identical byte for byte, SSIM 1.000000 across all 1418 frames. Not a pixel moved.

### 3.6 What is left

- **Zoom defeats the shadow cache.** A zoom region changes the geometry every frame, so the shadow
  pays full price for its whole duration. This is the strongest remaining case for a single-pass
  shader — and it must be argued on what remains *after* §3.4, not on the 30 ms already gone.
- **The 3D path is not cached** and stays at full price on purpose: it blurs `foregroundCanvas`,
  whose alpha carries the webcam, cursor and annotations, so it has no stable geometry to key on.
- **The webcam mask** is unaudited: the shape does not change, only the pixels inside it.

---

## 4. The bench

```bash
npm run bench:export -- --project=<id|title> --arms=webcodecs,native --runs=2 --effects=shadow,blur
```

`scripts/bench-export.mjs` + `src/bench/runBench.ts`. It **simulates nothing**: it opens the real
editor window (same `webPreferences`, preload and sandbox), loads a real saved project through the
same bridge the editor uses, and calls `exportAxcutDocument` — `ExportDialog`'s own entry point. Only
React is skipped, so nothing renders alongside the export.

It exists because driving this through the UI cost ~5 minutes a run and kept injecting confounds: one
A/B ran with DevTools open on **one arm only**; another ran on a laptop at 5 % battery whose SoC
budget drifted 26 % *between the two arms* — enough to invert the conclusion.

**Arms** set `localStorage` flags read at runtime, so one app session measures every arm against one
document: `webcodecs`, `native`, `*-legacy` (the pre-2026‑07‑17 compositor, for attribution),
`composite-ceiling` (render only), `readback-ceiling` (render + `copyTo`, discard).

**`--effects=shadow,blur,radius,zoom`** patches an in-memory **copy** of the document; nothing
reaches disk. Saved projects carry no appearance at all (`shadowIntensity` defaults to **0**), so
whole effects never execute — "fixing" the shadow on a default project measures exactly zero. `zoom`
matters beyond its own cost: it is the only effect that changes geometry per frame, so it is what
invalidates a geometry-keyed cache. **A parity test without it passes with a broken cache key**,
because nothing ever asks the cache to invalidate.

### 4.1 Parity is gated, not argued

Unit tests never look at a pixel. The `native*` arms write real files: export the same timeline
through the same encoder with each compositor, then `cmp` and `ffmpeg -lavfi ssim`. Every compositor
change above cleared it byte-for-byte. **"Obviously equivalent" is what this pipeline keeps
punishing** — gate it.

### 4.2 This machine is not reproducible. Only ratios are.

The same arm, same project, same settings has measured **44.0, 36.8, 32.3, 31.8, 22.2 and 11.9 fps**
across sessions. The 11.9 run reported **0 % spread** over its two samples — it looked airtight and
did not survive a re-run 40 minutes later (22.2).

So: **arms interleave (A,B,A,B), and the bench reports same-arm spread and declares itself VOID above
10 %.** Never quote an absolute fps as "what the export does"; quote a within-run ratio. A stable
measurement is not a true one.

---

## 5. Refuted: do not re-propose these

Every row was built or costed against the wrong wall (§3.2). Kept so the argument is not re-run.

| proposal | verdict |
|----------|---------|
| **Native ffmpeg fed from the renderer** (bundled LGPL, hardware encoder) | **2.1× SLOWER** (38.5 s → 80.8 s, spread 3–4 %). ffmpeg consumes frames *faster* (`encodeWait` −29 %, `flush` −94 %) — but WebCodecs encodes straight off the GPU texture and never brings a frame to the CPU. Adding a descent to a wall that was already there. |
| **A′ — `sandbox: false`**, renderer spawns ffmpeg and writes its stdin | **Excluded without building it.** With the crossing at *exactly zero* (frames descended then discarded: no IPC, no ffmpeg, no muxer) the pipeline still lost, **while WebCodecs was also writing the file**. A′ does not even remove the crossing — it swaps a structured clone (~390 MB/s) for a pipe write (~500 MB/s), ~1.2× on one leg, bought by giving up the sandbox that guards demux/decode of untrusted media. |
| **Phase 4 — GPU BGRA→NV12 packing** | Cannot rescue the above. The descent measured **6.7 ms fixed + 3.9 ms/MB** (257 MB/s marginal — a sync, not a copy), so NV12 halves it and still lands at parity at best. |
| **Native CPU compositor** | Reached parity at best — and that comparison was anchored on the 44 fps figure §4.2 retired, so it is not even that solid. Compositing is what CPUs are bad at and GPUs are good at; avoiding the descent pays it back in compositing. |
| **Worker + OffscreenCanvas** | Buys UI responsiveness, not speed. The main thread was never the throughput limit. |
| **GPU-resident compositing** (`a31cf49` → reverted `e6cbb45`) | Implemented, measured, reverted: moved the work, left the synchronisation where it was. |

### 5.1 Native core / Tauri

**It is not *Node vs Rust*, and not *Electron vs Tauri*.** Neither the language nor the shell forces
the descent — **the browser engine does**. The compositor is Pixi/WebGL/Canvas2D inside Chromium's
renderer, and Chromium exposes its GPU textures to nobody. Tauri's webview on Windows *is* Chromium
(WebView2): composite in the webview under Tauri and you pay the identical descent.

Zero descent requires one thing: **the compositor stops being a web canvas** and becomes our own GPU
code, owning the same device as the encoder. That is reachable **from Electron too** — an N-API
addon, or a native sidecar. **The shell is a consequence, not a cause**; it earns its place on bundle
size and memory, never on this measurement. What would actually force the shell question is the
**preview**: once the compositor is native, the preview must come from it too, or the product ships
two compositors and loses the parity that is its entire value.

**Hardware findings, if anyone revisits this** (measured 2026‑07‑17, bundled ffmpeg, this laptop):

- **GPU decode → GPU encode, no descent, no compositing: 234 fps.** The physics has room; the floor
  is not the problem.
- **Vulkan is a dead end for the encoder here**: the driver exposes `video_decode_queue` only (no
  encode queue), and AMF refuses to initialise from a Vulkan device — *"not supported"*, explicitly.
- **`scale_d3d11` fails** to create its texture (`80070057`) on every format tried.
- **d3d11 → OpenCL `hwmap` fails** on NV12's UV plane.
- So **the ffmpeg CLI cannot express GPU-composite → GPU-encode on this hardware** — a limit of its
  filter plumbing, not of the GPU, which composites the whole scene natively today. A real native
  core would decode with libavcodec into a **D3D11** texture (not Vulkan, not OpenCL), composite on
  that device, and hand the texture to AMF.

---

## 6. Traps this pipeline has actually fallen into

Each cost hours and each produced a confident, wrong conclusion.

1. **`app.getGPUFeatureStatus()` from a windowless script** reports everything `disabled_software`.
   Always probe with a real window.
2. **Piping via `cat` under Git Bash** caps at ~70 MB/s — MSYS emulation, not Windows.
3. **`new VideoFrame(canvas)` is lazy.** Timing the constructor measures nothing.
4. **Isolated component benchmarks cannot price the cost of connecting the component.** The
   `node → ffmpeg` probe measured 489–589 MB/s by materialising frames **once**, outside the timed
   loop — a true statement about the pipe that said nothing about the pipeline.
5. **`-encoders` lists what was compiled in, not what the machine can run.** A portable build lists
   nvenc/qsv/amf everywhere; on this AMD laptop nvenc dies with "Cannot load nvcuda.dll". Only a
   one-frame smoke encode settles it — and the unit tests passed *because the fixtures encoded the
   same wrong assumption as the code*.
6. **Electron cannot transfer an ArrayBuffer renderer→main.** The transfer list takes
   `MessagePort[]`; transferring a buffer silently drops the whole message
   ([electron#34905](https://github.com/electron/electron/issues/34905)) — it works renderer→renderer.
7. **`Buffer.from(typedArray)` copies.** Wrapping (`Buffer.from(buf.buffer, byteOffset, byteLength)`)
   measured +31 %.
8. **A stale `dist-electron` bundle** runs the *previous* main process against the new renderer. It
   read as "export IPC not registered" once and as "the bench flag does nothing" once. The bench now
   refuses to run against one.
9. **The installed app (`openscreen.exe`) holds the same single-instance lock as the dev build.** A
   launch exits 0 and reports nothing — silently.

---

## 7. Unrelated but recorded: project files can corrupt

`proj_de6ffaaa` (`os_parity`) is **4006 bytes: 3485 of valid JSON followed by the tail of a longer
version of the same document.** That is two concurrent `fs.writeFile` calls of two different
versions — both open with `O_TRUNC`, then write at their own offsets. `listProjects` skips it, so the
project is unopenable.

`writeProject` (`document-service.ts`) truncates correctly on its own; what is missing is
**serialisation of saves and an atomic write** (temp file + rename).

**Not repaired.** The recoverable prefix has `speedRegions: 0, zoomRegions: 0` while the real
timeline had two 3× regions and a 1.80× zoom — truncating would have returned a project silently
stripped of its effects, and the zoom is not recoverable from the file at all. A byte-exact backup
sits beside it (`*.corrupt-backup-20260716`).
