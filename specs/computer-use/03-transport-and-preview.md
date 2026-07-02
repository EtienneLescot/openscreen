# 03 — Transport & preview

**Surface:** `Preview` (`src/components/ai-edition/Preview.tsx`), `PreviewCanvas` (`src/components/ai-edition/PreviewCanvas.tsx`), `VirtualPreview` (`src/components/ai-edition/VirtualPreview.tsx`).
**Prerequisites:** `02-editor-foundation.md` — a project is loaded with at least one clip in the timeline. If scenario 02.3 left the project empty, re-record a clip (re-run 01.5–01.8) or import via the Open Project modal.

**Goal of this block:** prove the preview surface (the visual playback area + the transport bar) behaves correctly: play, pause, restart, scrub, fullscreen, and the dual-layer cross-fade at clip boundaries.

**Reference:**
- design `openscreen-editor.html` — `.preview-wrap`, `.preview-canvas`, `.preview-frame`, `.transport`, `.playhead`.
- `Preview.tsx:142` — `<div aria-label="Video preview" data-testid="preview">`.
- `Preview.tsx:172` — `<div className={styles.transport} role="toolbar" aria-label="Playback controls">`.
- `Preview.tsx:177` — Play/Pause button (`aria-label="Play / Pause"`).
- `VirtualPreview.tsx` — two `<video>` elements (A/B) for buffer-and-swap at clip boundaries.

---

## Scenario 03.1 — Preview shows the first frame of the active clip

**Setup**
1. From the end of block 02. Project loaded with ≥ 1 clip.

**Steps**
1. Take a screenshot of the preview area.
2. The preview should show the first frame of the first clip (or the appropriate thumbnail).
3. The preview's `data-current-time-sec` is `0` (or close to it).
4. The preview's `data-is-playing` is `false`.

**Expected**
- The preview is visible (the `data-testid="preview"` element).
- The first frame of the source video is rendered.
- The aspect ratio matches the project's `aspectRatio` setting (default `16:9`).
- No `loading` overlay; no `error` overlay.

---

## Scenario 03.2 — Play / Pause toggle

**Setup**
1. From scenario 03.1 state.

**Steps**
1. Click the **Play / Pause** button in the transport bar (`aria-label="Play / Pause"`).
2. Wait 1 s. Take a screenshot.
3. The `data-is-playing` attribute is now `true`. The button shows the pause icon (or its label switches).
4. Click the same button again.
5. The `data-is-playing` is back to `false`. The play icon returns.

**Expected**
- Play starts the video; `data-current-time-sec` advances.
- Pause stops the video at the current time.
- The button's icon and label flip consistently.
- The keyboard shortcut `Space` also toggles play/pause (verify by pressing `Space` with the focus on the preview).

---

## Scenario 03.3 — Restart from time 0

**Setup**
1. Play the video for at least 2 s. Pause it. `data-current-time-sec` is at least `2`.

**Steps**
1. Click the **Restart** button (icon: `MdRestartAlt` or similar).
2. Take a screenshot.

**Expected**
- `data-current-time-sec` is now `0`.
- The video frame is back to the first frame.
- Playback does NOT auto-start.

---

## Scenario 03.4 — Scrub via the range slider

**Setup**
1. From scenario 03.3 state. Video is paused at `0`.

**Steps**
1. Locate the seek range slider (`aria-label="Seek video"`).
2. Click at ~75% of the slider width.
3. The preview seeks to the corresponding source time.
4. Read `data-current-time-sec`.

**Expected**
- The slider's value reflects the seek position.
- `data-current-time-sec` jumps to ~75% of the clip's duration.
- The preview shows the frame at the seek position.
- The time readout (`MM:SS.mmm / MM:SS.mmm`) updates accordingly.

---

## Scenario 03.5 — Loop toggle

**Setup**
1. From scenario 03.4 state. Scrub to ~90% of the clip.

**Steps**
1. Click the **Loop** button (`aria-label="Loop"`). The button's pressed state shows.
2. Click **Play**. Wait for the playback to pass the clip's end.

**Expected**
- When the playback reaches the end of the timeline (sum of clip durations):
  - With loop ON: playback restarts from `0`.
  - With loop OFF (default): playback stops at the end.
- The loop button's visual state (pressed / not pressed) reflects the current setting.

---

## Scenario 03.6 — Previous / Next clip navigation

**Setup**
1. Project has 2 clips (drag a second asset into the timeline via the Files panel — covered in 05.1).

**Steps**
1. Click the **Previous clip** button (`aria-label="Previous clip"`).
2. The preview seeks to the start of the previous clip.
3. Click the **Next clip** button (`aria-label="Next clip"`).
4. The preview seeks to the start of the next clip.

**Expected**
- The buttons jump between clip boundaries.
- The `data-current-time-sec` reflects the new position.
- If only one clip exists, both buttons may be disabled or no-op.

---

## Scenario 03.7 — Fullscreen toggle

**Setup**
1. From scenario 03.6 state.

**Steps**
1. Click the **Fullscreen** button (`aria-label="Fullscreen"`).
2. The preview enters fullscreen mode.

**Expected**
- The preview occupies the entire screen.
- The transport bar is hidden in fullscreen (or shown as an overlay).
- Press `Esc` to exit fullscreen.

---

## Scenario 03.8 — Time readout format

**Setup**
1. Preview is paused at some position. Read the time readout.

**Steps**
1. Read the text. Format is `MM:SS.mmm / MM:SS.mmm` (current / total virtual duration).

**Expected**
- The current time is on the left, separated by a `/` or `—` from the total.
- The format is monospaced.
- The current matches `data-current-time-sec` (when converted to `M:SS.mmm`).
- The total is the sum of all clip durations (with skips applied).

