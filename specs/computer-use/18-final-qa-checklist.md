# 18 — Final QA checklist (cross-cutting smoke pass)

**Surface:** the entire app.
**Prerequisites:** all previous blocks `00`–`17` green.

**Goal of this block:** a single end-to-end smoke pass that exercises the most critical user paths, end-to-end, on a clean app launch. The MCP runs this last, after every per-feature spec has been individually verified.

**Reference:** each scenario here aggregates the relevant steps from the per-feature specs. The intent is regression coverage — if any of these fail, something serious broke.

---

## Scenario 18.1 — Cold launch → HUD visible

**Setup**
1. Quit the app cleanly. No Electron process is running.

**Steps**
1. `npm run dev`.
2. Wait for Vite dev server. Wait for the HUD window.

**Expected**
- HUD is visible, frameless, bottom-centred.
- No console errors.
- The HUD's record button is in the idle state.
- The language picker shows `EN`.

---

## Scenario 18.2 — Record → edit → export happy path

**Setup**
1. From the end of 18.1.

**Steps**
1. Pick the primary monitor as a source.
2. Wait through the countdown (3-2-1).
3. Record for ~5 s while performing some screen motion.
4. Stop.
5. The editor opens with the recorded clip.
6. Add a skip range at 1 s–2 s (Scissors button).
7. Add a zoom region at 2 s–4 s with depth 2×.
8. Add a text annotation over the entire clip.
9. Change the background wallpaper to a gradient.
10. Open the Export dialog. Export as MP4, final-balanced, 30fps, h264.
11. Wait for completion. Reveal the file in the folder.

**Expected**
- The MP4 file exists.
- The file's duration is ~3 s (the 1 s skip is applied).
- The file contains the zoomed-in frames at 2 s–4 s.
- The text annotation is baked into the video.
- The gradient background is applied.

---

## Scenario 18.3 — Multi-clip project flow

**Setup**
1. From scenario 18.2 state. Quit and re-launch.

**Steps**
1. Re-record a 3 s clip. Stop.
2. From the Files panel, drag the just-recorded file into the timeline again (creates a 2nd clip).
3. Drag a different asset (use a sample video file from `tests/fixtures/`) into the timeline.
4. Reorder the clips (drag the first clip past the second).
5. Edit the second clip's source range (Edit Clip dialog, shrink to 1 s).
6. Add a speed region on the third clip at 2×.
7. Save the project (`Ctrl+S`).
8. Quit. Re-launch.
9. Re-open the project from `Recent`.

**Expected**
- The project reloads with all 3 clips, the skip, the zoom, the text annotation, and the speed region intact.
- All data-* attributes on the timeline reflect the saved state.

---

## Scenario 18.4 — AI chat flow

**Setup**
1. Project from scenario 18.3 is open.
2. A provider is configured (OpenAI / Anthropic / etc.).

**Steps**
1. Open the chat panel.
2. Send: `Trim silences longer than 0.5 seconds.`
3. Wait for the agent's response.

**Expected**
- The agent applies 1+ skip ranges.
- Each skip has an `applied: …` line.
- The timeline reflects the new skips.
- Undo (`Ctrl+Z`) reverts the agent's batch.

---

## Scenario 18.5 — Transcript + skip interaction

**Setup**
1. From scenario 18.4 state.

**Steps**
1. Open the Auto-Captions modal. Generate captions (tiny model).
2. Wait for the transcript to appear.
3. Click a word. The preview seeks.
4. Shift-click another word. Press `Delete`. A skip range is added.

**Expected**
- The new skip matches the deleted word range.
- The preview skips the range during playback.

---

## Scenario 18.6 — All 13 locales switch cleanly

**Setup**
1. From any state.

**Steps**
1. Cycle through every locale (13 of them).
2. For each, verify:
   - No console errors.
   - All labels are translated (no English fallback visible).
   - Layout doesn't break (RTL works for `ar`).

**Expected**
- Every locale passes.

---

## Scenario 18.7 — Theme + locale + state persistence

**Setup**
1. Set: theme = dark, locale = ja-JP, cursor mode = system, tray layout = vertical.

**Steps**
1. Quit. Re-launch.

**Expected**
- All four preferences are preserved.

---

## Scenario 18.8 — Multi-window coordination

**Setup**
1. The app is running. Editor is open.

