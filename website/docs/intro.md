---
id: intro
title: Introduction
sidebar_position: 1
---

# Welcome to OpenScreen

OpenScreen is a **free, open-source screen recorder and editor** built on Electron, React, and Pixi.js. It uses native capture APIs (ScreenCaptureKit on macOS, Windows Graphics Capture on Windows) for low-overhead recording, and ships with a real multi-track editor.

:::warning
OpenScreen is **not production-grade**. The project is in active development and rough edges are expected.
:::

## What you can do

- [Record](./recording.md) a specific window or your whole screen, with system audio and microphone.
- [Edit](./editing-timeline.md) on a timeline: zooms, trim/skip regions, per-region speed, text/image/arrow annotations, cursor themes, webcam layouts, background/effects.
- Generate [automatic captions](./captions.md) on-device with Whisper, and edit your recording by deleting words from the transcript.
- Optionally connect your own LLM key to edit by chat — [off by default](./captions.md#ai-editing-opt-in-bring-your-own-key), never required.
- [Export](./export.md) to MP4 (720p/1080p/source) or animated GIF.

:::note
Recording, editing, captions, and export all work fully offline with no account. AI chat editing is the one opt-in feature that talks to a network — and only once you connect a provider yourself.
:::

## Project facts

| | |
|---|---|
| **License** | MIT — free forever |
| **Platforms** | Windows, macOS, Linux ([see the roadmap](https://github.com/getopenscreen/openscreen/blob/main/ROADMAP.md) for packaging status) |
| **Repo** | [github.com/getopenscreen/openscreen](https://github.com/getopenscreen/openscreen) |

## Status of this site

Everything under **Features** in the sidebar documents what's actually shipped in the app today, not the roadmap. The deeper internal specs this site is built from — architecture notes, engineering docs, test plans — still live in the repo and aren't migrated here yet:

- [`README.md`](https://github.com/getopenscreen/openscreen/blob/main/README.md)
- [`CONTRIBUTING.md`](https://github.com/getopenscreen/openscreen/blob/main/CONTRIBUTING.md)
- [`AGENTS.md`](https://github.com/getopenscreen/openscreen/blob/main/AGENTS.md)
- [`docs/`](https://github.com/getopenscreen/openscreen/tree/main/docs)