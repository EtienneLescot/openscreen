# OpenScreen Roadmap
The recorder you love, with an optional AI sidekick. Same sleek, low-friction recorder UX. An opt-in AI editing layer is on the way for users who want it — never required, never snuck in.

This roadmap is the source of truth for what we're shipping next in OpenScreen. It is a living document — items move between tiers as work lands. Have an idea, a vote, or a dissenting opinion? Drop into the 🗺️・roadmap channel on our Discord or open a GitHub issue with the `roadmap` label.

## 🧭 North Star
**Record → Edit → Export.** (with an optional AI shortcut for users who want one)

OpenScreen is, first and foremost, a polished screen recorder. Record, trim on the timeline, export. Most users will keep using exactly this workflow.

There is also an optional AI editing layer — for users who want to edit by talking or by editing a transcript. It's opt-in, off by default, and never required. If you don't enable it, the AI layer doesn't exist for your install: nothing downloads, nothing leaves your machine, no LLM is contacted.

Three axes guide every decision on this roadmap:

- **Stability first** — the recorder must work reliably on macOS, Windows, and Linux. Bugs found by real users ship before new features.
- **Sleek UX stays** — every AI feature must keep the OpenScreen feel: minimal clicks, instant feedback, no clutter.
- **100% free, forever** — no paywalls, no premium tier, no usage caps. Every feature on this page ships under MIT.

## 🤖 The optional AI Edition — shipped, off by default
A Screen Studio + Descript alternative, open-source and free forever. The recorder-first UX stays intact, and the AI layer sits beside it, off by default.

What ships today (each one opt-in, each one toggleable independently):

- [x] **Local Whisper transcription (on-device)** — whisper.cpp with the compute backend picked at runtime: Metal on Apple Silicon, Vulkan on Windows and Linux, CPU everywhere else. No upload, no cloud, works offline. It's the foundation every feature below stands on.
- [x] **Transcript-driven editing (local)** — edit video like a doc: select words, press `Delete`, the span is cut from playback and export. Silences are marked inline and trimmable the same way. Word boundaries are re-anchored on the audio so a cut lands where the word actually starts.
- [x] **Captions as a derived layer (local)** — cues are a live view of the transcript, not generated text you then maintain; restyle or regroup them with no regeneration step. Optional translation into 15 languages, stored beside the transcript and never in it.
- [x] **Edit by chat (requires BYO LLM key)** — describe an edit in plain language; the agent applies real, undoable timeline operations (trims, zooms, speed, annotations, clip ranges, reordering). Off until you connect a provider.
- [x] **Non-destructive project document (always on)** — `.openscreen` projects keep every edit re-editable, and `Ctrl/Cmd + Z` covers agent edits exactly like manual ones.
- [x] **Bring-your-own LLM (opt-in)** — Anthropic, OpenAI, Google, Mistral, OpenRouter, MiniMax, and any OpenAI-compatible endpoint. Keys live in your OS credential store via Electron `safeStorage`; requests go straight from your machine to the provider. We never see them, because there is no server to see them with.

Still open on this axis:

- [ ] **One-click cleanup** — silence trimming ships in the transcript pane, but there's no dedicated filler-word pass (only the agent names a word a filler today), and voice enhancement ("Studio Sound") isn't started.
- [ ] **Sanctioned ChatGPT / GitHub Copilot sign-in** — both were removed in 1.8.0: reaching a user's subscription meant shipping GitHub's and OpenAI's own client IDs and an editor `User-Agent` against endpoints reserved for first-party clients, from inside a signed installer. They come back on the vendors' sanctioned surfaces — GitHub's Copilot SDK (we register our own OAuth App) and `codex app-server` (drives the user's own `codex login`, no client ID shipped at all). Separate integrations, not a header swap.

## 🖥️ Rendering & platform parity
The live preview and MP4 export run on one native Rust compositor: demux → decode → composite → hardware encode → mux, GPU-resident, no CPU readback between stages. Both consume the same scene description, so the frame you see in the editor is the frame the export writes — there is no second renderer that can drift.

That engine ran on Direct3D 11 only until 1.8.0, which made this the largest gap on the roadmap. It now has three backends behind the same scene contract:

