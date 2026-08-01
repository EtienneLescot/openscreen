---
id: intro
title: Introduction
sidebar_position: 1
description: "OpenScreen is a free, open-source screen recorder and video editor for Windows, macOS, and Linux. Native capture, GPU compositing, MIT licensed."
keywords:
  - screen recorder
  - open source screen recorder
  - free screen recorder
  - video editor
  - Windows
  - macOS
  - Linux
---

# Welcome to OpenScreen

OpenScreen is a **free, open-source screen recorder and editor**. It uses native capture APIs (ScreenCaptureKit on macOS, Windows Graphics Capture on Windows) for low-overhead recording, and composites both the live preview and the final export on the GPU through a native Rust + Direct3D 11 renderer — one path, so what you see in the editor is what comes out of the export.

:::warning
OpenScreen is **not production-grade**. The project is in active development and rough edges are expected.
:::

## What you can do

- [Record](./recording.md) a specific window or your whole screen, with system audio, microphone, and webcam — from a floating HUD or from the editor itself.
- Build a project from several sources: [import, trim, crop, reorder, and split clips](./media-library.md) on one timeline.
- [Edit](./editing-timeline.md) with zooms, trims, per-region speed, Full Camera segments, text/image/arrow/blur annotations, cursor themes, webcam layouts, and background/effects.
- Transcribe on-device with Whisper, then [burn in captions](./captions.md) — restyled live, translatable into 15 languages — or cut your recording by deleting words from the transcript.
- Optionally connect your own LLM key to [edit by chat](./ai-editing.md) — off by default, never required.
- [Export](./export.md) to MP4 (720p/1080p/source, H.264 or H.265) or animated GIF.

:::note
Recording, editing, transcription, captions, and export all work fully offline with no account. AI chat editing and caption translation are the only features that talk to a network — and only once you connect a provider yourself.
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