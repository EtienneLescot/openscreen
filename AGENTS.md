# AGENTS.md

OpenScreen is a free, open-source screen recorder and video editor (Electron + React + TypeScript + Pixi.js) maintained as a continuation of the original v1.5.0 release. This file is the canonical guide for any AI coding agent working in this repo.

## Setup commands

- Install deps: `npm install` (Node 22.22.1, npm 10.9.4 — see `package.json#engines`)
- Start dev:    `npm run dev` (Vite dev server; Electron window opens via `vite-plugin-electron`)
- Build:        `npm run build` (TypeScript check + Vite build + electron-builder)
- Typecheck:    `npx tsc --noEmit` — app code only. CI also runs `npx tsc -p tsconfig.test.json --noEmit` in a separate job ("Typecheck (tests)"), so **run both**: test files are invisible to the root config, and a type error in a `*.test.ts` fails CI while the root check stays green.
- Test (unit):  `npx vitest --run <path>` while you work, `npm run test` once at the end — see [Testing instructions](#testing-instructions)
- Test (e2e):   `npm run test:e2e` (Playwright)
- Lint:         `npm run lint` (Biome 2.4)
- Format:       `npm run format` (Biome, tabs, double quotes, 100-col)
- i18n check:   `npm run i18n:check` (validates the 13 locale files)

**Use npm, not bun/pnpm/yarn/Deno.** Not a style preference. Node native modules are rebuilt against Electron's ABI by electron-builder + `@electron/rebuild`, which resolve the tree through `package-lock.json`. Another package manager writes a different lockfile, so that rebuild breaks. `packageManager` + `engines` in `package.json` pin the versions; CI installs with `npm ci`. Note what this does *not* cover: the standalone Swift (macOS) and C++ (Windows) capture helpers are separate executables, built by `npm run build:native:<platform>` and only *copied* into the package as `extraResources` — `build:win` even passes `--config.npmRebuild=false`. Nothing in a normal build compiles them.

## Development principles

- Prefer the simplest solution that stays readable — no abstraction for hypothetical needs (YAGNI).
- **No mandated app-stack choice yet.** Contributors pick their own state/data library. Don't impose one across the codebase and don't refactor existing code onto a different one — keep each addition self-contained and consistent within its own module. A single choice may be enforced later.
- Don't optimize for line count. A dense one-liner that hides control flow is worse than the explicit version.
- Match the surrounding code's idiom rather than introducing a new pattern next to it.

## Project layout

- `src/` — React app: UI, editor components, timeline, i18n, captioning/cursor/exporter libs
- `electron/` — main process, IPC, recording orchestration
- `electron/native/` — **native** capture helpers: `screencapturekit/` (Swift, macOS) and `wgc-capture/` (C++/Win32, Windows). These are built and shipped with the app, not loaded from npm
- `technical-documentation/` — architecture, engineering and testing reference (start at its README)
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

### When to run what

The full unit suite is ~1670 tests over 140 files and takes over a minute. Running it after
every edit is the main way an agent turns a 5-minute task into a 30-minute one, so don't:

- **While you work** — run only what you touched: `npx vitest --run src/lib/foo.test.ts`,
  or `npx vitest --run src/lib/ai-edition` for a directory. `npm run test:changed` picks
  the affected files off the working tree, `npx vitest --run --changed main` off the
  branch diff. A single file is 1–10s against ~80s for everything.
- **Typecheck and lint freely** — `npx tsc --noEmit` and `npm run lint` are seconds, not
  minutes. They are the right inner-loop check, not the test suite.
- **Once, at the end** — `npm run test` before you commit or open the PR. One full run per
  task, not per edit. If the change is narrow and CI will run anyway, the targeted run plus
  CI is enough; say so rather than burning the wall-clock twice.
- **Never** `npm run test:watch` — it does not terminate, and it will hang the session.

### Layout and conventions

- Unit tests live next to source as `*.test.ts` / `*.test.tsx` (Vitest). Config is
  `vitest.config.ts`; it covers `src/`, `electron/` and `.github/`.
- **The default environment is `node`.** A test that needs a DOM opts in with
  `// @vitest-environment jsdom` on line 1 — that is also the fix for `document is not
  defined`. Don't add it to a test that doesn't need it: jsdom setup dominates this
  suite's runtime (see the comment in `vitest.config.ts`).
- Anything platform-conditional (`process.platform`) must pin the platform in the test.
  CI is Linux-only, so a Linux-only code path left unpinned is green in CI and red on
  every Windows and macOS machine — `electron/recording/webm-seek-index.test.ts` is the
  worked example.
- E2E tests are in `tests/e2e/` (Playwright). Some specs are platform-specific (e.g. `windows-native-checklist.spec.ts`).
- **Playwright is not the end of the e2e story.** It drives the app through CDP, which cannot reach real capture, a real webcam, the tray, or the click-through HUD. Everything those miss is covered by a manual pass driven with computer-use — see [Desktop E2E testing with computer-use](#desktop-e2e-testing-with-computer-use) below, which is required for native changes and before promoting a release candidate.
- Add a test for every new behavior in the same package as the code under test.
- All tests must pass before opening a PR. CI runs `npm run test` on every PR.
- **Which kind of test to write, and where: [`technical-documentation/testing/writing-tests.md`](technical-documentation/testing/writing-tests.md).**

## Desktop E2E testing with computer-use

**Computer-use is how the manual end-to-end pass is driven — all of it, not only the native parts.** Real capture is what forces it (native screen recording, a physical webcam, the tray: no unit or browser test reaches those), but once the app is up you drive everything the same way — editor, timeline, regions, transcript, export, settings, persistence. Screenshot and click/type on the desktop, through the **computer-use** MCP, against the actual Electron app. This is the required "manual smoke test on real Windows/macOS" for native changes, and the only mode in which the checklist below means anything.

This section is the *mechanics*. **What to actually run is [`technical-documentation/testing/manual-e2e-checklist.md`](technical-documentation/testing/manual-e2e-checklist.md)** — the capture-to-export pass, per-platform sections, and a results log to append to. Run it before promoting a release candidate and after any change to native capture, preview or export. For cursor work specifically, [`native-cursor-diagnostics.md`](technical-documentation/testing/native-cursor-diagnostics.md) gets you sidecars and reports without a full record-edit-export cycle. The checklist links back here for the mechanics below; the pairing only works if you know both halves exist.

**If the computer-use MCP is available to you, this pass is yours to run — offer it, don't hand it back.** "Manual" names the input (real OS mouse and keyboard events), not the operator; an agent holding that mouse satisfies every check in the file. So when the work calls for it — a change to native capture, preview or export, or a release candidate waiting on QA — say you can run it and run it, instead of closing with "manual e2e pass required" and leaving a maintainer to do what you were already equipped to do. `list_granted_applications` answers whether the MCP is there at all; if it is not, say *that* plainly, because then the checklist genuinely does fall to a human.

**Run whatever slice was asked for.** The whole file is one option, not the only one: a single section, one platform block, or the three checks that cover the change you just made are all legitimate runs — every row in the results log so far is a partial. What is not legitimate is silence about the rest. A check you did not run is **skipped with its reason**, never passed, and the run only exists once it is a row in the results log carrying the build/tag, the platform, and what you did not cover.

**A release candidate is the exception.** The checklist asks for the whole file before a promote, in its own opening, and that is not softened by anything above: a slice covers a *change*, never a promotion. Scope one down and the row you write says `Partial`, which is not a green light to dispatch `promote.yml`.

**Launch the app**

- Normal: `npm run dev` — Vite serves the renderer and `vite-plugin-electron` opens the Electron window. The main process logs `Global shortcut registered: CommandOrControl+Shift+O` when ready (Ctrl/Cmd+Shift+O toggles the HUD).
- **Set `OPENSCREEN_DISABLE_CONTENT_PROTECTION=1` in the environment you launch from, or the HUD is invisible in every screenshot you take.** It is a module-scope constant (`electron/windows.ts:20`), read once as the main process loads, so it cannot be turned on afterwards — you relaunch or you work blind. The main process prints `[content-protection] OFF for the HUD window` when it took effect; if that line is missing, stop and relaunch rather than hunting a HUD you will never see. What it does and when to unset it: the HUD notes below.
- The app is single-instance through `app.requestSingleInstanceLock()`, which keys on the `userData` path. If a leftover Electron process still holds it, a new launch quits silently (exit 0, no window) — kill leftover `electron` processes before relaunching. The lock is held by the OS and dies with the process, so there is nothing to clean up on disk. A dev build and the installed `Openscreen` resolve different `userData` paths and can run side by side.
- **From a git worktree** (no `node_modules`/native binaries): junction/symlink `node_modules` from the main checkout (deps are usually identical — check `package-lock.json`), and copy the prebuilt native capture binaries from `electron/native/bin/<platform>/` (gitignored — rebuilding needs the full VS/Xcode toolchain). Then `npm run dev` works normally.
- **Those binaries are frozen at whenever someone last built them, and nothing warns you.** They are not rebuilt by `npm run dev` or `npm run build`, so a helper older than the native change you came to test will run happily and silently exercise the old code path — the recording succeeds, and the thing you wanted to see is simply absent. Before trusting any native result, date the binary against the commit and search it for a string the change introduced — from the repo root:

  ```powershell
  # the string the change introduced — absent from a stale helper
  findstr /M /C:"fragmented-mp4" electron\native\bin\win32-x64\wgc-capture.exe
  # the control — present in every helper, stale or not
  findstr /M /C:"encoder-selection" electron\native\bin\win32-x64\wgc-capture.exe
  ```

  Run **both**. Only the second tells "the binary is stale" apart from "my search is broken", and that distinction is not hypothetical: `findstr` handles binaries and ships with Windows, but Git Bash has **no `strings`**, so `strings … | grep` there returns nothing and reads as a confident *absent* for every binary you point it at. Measured against the two helpers this section is about — stale: no match, then HIT; current: HIT, HIT. A control that does not hit means you learned nothing about the binary. If it is stale, rebuild it with `npm run build:native:win` (or `:mac` / `:linux`) — that is the only thing that compiles a helper. Without the toolchain, test the CI-built artifact instead; a dev build cannot answer the question.
- **And it is the whole directory, not the one binary you came for.** `electron/native/bin/<platform>/` also holds the compositor addon, the cursor sampler, the ffmpeg DLLs it dlopens, and the STT binaries — each frozen independently at whenever someone last ran a build. Refreshing only the helper leaves a mismatched set, and a mismatched set fails like a product bug: an export died on `open_input: -22 (Invalid argument)` from `compositor.exportMulti` purely because the addon was four days older than the av\* DLLs it was built against, while `ffmpeg` on the command line opened the very same file without complaint. If you are borrowing binaries from an installed build, copy the **entire** directory and diff it by hash afterwards — the last check turned up sixteen differing files and two missing outright.

**Granting access**

- `request_access` resolves names against installed apps. A **dev build runs as `electron.exe`** (or `Electron.app`), *not* the installed `Openscreen` — grant **`electron.exe`** or the dev window stays masked in screenshots. Non-allowlisted windows are masked (solid rectangles); the screenshot note lists their process names to add.
- **Start the app before asking for it.** `electron.exe` is not an installed app, so the resolver only finds it once the process exists *and* owns a window; ask any earlier and the call fails with `doesn't match any installed or running application` — and one unresolvable name short-circuits the whole request, including the names that would have resolved. Granting `Openscreen` instead is not a workaround: it resolves to `…\programs\openscreen\openscreen.exe`, so the dev window stays masked while the grant reports success.

**The HUD widget** (recording controller)

- **It is invisible in screenshots by default.** The HUD (and the Notes window) call `setContentProtection(true)` so the recording controls never end up baked into a recording — the same `SetWindowDisplayAffinity` that WGC honours also hides them from *your* screenshots. The window is there, and clicks land, but you are aiming blind at a rectangle you cannot see. Set **`OPENSCREEN_DISABLE_CONTENT_PROTECTION=1`** in the app's environment to turn it off for a session; every skipped window logs a warning. Unset it before recording anything real, or the HUD ends up in the video.
- **On macOS 26+ content protection is auto-disabled, so the HUD *is* visible and screenshottable with no flag.** That OS never displays a content-protected window at all — not just absent from captures, but never painted, leaving a tray icon, a live renderer and nothing on screen (confirmed on macOS 26.5 / Electron 41.2.1). `applyContentProtection` therefore skips the call there and logs a warning per window. The native ScreenCaptureKit helper still keeps the HUD and an open Notes window out of full-display recordings through `SCContentFilter(excludingWindows:)`; ordinary OpenScreen windows remain recordable. `OPENSCREEN_FORCE_CONTENT_PROTECTION=1` re-enables Electron's protection to re-test against a future Electron.
- The HUD is what opens the editor (clapper icon, tooltip *Open Studio*), so without that flag a whole slice of the app is unreachable from automation: killing the app to redeploy a native addon leaves you unable to reopen a project.
- Frameless, transparent, always-on-top, `skipTaskbar`, centered at the **bottom of the primary display** (`createHudOverlayWindow`, 820×560 at construction, then resized to fit its content — measured 904×698 with the bar at the bottom and mostly empty reserve above it). It is **click-through** (`setIgnoreMouseEvents(ignore)`): moving the real cursor over an interactive control makes that region clickable and shows its tooltip, so `mouse_move` → screenshot → `left_click` works; a blind click on empty HUD area passes through to the desktop.
- **Only a real OS mouse move reaches the HUD — on macOS as much as on Windows.** While the window is input-transparent Chromium delivers it no pointer events at all, so the main process samples the OS cursor instead: the `hud-overlay-cursor` poll in `electron/windows.ts` reads `screen.getCursorScreenPoint()` while the HUD is click-through and pushes the window-relative point to the renderer, which hit-tests it with `elementFromPoint(…).closest("[data-hud-interactive='true']")`. One path, both platforms — there is no platform branch. **Linux is the exception** (`!enabled && !isLinuxHud` in `LaunchWindow.tsx`, where the call is a no-op), so it is the one platform where a blind click on the HUD simply lands. What the poll keys off is the OS cursor's position *relative to the window*, so a resize or re-anchor that slides the bar under a motionless pointer produces a fresh sample too. What it can never key off is synthesised input: Playwright's `.click()`, `javascript_tool`-dispatched pointer events and everything like them move no pointer at all, so they never put one on a control. They arrive *below* the OS hit-test, fire the DOM handler, and look like they worked — while the click-through path was never exercised at all. `tests/e2e/windows-native-checklist.spec.ts` does click HUD test IDs and stays green for exactly that reason; it proves renderer wiring, not reachability, and a macOS spec written the same way would prove no more. Use computer-use (`mouse_move` → `left_click`), and never conclude from a passing injected click that a user could have clicked it. (Until #385 the lift was Electron's `{ forward: true }` — a global `WH_MOUSE_LL` hook on Windows — which Windows can revoke without telling the app, leaving the HUD painted and permanently dead. The poll replaced it. The rule for you is unchanged, because both mechanisms key off the real cursor.)
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
- ffmpeg lives at `crates/thirdparty/ffmpeg-*/bin/ffmpeg.exe` (also needed on `PATH` for the compositor addon to load).

## PR & commit conventions

- Branch from `main`; never push to it directly.
- Commit messages: short imperative summary, optional body. Recent style mixes conventional-ish prefixes (`ci:`, `chore:`, `fix:`) with plain messages — either is fine, just be consistent within a PR.
- **PR titles must follow Conventional Commits** (`feat:`, `fix:`, `chore:`, `refactor:`, `perf:`, `docs:`, `test:`, `build:`, `ci:`, `style:`, `revert:`). Enforced by the `semantic-pr` job in `ci.yml`. This feeds GitHub's auto-generated release notes with clean categories.
- Open PR via `gh pr create` once CI is green.
- PR template is in `.github/pull_request_template.md`.

## Release flow

Two `workflow_dispatch` workflows: cut an RC, then promote it to stable. **Full operational guide, branch contract, cherry-pick rules, and manual fallback: `technical-documentation/engineering/release-and-secrets.md`.** Read it before touching a release.

The one rule to know before you merge anything: **there is one release branch per stable version** (`release/vX.Y.Z`), created at rc.1 and **frozen** until promote. Only cherry-picked bugfixes land on it, so anything merged to `main` after the cut ships in the *next* cycle, not the one in flight.

## Security

- Never commit secrets. `.env.example` exists; real `.env` is gitignored.
- `macos.entitlements` controls macOS permissions — review when touching native recorder.
- Native helpers run with elevated privileges on user systems; treat code in `electron/*-helper/` as security-sensitive.

## Specialized notes

- **Native capture is platform-fragile**: macOS uses ScreenCaptureKit (Swift), Windows uses WGC (C++/Win32). CI runs on Linux only — manual smoke test on real macOS/Windows is required for native changes.
- **Pixi.js v8** is the rendering engine. Filters come from `pixi-filters` and `@pixi/filter-drop-shadow`. GSAP + `motion` for animation.
- **i18n**: 13 locales in `src/i18n/locales/<locale>/` (e.g. `src/i18n/locales/en/settings.json`). The `i18n:check` script validates them — run it after touching translation files.
- **Build pipeline**: `npm run build` is full electron-builder. For iterating on renderer only, use `npm run build-vite` (Vite + tsc, no packaging).
- **Product constraints**: the project is free forever and explicitly "not production-grade". Don't add paywalls, premium tiers, or logic that gates a feature on who the user is, and don't add upsell language to the README or UI copy. This is a hard constraint, not a judgement call. (A flag that hides an unfinished capture backend is fine — it gates on readiness, not on the user.)
