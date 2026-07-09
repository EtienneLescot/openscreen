---
id: captions
title: Captions & AI
sidebar_position: 6
---

# Captions & AI

## Automatic captions

OpenScreen generates captions from your recording's audio entirely on-device — nothing is uploaded, and it works offline.

From the timeline toolbar, click the captions icon to open the **Auto captions** dialog:
- **Min words per caption** and **Max words per caption** (1–12 each) control how phrases are grouped — timing is spread across the words in each phrase.
- Hit **Generate**. The first run downloads a local Whisper model (~264MB, verified by checksum); after that, transcription runs fully offline. Language is auto-detected — there's no manual language picker.

Generated captions are inserted as text annotations on the timeline, so they use the same styling controls described in [Editing & timeline](./editing-timeline.md#annotations) — edit one caption's font, size, or position, and the change propagates to the rest.

## Transcript editing

Once you've transcribed a clip, a **Transcript** tab shows the aggregated transcript across your whole timeline. It's a live text view of your recording:

- Select a word or range of words and press `Backspace`/`Delete` to mark that span as skipped — it's cut from playback and export, the same as trimming on the timeline, just driven from the text instead.
- Hover a skipped (struck-through) span to restore it.

This runs on the same local transcript as auto-captions — no upload, no cloud.

## AI editing (opt-in, bring your own key)

Beyond captions, OpenScreen has an optional chat panel that can apply structured edits to your project on your behalf — cut a span, adjust the timeline — using a language model. It's off unless you connect a provider:

1. Open **Provider Settings** and pick a provider: Anthropic (Claude), OpenAI, Google (Gemini), Mistral, OpenRouter, or MiniMax — paste an API key for any of these and you're connected.
2. Use the chat panel to describe an edit in plain language; the agent applies it as a real, undoable timeline operation (there's an Undo action right in the chat).
3. Your key is stored via your OS's secure credential store — OpenScreen's servers never see it, because it doesn't have any; requests go straight from your machine to the provider you chose.

:::note
ChatGPT and GitHub Copilot are listed as sign-in options but their OAuth/device-login flow isn't finished yet — stick to an API-key provider (Anthropic, OpenAI, Google, Mistral, OpenRouter, or MiniMax) for now.
:::

:::tip
None of this is required. Recording, editing, captions, and export all work with zero network access and no account, whether or not you ever open the chat panel.
:::
