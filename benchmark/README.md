# Export benchmark

How long does it take to turn a 60-second screen recording into a finished 1080p60 MP4, in
OpenScreen and in the apps it competes with — measured the same way, on the same clip, with the
same edit applied, and verified frame by frame.

This directory is the whole apparatus: it generates the source clip, installs the competitors,
translates one scenario into each app's own controls, drives the export, times it, checks that
what came out is what was asked for, and writes the report. It is meant to be started once and
left alone.

```bash
node benchmark/bench.mjs doctor        # is this machine fit to measure?
node benchmark/bench.mjs preflight     # the one interactive gate — grant everything here
node benchmark/bench.mjs install       # unattended
node benchmark/bench.mjs calibrate     # once per machine
node benchmark/bench.mjs run           # walk away
node benchmark/bench.mjs report
```

Driving it from a phone or another machine: [REMOTE.md](./REMOTE.md).

---

## What is being measured

**The clock starts** the instant the export is committed — the click on *Export*, or a CLI's
first progress event — and **stops when the last byte lands in the output file**. Launching the
app, loading the project and setting presets happen before the clock starts, for every app
alike, and are reported separately as `prepareMs` and `launchToCommitMs`.

Two apps in this set (Camtasia, Kap) publish their own completion signal. Where one exists the
harness takes whichever is *earlier* — the app's or the filesystem's — so an app can shorten its
own measurement but never lengthen it.

**Every output is then checked twice.** First against the target's metadata: resolution, frame
rate, codec, duration. Then against its own pixels, because metadata cannot tell you whether the
app actually did the work:

| Check | How | Why it exists |
|---|---|---|
| Background applied | the frame's corners must be light where the recording is dark | an app that skipped the wallpaper composites far less |
| Padding | bounding box of the dark recording against the light wallpaper | apps' padding controls are on different scales; this measures the real inset |
| Corner radius | the box's corner shows wallpaper while its top edge shows content | separates a rounded rect from a plain one |
| Zooms | frame-to-frame activity must spike inside every zoom window | an ignored zoom list is invisible in metadata |
| Rendered cursor | motion energy at the telemetry's position, against controls on the same scrolling material | an app can accept a cursor track and draw nothing — Cap does |
| Webcam inset | skin-tone fraction in the expected corner | nothing else in the composition is near that colour |
| Motion blur | *not asserted* | every threshold tried passed some correct renders and failed others; reported as configured, never as verified |

**The verifier overrides the driver.** A driver reports what it configured; only the pixels say
what happened. Cap accepts a cursor track, reports `cursor.hide: false`, and renders no pointer
at all — that counted as full fidelity until the check existed, and is now `0.9` with `cursor`
listed as contradicted.

Both new detectors were wrong on their first version, and were caught the same way: by running
them against Kap and the ffmpeg floor, which draw neither a cursor nor a camera. Both "passed".
The cursor check had been comparing the pointer's window against the frame's static corners —
really asking "is this region busier than the edges" — and the webcam threshold sat below the
fixture's own warm syntax colours. Thresholds are now calibrated against measured positives and
negatives, and every raw ratio is recorded per run so the margin is auditable rather than
implied.

A run that fails verification is recorded as a failure, never as a fast time.

**Fidelity** records how much of the scenario each app could express. A row marked `partial` did
less work; its number is a reference, not a ranking. Kap, which has no background, padding,
corner-radius, shadow or zoom features at all, is always partial — it is in the set as a
real-app floor, not as a peer.

## The source clip

Not shipped — **generated**, from a spec plus a seed, so that two machines can prove they
measured the same workload by comparing one hash:

```
1920×1080, 60 fps, 60 s, 3600 frames, H.264 High + AAC 48 kHz
sha256 recorded in every results file
```

