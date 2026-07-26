# 02 — Editor foundation: shell, panels, project list, save flow

**Surface:** `NewEditorShell` (`src/components/ai-edition/NewEditorShell.tsx`), `Titlebar`, `LeftPanel`, `LeftRail`, `RightPanelStack`, `RightRail`, `Modals`, `Bottombar`.
**Window type:** `editor` (`electron/windows.ts:168` — maximized, hiddenInset traffic lights on macOS, `webSecurity: false`).
**Prerequisites:** `01-source-selection-and-record.md` — at least one recording has been made, editor is open.

**Goal of this block:** prove the editor's structural surfaces (panels, rails, titlebar, project list, save/unsaved-changes flow, language + theme switching). After this block, every later block can assume the editor is the foreground window and the user has a known project loaded.

**Reference:**
- design `openscreen-editor.html` — titlebar, workbench grid, panel-stack structure.
- inventory `openscreen-inventory.md §3` — `EditorProjectData`, project file format, save flow.
- inventory `openscreen-inventory.md §5` — IPC for save / load / unsaved changes.
- `NewEditorShell.tsx:50-70` — `COLLAPSE_INITIAL = { left: false, right: true, bottom: false }`.

---

## Scenario 02.1 — Editor shell layout is correct on first open

**Setup**
1. From the end of block 01: editor is open with a recording loaded.

**Steps**
1. Take a screenshot of the editor window (maximized).
2. Identify each region by visual scan:
   - **Titlebar** (top, 34 px) — brand mark + project name + saved dot + language selector + window controls (Win/Linux) or hiddenInset traffic lights (macOS).
   - **Left rail** (vertical, 48 px) — icon buttons for `Media`, `Chat`, `Settings`, etc. (`aria-label="Left tools"`).
   - **Left panel** (320 px) — currently showing the Media tab (compositions + files).
   - **Center workbench** — preview pane (top) + transport bar (bottom of preview) + the Bottombar is collapsed by default (`rightCollapsed: true` initial state means the **right** properties panel is hidden — verify).
   - **Resize handle** between left panel and center (`aria-label="Resize left panel"`).
   - **Right rail** (vertical, 48 px) — icon buttons for `Background`, `Layout`, `Camera`, `Cursor`, `Effects`, `Crop` (`aria-label="Right tools"`).
   - **Resize handle** between center and right rail (`aria-label="Resize right panel"`).
   - **Bottom handle** (`aria-label="Resize timeline"`).
   - **Bottombar (collapsed by default)** — at the bottom, showing the timeline (it is NOT collapsed by default — only the right properties panel is). Re-verify the bottom is visible.
3. Read the timeline pane attributes: `data-clip-count`, `data-skip-count`, `data-current-time-sec`, `data-zoom-multiplier`.

**Expected**
- The window fills the screen minus the platform-specific frame.
- All four regions exist.
- The timeline is visible at the bottom (its initial height is set by `--bottom-h: 224px`).
- The right properties panel is hidden by default — only the right rail is visible.
- `data-clip-count="1"`, `data-skip-count="0"`, `data-current-time-sec="0"` (or `~0`), `data-zoom-multiplier="1"`.
- The preview's `data-testid="preview"` element is visible.
- No console errors.

---

## Scenario 02.2 — Open existing project via the project list

**Setup**
1. From scenario 02.1 state.
2. The LeftPanel's **Media** tab should be active (default).

**Steps**
1. In the LeftPanel, locate the **Compositions** section (top).
2. Take a screenshot. The list should show the current project as active (mint background, check mark).
3. Locate the **Files** section. The current recording should appear as an asset row with its filename and duration.
4. Click the `+` button next to the Compositions header (opens the `OpenProjectModal`).
5. The modal appears: it has two columns — **Recent projects** (left) and **+ New project** (right).

**Expected**
- The current project's row is marked active.
- The Files list shows the just-recorded file with its duration (e.g. `0:05`).
- The `+` button opens the modal; the modal is a centered card with a backdrop.
- The Recent Projects column is populated (at minimum the current project; possibly older ones from `userData/projects/`).
- Press `Esc` to close the modal.

---

## Scenario 02.3 — Create new project

**Setup**
1. From scenario 02.2 state (modal closed).

**Steps**
1. Click the `+` button in Compositions.
2. In the OpenProjectModal, click the `+ New project` card on the right side.
3. A `NewProjectModal` appears (or the same modal switches view).
4. Enter a project title in the input (e.g. `Test Project Alpha`).
5. Click `Create`.

**Expected**
- The editor reloads with a fresh, empty project.
- The LeftPanel's Compositions now lists `Test Project Alpha` as active.
- The Files section is empty.
- The preview shows the empty state (`data-testid="preview"` with no clip loaded).
- The timeline shows the empty-state message: `Drag a video from the media panel here to start your timeline.`
- The `data-clip-count` is `0`.

