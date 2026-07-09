---
id: export
title: Export
sidebar_position: 7
---

# Export

Click **Export** in the Studio's top bar to open the export dialog.

## Formats

- **MP4** — pick a quality: **720p** (smaller file), **1080p** (recommended), or **Source** (matches your recording's resolution). Frame rate: 24 / 30 / 60 fps. Codec: H.264 (best compatibility), H.265, or VP9.
- **GIF** — pick a frame rate (15 / 20 / 25 / 30 fps) and a size (Medium / Large / Original), with a **Loop** toggle.

## Exporting

1. Configure your format and quality, then hit **Export**.
2. Pick a save location in the native file dialog.
3. The dialog walks through rendering, then writing to disk, with a progress indicator.
4. On success, a **Show in folder** action jumps straight to the file.

If something fails during render or write, the dialog shows the error message so you can retry.

## Exported file vs. project file

Exporting produces a finished, flattened video (or GIF) — it isn't editable afterward. If you want to keep editing later, save a `.openscreen` **project** instead (see [Editing & timeline](./editing-timeline.md#saving-your-work)); project files keep every zoom, skip, annotation, and setting intact.
