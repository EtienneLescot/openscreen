# Native Core — moving the compositor out of the browser renderer

Status: **Exploratory / for decision.** This is a product-architecture proposal, not a perf patch.
Scope: the render/composite/encode core of the `.axcut` editor — preview *and* export.
Prerequisite reading: [`export-pipeline-v2-spec.md`](./export-pipeline-v2-spec.md) §3.1 and §4.4.1 — every number below comes from there.

> **Re‑framed 2026‑07‑16 by measurement.** The plan was A (bundled ffmpeg, ~×10) *then* C (this doc,
> the last ×2). A was built and measured: it is **×0.48** — 2.1× slower than WebCodecs, because a
> sandboxed renderer cannot hand a GPU texture to a native process, so every frame must descend to
> RAM (38.9 ms/frame) where WebCodecs never descends at all. See
> [`export-native-encode-measurement.md`](./export-native-encode-measurement.md).
>
> **Option A′ (`sandbox: false`) is excluded — measured, not argued.** With the crossing set to
> *exactly zero* (frames descended to RAM then discarded: no IPC, no ffmpeg, no muxer) the pipeline
> still runs 40.5 fps against WebCodecs' 44.0, and WebCodecs is also writing the file. That ceiling
> bounds every "remove the crossing" variant at once — A′, shared memory, zero‑copy transfer — since
> none of them can skip `copyTo()`. A′ is strictly worse than that ceiling anyway: it swaps a
> structured clone (~390 MB/s) for a pipe write (~500 MB/s), i.e. ~1.2× on one leg, bought by giving
> up the sandbox that §3.2 identifies as protecting demux/decode of untrusted media.
>
> This does not make C a bigger win by default — it makes C the **only** arrangement in which native
> encode can pay, and for a different reason than this doc argues: not "fewer copies", but *the frame
> never descends*. That is now the load‑bearing assumption of this entire proposal, and it is
> **unmeasured**. Prototype and bench "composite and encode on one device, frame never descends"
> **before** committing to a migration. The last architectural certainty was 2.1× backwards.

---

## 1. Why this exists

The export pipeline was measured end‑to‑end (2026‑07‑16). After replacing the WebCodecs encoder with native ffmpeg, the bottleneck is **not** the encoder any more — it is the **renderer→main process crossing**:

| architecture | fps @1080p | vs today |
|---|---:|---:|
| today (WebCodecs) | 8 | — |
| Phase 3 — native ffmpeg, BGRA over IPC | 34 | 4.3× |
| Phase 4 — + GPU NV12 packing (halves the bytes) | 81 | 10× |
| **native compositor (no crossing)** | **~165** (encoder‑bound) | **20×** |
| native compositor + parallel encode sessions | >165 | >20× |

