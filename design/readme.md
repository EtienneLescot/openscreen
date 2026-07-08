# OpenScreen Design System

A design system extracted from the **OpenScreen Editor** — an AI-native screen-recording
studio and video editor. Think "Screen Studio meets a chat agent": you record your screen,
and an AI agent cleans up dead air, filler words, and pacing, proposes cuts you approve, and
lets you restyle backgrounds, cursors, captions, zoom and layout from a floating inspector.

The UI is a **dark-first, dense, pro-tool** aesthetic built around a single emerald brand hue,
Geist / Geist Mono type, glassy floating panels, and a rich multi-lane timeline.

## Source

Everything here was extracted from a single ground-truth file in this project:

- **`OpenScreen Editor v4.dc.html`** — the most complete build of the editor (chat + stage + timeline).

No external codebase or Figma was provided; the `.dc.html` source IS the ground truth. Related
earlier files (`OpenScreen Editor v2/v3`, `OpenScreen Recording Widget`) were left out of scope
per the request (v4 only).

> **Sharing:** to let others in your org use this, open the **Share** menu and set the file
> type to **Design System**.

---

## CONTENT FUNDAMENTALS

How OpenScreen writes.

- **Voice:** calm, competent, first-person-as-agent. The agent says *"On it — scanning track 1
  for silences now"* and *"I'll flag anything over 600ms."* It narrates what it's doing in plain
  language, commits to specifics (numbers, thresholds), and never gushes.
- **Person:** the product speaks as **"I"** (the agent) to **"you"** (the creator). UI chrome is
  impersonal and imperative: *"Describe the edit you want…"*, *"Drag a clip onto the timeline
  below to add it"*, *"Add chapter at playhead"*.
- **Casing:** Sentence case for body, buttons, and helper text. **UPPERCASE mono micro-labels**
  for section eyebrows only — `RECIPE`, `PRESET`, `STYLE`, `ASPECT RATIO`, `CAMERA SHAPE`.
- **Numbers are first-class.** Timecodes (`0:00.0`), durations (`−0:37.3`), resolutions
  (`1920 × 1080 · 60 fps`), counts (`3/5`, `−3 cuts`), percentages (`0% context`) all render in
  **Geist Mono**. Precision reads as trustworthy.
- **Verbs for actions:** "Apply 3 cuts", "Review each", "Regenerate", "Import media", "Export".
  Short, concrete, no "Click here".
- **Tone of empty states:** factual, lightly guiding — *"Not generated yet — pick a language and
  click regenerate."*, *"No annotations yet"*.
- **No emoji.** None anywhere in the product. Don't introduce them.
- **Filenames stay real:** `demo-n8n-as-code-1.mp4`, `recording-1783066227227.mp4` — never
  "My Video.mp4".

---

## VISUAL FOUNDATIONS

- **Theme:** dark-first. A light theme exists and is a full token swap (`data-theme="light"`),
  but dark is the default and the "hero" look. The accent emerald is identical in both themes.
- **Color:** near-black blue-grey surfaces (`#080a0d` → `#2b313b`), a single **emerald** brand
  hue (`#10b981`) used sparingly for primary actions, active states, and focus. Timeline lanes
  add three semantic accents — **amber** annotations, **orange** speed ramps, **red/danger**
  skips & cuts. Color is rationed: most of the UI is greyscale, emerald marks the one thing that
  matters on screen.
- **Type:** Geist for everything UI, Geist Mono for anything numeric/technical. Base 13px. Tight
  negative tracking on headings; wide positive tracking on tiny uppercase labels.
- **Backgrounds:** subtle radial gradient on the app shell (lighter toward top-center). The
  preview stage sits on its own radial vignette. No photographic backgrounds, no patterns, no
  noise/grain. Surfaces are flat fills separated by hairline borders.
- **Borders:** 1px hairlines everywhere (`--border`), with a softer variant for internal dividers
  (`--border-soft`) and a brighter one for hover/handles (`--border-hi`). Selected/active
  controls get a 1.5px emerald border.
- **Elevation:** two levels. Resting cards use a barely-there inset top highlight + soft shadow.
  Floating things (inspector, transport, popover menus) use `--elev-pop` — a deep soft drop
  shadow plus a 1px inner top highlight, reading as glass.
