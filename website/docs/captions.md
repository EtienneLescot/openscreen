---
id: captions
title: Captions & transcript
sidebar_position: 7
description: "Transcribe on-device with Whisper, burn in styled captions, translate them into 15 languages, and edit a recording by deleting words from the text."
keywords:
  - automatic captions
  - subtitles
  - Whisper transcription
  - offline transcription
  - caption translation
  - transcript editing
---

# Captions & transcript

OpenScreen transcribes your recording's audio **entirely on-device** — nothing is uploaded, and it works offline. That one transcript is then the source for two things: the captions burned into your video, and a text view you can edit your recording from.

## Transcribing

Every clip carries its own transcript. Run it either way:

- From the **Media** stage — select an asset card and hit **Regenerate**. This is also where you force a language (Auto, English, French, Spanish) instead of letting Whisper detect it, and where per-asset status lives (Pending, Transcribing, Generated, Failed).
- From the **Captions** facet in the editor's inspector — **Transcribe video** runs the same pipeline on the current media.

The first run downloads a local Whisper model (~264 MB, SHA-256 verified, written atomically so a half-download can never be picked up). After that, transcription is fully offline. It runs natively — whisper.cpp with a GPU backend picked at runtime: Metal on Apple Silicon, Vulkan on Windows and Linux, CPU everywhere else.

Word timings come from Whisper's own DTW token timestamps, then get re-anchored on the audio itself — every boundary is pulled back to the quietest moment just before it. This is what makes a transcript-driven cut land where the word actually starts instead of a syllable late.

## Captions

Captions are a **live view of the transcript**, not generated text you then maintain. Change the transcript, change the caption settings, or move clips on the timeline, and the cues follow on the next frame — there's no regeneration step and no stale copy to reconcile.

Open the **Captions** facet in the inspector:

| Section | Controls |
|---|---|
| **Show captions** | Master on/off for both preview and export. |
| **Language** | *Original (transcript)*, or any translation layer you've generated. |
| **Text** | Font, size, bold, text color. |
| **Background** | On/off, color, and opacity for the plate behind the text. |
| **Position** | Top / Middle / Bottom, left / center / right alignment, a fine vertical offset, and band width as a % of the frame. |
| **Line length** | Min and max words per line (1–12). Lines are packed inside that range. |

Size is expressed in pixels at a 1080-high frame and scales with the real output, so captions look the same at 720p, 1080p, or source. Preview and export share the same layout code — what you see is what gets burned in.

### Translation

Pick a target language and hit **Translate**. Fifteen targets ship in the dropdown: English, French, Spanish, German, Italian, Portuguese, Dutch, Polish, Turkish, Russian, Arabic, Hindi, Japanese, Korean, and Chinese.

Translation goes through the LLM provider you've connected (see [AI editing](./ai-editing.md)) — it's the one caption feature that needs a network. It's stored **beside** the transcript, never in it: the original text and its timings stay untouched, you can switch back to *Original* at any time, and deleting a translation leaves the recording exactly as it was. Re-running after adding footage only costs the new material, and anything the model doesn't return falls back to the original words rather than being invented.

:::note
Projects made with the older "generate captions" flow carry caption text as real annotations, which would draw on top of the live layer. The Captions pane detects them and offers to remove them — it asks first, since it deletes data.
:::

## Transcript editing

The **Transcript** facet shows the aggregated transcript across every clip on the timeline. It's a live text view of your recording:

- Select a word or a range of words and press `Backspace`/`Delete` to mark that span as skipped — it's cut from playback and export, exactly like a trim region on the timeline, just driven from the text instead.
- Skipped spans show struck through in red. Hover one to restore it.
- Silences are marked inline and can be trimmed or restored the same way.

No upload, no cloud — this runs on the transcript already sitting in your project.