It is built to look like a screen recording rather than a test pattern, because that is what
changes an encoder's job: a dark editor with syntax-coloured "code", a scrolling viewport, a
blinking caret, a selection band and a moving cursor — large static regions with sharp edges and
localized motion. `benchmark/lib/fixture.mjs` composes it from ffmpeg primitives; nothing is
random at run time.

Why 60 fps and not 30: OpenScreen's MP4 export path is fixed at 60 (`MP4_EXPORT_FPS`,
`src/cli/CliExportRunner.tsx`), and every other app in the set can be told to emit 60. It is the
only frame rate on which "force identical output" is actually achievable.

## The scenario

One definition, in `benchmark/scenarios/index.mjs`, translated by each driver into its own app's
vocabulary:

- **wallpaper** background — an image the compositor samples per pixel, not a colour it clears once
- padding: 5 % of the frame's short side, corner radius 40 px, drop shadow
- three zooms — 6–12 s at 1.8×, 22–29 s at 2.2×, 41–48 s at 1.6×
- **motion blur** on the composited frame
- **a rendered cursor** — themed sprite, smoothing, its own motion blur, click effects
- **a webcam inset** — bottom-right, rounded, shadowed, at 25 % of the frame
- output: 1920×1080, 60 fps, H.264, MP4

The first version of this scenario had only the first two lines, and that was a mistake worth
recording: a screen clip on a flat colour measures decoding and encoding, not what a demo export
costs. The cursor and the camera are a large share of the work, and neither was running.

**The cursor is data, not pixels.** Every app here hides the system pointer while recording and
re-draws it at export time from a telemetry sidecar. The fixture used to paint a fake cursor
into the video, which exercised none of that and would have double-drawn the moment an app
rendered its own. The trajectory is now generated — eased glides between dwell points with
clicks at the pauses, the shape smoothing and dwell-based auto-zoom actually react to — written
in each app's own format, and the screen clip is left clean.

The wallpaper and the webcam come from the same seed as the screen recording, so the whole
bundle reproduces on another machine and can be checked by hash.

### Translating the scenario — and why calibration exists

No two of these apps put their padding control on the same scale. Asked for "5", Cap produced a
1.85 % inset and OpenScreen a 10 % one — a 44 % difference in how many source pixels each was
sampling per frame. That is a confound, not a result.

`bench.mjs calibrate` fixes it: for each app it renders a short clip at two padding values,
measures the inset from the output pixels, solves for the value that hits the scenario's target,
and writes the answer to `benchmark/calibration.json`. On this machine:

| App | control value | measured inset | content box |
|---|---|---|---|
| OpenScreen | `padding: 25` | 5.00 % | 1728×972 |
| Cap | `padding: 13.56` | 4.81 % | 1734×976 |

Run it once per machine, and again after any app updates. `run` reads the file automatically;
without it, each driver falls back to its documented default and the report shows the inset it
actually achieved.

## Automating apps that have no CLI

Only two apps in this set can be scripted the ordinary way. What the others expose was
established by inspection, not assumption:

| Driver | CLI | AppleScript dictionary | Accessibility tree | Screenshotable | Driven by |
|---|---|---|---|---|---|
| `openscreen-cli` | **yes** (`openscreen export`) | no | — | — | `cli` |
| `openscreen-gui` | — | no | **no** (Electron) | yes | `cdp+menu` |
| `cap` | **yes** (`cap-cli export`) | no | — | — | `cli` |
| `camtasia` | no | **yes** (import, `isExporting`) | yes | yes | `applescript+ax` |
| `kap` | no | no | **no** (empty window) | yes | `cdp` |
| `screen-studio` | no | no | **no** | **no** — see below | `cdp+menu` |
| `focusee` | no | no | yes | yes | `ax+menu` |

OpenScreen appears twice on purpose. The CLI leg measures the render engine with no interface in
the way — the right number to set beside Cap's CLI, and the wrong one to set beside an app that
can only be clicked. The GUI leg carries the editor's own overhead, because the subject of a
benchmark should not be the only entrant excused from it.

