# Manual end-to-end checklist

This checklist covers the real desktop capture-to-export path: the parts that unit, browser, and Playwright tests cannot exercise, including real screen capture, a physical webcam, the system tray, the native compositor, and export. Run it before promoting a release candidate and after any change to native capture, preview, or export.

## How to run this

1. Drive the real Electron app with computer-use, not a browser shim. Start a dev build with `npm run dev`, or launch the packaged build under test.
2. The app is single-instance. If a stale process holds the lock, stop the leftover Electron/OpenScreen process and remove the per-user lock directory before relaunching; a second launch can exit successfully without opening a window.
3. From a worktree, link or junction `node_modules` to the main checkout and provide the prebuilt native capture binaries for the platform before starting the dev build.
4. Grant computer-use access to the process name that actually owns the window: `electron.exe` or `Electron.app` for a dev build, and `Openscreen.exe` or `Openscreen.app` for a packaged build. Do not grant access only to the installed app name when testing a dev build.
5. Read [AGENTS.md](../../AGENTS.md) for the computer-use mechanics, screenshot permissions, tray interaction, and cleanup procedure. Read one check, perform it, observe the result, then continue; close each modal or popover with `Esc` before the next check.
6. The recording HUD is protected from capture by default and is invisible in screenshots. For this session only, launch with `OPENSCREEN_DISABLE_CONTENT_PROTECTION=1`; this is the environment variable checked before `setContentProtection(true)`. Unset it before making any recording whose HUD must not appear in the video.
7. A preview screenshot is downscaled. Settle every pixel-level question by exporting a frame and measuring the exported frame, not by judging fine edges, corners, shadows, or alignment from the preview screenshot.
8. Keep the first real recording or imported project available for the editor sections. Log crashes, hangs, data loss, security issues, and reproducible visual failures as soon as they occur.

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

### Linux

- [ ] Run the complete editor-to-export flow on real Linux with the supported packaged or development build.
- [ ] Confirm the HUD remains interactive on the supported Linux window manager.
- [ ] Select a screen source and confirm the resulting recording is not black.
- [ ] Confirm the system tray or supported desktop indicator can refocus the HUD when it is hidden.
- [ ] Confirm microphone capture works with a physical device and the chosen device is audible in playback.
- [ ] Confirm the webcam toggle reflects the available physical camera or clearly reports that no camera is available.
- [ ] Confirm the native compositor preview loads without a blank surface or renderer crash.
- [ ] Export MP4 and GIF and confirm the files open in a system media player.
- [ ] Close and relaunch the app and confirm a saved project can be reopened without data loss.

## Results log

| Date | Build / tag | Platform | Pass/fail | Notes |
|------|-------------|----------|-----------|-------|
|      |             |          |           |       |
|      |             |          |           |       |
|      |             |          |           |       |
