# Native encode, measured end‑to‑end — why option A cannot win

**Date:** 2026‑07‑16
**Companion to:** [`export-pipeline-v2-spec.md`](./export-pipeline-v2-spec.md) (§3.1, §4.4, §7, Phase 3, Phase 4) and [`native-core-tauri-spec.md`](./native-core-tauri-spec.md)
**Code:** `6d521c53` — bench + instrumentation
**Machine:** AMD Ryzen 5 7520U (integrated Radeon), Windows 11, `h264_amf`, on AC

---

## 1. Verdict

Feeding the bundled native ffmpeg from the renderer — **option A**, the path the v2 spec calls "the actual win" (Phase 3) — is **2.1× slower** than the WebCodecs path it was meant to replace.

| arm | wall (median) | fps | readback |
|-----|--------------:|----:|---------:|
| `webcodecs` | **38.5 s** | **36.9** | 158 ms |
| `native` | 80.8 s | 17.5 | **55 207 ms** |
| `native-cpu` | 83.6 s | 17.0 | 57 989 ms |
| `webcodecs-cpu` | 38.0 s | 37.3 | 166 ms |

*proj_a7468696 — 2 assets, 2 clips, webcam; MP4/1080p/60/H.264; 1418 output frames; 2 runs per arm, interleaved; same‑arm spread 3–4 %.*

**ffmpeg is not the problem.** It consumes frames *faster* than WebCodecs does — exactly as §3.1 predicted:

| stage | webcodecs | native | delta |
|-------|----------:|-------:|------:|
| `encodeWait` | 26 731 ms | 18 990 ms | **−29 %** |
| `flush` | 1 444 ms | 80 ms | **−94 %** |
| `readback` | 158 ms | 55 207 ms | **×349** |

The encoder win is real and it is dwarfed by the **price of admission**: getting the pixels to the CPU at all.

And that price is disqualifying on its own. With the crossing set to **exactly zero** — frames descended to RAM and then discarded, no IPC, no ffmpeg, no muxer, no audio — the pipeline still runs at **40.5 fps against WebCodecs' 44.0**, and WebCodecs is *also writing the file* (§5). So no amount of engineering on the crossing can save this shape: not option A′ (`sandbox: false`), not shared memory, not zero‑copy transfer. **The descent itself is the disqualification.**

---

## 2. Why

WebCodecs never brings a frame to the CPU. `encoder.encode(new VideoFrame(canvas))` hands the hardware encoder a **GPU texture**; the pixels are composited, encoded and emitted without ever crossing to system RAM. The `readback` stage reads ~0.1 ms/frame in that arm because **nothing is read back** — `new VideoFrame(canvas)` is lazy and the encoder consumes the texture in place.

ffmpeg cannot do that over a pipe. Raw video on stdin means the pixels must exist **in system RAM**, so the export must force the descent that WebCodecs never performs:

```
webcodecs:  canvas ──(GPU texture)──────────────▶ HW encoder ──▶ mp4
native:     canvas ──▶ copyTo() ──▶ RAM ──IPC──▶ main ──stdin──▶ ffmpeg ──▶ mp4
                       ▲ 38.9 ms/frame
```

This inverts §3.1's conclusion a second time. That section established, correctly, that *readback is 0.1 % of wall* and that *the encoder is the wall, and the wall is the API*. Both hold. What the Phase‑0 probe could not see is that **the 0.1 % was conditional**: readback cost nothing precisely because nothing forced it, and forcing it is exactly what feeding a native encoder requires. §3.1's own probe measured `node -> ffmpeg stdin pipe: 489–589 MB/s, costs ~3%` — a true statement about the *pipe*, obtained by materialising frames once, outside the timed loop. The measurement never included the descent, because in that harness the descent happened once for 546 frames instead of once per frame.

The trap is the same one §3.1 already names ("`new VideoFrame(canvas)` is lazy"), applied one level up: **an isolated component benchmark cannot price the cost of connecting it.**

---

## 3. Was the canvas the problem? No — hypothesis tested and dead

