# Art direction brief — the recreated editor

The engineering of this section is finished and correct. Its composition is not.
This brief exists because the specification it was built from was exact about
geometry and silent about art direction, and it shows.

**The one job: make a scroll through this read as one continuous look at a piece
of software, instead of a series of fragments.** Everything below is either the
material you have to work with, a constraint you may not break, or a description
of what is currently wrong.

---

## 1. What this section is

The OpenScreen landing page opens with a photograph of the real editor. Below it,
the same editor is **redrawn in live DOM** — real elements, real text, the app's
own design tokens — wrapped around **real video of the recording it is editing**.
The reader scrolls; a camera moves through that scene in 3D perspective; the
interface changes state as it goes.

It is a composite, the same way the application is one: the app draws chrome in
DOM and puts video in a canvas. That is the point. Chrome alone would be a
*drawing* of an interface used to sell an interface — which is exactly what this
page deleted, and the deletion is the section's whole premise.

Live at `http://localhost:3223` (see §7). The code is five files, ~4,200 lines:

| file | lines | what it is |
|---|---:|---|
| `index.tsx` | 595 | the markup. Renders once, holds no state, hands refs to the driver |
| `styles.module.css` | 1,613 | geometry, tokens, the 3D camera keyframes, the gates |
| `driver.ts` | 366 | one rAF loop; the media clock |
| `generated.ts` | 639 | **emitted, never hand-edited** — every string and number on screen |
| `../../../scripts/gen-recreation.mjs` | 1,020 | the generator that emits it |

---

## 2. The problem to solve

**Stated as a problem, because the current answer is wrong and a better one may
not look like the current one at all.**

The scene is authored at the app's literal size — 1920 CSS px — so that 11px pill
labels and 13px transcript text render at 1:1 and stay legible. That was the
right instinct: text drawn at native size is the difference between software at
life size and a mockup.

But a 1920px-wide scene in a 1440px viewport **cannot be seen whole**. Every hold
in the current camera therefore frames a fragment: half a transcript panel, a
slice of canvas, a corner of the FAQ. There is no moment in the entire scroll
where a reader sees *an editor*. Authoring at 1:1 and filling the viewport are
in direct tension, and the current build resolves it by silently choosing 1:1 and
letting the composition lose.

Ways out exist and none is obviously right — that is the brief:

- Reframe so each act is a **deliberate detail shot** rather than an accidental
  crop, and let the whole-editor view be carried by the photograph above.
- Scale the scene down at the holds and accept softer text, buying a whole view.
- Author a **narrower** scene — a composition of the app's parts rather than a
  facsimile of its layout — which is not the app's geometry but may be the better
  picture.
- Something else. The constraint is legibility and honesty, not 1920.

---

## 3. What is wrong now, specifically

Regenerate the evidence with §7's command; these are the three that matter.

**The camera is inside the scene rather than looking at it.** See above. This is
the structural fault and everything else is downstream of it.

**The copy panels are cards dropped on top.** Each act's headline and paragraph
render as a rounded, shadowed rectangle floating over the scene, overlapping it
at whatever position the transform happens to leave. They read as a separate UI
layer, not as part of a composition. There is no relationship — no alignment, no
consistent side, no negative space reserved for them.

**A third rectangle competes.** The figure's caption (the mono paragraph
explaining what is drawn and what is filmed) is a third floating card. Three
shadowed rectangles fight for the frame at once.

**There is no ground.** The scene bleeds into flat black with hard vertical seams
where the world ends. Nothing situates it; nothing catches its edge.

---

## 4. What you may not break

These are not stylistic preferences. Each has a reason and most have a test.

**Every string comes from somewhere.** `generated.ts` is emitted by a generator
that reads the project document, the app's locale files, and the app's own
`formatSec` / `effectiveZoomScale` / `buildClipSection` — imported and executed,
not reimplemented. Each string carries a `PROVENANCE` entry naming its source.
**Do not type a label, a timecode, a percentage or a duration into the markup.**
If a value cannot be sourced, it does not appear: that is why there is no chat
context pill (its value is computed and cannot honestly read 0% beside a rendered
reply) and no webcam bubble (the camera track is off in this project).

You may freely change **layout, size, position, colour, order, transform and
motion**. You may not change **what is said**.

**The two clocks stay separate.** `video.currentTime` owns the transport digits,
the playhead, the cue-word underline and the canvas frame. Scroll owns the camera
and the presence of the edit-history objects. No readout may have two sources,
and no scroll-driven rule may touch a property the media clock owns. It is
greppable on purpose.

**Nothing is seeked.** The canvas video plays and loops. Scroll moves the camera,
never the film. Seeking per animation frame is the most expensive thing this page
could do.

**The gates are mirrors and must stay mirrors.** The recreation shows only at
≥901px with `position: sticky` supported and not in forced-colors. The three
photographic bands it replaces (`.superseded` in `../Walkthrough/styles.module.css`)
carry the exact inverse. Both are pure CSS. If they ever drift apart there is a
width at which a reader sees the same three claims twice, or neither.