---

## Scenario 02.4 — Rename the current project

**Setup**
1. From scenario 02.3 state (Test Project Alpha is active).

**Steps**
1. Click the project name in the titlebar (the visible text is `Test Project Alpha`). A button.
2. The titlebar reveals an inline input.
3. Type `Test Project Beta`. Press `Enter`.

**Expected**
- The titlebar updates to `Test Project Beta`.
- The `data-project-name` (if present) reflects the new name.
- Pressing `Esc` cancels the rename (verify by clicking again and pressing `Esc`).
- Clicking outside the input also saves the rename.

---

## Scenario 02.5 — Open a different project from Recent

**Setup**
1. From scenario 02.4 state.
2. First, generate another project: re-record a short clip, stop, the editor opens with a new take. (Repeat 01.5–01.8 with a different source if needed — or use any of the existing fixture files.)

**Steps**
1. Open the OpenProjectModal (`+` button).
2. Click on the first project (the one created in 02.3) in the Recent list.
3. The modal closes; the editor reloads.

**Expected**
- The editor's preview shows the previously-saved project's content.
- The titlebar reflects the project name.
- The Files list is populated with the previously-loaded asset.

---

## Scenario 02.6 — Left panel tabs switch

**Setup**
1. From scenario 02.5 state.

**Steps**
1. Click the **Media** tab button on the left rail.
2. Click the **Chat** tab button on the left rail.
3. Click the **Settings** tab button on the left rail.
4. Click back to **Media**.

**Expected**
- The left panel's content swaps between tabs.
- **Media**: Compositions + Files sections.
- **Chat**: Chat history + composer (only if `AI_FEATURES_ENABLED`). If the flag is off, the chat tab is hidden.
- **Settings**: General / Export / Recording / Audio / Shortcuts tabs.
- The active tab on the rail has the mint accent (left-border indicator).
- Selecting the Chat tab auto-opens the chat panel if collapsed.

---

## Scenario 02.7 — Left panel collapse/expand

**Setup**
1. From scenario 02.6 state.

**Steps**
1. Drag the resize handle (`aria-label="Resize left panel"`) left by 80 px.
2. Drag it right by 160 px (past the original position).
3. Click the `<<` collapse button (the small caret on the resize handle).
4. Click the `>>` expand button.

**Expected**
- The left panel width changes during the drag.
- The collapse button tucks the panel down to the rail-only state.
- The expand button restores the previous width.
- The right panel and the preview both resize in response.
- The collapse state persists across restarts (in `localStorage["openscreen-workbench"]` or similar).

---

## Scenario 02.8 — Right panel (properties) collapse/expand

**Setup**
1. From scenario 02.7 state.

**Steps**
1. The right rail is visible, the right panel itself is collapsed (default initial state).
2. Click any right-rail button (e.g. **Background**).
3. The right panel opens, showing the Background pane (image grid + gradient grid + custom upload).
4. Click another right-rail button (e.g. **Layout**). The panel swaps content.
5. Drag the resize handle (`aria-label="Resize right panel"`) left by 50 px.
6. Click the collapse button on the right handle.
7. Click the expand button.

**Expected**
- Right-rail buttons toggle the right panel's visibility and content.
- The right panel width changes during the drag.
- The collapse/expand state persists.
- The active right-rail button has the mint accent.

---

## Scenario 02.9 — Bottom timeline collapse/expand

**Setup**
1. From scenario 02.8 state.

**Steps**
1. The bottom timeline is visible.
2. Drag the resize handle (`aria-label="Resize timeline"`) up by 60 px.
3. Click the collapse button on the handle.
4. Click the expand button.

**Expected**
- The bottom pane height changes during the drag.
- Collapse tucks it down to ~32 px (a thin strip with the timeline header only).
- Expand restores the previous height.
- The collapse state persists.

---

## Scenario 02.10 — Save project (no changes → no-op)

**Setup**
1. From scenario 02.9 state. Make sure the project is in a clean state (just opened).

**Steps**
1. Press `Ctrl+S` (or `Cmd+S` on macOS).

**Expected**
- The titlebar's "saved" indicator remains green (the dot stays mint, no spinner).
- No save dialog appears (the path is the same).
- No console errors.

---

## Scenario 02.11 — Save project after edit (dirty flag visible)

**Setup**
1. Make a trivial change to the project (e.g. add a zoom region — see 07.1 for the recipe; or click `Magic` button on the bottom bar).
2. Take a screenshot.

