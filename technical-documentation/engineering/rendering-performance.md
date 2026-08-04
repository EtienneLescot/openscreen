# Rendering performance

This is the measurement record for preview fluidity and export speed, and the evidence that chose the current stack. The GPU-resident native compositor this record motivated is described in [../architecture/native-compositor.md](../architecture/native-compositor.md); the export architecture that consumes these measurements is in [../architecture/export-pipeline.md](../architecture/export-pipeline.md). The product surface the measurements describe is in [../architecture/overview.md](../architecture/overview.md); the decision narrative is in [../architecture/decisions.md](../architecture/decisions.md).

The reference machine for every number in this document is an AMD Ryzen 5 7520U laptop with the integrated Radeon GPU, running Windows 11 — deliberately the weak case, and the only fully-measured machine. A discrete-GPU and Intel QSV run is owed (see [Known gaps](#known-gaps)).

## Where it landed

**The shipped path is the D3D11 compositor in [`crates/compositor/`](../../crates/compositor/), at ~126 fps for 1080p60 with every effect on.** One `ID3D11Device`, no CPU readback between any stage:

```
demux → D3D11VA decode (×2, NV12 GPU textures) → HLSL composite
      → RGB→NV12 (2 RTV passes) → h264_amf encode (GPU→GPU) → MP4 mux
```

On the reference machine, same fixture, sustained regime:

| path | fps @ 1080p60, full effects | status |
|---|---:|---|
| **D3D11 (`crates/compositor/`)** | **~126** (median 125.9, spread 11.8 %) | **shipped** |
| WebCodecs in Chromium | 79 | removed — the web pipeline *after* the [Canvas2D rebuild](#the-fix-and-what-it-bought); never released |
| Rust + wgpu / Vulkan | 48–68 | [rejected](#rust--wgpu-native-poc-poc-native), driver-blocked |

That fps envelopes **the whole run** — demux, decode, composite, encode and mux — because the measured window is one `Instant::now()` before and one after everything. Nothing inside can falsify the clock.

> **This table is not the user-facing delta, and reading it as one understates the change by about an order of magnitude.** The 79 fps row is the web pipeline *after* the [Canvas2D compositor rebuild](#the-fix-and-what-it-bought) — an intermediate state of the 1.8.0 cycle that no release ever shipped. The last **released** web pipeline is v1.7.0's, which is the `webcodecs-legacy` arm: [~8 fps at M1](#m1--the-starting-pipeline), 9.8 fps under [Gate G0](#gate-g0--passed-2026-07-17). The tell is in the tree, not in the tags: `src/lib/exporter/frameRenderer.ts` carries no `shadowCache` at all in `v1.7.0` (1184 lines), and carries it throughout by `v1.8.0-rc.4` (1552 lines). So 1.8.0 compounds two changes against what a user actually had: the rebuild (~2×, byte-identical output) and then the native engine that replaced it. Quote the magnitude, never a precise multiple across these runs — [this machine does not support that arithmetic](#bench-methodology-of-the-deleted-harness).

The effect set is not a reduced one: animated layout, zooms, NV12→RGB BT.709, rounded corners and masks (SDF), drop shadows (SDF penumbra), background blur (dual-Kawase), per-velocity motion blur, custom cursor with click bounce.

### What bounds it

Windows per-engine GPU counters (`\GPU Engine\Utilization` — no elevation, no in-process probe, so it cannot poison the headline):

- **Light configs are encode-bound** (video-codec engine ~71 %); **heavy configs are composite-bound** (3d engine ~84 %). Decode never bounds — fast and bursty, ~2 ms.
- The VCN encoder is the hard ceiling at **~210 fps** for decode+encode alone (fixed-function; `-quality speed` buys +2 %). So on heavy configs the compositor is the only optimisable surface left.
- **Already parallel on the GPU.** The 3d and codec engines are both busy over the same window (84 % + 61 % = 145 %, impossible if serialised): the GPU pipelines stages across frames on its own, single-threaded CPU loop notwithstanding. An explicit CPU-side pipeline adds ~nothing — confirmed by a no-op SRV-cache trial that moved neither bound. This is the native twin of the [encoder-pipelining loss](#encoder-pipelining).

The direction is thermal-robust: absolute fps drifts with the passive iGPU's boost/throttle, but at **every state measured** the full-effects config beats both the browser and the wgpu path, throttled floor included.

### Measuring it today

The live harness is the one in `crates/`, not the deleted `npm run bench:export`:

```bash
x.bat run --release -- --cfg C0..C8 --fixture fixture --repeat 3 --out out/
```

C0..C8 are cumulative — each adds one layer, so the fps delta between two rows prices that layer ([`crates/compositor/src/config.rs`](../../crates/compositor/src/config.rs)):

| cfg | adds |
|---|---|
| C0 | decode + encode, no composite |
| C1 | + background, layout, 2 sources |
| C2 | + rounded corners |
| C3 | + drop shadows |
| C4 | + background blur |
| C5 | + animated zoom |
| C6 | + layout animation |
| C7 | + custom cursor (bounce) |
| C8 | + motion blur (velocity, 8 taps) |

It writes `out/C{0..8}.mp4` (1080p60, 360 frames), frame PNGs at 60/180/300, `out/report.json`, and a markdown table on stdout.

#### One admissible run — 2026-07-27

Reference machine, `--repeat 3`, one full C0..C8 warm-up sweep discarded first, fixture regenerated from the frozen manifest (`-c copy`, bitstream untouched). Every config passes the protocol's < 15 % spread gate. `fps` is the harness's **best of 3**, not a median — it reports `best` and derives spread from best-vs-worst ([`bench.rs:105`](../../crates/poc-d3d/src/bench.rs)).

| cfg | adds | fps | ms/f | Δ ms/f | spread |
|---|---|---:|---:|---:|---:|
| C0 | decode + encode, no composite | **236.5** | 4.23 | — | 0.6 % |
| C1 | + background, layout, 2 sources | 142.5 | 7.02 | **+2.79** | 1.6 % |
| C2 | + rounded corners | 141.4 | 7.07 | +0.05 | 5.1 % |
| C3 | + drop shadows | 134.5 | 7.43 | +0.36 | 0.9 % |
| C4 | + background blur | 121.9 | 8.21 | **+0.77** | 5.7 % |
| C5 | + animated zoom | 123.2 | 8.12 | −0.09 | 2.6 % |
| C6 | + layout animation | 125.4 | 7.97 | −0.14 | 10.6 % |
| C7 | + custom cursor (bounce) | 127.3 | 7.86 | −0.12 | 9.0 % |
| C8 | + motion blur (velocity, 8 taps) | **104.0** | 9.62 | **+1.76** | 2.4 % |

**Three layers cost; the rest are free.** Compositing at all is the big step (C0→C1, +2.79 ms/frame — the encoder's whole budget is 4.23), then background blur (+0.77) and motion blur (+1.76). Rounded corners and shadows are near-free because they draw inside a pass that already exists — the same finding the [Canvas2D-era radius measurement](#what-the-compositor-was-rebuilding-per-frame) reached by a different route.

**C5–C7 read as a flat band, and that is the honest reading.** Zoom, layout animation and cursor land at 123.2 / 125.4 / 127.3 — *above* their predecessor, which is impossible for cumulative configs. The violations are +1 to +2 fps against those configs' own spreads of 2.6 / 10.6 / 9.0 %, so they are noise around a plateau, not a measurement: **those three layers do not move the needle.** Reporting them as monotone would be inventing precision the run does not have.

C8's 104.0 fps sits under the ~126 headline above. Different session and thermal state, and a different statistic (that figure is a median under protocol §C.2, this one a best-of-3) — the two are not comparable as levels. **The layer attribution is what this run claims; the absolute is not.**

> A first attempt the same day was **VOID** and is not reported: five of nine configs blew the spread gate (up to 42.5 %) while ~40 browser and Electron processes were live, and C3 came out **+15.8 fps faster than C2** — adding a layer. Cumulative configs cannot speed up; that is the tell that noise had swamped the signal. It is recorded here only because it is a clean example of why the gate exists.

### The CPU backend (WARP + software decode) — 2026-07-27

`d3d::Backend::Cpu` runs the *same* pipeline on a WARP device with libavcodec software
decode ([`cpu_frames.rs`](../../crates/compositor/src/cpu_frames_windows.rs)), for hosts with no
usable D3D11 GPU. Rendering and decoding are two independent axes — WARP covers the
first and *nothing* of the second, on any platform — so the fallback needed both halves.

Measured with a preview-shaped workload, because the CPU backend cannot reach the export
path at all: `h264_amf` requires the real GPU, and encode is a **third** axis with no
software fallback wired today. So the harness grew `--preview` (decode → compose →
readback, no encoder) and `--backend`, which is what makes the two comparable:

```bash
x.bat run --release -- --cfg C1..C8 --backend cpu --preview --frames 300 --repeat 3
```

C0 is excluded: it is "decode + encode, no composite", which has no meaning without an
encoder.

| cfg | HW fps | HW ms/f | CPU fps | CPU ms/f | Δ ms/f (CPU) | gap |
|---|---:|---:|---:|---:|---:|---:|
| C1 | 65.3 | 15.30 | 30.7 | 32.60 | — | 2.1× |
| C2 | 65.2 | 15.34 | 30.1 | 33.25 | +0.65 | 2.2× |
| C3 | 63.1 | 15.84 | 28.5 | 35.06 | +1.81 | 2.2× |
| C4 | 49.1 | 20.37 | 9.1 | 110.49 | **+75.43** | 5.4× |
| C5 | 51.2 | 19.54 | 7.9 | 126.14 | +15.65 | 6.5× |
| C6 | 54.3 | 18.42 | 9.5 | 105.78 | −20.36 | 5.7× |
| C7 | 53.9 | 18.55 | 9.2 | 108.53 | +2.75 | 5.9× |
| C8 | 48.0 | 20.85 | 6.2 | 161.18 | **+52.65** | 7.7× |

**Two shaders account for the whole gap, and both are multi-tap sampling loops.**
Background blur costs +4.53 ms on hardware and **+75.43 ms** on WARP (17×); motion blur
costs +2.30 ms and **+52.65 ms** (23×). Everything else — compositing, SDF rounded
corners, drop shadows, zoom, layout animation, cursor — runs within ~2.2× of the GPU.
So WARP is not uniformly slow: it is fine at single-pass geometry and collapses on
per-pixel sampling loops. C1–C3 at ~30 fps is a usable editing preview; C4 onward, at
6–9 fps, is not.

**The render is iso**, which is the property that makes a backend swap worth having at
all. Comparing the same fixture frame per config, full-image over all 6 220 800 channels:
93–95 % of channels bit-identical, **max deviation 3/255**, nothing above 2 outside a
handful of pixels, and matching mean levels (217.77 vs 217.81 — neither frame is blank).
Every effect layer survives the swap. The residual is rasteriser/FP difference, so any
pixel-golden test that spans backends needs a tolerance rather than an exact baseline.

> **Not an admissible run under [§ spread thresholds](#spread-thresholds).** Four of
> sixteen rows blow the 15 % gate (CPU C1 21.3 %, C3 37.7 %, C8 25.5 %; HW C7 18.8 %) —
> ~14 browser processes were live. The **layer attribution** is what this run claims and
> it is robust: both cliffs are 3–5× drops bracketed by rows at 3.7 %/10.5 % and
> 4.9 %/6.5 % spread. The **absolutes are not quotable** until a re-run on a quiet
> machine. C6's negative delta is the same C5–C7 plateau noise the
> [admissible hardware run](#one-admissible-run--2026-07-27) documents.

#### CPU export — the third axis

`ExportCodec::candidates()` already picks a working encoder per host, so the CPU backend
needs no encoder logic of its own. It needed a different **frame source**:
`VideoEncoder::send` downloads via `av_hwframe_transfer_data`, which presupposes a D3D11
pool, and WARP cannot create one (`av_hwdevice_ctx_init(D3D11VA)` fails for the same
missing `ID3D11VideoDevice` that blocks decoding). So on `Backend::Cpu` the pool is
skipped, zero-copy candidates are dropped with a stated reason, and `send_composited`
reads the composed NV12 out of the compositor directly.

`x.bat run --release -- --cfg C8 --backend cpu --export` on the fixture (360 frames):

| path | encoder chosen | fps | ms/f |
|---|---|---:|---:|
| hardware | `h264_amf` (D3D11, zero-copy) | **88.2** | 11.34 |
| CPU backend | `h264_mf` (system frames) | **4.8** | 207.87 |
| CPU, forced last resort | `libopenh264` | **4.6** | 218.91 |

All three produce valid 360-frame 1080p MP4s that decode clean under `ffmpeg -f null -`.

**`h264_mf` winning on the CPU backend is a local artefact, not the no-GPU answer.** Media
Foundation picks its own encoder MFT independently of our D3D device, so on this machine —
which *has* an AMD GPU, just not one this compositor is using — it can still reach hardware.
On a genuinely GPU-less host `h264_mf` would fall to its own software encoder or fail, and
`libopenh264` is the floor. The forced row is there precisely because the automatic one
cannot be trusted to represent that host: `OPENSCREEN_EXPORT_ENCODER=libopenh264` is the
only way to exercise the real last resort from a machine that has a GPU.

The encoder is not the bottleneck either way — the two CPU rows differ by 5 %, while the
gap to hardware is 18×. That gap is the blur and motion-blur shaders (see the table above),
not the codec.

## How we got here — the WebCodecs trail

> **This section is history.** It records the measurements that killed the browser-based export pipeline and motivated the native one. The code it describes is **gone**: `src/lib/exporter/videoExporter.ts`, `src/bench/runBench.ts` and the `npm run bench:export` script were deleted with the web MP4 pipeline. It is kept because it is the evidence for [why the compositor, not the encoder, was the wall](#the-wall-is-the-compositor) — which is the entire reason `crates/compositor/` exists — and because the [measurement hazards](#measurement-hazards) it uncovered still apply to any new benchmark here.
>
> One piece of it is still live: the Canvas2D compositor described under [The fix, and what it bought](#the-fix-and-what-it-bought) survives in `src/lib/exporter/frameRenderer.ts`, which now serves **GIF export only** — GIF has no native encoder yet.

### Bench methodology (of the deleted harness)

`npm run bench:export` (`scripts/bench-export.mjs` + `src/bench/runBench.ts`) opened the real editor window — same `webPreferences`, preload, sandbox — loads a real saved project through the same bridge the editor uses, and calls `exportAxcutDocument` (`ExportDialog`'s entry point). React is skipped, so nothing renders alongside.

Arms interleave A/B/A/B; same-arm spread is reported; a run above **10 %** spread declares itself VOID. Two earlier runs were discarded because battery and thermal drift (up to 62 % spread) inverted the conclusion. Treat any un-gated benchmark on this hardware as noise.

**This machine is not reproducible.** The same arm, same project, same settings has measured **44.0, 36.8, 32.3, 31.8, 22.2 and 11.9 fps** across sessions; the 11.9 run reported 0 % spread over its two samples and did not survive a re-run 40 minutes later (22.2). **Only within-run ratios transfer between machines, never absolute times.** A stable measurement is not a true one.

### M1 — the starting pipeline

Export ran at **~8 fps** (94.6 s for a 9.1 s clip). 90 % of wall time sat in `encodeWait` (blocked on the encoder queue). The conclusion drawn at the time was *"the encoder is the wall."* It was wrong — see M4 and [What the numbers mean](#what-the-numbers-mean).

### M2 — native ffmpeg, fed from the renderer

A bundled LGPL ffmpeg with the AMD hardware encoder (`h264_amf`) measured **165 fps** encoding pre-materialised frames. So it was wired in: composite in the renderer → copy pixels to CPU → IPC to the main process → pipe into ffmpeg. End-to-end, same project:

| arm | wall | fps | readback time |
|---|---:|---:|---:|
| WebCodecs (status quo) | 38.5 s | **36.9** | 0.16 s |
| native ffmpeg | 80.8 s | 17.5 | **55.2 s** |

**2.1× slower.** ffmpeg itself consumed frames faster than WebCodecs (`encodeWait` −29 %, `flush` −94 %) — the loss is entirely the **descent**: `copyTo()` measured 1.43 ms in an isolated probe but **38.9 ms** inside the real loop (the probe hit an idle GPU; the loop forces a pipeline stall — see [Measurement hazards](#measurement-hazards)).

### M3 — the ceiling arm

To bound every "make the crossing cheaper" idea at once (removing the sandbox, shared memory, zero-copy IPC): descend every frame and **throw it away** — no IPC, no encoder, no muxer, no audio. Result: **40.5 fps**, against **44.0 fps** for WebCodecs *doing the whole export including writing the file*. The descent alone, with nothing behind it, loses to the complete shipping pipeline. Every architecture that routes frames through renderer CPU RAM is dead on this machine, and none of them had to be built.

### M4 — the layer bench

Rebuild the pipeline layer by layer, measure each addition (same project, 1080p60):

| layer | fps | ms/frame | Δ ms |
|---|---:|---:|---:|
| L0 — decode + encode only | **213** | 4.7 | — |
| L1 — + flat background, scale, webcam | 111 | 9.0 | **+4.3** |
| L2 — + wallpaper image | 75 | 13.3 | **+4.3** |
| L4 — + rounded corners | 68 | 14.7 | +1.4 |
| L5 — + drop shadow | 53 | 18.9 | **+4.2** |
| L6 — + circular webcam mask | 52 | 19.2 | +0.3 |
| L7 — + animated zoom | (see [L7 row](#the-l7-row-and-the-shadow-cache-2026-07-17)) | | |

**The full WebCodecs decode→encode loop runs at 213 fps** on this machine. The encoder was never slow.

### M5 — the composite-ceiling re-measurement (2026-07-17)

A second derivation, on `proj_a7468696` (2 assets, 2 clips, webcam; MP4/1080p/60/H.264; 1418 frames), three arms in one run, each adding one stage to the one above:

| arm | ms/frame | what it does |
|---|---:|---|
| `composite-ceiling` | **24.6** | decode + composite, nothing downstream |
| `readback-ceiling` | **24.6** | the same + a full `copyTo()` |
| `webcodecs` | 31.1 | the same + encode + mux + file |

**Adding the entire GPU→CPU descent moves the wall by 0.03 ms/frame.** The compositor is **79 %** of the export; the encoder is **4.5 %**.

### Gate G0 — passed 2026-07-17

The premise under test: a fence (`gl.finish()`) after compositing, before the `encodeWait` timer starts, collapses `encodeWait` if the wall is the compositor.

Reference machine, real bench harness, four arms interleaved, 2 runs each, effects `shadow,blur,radius`, 1080p60, 820 frames. Project: `proj_5b3ac6bc` ("Recording 15/07/2026 18:38:53") — **not** the record's `os_parity`, which was found destroyed by the [data-loss bug](#known-gaps). This project is heavier than the record's: two clips, both with a visible webcam track — absolute numbers are therefore not comparable with M1–M4; the arm-vs-arm attribution, which is all G0 claims, is.

| arm | wall | fps | spread | encodeWait total | fence total |
|---|---:|---:|---:|---:|---:|
| webcodecs-legacy | 83.3 s | 9.8 | 5 % | 58 305 ms | — |
| webcodecs-legacy-fence | 64.4 s | 12.8 | 8 % | **3 181 ms** | 44 538 ms |
| webcodecs | 56.6 s | 14.6 | 5 % | 32 368 ms | — |
| webcodecs-fence | 50.1 s | 16.4 | 9 % | **3 013 ms** | 28 199 ms |

Per frame (820 frames): legacy `encodeWait` 71.1 → **3.9 ms** (×18 collapse), the difference reappearing under `fence` (54.3 ms/frame); shipping compositor 39.5 → **3.7 ms** (×10.7), `fence` 34.4 ms/frame. `encode` itself is ~0.03 ms/frame.

**G0 confirmed.** `encodeWait` was billing the compositor's GPU execution; the encoder's own residual wait is ~3.7–3.9 ms/frame on this machine. The wall is the compositor — here even more so than M4 estimated, because this project composites a webcam bubble on every frame of both clips.

Two findings G0 did not set out to test:

- **The fenced arms are FASTER end-to-end** (legacy −23 %, shipping −11 %). Draining the GPU once per frame beats letting Chromium queue unboundedly — deep uncontrolled pipelining is actively harmful here. The "pipeline, don't await" rule needs the nuance: **bounded in-flight work, not maximal**.
- **The compositor changes are confirmed in-run**: legacy 9.8 → shipping 14.6 fps (+49 %) on a project whose per-frame webcam compositing the changes never touched.

### The L7 row and the shadow cache (2026-07-17)

Same machine, same harness, `--clip=4` (122 frames), 4 runs per arm plus one discarded warm-up, four arms interleaved. **Spread 2–4 %** — the run is valid. All arms fenced, so the compositor's cost is billed to `fence` and not to the encoder. Shadow is isolated by *pairs*: an arm's twin sets `shadowIntensity: 0`, because omitting the effect still renders the project's own.

| arm | camera | shadow | wall | ms/frame |
|---|---|---|---:|---:|
| webcodecs-fence | still | on | 4144 ms | 34.0 |
| webcodecs-fence-noshadow | still | off | 3990 ms | 32.7 |
| webcodecs-fence-zoom | moving | on | 5835 ms | 47.8 |
| webcodecs-fence-zoom-noshadow | moving | off | 4659 ms | 38.2 |

Shadow cache: **0.8 % miss** with a still camera (121 hits / 1 miss), **54.1 % miss** during the zoom (56 / 66) — byte-identical across all four runs, so the miss rate is a property of the timeline, not of the machine.

The arithmetic, per frame:

| item | cost |
|---|---:|
| shadow, cache HOLDING (still camera) | **1.3 ms** |
| shadow, cache MISSING (moving camera) | **16.7 ms** |
| everything else the zoom adds (motion-blur filter, transform) | ~10.1 ms |
| a still frame, all in | 34.0 ms |
| a moving frame, all in | ~59 ms |

So the shadow cache is doing exactly what it was built for — it takes the shadow to ~0 on still frames — and it cannot help on a moving one, by construction. On a moving frame the shadow alone costs half again as much as the *entire rest* of the compositor (16.7 vs 32.7 ms). It is the single largest per-frame item there.

#### What the 16.7 ms is

A cache miss is two stacked things: the three chained gaussians, and the full-frame Canvas2D plumbing feeding them (silhouette copy, `source-in` fill, filtered blit — 2 Mpx each). They have different fixes, so they were priced apart with a third arm that runs the whole miss path with the filter chain switched off (`openscreen.shadowNoFilter` — renders no shadow; diagnostic only). Both arms fenced, 122 frames, 66 of them missing the cache, two independent runs:

| arm | run A | run B |
|---|---:|---:|
| zoom + shadow | 3668 ms | 4086 ms |
| zoom + shadow, no gaussians | 2734 ms | 2964 ms |
| zoom, no shadow at all | 2513 ms | 2730 ms |
| **⇒ gaussians** | **934 ms** | **1122 ms** |
| **⇒ plumbing** | **221 ms** | **234 ms** |

**The gaussian chain is ~81 % of the miss** (~14.2 ms per moving frame, against ~3.3 ms of plumbing). Run B is VOID on its own spread gate (31 %; the machine had been benching continuously for ten minutes and was drifting) — but it is reported because the two runs agree on the *ratio* (4.2 : 1 and 4.8 : 1) while disagreeing on the absolute, which is exactly what interleaved arms under drift should do. **A 4 : 1 ratio does not turn over inside that noise.**

**So: touching less of the frame recovers ~3 ms; the fix has to be the filter.** The CSS `drop-shadow` is `feGaussianBlur` on SourceAlpha, and the SVG filter spec defines that blur, for the project's radii, as three successive box blurs of a specified width. Reimplementing that cascade in a shader is the same algorithm on a different device — not an approximation. Box blurs are separable and O(1) per pixel; this is the cheap case on a GPU.

That claim is falsifiable and must be falsified before it is built: the spike is a GPU pass rendering the same silhouette, pixel-diffed against the Canvas2D output. If they do not match, the claim is wrong. Skia's real path may not follow the spec's letter.

#### The moving-camera decision

The product question — "how much of a typical timeline has a MOVING camera" — is the user's, not the bench's. **Answered, 2026-07-17 (product owner): a moving camera is the norm.** Screen presentations carry zooms by nature; the webcam is commonly set to resize reactively *during* those zooms; and Full Camera animates the webcam across the whole stage.

### The standalone POC (`poc/`) — 2026-07-17

`poc/` — its own directory, its own server, no Electron, no app code, nothing imported from the existing compositor. Two real recordings (screen + webcam), one layout, animated: two eased zooms with a focus point, and a layout move where the webcam grows from a docked circle into a panel, its shape morphing through the same SDF. Decode and mux via mediabunny, composite in WGSL, out to a watchable mp4. The layout, the easings and the effects are written from zero — the point was to prove the paradigm reconstructs the product, not to reuse what exists.

**Measured by the product owner, on a visible window, interleaved A/B, one discarded warm-up round, 4-second exports at 1080p on an AMD RDNA-3 iGPU:**

| arm | cruise | spread | runs |
|---|---:|---:|---|
| optimised | **85.1 fps** | 6 % | 88.9 / 84.0 / 85.1 |
| naive | 46.3 fps | 35 % | 46.3 / 53.8 / 37.5 |

**+84 % — it roughly doubles.** Read honestly: the naive arm's 35 % spread makes the *size* loose (85.1 against its best run is +58 %, against its worst +127 %); the direction and the order of magnitude are not in doubt. The optimised arm is steady at 6 % because it does less work, so it has less to vary.

Against the shipping compositor (different project — the comparison is an order of magnitude, not a measurement): 29.5 fps on a still frame, ~17 fps while the camera moves. The POC is 3–5× that, and it does not slow down when the camera moves, because there is no cache to miss.

**85 fps at 1080p is past 60.** That is the preview-fluidity target, reachable on the *weakest* machine in the fleet, with room over.

The three changes that produced the 84 %:

- **The background was recomputing a constant.** 16 gradient evaluations per pixel per frame, 210 times, for an image that never changes. Baked into a texture once at init; the frame reads one texel. This is *not* the shadow cache in disguise, and the difference is the whole argument: a cache guesses its input has not changed and needs a key to find out. A constant has no input.
- **The shadow ran everywhere.** 12 taps on every pixel, including under the opaque video and far outside the rect where the answer is zero. Every tap lands within `spread` of the pixel, so the box grown by spread bounds where any tap can hit, and the box shrunk by spread bounds where all of them do — Minkowski sums with the tap disc, the same number by arithmetic rather than by twelve samples.
- **The frame was drawn as one fullscreen triangle with `if`s.** It paid for every pixel of every effect and threw most of it away. Now each element is a quad sized to its own rect: the rasterizer runs the fragment shader only where the element is and clips what leaves the stage, in fixed function, with no branch. A zoomed recording is 2.7× the stage — two thirds of it is off-screen and now costs nothing. Plus CPU culling from the rects the pure-function `evaluate` already produced: when the recording covers the stage (every zoom), the background and its shadow are not drawn at all; an off-stage webcam is not drawn at all.

The trail ends here: the D3D11 fast path that replaced all of it is measured in [Where it landed](#where-it-landed), above.

## Measurement hazards

### Asynchronous GPU APIs

When code calls a draw function, the GPU hasn't drawn anything yet — the call just *queues* work and returns immediately. The work actually executes later, and its cost lands on **whichever operation first needs the result** (the "sync point"). Consequence: a timer around a draw call measures ~0 ms even if the draw costs 15 ms, and the 15 ms shows up in some *other* stage's timer. Three confident wrong conclusions in this project came from exactly this: the `render` timer (1.7 ms submission vs 14.5 ms execution), the pipe probe (489 MB/s "≈3 %" — frames materialised *outside* the loop), and the `copyTo` probe (1.43 ms idle vs 38.9 ms in-loop).

**Rule for any new benchmark in this project:** *what sync point am I including, and does the real loop include the same one?* If the probe does not force the work the real loop forces, it cannot price the cost of connecting the component.

The same trap produced three disguises of one wall in this pipeline: an `encodeWait` at "90 % of wall", a "readback" of 32 seconds, and a "descent" of 38.9 ms/frame. One wall, three names. **This retires "≈13 ms/frame of Chromium overhead on a path we do not control"**: it is our compositor, and we control all of it. Trust the ceiling arms, not `StageTimings`.

### Warm-up rounds, sustained vs burst regime

- **First export pays for shader compilation, decoder setup and JIT** (9.3 s vs 5.6/6.6/5.8 s for its own repeats) and lands on whichever arm ran first: a 60 % same-arm spread that voided two runs by itself. **One discarded warm-up per arm brings the spread to 2–4 %.**
- Battery and thermal drift has inverted conclusions on this hardware — up to 62 % spread on two earlier runs. Un-gated benchmarks on this hardware are noise.
- **A hidden tab is a throttled tab**, and Chromium escalates the longer it stays hidden. Same code, same machine, one session: 58.3 → 42.8 → 35.5 → 6.0 fps, and an A/B that reported 6.0 on *both* arms with a 401 % spread. The harness refuses to run when `document.hidden`. **Nothing measured from an agent-driven browser pane is admissible; the numbers in this document were taken by a human, on a visible window.**

### Clock-read placement

- A canvas in the document is presented every frame — 35 ms/frame of compositing an export never does. The render target is an OffscreenCanvas.
- `getSample(t)` per frame is a seek per frame: 122 ms/frame, three times everything else combined, on a long-GOP screen recording. Forward streams: 0.6 ms/frame.
- The harness leaked its GPU device, and six back-to-back runs decayed 19.9 → 8.6 → 7.5 fps during the very A/B meant to settle a question.
- The D3D11 POC's measured window is one `Instant::now()` before and one after the WHOLE run — decode, encode and mux inside; nothing inside can falsify the clock.

### Per-loop fps measured an empty loop, not throughput

`submit()` is non-blocking; encode is awaited only on backpressure. Under the pipeline the loop does not wait for the work — so a SLOWER composite blocks the loop LESS and reads FASTER. The naive POC arm reported 588 fps, 5× the optimised arm's, doing more work. Throughput is frames ÷ wall until they are actually composited, encoded and muxed (`finalize()` forces completion); that is the metric the harness now computes. The product owner caught this from the numbers alone.

The same artifact produced a first, larger encoder-pipelining "gain" (+205 %) that disappeared under the corrected throughput metric.

### Average fps is not cruise fps

The first frames of a 4-second export cost 358/113/28/350 ms — 10.3 ms/frame of drag, and the mean lands 26 % under the real rate. **Cruise = median of the last three quarters.**

### The instruments cost 17 %

`onSubmittedWorkDone()` per frame is a fence that forbids decode/composite/encode from overlapping; `mapAsync()` for the GPU timestamps is a sync per frame. Both are switchable, and the harness measures itself: instrumented 35.5 fps vs clean 42.8. The phase breakdown attributes; it does not price.

### Spread thresholds

- Same-arm spread above **10 %** declares the run VOID. The reference machine has voided runs at 31 % spread (B.1) and 35 % spread (naive POC arm) for real reasons; the run is still reported when the *ratio* survives the noise.
- A single 0 % spread is a warning sign, not reassurance. The 11.9 fps run above reported 0 % spread over two samples and did not survive 40 minutes later (22.2 fps).

### Bench-methodology traps

- `--effects` is per-session, not per-arm. Two effects A/B'd across two sessions is a cross-session comparison — the mistake this bench exists to prevent. Effects are now per-arm (`addEffects`), so an effect is A/B'd inside ONE interleaved run.
- The `zoom` effect injected `depth: "medium"`; `ZOOM_DEPTH_SCALES` keys on 1–6, so the lookup returned `undefined` and **the zoom never ran** — every previous zoom arm reported a clean number for an effect that did nothing. The injected region is now parsed through `zoomRegionSchema` — the pipeline's own contract.
- Saved projects carry no appearance at all (`shadowIntensity` defaults to 0), so whole effects never execute; "fixing" the shadow on a default project measures exactly zero. The `zoom` effect matters beyond its own cost: it is the only effect that changes geometry per frame, so it is what invalidates a geometry-keyed cache. **A parity test without it passes with a broken cache key**, because nothing ever asks the cache to invalidate.
- `app.getGPUFeatureStatus()` from a windowless script reports everything `disabled_software`. Probe with a real window.
- Piping via `cat` under Git Bash caps at ~70 MB/s — MSYS emulation, not Windows.
- `new VideoFrame(canvas)` is lazy. Timing the constructor measures nothing.
- `-encoders` lists what was compiled in, not what the machine can run. A portable build lists nvenc/qsv/amf everywhere; on this AMD laptop nvenc dies with "Cannot load nvcuda.dll". A one-frame smoke encode is the only way to settle it — and the unit tests passed *because the fixtures encoded the same wrong assumption as the code*.
- Electron cannot transfer an ArrayBuffer renderer→main. The transfer list takes `MessagePort[]`; transferring a buffer silently drops the whole message ([electron#34905](https://github.com/electron/electron/issues/34905)) — it works renderer→renderer.
- `Buffer.from(typedArray)` copies. Wrapping (`Buffer.from(buf.buffer, byteOffset, byteLength)`) measured +31 %.
- A stale `dist-electron` bundle runs the *previous* main process against the new renderer. It read as "export IPC not registered" once and as "the bench flag does nothing" once. The bench now refuses to run against one.
- A second instance of the same build quits silently: the lock keys on the `userData` path, so another dev build already running makes a launch exit 0 and report nothing. The installed app (`openscreen.exe`) resolves a different `userData` path and does not conflict.

## What the numbers mean

> This is the conclusion the whole WebCodecs trail exists to establish, and it is why `crates/compositor/` was built. It holds on the shipped path too, in the same shape: heavy configs are composite-bound at ~84 % 3d-engine utilisation while the encoder ceiling sits far above at ~210 fps (see [What bounds it](#what-bounds-it)). The file references below are to code that has since been deleted.

### The wall is the compositor

```
compositing (L1→L6):        14.5 ms
encoder (h264_amf, alone):   6.1 ms
                            ───────
                            20.6 ms  →  48.5 fps
observed WebCodecs export:  20.7 ms  →  48.4 fps      ← the numbers close
```

Confirmed by the M5 re-measurement on a different project: `composite-ceiling` 24.6 ms, `readback-ceiling` 24.6 ms (the descent adds **0.03 ms/frame**), `webcodecs` 31.1 ms. The compositor is **79 %** of the export; the encoder is **4.5 %**.

**Why it hid:** `new VideoFrame(canvas)` is lazy and `encoder.encode()` is the first operation that forces the GPU/canvas work to finish (`src/lib/exporter/videoExporter.ts:477–519`). So the compositor's 14.5 ms was **billed to the encoder's timer**. The `render` timer (1.7 ms) measured *submission*, not execution.

### What the compositor was rebuilding per frame

| what it did | what the data was | wasted work | source | measured |
|---|---|---|---|---:|
| three chained `drop-shadow` over 2.07 Mpx of video, every frame | `drop-shadow` reads **only the alpha channel**. The video is opaque and masked by a rounded rect — its alpha *is* the rounded-rect silhouette. The result depends only on `(x, y, w, h, radius, intensity)`, not on a single video pixel. | the video pixels, 2.07 Mpx of them, blurred three times | `frameRenderer.ts:1045` (dup at `:533`) | **~30 ms/frame** (M2 + M5 re-measurement: **43.5 ms** isolated, spread 3–4 %) |
| the wallpaper — a static image — cleared, re-blurred (`blur(6px)`) and re-blitted every frame | it never changes; blur it once at init | 1418 re-blurs for an image loaded once | `frameRenderer.ts:1007–1017` | ~5 ms/frame (M5 re-measurement: **17.9 ms** isolated) |
| a `BlurFilter` that is **always zero** (all four writes to `.blur` in the export path set 0) sits permanently in `videoContainer.filters` | dead filter | forces Pixi into render-to-texture + a full-screen pass per filter, per frame; plus a GL texture is created and destroyed per frame | `frameRenderer.ts:235/238/240`, `:409–415` | the L1 +4.3 ms delta (zoom-blur cost the same data path) |
| the rounded-rect mask retessellated per frame | identical from frame to frame | `clear()` / `roundRect()` / `fill()` over the same geometry | `frameRenderer.ts:769–771` | the L4 +1.4 ms delta |

The radius change is ~free — it draws inside a pass that already exists (M5 re-measurement: radius 13.3 ms/frame isolated vs 17.9 ms/frame for blur, vs 43.5 ms/frame for shadow; the radius number is the cost of the pass, not the cost of the radius change).

### The structural conclusions that follow

- **(a) The frame is a pure function of `(document, t)`.** Extract `evaluate: (Document, t) → FrameState`, where `FrameState = { sourceTimes, rects, transforms, velocity, maskParams, shadowGeom, activeCaptions, annotations }`. CPU, microseconds, testable without a GPU. Parity lives here: preview and export call the *same* `evaluate`, so they cannot drift on layout, easing, timing, or reveal logic. (The geometry code already exists, smeared across `compositeLayout.ts`, `zoomTransform.ts`, `updateAnimationState` — this is an extraction, not a rewrite.)
- **(b) The compositor is tiny.** The full feature set compiles to: 4 textures (screen · webcam · background · glyph/annotation atlas), 1 uniform block (~200 bytes: rects, matrices, velocity, radii, shadow params, mask selector, reveal progress), 2 passes (P1: directional motion blur, only when `|velocity| > 0`; P2: composite, one draw call; P3: 3D rotation, folds into P2's vertex stage), caches (wallpaper 1×, shadow per-geometry, masks per-shape, caption rasters per-segment, cursor sprites 1×). Any 2015-class GPU runs this in **< 2 ms** at 1080p. Text is the one thing that stays CPU-rasterised (glyphs → offscreen → texture, cached per segment, raster only the caption's ~1920×200 rect).
- **(c) Only two seams matter.** With (a) at ~0 ms and (b) at ≤ 2 ms, the architecture is decided by two data handoffs: S1: decoded frame → compositor texture (decode → GPU); S2: composited target → encoder (GPU → encode). **Every measured disaster in this project happened at a seam.** The design rule: both seams stay on the GPU device and are crossed exactly once per frame. The web platform's S1 (`VideoFrame` → texture import) and S2 (`VideoFrame(canvas)` → `VideoEncoder`) are the designed fast paths and are what L0's 213 fps already includes.

## The fix, and what it bought

> The Canvas2D/Pixi compositor this rebuilt is no longer on the MP4 path — `crates/compositor/` replaced it. `src/lib/exporter/frameRenderer.ts` still carries the work, and still serves **GIF export**, which has no native encoder yet. So the caches and the byte-identical parity gate below are live for GIF and history for MP4.

### The change

The compositor was rebuilt to classify by what invalidates a cache, not by layer:

| never | on geometry | every frame |
|---|---|---|
| wallpaper blur | drop shadow, rounded mask, video texture | video, cursor, webcam, annotations |

Concretely:

- Pre-blur wallpaper at init; per-frame draw = plain blit with `globalCompositeOperation='copy'` (`frameRenderer.ts:1007–1017`).
- Shadow: render the same 3-filter chain **once per geometry** onto a white rounded-rect silhouette, cache by `(rect, radius, intensity)`, per-frame = 2 `drawImage` (`:1045` and `:533`). The silhouette is taken from `videoCanvas`'s own alpha (`drawImage` + `source-in` over black), so nothing has to stay in sync as layout code evolves; the shadow output is `silhouette OVER shadow`, so drawing `videoCanvas` on top covers the silhouette exactly, **including the anti-aliased corners**.
- Delete the always-zero `BlurFilter`; attach `motionBlurFilter` only when `velocity > 0` (pattern: `pixiCursorRenderer.ts:568`) (`:235/238/240`).
- Reuse one GL texture, stop create/destroy per frame (pattern: `threeDPass.ts`) (`:409–415`).
- Rebuild mask only on layout change (`:769–771`).
- `clearRect(w,h)` before a `drawImage(w,h)` that covers the canvas is two full-frame passes where `globalCompositeOperation = "copy"` is one.

**Do not** replace the shadow with an SDF/`smoothstep` approximation: the cascaded falloff is exact-cached instead, because this codebase has already been burned twice by shadow-falloff/corner-AA approximations (see the comments in `threeDPass.ts`). The separately-falsifiable shadow-on-GPU spike (three successive box blurs in a shader, pixel-diffed against the Canvas2D output) is a separate item — see [Known gaps](#known-gaps).

### The measured delta

Within-run ratios only (this machine is not reproducible):

| run | before | after | ratio |
|---|---:|---:|---:|
| `composite-ceiling`, shadow+radius | 39.45 ms/frame | 20.22 | **1.95×** |
| `webcodecs`, blur+shadow+radius | 67 717 ms | 33 707 | **2.01×** |
| `webcodecs`, shadow+radius | 63 825 ms | 39 839 | **1.60×** |

**Output is byte-identical.** Same timeline, same encoder, old compositor vs new → the files are identical byte for byte, SSIM 1.000000 across all 1418 frames. Not a pixel moved.

Gate G0 measured the in-run effect: legacy 9.8 → shipping 14.6 fps (+49 %) on a project whose per-frame webcam compositing the changes never touched. The L7 row confirms the ceiling: compositor cache hits at 0.8 % miss on a still camera, so the shadow drops to ~1.3 ms/frame there.

## The WebCodecs bench (retired)

> Retired with the pipeline it measured. `src/bench/runBench.ts` is deleted and `npm run bench:export` is no longer a script in `package.json`; `scripts/bench-export.mjs` is deleted along with its runner. The live harness is [`x.bat --cfg C0..C8`](#measuring-it-today). The design rules below — interleaved arms, spread gates, ratios-only, gated parity — are what any replacement has to keep, which is why they are recorded.

### Command

```bash
# retired — the runner this drove no longer exists
npm run bench:export -- --project=<id|title> --arms=webcodecs,native --runs=2 --effects=shadow,blur
```

`scripts/bench-export.mjs` + `src/bench/runBench.ts`. It **simulated nothing**: it opened the real editor window (same `webPreferences`, preload and sandbox), loaded a real saved project through the same bridge the editor uses, and called `exportAxcutDocument` — `ExportDialog`'s own entry point. Only React was skipped, so nothing rendered alongside the export.

It exists because driving this through the UI cost ~5 minutes a run and kept injecting confounds: one A/B ran with DevTools open on **one arm only**; another ran on a laptop at 5 % battery whose SoC budget drifted 26 % *between the two arms* — enough to invert the conclusion.

### Arms

Arms set `localStorage` flags read at runtime, so one app session measures every arm against one document: `webcodecs`, `native`, `*-legacy` (the pre-2026-07-17 compositor, for attribution), `composite-ceiling` (render only), `readback-ceiling` (render + `copyTo`, discard).

### Fixture

`--effects=shadow,blur,radius,zoom` patches an in-memory **copy** of the document; nothing reaches disk. Saved projects carry no appearance at all (`shadowIntensity` defaults to **0**), so whole effects never execute — "fixing" the shadow on a default project measures exactly zero. The `zoom` effect matters beyond its own cost: it is the only effect that changes geometry per frame, so it is what invalidates a geometry-keyed cache. **A parity test without it passes with a broken cache key**, because nothing ever asks the cache to invalidate.

### Parity is gated, not argued

Unit tests never look at a pixel. The `native*` arms write real files: export the same timeline through the same encoder with each compositor, then `cmp` and `ffmpeg -lavfi ssim`. Every compositor change above cleared it byte-for-byte. **"Obviously equivalent" is what this pipeline keeps punishing** — gate it.

### Ratios only

**Only within-run ratios transfer between machines, never absolute times.** Arms interleave (A, B, A, B), and the bench reports same-arm spread and declares itself VOID above 10 %. A stable measurement is not a true one — see [Measurement hazards](#measurement-hazards) for the full set of traps this bench exists to prevent.

## Rejected routes

### Rust + wgpu native POC (`poc-native/`)

**What it was.** `poc-native/` — Rust, wgpu (Vulkan on the reference AMD iGPU), the AMD hardware encoder via ffmpeg `h264_amf`. No browser, no WebCodecs. **What the measurement said.** The compositor is portable, proven: wgpu runs `composite.wgsl` **unchanged** — the only edits are the two the web platform forces and native lacks (`texture_external` → `texture_2d`, `textureSampleBaseClampToEdge` → `textureSampleLevel`); the native frame at t=0.5 s is pixel-identical to the web POC. Encoder ceilings measured (ffmpeg, `-benchmark`): `h264_amf` with CPU-decoded frames ~180 fps; `d3d11va` decode → `h264_amf`, frames stay on GPU **256 fps** — the hardware encoder is not the wall. The naive Vulkan pipeline measured 31 fps end-to-end (decoded via wgpu, composite in WGSL, encode `h264_amf`), but the cause was measured before it was concluded: with encode pipe 31.2 fps vs without 31.7 fps, the encoder isn't the wall; the decode pipe alone (ffmpeg → /dev/null, 180 frames) is **30 fps**, 3.9 s of system time — 8 MB/frame × 180 = 1.4 GB of *uncompressed* pixels shoved between subprocesses. The wall is the subprocess raw-RGBA pipes, an artifact of reaching ffmpeg as a child process, not the descent, not the compositor (1.9 ms), not the encoder (256 fps). The CPU path was pushed to its ceiling and loses by construction: subprocess pipes 31 fps, in-process CPU decode synchronous 25 fps, in-process CPU decode threaded (overlapped) no encode 61 fps, threaded decode + composite + `h264_amf` ~48 fps, threaded no-readback no encode 68 fps — against WebCodecs 79 fps and `d3d11va` → `h264_amf` all on GPU 256 fps. Threading the decode was the real lever (25 → 61): the subprocess version's advantage was never "pipes", it was parallel decode. The CPU path plateaus UNDER the browser, and the reason is pinned by the no-readback probe: the descent (GPU→CPU) is only ~10 % (61 → 68); the wall is **CPU↔GPU transport** — 9 MB uploaded per frame on input, 8 MB read back on output, plus CPU swscale at both ends (YUV→RGBA decode, RGBA→NV12 encode). The browser pays none of this: WebCodecs decodes into GPU-backed `VideoFrame`s that `importExternalTexture` wraps with no CPU copy. **The Vulkan route is blocked on the driver:** `VK_KHR_video_maintenance1` is required and the AMD iGPU's driver (24.10.38) predates it. `crates/compositor/` delivers the same GPU-resident principle on the shipped driver and is the retained native fast path (see [D3D11](#the-d3d11-native-fast-path-cratescompositor--2026-07-18) above). **One-line reason not to re-propose:** portability is proven but the GPU-resident native ceiling requires a path the AMD driver doesn't expose; the same goal is reached on D3D11.

### Tauri / a separate native core

**What it was.** OpenScreen, but on Tauri, with the compositor in a Rust core. **What the measurement said.** It is not Node vs Rust, and not Electron vs Tauri. Neither the language nor the shell forces the descent — **the browser engine does.** The compositor is Pixi/WebGL/Canvas2D inside Chromium's renderer, and Chromium exposes its GPU textures to nobody. Tauri's webview on Windows is Chromium (WebView2): composite in the webview under Tauri and you pay the identical descent. Zero descent requires the compositor to stop being a web canvas and become the project's own GPU code, owning the same device as the encoder. That is reachable **from Electron too** — an N-API addon, or a native sidecar. **The shell is a consequence, not a cause**; it earns its place on bundle size and memory, never on this measurement. What would actually force the shell question is the preview: once the compositor is native, the preview must come from it too, or the product ships two compositors and loses the parity that is its entire value. Hardware findings (measured 2026-07-17, bundled ffmpeg, reference laptop): GPU decode → GPU encode, no descent, no compositing = 234 fps; Vulkan is a dead end for the encoder here (the driver exposes `video_decode_queue` only, no encode queue; AMF refuses to initialise from a Vulkan device — *"not supported"*, explicitly); `scale_d3d11` fails to create its texture (`80070057`) on every format tried; d3d11 → OpenCL `hwmap` fails on NV12's UV plane. So **the ffmpeg CLI cannot express GPU-composite → GPU-encode on this hardware** — a limit of its filter plumbing, not of the GPU. **One-line reason not to re-propose:** the engine forces the descent, not the shell; the same engine runs under Tauri.

### Native ffmpeg encode driven from the renderer

**What it was.** M2 above: composite in the Chromium renderer, copy pixels to CPU, IPC to the main process, pipe into a bundled LGPL ffmpeg with the AMD hardware encoder. **What the measurement said.** **2.1× SLOWER end-to-end** (38.5 s → 80.8 s, spread 3–4 %). ffmpeg itself consumed frames faster than WebCodecs (`encodeWait` −29 %, `flush` −94 %) — but WebCodecs encodes straight off the GPU texture and never brings a frame to the CPU. The M3 ceiling arm bounds the related "sandbox: false, direct pipe" variant: with the crossing at exactly zero (frames descended then discarded: no IPC, no ffmpeg, no muxer) the pipeline still lost, **while WebCodecs was also writing the file**. It does not even remove the crossing — it swaps a structured clone (~390 MB/s) for a pipe write (~500 MB/s), ~1.2× on one leg, bought by giving up the sandbox that guards demux/decode of untrusted media. Phase-4 GPU BGRA→NV12 packing cannot rescue either: the descent measured 6.7 ms fixed + 3.9 ms/MB (257 MB/s marginal — a sync, not a copy), so NV12 halves it and still lands at parity at best. Worker + OffscreenCanvas buys UI responsiveness, not speed; the main thread was never the throughput limit. A previous attempt to keep the composited texture on the GPU side (`a31cf49` → reverted `e6cbb45`) was implemented, measured, reverted: it moved the work, left the synchronisation where it was. **One-line reason not to re-propose:** WebCodecs encodes straight off the GPU texture and never brings a frame to the CPU; adding a descent to a wall that was already there.

### Encoder pipelining

**What it was.** Keep the encoder queue full (queue depth ≥ 2) so the compositor and the encoder overlap, rather than awaiting each frame. **What the measurement said.** C.3 (2026-07-17, reference iGPU, corrected throughput metric, interleaved A/B, spread 7–11 %, so real): encoder queue depth 4 (buffered / pipelined) **49 fps**; encoder queue depth 1 (serialised, await each frame) **79 fps**. **Pipelining is 38 % SLOWER here, not faster.** The likely cause is that an integrated GPU shares one memory bus between the WebGPU compositor and the fixed-function H.264 encoder: overlapping them makes them contend for bandwidth, where serialising lets each have it in full per turn. A first, larger "gain" from pipelining — +205 % — was the empty-loop artifact (see [Measurement hazards](#measurement-hazards)), not real. The native twin on the D3D11 path confirms: 3d 84 % + codec 61 % = 145 % over the same window, so the GPU already pipelines the stages across frames on its own; a no-op SRV-cache trial that reduced CPU overhead moved neither bound. **One-line reason not to re-propose:** a loss on the target integrated GPU; default is serialise on iGPU, keep the pipeline path behind a `queueDepth` override for discrete-GPU machines (a discrete-GPU run is owed — see [Known gaps](#known-gaps)).

### Software VP9

**What it was.** `libvpx-vp9` software encode as a fallback for the absence of a hardware VP9 encoder. **What the measurement said.** Correct output, no hardware VP9 encoder on the target reference machine (the AMD iGPU ships `h264_amf` and HEVC encode, not VP9). It is the only VP9 path available on this hardware, but it is far too slow for either preview or export — the gap to the hardware H.264 path the product actually uses is several orders of magnitude, and no in-house benchmark number survives the question of what it would buy. **One-line reason not to re-propose:** with no hardware VP9 to fall back on, software VP9 cannot reach the frame rate the product requires.

### Native GIF export — initial bench (slice 1, 2026-07-28)

> **The path chosen.** Hand-rolled pure-Rust GIF89a writer in
> [`crates/compositor/src/gif_export.rs`](../../crates/compositor/src/gif_export.rs):
> header + Graphics Control Extension + Image Descriptor + LZW
> (GIF's `palette`-as-codes-0..255-with-256-clear-257-EOI variant,
> LSB-first code packing) + trailer, hand-rolled. Palette via
> median-cut on the frame's colour histogram (the standard Heckbert
> algorithm, count-weighted split at the median of the longest-axis
> channel). No new crate deps, no swscale round-trip, no GPL
> pull-ins. The rejected alternatives were the ffmpeg
> `palettegen` + `paletteuse` filter graph — the compositor's ffmpeg
> bindings are `avformat` / `avcodec` / `avutil` / `swscale` /
> `swresample` only, **no `libavfilter`**
> ([`crates/compositor/Cargo.toml`](../../crates/compositor/Cargo.toml), [`crates/compositor/build.rs`](../../crates/compositor/build.rs)),
> so `palettegen` / `paletteuse` are not buildable — and ffmpeg's
> `gif` muxer / codec, which expects pre-quantized `PAL8` frames
> and refuses to do the quantize step itself. The "ffmpeg GIF
> muxer" route was a write-our-own-palette-and-LZW path either
> way, and the CPU readback (the dominant per-frame cost) lands
> us on CPU regardless. Writing it in pure Rust skips a swscale
> round-trip and keeps the readback / quantize / LZW layers
> auditable in one file. See [`crates/compositor/src/gif_export.rs`](../../crates/compositor/src/gif_export.rs) for
> the implementation, [`crates/poc-d3d/src/bench.rs`](../../crates/poc-d3d/src/bench.rs) for the bench.
>
> **No prior `gif.js` baseline is documented in this file.** The browser-side
> `npm run bench:export` that measured `gif.js` (Canvas2D compositor +
> `gif.js` worker, the same path `gifExporter.ts` still uses today) was
> deleted with the rest of the WebCodecs export pipeline (see
> [The WebCodecs bench (retired)](#the-webcodecs-bench-retired)). The
> closest historical anchor is the M2 arm of the retired harness, which
> measured the full `native ffmpeg` path (encode `h264_amf` of pre-materialised
> frames) at **165 fps** — but that was the encode alone, not the
> descent, and the comparison with GIF's CPU quantize + LZW is apples
> to oranges anyway. **The honest signal here is the wall-time of the
> native GIF path itself**; the comparison with `gif.js` is a separate
> cross-stack measurement to be added once the renderer-side `gif.js`
> is exercised through the same harness, and a follow-up PR will pick
> that up.

The slice-1 bench lives at `--cfg GIF` on the existing
`crates/poc-d3d/src/bench.rs` (the same C0..C8 harness, just a separate
mode). It drives `compositor::export_gif` end-to-end on the fixture
(`fixture/screen.mp4` + `fixture/webcam.mp4` + `fixture/screen.cursor.json`,
360 frames at 60 fps = 6 s source), defaulting to 854×480 / 12 fps /
infinite loop / no dithering, and reports wall time, frame count, FPS,
file size, ms/frame, and spread across `--repeat` runs.

```bash
# from crates/
x.bat run --release -- --cfg GIF --repeat 3 --out out/
# optional overrides: --gif-width 1920 --gif-height 1080 --gif-fps 24 --gif-dither 1
```

Per the brief: "**the readback is the dominant per-frame cost**." That
claim is the one the bench is built to verify. The wall-time recorded
in slice 1 is the first number; a 5× regression vs. the renderer-side
`gif.js` would block the swap (the user already chose the Rust path,
but a 5× regression isn't a win). The follow-up slice will run the
same harness against `gif.js` to settle that ratio.

**Reading the result.** Compare two numbers:
- the C0 row of the C0..C8 bench (encode alone, no descent) — the
  GPU-residency ceiling on this machine for the same source;
- the `wall_s_best` row of the GIF bench — what the native GIF path
  actually delivers, including the readback + median-cut + LZW.

The gap between them is the cost the readback + palette add on top of
the composite. If the GIF wall is within ~2× the C0 wall, the path is
viable; if it's >5×, the swap is rejected on the bench signal. The
ratio is what this section claims — the absolute number will land when
the bench runs on the reference machine.

## Known gaps

- **The C0→C8 table rests on one run, on one machine.** [Recorded above](#one-admissible-run--2026-07-27) and admissible on its own gate, but a single sweep: the C5–C7 plateau is the part most likely to move under a second run, since the layers it prices are individually smaller than the machine's own noise. A repeat on a cool machine — and on the discrete-GPU box that is [owed anyway](#known-gaps) — would settle whether those three are genuinely free or merely under the floor.
- **The fixture media is not versioned, and its cursor track has no provenance entry.** `crates/fixture/fixture.json` documents the exact `-c copy` cuts for `screen.mp4` and `webcam.mp4` (which is what made the run above reproducible), but says nothing about `screen.cursor.json`, which C7 needs. It happens to be the raw, uncut `.cursor.json` beside the origin recording — the loader windows it itself at `offset 100_000 ms, 6 s` ([`bench.rs:70`](../../crates/poc-d3d/src/bench.rs)), matching the manifest's `cut_offset_s: 100`. That is recoverable by reading the code, not by reading the manifest; the manifest should carry it.
- **One bench fixture is still corrupt, from a bug since fixed.** Two concurrent saves used to be able to interleave and truncate a project file, which destroyed at least two real ones (a valid JSON prefix followed by the tail of a longer version). `proj_de6ffaaa` (`os_parity`) is still in that state — 4006 bytes, 3485 of them valid JSON — with a byte-exact backup beside it (`*.corrupt-backup-20260716`); recovery is mechanical (truncate to the 3485-byte prefix). The bug itself is gone: `DocumentService` now serialises saves through a per-project write queue and writes atomically (unique temp file → `fsync` → rename), which is why Gate G0 was run on `proj_5b3ac6bc` instead. The reference project for M1–M4 is `proj_a7468696`.
- **A discrete-GPU and Intel QSV run is owed** (G3). Every number in this record is from a single iGPU laptop. A hybrid-GPU laptop (Intel iGPU + NVIDIA dGPU; AMD APU + AMD dGPU) is the case that must be measured and adapter-pinned before any native number is trusted there: if decode, composite and encode land on **different** adapters, the single-device zero-copy assumption breaks and a cross-adapter copy through system RAM / PCIe is forced — a descent in disguise, reintroducing exactly the wall this architecture removes.
- **Shadow-on-GPU spike.** Reimplement the exact 3-pass cascade (the SVG `feGaussianBlur` for the project's radii) in a shader, pixel-diffed against the Canvas2D output. Falsifiable: if the GPU and Canvas2D outputs do not match, the claim is wrong. Skia's real path may not follow the spec's letter. The product call (2026-07-17) that a moving camera is the norm is what makes this the remaining lever on heavy timelines.
- **Software VP9 under any target hardware is not measured** — it is recorded as a refuted route, not as a benchmarked number.
- **The "moving camera is the norm" product call** is the product owner's standing answer, not a measurement. The L7 row's 0.8 % / 54.1 % cache-miss split is the bench's answer; the user's call is what determines what fraction of a typical timeline exercises the moving-camera path. The decision the call enables — the unified GPU-resident compositor — is recorded in [../architecture/decisions.md](../architecture/decisions.md).
- **The "average fps vs cruise fps" correction** lives in the harness, not in the bench UI: cruise = median of the last three quarters. The same metric is reported everywhere.
