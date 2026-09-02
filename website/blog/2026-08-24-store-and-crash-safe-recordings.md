---
title: Recordings that survive a crash, and an app you can actually install
description: v1.10.0 put OpenScreen in the Microsoft Store, on Fedora and on ARM64, and made capture write fragmented MP4 so a helper that dies mid-recording leaves a playable file.
authors: [etienne]
tags: [release, distribution]
image: /img/og-image.png
---

Two things in this stretch matter more than the version numbers. Capture now writes fragmented MP4, so a recorder that dies halfway through leaves you a playable file instead of a corrupt one. And the app finally installs the way people on each platform expect it to.

That is [v1.10.0](https://github.com/getopenscreen/openscreen/releases/tag/v1.10.0), August 24. Before it, v1.9.0 through v1.9.6 in under two weeks.

<!-- truncate -->

## Losing a recording used to be possible

A screen recorder that can lose the take is not a screen recorder. The old capture path wrote a single MP4 whose index is finalised at the end, so a helper crash, a forced quit or a dead battery left a file no player could open. The recording had happened. It was just unreadable.

Capture writes fragmented MP4 now. The file is valid at every fragment boundary, so whatever was captured before the process died is still there and still plays.

The same release stopped two other ways to lose work. The native webcam stream writes to disk while it records, so killing a recording can't take the camera track with it, and the Windows capture helper stopped hanging on stop, which used to require killing the process and losing the file.

## Where you can install it now

Most of v1.10.0 was packaging. Distribution is where free desktop software quietly fails: the build works, and nobody can get it.

**Windows.** The appx goes to the Microsoft Store from the release build, with branded tiles. That is the route I'd recommend on Windows now. winget stopped skipping silently. There is no Visual C++ Redistributable dependency any more, and the OpenMP runtime the transcription backends actually import is bundled, so transcription works on a clean machine.

**Linux.** Fedora RPM ([@Mundo-Dev0ps](https://github.com/getopenscreen/openscreen/pull/101)), ARM64 builds ([@zebster-cmd](https://github.com/getopenscreen/openscreen/pull/293)), and DMA-BUF negotiation so capture works on niri and other wlroots compositors, which had no working screen recorder from this project at all. Packages now respect the glibc floor of the distros they claim to target, declared and proven on a clean machine, and AppStream metadata is in place for Flathub.

**macOS.** The Homebrew cask job runs again instead of sitting dormant.

Capture is also DPI-aware and stops guessing which monitor you meant, and there is a GPU DXGI encode path behind a flag, opt-in until it earns the default.

## v1.9.0, three weeks earlier

v1.9.0 shipped August 5, the day after v1.8.0 was promoted. That is a backed-up queue rather than speed: the 1.8.0 RC window ran through nine candidates while `main` kept moving. The frozen release branch is the only reason the two didn't tangle.

Two features in it:

- Teleprompter mode in the notes window. Your script scrolls next to the capture, mirrored so it reads right in a webcam ([@My-Denia](https://github.com/getopenscreen/openscreen/pull/152)).
- A headless CLI with `record`, `export` and `info`, driving the same engine the app does, which makes OpenScreen usable from a script or on a server ([@PeterTakahashi](https://github.com/getopenscreen/openscreen/pull/176)).

It also removed a PID-file instance lock that could permanently brick startup, notarized macOS RCs like stable builds, and made the AppX package declare all 13 locales instead of one.

## What changed in the patch releases

v1.9.1, v1.9.2, v1.9.5 and v1.9.6 went out over ten days. 1.9.3 and 1.9.4 never left RC and their fixes rolled forward.

Roundness, shadow and motion blur are on by default now, which is the look most people were assembling by hand on every project. The Windows cursor sampler became DPI-aware. The chat agent learned `addTrims` and `addZooms`, so asking it for a cut stopped costing a round trip through a slower path.

Every release's regression pass is written up in the repo's testing docs, including the ones that caught a candidate breaking something. This site was rebuilt in the same window, and gained its light theme.

## On `main` right now

Webcam background effects have landed on all three compositor backends. Blur or replace what is behind you, including an AI cutout that doesn't need a green screen. The transcription helper reports its real timing and which compute backend it used, so "how long will this take" has an answer instead of a progress bar with no scale.

Still open: hardware encode on Linux, and measurements on discrete GPUs and QSV. It is still pre-1.x, so rough edges are expected and bug reports are welcome.

Three months, ten releases. [Discord](https://getopenscreen.com/discord) is open if you want to argue with any of it.
