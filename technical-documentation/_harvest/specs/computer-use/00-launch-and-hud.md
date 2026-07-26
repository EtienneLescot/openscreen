# 00 — Launch window & HUD recorder

**Surface:** `LaunchWindow` (`src/components/launch/LaunchWindow.tsx`).
**Window type:** `hud-overlay` (`electron/windows.ts:87` — frameless transparent 600×160 always-on-top, bottom-centred).
**Prerequisites:** none — first spec in the run.

**Goal of this block:** prove the launch window mounts, the HUD tray behaves as expected, the language picker works, all device toggles are wired, and the record/cancel/restart flow works against the source-selector stub. This is also the block where the MCP takes the first screenshot and gets its bearings on screen coordinates.

**Reference:**
- design `openscreen-editor.html` is for the *editor*; the HUD has no design counterpart — `LaunchWindow.module.css` is the source of truth for spacing.
- inventory `openscreen-inventory.md §1` for the window graph (HUD → SourceSelector → Editor).
- the main app `electron/main.ts:588` opens `createHudOverlayWindow()` first; `electron/main.ts:304-360` builds the tray + dynamic menu.

---

## Scenario 00.1 — Launch window appears on app start

**Setup**
1. Ensure no prior Electron process is running. From a terminal: `Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force`.
2. From the repo root, run `npm run dev`. Wait for the Vite dev server line `Local:   http://localhost:5173/`.
3. Wait up to 15 s for the Electron HUD window to appear.

**Steps**
1. Take a screenshot of the foreground window. Confirm it is **transparent + frameless + bottom-centred** on the primary display.
2. Look for the HUD bar: a row of icon buttons grouped into the rec/play/stop cluster, a drag handle (the dotted icon), and a language selector on the right.
3. Read the titlebar text — should be empty (frameless, no native chrome).
4. Press `Tab` once. The first focused element must be the drag handle (`title="Drag"`). Press `Esc` to leave focus.

**Expected**
- The HUD is visible, transparent, frameless, ~160 px tall, anchored to the bottom-centre of the screen with a 20 px gap.
- The HUD contains (left → right): drag handle, monitor/source-pick button, mic toggle, volume toggle, webcam toggle, cursor-mode toggle (only on Win/macOS), divider, record button.
- The HUD's right edge holds the language selector (current locale code, e.g. `EN`) and window-control buttons (minimize, close).
- No console errors in the launched process.

---

## Scenario 00.2 — Tray layout toggles between horizontal and vertical

**Setup**
1. From scenario 00.1 state.

**Steps**
1. Right-click anywhere on the HUD bar (or press-and-hold on a touch device) — the **layout toggle** appears in a small popover. The exact trigger is in `LaunchWindow.module.css`; if not visible, click the long-press indicator for ~500 ms.
2. Click the layout toggle once. Take a screenshot.

**Expected**
- The tray layout switches from horizontal to **vertical**: buttons stack into a column inside the same frameless window, and the window grows tall enough to fit (the `electronAPI.setHudOverlaySize` IPC has fired — verifiable by re-measuring the window bounding box in the next screenshot).
- Click again → reverts to horizontal.
- The window does NOT overlap the system taskbar. If it does, fail.

---

## Scenario 00.3 — Language picker opens and lists all 13 locales

**Setup**
1. From scenario 00.2 state (back to horizontal layout).

