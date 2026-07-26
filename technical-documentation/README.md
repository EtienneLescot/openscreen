# Technical documentation

Reference documentation for how OpenScreen is built. It describes the system **as it is on this
branch** — not how it got here. Product direction lives in [`../ROADMAP.md`](../ROADMAP.md),
day-to-day contributor rules in [`../AGENTS.md`](../AGENTS.md) and
[`../CONTRIBUTING.md`](../CONTRIBUTING.md), and end-user documentation in
[`../website/docs/`](../website/docs/).

Organised by **type** — architecture (what the system is), engineering (how it is built and
shipped), testing (how it is verified) — and within each type, by **subsystem**.

## Architecture

Start with the [overview](architecture/overview.md): the process model, the authoring levels, and
who reads and writes the project document.

| Doc | Subsystem |
|---|---|
| [overview.md](architecture/overview.md) | The whole picture: windows, processes, data flow, subsystem map |
| [document-model.md](architecture/document-model.md) | `AxcutDocument` — the single source of truth, its schema, migrations and persistence |
| [timeline-model.md](architecture/timeline-model.md) | Time reference frames, clip-anchored modifiers, and the invariants that keep preview and render agreeing |
| [editor-shell.md](architecture/editor-shell.md) | The editor UI: surfaces, modes, facets, and how to add a region kind |
| [preview.md](architecture/preview.md) | Showing the frame at the playhead: scene description, frame delivery, playback sync |
| [native-compositor.md](architecture/native-compositor.md) | The Rust + D3D11 engine that composites and encodes, for both preview and export |
| [export-pipeline.md](architecture/export-pipeline.md) | Document to file: render plan, segment loop, audio junctions, output formats |
| [recording.md](architecture/recording.md) | Capture on Windows, macOS and Linux: the HUD, the native helpers, what lands on disk |
| [cursor.md](architecture/cursor.md) | Cursor capture, telemetry, rendering and auto-follow |
| [transcription-and-captions.md](architecture/transcription-and-captions.md) | On-device speech to text, and the caption layer derived from it |
| [ai-agent.md](architecture/ai-agent.md) | The optional agent: tool loop, checkpoints, context management |
| [llm-providers.md](architecture/llm-providers.md) | Provider registry, auth modes, credential storage |
| [native-bridge.md](architecture/native-bridge.md) | The renderer ↔ main-process contract every native capability goes through |
| [decisions.md](architecture/decisions.md) | **The decision ledger** — what is settled, what was rejected and why |

## Engineering

| Doc | Topic |
|---|---|
| [rendering-performance.md](engineering/rendering-performance.md) | The measurement record for preview fluidity and export speed |
| [build-and-packaging.md](engineering/build-and-packaging.md) | Build commands, native artifacts, per-platform packaging |
| [ci-workflows.md](engineering/ci-workflows.md) | The GitHub Actions tiers and how artifacts flow between them |
| [release-and-secrets.md](engineering/release-and-secrets.md) | Cutting and promoting a release; the secrets it needs |

## Testing

| Doc | Topic |
|---|---|
| [writing-tests.md](testing/writing-tests.md) | Unit, browser and end-to-end tests: which to write, where, how to run them |
| [manual-e2e-checklist.md](testing/manual-e2e-checklist.md) | What automated tests cannot reach — real capture, a real webcam, the tray, export |
| [native-cursor-diagnostics.md](testing/native-cursor-diagnostics.md) | Windows and macOS cursor sampler tools and how to read their reports |

## Keeping this current

Three rules, in order of how much damage breaking them does:

1. **The code is the authority.** If a doc and the code disagree, the doc is wrong. Fix it in the
   same change that made it wrong.
2. **Describe, don't narrate.** These are references, not plans or changelogs. No task tables, no
   phase numbers, no "recently fixed" — git already records history, and a doc that mixes the two
   makes a reader guess which sentences are still true.
3. **Settled questions go in [decisions.md](architecture/decisions.md).** Including the rejected
   routes, with the reason. That file is what stops the same idea being re-proposed every quarter.

`npm run docs:check` enforces the mechanical part: every required doc exists, every
relative link resolves, and no doc presents a removed component as current.
