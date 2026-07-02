# 16 — Modals, keyboard shortcuts, i18n (13 locales)

**Surface:** `Modals.tsx`, `ShortcutsContext`, `ShortcutsConfigDialog`, `I18nContext`, language picker.
**Prerequisites:** `02-editor-foundation.md`.

**Goal of this block:** prove every modal in the app opens, behaves, and closes correctly; every keyboard shortcut works; every locale (13 total) renders correctly.

**Reference:**
- design `openscreen-editor.html` — `.modal`, `.modal-card`, `.modal-backdrop`, `.modal-head`.
- `Modals.tsx:49` — `role="dialog"`.
- `Modals.tsx:51` — `aria-labelledby="modal-title"`.
- `Modals.tsx:65` — `aria-label="Close"`.
- `src/i18n/config.ts:30` — `SUPPORTED_LOCALES = [en, ar, es, fr, it, ja-JP, ko-KR, ru, tr, vi, pt-BR, zh-CN, zh-TW]`.
- `src/i18n/loader.ts` — namespace loader (`common, dialogs, editor, launch, settings, shortcuts, timeline`).

---

## Scenario 16.1 — Open the Open Project modal

**Setup**
1. Titlebar → click `Open Project` (or `File → Open Project`).

**Steps**
1. The modal opens.

**Expected**
- The modal is centered with a backdrop.
- Two columns: **Recent projects** (left) and **+ New project** (right).
- The recent list shows up to 8 projects sorted by `updatedAt` desc.
- Clicking a project opens it; clicking the `+ New project` button creates a new one.
- `Esc` closes the modal.

---

## Scenario 16.2 — Open the New Project modal

**Setup**
1. From scenario 16.1 state. Click `+ New project`.

**Steps**
1. The New Project modal opens.

**Expected**
- The modal has a title input field.
- Typing a name and clicking `Create` creates the project.
- `Esc` cancels.

---

## Scenario 16.3 — Open the Crop Video modal

**Setup**
1. Click the right rail's **Crop** button (`aria-label="Crop video"`).

**Steps**
1. The Crop modal opens.

**Expected**
- The modal has a 16:9 crop stage.
- A draggable crop rectangle.
- Aspect ratio lock / format selector.
- `Done` and `Cancel` buttons.

---

## Scenario 16.4 — Open the Unsaved Changes modal

**Setup**
1. Make a change to the project.
2. Try to close the editor.

**Steps**
1. The modal appears.

**Expected**
- 3 buttons: `Save`, `Discard`, `Cancel`.
- `Cancel` keeps the editor open with the dirty state.
- `Save` saves + closes.
- `Discard` closes without saving.

---

## Scenario 16.5 — Open the Shortcuts config dialog

**Setup**
1. Titlebar → click the keyboard icon (or Settings → Shortcuts).

**Steps**
1. The ShortcutsConfig dialog opens.

**Expected**
- The dialog lists all keyboard shortcuts.
- Each shortcut has a label and a key-binding display.
- Clicking a binding allows re-binding (press the new keys).

---

## Scenario 16.6 — Rebind a shortcut

**Setup**
1. From scenario 16.5 state.

**Steps**
1. Click on the binding for `Save Project` (default `Ctrl+S`).
2. Press `Ctrl+Shift+S`.
3. Save.

**Expected**
- The binding updates.
- The new binding works in the editor.
- The change persists across app restarts.

---

## Scenario 16.7 — Reset shortcuts to defaults

**Setup**
1. From scenario 16.6 state. Rebind 2 shortcuts.

**Steps**
1. Click `Reset to defaults`.

**Expected**
- All shortcuts revert to their default bindings.

---

## Scenario 16.8 — Open the Settings dialog (Editor Settings)

**Setup**
1. Titlebar → click the gear icon (or Left panel → Settings).

**Steps**
1. The Settings dialog opens.

**Expected**
- Multiple tabs: `General`, `Export`, `Recording`, `Audio`, `Shortcuts`.
- Each tab has its own form.

---

## Scenario 16.9 — Switch UI language to French

**Setup**
1. Open the language picker (titlebar's language button or the launch HUD's language menu).

**Steps**
1. Click `Français`.
2. Wait 500 ms.

**Expected**
- All visible UI text in the editor switches to French.
- The titlebar, panels, bottombar, modals — every label.
- No console errors.
- Press `Esc` to close the menu.

---

## Scenario 16.10 — Switch UI language to Arabic (RTL test)