**Steps**
1. The titlebar's "saved" indicator should now show a yellow/warning state or an unsaved dot (implementation-specific — verify the dot is no longer green).
2. Press `Ctrl+S`.

**Expected**
- A save dialog opens if `currentProjectPath` is unset (new project) — verify the user is prompted for a path.
- If the path is set, no dialog opens; the save completes silently.
- After save, the "saved" dot returns to mint.
- The file `userData/projects/<projectId>.openscreen` (or `.axcut`) is updated — verify by listing the directory.

---

## Scenario 02.12 — Unsaved changes prompt on close

**Setup**
1. Make a change (trivially: open a clip, change a setting).
2. Confirm the saved dot is dirty.

**Steps**
1. Close the editor window (X button on Win/Linux; red traffic light on macOS).
2. An `UnsavedChangesModal` appears.
3. The modal has 3 choices: `Save`, `Discard`, `Cancel`.
4. Click `Cancel`. The editor window stays open.
5. Close again. Click `Discard`. The window closes without saving.
6. Reopen. The previous state is lost (or kept depending on which path the OS re-loads).

**Expected**
- The modal is centered with a backdrop.
- `Cancel` keeps the editor open and the dirty state.
- `Discard` closes the window (the IPC `close-confirm-response="discard"` fires; see `electron/main.ts:395-426`).
- `Save` (not exercised here — exercised in 02.13).

---

## Scenario 02.13 — Unsaved → Save closes the editor

**Setup**
1. Make a change.
2. Close the editor.

**Steps**
1. Click `Save`.
2. If the project is new, a save-as dialog appears.
3. Pick a location, confirm. The editor closes.
4. Reopen the project from `Recent`. The saved state is loaded.

**Expected**
- Save path is `userData/projects/<id>.openscreen` (legacy) or `userData/projects/<id>.axcut` (v3) — see `electron/ai-edition/document-service.ts` for the writer.
- The file is valid JSON (parse it via `Get-Content | ConvertFrom-Json` to verify).

---

## Scenario 02.14 — Application menu File operations

**Setup**
1. Editor is open.

**Steps**
1. From the OS application menu, click `File → New Project` (or `Ctrl+N`). A `NewProjectModal` appears.
2. Cancel it.
3. `File → Open Project` (`Ctrl+O`). The `OpenProjectModal` appears.
4. Cancel it.
5. `File → Save Project` (`Ctrl+S`). Same as scenario 02.10/02.11.
6. `File → Save Project As` (`Ctrl+Shift+S`). The save-as dialog opens.

**Expected**
- Each menu item triggers its respective IPC channel (`menu-new-project`, `menu-load-project`, etc. — see `electron/preload.ts:202-225`).
- The behaviour matches the corresponding in-app buttons.

---

## Scenario 02.15 — System tray / menu integration

**Setup**
1. Editor is open.

**Steps**
1. Find the OpenScreen icon in the system tray (Win: bottom-right; macOS: menu bar).
2. Right-click. The menu shows: `Open`, `Quit`.
3. Click `Open`. The editor comes to the foreground (no-op if already foreground).
4. Right-click again. Click `Quit`. The entire app exits.

**Expected**
- The tray menu reflects the current state (no `Stop recording` unless recording).
- `Quit` cleanly closes all windows.

---

## Scenario 02.16 — Titlebar "New recording" button returns to HUD

**Setup**
1. Editor is open.

**Steps**
1. Click the titlebar's `New recording` button (`aria-label="New recording"`). Located in the titlebar's left-side action cluster.

**Expected**
- The editor window closes (or hides).
- The HUD window reappears.
- No new recording starts — this is a "go back to recorder" action; recording starts from the HUD.
- Project state is preserved (the dirty flag persists if there are unsaved changes — but the user has to manually save first; no auto-save).

---

## Scenario 02.17 — Empty-state messaging

**Setup**
1. Create a brand new empty project (scenario 02.3).

**Steps**
1. Take a screenshot. The preview shows an empty-state message.
2. The timeline shows: `Drag a video from the media panel here to start your timeline.`
3. The bottombar's action buttons (Magic, Zoom+, Captions) are **disabled**.

**Expected**
- The empty-state text matches the i18n string in `src/i18n/locales/en/timeline.json` (or `editor.json`).
- The disabled buttons have reduced opacity and a `cursor: not-allowed`.
- Adding an asset to the project (drag-drop into the Files list) clears the empty state.

---

## Cross-cutting checks for this block

- Every modal opened in this block must close cleanly with `Esc` and with backdrop-click (where applicable).
- The workbench layout (panel widths, collapse states) persists across an app restart.
- The project title persists across renames + restarts.

**Next:** proceed to [`03-transport-and-preview.md`](03-transport-and-preview.md).