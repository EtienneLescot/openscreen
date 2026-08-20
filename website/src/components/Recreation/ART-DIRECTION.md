# The recreation — art direction

Five settings in two acts, told by the scroll. This replaces an earlier build
that drew the whole editor at 1:1 in a 1920px scene and flew a camera over it;
this note records what was wrong with that and what the rules are now, so the
next pass does not rediscover either.

## What the previous cut got wrong

1. **The scene was bigger than the screen.** Authored at 1920px and shown in a
   1440px viewport, it could never be seen whole, so every camera hold framed a
   fragment of an interface rather than an interface. Nothing else on the list
   mattered as much as this one.
2. **It was boxed into the 1040px measure.** Inside the page's content column,
   a whole editor had to be drawn at a third of its natural size.
3. **Three shadowed rectangles competed** — chat, canvas, floor — with no ground
   under any of them and no clear subject in any frame.
4. **It was generated from a spec and looked at once, at the end.**

## The rules

**Nothing is drawn that the current beat does not need.** Act one is a
composite and one inspector panel; there is no timeline, because a background
swap, a padding change and a cursor resize are all legible in a still frame and
the picture would rather have the room. Act two adds the timeline, because
zooms, a pinned note and cuts arriving from a transcript are only meaningful
against one. The floor slides in once, between the acts.

**Everything is sized to the viewport.** Percentages, `min()` against a measure,
and container units inside the composite. There is no pixel scene and therefore
no framing that can go wrong at a width nobody tested. The band is the one
block on the page that escapes `.inner`.

**One subject per frame.** A caption and a panel on the left, the composite on
the right, the floor at the bottom in act two. The composite gets a hairline and
a seated shadow, not a glow — a halo reads as a selection state on something
that is not selected.

**One clock.** Scroll position becomes scene seconds, scene seconds become
document seconds in act two, and the playhead, the pill under it, the composite's
magnification and the transcript's cue are four readings of that one number. No
media element, no second timebase, nothing that can drift.

**The beats touch.** A gap between beats is a stretch with no caption, no panel
and no palette — which looks like breathing room on paper and like the left half
of the screen going empty on screen. Two separate passes shipped that bug.

**The hand is aimed at the control it operates, never at a coordinate.** Both
pointers name a target — `data-t` for the reader's, `data-shot` for the recorded
one — and the driver measures it once per resize, then re-expresses it as a
percentage of the stage each frame. The percentages are the output, not the
score: a path authored in them has to be re-tuned every time a panel moves and
is otherwise silently almost-right. The recorded pointer still carries authored
coordinates for the moments its tip is over nothing nameable — open canvas, the
travel between two controls.

## What is real

- **The panels** are the app's, by locale key: `PANELS` for the titles,
  `CONTROLS` for every slider at this document's own setting, scaled and
  suffixed the way `RightPanes.tsx` does it. Cursor size is `size * 10` over
  5–100 with one decimal and no unit — a hand-written panel gets that wrong in a
  way that looks entirely plausible.
- **The padding slider** moves the composite through `PreviewCanvas.tsx`'s own
  `clamp(1 - (padding/100) * 0.4, 0.4, 1)`, evaluated per frame.
- **The wallpapers** are the app's own — twelve of the eighteen it ships, in the
  design's order — and the first one the take picks is the one `STAGE.wallpaper`
  names.
- **The pills' scales and labels** are the document's: `effectiveZoomScale` for
  the zooms, `toFixed(2)` and all, which is how a hand-typed "1.8×" gives itself
  away. Their times are not. The document's own edit is two trims at the two ends
  of a forty-second take — truthful, and almost nothing to look at — so the rail
  stages nine objects over twenty-six seconds: three zooms, a speed ramp and five
  trims. The annotation is the one drawn object; the document holds none, which
  is exactly why that lane still shows its "Press A" hint.
- **The transcript** is staged for the same reason: 76 tokens against the
  document's 106, and five of them strike — the three silences and the two
  filler words. The document's own transcript, as `buildClipSection` builds it,
  is in `generated.ts`; the pane does not read it.
- **The picture in the window** is a render of the page the recording was of.
- **The webcam bubble** is staged too, and is the one thing on screen the
  document contradicts rather than merely omits: `cameraTrack.visible` is false,
  so the bubble plays a clip of its own.

`generated.ts` carries all of it and is emitted by `scripts/gen-recreation.mjs`.
Never edit it by hand; `--check` fails the Docs workflow when it drifts.

That check compares its own output with the committed file byte for byte, so
the generator has to own the file's formatting outright — `biome.json` tells the
formatter to skip it, and the emitter writes TypeScript rather than JSON so that
what it produces is also what a reader wants to read. Anything that reformats it
afterwards makes the check report drift on a file nobody touched, which is
exactly what it did for as long as lint-staged was formatting it.

## Verifying

The in-app browser pane returns black frames for this page. Drive headless
Chrome over CDP instead, scroll to a scene time, and look at the result — every
defect in the list at the top of this file was visible in a screenshot and
invisible in the source.