**Steps**
1. Click the language selector on the right end of the HUD (visible label is the language's short code, e.g. `EN`, `FR`, `JA-JP`). The full set lives in `src/i18n/config.ts:30` and `SUPPORTED_LOCALES` — the menu should show all of them.
2. Take a screenshot of the opened menu.
3. Click `Français`. Wait 500 ms.
4. Take a screenshot of the HUD bar — every visible label (button tooltips, the language code itself) must now read French.

**Expected**
- The menu opens with exactly **13** entries: `English`, `العربية`, `Español`, `Français`, `Italiano`, `日本語`, `한국어`, `Русский`, `Türkçe`, `Tiếng Việt`, `Português (Brasil)`, `简体中文`, `繁體中文`.
- After clicking `Français`: the language code on the HUD reads `FR`; the menu closes; no English text remains in any HUD label.
- Pressing `Esc` while the menu is open closes it without changing the locale.
- Clicking outside the menu closes it.

---

## Scenario 00.4 — Mic toggle, microphone device selector, audio level meter

**Setup**
1. From scenario 00.3 state. Switch back to `English` first: open the language menu → click `English`.
2. Ensure the mic icon is currently OFF (default state). The mic icon shows `MdMicOff` when off, `MdMic` when on.

**Steps**
1. Click the mic toggle. Take a screenshot.
2. Hover over the mic toggle for 500 ms. A popover appears anchored above the bar (because the bar's mic-popup uses `bottom-[68px]`).
3. The popover contains the microphone device selector and the audio-level meter (`AudioLevelMeter`).
4. If the system has only one mic input, the selector shows the default device. Otherwise, click the selector and pick another device.
5. Speak into the mic (or play any audio source on the system). The audio-level meter should animate for at least 1 s.

**Expected**
- Mic icon flips between `MdMic` and `MdMicOff` on click.
- Mic-popover stays anchored to the bar and does not get clipped by the bottom of the screen.
- The audio-level meter shows live bars when sound is present.
- Picking a new mic device updates the label in the selector.
- Click outside the popover closes it.

---

## Scenario 00.5 — Webcam toggle + camera selector

**Setup**
1. From scenario 00.4 state. Close any open mic popover (click outside).

**Steps**
1. Click the webcam toggle. Take a screenshot.
2. Hover over the webcam toggle for 500 ms. The webcam popover appears with the device selector.
3. The selector lists available cameras (system camera + any USB capture devices).
4. Pick a different camera if more than one is available.

**Expected**
- Webcam icon flips between `MdVideocam` and `MdVideocamOff` on click.
- Webcam popover stays anchored to the bar.
- Selecting a camera updates the device label.
- The system will request camera permission on first activation. If permission is denied, the toggle remains off and the popover shows the unavailable state (`webcam.unavailable`).

---

## Scenario 00.6 — Cursor capture mode toggle (Win/macOS only)

**Setup**
1. From scenario 00.5 state. Close popovers.
2. Verify the platform via the launch process (this scenario only runs on Win/macOS — skip on Linux).

**Steps**
1. Locate the cursor-mode button (`MdMouse` icon).
2. Click it once. The icon must change visual style (active state has a mint background).
3. Click again. Reverts.

**Expected**
- Cursor-mode button is visible on Win/macOS only (the platform check is in `LaunchWindow.tsx:212-225`).
- Two states exist: `editable-overlay` (default) and `system`. The active state is visible by the mint background.
- The selected mode is preserved across app restarts (it lives in `userPreferences`).

---

## Scenario 00.7 — System audio toggle

**Setup**
1. From scenario 00.6 state.

**Steps**
1. Locate the system-audio button (`MdVolumeUp` / `MdVolumeOff` icon, on the bar).
2. Click it once.

**Expected**
- Icon flips between volume-on and volume-off.
- The selected state is preserved across restarts.
- On Linux/Wayland the button may be disabled with `opacity-30` — verify the disabled state matches the platform.

---

## Scenario 00.8 — Minimize / close window controls

**Setup**
1. From scenario 00.7 state.

**Steps**
1. Click the minimize button (the horizontal bar icon, `FiMinus`). The HUD window minimises.
2. Restore the HUD via the system tray icon (OpenScreen tray). Click on the tray → the HUD reappears at the same position.
3. Click the close button (`FiX`). The HUD window closes.
4. Re-open via the system tray icon.

**Expected**
- Minimize/close behave per-platform conventions.
- The HUD reappears at the same screen position and with the same dimensions.
- The tray icon (in the system tray / menu bar) shows the right-click context menu: "Open", "Quit" (and "Stop recording" if recording).

---

## Scenario 00.9 — Drag handle moves the HUD window

**Setup**
1. From scenario 00.8 state.

**Steps**
1. Pointer-down on the drag handle (`RxDragHandleDots2` icon, leftmost element of the bar).
2. Drag the HUD ~200 px to the right and ~50 px up.
3. Release.

**Expected**
- The HUD window moves with the cursor.
- The bar's bottom-centre anchor is preserved if the user drags it (i.e. the window stays anchored to its current bottom-centre).
- Closing and re-opening the HUD keeps it at the dragged position.
- The HUD does not move off-screen at the bottom — the bottom-anchor logic prevents it from going below the taskbar.

---

## Scenario 00.10 — Click source-pick button opens the Source Selector

**Setup**
1. From scenario 00.9 state.

**Steps**
1. Click the source-pick button (`MdMonitor` icon, second from the left in the bar).
2. Wait up to 5 s for a new frameless window to appear.
3. Take a screenshot.

**Expected**
- A new frameless transparent window opens, ~620×420 px, anchored to the cursor position.
- The window contains the SourceSelector component: a tabs strip at the top (`Screens (N)` / `Windows (N)`), a grid of source thumbnails, and a footer with `Cancel` + `Share` buttons.
- The source-pick button has a subtle active/pressed state while the selector is open.

---

## Scenario 00.11 — Cancel the source selector

**Setup**
1. From scenario 00.10 state (Source Selector is open).

**Steps**
1. Click the `Cancel` button (visible label is the localized string from `src/i18n/locales/en/common.json` `actions.cancel`).
2. Wait up to 3 s.

**Expected**
- The Source Selector window closes.
- The HUD bar returns to its previous state (source-pick button no longer pressed).
- No recording was started.
- No console errors.

---

## Scenario 00.12 — Hover-state reveal of auxiliary buttons

**Setup**
1. From scenario 00.11 state.

**Steps**
1. Take a baseline screenshot of the HUD bar.
2. Hover (no click) over the area just to the right of the cursor-mode button. The device-popup anchors appear.
3. Move the mouse off the bar.

**Expected**
- Auxiliary controls (mic/webcam expanded controls) reveal on hover/focus, hide on blur. They use the `hudAuxIconBtnClasses` class — slightly dimmer (`text-white/55`) than the primary buttons.
- Focus ring is visible on tab navigation.
- No layout shift visible to the user (transitions are short, <180 ms).

---

## Cross-cutting checks for this block

- After every scenario, the MCP must take a fresh screenshot and confirm the HUD's bounding box. The HUD must remain visible (not behind the editor or another app window).
- Console: any `error` console message in this block is a fail. `warn` is acceptable only for permission prompts the user dismisses.
- The MCP must NOT click the record button in this block. Recording starts in **01**.

**Next:** proceed to [`01-source-selection-and-record.md`](01-source-selection-and-record.md).