**Reduced motion and no-JS fall back to the photographs**, with not one clip byte
requested. Verified: the document is 9,161px with the recreation and 5,971px
without.

**The media budget has 12,744 bytes left**, of 1,600,000 — `npm run check:media`
is the gate and it fails the build. If you need more, the four `-scrub` clips
(865 KB) are now redundant with the DOM camera and can go; nothing else can.

**Accessibility.** Nothing focusable anywhere — the app's silence marker is a real
button, and recreating it as one would announce an action this page will never
perform. No `role="img"` (it would flatten 433 nodes to `presentation`). The
transcript and chat are exposed as real selectable text; the chrome is
`aria-hidden`. The tree is fixed at the closing state so it never mutates under a
linear reader. What moves is opacity, not the tree.

**No `backdrop-filter` inside the transformed world** (measured: 2.2–3.0× the
main-thread work of a whole sweep, a 166ms worst frame). **No `100vw`** — it ships
a horizontal scrollbar on every classic-scrollbar platform. **No CSS custom
property written from JavaScript** — an inherited property invalidates every
descendant; measured at 211ms of style recalc against 8–9ms for direct
`element.style` writes.

---

## 5. The material

All paths relative to `website/`. Everything here is already cut, verified and
committed; none of it needs reshooting.

### Photographs of the real application

| file | size | bytes | what it shows |
|---|---|---:|---|
| `static/img/walkthrough/editor-1560.jpg` | 1560×876 | 68,521 | the whole editor at the end of a session — the agent's reply, two silences struck red in the transcript, two trims and three zooms on the timeline |
| `static/img/walkthrough/editor-1040.jpg` | 1040×584 | 57,132 | same frame, smaller |
| `…/editor-1560.avif`, `editor-1040.avif` | — | 53,739 / 30,807 | same, AVIF |
| `…/01-record-a.jpg` | 820×461 | 13,051 | the recorder's five settings rows |
| `…/02-timeline-a.jpg` | 1560×288 | 26,597 | the timeline strip: three zoom pills, two trim pills, lane hints, waveform |
| `…/03-captions-a.jpg` | 960×540 | 36,099 | a caption rendered over the canvas, Captions panel beside it |
| `…/04-agent-a.jpg` | 960×540 | 48,827 | the agent's reply quoting real timecodes, green applied line |
| `…/05-export-a.jpg`, `-b.jpg` | 960×540 | 15,747 / 16,517 | the export dialog, before and mid-render |

Each has a 640-wide `-sm-` companion.

### Footage

| file | size | bytes | what it is |
|---|---|---:|---|
| `static/video/canvas-loop.mp4` | 836×470 | 132,193 | **7.000s seamless loop**, the recording being edited, pre-cropped to zoom region 2's own 2.20× framing so the picture, the `2.20×` pill and the playhead are three renderings of one fact |
| `static/video/canvas-loop-sm.mp4` | 640×360 | 62,819 | same |
| `static/img/walkthrough/canvas-poster.jpg` | 872×490 | 35,889 | its first frame |
| `static/video/05-export.mp4` (+`-sm`) | 960×540 | 22,259 | the export dialog rendering |
| `static/video/*-scrub.mp4` ×4 | — | 865,212 | all-intra clips for the scroll-scrubbed bands — **redundant with this section; reclaimable** |

### Data

`generated.ts` exports, all derived: 106 transcript entries (103 words + 3 silence
markers, each knowing whether a trim covers it), 5 timeline pills with their
positions as percentages, 5 lanes with the app's real shortcut hints, both ruler
variants (2s step ≤3042px, 1s step above), the waveform as 5 SVG paths bucketed by
opacity, the chat's four blocks, the stage geometry, and the app's dark tokens.

---

## 6. How this will be judged

In this order:

1. **Does a scroll read as one look at one piece of software?** Today it does not.
2. **Is the text legible where the reader is asked to read it?** The transcript and
   the agent's reply carry the section's two strongest claims; if they cannot be
   read, the panels have no reason to be drawn rather than photographed.
3. **Does the motion feel motivated?** The camera should move because there is
   something to look at, not to demonstrate that it can.
4. **Does it still feel like software rather than a mockup?** This is what native
   text size was protecting. If you trade it away, trade it knowingly.
5. **Do the fallbacks still hold, and does the budget still pass?** `npm run
   typecheck && npm run check:media && npm run build` must be green.

---

## 7. Running it and seeing it

```bash
cd website && npm ci && npm run build && npm run serve -- --port 3223
```

Then `http://localhost:3223`. Hard-reload — this page has bitten three people
with a stale cache.

The in-app browser panes do not deliver `IntersectionObserver` callbacks while
hidden, so drive a real headless Chrome over CDP instead. Working drivers, which
also produce the evidence in §3:

```
scratchpad/rec-shots.mjs     six screenshots across the scroll
scratchpad/fallback.mjs      the gates at a given width, optionally with reduced motion
scratchpad/overflow.mjs      every element crossing the viewport edge at a given width
```

To change what is *said* rather than how it looks, edit the sources the generator
reads and re-run `node scripts/gen-recreation.mjs`. Never edit `generated.ts`.