---

## Scenario 03.9 — Playhead stays in sync with timeline

**Setup**
1. Play the video for at least 3 s. Pause.

**Steps**
1. Read the preview's `data-current-time-sec`.
2. Read the timeline pane's `data-current-time-sec`. They must match.
3. Click on the timeline ruler at ~50% of its width.
4. The preview seeks to the corresponding source time. Both data attributes update.

**Expected**
- `data-current-time-sec` on the preview and on the timeline pane are always equal.
- Scrubbing on either surface updates both.

---

## Scenario 03.10 — REC toggle on transport bar

**Setup**
1. From scenario 03.9 state. Transport bar visible.

**Steps**
1. Locate the REC pill on the transport bar (red dot when active).
2. Click it. The transport changes state to REC.
3. The HUD does NOT reopen — this is a UI element, not the recorder entry point.
4. Click REC again. Returns to play state.

**Expected**
- The REC button toggles a visual state but does not start a real recording.
- (Alternative: if the REC button is a shortcut to reopen the HUD, click it once → HUD reappears. Implementation-specific.)

---

## Scenario 03.11 — Preview handles short clips (1–3 s)

**Setup**
1. Record a short clip (~2 s) → editor opens with a short single clip.

**Steps**
1. Play the clip.
2. Watch the end behavior.

**Expected**
- The clip plays to the end without crashing.
- The playhead stops at the end of the clip.
- The preview shows the last frame (paused).

---

## Scenario 03.12 — Preview handles long clips (>5 min)

**Setup**
1. Record or import a 5+ minute clip.

**Steps**
1. Play for 5 s. Pause. Read `data-current-time-sec`.
2. Scrub to ~75%. The preview seeks correctly.

**Expected**
- Playback is smooth.
- Scrubbing is responsive (no > 1 s lag).
- No console errors during long playback.
- Memory usage stays bounded (no leak indicators in the console).

---

## Scenario 03.13 — Webcam PiP / Dual / Vertical layout presets

**Setup**
1. Project has both a screen recording AND a webcam file (i.e. recorded with `webcamEnabled=true`).
2. Open the right rail → **Camera** pane (or **Layout** pane depending on grouping).

**Steps**
1. The layout preset selector lists: `picture-in-picture` (default), `dual-horizontal`, `dual-vertical`, `screen-only`, `webcam-only`.
2. Click `dual-horizontal`. The preview swaps to side-by-side layout.
3. Click `dual-vertical`. The preview stacks vertically.
4. Click `picture-in-picture`. The webcam overlays in the corner.

**Expected**
- The layout switch is instantaneous (no re-render glitch).
- The webcam mask (rectangle, circle, square, rounded) is applied.
- The webcam mirroring setting is honored.
- The transition between layouts does not cause the playback to stutter.

---

## Scenario 03.14 — Cursor overlay at recorded positions

**Setup**
1. Project was recorded with `cursorCaptureMode = "editable-overlay"` (default).
2. The preview shows the recorded video at a time where the cursor was moving.

**Steps**
1. Read the right pane → **Cursor** settings.
2. Adjust the cursor theme (e.g. switch from `macOS Arrow` to `Mint Dot`).
3. Adjust the cursor size (slider, default 3.0).

**Expected**
- The cursor in the preview updates to match the new theme and size.
- The smoothing slider affects the cursor's motion blur (set to 0 = sharp; set to 1 = smooth).
- The clip-to-bounds toggle hides the cursor when it leaves the recording area.

---

## Scenario 03.15 — Playback across clip boundaries (cross-fade)

**Setup**
1. Project has 2 clips back-to-back (no skip between them).
2. The first clip ends at ~5 s; the second starts at ~5 s.

**Steps**
1. Play the timeline. Watch the boundary.
2. The transition is a **cross-fade** between two `<video>` elements (the A/B buffer-and-swap in `VirtualPreview.tsx`).

**Expected**
- The transition is smooth (no visible jump).
- No black flash between clips.
- The playhead does not stutter at the boundary.
- Audio does not glitch.

---

## Scenario 03.16 — Playback across skip ranges

**Setup**
1. Project has 1 clip with a skip range between 2 s and 4 s.

**Steps**
1. Play from `0`. Watch the preview.

**Expected**
- The preview skips from `2 s` to `4 s` (the keep-before + keep-after intervals).
- The skip is visually invisible (no black frame).
- The timeline's data attributes show the playhead jumps from ~2 s to ~4 s.
- The time readout's current value jumps accordingly.

---

## Scenario 03.17 — Restart-from-button vs scrub-to-zero

**Setup**
1. Play the video. Pause at ~5 s.

**Steps**
1. Click Restart button.
2. Click the seek slider at position `0` (far left).

**Expected**
- Both actions seek the playhead to `0`.
- The Restart button does NOT change `data-is-playing`; the seek-slider click may or may not.

---

## Scenario 03.18 — Preview error overlay

**Setup**
1. Force a preview error: open a project whose underlying file was deleted on disk.

**Steps**
1. Take a screenshot.

**Expected**
- The preview shows the `error` overlay: `Video preview could not be loaded.`
- The transport's play button is disabled.
- The timeline still shows the clip (state is intact).
- Re-importing the file restores the preview.

---

## Cross-cutting checks for this block

- All transport buttons have `aria-label` attributes the MCP can use for selection.
- The MCP must NEVER close the editor window during this block (no save/unsaved interruptions).

**Next:** proceed to [`04-timeline-pan-zoom-scrub.md`](04-timeline-pan-zoom-scrub.md).