`frameRenderer.ts` requests GPU‑backed 2D canvases outside Linux (`willReadFrequently: this.isLinux`). Plausible hypothesis: a GPU‑backed canvas makes compositing cheap and readback expensive, which is the wrong trade for a path that reads back **every** frame. Flipping it should collapse the 38.9 ms.

It does not. `native-cpu` (57 989 ms) is no better than `native` (55 207 ms), and the control `webcodecs-cpu` is indistinguishable from `webcodecs`.

The arm is real, not a silent no‑op: `willReadFrequently` is a *hint*, so the renderer now logs what Chromium **granted**, not what we asked for —

```
· canvas requested willReadFrequently=false granted=false     ← native
· canvas requested willReadFrequently=true  granted=true      ← native-cpu
```

— and the readback did not move. The cost is not the canvas backing.

---

## 4. Would NV12 save it? No — and we did not have to build it to know

Phase 4 proposes packing BGRA (8.294 MB/frame) → NV12 (3.110 MB/frame) on the GPU. If the readback were bandwidth‑bound, that is a 2.7× cut.

Two resolutions give the descent a shape:

| output | bytes/frame | readback total | **ms/frame** |
|--------|------------:|---------------:|-------------:|
| 1080p | 8.294 MB | 55 207 ms | **38.93** |
| 720p | 3.686 MB | 29 795 ms | **21.01** |

*720p: 2 runs, spread 1 %.*

Fitting `t = a + b·MB` over the two points:

```
b = (38.93 − 21.01) / (8.294 − 3.686) = 3.889 ms/MB   (≈ 257 MB/s marginal)
a = 38.93 − 3.889 × 8.294             = 6.68 ms       (fixed per frame)
```

So the descent is **~6.7 ms of fixed stall plus ~3.9 ms/MB**. It scales with size, but at 257 MB/s — two orders below memory bandwidth — which is why it reads as a pipeline sync, not a copy.

Extrapolating NV12 (3.110 MB): **6.68 + 12.10 = 18.77 ms/frame**, roughly halving the readback. Projecting the native loop at 1080p:

| | render | readback | encodeWait | total | fps |
|---|---:|---:|---:|---:|---:|
| native, measured | 1.70 | 38.93 | 13.39 | 54.0 ms | 18.5 |
| native + NV12, projected | 1.70 | 18.77 | 13.39 | 33.9 ms | **29.5** |
| native + NV12, optimistic¹ | 1.70 | 18.77 | 5.02 | 25.5 ms | **39.2** |
| **webcodecs, measured** | 1.70 | 0.11 | 18.85 | **20.7 ms** | **48.4** |

¹ assumes `encodeWait` also falls in proportion to bytes, i.e. the IPC crossing is pure bandwidth.

Even the optimistic projection only reaches **parity**, after building GPU shader packing. Phase 4 cannot rescue this path.

---

## 5. What about option A′ — dropping the sandbox to remove the crossing?

The obvious rescue: if the crossing is what costs, remove it. **A′** (`sandbox: false`, renderer spawns ffmpeg and writes its stdin directly) skips the IPC structured clone; other variants propose shared memory or a zero‑copy transfer.

None of them can be rescued, and none had to be built to find out. They all keep `copyTo()` — ffmpeg needs the pixels in RAM whoever spawns it — so a single arm bounds every one of them at once: **descend every frame, then discard it.** The crossing costs exactly zero, there is no encoder, no muxer, no audio.

| arm | wall | fps | readback | encodeWait | writes a file? |
|-----|-----:|----:|---------:|-----------:|:--------------:|
| `webcodecs` | 32.2 s | **44.0** | 170 ms | 20 997 ms | **yes** |
| `readback-ceiling` | 35.0 s | **40.5** | 29 210 ms | **2 ms** | no |
| `native` | 69.1 s | 20.5 | 34 389 ms | 26 787 ms | yes |

*Same project and settings as §1; 2 runs per arm, spread 1–2 %. Absolute numbers differ from §1 — a later session, a warmer/steadier machine — which is exactly why arms are only ever compared within a run.*

`encodeWait: 2 ms` across 1418 frames confirms the arm does what it claims: the crossing really is zero.

