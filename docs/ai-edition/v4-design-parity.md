# OpenScreen Editor v4 — design parity & implementation notes

Implementation of the **OpenScreen Editor v4** design
(`claude.ai/design` project `54649d16-a5bd-4352-bed6-a62d4c2dff2e`,
`OpenScreen Editor v4 - standalone.html`), started from
`feat/native-stt-whispercpp`.

## How the design was imported

The design lives in a claude.ai/design **design-system** project, read
through the design MCP (`DesignSync`, authenticated via `/design-login` to
`https://api.anthropic.com/v1/design/mcp`). Method calls used:

- `list_files` on project `54649d16…` — full file inventory.
- `get_file` on the v4 design sources.

**On `OpenScreen Editor v4 - standalone.html` specifically:** that file is a
self-extracting gzip **bundle** (an unpacker script + a `__bundler/manifest`
of base64/gzip assets + a `__bundler/template` of the page markup). Retrieved
via `get_file`, it comes back **exactly 262 144 bytes = 256 KiB** — the tool's
hard response cap — and is truncated there: the manifest (253 KB, images only —
the C2PA-signed logo PNG + SVGs) fits, but the `__bundler/template` markup and
closing tags sit past the cap and are unreachable. `get_file` has no
offset/paging parameter, so the *full* bundle cannot be pulled through the MCP.

The bundle is a build artifact **generated from** the project's editable
ground-truth source, which was retrieved **complete** and audited in full:

- `OpenScreen Editor v4.dc.html` — 134 799 bytes, ends in `</html>`. The
  `<x-dc>` template + the `DCLogic` controller (`state`, `renderVals()`),
  covering the `stageMode` media/preview/rec branches, the 8 inspector facets,
  every slider/toggle, the timeline lanes/clips/navigator logic, and the
  light+dark token maps.
- `ui_kits/editor/index.html` — the React recreation of the same editor.
- `tokens/*.css` — the color/type/spacing/radii/elevation tokens.

The standalone renders exactly this design; the truncated tail contains no
design information not present in the fully-retrieved `.dc.html`.

## Design → component map

| Design element | Implementation |
|---|---|
| App grid, rows `58px 1fr {timeline}` per mode | `NewEditorShell.tsx` + `v4/EditorShellV4.module.css` |
| Top bar + **Media / Edit / Rec** switch | `v4/EditorTopBar.tsx` |
| Agent panel (392px, Edit only) | reuses `LeftPanel` (`ChatStripPanel`) in the `.agent` column |
| Stage — Edit preview | `Preview.tsx` inside `.stage` |
| Stage — Media browser (search / grid / detail) | `v4/MediaStage.tsx` |
| Stage — Rec (webcam + glass source bar + big REC) | `v4/RecStage.tsx` |
| Floating transport | `v4/FloatingTransport.tsx` |
| Floating inspector + 8-facet rail | `v4/FloatingInspector.tsx` → reuses `RightPanes` (Background/Effects/Layout/Cursor/Transcript) + Captions/Crop/Chapters |
| Timeline footer (tools, ruler, lanes, clips, navigator) | `Bottombar.tsx` + `TimelinePane.tsx` |
| Media timeline "Arrange clips" header | `Bottombar` `timelineVariant="media"` |
| Region pills (flat wash + 1.5px frame, per-kind color) | `NewEditorShell.module.css` `.zoomPill/.speedPill/.annotationPill/.skipPill` |
| Lane watermark hides when populated | `RegionTimeline.tsx` (`Children.count`) |
| Clip card (--surface-1 / 1.5px / 11px) + floating blur label chip | `TimelinePane.module.css` `.trackBlock/.trackVisual/.trackInfo` |
| Navigator (grey track + --surface-hi window + grips) | `TimelinePane.module.css` `.timelineNavigator*` |
| Tokens (incl. added `--surface-hi`, dark `--fg-emphasis`, `--accent-border/ring/stripe`, `*-wash`) | `src/styles/design-tokens.css` |

## Verification

`tsc --noEmit`, `biome check`, and full `vite build` (renderer + Electron main
+ preload) all pass. All three modes and the populated Edit-mode timeline were
verified in a real browser render (dark hero theme) via a browser-only preview
config (`vite.v4preview.config.ts`) with a seeded document — see
[verify commands memory] / `NewEditorShell` dev store exposure.

## Deliberate engineering decision

The timeline's **visual** matches the design (verified with live data). Its
**interaction logic** — clip drag/reorder, region resize, place-skip,
zoom-pan navigator — is the existing, tested machinery, restyled rather than
rewritten. Re-deriving that logic from scratch was intentionally avoided: it
carries real regression risk to functional editing for no visual gain. If a
ground-up timeline reimplementation is desired, it should be scoped as its own
effort with that risk acknowledged.
