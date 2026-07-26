# AGENTS.md

OpenScreen is a free, open-source screen recorder and video editor (Electron + React + TypeScript + Pixi.js) maintained as a continuation of the original v1.5.0 release. This file is the canonical guide for any AI coding agent working in this repo.

## Setup commands

- Install deps: `npm install` (Node 22.22.1, npm 10.9.4 — see `package.json#engines`)
- Start dev:    `npm run dev` (Vite dev server; Electron window opens via `vite-plugin-electron`)
- Build:        `npm run build` (TypeScript check + Vite build + electron-builder)
- Typecheck:    `npx tsc --noEmit` (CI runs this; no standalone script)
- Test (unit):  `npm run test` (Vitest, jsdom env)
- Test (browser): `npm run test:browser` (Vitest + Playwright, requires `npm run test:browser:install` first)
- Test (e2e):   `npm run test:e2e` (Playwright)
- Lint:         `npm run lint` (Biome 2.4)
- Format:       `npm run format` (Biome, tabs, double quotes, 100-col)
- i18n check:   `npm run i18n:check` (validates the 13 locale files)

## Project layout

- `src/` — React app: UI, editor components, timeline, i18n, captioning/cursor/exporter libs
- `electron/` — main process, IPC, recording orchestration
- `electron/native/` — **native** capture helpers: `screencapturekit/` (Swift, macOS) and `wgc-capture/` (C++/Win32, Windows). These are built and shipped with the app, not loaded from npm
- `docs/` — architecture, engineering roadmaps, testing guides
- `tests/` — Playwright e2e specs + fixtures
- `scripts/` — native build scripts, diagnostic tools
- `nix/`, `flake.nix` — Linux packaging
- `release/`, `dist-electron/` — build artifacts (gitignored)

## Code style

