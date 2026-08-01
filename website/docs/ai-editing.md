---
id: ai-editing
title: AI editing
sidebar_position: 8
description: "Connect your own LLM key to edit OpenScreen projects from a chat panel. Entirely optional and off by default — nothing leaves your machine until you opt in."
keywords:
  - AI video editing
  - LLM video editor
  - chat editing
  - bring your own key
  - privacy
---

# AI editing

OpenScreen ships an optional agent that edits your project from a chat panel. It is **off until you connect a provider yourself**, and it is the only part of the app that talks to a network.

:::tip
None of this is required. Recording, editing, transcription, captions, and export all work with zero network access and no account, whether or not you ever open the chat panel.
:::

## Connecting a provider

Open the chat column (the toggle at the far left of the top bar, in **Edit** mode), then **AI settings** → pick a provider and paste an API key:

| Provider | Notes |
|---|---|
| **Claude API** (Anthropic) | |
| **OpenAI API** | |
| **Gemini API** (Google) | |
| **Mistral API** | |
| **OpenRouter API** | One key, many models. |
| **MiniMax API** / **MiniMax Token Plan** | |
| **OpenAI Compatible** | Any OpenAI-shaped endpoint — you supply the base URL. |

Your key is stored encrypted through your OS's credential protection (Electron `safeStorage`); if encryption isn't available, the write fails rather than falling back to plaintext. OpenScreen's servers never see it, because there aren't any — requests go straight from your machine to the provider you picked. Provider-specific environment variables work too, if you'd rather not store a key at all.

:::note
The ChatGPT and GitHub Copilot sign-in options were **removed in 1.8.0**. They worked by shipping first-party client credentials belonging to those vendors, which isn't ours to redistribute. Use an API-key provider instead.
:::

## Using the agent

Describe the edit in plain language — "cut the dead air in the intro", "zoom in when I open the terminal". The agent works through real, undoable timeline operations, not a re-render: it can add and adjust trims, zooms, speed regions, annotations and Full Camera segments, edit clip in/out points, reorder or remove clips, and read the transcript to find what you're referring to.

The panel around it:

- **Conversations** — history, rename, delete, and start a new one. Each keeps its own agent state.
- **Model picker** — live model list from the connected provider, with a reasoning-effort control where the provider supports one.
- **Context meter** — estimated tokens used against the budget, with a **Compact** action that summarizes earlier turns instead of dropping them.
- **Rewind to this message** — rolls back the agent's edits and every follow-up turn after that point, restoring project, conversation, and agent state together.
- **+ skip** — hand the agent an explicit `startSec-endSec` range to cut, when it's easier to say than to describe.

`Ctrl/Cmd + Z` undoes an agent edit exactly like a manual one.

The **Smart zooms + cuts** entry in the timeline's auto-enhance menu is the same agent on a one-shot prompt. (The other entry, **Automatic zooms**, reads recorded cursor movement and needs no provider at all.)

## What else uses your provider

[Caption translation](./captions.md#translation) is a single text-transform call against the same model — it doesn't run the agent loop and can't touch your document. Transcription and caption rendering stay entirely on-device either way.
