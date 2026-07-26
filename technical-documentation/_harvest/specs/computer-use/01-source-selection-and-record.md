# 01 — Source selector, countdown, recording lifecycle

**Surface:** `SourceSelector` (`src/components/launch/SourceSelector.tsx`) + `CountdownOverlay` (`src/components/launch/CountdownOverlay.tsx`) + `useScreenRecorder` (`src/hooks/useScreenRecorder.ts`).
**Window types involved:** `hud-overlay`, `source-selector`, `countdown-overlay`, then `editor`.
**Prerequisites:** `00-launch-and-hud.md` — all 12 scenarios green.

**Goal of this block:** exercise the full recording pipeline — pick a screen source, see the countdown, start recording, pause / resume, restart, stop, and arrive at the editor with the just-recorded session loaded.

**Reference:**
- inventory `openscreen-inventory.md §1` — window graph and recorder lifecycle.
- source `useScreenRecorder.ts:1040` (`startRecordCountdown`) and `:1163+` (browser `getDisplayMedia` path).
- native fallback for Windows/macOS uses WGC / ScreenCaptureKit; tests must note which path was taken (`data-capture-mode` is not currently exposed — fall back to inspecting `useScreenRecorder` internals via the console).

---

## Scenario 01.1 — Source selector shows Screens / Windows tabs

**Setup**
1. Click the source-pick button on the HUD bar (`MdMonitor` icon). Wait for the Source Selector window.

**Steps**
1. Take a screenshot of the Source Selector.
2. Locate the tabs strip at the top. Click the `Screens (N)` tab.
3. Click the `Windows (N)` tab.
4. Click back to `Screens (N)`.

