# Manual end-to-end checklist

This checklist covers the real desktop capture-to-export path: the parts that unit, browser, and Playwright tests cannot exercise, including real screen capture, a physical webcam, the system tray, the native compositor, and export. Run it before promoting a release candidate and after any change to native capture, preview, or export.

Sections marked **v1.8.0** cover what this release changed: chat-driven editing through the agent tool set, clip-anchored modifiers, local transcription, the macOS Metal compositor, and the new effect controls. Run the whole file for a release candidate; the v1.8.0 sections are the ones with no prior release to fall back on.

## How to run this

1. Drive the real Electron app with computer-use, not a browser shim. Start a dev build with `npm run dev`, or launch the packaged build under test.
2. The app is single-instance per `userData` path. If a leftover Electron/OpenScreen process still holds the lock, stop that process before relaunching; a second launch can exit successfully without opening a window. The lock is held by the OS and is released when the process dies, so there is nothing to delete on disk.
3. From a worktree, link or junction `node_modules` to the main checkout and provide the prebuilt native capture binaries for the platform before starting the dev build.
4. Grant computer-use access to the process name that actually owns the window: `electron.exe` or `Electron.app` for a dev build, and `Openscreen.exe` or `Openscreen.app` for a packaged build. Do not grant access only to the installed app name when testing a dev build.
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
- [ ] With the Whisper helper binary absent, activate the transcribe action and confirm the UI reports why nothing happened. Observed 2026-07-31: the button produces no message, no error state, and not one line in the main-process log — a build shipped without the helper gives the user a dead button and no way to find out. Verify against a build whose helper was deliberately not packaged, not only against a working one.
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

- [ ] Activate the top-bar settings control by its `aria-label` and confirm the shortcuts configuration dialog opens.
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
|      |             |          |           |       |
|      |             |          |           |       |
