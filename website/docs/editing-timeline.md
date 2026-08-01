---
id: editing-timeline
title: Editing & timeline
sidebar_position: 6
description: "Edit in OpenScreen's timeline: zoom, trim, and speed regions, Full Camera segments, annotations, cursor styling, and the floating inspector."
keywords:
  - video timeline editor
  - zoom regions
  - speed ramping
  - annotations
  - cursor smoothing
  - multi-track editing
---

# Editing & timeline

The editor has three modes, switched from the segmented control in the top bar:

| Mode | What it's for |
|---|---|
| **Media** | Your project's clips: import, search, inspect transcripts, drag onto the timeline. See [Media library](./media-library.md). |
| **Edit** | The preview, the floating inspector, and the full timeline. This is where the project is actually edited. |
| **Rec** | Pre-flight config for a new recording — mic, camera, system audio, cursor. See [Recording](./recording.md#recording-from-the-editor-rec-mode). |

Everything below describes **Edit** mode: a resizable preview on top, a timeline underneath. Drag the handle between them to rebalance the split.

## Floating inspector

A floating icon rail sits over the preview. Six facets:

| Facet | What it controls |
|---|---|
| **Background** | Image, solid color, or gradient behind your recording — upload your own image or pick from presets. |
| **Effects** | Background blur, motion blur, shadow, corner roundness, and padding sliders. |
| **Layout** | Webcam composite: picture-in-picture, vertical stack, dual frame, or no webcam. Mirror, "shrink on zoom," camera shape (rectangle/circle/square/rounded), and size. Drag the webcam bubble directly on the canvas to reposition it. |
| **Cursor** | Only meaningful for recordings with editable cursor data (macOS/Windows). Show/hide, clip-to-canvas, a strip of cursor themes, and sliders for size, smoothing, motion blur, and click bounce. |
| **Captions** | Turn captions on, style them, and translate them — see [Captions & transcript](./captions.md). |
| **Transcript** | The aggregated transcript across every clip, editable — see [Transcript editing](./captions.md#transcript-editing). |

The **pencil** button on the same rail opens the **Edit clip** modal for the selected clip: a draggable crop rectangle with numeric X/Y/W/H inputs and aspect-ratio presets, plus the clip's in/out points. Crop is per clip, not per project.

Selecting a region on the timeline (a zoom, trim, annotation, speed, or Full Camera block) replaces the facet body with an inspector for that region, described below alongside each region type.

## Timeline toolbar

- **Auto-enhance** (wand icon) — a menu with two one-shot passes:
  - **Automatic zooms** — reads the recorded cursor movement and drops zoom regions on the moments where the cursor dwells. No network, no model.
  - **Smart zooms + cuts** — hands the job to the AI agent instead, which needs a [connected provider](./ai-editing.md).
- **Speed** (`S`) — adds a speed-change region at the playhead.
- **Comment** (`A`) — adds an annotation at the playhead.
- **Trim** (`T`) — drops a two-second cut ("trim region") at the playhead. Drag its edges to resize, like any other region.
- **Add zoom** (`Z`) — drops an animated zoom region at the playhead.
- **Auto focus** (crosshair) — toggle; when on, every zoom region follows the cursor and the per-zoom focus control locks.
- **Full Camera** (`C`) — adds a segment where the webcam takes the whole frame.
- **Aspect ratio** — the output shape for preview and export: your clips' own shapes under **Original**, plus 16:9, 9:16, 1:1, 4:3, 4:5, 16:10, and 10:16.

Drag a region's edges to resize, or drag the block to move it. Regions snap to the playhead, other region edges, and the timeline's start/end. `Ctrl/Cmd + C` / `Ctrl/Cmd + V` copies a selected region's attributes onto another region of the same kind.

`Shift` + scroll pans the timeline; `Ctrl`/`Cmd` + scroll zooms in and out. Both are shown as hints under the transport bar.

### Zoom regions

Click a zoom block to open its inspector:
- Six depth presets — 1.25× / 1.5× / 1.8× / 2.2× / 3.5× / 5×.
- **3D rotation** — None, Iso, Left, or Right.
- **Focus mode** — Manual (drag the focus marker in the preview) or Auto (follows the recorded cursor). Locked to Auto when the toolbar's Auto-focus toggle is on.
- **Focus position** — numeric X/Y percentage in manual mode.

### Trim regions

A trimmed span is cut from playback and export. The inspector is a single **Delete** action — press `Del` or use the inspector button. The same cuts can be made from the text instead, in the [transcript](./captions.md#transcript-editing).

### Speed regions

A preset dropdown (0.25× through 5×, plus 1× to return to normal) and a free numeric field that accepts anything up to 100×. Export renders the true speed either way.

### Full Camera regions

A span where the webcam fills the frame instead of sitting in its layout box — useful for a talking-head intro in the middle of a screen recording. Only meaningful when the recording has a webcam track.

### Annotations

Four types, switchable from the **Type** dropdown in the inspector. Switching type keeps the region's span and box, so a mis-pick costs one click rather than a redraw.

- **Text** — content, size, background color with an on/off toggle, text color, and an appearance animation (None / Fade / Rise / Pop / Slide Left / Typewriter / Pulse).
- **Image** — upload a JPG, PNG, GIF, or WebP.
- **Arrow** — eight directions, stroke width (1–20), and color.
- **Blur** — a privacy mask. Gaussian or Mosaic, rectangle or oval, with intensity (or mosaic block size). Drag and resize it over the preview like any other annotation.

:::note
Freehand blur shapes can no longer be drawn. Existing ones still render, but as their bounding box — deliberately over-covering rather than leaving something you marked private visible in the export. The inspector says so when it sees one.
:::

## Cursor styling

If your recording has editable cursor data (native capture on macOS/Windows), the Cursor facet lets you pick from a library of cursor themes and tune size, smoothing, motion blur, and click bounce independently of the raw capture — the underlying cursor path is smoothed deterministically, so what you see in preview matches the final export.

## Keyboard shortcuts

The gear icon in the top bar opens the shortcuts dialog, where the configurable ones can be rebound.

| Action | Default |
|---|---|
| Add Zoom | `Z` |
| Add Trim | `T` |
| Add Speed | `S` |
| Add Annotation | `A` |
| Add Full Camera | `C` |
| Delete Selected | `Ctrl/Cmd + D` |
| Play / Pause | `Space` |
| Copy region attributes | `Ctrl/Cmd + C` |
| Paste region attributes | `Ctrl/Cmd + V` |

Fixed (not reassignable):

| Action | Shortcut |
|---|---|
| Undo | `Ctrl/Cmd + Z` |
| Redo | `Ctrl/Cmd + Shift + Z` (or `+ Y`) |
| Delete Selected (alt) | `Del` / `⌫` |
| Cycle annotations forward / backward | `Tab` / `Shift + Tab` |
| Frame back / forward | `←` / `→` |
| Pan timeline | `Shift + Scroll` |
| Zoom timeline | `Ctrl + Scroll` |

## Saving your work

Edits live in a `.openscreen` project file — separate from any exported video, and fully re-editable:

- **Save Project** (`Ctrl/Cmd + S`) — saves in place, or prompts for a location the first time.
- **Load Project** (`Ctrl/Cmd + O`) — opens an existing `.openscreen` file.
- **New Project** (`Ctrl/Cmd + N`) — clears the current project.

The top bar shows a **Saved** / **Unsaved** indicator, and closing with unsaved changes prompts you to save, discard, or cancel.

When you're ready, head to [Export](./export.md).