The ladder each GUI driver climbs, best rung first: a scripting dictionary → a System Events
menu item by name → a documented keyboard shortcut → an accessibility control by name → the
renderer's own DOM over CDP → pixel coordinates. Every driver records which rung it used, in the
`automation` column of the report, because that is what tells a reader how well a given row will
reproduce on somebody else's machine. Pixel coordinates are the only rung that does not survive a
different display, and no driver here needs them.

**Screen Studio cannot be screenshotted at all.** It marks its editor window
`kCGWindowSharingNone`, so macOS excludes it from every capture API — the window is plainly
visible to the person sitting there and invisible to `screencapture`, ScreenCaptureKit and any
agent driving pixels. It publishes no accessibility tree either. Launching it with
`--remote-debugging-port` is what makes it drivable, and that is a *more* reproducible
interaction than clicking pixels: elements are found by their visible text, which survives a
moved window, a different display and a resized UI. The flag opens an inspector and nothing
else; the renderer and the export pipeline are the shipping ones.

`node benchmark/bench.mjs discover <app>` dumps an installed app's menus and accessibility tree.
That is how a driver gets written, and how it gets repaired when a new version renames something.

## What is in the set, and what it costs to get

| App | Licence for exporting | Install |
|---|---|---|
| OpenScreen | MIT, free, no watermark | GitHub release |
| Cap | AGPL-3.0, free; sign-in not needed for a local export | direct DMG |
| Camtasia | 30-day trial, watermarked output | direct DMG |
| Kap | MIT, free | GitHub release |
| Screen Studio | **licence required to export at all** — no trial export | direct DMG |
| FocuSee | trial, watermarked | vendor downloader stub |

`screen-studio` and `focusee` are **off by default** — on a machine without a Screen Studio
licence, and against FocuSee 2.4.1, they can only ever record a failure. Enable either
explicitly with `--apps`.