**And it still loses: 40.5 fps against WebCodecs' 44.0 — while WebCodecs also muxes and writes the file** (its `flush` 1222 ms + `audioEncode` 397 ms are included in that 44.0). The descent *alone*, with nothing behind it, is slower than WebCodecs doing the entire job.

So the ceiling for every "remove the crossing" design sits **below** the path we already ship. A′ is in fact strictly worse than this ceiling: it does not eliminate the crossing, it swaps a structured clone (~390 MB/s) for a pipe write (~500 MB/s, §3.1 of the v2 spec) — a ~1.2× improvement on one leg, bought by giving up the renderer sandbox that [`native-core-tauri-spec.md`](./native-core-tauri-spec.md) §3.2 identifies as protecting the demux/decode of untrusted user media.

Combining A′ with Phase 4 does not save it either: NV12 projects the ceiling to ~20.4 ms/frame (≈49 fps), but A′'s pipe write of 3.110 MB at ~500 MB/s adds ~6.2 ms/frame back, landing ≈37.6 fps — still under 44.0, now having paid both the sandbox *and* GPU shader packing.

**Conclusion: descending the frame is disqualifying, independently of what happens afterwards.** The only remaining move is not to descend — §6.

---

## 6. What this means

### For the spec

| section | status |
|---------|--------|
| §3.1 — "the encoder is the wall, and the wall is the API" | **holds**, but incomplete: it prices the encoder, not the connection to it |
| §3.1 — "readback is 0.1 % of wall" | **holds only for WebCodecs.** Conditional on nothing forcing the descent |
| §4.4 / §7 / Phase 3 — native ffmpeg as primary encoder, fed from the renderer | **refuted on this machine.** 2.1× regression |
| Phase 4 — GPU BGRA→NV12 packing | **cannot save Phase 3.** Best case is parity |
| §7 — "WebCodecs demoted then removed" | **must not proceed.** WebCodecs is currently the fastest path we have |
| A′ (`sandbox: false`) and other "remove the crossing" variants | **excluded by the ceiling** (§5), without being built |

### For the roadmap

The agreed plan was **A** (ship ai‑edition at ~×10 via bundled ffmpeg) then **C** (Tauri/Rust for the last ×2). The measurement inverts it:

- **A is not ×10. It is ×0.48.** The bundled LGPL ffmpeg, the encoder probe, the IPC and the credit window all work correctly — and the architecture still loses, because a sandboxed renderer cannot hand a GPU texture to a native process.
- **A′ is not a rescue.** It buys ~1.2× on one leg (structured clone → pipe write) at the cost of the sandbox, and the ceiling with that leg at *zero* already loses (§5).
- **C is where the win is, and for a new reason.** Not "the last ×2", but the *only* way to make native encode pay: if compositing and encoding live on one device in one process, the composited surface feeds the encoder (D3D11VA / VideoToolbox) **without ever descending**. The descent does not get cheaper — it stops existing.

The ×10 was never in front of us. And the wall is not the crossing — the ceiling arm set the crossing to zero and the shape still lost. **The wall is the descent**: any design in which a composited frame reaches system RAM has already paid more than WebCodecs pays for the whole export.

### What survives from the native work

Nothing here invalidates the parts, only their arrangement. `ffmpegCapabilities` (smoke‑tested encoder election), `ffmpegEncodeSession` (stdin + backpressure + progress), the pinned licence‑gated LGPL binary and `scripts/fetch-ffmpeg.mjs` are all reusable by option C, which still needs a native H.264 encoder. What does not survive is *feeding it from the renderer*.

---

## 7. Method

```bash
npm run bench:export -- --project=proj_a7468696 --arms=webcodecs,native,native-cpu,webcodecs-cpu --runs=2
```

The bench (`scripts/bench-export.mjs` + `src/bench/runBench.ts`) simulates nothing: it opens the **real editor window** (same `webPreferences`, preload and sandbox), loads a **real saved project** through the bridge the editor uses, and calls **`exportAxcutDocument`** — `ExportDialog`'s own entry point. Only React is skipped, so nothing renders alongside the export. Arms are set via `localStorage` and read at runtime, so one app session measures every arm against one document.

