# Manual end-to-end checklist

This checklist covers the real desktop capture-to-export path: the parts that unit, browser, and Playwright tests cannot exercise, including real screen capture, a physical webcam, the system tray, the native compositor, and export. Run it before promoting a release candidate and after any change to native capture, preview, or export.

**"Manual" is about the input, not the operator.** These checks need real OS mouse and keyboard events, not a human hand — so an agent with the computer-use MCP runs them, on demand, and a request for one section after a targeted change is as much a run as the whole file before a promote. Availability check and the rule on partial runs: [AGENTS.md](../../AGENTS.md#desktop-e2e-testing-with-computer-use).

Sections marked **v1.8.0** cover what this release changed: chat-driven editing through the agent tool set, clip-anchored modifiers, local transcription, the macOS Metal compositor, and the new effect controls. Run the whole file for a release candidate; the v1.8.0 sections are the ones with no prior release to fall back on.

## How to run this

1. Drive the real Electron app with computer-use — real OS mouse and keyboard events. Start a dev build with `npm run dev`, or launch the packaged build under test.

   "Manual" here usually means an agent holding the mouse, so the tempting shortcut is not a browser shim: it is driving the real app through CDP instead. **Do not.** Playwright's `.click()`, `javascript_tool`-dispatched pointer events and anything else synthesised into the renderer arrive *below* the OS hit-test. On Windows and macOS the HUD is input-transparent until a real cursor move lifts it, so an injected click fires the DOM handler and comes back green while the path a user actually takes was never exercised at all.

   That trap is specific to the HUD and the countdown overlay — they are the only click-through windows; the editor is an ordinary one, and an injected click there does reach the handler a user would reach. The reason not to inject in the editor either is the first line of this file: this checklist covers what unit, browser and **Playwright** tests cannot. Drive it the way those tests already drive it and you have re-run the coverage you had, then written "passed" beside the parts nothing checked.
2. The app is single-instance per `userData` path. If a leftover Electron/OpenScreen process still holds the lock, stop that process before relaunching; a second launch can exit successfully without opening a window. The lock is held by the OS and is released when the process dies, so there is nothing to delete on disk.
3. From a worktree, link or junction `node_modules` to the main checkout and provide the prebuilt native capture binaries for the platform before starting the dev build. **Date those binaries against the change you came to test.** Nothing rebuilds them, so an older helper runs the old code path in silence: the recording succeeds and the thing you were checking for is simply absent. See AGENTS.md for how to check one and how to rebuild it; when you cannot, test the CI-built artifact, because a dev build cannot answer a native question.
4. Grant computer-use access to the process name that actually owns the window: `electron.exe` or `Electron.app` for a dev build, and `Openscreen.exe` or `Openscreen.app` for a packaged build. Do not grant access only to the installed app name when testing a dev build — it resolves to the *installed* executable and reports success while the dev window stays masked. This is step 4 and not step 1 for a reason: a dev build is not an installed app, so the resolver cannot find it until it is running and owns a window, and one unresolvable name voids the whole request.

   **Ask for everything in ONE call — after the launches above, before the first check.** `request_access` takes a list, and once a grant is in place the rest of the pass runs without a single further prompt: a full capture-to-export run is dozens of clicks and none of them ask again. So the only thing keeping a human at the keyboard is *how many* dialogs you raise and *when*. Raise one, before the first check, and the operator can walk away for the rest of the run; discover a fourth app you need an hour in and they cannot. That is also why this cannot move earlier — the resolver needs the app running, and one unresolvable name voids the batch. Beyond the app under test, ask for:

   - the desktop shell — the tray icon and the native save dialogs live there, and the tray is the only reliable way back to the HUD;
   - the OS settings app — needed to change display scaling, which is how DPI checks are run (see AGENTS.md; "the machine is at 100%" is not a reason to skip them).

   **Name them the way the Start menu does, in the system's own language.** The resolver matches installed-app display names, not executables: on a French Windows the shell is `Explorateur de fichiers` and `explorer.exe` fails outright — `notInstalled`, with a nonsense suggestion attached — which then voids every other name in the same call. On an English install it is `File Explorer`. When unsure, ask rather than guess; the tool lists the installed names it knows.

   There is no way to pre-approve any of this in config: the request has to be answered live. That is upstream ([claude-code#46907](https://github.com/anthropics/claude-code/issues/46907), closed stale), and `bypassPermissions` does not cover it either ([#43172](https://github.com/anthropics/claude-code/issues/43172)). Batching is the whole mitigation.
5. Read [AGENTS.md](../../AGENTS.md) for the computer-use mechanics, screenshot permissions, tray interaction, and cleanup procedure. Read one check, perform it, observe the result, then continue; close each modal or popover with `Esc` before the next check.
6. The recording HUD is protected from capture by default and is invisible in screenshots. For this session only, launch with `OPENSCREEN_DISABLE_CONTENT_PROTECTION=1`; this is the environment variable checked before `setContentProtection(true)`. Unset it before making any recording whose HUD must not appear in the video.
7. A preview screenshot is downscaled. Settle every pixel-level question by exporting a frame and measuring the exported frame, not by judging fine edges, corners, shadows, or alignment from the preview screenshot.
8. Keep the first real recording or imported project available for the editor sections. Log crashes, hangs, data loss, security issues, and reproducible visual failures as soon as they occur.
9. Several v1.8.0 sections need a configured AI provider (chat editing, caption translation) or a built native compositor addon (preview, export). A dev build from a worktree needs the compositor addon installed for its platform, not only the capture binaries. When a prerequisite is missing, record the section as skipped with the reason; do not mark it passed.
10. Prefer a project with at least two clips from the same asset for the modifier sections. A single-clip project cannot exercise anchoring, reorder, or cross-boundary splitting at all, which is where the v1.8.0 timeline model changed.

## Launch and HUD

- [ ] Start the app and confirm one launch window appears without a startup crash.
- [ ] Confirm the launch window remains usable after the first device enumeration completes.
- [ ] Confirm the HUD is visible when content protection is disabled for the test session.
- [ ] Activate `[data-testid="launch-tray-layout-button"]` and confirm the tray changes between horizontal and vertical layouts.
- [ ] Confirm the chosen tray layout remains coherent when the HUD grows to show recording controls.
- [ ] Activate `[data-testid="hud-drag-handle"]`, drag the HUD across most of the primary display, and confirm it follows the pointer without drift.
- [ ] Release the drag and confirm the HUD stays at the dropped position instead of jumping.
- [ ] Activate the language button by its visible language code and confirm a menu of locale choices opens.
- [ ] Press `Esc` with the language menu open and confirm it closes without changing the locale.
- [ ] Activate the minimize control and confirm the HUD hides without quitting the app.
- [ ] Refocus the app from its system-tray icon and confirm the HUD returns to the foreground.
- [ ] Activate the close control while idle and confirm the HUD closes cleanly.
- [ ] Relaunch the app after closing it and confirm the single-instance behavior does not leave a duplicate HUD.

## Source selection and recording

- [ ] Activate `[data-testid="launch-source-selector-button"]` and confirm the source selector opens.
- [ ] Select a screen or application card with `data-testid="source-selector-card"`, activate `[data-testid="source-selector-share-button"]`, and confirm the selector closes with the source name on the HUD.
- [ ] Confirm `[data-testid="launch-record-button"]` is disabled until a source is selected, then activate it and confirm recording starts with a red stop state and an increasing elapsed timer.
- [ ] Confirm the configured system-audio, microphone, webcam, and cursor states remain visible while recording.
- [ ] Activate the recording control's pause action and confirm the timer stops advancing, then resume and confirm it advances again.
- [ ] Activate the restart action while recording and confirm the current recording is discarded and a fresh recording begins.
- [ ] Activate the cancel action while recording and confirm recording ends without opening an editor for the canceled take.
- [ ] Confirm stopping opens the editor with the recorded screen asset loaded.
- [ ] On Windows, stop once with system audio, microphone, webcam, and cursor all disabled and confirm the editor opens within a few seconds.
- [ ] Record once with microphone only and confirm the resulting playback contains audible microphone audio.
- [ ] Record once with system audio only and confirm the resulting playback contains audible system audio.
- [ ] Record with microphone and system audio enabled and confirm both sources are audible and reasonably balanced.

## Editor opens and loads the project

- [ ] Confirm the editor opens after a successful stop with the expected project title and asset.
- [ ] Confirm `[data-testid="preview"]` is present and its current-time value starts at the beginning of the project.
- [ ] Confirm the loaded video is visible in the preview rather than an empty state or broken-video state.
- [ ] Confirm the timeline contains a clip for the recorded or imported asset.
- [ ] Activate the project rename control by its `aria-label`, enter a new non-empty title, and confirm the title changes.
- [ ] Confirm the top bar shows an unsaved state after changing the project title.
- [ ] Switch among the Media, Edit, and Rec editor modes and confirm each selected tab visibly changes state.
- [ ] Confirm the editor's preview, timeline, and inspector remain usable after switching modes.
- [ ] Activate the left-panel toggle by its `aria-label` and confirm the chat/media panel opens or closes without changing the project.
- [ ] Resize the chat panel by its visible divider and confirm the preview area resizes without moving the timeline content.
- [ ] Resize the timeline by its visible top divider and confirm the timeline height changes without a layout crash.

## Transport and preview

- [ ] Activate the playback control with the `aria-label` for play/pause and confirm `[data-testid="preview"]` changes `data-is-playing` from `false` to `true`.
- [ ] Activate play/pause again and confirm playback stops and the preview reports `data-is-playing="false"`.
- [ ] Confirm the transport time readout advances while playback is running.
- [ ] Confirm the playhead advances with the video instead of remaining at its starting position.
- [ ] Drag the transport seek range control with the `aria-label` for seeking and confirm `[data-testid="preview"]` reports the new current time.
- [ ] Seek while paused and confirm the preview frame changes to the selected time.
- [ ] Seek while playing and confirm playback continues from the new time without a visible stuck frame.
- [ ] Activate the loop control and confirm its pressed state changes.
- [ ] Play through the end with looping enabled and confirm playback returns to the loop start.
- [ ] Activate the fullscreen control and confirm the preview enters fullscreen presentation.
- [ ] Exit fullscreen and confirm the normal editor layout returns.
- [ ] With a webcam recording, confirm the webcam picture-in-picture appears aligned with the screen content.
- [ ] Add a full-camera segment, scrub into it, and confirm the webcam grows to fullscreen then returns at the segment end.
- [ ] Confirm the preview's webcam, cursor, background, and region effects remain synchronized while scrubbing.

## Timeline navigation (pan, zoom, scrub)

- [ ] Confirm the timeline ruler displays time labels from the project start through its duration.
- [ ] Click a position on the ruler and confirm the playhead and preview seek to that time.
- [ ] Drag across the ruler or timeline track and confirm the playhead follows the pointer.
- [ ] Hold `Ctrl` while scrolling over the timeline and confirm the timeline zooms around the pointer position.
- [ ] Hold `Shift` while scrolling over the timeline and confirm the visible time range pans without changing the project.
- [ ] Drag the timeline with the middle mouse button and confirm the visible time range pans.
- [ ] Confirm the playhead remains aligned with the ruler and clip positions after zooming and panning.
- [ ] Drag the navigator window and confirm the main timeline follows its visible range.
- [ ] Drag a navigator handle and confirm the visible range narrows or widens without changing clip data.
- [ ] Confirm an empty-area click clears any selected region and closes its selection inspector.
- [ ] Confirm the reworked ruler keeps readable labels at the narrowest and widest zoom levels rather than colliding or disappearing.
- [ ] Confirm the playhead stays exactly on the time it reports after zooming, panning, and resizing the timeline.
- [ ] Change the project title, save, and toggle the export control's availability, and confirm the top bar keeps its layout instead of reflowing on each state change.

## Clip operations

- [ ] Open the Media panel and confirm the project asset is listed with its source name.
- [ ] Drag a listed media asset into the timeline clip area and confirm a new clip appears.
- [ ] Click a clip and confirm it receives a selected visual state.
- [ ] Drag a selected clip before another clip and confirm the clip order changes.
- [ ] Double-click a clip and confirm the Edit Clip dialog opens.
- [ ] Change the clip start in-point in the dialog and confirm the clip duration changes.
- [ ] Change the clip end in-point in the dialog and confirm the clip duration changes.
- [ ] Confirm the clip's crop or in/out changes affect the preview after closing the dialog.
- [ ] Select a clip and activate the delete control with the `aria-label` for deleting a clip; confirm only that clip is removed.
- [ ] Select a clip, use the configured copy and paste shortcuts, and confirm a duplicate clip appears.
- [ ] Select more than one clip when supported and confirm the edit control offers a clip picker rather than editing an unspecified clip.

## Regions (trim/skip, zoom, speed, annotation)

- [ ] Drag a trim region's left edge and confirm its start time changes.
- [ ] Drag a trim region's right edge and confirm its end time changes.
- [ ] Scrub across a trim region and confirm the preview skips the marked interval during playback.
- [ ] Delete the selected trim region from its inspector and confirm the interval is restored.
- [ ] Activate the timeline tool with the visible zoom label and confirm a zoom region appears.
- [ ] Select the zoom region and cycle its level through multiple available depths; confirm the preview scale changes.
- [ ] Drag the zoom focus point in the preview and confirm the zoom follows the new focus.
- [ ] Change the zoom rotation preset among none, iso, left, and right and confirm the preview orientation changes.
- [ ] Set a zoom region to automatic focus and confirm its focus follows cursor telemetry across the whole region.
- [ ] Use the automatic-zooms menu and confirm it adds suggested zoom regions when cursor telemetry supports suggestions.
- [ ] Select a zoom region and delete it from the selection inspector; confirm it disappears from the lane.
- [ ] Activate the timeline tool with the visible speed label and confirm a speed region appears.
- [ ] Change the speed region through its preset selector and confirm the lane label and preview timing change.
- [ ] Enter a custom speed in the speed field, commit it, and confirm the custom value remains selected.
- [ ] Play across a speed region and confirm the preview reflects the region's speed.
- [ ] Select a speed region and delete it from its inspector; confirm normal speed returns.
- [ ] Activate the timeline tool with the visible annotation or comment label and confirm an annotation region appears.
- [ ] Select a text annotation, replace its text, and confirm the new text appears in the preview.
- [ ] Change the text color and toggle its background; confirm both changes are visible in the preview.
- [ ] Change the text animation using the control with the `aria-label` for selecting text animation and confirm the animation runs when the playhead enters the region.
- [ ] Convert an annotation to an image, upload a supported image, and confirm the image appears in the preview.
- [ ] Convert an annotation to a figure, change its arrow direction and stroke width, and confirm the figure changes.
- [ ] Convert an annotation to blur, change its blur type and shape, and confirm the selected area is obscured.
- [ ] Drag an annotation in the preview and confirm its position persists when the playhead leaves and returns.
- [ ] Select an annotation and delete it from its inspector; confirm it disappears from the preview and lane.
- [ ] Use undo and redo after adding, editing, and deleting at least one region and confirm each operation restores the prior state.

## Modifiers are anchored to clips — v1.8.0

Zoom, speed, annotation, and full-camera regions are stored against a clip in that clip's own source time, not at an absolute ruler position. See [timeline-model.md](../architecture/timeline-model.md). These checks exist because the failure mode is silent: the pill stays where it was drawn while the effect fires somewhere else.

- [ ] Draw a zoom wholly inside one clip, reorder that clip to another position, and confirm the zoom travels with the clip and keeps its length.
- [ ] Confirm the moved zoom still fires over the same picture content, not at the ruler position it originally occupied.
- [ ] Draw a region across a boundary between two clips, move one of those clips away, and confirm the region splits into one pill per clip instead of remaining one pill at the old position.
- [ ] Put the two clips back side by side and confirm the fragments render as a single pill again.
- [ ] Confirm two regions of the same kind with identical properties that touch display as one pill.
- [ ] Change one of the two merged regions and confirm the pill separates into two.
- [ ] Drag a zoom pill into a neighbouring zoom with a different level and confirm it clamps at the neighbour's edge and the neighbour does not move.
- [ ] Confirm the same repel behaviour for two speed regions with different speeds.
- [ ] Add a trim inside a clip that a zoom already covers and confirm the covered part is hidden without shifting any later region on the ruler.
- [ ] Confirm the ruler still shows the trimmed span occupying its place while playback skips it.
- [ ] Delete a clip and confirm modifiers anchored only to that clip disappear while modifiers on other clips are untouched.
- [ ] Duplicate a clip and confirm its modifiers are duplicated with the copy.
- [ ] Change a clip's in and out points in the Edit Clip dialog and confirm anchored modifiers clamp to the new range rather than drifting past it.
- [ ] Select a zoom, copy its attributes with the configured copy shortcut, select another zoom, paste, and confirm the copied toast appears and the target adopts level, rotation, and focus without changing its own span.
- [ ] Repeat the attribute copy and paste for a speed region and for a text annotation.
- [ ] Trigger copy with nothing selected and confirm the "select a region" message rather than a silent no-op.
- [ ] Trigger paste before anything was copied and confirm the "nothing copied yet" message.
- [ ] Save, reopen the project, and confirm every modifier is still on the same clip content after the reorder performed above.
- [ ] Zoom and pan the timeline and confirm each pill's span still matches the time at which its effect fires in the preview.
- [ ] Export a short range that covers a reordered clip and a trim, and confirm the exported frames agree with the preview about where each modifier fires.

## Transcript and captions

- [ ] With no transcript, confirm the pane offers a transcribe action instead of showing an empty editor.
- [ ] Start transcription for the loaded asset and confirm a visible in-progress state appears.
- [ ] Confirm a completed transcription displays words in timeline clip order.
- [ ] Click a transcript word and confirm the playhead seeks to that word's start.
- [ ] Play the project and confirm the current word receives the cue highlight as playback advances.
- [ ] Place the caret in the transcript and press `Backspace` or `Delete`; confirm the affected word becomes marked as skipped rather than disappearing from the transcript.
- [ ] Hover a skipped word and activate its restore control by the `aria-label` for restoring that word; confirm the word is kept again.
- [ ] Open the inspector facet with the visible Captions label and confirm caption controls appear.
- [ ] Toggle caption visibility and confirm captions appear or disappear in the preview.
- [ ] Change caption font, alignment, position, size, color, and background controls and confirm each committed change is visible.
- [ ] Select a caption translation language, run translation with a configured provider, and confirm translated captions appear.
- [ ] Switch the caption language back to Original and confirm the source transcript returns.

### Local transcription and captions — v1.8.0

- [ ] Confirm the transcript pane states that transcription runs locally and that no upload occurs when it is started.
- [ ] With the Whisper helper binary absent, activate the transcribe action and confirm the UI reports why nothing happened, and that the main-process log carries exactly one matching `[stt]` line. The failure now reaches a toast (`transcriptionStore.ts`) and the log (`whisperServer.ts`), but the sentence shown is one the app writes for itself — `whisper-stt-server binary not found; build it via scripts/build-whisper-stt.sh`, produced before any helper process starts — so it points a packaged-build user at a script they do not have. Helper stderr is a separate source, and only ever for a helper that did start. Verify against a build whose helper was deliberately not packaged, not only against a working one.
- [ ] Run transcription in the packaged build and confirm the model is fetched or reused without an error about a missing cache directory.
- [ ] Confirm a second transcription reuses the cached model instead of downloading it again.
- [ ] Confirm the completed transcript reports the detected language on the media asset card.
- [ ] Choose an explicit language on the asset card, regenerate, and confirm the new transcript replaces the old one with its own word timings.
- [ ] Confirm word timings are monotonic: click several words in order and confirm each seek lands later than the previous one.
- [ ] Confirm silent stretches appear as a silence span with its duration rather than as missing text.
- [ ] Activate a silence span's trim control and confirm a trim appears on the timeline covering that interval.
- [ ] Restore that silence from the transcript and confirm the trim is removed.
- [ ] Confirm transcription is unavailable with a clear message rather than a crash when the app runs outside Electron.
- [ ] Translate captions, then delete the translation, and confirm the original transcript text and timings are unchanged.
- [ ] Confirm a project carrying caption annotations from the old feature reports them and offers to remove them.
- [ ] Play across a zoom region with captions on and confirm the captions stay in the frame instead of scaling and drifting with the zoom.
- [ ] Export that range and confirm the exported frames show the same caption placement as the preview.

## AI chat and providers — requires a configured provider

- [ ] Open the chat panel with the top-bar control identified by its `aria-label` and confirm the chat surface appears.
- [ ] Confirm the chat header shows controls for AI settings, history, and a new conversation.
- [ ] Send a short request and confirm the user message appears in the conversation.
- [ ] Confirm the provider returns an assistant response without an unhandled error.
- [ ] Open the model picker and confirm the active model is visibly selected.
- [ ] Change the reasoning effort when the configured provider supports it and confirm the chosen value remains selected.
- [ ] Run an edit request that creates a supported timeline change and confirm the applied operation is visible in the conversation.
- [ ] Use the conversation rewind control by its `aria-label` and confirm the rewind confirmation surface appears.
- [ ] Confirm a rejected or canceled rewind leaves the timeline unchanged.
- [ ] Open AI settings and confirm the provider list, connection status, and configuration form load.
- [ ] For an API-key provider, enter a key and confirm the provider becomes connected without displaying the raw key afterward.
- [ ] For a device-flow provider, confirm the challenge panel shows a user code and an Open login page action.
- [ ] Open conversation history and confirm the current conversation is listed.
- [ ] Start a new conversation, switch back to the prior one, and confirm each conversation retains its own messages.
- [ ] Rename a conversation with its visible rename control and confirm the new title appears.
- [ ] Delete a conversation with its visible delete control and confirmation prompt, then confirm it no longer appears.

## Chat-driven editing — v1.8.0, requires a configured provider

The agent may only call the fixed tool set in [ai-agent.md](../architecture/ai-agent.md); it never writes the document freehand. These checks are about the edit actually landing on the timeline, the turn being one undo unit, and a failed turn leaving the project intact.

- [ ] With no provider connected, open the chat and confirm the "bring your own AI" welcome view appears with the composer disabled instead of an error.
- [ ] Connect a provider and confirm the same panel becomes a usable conversation without restarting the app.
- [ ] Ask the agent to cut the silences and confirm the result appears as trim regions on the timeline rather than as rewritten clips.
- [ ] Confirm the seekable duration after that edit still reaches the full recording, so the trims are reversible.
- [ ] Ask for a zoom on a described moment and confirm a zoom pill appears at approximately the requested time and the preview scales there.
- [ ] Ask for a speed change over a described range and confirm a speed region appears with the requested factor.
- [ ] Ask for a text annotation and confirm it appears in the preview with the requested text.
- [ ] Ask for a full-camera segment and confirm the region appears and the camera fills the frame while it plays.
- [ ] Confirm each applied operation is summarized in the conversation and that the number of summarized operations matches what the timeline gained.
- [ ] Ask the agent to remove one of the modifiers it created and confirm that modifier alone disappears.
- [ ] Ask the agent to restore the full timeline and confirm the trims it added are gone.
- [ ] Confirm modifiers created by the agent are anchored like hand-drawn ones: reorder a clip and confirm they travel with it.
- [ ] After a turn that applied several operations, undo once and confirm the whole turn reverts as a single unit rather than one tool call at a time.
- [ ] Redo and confirm the whole turn returns.
- [ ] Ask for something outside the tool set and confirm the agent explains rather than silently doing nothing or leaving an invalid document.
- [ ] Send a request while the project has no asset and confirm a clear response instead of an unhandled error.
- [ ] Use the rewind control on an earlier user message, confirm in the dialog, and confirm the timeline, the conversation tail, and the later checkpoints all roll back together.
- [ ] Cancel a rewind at the confirmation dialog and confirm both the timeline and the conversation are untouched.
- [ ] Confirm the context badge shows a percentage and that its tooltip reports used and budget tokens.
- [ ] Activate Compact context on a conversation with enough history and confirm an earlier-context summary message appears and the percentage drops.
- [ ] Activate Compact context on a short conversation and confirm the "not enough history" message rather than a failure.
- [ ] Confirm a compaction failure leaves the conversation history unchanged.
- [ ] Use the copy control on an assistant message and confirm the message text reaches the clipboard.
- [ ] Open the timeline toolbar's auto-enhance menu, choose the AI option, and confirm the chat panel opens with the prompt prefilled and sent through the normal send path.
- [ ] Confirm the edit produced by that auto-enhance request can be rewound like any other turn.
- [ ] Choose the AI auto-enhance option with no provider connected and confirm the setup view appears instead of a failed send.
- [ ] Choose the cursor-based automatic zooms option and confirm it adds zooms without involving the provider.
- [ ] Restart the app and confirm conversations are gone while the provider configuration persists; this is a known gap, not a defect to file.
- [ ] Confirm the provider API key is never displayed in the settings form after it is saved.

## Native compositor preview and export — v1.8.0

- [ ] Confirm `[data-testid="native-compositor-mount"]` shows a live composited preview rather than an empty surface.
- [ ] Confirm `[data-testid="native-compositor-error"]` is absent during a normal run.
- [ ] Scrub back and forth across a clip boundary several times and confirm the preview keeps up without a stall on each crossing.
- [ ] Seek to the very end of the project and confirm the last frame is shown instead of a blank or stuck frame.
- [ ] Confirm no loading overlay remains on top of an already valid preview frame.
- [ ] On a machine with no compatible GPU, confirm `[data-testid="native-compositor-cpu-notice"]` appears, the export dialog shows its CPU warning, and the export still completes.
- [ ] Export the same project on macOS and on Windows and compare frames at identical timestamps for background, blur, shadow, roundness, padding, cursor, and text.
- [ ] On macOS, export an MP4 from a project with audio and confirm the output has audio.
- [ ] On macOS, export a frame containing a text annotation and confirm the text is upright, centred in its box, and that its background plate fits the text.
- [ ] On macOS, export a frame containing a blur annotation and confirm the area is actually obscured.
- [ ] On macOS, export a range with the cursor visible and confirm the cursor and its trail are rendered.
- [ ] On macOS, export frames with each 3D rotation preset and confirm the tilt matches the Windows render.
- [ ] On macOS, export a frame with background blur enabled and confirm it matches the Windows render.
- [ ] Export a range containing a zoom with an annotation and captions on screen, and confirm neither follows the zoom in the exported frames.
- [ ] Confirm the packaged macOS app refuses to start or reports clearly when the compositor addon is missing, rather than failing at first render.

## Export

- [ ] Confirm the top-bar export control is disabled when the project has no asset.
- [ ] With a loaded project, activate the export control by its `aria-label` and confirm the export dialog opens.
- [ ] Confirm the dialog initially offers MP4 and GIF format choices.
- [ ] Select MP4 and confirm quality choices include a lower tier, a balanced tier, and Source.
- [ ] Select each available MP4 quality and confirm the displayed output dimensions update.
- [ ] Select 24, 30, and 60 FPS and confirm the selected frame rate remains visible.
- [ ] Select H.264 and H.265 and confirm the selected codec remains visible.
- [ ] Select GIF and confirm GIF frame-rate, size, and loop controls appear.
- [ ] Change GIF frame rate and size, toggle looping, and confirm the summary reflects the choices.
- [ ] Start an MP4 export and confirm the native rendering progress reports advancing frames or percentage.
- [ ] Confirm the export dialog reports a saved output path after MP4 completes.
- [ ] Open the exported MP4 outside the app and confirm it plays through the expected duration with audio when the source has audio.
- [ ] Start a GIF export and confirm frame rendering and file writing complete without an unhandled error.
- [ ] Open the exported GIF outside the app and confirm it contains the expected motion and loop behavior.
- [ ] Export a GIF from colour-rich footage long enough to exhaust the encoder's first code widths, and confirm no frame degrades into corrupted stripes or shifted colours partway through.
- [ ] Open that GIF in a second viewer and confirm both decoders agree, since a code-width defect can decode differently per viewer.
- [ ] Export a project containing audio, a trim, a speed region, a zoom, an annotation, captions, and webcam layout changes when available.
- [ ] Compare that exported result with the preview for timing, skipped intervals, audio, webcam, captions, and effects.
- [ ] For every pixel-level comparison, export a frame and measure it with an image tool rather than relying on a preview screenshot.

## Settings, shortcuts, themes, i18n

- [ ] Change one shortcut, save it, use the new key in the editor, and confirm it triggers the configured action.
- [ ] Confirm `Ctrl/Cmd+S` saves the current project.
- [ ] Confirm `Ctrl/Cmd+O` opens the project dialog.
- [ ] Open the Background facet and switch among image, color, and gradient tabs.
- [ ] Select a built-in wallpaper and confirm the preview background changes.
- [ ] Choose a color swatch or enter a valid hex color and confirm the background changes.
- [ ] Choose a gradient preset and confirm the preview background changes.
- [ ] Open the Effects facet and toggle background blur, motion blur, shadow, roundness, and padding; confirm each changes the preview.
- [ ] Open the Layout facet and choose each available webcam layout; confirm the preview arrangement changes.
- [ ] Change webcam mirror, reactive zoom when supported, shape, and size; confirm each change is visible.
- [ ] Open the Cursor facet and toggle cursor visibility and clip-to-bounds; confirm the preview changes.
- [ ] Change cursor theme, size, smoothing, motion blur, and click bounce; confirm each committed value remains visible.
- [ ] Toggle the theme control by its `aria-label` and confirm the editor switches between dark and light themes.
- [ ] Open the top-bar language control by its `aria-label`, choose a non-English locale, and confirm visible UI strings change.
- [ ] Switch back to English and confirm the top bar, transport, inspector, and export labels return to English.
- [ ] Select a different aspect ratio from the timeline aspect-ratio menu and confirm the preview frame changes shape.
- [ ] Press `Esc` or click outside an open menu, popover, or dialog and confirm it closes.

### App menu, About, and updates

- [ ] On macOS, open the application menu and confirm About OpenScreen is followed by Check for Updates.
- [ ] On Windows and Linux, right-click the tray icon and confirm it lists Check for Updates and About OpenScreen. Outside the editor the tray is the only surface reachable by default there: the HUD is frameless and the editor and notes windows auto-hide their menu bar, so the Help menu appears only while Alt is held over one of those two windows.
- [ ] On Windows and Linux, open the editor, hold Alt, and confirm the Help menu lists Check for Updates and About OpenScreen.
- [ ] In the editor, click the OpenScreen wordmark in the top bar and confirm it opens a menu listing Keyboard Shortcuts, AI settings, Check for Updates and About OpenScreen. This is the discoverable path on Windows and Linux, where the two above are not.
- [ ] Confirm the About row in that menu shows the running version, and that it matches what the About box then reports.
- [ ] Open the wordmark menu and pick Keyboard Shortcuts; confirm the shortcuts configuration dialog opens and that only one dialog appears.
- [ ] Open the wordmark menu and pick AI settings; confirm it opens the same provider dialog the AI panel's gear does, and that only one dialog appears.
- [ ] Repeat that in Media mode, in Rec mode, and in Edit mode with the chat panel collapsed — the three states in which the dialog had no owner before, and the reason the row must not be Edit-only.
- [ ] Connect or disconnect a provider from the menu's dialog while the chat panel is open behind it, close the dialog, and confirm the composer and the model pill follow without reopening the panel.
- [ ] Open the wordmark menu, then press Escape, click elsewhere in the top bar, and click the wordmark again — confirm each closes it and that the window does not start dragging instead of registering the click.
- [ ] With the wordmark menu open, walk it with the Down and Up arrows and confirm focus wraps at both ends.
- [ ] Switch the app language and confirm the wordmark menu's four labels follow — the first two matching the dialogs they open, the last two the wording the macOS app menu and the tray use.
- [ ] Open About and confirm it names the running version, the Electron/Chromium/Node versions, and the install channel.
- [ ] Confirm the About box opens in front of the HUD rather than behind it.
- [ ] On Windows and Linux, press Copy in the About box and confirm the clipboard holds that same block.
- [ ] Open the HUD's device-settings panel and confirm its About row reports the same version.
- [ ] Run Check for Updates from the menu, from the tray, and from the HUD panel, and confirm each reaches the same result dialog.
- [ ] Start a second check while one is still running and confirm the HUD button stays disabled and reads "Checking…" until the first check's dialogs are done, rather than re-enabling into a click that does nothing.
- [ ] Start a recording, then confirm Check for Updates is gone from the app menu, the Help menu and the tray for as long as the take runs, and returns when it stops.
- [ ] Open the HUD's device-settings panel, start a recording with it still open, and confirm the update button disappears while the version stays. Then stop the take, reopen the panel, and confirm the button is back — a HUD that mounts mid-take must not lose it permanently.
- [ ] On a Microsoft Store, Flathub, Snap, or Nix install, confirm no update affordance appears in the menu, the tray, or the HUD panel, while the version still shows.

### New effects and controls — v1.8.0

- [ ] Set a zoom's custom scale beyond the preset levels, commit it, and confirm the preview scale and the retained value both follow.
- [ ] Activate the timeline's global auto-focus toggle and confirm every zoom switches to automatic focus.
- [ ] With the global toggle on, open a zoom's focus-mode control and confirm it reports being controlled globally instead of silently ignoring a per-zoom change.
- [ ] Turn the global toggle off and confirm per-zoom focus mode becomes settable again.
- [ ] Set a speed above the native playback limit and confirm the preview reports that it is frame-stepped and muted.
- [ ] Export that range and confirm the exported timing is correct despite the frame-stepped preview.
- [ ] Enter a speed above the maximum and confirm the limit message rather than a silently clamped value.
- [ ] Enable the webcam's shrink-on-zoom option and confirm the camera shrinks while a zoom plays and returns afterwards.
- [ ] Choose each webcam layout preset, including vertical stack and dual frame, and confirm the preview arrangement changes.
- [ ] Choose each webcam shape and confirm the mask changes in the preview.
- [ ] Turn the cursor's clip-to-canvas option off, zoom in, and confirm the cursor may extend past the frame edge; turn it on and confirm it is kept inside.
- [ ] Apply each text animation in turn and confirm the animation runs when the playhead enters the region.
- [ ] Toggle an annotation's background off and back on and confirm the previously chosen colour returns instead of black.
- [ ] Switch a blur annotation between gaussian and mosaic and confirm intensity and block-size controls follow the chosen type.
- [ ] Set a blur shape to oval and confirm the obscured area is elliptical in the preview.
- [ ] Draw a freehand blur shape and confirm the preview follows the drawn outline.
- [ ] Export a frame containing that freehand blur and confirm the export covers its bounding box, which over-covers rather than under-covers, as the inspector states.
- [ ] Add a Google font through the custom-font dialog and confirm it appears in the font selector and renders in the preview.
- [ ] Enter an invalid font URL and confirm the error message rather than a stuck adding state.
- [ ] Open the crop dialog, change the ratio with aspect lock on and off, apply, and confirm the preview reframes.
- [ ] Confirm a cropped project exports with the cropped framing rather than the original.

## Persistence (save, reopen, reload)

- [ ] Make a project change and confirm the top bar shows an unsaved indicator.
- [ ] Activate the top-bar save control by its `aria-label` and confirm the indicator changes to the saved state.
- [ ] Close and reopen the project from the Open Project dialog and confirm the asset and project title match before closing.
- [ ] Confirm clip order and each clip's in/out and crop settings survive reopen.
- [ ] Confirm trim, zoom, speed, annotation, and full-camera regions survive reopen with their positions and values.
- [ ] Confirm background, effects, layout, webcam, cursor, aspect-ratio, and caption settings survive reopen.
- [ ] Confirm the transcript and skipped-word ranges survive reopen.
- [ ] Confirm the seekable duration after reopen reaches the recording duration, not merely the end of the last region.
- [ ] Make a change, attempt to open another project, choose Cancel in the unsaved-changes prompt, and confirm the current project remains loaded.
- [ ] Make a change, choose Save in the unsaved-changes prompt, and confirm the next project opens after saving.
- [ ] Make a change, choose Discard in the unsaved-changes prompt, and confirm the next project opens without the discarded change.
- [ ] Open a project saved by a previous release and confirm it loads without a schema error.
- [ ] Confirm every modifier in that migrated project sits on the clip content it covered before, not at a shifted ruler position.
- [ ] Confirm a migrated project that had a region straddling two clips still renders it as one pill while the clips remain adjacent.
- [ ] Save the migrated project, reopen it, and confirm nothing shifted on the second round-trip.

## Platform-specific

### Windows

- [ ] Run the complete capture-to-export flow on real Windows with the packaged build.
- [ ] Confirm a screen source and a single-window source both produce non-black video.
- [ ] Confirm the system tray icon appears and changes to a recording state while recording.
- [ ] Right-click the tray icon while recording, choose Stop Recording, and confirm the editor opens.
- [ ] Confirm the HUD and notes window are excluded from captured video when content protection is enabled.
- [ ] Disable hardware H.264 if the test machine supports that diagnostic path and confirm the software-encoder notice is clear and non-blocking.
- [ ] Switch the recording HUD between displays and confirm it remains positioned on the intended display.
- [ ] Switch the desktop to an odd-pixel window size and confirm the recorded frame dimensions remain valid.
- [ ] Open Settings diagnostics when available and confirm a diagnostic bundle can be written.

### macOS

- [ ] Run the complete capture-to-export flow on real macOS with the packaged build.
- [ ] Grant screen-recording, microphone, and camera permissions and confirm the app reflects the granted devices.
- [ ] Record while switching Spaces with the HUD visible and confirm recording continues.
- [ ] Stop a recording and confirm the editor opens without a crash during native recorder shutdown.
- [ ] Confirm the tray or menu-bar item can refocus the HUD after it is hidden.
- [ ] Confirm the HUD and notes window are excluded from captured video when content protection is enabled.
- [ ] Confirm a physical webcam picture-in-picture records and plays back with the selected layout.
- [ ] Export MP4 and GIF and confirm both files open in a native macOS media viewer.
- [ ] Confirm closing and relaunching the packaged app does not leave an orphaned capture or editor window.
- [ ] On the newest supported macOS, confirm the HUD and notes windows are visible on screen rather than blanked by content protection.
- [ ] Confirm the HUD opens without waiting for the microphone permission prompt to be answered.
- [ ] Confirm local transcription reports the device it actually ran on and completes on a Metal-capable machine.
- [ ] Confirm the packaged `.app` contains the compositor addon and that the addon carries no build-machine path.
- [ ] Confirm the packaged `.app` bundles its ffmpeg libraries and runs on a machine with no developer toolchain installed.
- [ ] **On a Retina/HiDPI display**, record the screen and confirm the recorded frame is filled edge to edge — not the desktop drawn small in one corner of a black rectangle. Then do the same for a single window. Issue #418 shipped exactly this, invisible on every 1× display because a point size and a pixel size are the same number there; `SCStreamConfiguration` does not scale a frame up to fill an oversized buffer, so the surplus stays background black. Check the frame, not just the file's dimensions — the reporter's `.mp4` was 3024×1898 as expected and still wrong inside.
- [ ] **With a second display attached at a different scale factor**, record each display in turn and confirm both fill their frame. A machine whose displays all share one scale factor cannot catch a units mix-up.

### Linux

- [ ] Run the complete editor-to-export flow on real Linux with the supported packaged or development build.
- [ ] Confirm the HUD remains interactive on the supported Linux window manager.
- [ ] Select a screen source in the compositor's portal picker and confirm the resulting recording is not black.
- [ ] **Select a single WINDOW in the portal picker and confirm the recording contains only that window, at the window's dimensions — not the whole screen.** Check the pixel size, not just the look of it: `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 <file>` should report the window's size, never the monitor's. This is the case that shipped broken in 1.8.0.
- [ ] Record twice in a row and confirm the portal picker appears BOTH times, and that choosing a different source the second time actually changes what is recorded.
- [ ] Confirm the HUD shows no in-app source button on Linux, and that the record button starts a recording directly instead of opening a picker.
- [ ] Confirm the portal picker appears BEFORE the 3-2-1 countdown, not during or after it.
- [ ] Start the same flow from the editor's Rec stage ("Start recording") and confirm it behaves identically to the HUD — no source row, picker first, then countdown.
- [ ] Cancel the countdown after answering the picker and confirm the compositor's "screen is being shared" indicator goes away rather than lingering.
- [ ] Confirm the system tray or supported desktop indicator can refocus the HUD when it is hidden.
- [ ] Confirm microphone capture works with a physical device and the chosen device is audible in playback.
- [ ] Confirm the webcam toggle reflects the available physical camera or clearly reports that no camera is available.
- [ ] Confirm the native compositor preview loads without a blank surface or renderer crash.
- [ ] Export MP4 and GIF and confirm the files open in a system media player.
- [ ] Close and relaunch the app and confirm a saved project can be reopened without data loss.

## Results log

| Date | Build / tag | Platform | Pass/fail | Notes |
|------|-------------|----------|-----------|-------|
| 2026-07-31 | dev build, `claude/e2e-tests-v1-8-0-474894` (e9578f09) | macOS 26.5, M1 | Partial — 1 defect | Ran launch/HUD, media, modifier anchoring, and export. **Defect: a dangling asset blanks the preview.** Modifier anchoring across a reorder verified in preview and in the exported frames. macOS export produced 1280×720 h264 + AAC at ~2× realtime. Chat sections skipped: no AI provider configured. HUD drag not runnable under computer-use (drop point is the desktop). |
| 2026-08-13 | installed `v1.9.5-rc.1` | Windows 11 26200, 1920×1080 @ 100% | Partial — 1 defect | Ran launch/HUD, source selection, recording, stop, editor open. Fragmented MP4 confirmed on the shipped artifact: 48 `moof`+`mdat` pairs over 47.6s, `mvex` present, `mfra` on clean stop. **Defect: a recording that survives a helper kill is thrown away by the app** — killing `wgc-capture.exe` mid-recording leaves a fully decodable 41s file (2460 packets, `ffmpeg -f null -` exit 0) with no `.session.json` and no `.cursor.json`, and stop answers "The recording could not be saved". Fixed in #363, re-verified end to end. Truncation ablation at 60%: plain MP4 unreadable, fragmented plays 29s. **A dev build cannot test any of this** — the prebuilt worktree helper predated the change and silently ran the old path. Editor/export/chat sections not run. |
| 2026-08-14 | `release/v1.9.5` @ `b1b81de5` (rc.2 candidate: dev TS + the CI-built rc.1 native payload, which is byte-identical since no native source changed) | Windows 11 26200, 1920×1080 @ 100% | Pass — no defect | Regression net across the 65 commits since **v1.9.2**, not just the rc.2 delta. Four recordings. Every one a fragmented MP4 (`mvex` + ~1 `moof`/s, `mfra` only on a clean stop). GPU DXGI path still correctly opt-in (`videoInput: cpu-rgb32`) — the #336 regression has not crept back. No capture-pacing drift: HUD `00:59` → 60.067s at 60/1. Waveform correct in both directions: absent with no audio track, rendered with one. Audio muxes into the fragmented container (AAC 48k stereo) with 15 ms A/V drift, under one frame. Compositor renders and exports with no camera declared. **#366**: reopening returns to the saved project with its settings (Blur BG on, padding 9%) and mints no second project — 167→168 across a whole new recording. **#363**: helper killed mid-recording → editor opens on the recovered take (46 `moof`, no `mfra`), all three sidecars written, imported once. Export MP4 1080p60 **from that recovered take**: 46.0s / 2760 packets, decodes clean, duration matches the source exactly. Tray refocus works. NOT covered: DPI scaling — **not re-run here, already validated when `60bb6d7c` / `71cc88d6` landed**; note that the display scale is a setting, so "this machine is at 100%" is never a reason a DPI bug cannot be tested (flip it to 150%, ~2 min). Also not covered: webcam PiP and the export webcam fixes, microphone, GIF, macOS/Linux, AI sections, packaging. |
| 2026-08-14 | installed `v1.9.5-rc.1`, macOS Apple Silicon DMG (CI-built, Developer ID signed). **rc.2 is not published** — only rc.1 exists on Releases; no native source changed between `v1.9.5-rc.1` and `origin/release/v1.9.5`, so this artifact already carries the rc.2 native payload, but #366 (cross-platform TS) is absent from it | macOS 26.5 (25F71), M1, 1920×1080 @ 2× | **Fail — 1 blocker** | **The plan's assertion-1 criterion does not hold on macOS, in both directions.** On a clean stop `AVAssetWriter.finishWriting()` collapses the fragments into a normal movie: `ftyp mdat moov`, `mvex` ABSENT, 0 `moof`, no `mfra` (45 s / 44.4 MB run). That is exactly the shape the plan calls the headline failure — and the pre-`a6795d23` control recording (2026-08-10) has the *same* shape — so **a clean-stop box walk cannot distinguish fragmented from plain on macOS; only the kill test can.** Fragmenting *is* active: the takes whose writer died mid-fragment retain `mvex` + ~1 `moof` per second of media (shipped-build writer-failure samples: 35 `moof`/36.0 s, 14/15.0 s, 3/4.0 s; plus 18 on a surviving-helper kill). The one kill on the shipped build is the exception that proves the scope — capture had already stalled ~12 s before the kill, so it carries `mvex` but **0 `moof`** and only 1.0 s. No macOS file, clean or killed, ever carried `mfra`. **Blocker: every app-driven recording truncates, then the app discards it.** (Root cause and fix reported in #375 — the fragments carry a negative composition offset in a version 0 `trun`, where ISO/IEC 14496-12 8.8.8.2 defines the field as unsigned, because frame reordering was left on; `AVVideoAllowFrameReorderingKey: false` clears it and restores the crash-resilience the fragmenting was for. Verified at helper level there; **this rc.1 run only reproduced the failure and validated nothing about the fix**. Re-run this section against a CI build carrying #375 before rc.2 ships.) 3/3 takes stopped writing early while the HUD kept counting — media 4.0 s / 36.0 s / 15.0 s against HUD `02:02` / `01:30` / `01:04`. Helper emits `{"event":"error","code":"writer-failed"}`; main log `AVFoundationErrorDomain Code=-11800 … (-16341)`. Stop then hangs ~30 s on "Saving…" and drops the take: no `.session.json`, no `.cursor.json`, no editor. The app *does* surface the raw error in a toast (confirmed by hand on the same machine at 13:28–13:35 — my automated runs screenshotted after it auto-dismissed, so an earlier draft of this row wrongly said there was none). 44,561,966 / 328,337,979 / 139,631,607 / 17,187,009 bytes decodable and thrown away (147 GB free — not disk). Reproduced standalone with the shipped helper at 1080p30/8 Mbps, 2/2 (~9 s, ~5 s), so it is not confined to the app's 4K60 path — but do not read that as load-independent: append rate demonstrably modulates how reliably it bites (#375 measures it reliable at ~57 fps and intermittent at 30 fps). **Reproduced by hand, no automation involved**, on six takes recording a YouTube page — and those six separate the trigger cleanly: **system audio ON → 3/3 died at ~1.0 s and minted 0 projects; system audio OFF → 3/3 survived (3.3 s, 7.4 s, 25.0 s) and minted 1 project each.** **Audio is not the condition, only an accelerant** — a controlled run with system audio off *and not one screenshot taken during the capture* (the screenshot layer hides non-allowlisted windows, so it was the last confound worth eliminating) died the same way: 8.008 s of video, 79,004,330 bytes then flat for 76 s with the helper still alive, 7 `moof`, 0 sidecars, 0 projects, same `-11800`/`-16341`. What audio changes is the window: with a track it is ~1 s, without one ~4–40 s. That reconciles the by-hand takes with mine — a take short enough to stop before the writer dies is clean, which is why 3.3 s and 7.4 s survived and 8.0 s did not, and why the 25.0 s one minted a project while still carrying `mvex` (never cleanly finalised). **Turning audio off is therefore not a safe workaround.** Untested here: microphone — this Mac has no input device, and whether a mic track triggers the same path is an inference, not a measurement. **Helper A/B narrows the with-audio path to the fragmentation line**: helper built twice from source identical to the rc.1 tag, differing only by `writer.movieFragmentInterval` (701 vs 700 lines) — with system audio at 1080p30, WITH the line `writer-failed` 2/2 (2.0 s, 1.0 s), WITHOUT it clean `recording-stopped` 3/3 (40.6 s, 37.9 s, 37.6 s). **Read those counts as a sample, not a law**: a later rebuild of the with-the-line arm survived 22.2 s at the same settings, so the failure is probabilistic and rate-dependent, and the byte-level evidence in #375 is what actually carries the case. The video-only local-vs-shipped gap (local survived 45 s, shipped failed 5/5) is explained by the same variable rather than by the released artifact — the shipped runs encoded at 56.6 fps against 29 fps locally. **Kill test** is confounded on the shipped build (capture already dead before the kill): 17.19 MB → only 1.0 s / 56 packets, 0 `moof`. On a helper that does not fail, a mid-write kill leaves 18 `moof`, decodes clean (`ffmpeg -v error -f null -` exit 0, 1373 packets) and no `mfra` — the shape the plan expects. **#363 gap confirmed, and on macOS it fires with no kill at all**: `writer-failed` alone loses the take; there is no app-side recovery. **Audio**: AAC 48 kHz stereo muxes into the fragmented container, video start `0.000000` vs audio `0.014479` → 14.5 ms drift, under one frame at 30 fps (measured on the 2.0 s written before the writer died). **Compositor + export pass**: preview renders with no camera declared; export MP4 1080p60 H.264+AAC via `h264_videotoolbox (zero-copy VT)`, 5,726,865 bytes, 318 packets, decodes clean, duration matches to within 7 ms — source 26.713 s minus trims 19.910 + 1.513 = 5.290 s expected vs 5.283 s measured, under one frame at 60 fps. **#366 not runnable as specified** (absent from rc.1, rc.2 unpublished, and record→editor never completes); adjacent behaviour measured on an existing project — close+reopen kept 19→19 projects, exactly ONE project references the recording, and Blur BG / padding survived (`showBlur=true`, `padding=16`). NOT covered: Windows-only DPI and wgc-capture, GIF, AI sections, packaging (per plan); webcam PiP and microphone — this Mac has neither (Device settings reports "No microphone found" / "No camera found"). |
| 2026-08-22 | installed `v1.10.0-rc.3` — CI-built NSIS artifact from build run 32582966489 (`openscreen-windows`), App menu → About reports `1.10.0-rc.3`, native payload complete and uniformly stamped (19 files in `resources/electron/native/bin/win32-x64`, all `17:59:10`, so helper + compositor addon + av\* DLLs are one matched CI set) | Windows 11 26200, 1920×1080 @ 100% | **Pass — 2 minor defects** | **Pause works, and the measurement that says so is the wall clock.** `createdAt` 20:25:52.208 against a file finalised at 20:30:56.754 is 304.55 s elapsed for a **286.333 s** file — **18.21 s shorter, exactly the paused interval**, so capture was genuinely suspended. The HUD timer froze at `03:58` across two reads 7 s apart with the indicator amber, and resume was clean (`04:01` → `04:08` over 7 s, no time lost). An earlier draft of this row called this a blocking defect, on the strength of comparing the file duration against a timer read *before* the stop click; with tool round-trips of ~20 s that comparison is worthless, and the packet count offered as corroboration proves nothing either — a file is continuous 60 fps whether or not capture was ever suspended. Written down because the wrong version of this measurement is easy to repeat: compare against wall-clock elapsed, never against the last timer you happened to screenshot. **Capture is otherwise sound, on two takes.** 15.8 s: fragmented (`ftyp uuid pdin moov` then 16 `moof`/`mdat`, `mvex` present), `mfra` on the clean stop, 1920×1080 @ 60/1, 948 packets = 15.8 × 60, `ffmpeg -v error -f null -` exit 0, both sidecars written. 286.3 s: 287 `moof`, `mfra` present, 17,180 packets, decodes clean, `.cursor.json` 1.3 MB. No pacing drift and no dropped frames over 4 min 46. **Export passes and honours its settings**: 720p/30 requested from a 1080p60 source gave 1280×720, `avg_frame_rate` 85900/2863 = 30.004, 8590 packets matching the frame count the progress UI itself reported, duration 286.333 s identical to source, decodes clean, 124.5 MB, written to the path chosen in the native save dialog and reported back as "Saved to …". Composition verified by extracting a frame and reading it at full resolution (not from a preview screenshot): gradient background, content inset as a rounded card with a drop shadow, content aspect ≈1.76 against the 16:9 target, synthetic cursor drawn. Note the exporter adds a silent **AAC 48 kHz stereo** track even though no audio source was enabled. **Retracted: "the HUD language menu ignores `Escape`".** It does not — the maintainer confirms the key works by hand. **Claude Desktop swallows `Escape` before it reaches the app under test**, so a synthesised press proves nothing about the app, and `GetForegroundWindow()` returning the HUD does not rescue the inference: the key never left the driver. The companion observation (an outside click on the HUD's own drag handle did not dismiss the menu) is withdrawn with it, since the HUD's own chrome is not "outside" the popover in any meaningful sense. What *is* established is that the blur path shipped in this RC works: `54e12706 fix(hud): dismiss the HUD popovers when the window loses focus` dismissed the menu on a click to the desktop. **Rule for anyone driving keyboard checks from computer-use: `Escape` is unusable as evidence, and any negative keyboard result needs a by-hand confirmation before it goes in this table.** **Behaviour vs doc**: the record button is not disabled without a source — it opens the source selector. No recording starts, so the check's intent holds, but AGENTS.md still describes a disabled button with a "Please select a source to record" tooltip, and that is why no tooltip appears. **Passed**: single launch window, no startup crash; HUD visible under `OPENSCREEN_DISABLE_CONTENT_PROTECTION=1`; tray layout toggles horizontal↔vertical both ways; HUD drag follows the pointer without drift and stays at the drop point; language menu opens with its locale list; minimize hides the HUD without quitting (6 processes still alive); relaunching routes through the single-instance lock, restores the window and mints no duplicate; source selector opens, selecting a card enables Share, and the HUD label becomes the picked source (`Tout l'écran`); record → stop opens the editor with the asset, a timeline clip and a rendered preview; About reports the RC version. **Local transcription works, on GPU** — an earlier draft of this row reported it broken, which was wrong. Relaunching with stdout/stderr captured and importing a 15 s asset that carries an audio track settles it: `[whisper-stt] boot: model=…\whisper-ggml\ggml-small-q8_0.bin host=127.0.0.1 port=64720 threads=16`, `ggml_vulkan: 0 = NVIDIA GeForce RTX 4070 Ti`, `model loaded; backend=whispercpp-vulkan`, then `[stt] done on whispercpp-vulkan: 1 chunk(s), 15.0s audio in 0.1s (0.01 rtf, 106.8x real-time)`. The pane switched to "1 caption lines, derived live from the transcript". **The real (minor) defect is the error message**: on an asset with *no audio track* the captions pane says **"Failed to fetch"**, which reads as a network failure and sent this run hunting a broken STT server that was never involved — the pipeline simply has no audio to extract. It should say so. **Second minor find, from the same stderr**: `listProjects` cannot read three saved projects — one `ZodError` (`transcript.segments[0].endSec must be greater than or equal to startSec`, repeated across `segments`, `words` and `transcripts[0]`) and two `SyntaxError: Unexpected non-whitespace character after JSON`, i.e. truncated or double-written project files. They are skipped silently in the UI. **Caption anchoring — the rc.2→rc.3 delta — is present but its rendering was not measured.** The Position section carries exactly the model those commits describe: `Bottom`/`Top`, the note "Long captions grow upward — the bottom edge stays put", `Distance from bottom` defaulting to **1.5 %**, and Left/Center/Right. What could not be checked is where a caption actually lands, because the only transcript obtainable here came from a 300 Hz sine and yielded one line that never surfaced at any scrubbed position. **Closed out of band: the maintainer ran the caption sections by hand on a real spoken-audio recording and reports them correct**, which is the coverage this automated run could not supply and the last gap standing between this RC and a promote. Also confirmed from stderr: `[content-protection] OFF for the HUD window (OPENSCREEN_DISABLE_CONTENT_PROTECTION=1)`, so the flag does log its effect, and with the flag unset the HUD is correctly invisible to screenshots. **The consequence matters more than the cause: the eight caption anchoring/margin/inset cherry-picks that are the entire delta from rc.2 to rc.3 are NOT covered by this run.** **Not run**: restart and cancel actions; audio capture of any kind; webcam PiP; GIF; DPI scaling; HUD/notes exclusion from captured video with content protection ON (the whole session ran with it off, and the exported frame confirms the HUD *is* captured when it is off); regions, modifiers, timeline navigation, clip operations, persistence; macOS and Linux. **Environment limits that shaped this run, worth knowing before the next one.** `parsecd.exe` runs **elevated** and holds an invisible always-foreground window (`ParsecMinFrameRate16`); the moment OpenScreen loses focus every computer-use click is refused, and because the process is elevated UIPI makes granting Parsec useless — **tray-icon refocus could therefore not be tested at all**. Relaunching the app (single-instance raises it) is the way back. Dragging the HUD only works while every intermediate pointer position stays inside the HUD's own 904×698 mostly-transparent window; as soon as one lands on the desktop, the tier-"click" shell gate refuses the drag mid-gesture and leaves the button down — release it explicitly. Finally, the Microsoft Store package (`EtienneLescot.OpenScreen`, 1.9.6) **shadows the NSIS install in `request_access`**: every grant resolved to the Store bundle and the RC window stayed masked in screenshots while reporting success, until the Store package was removed. Screenshots do **not** interrupt a recording — that hypothesis was raised and disproved by running a 90 s capture with none taken and then taking one mid-capture with the helper surviving. |
| 2026-08-23 | installed `v1.10.0-rc.3` (Developer ID, unmodified) run with `OPENSCREEN_SCK_CAPTURE_EXE` pointed at a helper built from this branch | macOS 26.6.2 (25G83), M1, 1728×1117 @ 2× | Pass — fixes a blocker | **Window capture section only.** Before: selecting any window in the source picker kills the helper the instant `start()` builds its filter — `Assertion failed: (did_initialize), function CGS_REQUIRE_INIT, file CGInitialization.c, line 44`, SIGABRT, `-[SCContentFilter initWithDesktopIndependentWindow:]` → `SLSGetDisplaysWithRect`. 6/6 attempts on the shipped rc.3, no file, no error surfaced in the UI (the HUD returns to idle as if nothing happened). Display capture is unaffected and always worked, which is why this went unnoticed: the two paths diverge at `makeCaptureTarget`, and only the window branch resolves a rect through SkyLight. After: record → 25.2s → stop → **editor opened on the take**, `recording-1787475175449.mp4` 12,559,123 bytes / 25.18s / 2674×1684, the MP4 and both sidecars written (`.cursor.json`, `.session.json`), one project minted, zero crash reports. Helper-level A/B on an identical request JSON isolates the change: shipped signed helper → assertion, no file; this branch's helper → `recording-started`/`recording-stopped`, 4.49s / 1336×840 decodable MP4. NOT covered: webcam PiP, microphone, system audio (all off for these runs), export, GIF, AI/transcript sections, Windows, Linux. Not covered by unit tests either — `Package.swift` scopes the Swift test target to what runs without a screen, a display server or a TCC grant, and this crash needs all three. |
|      |             |          |           |       |
|      |             |          |           |       |