A watermark does not change render time, so a trial build is a valid measurement. A licence
*wall* is not — see [Known blockers](#known-blockers).

## Reproducing on another machine

1. `node benchmark/bench.mjs doctor` — refuses to proceed quietly on battery, in Low Power Mode,
   under thermal throttling, or with less than 20 GiB free. All four move export times.
2. `node benchmark/bench.mjs preflight --launch` — prints the whole download list with sizes and
   licence terms, provokes every macOS permission prompt the run would otherwise hit mid-flight,
   and opens each GUI app once so its first-launch dialogs can be cleared. **This is the only
   step that needs a human.**
3. `node benchmark/bench.mjs install`
4. `node benchmark/bench.mjs calibrate`
5. `node benchmark/bench.mjs run --reps 3`

Comparing two machines: the results file carries the source clip's sha256, every app's version,
the calibration used, the machine's chip/cores/RAM/OS build, and the power and thermal state at
each repetition. Two runs are comparable when the fixture hashes and the app versions match.

### ffmpeg

Used to build the fixture and to verify outputs — it is measuring instrumentation, not part of
any app's export path. Resolution order: `OSBENCH_FFMPEG`/`OSBENCH_FFPROBE`, then `ffmpeg` on
`PATH`, then the repo's LGPL tree under `crates/thirdparty/ffmpeg-*`. That tree is gitignored, so
it exists only in the checkout that built it; the harness finds it through
`git rev-parse --git-common-dir` and wraps it in a small script that re-exports
`DYLD_LIBRARY_PATH` inside its own process, because macOS strips `DYLD_*` across any
SIP-protected exec and the inherited variable never survives.

The LGPL build has no libx264 and no drawtext. The fixture is encoded with
`h264_videotoolbox` and drawn with `drawbox`; neither `-crf` nor text overlays are available.

### Background load, and the one that matters most

The precondition that never announces itself. Nothing throttles and nothing warns — every export
is simply slower. `doctor` refuses to call a machine ready above 60% foreign CPU, and the figure
is sampled during every export and reported per row as **Bg load**.

**Do not run this over a remote-desktop session.** That is the single largest source of error
found while building this, and it is not a CPU problem. Parsec, Screen Sharing and ARD all
encode the screen continuously through `VTEncoderXPCService` — *the same hardware H.264 encoder
every app in this benchmark uses for its export*. The contention is for the media engine, which
no CPU measurement sees:

| | quiet machine | with a remote session live |
|---|---|---|
| ffmpeg floor | 17.7 s | 23.7 s (+34%) |
| Cap | 19.6 s | 43.8 s (+123%) |

Same machine, same clip, same settings, same padding — the padding calibration and the
background colour were both ruled out by A/B (42.6 s vs 42.5 s, and 42.4 s with the original
colour). Apps are affected unequally because they lean on the encoder differently, so the load
does not cancel out and the *ranking* can move, not just the absolute times.

Within a single run the numbers are still sound, and the **closing control** is what proves it:
the floor workload is measured again after all the apps, and the report prints the ratio. In the
committed run it came back at 23.69 s against an opening 23.68 s — no drift, so every app in
that run met identical conditions. Comparing across runs on different machines requires the same
to be true of both.

### Repetitions and guards### Repetitions and guards

Three scoring runs after one discarded warm-up, 45 s of cooldown between them. The warm-up is
kept in the data but excluded from the statistics — first runs pay for cold caches and
uncompiled shaders. The headline figure is the **median** with a median absolute deviation;
with n=3 a standard deviation is mostly noise. Preconditions are re-checked before every
repetition and recorded per run, so a throttled run is visible rather than averaged in.

## Reading the report

`results/<runId>/` holds `results.json` (everything), `report.md`, `report.html`,
`events.ndjson` (append-only) and `status.json` (atomically rewritten, safe to poll).

- **Export (median)** — commit → last byte.
- **×realtime** — output duration ÷ export time. Above 1 is faster than playback.
- **vs floor** — multiples of `ffmpeg (re-encode floor)`, a plain transcode with no compositing.
  It separates "this encoder is slow on this machine" from "this app's pipeline is slow".
- **Fidelity** — `full`, or `partial` with the missing features named.
- **Driven by** — the automation rung.

## Known blockers

Recorded here rather than quietly dropped, because "not measured" and "slow" are very different
findings.

- **Screen Studio 3.7.5** gates export behind account activation. There is no trial export and no
  watermark path — clicking *Export* opens an activation wall. The driver is complete and works;
  supply a licence, activate once during preflight, and `--apps screen-studio` produces a number.
- **FocuSee 2.4.1** (direct download, macOS 26.5) rejects every MP4 it is given — including a
  real 2560×1440 H.264 recording — with *"The source file is damaged and cannot be opened."* It is
  not sandboxed, so this is not a file-access grant. Both its own import panel and `open -a` fail.
  Its driver is written against the AX tree it does expose; it will start working if a later
  build fixes the import.

## Layout

```
bench.mjs              entrypoint
apps.mjs               registry: what is in the set, where it comes from, what it costs
scenarios/index.mjs    the scenario and the pinned output target
lib/env.mjs            machine fingerprint, power/thermal state, ffmpeg resolution
lib/fixture.mjs        deterministic source generation + ffprobe
lib/measure.mjs        stopwatch, process sampling, output verification
lib/visualCheck.mjs    pixel verification of the effects
lib/calibrate.mjs      solving each app's padding control
lib/runner.mjs         the shared clock every driver is timed by
lib/install.mjs        unattended DMG installation
lib/permissions.mjs    provoking every macOS prompt up front
lib/uiScript.mjs       AppleScript / System Events / accessibility
lib/cdp.mjs            Chrome DevTools Protocol, for the Electron apps
lib/report.mjs         markdown + HTML
lib/state.mjs          append-only event log and pollable status
drivers/               one per app — see drivers/README.md for the contract
```