The crossing exists for one reason: **the compositor runs inside a sandboxed Chromium renderer**, so every finished frame must be copied across a process boundary to reach a native encoder. Electron offers no zero‑copy path out ([electron#34905](https://github.com/electron/electron/issues/34905): the transfer list accepts `MessagePortMain[]` only — an ArrayBuffer transfer silently drops the message). Every frame is structured‑cloned: ~390–420 MB/s, and attaching ffmpeg to the receiving process costs another ~40 % because one thread both receives IPC and writes stdin.

**Phase 4 works around the wall (10×). This document is about removing it (20×+).**

## 2. The trap this must avoid

> Moving compositing to Rust **for export only** would give us two implementations of the entire visual identity — zoom spring, auto‑focus follow, motion blur, three‑layer drop shadow, webcam masks, cursor smoothing/click‑bounce/motion‑blur, annotations, 3D rotation, gradients, border‑radius, padding, crop — that must agree **pixel‑for‑pixel, forever**, because the preview would stay in the browser.

We spent a full session validating parity for *one* path. Two paths means paying that validation on every visual change, indefinitely. **A native compositor is only worth building if it serves the preview too.** That is the whole argument of this document, and the reason it is an architecture decision rather than an optimisation.

## 3. Correcting the framing: "Electron for UI + Tauri for backend"

That combination does not exist. **Electron and Tauri are both application shells** — each provides the window, the webview and the native backend. Electron = web UI + Node backend; Tauri = web UI + Rust backend. You pick one.

The real question is not *Electron vs Tauri*. It is:

> **Where does the compositor live, and how does the preview display its output?**

| option | compositor | preview display | crossing? | parity | other cost |
|---|---|---|---|---|---|
| **A. status quo + Phase 4** | Pixi/WebGL in renderer | canvas in the webview | yes (3.0 MB/frame) | ✅ one compositor | — |
| **A′. Electron, export window with `sandbox:false`** | Pixi/WebGL in renderer | canvas in the webview | **no** | ✅ one compositor | **the sandbox** |
| **B. Rust compositor, export only** | Rust/wgpu | Pixi (unchanged) | export: no | ❌ **two compositors** | months |
| **C. Rust compositor + native preview surface** | Rust/wgpu | native surface in the window | no | ⚠️ *promised*, not given (see below) | months + shell migration |
| **D. Rust compositor, preview via webview** | Rust/wgpu | frames pushed to the webview | **yes, reversed** | ✅ one compositor | months, for nothing |

**A′ is the option this document originally missed, and it matters.** The crossing is not purely architectural — it is partly *configuration*. With `sandbox:false` + `nodeIntegration:true`, the renderer **is** a Node process: it can `spawn('ffmpeg')` and write frames straight to `stdin`. V8 heap → pipe, no Mojo, no structured clone. (That is literally what our 165 fps `pipebench.cjs` measured.) **A′ reaches the same ~165 fps as C, for a boolean.**

We are **not** taking it. The app deliberately runs `nodeIntegration:false` + `contextIsolation:true` with the sandbox on by default, and the editor already spends its security budget on `webSecurity:false`. Turning the sandbox off on the window that handles user-supplied media trades a layer of defence-in-depth for 2×. (The threat model is narrower than it first looks — demuxing is WASM, decoding runs in the GPU process, and ffmpeg only ever sees rawvideo we produced — but an exploit in the WASM demuxer or the WebGL path would land on full Node instead of having to escape a sandbox first. That is a real loss.)

**What A′ does to the case for C:** they buy the *same thing* — removing the crossing, ~165 fps. A′ costs the sandbox; C costs months plus a wgpu compositor. So C is not "the only way to 20×" — it is "the way to 20× that lets us *design* the isolation instead of deleting it" (§3.2 — and only if we actually budget for that design).

**On C's parity column — read it honestly.** It is marked ⚠️, not ✅, on purpose. One compositor gives parity *by construction* only **after** the shadow, webcam mask, cursor and zoom easing are re‑implemented identically in wgpu — which is precisely where parity breaks in practice. Until then the ✅ is a promise, not a state. B is worse still: two compositors permanently, on a product whose entire value is that the export looks like the preview.

D is a trap: pushing preview frames back to the webview reintroduces the exact bottleneck, reversed.

### 3.1 A′′ — sandboxed demux, unsandboxed composite (unverified)

[electron#34905](https://github.com/electron/electron/issues/34905) notes the zero‑copy transfer that fails renderer→main **works renderer→renderer**. That suggests a narrower A′: keep demux/decode in the sandboxed editor renderer, transfer the *decoded* frames zero‑copy to a second, `sandbox:false` window that only ever sees **our own pixels**, and let that window spawn ffmpeg. The lock stays where the hostile input actually arrives.

**This is speculation.** Not measured, not validated. Two things would have to hold: that renderer→renderer transfer really is zero‑copy in our Electron version, and that a renderer holding no untrusted input is meaningfully safer — which is arguable, since it still runs Blink/V8. Worth an hour before anyone spends a month on C; not worth more than that until someone measures it.

### 3.2 Security: "going native" relocates the problem, it does not solve it

An earlier draft justified C partly as *"the way to 20× that keeps the sandbox"*. **That is wrong, and it is the most important correction in this document.**

| | who parses hostile input | is one bug enough? |
|---|---|---|
| **A + Phase 4** | `web-demuxer` in **WASM** (confined linear memory) + decode in the **GPU process** (separately sandboxed) | no — needs a parser bug *chained with* a sandbox escape |
| **A′** | unchanged — still WASM + GPU process | **yes** — *any* renderer bug reaches `require('child_process')` |
| **C** | **native ffmpeg (C), in‑process, no sandbox at all** | **yes** — any ffmpeg demuxer CVE lands on the machine |

Read the media column again: today the riskiest parser runs in **WASM**. A native core would replace it with **unsandboxed C parsing untrusted containers** — on the media path specifically, **C is a regression against both A and A′**. Media demuxers are among the most CVE‑dense code in existence, which is exactly why browsers confine them.

So the security objection to A′ does **not** convert into an argument for C. The honest distinction is narrower:

- **A′ removes a layer wholesale, with no recourse.** `nodeIntegration` is all‑or‑nothing for that renderer.
- **C hands us the isolation design.** We *can* run demux/decode in a sandboxed child process (what Chromium does), keep our own logic in memory‑safe Rust, and ship a webview with **no Node** at all (Tauri's IPC is a command allowlist, far narrower than `nodeIntegration`).

That is a **capability, not a property**. If C is built without that isolation, we will have spent months to end up **less safe than today**. Therefore:

> **Requirement (blocking) for C:** demux and decode of user‑supplied media MUST run in a sandboxed child process, not in the core. Any C proposal that does not budget for this is not a C proposal — it is a regression with better fps.

**For the record — this app is a screen recorder.** It legitimately holds screen contents, microphone, camera and the filesystem. An RCE here is worth more to an attacker than in almost any other desktop app. That asymmetry, not the raw CVE odds, is why the 2× does not buy the sandbox.

C is achievable in **either** shell — Electron with a napi‑rs addon plus a native child window, or Tauri natively. Tauri is the natural home (the backend already *is* Rust, and `wry` + a wgpu surface is a known pattern); Electron would be swimming against the process model. **This is what Cap (cap.so) does** — and why its native encoder crates make sense for it: Tauri/Rust, capture + composite + preview all native, no sandboxed renderer in the frame path.

## 4. Target architecture (option C)

```
┌─ Web UI (React) ─ unchanged ────────────────────────────────┐
│  timeline, inspector, dialogs, state (Zustand), i18n         │
│         │ commands (seek, set zoom, play…)  ▲ events         │
└─────────┼────────────────────────────────────┼──────────────┘
          ▼                                    │
┌─ Rust core ─────────────────────────────────────────────────┐
│  compositor (wgpu)  ← ONE implementation, used by both       │
│      ├── preview  → native surface layered in the window     │
│      └── export   → frame → encoder, in‑process, no crossing │
│  decode (ffmpeg/VideoToolbox/MF)                             │
│  encode (h264_nvenc / h264_qsv / h264_amf / videotoolbox /   │
│          vaapi — via ff-encode or vendor crates)             │
│  muxing, audio (WSOLA + AAC)                                 │
└─────────────────────────────────────────────────────────────┘
```

**Key property:** the compositor is a pure function of `(RenderPlan, time) → frame`. The preview draws it to a surface; the export hands it to an encoder. Same code, same pixels, by construction — parity stops being a thing we validate and becomes a thing we get for free.

### 4.1 What ports, and what does not

| layer | today | native core | effort |
|---|---|---|---|
| Web UI, timeline, state | React | **unchanged** | none |
| `RenderPlan` model | TS (`renderPlan.ts`) | port to Rust (pure data + logic, already unit‑tested) | S |
| geometry/timing SSOT (`compositeLayout`, `zoomTransform`, zoom spring, auto‑focus, cursor smoothing) | TS, pure | port to Rust — these are pure maths with tests, the cheapest part to move | M |
| compositor (Pixi/WebGL + Canvas2D layers) | TS | **rewrite in wgpu** — video sprite, wallpaper, 3‑layer shadow, webcam mask, cursor, annotations, 3D rotation, blur/motion‑blur | **L — the real cost** |
| preview display | `<canvas>` in webview | native wgpu surface in the window | M |
| decode | WebCodecs + web‑demuxer (WASM) | ffmpeg/native | M |
| encode | WebCodecs | native (this is the 20×) | S — mostly done in Phase 3 |
| audio (WSOLA, AAC, concat) | TS, pure + tested | port to Rust | M |
| capture (WGC, cursor sampler) | already native `.exe` | reuse as‑is or fold into the core | S |
| STT (whisper) | already native | unchanged | none |
| shell (IPC, updater, packaging, single‑instance, global shortcuts) | Electron | **rewrite for Tauri** | **L — the hidden cost** |

**The two big items are the wgpu compositor and the shell migration.** Everything the app already ships natively (`wgc-capture.exe`, `cursor-sampler.exe`, whisper) survives.

### 4.2 Why wgpu

One Rust codebase targeting Vulkan/Metal/D3D12 natively — and WebGPU in a browser, which keeps a web build possible. Effects map to shaders; the current 2D‑canvas layers (shadow, masks, cursor) become quads + fragment shaders. Alternative: per‑platform native APIs (Cap's `enc-avfoundation` / `enc-mediafoundation` model) — more code, no portability upside for compositing.

## 5. Honest cost / risk

- **This touches the product's entire visual identity.** Every effect must be re‑implemented and must look *right*, not merely *similar*. The frame‑diff harness from the export work is the gate, but the surface is large.
- **Shell migration is not free**: Electron APIs in use (`desktopCapturer`, `globalShortcut`, single‑instance lock, auto‑update, notarisation/packaging for 3 OSes, the whole `electron/ipc` surface) all need Tauri equivalents. Some are better in Tauri, some worse.
- **The team's language mix changes.** Today: TS + a little C++/native. After: a substantial Rust core that the whole team must be able to touch.
- **It is a months‑scale project**, and it competes with product work for the same 2× that Phase 4 does not deliver (10× → 20×).
- **Risk of a half‑migration**: option B (export‑only Rust compositor) is the tempting shortcut and it is the worst outcome — two compositors, permanent parity tax. If we start, we must reach C.

## 6. Recommendation & sequencing

1. **Do Phase 4 first, now** (§4.4.1 of the export spec): NV12 packing + move the ffmpeg stdin write off the IPC‑receiving thread. Target ~81–100 fps (**10×**), no architecture change, one compositor, no security trade. It is *not* wasted if we later go native — the encoder selection, the LGPL ffmpeg bundling and the capability probe all survive into the Rust core.
2. **Exhaust the free levers before paying for anything.** They can close the question outright: **N parallel MessagePorts** (untested — if the crossing goes 387 → ~600 MB/s, Phase 4 becomes encoder‑bound and C loses its entire reason to exist), and moving the stdin write to a `worker_thread` so the IPC‑receiving thread stops serialising with it (that serialisation costs a measured 40 %). A bigger credit window is **already ruled out** — measured 131 fps at window=32 vs 130 at window=8, saturated.
3. **Then decide C on evidence**, judged against A′ rather than against A: C's actual offer is *"the 2× that A′ gives for free, but without giving up the sandbox"*. That is worth something — it is not worth what this document originally implied.
4. **Spend an hour on A′′ (§3.1) before spending a month on C.** If renderer→renderer zero‑copy holds up, the crossing may be removable without touching the lock that guards the hostile input.
5. If we go C: **spike first** — a wgpu compositor rendering *one* clip with zoom + shadow + webcam, frame‑diffed against the current export. That subset is where the ⚠️ in §3's parity column lives. If parity is achievable there at reasonable cost, the rest is grind. If not, we learn cheaply. **Budget the sandboxed demux/decode child process from day one** (§3.2) — it is blocking, not a nice‑to‑have.

**Bottom line:** Phase 4 buys **10×** for weeks, safely. C buys the last **2×** (81 → 165 fps: 6.7 s → 3.3 s on os_parity, ~7.4 → ~3.6 min on a 10‑minute recording) for months, a Rust compositor, a shell migration, and a parity risk that is real. A′ buys that same 2× for a boolean — and we are refusing it on security. Consistency does not *force* refusing C, but not for the reason first written here: C does **not** "keep the sandbox" (§3.2). It relocates the exposure into native code and hands us the isolation design — which is a capability we then have to pay for. Same 2× prize either way; price it as such.

**Retracted:** an earlier draft argued *"measure 4K, the crossing scales with pixels while the encoder degrades more gently, so 4K makes this case much stronger."* That was itself an unmeasured extrapolation — the encoder slows at 4K too (h264_amf drops to roughly 40–50 fps), so the gap narrows rather than widens. 4K does not rescue this case.
