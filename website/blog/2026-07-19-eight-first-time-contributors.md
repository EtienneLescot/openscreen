---
title: v1.7.0 was mostly written by people I'd never met
description: Eight first-time contributors shipped most of v1.7.0, including memory-safe handling of long recordings and a software H.264 fallback. Before it, v1.6.0 built the release process that made merging their work safe.
authors: [etienne]
tags: [release]
image: /img/og-image.png
---

Two releases in the first month, [v1.6.0](https://github.com/getopenscreen/openscreen/releases/tag/v1.6.0) on July 4 and [v1.7.0](https://github.com/getopenscreen/openscreen/releases/tag/v1.7.0) on July 19. The second one is the one worth writing about. Eight people who had never touched the project shipped most of it, and several of those changes fix things that had been broken since before the archive.

<!-- truncate -->

## v1.6.0, so that merging is safe

The fork inherited a codebase with no release candidate process. Merging a stranger's PR into a project with no RC step means the first person to find the regression is a user, so this came first: RC tags, a promote workflow, release notes generated from the PR history.

The Windows Graphics Capture helper, the native code that does the actual recording on Windows, got per-step stop timing and a diagnostic tool. "Recording fails on stop" is not a fixable bug report when all you know is that it failed, and it was the most common one.

The Linux HUD got its drag handle back. The overlay's pointer-events handling made the bar unmovable there, which nobody had noticed because nobody on the original team ran Linux.

Three PRs from outside landed in this one: the macOS cursor offset in single-window capture ([@giulio333](https://github.com/getopenscreen/openscreen/pull/22)), copy/paste for timeline region attributes ([@446f6e6e79](https://github.com/getopenscreen/openscreen/pull/33)), and a CI refactor ([@psychosomat](https://github.com/getopenscreen/openscreen/pull/40)).

### The release branch rule

If you maintain something with a promote step, this is the part to steal. One release branch per stable version, cut at the RC, frozen until promote. Only cherry-picked bugfixes land on it, and anything merged to `main` after the cut ships in the next cycle.

I wrote that rule after the promote workflow tagged the tip of `main` instead of the RC snapshot people had tested. The release went out containing commits nobody had signed off on, and I replayed it. The rule is in the repo docs now and every release since has followed it.

## v1.7.0

Eight first-time contributors:

- Large recordings stream instead of loading into memory. The editor and exporter used to run out of RAM on long captures, which made the app unusable for exactly the recordings people care most about ([@rainyflash](https://github.com/getopenscreen/openscreen/pull/74)).
- A software H.264 fallback for Windows machines whose hardware encoder is missing or locked, which is a large share of corporate laptops ([@My-Denia](https://github.com/getopenscreen/openscreen/pull/73)).
- The webcam recorder now starts after native macOS capture does, so the first seconds of camera footage stop vanishing ([@josiahcoad](https://github.com/getopenscreen/openscreen/pull/85)).
- A fix for the cursor drifting out of place after a crop ([@SakuraiSatoru](https://github.com/getopenscreen/openscreen/pull/65)).
- A notes window that capture ignores, so you can keep your script beside the recording without it showing up in the video ([@Itzadetunji](https://github.com/getopenscreen/openscreen/pull/43)).
- Playback speed up to 100x, for finding the one moment you want in an hour of footage ([@rainyflash](https://github.com/getopenscreen/openscreen/pull/80)).
- The Full Camera timeline effect. Press a key and the webcam PiP grows to fullscreen for a stretch, then eases back ([@rodrvc](https://github.com/getopenscreen/openscreen/pull/66)).
- A custom gradient editor for backgrounds ([@psychosomat](https://github.com/getopenscreen/openscreen/pull/81)).

The platform work in that release was mine. Preview recovery from WebGL context loss on Linux and Wayland. Vulkan off on Wayland so PipeWire capture can import DMA-BUF frames. webm duration patching rewritten so hour-long recordings stop killing the editor on load.

## Why this matters more than the feature list

An archived repo with 39k stars has a lot of people sitting on fixes they wrote for themselves and never upstreamed, because there was nobody to merge them. Reopening the repo released about a month of accumulated work in two weeks, from people who had already done it.

That is the argument for continuing an archived project rather than starting a new one. The users are already there and some of them are already contributors.

Next: v1.8.0, where an AI layer and a whole new rendering engine shipped under one version number.