- [x] **MP4 export on macOS** — Metal render pipeline with VideoToolbox decode and encode, a CoreText text rasterizer, and audio muxed into the output. All nine shader entry points are ported to MSL, so annotations, the cursor and its trail, the 3D tilt zoom and the dual-Kawase blur all render there.
- [x] **MP4 export on Linux** — wgpu/WGSL pipeline with software H.264 encode, MP4 mux and AAC audio.
- [x] **Feature:** software fallback when no GPU encoder is available — [#18](../../issues/18). A CPU backend (software render + decode) is selected automatically and surfaced in the UI, and reaches the export encoder like any other backend. Direct3D 11 now fails legibly rather than silently degrading to WARP.

Still open on this axis:

- [ ] **Hardware encode on Linux** — the export path is correct but software-encoded, so it is slower than the Windows and macOS ones. The capture helper already uses a hardware H.264 encoder; the export pipeline does not.
- [ ] **A discrete-GPU and Intel QSV measurement.** Every number in [rendering-performance.md](technical-documentation/engineering/rendering-performance.md) comes from one passive-iGPU laptop, deliberately chosen as the weak case. Nothing is measured on the hardware most users have.

## 🛠️ Stability & quality (what we're actually shipping)
Pulled from real user bug reports on getopenscreen/openscreen. This is the queue for the next release window.

- [ ] **Fix:** video disappears from editor after export — [#8](../../issues/8) (Linux, Manjaro). Renderer regression after export.
- [ ] **Fix:** crash after stopping macOS recording — [#21](../../issues/21) (macOS 26.4.1, Apple Silicon). Crash is in the Electron / Node async fs shutdown path; recording artifacts are written correctly.
- [ ] **Fix:** macOS cursor offset in single-window capture — [#22](../../issues/22).
- [ ] **Fix:** recover preview from WebGL context loss on Linux / Wayland — [#19](../../issues/19).
- [x] **Feature:** copy / paste attributes in the timeline — [#24](../../issues/24). `Ctrl/Cmd + C` / `Ctrl/Cmd + V` copy a selected region's attributes onto another region of the same kind.
- [ ] **Feature:** right-click context menu for the copy / paste above — the other half of [#24](../../issues/24), still open.
- [x] **Feature:** restore blur regions — [#76](../../issues/76). Shipped as an annotation **type** rather than its own region kind: Gaussian or mosaic, rectangle or oval, composited natively in both preview and export. Freehand is deliberately not offered when creating one — its input was broken and the renderer only ever masked the bounding box, and a half-reliable privacy tool is worse than no tool, because people trust it. Existing freehand shapes still render as their bounding box, with the inspector saying so.

## 📚 Site & documentation
- [x] **Feature:** Docusaurus site — landing + docs, live at [getopenscreen.github.io/openscreen](https://getopenscreen.github.io/openscreen/), built from `website/` and deployed to GitHub Pages by `.github/workflows/docs.yml` on every push to `main`. Landing page plus a Features section covering recording, the media library, the timeline, captions, AI editing and export. MIT, no tracking, no paywall — same posture as the app.
  - [ ] Custom domain.
  - [ ] Versioning — still off until v2.
  - Engineering docs stay in `technical-documentation/` on purpose: they track the code rather than the product, are link-checked by `npm run docs:check`, and aren't user-facing.

## 📬 How to influence this roadmap
- **Discord** — join the OpenScreen Discord and post in [#🗺️・roadmap](https://discord.com/channels/1489517664467681310/1493586210675884265). The fastest way to get a thumbs-up or thumbs-down on a feature.
- **GitHub** — open an issue with the `enhancement` label, or react with 👍 / 👎 on existing items.
- **PRs** — if you want to ship one of these, open a PR and link the relevant issue. We review fast and help with native-bridge / i18n questions.

Anything not on this list yet? Open an issue and tag it `roadmap` — we'll triage it into a tier within a week.

---

## Changelog
- **2026-06-24** — initial draft. Stability items pulled from open issues / PRs on getopenscreen/openscreen. AI section presented as opt-in / off by default. Whisper entry updated to reflect existing caption feature.
- **2026-06-25** — added "Site & documentation" tier: Docusaurus + GitHub Pages. Cleaned smoke-test noise from the changelog (internal CI sync validation, not user-facing).
- **2026-07-06** — added blur regions to the stability & quality tier. Confirmed upstream deprecated the feature in v1.5.0 without an explicit reason; the renderer code carried over to the fork, so the work is unblocking the export guard + adding coverage. Tracked via #76.
- **2026-07-27** — reconciled the roadmap with the code. The AI Edition tier moved from "a direction, not a sprint plan" to shipped: on-device transcription, transcript-driven editing, captions as a derived layer with translation, the chat agent, and `.openscreen` projects are all in. Provider list corrected — ChatGPT and GitHub Copilot were removed in 1.8.0 and are now blocked on the vendors' sanctioned surfaces, and MiniMax was missing. New "Rendering & platform parity" tier: preview and MP4 export share one native D3D11 compositor, and porting it off Windows is now the biggest open item; #18 moved there since it's an encoder concern. Blur (#76) marked shipped — as an annotation type, not a region kind, so the old note pointing at `src/lib/exporter/videoExporter.ts` was doubly stale (that file was deleted with the web export pipeline). Copy/paste (#24) split: the shortcuts shipped, the right-click menu didn't. Docusaurus site marked shipped.- **2026-08-01** — the platform-parity tier was the stalest thing on this page: it still described the compositor as Direct3D 11 and listed MP4 export on macOS and Linux as unstarted, while v1.8.0-rc.5 was already publishing DMGs and Linux packages built on the Metal and WGSL backends. #18 (software encoder fallback) shipped with them, as an automatically-selected CPU backend rather than an encoder flag. Two real gaps replace them: Linux export is software-encoded, and every performance number on record still comes from one passive-iGPU laptop. Also corrected the framing that produced this drift — the tier was written as "porting it off Windows is the biggest open item", which stayed true in the text long after it stopped being true in the tree.