- TypeScript strict mode (`tsconfig.json`). No `any` (Biome `noExplicitAny` is `warn` — don't add new `any`).
- Biome handles lint AND format. Tabs, double quotes, 100-col width, LF line endings. Run `npm run lint:fix` before committing.
- React functional components only. Hooks at top level (Biome `useHookAtTopLevel` is `error`).
- Imports: use the `useImportType` discipline (Biome organizes them).
- Husky + lint-staged runs Biome on staged `*.{ts,tsx,js,jsx,mts,cts,json}`.
- The repo is pre-1.x and not production-grade — rough edges are expected, but new code should be clean.

## Testing instructions

- Unit tests live next to source as `*.test.ts` / `*.test.tsx` (Vitest, jsdom).
- Browser tests use `vitest.browser.config.ts` (Playwright headless) — only run when DOM/Pixi rendering matters.
- E2E tests are in `tests/e2e/` (Playwright). Some specs are platform-specific (e.g. `windows-native-checklist.spec.ts`).
- Add a test for every new behavior in the same package as the code under test.
- All tests must pass before opening a PR. CI runs `npm run test` and `npm run test:browser` on every PR.

## Desktop E2E testing with computer-use

Unit/browser tests can't exercise real capture (native screen recording, a physical webcam, the tray). To verify a recording/editor feature end to end, drive the actual Electron app with the **computer-use** MCP (screenshot + click/type on the desktop). This is the required "manual smoke test on real Windows/macOS" for native changes.

**Launch the app**

- Normal: `npm run dev` — Vite serves the renderer and `vite-plugin-electron` opens the Electron window. The main process logs `Global shortcut registered: CommandOrControl+Shift+O` when ready (Ctrl/Cmd+Shift+O toggles the HUD).
- The app is single-instance: a lock dir at `%TEMP%/openscreen-single-instance-<user>.lock` (macOS: `$TMPDIR`). If a stale Electron process holds it, a new launch quits silently (exit 0, no window). Kill leftover `electron` processes and delete that lock dir before relaunching.
- **From a git worktree** (no `node_modules`/native binaries): junction/symlink `node_modules` from the main checkout (deps are usually identical — check `package-lock.json`), and copy the prebuilt native capture binaries from `electron/native/bin/<platform>/` (gitignored — rebuilding needs the full VS/Xcode toolchain). Then `npm run dev` works normally.

**Granting access**

- `request_access` resolves names against installed apps. A **dev build runs as `electron.exe`** (or `Electron.app`), *not* the installed `Openscreen` — grant **`electron.exe`** or the dev window stays masked in screenshots. Non-allowlisted windows are masked (solid rectangles); the screenshot note lists their process names to add.

**The HUD widget** (recording controller)

- **It is invisible in screenshots by default.** The HUD (and the Notes window) call `setContentProtection(true)` so the recording controls never end up baked into a recording — the same `SetWindowDisplayAffinity` that WGC honours also hides them from *your* screenshots. The window is there, and clicks land, but you are aiming blind at a rectangle you cannot see. Set **`OPENSCREEN_DISABLE_CONTENT_PROTECTION=1`** in the app's environment to turn it off for a session; every skipped window logs a warning. Unset it before recording anything real, or the HUD ends up in the video.
- The HUD is what opens the editor (clapper icon, tooltip *Open Studio*), so without that flag a whole slice of the app is unreachable from automation: killing the app to redeploy a native addon leaves you unable to reopen a project.
- Frameless, transparent, always-on-top, `skipTaskbar`, centered at the **bottom of the primary display** (`createHudOverlayWindow`, 600×160). It is **click-through** (`setIgnoreMouseEvents(true, { forward: true })`): moving the real cursor over an interactive control makes that region clickable and shows its tooltip, so `mouse_move` → screenshot → `left_click` works; a blind click on empty HUD area passes through to the desktop.
- Control row (left→right): layout preset, **source** button (`Screen`/`Window` → label becomes the picked source), system-audio toggle, mic toggle, **webcam toggle** (shows the detected camera name), cursor-highlight toggle, **record**, notes, open-editor, language, minimize, close. The record button is disabled until a source is chosen (tooltip: "Please select a source to record").

**The tray icon** (bottom-right notification area)

- Because the HUD skips the taskbar and can be minimized/hidden, the **system-tray icon is the reliable way to refocus the app**: **left-click or double-click reopens/focuses the HUD** (`showMainWindow`). Its icon swaps to a red dot while recording.
- **Right-click → context menu**: *Open* / *Quit* when idle, or ***Stop Recording*** while recording (mirrors the HUD's stop). Tooltip shows `OpenScreen` or `Recording: <source>`. Use this to stop a recording if the HUD isn't reachable.

**End-to-end flow (record → edit)**

1. On the HUD: click the **webcam** toggle to enable the camera, then the **source** button → pick the *Screens*/*Windows* tab → select a thumbnail → **Share**.
2. Click **record**; the HUD switches to a red stop button with a running timer (a countdown overlay may show first).
3. Stop via the HUD's red button (or tray → *Stop Recording*). The **editor window opens** with the screen recording and the webcam PiP.
4. Exercise the feature in the editor (e.g. Full Camera: press **C** to add a segment on the timeline, scrub to see the webcam grow to fullscreen and ease back; **Ctrl+Z** / **Ctrl+Shift+Z** undo/redo).
5. Capture a screenshot as proof. Clean up: stop `npm run dev`, remove temporary worktree junctions/lock.

**Judging the rendered picture**

- A preview screenshot is a **downscaled** view of the compositor's output (a 1920-wide render shown in a ~600px pane, then downscaled again by the screenshot). Fine detail — a corner radius, a 1° edge slope, a soft shadow — does not survive that, and squinting at it produces confident wrong conclusions. To decide anything about pixels, **export and measure**: `Export → MP4 1080p`, then `ffmpeg -ss <t> -i out.mp4 -frames:v 1 -c:v ppm frame.ppm` and walk the raw bytes (a P6 PPM is a 15-line parser) for the exact edges. That is what settled a "the tilt is truncated" report: measured right edge 1539 px against a computed corner at 1540 — no clipping at all, the real defect was elsewhere.
- ffmpeg lives at `poc-d3d/thirdparty/ffmpeg-*/bin/ffmpeg.exe` (also needed on `PATH` for the compositor addon to load).

## PR & commit conventions

- Branch from `main`; never push to it directly.
- Commit messages: short imperative summary, optional body. Recent style mixes conventional-ish prefixes (`ci:`, `chore:`, `fix:`) with plain messages — either is fine, just be consistent within a PR.
- **PR titles must follow Conventional Commits** (`feat:`, `fix:`, `chore:`, `refactor:`, `perf:`, `docs:`, `test:`, `build:`, `ci:`, `style:`, `revert:`). Enforced by the `semantic-pr` job in `ci.yml`. This feeds GitHub's auto-generated release notes with clean categories.
- Open PR via `gh pr create` once CI is green.
- PR template is in `.github/pull_request_template.md`.

## Release flow

Two `workflow_dispatch` workflows cut a release with a pre-release candidate (RC) first, then promote to stable. Trunk-based, no extra branch. Full operational guide in `.harness/docs/git-workflow.md` § Release flow.

- **Cut RC**: Actions → "Cut a release candidate" → Run workflow. Inputs: `bump` (patch|minor|major), `rc_number` (default 1), optional `target_version` override. Snaps issues out of the rolling `Next Release` milestone into a versioned `vX.Y.Z` milestone, bumps `package.json`, pushes the `vX.Y.Z-rc.N` tag, which triggers the existing `build.yml` to publish a GitHub pre-release. Notarization is skipped on RCs. Notifies `#rc-testing` on Discord.
- **Promote RC**: Actions → "Promote RC to stable release" → Run workflow. Input: `rc_tag` (e.g. `v1.5.0-rc.2`), optional `release_notes_extra`. Closes the `vX.Y.Z` milestone, strips `-rc.N` from `package.json`, pushes `vX.Y.Z` tag, which triggers `build.yml` to publish a stable release (full notarization, Tier 3 homebrew/winget/nix/aur fires). Notifies `#announcements` on Discord.
- **Manual fallback**: `git tag vX.Y.Z-rc.N <sha> && git push origin vX.Y.Z-rc.N` does the same as Cut RC (minus the milestone migration and Discord announce) — useful for emergency cuts.

Both workflows require the `OPENSCREEN_RELEASE_TOKEN` secret (a fine-grained PAT with `contents: write` + `issues: write`). This is the standard fix for `release: published` not triggering downstream workflows when the release is created by `GITHUB_TOKEN`. See `docs/secrets.md`.

**Release branches freeze the build between cut and promote.** Every RC cut creates `release/vX.Y.Z-rc.N`. The branch is *not* merged into `main` until the stable tag is published; only cherry-picks of bugfixes land on the release branch during the RC window. The stable tag points at the branch tip (RC + cherry-picks), then `promote.yml` opens a `release/vX.Y.Z-sync → main` PR to bring main into line. This contract exists because of the v1.6.0 incident (2026-07-05) where the original promote workflow tagged `main` instead of the RC snapshot, causing 23 unreleased commits to ship in `v1.6.0`. Full rules in `.harness/docs/git-workflow.md` § Release branches.

## Security

- Never commit secrets. `.env.example` exists; real `.env` is gitignored.
- `macos.entitlements` controls macOS permissions — review when touching native recorder.
- Native helpers run with elevated privileges on user systems; treat code in `electron/*-helper/` as security-sensitive.

## Specialized notes

- **Native capture is platform-fragile**: macOS uses ScreenCaptureKit (Swift), Windows uses WGC (C++/Win32). CI runs on Linux only — manual smoke test on real macOS/Windows is required for native changes.
- **Pixi.js v8** is the rendering engine. Filters come from `pixi-filters` and `@pixi/filter-drop-shadow`. GSAP + `motion` for animation.
- **i18n**: 13 locales in `src/i18n/locales/<locale>/` (e.g. `src/i18n/locales/en/settings.json`). The `i18n:check` script validates them — run it after touching translation files.
- **Build pipeline**: `npm run build` is full electron-builder. For iterating on renderer only, use `npm run build-vite` (Vite + tsc, no packaging).
- **README tone**: the project is explicitly "not production-grade" and free forever — don't add paywalls, premium tiers, or upsell language to UI/copy.