**Setup**
1. From scenario 16.9 state.

**Steps**
1. Open the language picker. Click `العربية`.

**Expected**
- The UI switches to Arabic.
- The layout mirrors to RTL (text alignment flips).
- The panels / rails maintain their visual positions.

---

## Scenario 16.11 — Switch UI language to Chinese (Simplified)

**Setup**
1. Open the language picker. Click `简体中文`.

**Expected**
- The UI switches to Simplified Chinese.
- All labels are in Chinese.

---

## Scenario 16.12 — Switch UI language to Japanese

**Setup**
1. Open the language picker. Click `日本語`.

**Expected**
- The UI switches to Japanese.

---

## Scenario 16.13 — Switch through all 13 locales

**Setup**
1. Cycle through every locale: `en, ar, es, fr, it, ja-JP, ko-KR, ru, tr, vi, pt-BR, zh-CN, zh-TW`.

**Steps**
1. For each: open the menu, click the locale, wait 500 ms, take a screenshot, verify the titlebar's language code matches.

**Expected**
- Each locale renders without console errors.
- Each locale's strings come from its own `src/i18n/locales/<locale>/*.json` namespace files.

---

## Scenario 16.14 — Switch back to English

**Setup**
1. Currently in a non-English locale.

**Steps**
1. Open the menu. Click `English`.

**Expected**
- The UI switches back to English.

---

## Scenario 16.15 — Keyboard shortcut: Ctrl+Z / Cmd+Z (undo)

**Setup**
1. Project has at least one change.

**Steps**
1. Press `Ctrl+Z` (or `Cmd+Z`).
2. Read the project state.

**Expected**
- The last change is reverted.
- The change can be redone with `Ctrl+Shift+Z` (or `Cmd+Shift+Z`).

---

## Scenario 16.16 — Keyboard shortcut: Space (play/pause)

**Setup**
1. Preview is in focus.

**Steps**
1. Press `Space`.

**Expected**
- The preview plays (or pauses if already playing).

---

## Scenario 16.17 — Keyboard shortcut: T (place-skip mode)

**Setup**
1. The timeline is visible.

**Steps**
1. Press `T`.

**Expected**
- The place-skip mode is armed.
- The body class is `timeline-placing-cut`.

---

## Scenario 16.18 — Keyboard shortcut: F (add keyframe)

**Setup**
1. The timeline is visible.

**Steps**
1. Move the playhead. Press `F`.

**Expected**
- A keyframe is added at the current time.
- The keyframe appears as a tick on the timeline ruler.

---

## Scenario 16.19 — Keyboard shortcut: Ctrl+N (new project)

**Setup**
1. Editor is open.

**Steps**
1. Press `Ctrl+N`.

**Expected**
- The New Project modal opens (or a new project is created if the dirty state allows).

---

## Scenario 16.20 — Keyboard shortcut: Ctrl+O (open project)

**Setup**
1. Editor is open.

**Steps**
1. Press `Ctrl+O`.

**Expected**
- The Open Project modal opens.

---

## Scenario 16.21 — Keyboard shortcut: Ctrl+S (save)

**Setup**
1. Editor is open.

**Steps**
1. Press `Ctrl+S`.

**Expected**
- The project is saved.
- The titlebar's saved dot returns to mint.

---

## Scenario 16.22 — Modal escape closes

**Setup**
1. Any modal is open (Open Project, Provider Settings, etc.).

**Steps**
1. Press `Esc`.

**Expected**
- The modal closes.
- The state behind the modal is intact.

---

## Scenario 16.23 — Modal backdrop click closes

**Setup**
1. Any modal is open.

**Steps**
1. Click the backdrop (outside the modal card).

**Expected**
- The modal closes.

---

## Scenario 16.24 — Modal stacking

**Setup**
1. Open a modal (e.g. Provider Settings).
2. While it's open, trigger another modal (e.g. a Help popover).

**Steps**
1. Verify only one modal is in the foreground at a time.
2. Close the inner one. The outer one is still visible.

**Expected**
- The modal stack is well-managed (no overlap).
- `Esc` closes the topmost modal first.

---

## Cross-cutting checks for this block

- The 13 locale files are syntactically valid (run `npm run i18n:check` — already part of CI).
- No locale has untranslated keys (English is the fallback).
- Keyboard shortcuts work consistently across locales (the bindings are not localised, only the labels).

**Next:** proceed to [`17-themes-and-settings.md`](17-themes-and-settings.md).