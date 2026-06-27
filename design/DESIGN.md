# OpenScreen Design System

> Category: Video & Productivity Tools
> Surface: Desktop web (Electron)
> Source: tokens extracted from `openscreen-editor-2.html` (canonical)

A high-fidelity, professional dark-and-light desktop application design system
optimized for video recording, post-processing editing, and timeline
manipulation. Mint is the single brand accent; red is reserved strictly for
REC / cut / skip / trim / transcript-highlight states; amber covers warnings.

---

## Color Palette

### Light theme (`:root`)

| Role | Token | Hex | Notes |
|---|---|---|---|
| Canvas | `--bg` | `#fafbfc` | Off-white, never pure white; soft radial gradient |
| Panel | `--surface` | `#ffffff` | Raised panels on canvas |
| Card | `--surface-1` | `#f7f8fa` | Tier 1 raised |
| Tier 2 | `--surface-2` | `#f3f5f8` | Raised on panel |
| Hover | `--surface-3` | `#eef0f3` | Active/hover state |
| Popover | `--surface-hi` | `#ffffff` | Highest elevation |
| Border | `--border` | `#e7e9ee` | Soft hairline |
| Border soft | `--border-soft` | `#f1f2f5` | Subtle dividers |
| Border hi | `--border-hi` | `#d1d5db` | Emphasis lines |
| Foreground | `--fg` | `#1f2937` | Slate, not pure black |
| Foreground emphasis | `--fg-emphasis` | `#111827` | Headlines |
| Muted | `--muted` | `#6b7280` | Body / labels |
| Meta | `--meta` | `#9ca3af` | Timestamps, captions |
| Brand (mint) | `--accent` | `#10b981` | Primary action, focus ring, toggle-on |
| Brand glow | `--brand-glow` | `rgba(16,185,129,0.35)` | Focus / hover |
| Danger | `--danger` | `#ef4444` | REC, skip, trim, transcript highlight |
| Warning | `--warn` | `#f59e0b` | Soft amber |
| Success | `--success` | `#10b981` | Alias of brand |

### Dark theme (`:root[data-theme="dark"]`)

| Role | Token | Hex | Notes |
|---|---|---|---|
| Canvas | `--bg` | `#0a0d12` | Near-black with faint blue cast |
| Panel | `--surface` | `#14181f` | Tier 1 panel |
| Card | `--surface-1` | `#14181f` | Same as panel base |
| Tier 2 | `--surface-2` | `#1c2029` | Raised |
| Hover | `--surface-3` | `#252a35` | Hover/active |
| Popover | `--surface-hi` | `#2e3440` | Highest |
| Border | `--border` | `#252a35` | Reads on canvas |
| Foreground | `--fg` | `#e6e9ef` | Off-white, never pure `#ffffff` |
| Muted | `--muted` | `#8b95a3` | Tuned for AA on dark |
| Brand (mint) | `--accent` | `#10b981` | Same hue, brighter tone on `--brand-lo: #34d399` |
| Danger | `--danger` | `#f87171` | Softer red for dark bg |

### Traffic lights (macOS chrome)

| Token | Hex |
|---|---|
| `--light-red` | `#ff5f57` |
| `--light-yellow` | `#febc2e` |
| `--light-green` | `#28c840` |

---

## Typography

- **Display:** system-ui stack — `system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif`
- **Body:** system-ui stack (same as display)
- **Mono:** `ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace`

### Type scale (desktop editor, base 13px)

| Token | Size | Use |
|---|---|---|
| `--fs-app` | 13px | Base UI |
| `--fs-app-sm` | 12px | Secondary |
| `--fs-app-lg` | 14px | Primary UI |
| `--fs-title` | 16px | Panel titles |
| `--fs-section` | 11px | Section headers (uppercase, tracked) |
| `--fs-display` | 24px | Hero numerals |

Nothing below 11px.

---

## Layout

- **Radius:** 8px standard; `--r-xs: 4px`, `--r-sm: 6px`, `--r-md: 8px`, `--r-lg: 12px`, `--r-pill: 9999px`
- **Border weight:** 1px
- **Spacing:** 4px baseline grid (`--sp-1` through `--sp-6`)
- **Editor wireframe:**
  - Titlebar: 34px
  - Left utility rail: 48px
  - Left panel: 320px
  - Right properties: 320px
  - Resize handle: 6px
  - Bottom timeline/toolbar: 224px

### Posture rules

- **One accent, used at most twice per screen.** Default budget is eyebrow + primary CTA.
- **Red is reserved** for REC, cut, skip, trim, and transcript highlight only. It is not a brand color.
- **Mint is the single brand color** for active state, focus ring, toggle-on, and brand mark.
- **Off-white canvas, tiered surfaces.** Never use pure `#000` or pure `#fff` for editorial chrome.
- **Soft elevation, slate-based shadows.** Two `--elev-card` and `--elev-pop` are enough.
- **System-ui type, mono numerics.** No web fonts loaded; ships the declared fallback stack.

---

## Motion

- `--motion-fast: 120ms` — hover, focus ring
- `--motion-base: 180ms` — state transitions
- `--ease: cubic-bezier(0.2, 0, 0, 1)` — standard easing

---

## Voice & Tone

- **Adjectives:** high-fidelity, professional, calm, restrained.
- **Tone:** a confident dark-themed tool. Marketing prose is sparse; product UI carries the work.
- **Messaging pillar:** video recording, post-processing editing, and timeline manipulation — same three jobs the editor does.

### Vocabulary

- **Use:** Record, Trim, Cut, Skip, Timeline, Clip, Track, Transcript.
- **Avoid:** playful emoji feature labels (✨ 🚀 🎯), "AI-powered" in product chrome, generic SaaS copy ("supercharge your workflow").

---

## Imagery

- **Style:** schematic, palette-derived. Scene illustration in preview is grayscale made from the same neutrals — not literal artwork.
- **Treatment:** replace placeholder scenes with real project footage when shipping.
- **Avoid:** stock photography, decorative illustration in tool chrome, hand-drawn mascots.

---

## Files in this directory

| File | Role |
|---|---|
| `openscreen-editor-2.html` | Latest editor (light + dark themes in one file). Canonical source of tokens. |
| `openscreen-editor.html` | First editor pass. Light-only. |
| `editor.html` | Earlier experimental editor with red REC accent. |
| `openscreen-landing.html` | Marketing landing page. |
| `index.html` | Launcher / overview. |
| `DESIGN.md` | This document. |

---

## Open questions / follow-ups

- `editor.html` uses a different red-dominant accent and predates the mint brand color. Keep as historical reference; do not import its tokens into new work.
- Landing page (`openscreen-landing.html`) is light-only; consider a dark variant once product photography is sourced.
- No logo asset is committed yet. Brand mark should be a simple wordmark or geometric mark in mint on the dark canvas.
