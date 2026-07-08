---
name: openscreen-design
description: Use this skill to generate well-branded interfaces and assets for OpenScreen (an AI-native screen-recording studio & video editor), either for production or throwaway prototypes/mocks/etc. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for prototyping.
user-invocable: true
---

Read the README.md file within this skill, and explore the other available files.
If creating visual artifacts (slides, mocks, throwaway prototypes, etc), copy assets out and create static HTML files for the user to view. If working on production code, you can copy assets and read the rules here to become an expert in designing with this brand.
If the user invokes this skill without any other guidance, ask them what they want to build or design, ask some questions, and act as an expert designer who outputs HTML artifacts _or_ production code, depending on the need.

Quick orientation:
- `styles.css` is the single CSS entry point — link it and use the CSS custom properties (never hard-code hex). Dark is the default; add `data-theme="light"` on a wrapper for the light palette.
- Type: Geist (UI) + Geist Mono (numbers/technical). Base 13px.
- One brand hue: emerald `--accent`. Ration it. Timeline lanes add amber/orange/red semantic accents.
- Components live in `components/` (forms, display, editor); full-screen recreations in `ui_kits/editor/`. Icons are Lucide.
- No emoji, no gradients-as-decoration, no photographic backgrounds. Dense pro-tool density, glassy floating panels, hairline borders.
