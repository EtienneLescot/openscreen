---
id: editing-timeline
title: Editing & timeline
sidebar_position: 5
---

# Editing & timeline

The Studio opens with a resizable preview on top and a timeline underneath. Drag the handle between them to rebalance the split.

## Preview and settings rail

An icon strip on the right switches between panels:

| Panel | What it controls |
|---|---|
| **Background** | Image, solid color, or gradient behind your recording — upload your own image or pick from presets. |
| **Effects** | Background blur toggle, motion blur, shadow, corner roundness, and padding sliders. |
| **Layout** | Webcam composite: picture-in-picture, vertical stack, dual-frame, or no webcam. Mirror, "shrink on zoom," camera shape (rectangle/circle/square/rounded), and size (10–50%). Only shown when a webcam track exists. Drag the webcam bubble directly on the canvas to reposition it. |
| **Cursor** | Only shown for recordings with editable cursor data (macOS/Windows). Show/hide, clip-to-canvas, a strip of cursor themes, and sliders for size, smoothing, motion blur, and click bounce. |
| **Crop** | Opens a modal with a draggable crop rectangle, numeric X/Y/W/H inputs, and aspect-ratio presets with a lock toggle. |

Separately, a **Transcript** tab shows the aggregated transcript once you've run captions — see [Captions & AI](./captions.md).

Selecting a region on the timeline (a zoom, skip, annotation, or speed block) temporarily replaces the rail with a region-specific inspector, described below alongside each region type.

## Timeline toolbar

- **Add zoom** (`Z`) — drops an animated zoom region at the playhead.
- **Auto focus** — toggle; when on, every zoom region follows the cursor and per-zoom focus controls lock.
- **Magic** (wand icon) — one-shot: scans the recording for sustained speech and proposes zoom regions automatically. Run it, then adjust or delete the suggestions it adds.
- **Trim** (scissors icon, `T`) — arms the cut tool; the next click on the timeline drops a one-second cut ("skip region") at that point. Drag its edges to resize, like any other region.
- **Annotation** (`A`) — adds a text, image, or arrow overlay at the playhead.
- **Speed** (`S`) — adds a speed-change region at the playhead.
- **Captions** — opens the [auto-captions dialog](./captions.md#automatic-captions).

Drag a region's edges to resize (there's an 8px grab handle on each side), or drag the block to move it. Regions snap to the playhead, keyframes, other region edges, and the timeline's start/end. A copy/paste shortcut duplicates a selected region's attributes onto another region of the same type.

Scroll to pan the timeline; `Ctrl`/`Cmd` + scroll to zoom in and out.

### Zoom regions

Click a zoom block to open its inspector:
- Six depth presets (1.25× / 1.5× / 1.8× / 2.2× / 3.5× / 5×) or a custom slider.
- **Focus mode** — Manual (drag the focus marker in the preview) or Auto (follows the cursor), when the recording has cursor telemetry. Locked to Auto when the global "Auto focus" toggle is on.
- **Focus position** — numeric X/Y percentage in manual mode.
- 3D rotation presets.

### Skip regions ("Trim")

A skipped span is cut from playback and export. The inspector is a single **Delete** action — press `Del` or use the inspector button.

### Speed regions

Presets from 0.25× to 5×, or type a custom value up to 16×. The inspector shows the current speed as a header chip.

### Annotations

Three types, switchable via tabs in the inspector:

- **Text** — content textarea, a font picker (24 built-in families, plus custom Google Fonts via `@import` URL), font size (12–128px), text animation (Fade / Rise / Pop / Slide / Typewriter / Pulse / None), bold/italic/underline, alignment, text and background color.
- **Image** — upload a JPG, PNG, GIF, or WebP.
- **Arrow** — eight directions, stroke width, and color.

Every annotation can be duplicated or deleted from the inspector footer. Auto-generated captions are also inserted as annotations — see [Captions & AI](./captions.md).

## Cursor styling

If your recording has editable cursor data (native capture on macOS/Windows), the Cursor panel lets you pick from a library of cursor themes and tune size, smoothing, motion blur, and click-bounce independently of the raw capture — the underlying cursor path is smoothed deterministically, so what you see in preview matches the final export.

## Keyboard shortcuts

Most shortcuts are configurable from the shortcuts dialog (opened from the toolbar's `?` icon):

| Action | Default |
|---|---|
| Add Zoom | `Z` |
| Trim (arm cut tool) | `T` |
| Add Speed | `S` |
| Add Annotation | `A` |
| Add Keyframe | `F` |
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
| Pan timeline | `Shift + Ctrl + Scroll` |
| Zoom timeline | `Ctrl + Scroll` |

## Saving your work

Edits live in a `.openscreen` project file — separate from any exported video, and fully re-editable:

- **Save Project** (`Ctrl/Cmd + S`) — saves in place, or prompts for a location the first time.
- **Save Project As** (`Ctrl/Cmd + Shift + S`) — always prompts for a new location.
- **Load Project** (`Ctrl/Cmd + O`) — opens an existing `.openscreen` file.
- **New Project** (`Ctrl/Cmd + N`) — clears the current project.

Closing with unsaved changes prompts you to save, discard, or cancel.

When you're ready, head to [Export](./export.md).
