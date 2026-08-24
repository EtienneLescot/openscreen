---
id: export
title: Exporting video
sidebar_position: 9
sidebar_label: Export
description: "Export from OpenScreen to MP4 (720p, 1080p, or source resolution, H.264 or H.265) or animated GIF, and how the MP4 render path actually works."
keywords:
  - export MP4
  - H.264
  - H.265
  - animated GIF
  - video export
  - 1080p
---

# Export

Click **Export** in the top bar to open the export dialog.

## Formats

- **MP4** — quality **720p**, **1080p**, or **Source**; frame rate 24 / 30 / 60 fps; codec **H.264** (best compatibility) or **H.265**.
- **GIF** — frame rate 15 / 20 / 25 / 30 fps, size Medium / Large / Original, and a **Loop** toggle.

:::note
VP9 was removed. There's no hardware VP9 encoder on the GPUs the native pipeline targets, and the software fallback was far too slow to ship as an option that looks like the others.
:::

## Resolution

The dialog shows the exact pixel size each quality tier will produce, given your timeline's aspect ratio.

**Source** sizes to the *smallest* clip's true post-crop footprint, which makes it upscale-proof by construction: no clip on the timeline ever gets stretched past its real resolution. The fixed 720p and 1080p tiers target a short side regardless, so they can still upscale a small clip — the dialog badges the tier when that would happen.

## Exporting

1. Configure format and quality, then hit **Export**.
2. Pick a save location in the native file dialog.
3. The dialog reports real progress from the encoder: rendered frames out of total, plus an ETA, then a writing phase.
4. On success, **Show in folder** jumps straight to the file.

If something fails during render or write, the dialog shows the error so you can retry.

## How MP4 is rendered

MP4 export runs through the same native Rust compositor that draws the live preview — Direct3D 11 on Windows, Metal on macOS, wgpu/WGSL on Linux — one clip at a time, on a single GPU device: demux → decode → composite → encode → mux. On Windows and macOS the encoder takes the composed frame straight off the GPU, with no CPU readback in between; on Linux the frame is read back and encoded in software. The preview pauses itself for the duration so the two aren't fighting over the GPU.

Because preview and export consume the same scene description, the frame you're looking at is the frame you get — there is no separate export renderer that could drift.

:::note Platform support
MP4 and GIF export both work on Windows, macOS, and Linux. The one difference left is speed: the Linux encode is software rather than hardware today, so the same export takes longer there. See the [roadmap](https://github.com/getopenscreen/openscreen/blob/main/ROADMAP.md) for status.
:::

## Exported file vs. project file

Exporting produces a finished, flattened video (or GIF) — it isn't editable afterward. If you want to keep editing later, save a `.openscreen` **project** instead (see [Editing & timeline](./editing-timeline.md#saving-your-work)); project files keep every clip, zoom, trim, annotation, and setting intact.
