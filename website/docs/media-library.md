---
id: media-library
title: Media library & clips
sidebar_position: 5
description: "Manage sources and clips in OpenScreen: import media, then trim, crop, split, and reorder clips on one timeline, and set the project output size."
keywords:
  - media library
  - video clips
  - trim video
  - crop video
  - split clips
  - timeline
---

# Media library & clips

A project isn't one recording — it's a set of sources and an ordered list of clips cut from them. **Media** mode is where you manage the sources; the clip row at the bottom of the timeline is where you arrange them.

## Media mode

Switch to **Media** in the top bar. The stage shows one card per source in the project, with a search box above them.

Select a card to open its detail panel:

- **Source Transcript** — the full text for that asset, with its status (Pending transcription / Transcribing / Generated / Failed) and the detected language.
- **Regenerate as** — re-run local Whisper for this asset, either on **Auto** detection or forced to English, French, or Spanish.

**Import media** adds a source from disk — video, audio, or images. The file dialog accepts `webm`, `mp4`, `mov`, `avi`, `mkv`, `m4v`, `wmv`, `flv`, and `ts`.

Importing a source does *not* put it on the timeline. Drag its card onto the clip row to do that.

## Clips on the timeline

The bottom row of the timeline is the clip strip. Each clip shows its own waveform.

- **Drag to reorder.** The regions on top follow their clip — a zoom you placed on a clip stays on that clip when it moves.
- **Double-click** (or the pencil on a clip) opens **Edit clip**: in/out points with a scrubbable range, and a crop rectangle with draggable handles, numeric X/Y/W/H, and ratio presets. Crop is per clip.
- **Delete clip** removes it from the timeline; the source stays in the media library.
- **Drop a source onto an existing clip** and OpenScreen asks where it goes: **Add before**, **Add after**, or **Split here and insert** — which cuts the target clip at the drop point and drops the new source in between.

Clips are always contiguous — no gaps, no overlaps. Removing or reordering one closes the ruler up behind it.

## Output size

The aspect-ratio picker in the timeline toolbar sets the shape of the frame; **Original** lists the actual shapes of the clips in your project. Every clip gets fitted into that frame, so mixing a 16:9 screen recording with a 9:16 phone capture in one timeline works — see [Export](./export.md#resolution) for what resolution comes out.

## Starting a project

**New project** asks for a name and a starting point:

- **Screen recording** — jumps straight into [Rec mode](./recording.md#recording-from-the-editor-rec-mode).
- **Import media** — opens the file picker.

**Open project** lists your recent `.openscreen` files with a search box, keyboard navigation, and a **Browse files…** escape hatch. You can also drop a `.openscreen` file onto the empty editor.