Four arms, because two would not have been decidable:

| arm | encoder | canvas |
|-----|---------|--------|
| `webcodecs` | WebCodecs | GPU |
| `native` | ffmpeg | GPU |
| `native-cpu` | ffmpeg | **CPU** |
| `webcodecs-cpu` | WebCodecs | **CPU** |

Without `webcodecs-cpu`, a `native-cpu` result could be attributed to the canvas, the encoder, or neither.

**Arms interleave (A,B,A,B) and same‑arm spread is reported.** Above 10 % the run declares itself VOID. This is not decoration — see §7.

---

## 8. Two runs discarded, and why they are in this report

**Run 1 (UI, ~5 % battery, unplugged).** Baseline 84.6 s → native 54.1 s, "1.56× faster". Discarded: the SoC (15 W class, shared CPU/iGPU budget) was power‑squeezed and the budget **drifted upward while charging, between the arms**. Also self‑inflicted: DevTools were open for the native arm only, streaming hundreds of console lines — a handicap applied to one arm.

**Run 2 (UI, on AC, DevTools closed, A/B/A/B).**

| | A1 | B1 | A2 | B2 |
|---|---:|---:|---:|---:|
| | webcodecs | native | webcodecs | native |
| wall | 77.6 s | 79.9 s | **61.7 s** | **49.4 s** |

Discarded by its own gate: **A1 vs A2 disagree by 26 %; B1 vs B2 by 62 %** — with the battery climbing 34 % → 43 % throughout. The drift exceeded the effect and *inverted the conclusion*: A1↔B1 says "native 3 % slower", A2↔B2 says "native 20 % faster". Either would have been reported as a finding.

The valid run's 3–4 % spread is what makes §1 trustworthy. **A single A/B on this machine was never capable of answering the question**, and no amount of care in reading the numbers would have revealed that — only the repeat did.

Everything the bench guards against is something that already produced a confident wrong answer:

- a **stale `dist-electron` bundle** (twice — once the export IPC read "no handler registered", once the bench flag silently did nothing and the app opened its normal HUD)
- a **leftover instance** holding the single‑instance lock, making the launch exit 0 in silence
- a **dead dev server** yielding a blank window
- a **runner that swallowed the app's own stderr** while it was explaining the failure

---

## 9. Caveats

- **One machine.** Ryzen 5 7520U, integrated Radeon, `h264_amf`. The descent is a Chromium GPU→CPU transfer and is likely universal, but a discrete GPU (PCIe) or Intel QSV could produce different constants. `npm run bench:export` makes that a one‑command check — this should be re‑run before the conclusion is generalised beyond iGPU laptops.
- **The linear fit is two points**, not a proof. It is directionally clear (readback scales with bytes, ~257 MB/s marginal, ~6.7 ms fixed), but the NV12 projection is an extrapolation, not a measurement.
- **The workload is not os_parity.** The v2 spec's reference project (2 assets, 2×3× speed, 1.80× zoom, webcam, 546 frames) is **corrupt on disk** — see §9. `proj_a7468696` (2 assets, 2 clips, webcam, 1418 frames) has no speed or zoom regions, so it composites *less* per frame than os_parity. That biases nothing here: zoom and speed affect `render` (1.7 ms/frame, ~4 % of the loop), not the descent under test, and every arm ran the same document.
- **The native arm does not mux audio yet** (the A/V‑lock ordering needs the real per‑segment frame counts, which only exist after the loop). Audio decode and the WSOLA stretch run on **both** arms deliberately, so the CPU contention on the video loop is identical; only `audioEncode` (373 ms, ~1 %) is missing from the native arm. Crediting it fully to native does not change a 2.1× gap.

---

## 10. Unrelated finding: `os_parity` is corrupt (data‑loss bug)

While resolving the bench's target project, `listProjects` was silently skipping `proj_de6ffaaa` (`os_parity`). The file is 4006 bytes: **3485 bytes of valid, complete JSON followed by the tail of a longer version of the same document.**

