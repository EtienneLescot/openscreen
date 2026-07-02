# 17 — Theme, settings dialog, preferences

**Surface:** `useTheme`, `NewEditorShell.module.css` (theme variables), `Settings` (within `Modals.tsx` or `LeftPanel.tsx`), `userPreferences.ts`.
**Prerequisites:** `02-editor-foundation.md`.

**Goal of this block:** prove dark / light theme switching works, the Settings dialog (general / export / recording / audio tabs) works, and user preferences persist.

**Reference:**
- design `DESIGN.md` — token tables for both themes.
- design `openscreen-editor.html` — `:root` and `:root[data-theme="dark"]` CSS variables.
- `src/index.css:7-61` — theme variable definitions.
- `useTheme.ts` — theme toggle hook.
- `loadUserPreferences` / `saveUserPreferences` (`src/lib/userPreferences.ts`).

---

## Scenario 17.1 — Initial theme (dark)

**Setup**
1. Open the editor.

**Steps**
1. Take a screenshot.

**Expected**
- The default theme is **dark** (per the design — `index.html` root background `#09090b`).
- All design tokens reflect dark values (`--bg: #0a0d12`, `--fg: #e6e9ef`, etc.).

---

## Scenario 17.2 — Switch to light theme

**Setup**
1. From scenario 17.1 state.

**Steps**
1. Open Settings (or the theme toggle button if exposed in the titlebar).
2. Switch to `Light`.

**Expected**
- The editor's `data-theme` attribute becomes `light` (or the `:root` no longer has `data-theme="dark"`).
- All colors switch to the light palette (`--bg: #fafbfc`, `--fg: #1f2937`).
- The contrast is preserved (AA-grade).
- The change is immediate.

---

## Scenario 17.3 — Switch back to dark theme

**Setup**
1. From scenario 17.2 state.

**Steps**
1. Switch back to `Dark`.

**Expected**
- The theme returns to dark.

---

## Scenario 17.4 — Theme persists across app restarts

**Setup**
1. From scenario 17.3 state. Switch to light theme.

**Steps**
1. Quit the app. Re-launch.

**Expected**
- The theme is still light.

---

## Scenario 17.5 — Theme + language combined persistence

**Setup**
1. Set theme = dark, language = French.

**Steps**
1. Quit the app. Re-launch.

**Expected**
- Theme = dark, language = French.

---

## Scenario 17.6 — Settings dialog: General tab

**Setup**
1. Open the Settings dialog.

**Steps**
1. Click the `General` tab.

**Expected**
- The General tab contains:
  - Theme selector.
  - Language selector.
  - Auto-save toggle.
  - Behaviour preferences (auto-open editor on stop, etc.).

---

## Scenario 17.7 — Settings dialog: Export tab

**Setup**
1. Open the Settings dialog.

**Steps**
1. Click the `Export` tab.

**Expected**
- The Export tab contains:
  - Default export format (MP4 / GIF).
  - Default quality preset.
  - Default fps.
  - Default codec.
  - Default output directory.

---

## Scenario 17.8 — Settings dialog: Recording tab

**Setup**
1. Open the Settings dialog.

**Steps**
1. Click the `Recording` tab.

**Expected**
- The Recording tab contains:
  - Default cursor capture mode.
  - Default microphone device.
  - Default system audio toggle.
  - Default webcam toggle.
  - Countdown duration (default 3 s).

---

## Scenario 17.9 — Settings dialog: Audio tab

**Setup**
1. Open the Settings dialog.

**Steps**
1. Click the `Audio` tab.

**Expected**
- The Audio tab contains:
  - Audio input device.
  - Audio processing options (noise suppression, AGC).
  - Audio level meter calibration.

---

## Scenario 17.10 — Tray layout preference (horizontal / vertical)

**Setup**
1. The HUD has both layouts available (scenario 00.2).

**Steps**
1. Switch the HUD to vertical.
2. Quit the app. Re-launch.

**Expected**
- The HUD opens in vertical mode.

---

## Scenario 17.11 — Cursor capture mode preference

**Setup**
1. Switch the cursor mode to `system` (scenario 00.6).

**Steps**
1. Quit the app. Re-launch.

**Expected**
- The cursor mode is still `system`.

---

## Scenario 17.12 — Theme + recording preferences together

**Setup**
1. Set: theme = dark, language = en, cursor mode = system, tray layout = vertical, mic = enabled.

**Steps**
1. Quit the app. Re-launch.

**Expected**
- All preferences are preserved.

---

## Scenario 17.13 — Reset all preferences to defaults

**Setup**
1. From any preferences state.

**Steps**
1. Open Settings. Click `Reset to defaults`.

**Expected**
- All preferences revert to their factory defaults.
- A confirmation prompt may appear.

---

## Cross-cutting checks for this block

- Theme switching does not require a reload (it's live CSS variable swap).
- The dark theme is the default on first launch.
- The language picker shows all 13 locales.
- The preferences are stored in `userData/userPreferences.json` (or similar).

**Next:** proceed to [`18-final-qa-checklist.md`](18-final-qa-checklist.md).