**Steps**
1. Click `New recording` in the titlebar. The HUD reopens.
2. Click `Open studio` (or any equivalent) in the HUD. The editor reopens.

**Expected**
- Only one window is in the foreground at a time.
- The HUD and editor share the same project state.

---

## Scenario 18.9 — Long recording (5+ min) playback

**Setup**
1. Record a 5-minute clip (or import a long fixture).

**Steps**
1. Open the editor. Wait for the preview to load.
2. Scrub to ~75%. Verify the preview loads the frame within 1 s.
3. Play for 30 s. Pause. Verify the timeline updates correctly.

**Expected**
- No memory leaks (no console warnings about GC pressure).
- Scrubbing is responsive.

---

## Scenario 18.10 — Export round-trip (preview-low → final-high)

**Setup**
1. Project has 3 clips + 2 skips + 1 zoom region.

**Steps**
1. Export at `preview-low`. Verify the file plays and the duration matches.
2. Export at `final-high`. Verify the file plays and the duration matches.
3. Export as GIF. Verify the file plays.

**Expected**
- All 3 exports succeed.
- All 3 files have the expected duration (sum of kept intervals).

---

## Scenario 18.11 — Concurrent operations (rapid clicks)

**Setup**
1. Editor is open with a project.

**Steps**
1. Rapidly click the Skip / Zoom / Annotation add buttons 10 times in a row.

**Expected**
- The UI does not freeze.
- All 10 regions are added (or the operation is throttled correctly).
- No console errors.

---

## Scenario 18.12 — Save / load round-trip across all data types

**Setup**
1. Project has 1 clip + 1 skip + 1 zoom + 1 speed + 1 annotation + 1 text annotation + 1 image annotation + 1 figure annotation + 1 blur annotation + 1 custom wallpaper + custom cursor theme.

**Steps**
1. Save the project (`Ctrl+S`).
2. Quit. Re-launch.
3. Open the project.

**Expected**
- All data types are restored.
- The preview reflects every change.

---

## Scenario 18.13 — Failure: missing asset file

**Setup**
1. Project is open with 1 clip.

**Steps**
1. Delete the underlying video file from `userData/recordings/`.
2. Open the project.

**Expected**
- The editor opens.
- The preview shows the error overlay: `Video preview could not be loaded.`
- The timeline still shows the clip (state is intact).
- Re-importing the file restores the preview.

---

## Scenario 18.14 — Failure: corrupted project file

**Setup**
1. Project file at `userData/projects/<id>.openscreen` is corrupted (write garbage).

**Steps**
1. Open the project.

**Expected**
- The editor shows an error toast / modal.
- The app does not crash.
- A backup or recovery flow is offered (or the user is told to pick a different file).

---

## Scenario 18.15 — Failure: invalid LLM response

**Setup**
1. The agent returns malformed JSON for a tool call.

**Steps**
1. The agent attempts to apply the operation.
2. The IPC layer rejects the operation.

**Expected**
- The chat shows an error card.
- The project state is unchanged.
- The user can retry.

---

## Scenario 18.16 — Full app teardown

**Setup**
1. Editor + HUD + any open modals.

**Steps**
1. `Cmd+Q` (macOS) or close all windows (Win/Linux).
2. Wait for the process to exit.

**Expected**
- All windows close.
- The main process exits cleanly.
- No orphan processes (check Task Manager / Activity Monitor).

---

## Scenario 18.17 — Re-launch with no state

**Setup**
1. Delete `userData/` (or rename it for backup).

**Steps**
1. `npm run dev`.

**Expected**
- The app launches with a clean state.
- The HUD is visible.
- No projects exist (Compositions is empty).
- No console errors.

---

## Cross-cutting checklist for the entire run

The MCP, after running all 18 blocks, should produce a summary report with:

- Total scenarios run: 18 blocks × ~20 scenarios each = ~350 scenarios.
- Pass rate.
- List of failed scenarios (with screenshots + console logs).
- Console errors seen (classified by file:line if possible).
- Mean time per scenario.

**Final pass criteria:**
- 100% of `Expected` blocks pass.
- 0 console errors during any pass.
- All 13 locales render cleanly.
- Theme switching + state persistence work across restarts.

If any of the above fail, escalate to the human. Do not patch the app from the computer-use MCP — that's a human job.