**Expected**
- The tabs strip shows two tabs: `Screens (N)` and `Windows (N)` where N reflects the count returned by `desktopCapturer.getSources` (`electron/ipc/handlers.ts:1307`).
- Screens tab: thumbnail cards for each monitor (typically 1–2 in dev environments).
- Windows tab: thumbnail cards for each open window.
- If a tab has count 0, the grid is empty (not the empty-state page — that's only shown when **both** tabs are empty after a failed `getSources`).
- Tab switching preserves the previously selected source if it is still in the new tab.

---

## Scenario 01.2 — Pick a screen source → Share

**Setup**
1. From scenario 01.1 state. Default tab = Screens.

**Steps**
1. Click any source card. A green check badge appears in the corner (`MdCheck` icon).
2. The card is highlighted with a brighter border.
3. Click the `Share` button (localized label from `actions.share`).

**Expected**
- The `Share` button is **disabled** until a source is selected (gray).
- After clicking the source card, the button is enabled (mint background).
- Clicking `Share`:
  - Closes the Source Selector window.
  - Opens the Countdown Overlay window.
- The selected source becomes the recorder's source (verify by inspecting the next countdown frame).

---

## Scenario 01.3 — Cancel from the source selector

**Setup**
1. Open the Source Selector again.

**Steps**
1. Click `Cancel` (without selecting any source).

**Expected**
- The Source Selector closes.
- No Countdown opens.
- The HUD bar's source-pick button returns to its idle state.

---

## Scenario 01.4 — Countdown overlay counts down 3 → 2 → 1

**Setup**
1. From scenario 01.2 state (a source is selected, Countdown is open).

**Steps**
1. Take a screenshot every 1 s for 3 s.

**Expected**
- The Countdown overlay window is **frameless transparent**, ~420×260 px, anchored to the bottom-centre of the primary display.
- It shows a large countdown number that animates from `3` to `2` to `1`.
- Each number remains visible for ~1 s with a smooth transition (the number grows then fades).
- The countdown overlay's window can ignore mouse events (`focusable: false`) — verify by moving the mouse over it: clicks should NOT focus it.

---

## Scenario 01.5 — Recording starts, HUD reflects RECORDING state

**Setup**
1. Wait for the countdown to complete (the 3-2-1 finishes; the Countdown window closes).

**Steps**
1. Take a screenshot of the HUD bar.
2. The record button now shows the active REC state (red dot, label `Recording`).
3. A timer (`formatTimePadded(elapsedSeconds)`) starts counting up from `00:00`.
4. Pause and resume buttons become available.

**Expected**
- The HUD's record button has its `aria-pressed="true"` state (or visual equivalent: red dot animation, `REC` label).
- The timer ticks every second.
- The pause button is enabled.
- The restart button is enabled.
- The cancel button is enabled.
- The mic / webcam toggles are **disabled** during recording (greyed out).
- The cursor-mode button is disabled.
- The source-pick button is disabled.

---

## Scenario 01.6 — Pause / resume recording

**Setup**
1. From scenario 01.5 state. Let the timer reach at least `00:03`.

**Steps**
1. Click the pause button (`BsPauseCircle`).
2. Wait 2 s. Take a screenshot. The timer should be paused.
3. Click the resume button (`BsPlayCircle`).
4. Wait 2 s. Take a screenshot. The timer resumes.

**Expected**
- After pause: timer stops counting; the HUD record button's state changes to a "paused" variant (still REC visible, but timer frozen); pause button swaps to the resume icon.
- After resume: timer continues from the paused value (does NOT reset to 0); the icon swaps back to pause.
- Total `accumulatedDurationMs` is preserved across pause/resume cycles (verified by: stop the recording and check the editor's total duration matches the sum of active intervals).

---

## Scenario 01.7 — Restart recording discards the current take

**Setup**
1. From scenario 01.6 state. Timer is paused.

**Steps**
1. Click the restart button (`MdRestartAlt`). A confirmation prompt appears (if wired) — click `Yes` / `Discard`.
2. Take a screenshot of the HUD bar.

**Expected**
- The HUD resets to its pre-recording state: timer reads `00:00`, record button is in the idle state, pause/resume/restart are disabled again.
- The previous recording is **discarded** (no file written to `userData/recordings/`).
- A new recording can now be started by clicking the record button again.

---

## Scenario 01.8 — Stop recording transitions to the editor

**Setup**
1. From scenario 01.5 state (or restart from 01.7 and re-record for ~3 s).

**Steps**
1. Let the timer reach at least `00:05`.
2. Click the stop button (`FaRegStopCircle`).
3. Wait up to 10 s. Take a screenshot.

**Expected**
- The HUD window closes.
- The Countdown Overlay does NOT reappear.
- The **editor window** opens, maximized, with the just-recorded media loaded.
- The editor's bottom timeline pane shows the recorded media as a single clip spanning the recorded duration (e.g. `~5s`).
- The preview pane shows the first frame of the recording.
- The status `data-current-time-sec` is `0` (or very close).
- The `data-clip-count` is `1`.
- The `data-skip-count` is `0`.

---

## Scenario 01.9 — Cancel recording mid-take discards

**Setup**
1. From scenario 01.5 state.

**Steps**
1. Let the timer reach at least `00:02`.
2. Click the cancel button (`MdCancel`).
3. Take a screenshot.

**Expected**
- The HUD returns to its pre-recording state without opening the editor.
- No recording is saved.
- The tray icon's right-click menu no longer shows `Stop recording`.

---

## Scenario 01.10 — Webcam overlay during recording (optional, if webcam enabled)

**Setup**
1. Click the webcam toggle on the HUD before recording (refer to 00.5).
2. Pick a source, start the countdown, start the recording.

**Steps**
1. Record for ~5 s. Take a screenshot of the HUD and the system preview (the screen source being captured).
2. Stop the recording.

**Expected**
- The webcam feed appears as a small overlay on the captured screen (the desktopCapturer captures the screen including any application windows that draw to it; the HUD's webcam preview is a separate DOM element).
- After stop + editor open, the editor's preview shows the captured video. If a webcam file was produced (sidecar file), it may or may not be visible in the editor preview — depends on the active layout preset.
- The webcam PIP can be configured in the editor (covered in `10-properties-right-panel.md`).

---

## Scenario 01.11 — Cursor capture mode (system vs editable-overlay)

**Setup**
1. Set the cursor-mode toggle to `system` (refer to 00.6).
2. Start a recording. Record for ~5 s. Stop. Open the editor.

**Steps**
1. Open the editor. Check the preview at a time where the cursor is visible.
2. Open the right panel → Cursor pane. Inspect the cursor theme.

**Expected**
- When `system` mode: the OS cursor is hidden during recording; the recording has cursor telemetry captured separately; the editor renders a synthetic cursor based on the telemetry.
- When `editable-overlay` (default): the OS cursor is left visible during recording; the editor shows the original cursor + an editable synthetic overlay.
- Either way, the editor renders a cursor in the preview at the recorded positions.

---

## Scenario 01.12 — Permission flow on macOS (manual — skip if Win/Linux)

**Setup**
1. macOS only. The Screen Recording permission may be `not-determined` on first launch.

**Steps**
1. Click the source-pick button. The Source Selector window briefly opens and closes; the prompt for permission appears.
2. The app retries up to 8 times (`openSourceSelectorFlow.ts:32`).

**Expected**
- The Source Selector window appears within 8 retries (~8 s).
- On the user's first acceptance, the prompt closes and the Source Selector renders normally.
- Skip this scenario on Win/Linux.

---

## Scenario 01.13 — Multiple sequential recordings overwrite the editor's current pointer

**Setup**
1. From scenario 01.8 state (editor is open with recording #1).
2. Return to the recorder: titlebar → `Return to recorder` button (`aria-label="Return to recorder"`).
3. Record a second, shorter clip (~3 s). Stop.
4. The editor reopens.

**Steps**
1. Verify the editor's preview shows recording #2 (not #1).
2. Verify the timeline's clip count is still `1` (the new take replaced the old).

**Expected**
- The editor's `currentRecordingSession` pointer is updated to recording #2.
- The previous file is NOT deleted from `userData/recordings/` (per `openscreen-inventory.md §1` "Multiple sequential recordings").
- The titlebar's `data-project-name` is unchanged; only the content swaps.

---

## Cross-cutting checks for this block

- Every recording scenario must verify that **at least one file** landed in `userData/recordings/` (the file name pattern is `recording-<timestamp>.webm` for browser-capture, `recording-<timestamp>.mp4` for native).
- The MCP should not assume a particular capture mode. If the test environment is Win with the WGC helper available, it may take the native path; on a fresh Linux box, browser-capture is used. Both paths are correct as long as the editor ends up with a playable clip.
- After scenario 01.13 the editor is the foreground window. All later scenarios run from this state.

**Next:** proceed to [`02-editor-foundation.md`](02-editor-foundation.md).