That is the signature of **two concurrent `fs.writeFile` calls of two different document versions**: both open with `O_TRUNC`, then write at their own offsets. The shorter version won bytes 0–3485; the longer one's bytes past 3485 survive. `writeProject` (`document-service.ts`) truncates correctly on its own — what is missing is **serialisation of saves and an atomic write** (temp file + rename).

Consequence: the project is unopenable in the editor today.

**Not repaired.** The recoverable prefix has `speedRegions: 0, zoomRegions: 0`, while the real timeline has two 3× regions and a 1.80× zoom. Truncating to the valid prefix would have returned a project silently stripped of its effects. The zoom is not present anywhere in the file and is not recoverable from it. A byte‑exact backup sits beside it (`*.corrupt-backup-20260716`); the original is untouched.

---

## 11. PoC findings: the hardware is willing, the ffmpeg CLI is not

Probing option C on this machine with the bundled ffmpeg (2026‑07‑17), before writing any Rust:

| measured | fps |
|----------|----:|
| **GPU decode (d3d11va) → GPU encode (h264_amf), no compositing, no descent** | **234** |
| WebCodecs export today, full effect set | 44 |

234 fps is the **floor of the native‑GPU path** on this laptop: 5.3× today's export before a single effect is composited. The physics has room.

What does *not* work here is the plumbing between ffmpeg's filter graph and the encoder:

| API | decode | filters | encode | bridge to AMF |
|-----|:------:|:-------:|:------:|---------------|
| **Vulkan** | ✅ | ✅ (`scale_vulkan`, `overlay_vulkan`, `gblur_vulkan`, `color_vulkan`) | ❌ driver exposes `video_decode_queue` only — **no encode queue** | ❌ *"AMF initialisation from a vulkan device is not supported"* |
| **D3D11** | ✅ | ❌ `scale_d3d11` fails to create its texture (`80070057`) on every format | ✅ AMF | — |
| **OpenCL** | — | ✅ but **no scaler** | — | ❌ `hwmap` from d3d11 fails on NV12's UV plane |

So **the ffmpeg CLI cannot express GPU‑composite → GPU‑encode on this hardware.** That is a limit of the CLI's plumbing, not of the GPU: the same GPU decodes at 234 fps, encodes at 234 fps, and already composites the entire scene at **1.7 ms/frame** (the `render` stage, measured on every bench run above).

**This does not test option C** — it tests ffmpeg's filter graph, which no native core would use. A real one decodes with libavcodec into a D3D11 texture, composites with wgpu/D3D11 **on that same device**, and hands the texture to AMF. The CLI is built for linear transcode, not multi‑layer compositing; running out of road here says nothing about the architecture, only that the PoC needs code.

**What this does settle for the PoC's design, on AMD/Windows:** Vulkan is a dead end for the encoder (no encode queue, no AMF interop), so the compositor must own a **D3D11** device and hand D3D11 textures to AMF — not Vulkan, not OpenCL, whatever wgpu's default backend would pick.

---

## 12. Open questions

1. **Does the descent behave differently on a discrete GPU, or on Intel QSV?** One bench run per machine.
2. **Can option C actually keep the frame on‑device end to end?** Still the load‑bearing assumption of the whole native‑core case, and still unmeasured — §11 raised the floor (234 fps) and mapped the constraint (D3D11, not Vulkan), but the compositing‑to‑encoder handoff needs real code. Prototype and bench it *before* committing to a migration; this report exists because the last "obvious" architectural win was 2.1× backwards.
3. **Is WebCodecs' 18.85 ms/frame `encodeWait` improvable at all?** It is now the largest single cost in the fastest path we have. §3.1's isolated probe says the same silicon does 165 fps (6 ms/frame) under ffmpeg, so ~13 ms/frame is Chromium overhead on a path we do not control.
4. **Is `render` = 1.7 ms/frame the true GPU compositing cost, or an artefact of async?** `renderFrame` returns before the GPU finishes, so part of that work may be billed to whatever forces the sync next. It matters: 1.7 ms is what makes the native‑GPU projection (~167 fps) attractive.