- **Blur / transparency:** floating panels and on-video chrome use `backdrop-filter: blur(12–20px)`
  over semi-transparent dark fills. This is reserved for elements that float **over the video
  stage** (transport, inspector, recording bar, clip labels) — flat panels in the shell do not
  blur.
- **Corner radii:** nested-radius rhythm — small controls 6–9px, cards 11–12px, panels/popovers
  14–16px, status chips fully round. Containers always round more than what's nested in them.
- **Cards:** flat `--surface`/`--surface-1` fill, 1px border, radius 11–14px, `--elev-card`
  shadow. Setting cards in the inspector pair a label (left) with a mono value in emerald (right)
  above a slider.
- **Motion:** one shared easing `cubic-bezier(0.2,0,0,1)` at **0.15s** on color/border/shadow/
  transform for every interactive element. Sliders scale their thumb 1.14× on hover with an
  emerald halo. The record dot pulses (`os-pulse`, 1.4s). Content fades up 6px (`os-fade`). No
  bounces in chrome, no long durations.
- **Hover:** surfaces step up one level (`transparent → --surface-1/2/3`); ghost icon buttons go
  `--muted → --fg`; primary buttons darken to `--brand-lo`; chips gain an `--accent-wash` fill and
  `--accent-border`.
- **Press/active/selected:** active tabs & tools get an `--accent-soft` fill with `--accent` text;
  selected clips/media get a 1.5px emerald border; toggles slide a knob and fill emerald.
- **Focus:** 3px emerald ring (`--focus-ring`) via `:focus-visible`, no outline.
- **Density:** high. This is a desktop pro tool, not a marketing site. Compact controls
  (26–36px tall), off-grid odd paddings (7/9/11/13px), tight gaps.

---

## ICONOGRAPHY

- **Lucide-style line icons.** Every icon in the product is a stroked SVG at `viewBox="0 0 24 24"`,
  `stroke-width` 1.8–2.4, round caps/joins, `fill:none` (a few small glyphs use solid fill —
  play/pause triangles, cursor arrow, waveform bars). This matches the **Lucide** icon set almost
  exactly, so this system standardises on **Lucide** (`https://unpkg.com/lucide@latest`) as the
  icon source. Component cards link Lucide from CDN.
- Icon sizes: 9–17px inside controls, scaled to the control. Stroke colour is always
  `currentColor` so icons inherit the control's text colour (muted → fg on hover, accent when
  active).
- **No emoji, no icon font, no PNG icons** anywhere. One raster asset only: the logo mark.
- A few icons in the source are hand-tuned (the OpenScreen agent avatar built from `<rect>`s, the
  waveform bars, the cursor arrow). Treat those as bespoke; use Lucide for everything standard.

### Brand mark

- **`assets/logo-icon.png`** — the OpenScreen app icon (22×22 in the topbar). This is the only
  provided brand asset. There is **no wordmark file**; the product sets "OpenScreen" in Geist
  600, 15px, `-0.015em` tracking next to the icon. Do not redraw or recolour the mark.

---

## Index / manifest

Root:
- `styles.css` — the single entry point consumers link. `@import`s everything below.
- `readme.md` — this file.
- `SKILL.md` — Agent-Skill front-matter wrapper.
- `assets/logo-icon.png` — brand mark.

`tokens/` — CSS custom properties (all reachable from `styles.css`):
- `fonts.css` · `colors.css` · `typography.css` · `spacing.css` · `radii.css` · `elevation.css` · `base.css`

`guidelines/` — foundation specimen cards (Design System tab): colors, type, spacing, radii, elevation, motion.

`components/` — reusable React primitives (see each `*.prompt.md`):
- `forms/` — Button, IconButton, SegmentedControl, Switch, Slider, Select, TextField
- `display/` — Badge, Chip, Card, ProgressBar
- `editor/` — ChatBubble, ProposalCard, MediaCard, TimelinePill, FacetRailButton

`ui_kits/editor/` — high-fidelity recreation of the OpenScreen Editor (chat + stage + timeline).

## Intentional additions

None. The component inventory is exactly what the v4 editor defines. `TextField` merges the
`<input>` and `<textarea>` patterns (identical styling) into one primitive.
