# Build and packaging

OpenScreen builds its renderer, Electron main process, preload bridge, native helpers, and installers from the root npm scripts, `vite.config.ts`, `electron-builder.json5`, and platform-native projects under `electron/native/`. Nix provides a separate Linux package and development shell.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Starts Vite with the Electron plugin; builds and launches main/preload unless `NO_ELECTRON` is set. |
| `npm run build-vite` | Runs TypeScript checking and Vite only. It produces `dist/` and `dist-electron/` but no installer. |
| `npm run build` | Runs TypeScript checking, Vite, then unrestricted `electron-builder`. This is the full generic packaging command, but it does not proactively build platform helpers. **On Windows, prefer `build:win`** — see [Stale native artifacts](#stale-native-artifacts). |
| `npm run build:mac` | Builds the ScreenCaptureKit and cursor helpers, checks TypeScript, runs Vite, and packages the macOS target. |
| `npm run build:win` | Builds WGC/cursor helpers and the D3D11 compositor addon, fetches FFmpeg, checks TypeScript, runs Vite, and packages the Windows NSIS target without npm rebuild. |
| `npm run build:win:store` | Performs the Windows native and renderer build, then asks electron-builder for the configured AppX Store package. |
| `npm run build:linux` | Checks TypeScript, runs Vite, then packages AppImage, Debian, pacman, and RPM artifacts without npm rebuild. Its explicit `--linux` target list overrides `linux.target` in `electron-builder.json5`, so a target added to the config alone is never built. |
| `npm run build:native:mac` | Uses SwiftPM to build requested single-architecture ScreenCaptureKit and macOS cursor helpers and stages them under `electron/native/bin/darwin-*`. |
| `npm run build:native:win` | Uses CMake/Ninja in an MSVC environment to build WGC capture and cursor-sampler executables and stage x64 binaries. |
| `npm run build:native:compositor` | Uses Cargo/MSVC and the pinned shared FFmpeg SDK to build `compositor_view.node`. |
| `npm run build:whisper-binaries` | Runs the whisper.cpp CMake build and stages the speech-to-text executable plus ggml backend sidecars for the host. |
| `npm run fetch:ffmpeg` | Downloads and stages the FFmpeg binaries used by native Windows capture/compositing paths. |
| `nix build` | Builds the flake's default Linux package with system Electron rather than electron-builder. |
| `nix develop` | Opens the Linux Node/Electron/native-build/Playwright development shell defined by the flake. |

`vite.config.ts` uses `vite-plugin-electron` to compile `electron/main.ts` and `electron/preload.ts` into `dist-electron/` while Vite emits the renderer to `dist/`. The main `tsconfig.json` is strict, covers `src` and `electron`, and has `noEmit`; TypeScript is therefore a check while Vite performs emission. `build-vite` is the renderer/Electron-bundle build used when an installer is not needed, whereas `build` continues through electron-builder.

## Native artifacts

A usable full package depends on generated artifacts that are not committed:

| Artifact | Build/staging path | Toolchain |
|---|---|---|
| Windows WGC capture helper and cursor sampler | `electron/native/bin/win32-x64/` from `electron/native/wgc-capture/build/` | Visual Studio C++ Build Tools, Windows SDK, CMake, Ninja |
| macOS ScreenCaptureKit capture helper and cursor helper | `electron/native/bin/darwin-arm64/` or `darwin-x64/` | Full Xcode, Swift, SwiftPM; Command Line Tools alone may be insufficient |
| Whisper STT server and ggml/whisper backend libraries | `electron/native/bin/<platform>-<arch>/` | CMake plus host compiler; Metal on Apple Silicon, Vulkan SDK on supported Windows/Linux builds, CPU fallback, optional CUDA |
| Native D3D11 compositor addon | `electron/native/compositor-view/build/compositor_view.node` | Rust MSVC toolchain, Visual Studio/Windows SDK, LLVM/libclang, and the exact pinned shared FFmpeg SDK |
| Native Metal compositor addon | `electron/native/bin/darwin-<arch>/compositor_view.node` (plus a dev copy under `electron/native/compositor-view/build/`) | Rust, Xcode, and the LGPL FFmpeg tree from `fetch:ffmpeg:mac` |
| FFmpeg runtime files | matching `electron/native/bin/<platform>-<arch>/` directory | Downloaded by `fetch:ffmpeg` on Windows; **built from source** by `fetch:ffmpeg:mac` on macOS (~5 min) — BtbN publishes no macOS target and every circulating macOS build is GPL, which would relicense this MIT app |

Electron-builder copies only the matching `electron/native/bin/<platform>-<arch>/` directory into each package. On both Windows and macOS the compositor `.node` ships from inside that directory, beside the ffmpeg libraries it links against, and never travels through ASAR.

### The compositor addon must sit beside its ffmpeg libraries

This is a hard requirement on Windows, not a tidiness preference.

The addon dlopens `avcodec`/`avformat`/`avutil` at `require()` time. Until 1.9.0 the Windows build shipped it inside `app.asar.unpacked/electron/native/compositor-view/build/`, one directory away from `electron/native/bin/win32-x64/*.dll`, and the gap was bridged at runtime by `ensureFfmpegSharedDllsOnPath` prepending the DLL directory to `PATH` before the require.

That works for the NSIS installer. **It does not work under MSIX**, which resolves an addon's dependent DLLs through the package graph and ignores `PATH`. Measured inside a registered package, with the directory verifiably present and correctly prepended to `PATH`:

```
dllDir existsSync   : true
require BEFORE PATH : FAILED: The specified module could not be found.
require AFTER  PATH : FAILED: The specified module could not be found.
```

and with the addon sitting beside those same DLLs, no `PATH` involved:

```
require BEFORE PATH : LOADED OK
```

Node loads `.node` files with `LOAD_WITH_ALTERED_SEARCH_PATH`, so the addon's own directory is searched for its dependencies. Colocating removes the `PATH` mechanism rather than repairing it, and works on every Windows packaging format.

This shipped: the 1.9.0 Store build loaded no compositor at all, so the editor opened with a permanently blank preview while audio kept playing — audio comes from the renderer, every frame comes from the addon. It read as an application bug rather than a packaging one, because every file was present in the package and the NSIS build of the same commit was fine. `scripts/before-pack.cjs` now refuses to package unless the addon and at least `avcodec`/`avformat`/`avutil` are in the same directory, on Windows as it already did on macOS.

`electron/native/bin/`, local native build directories, the compositor build output, models, and caches are gitignored. Rebuilding from a source checkout therefore requires the complete platform toolchain and third-party SDKs; running the generic `npm run build` alone does not manufacture missing native artifacts. The Windows compositor's D3D11/FFmpeg prerequisites are described by the source POC in `crates/README.md`, while capture helper lookup and output conventions are documented in `electron/native/README.md`.

### Stale native artifacts

**On Windows, always package with `npm run build:win`, not `npm run build`.**

`compositor_view.node` is gitignored, so it is whatever your last local Rust build produced. `npm run build` is `tsc && vite build && electron-builder` — it never invokes `build:native:compositor`. Only `build:win` does. Two ways this bites:

- You edit `crates/compositor/`, then package with `npm run build`. The installer gets the addon from before your edit.
- You create a worktree. Git does not copy gitignored files, so the worktree has no addon until one is built or copied in — usually an old one from the main checkout.

A stale addon **fails silently rather than erroring**. Scene fields are `#[serde(default)]` on the Rust side, so an addon that predates a contract change does not reject the payload: it ignores the unknown key, takes the default, and falls back to older behaviour. Nothing appears in any log, and the symptom ("the feature does nothing") is indistinguishable from a TypeScript bug. This is not hypothetical — on 2026-07-27 a build shipped an addon three days older than the commit adding `cursorSprites`, custom cursor themes silently rendered as the built-in art, and the resulting investigation blamed the wrong layer entirely.

`scripts/before-pack.cjs` runs as electron-builder's `beforePack` hook and fails the build when the addon is older than `crates/compositor/src/`, `crates/compositor-view-napi/src/`, or either `Cargo.toml`. The fix it prints is:

```bash
npm run build:native:compositor      # Windows
npm run build:native:compositor:mac  # macOS
```

**On macOS it also asserts the payload is complete**, which is a stronger check than freshness and exists because the hook used to return early on every non-Windows platform. That gap was not theoretical: the macOS CI job built the ScreenCaptureKit helper but never ran `fetch:ffmpeg:mac` or `build:native:compositor:mac`, so the `.app` it produced had no compositor addon — preview and export dead in the installed app, with nothing in any log. Nothing caught it, because the one guard that would have was Windows-only.

The hook now reads `electron/native/bin/darwin-<arch>/` — the directory `mac.extraResources` ships wholesale, so "present here" means "present in the installed app" — and refuses to package unless it holds all of:

| Required | Without it |
|---|---|
| `compositor_view.node` | preview and every export render nothing |
| `libavcodec/libavformat/libavutil.*.dylib` | the addon cannot load at all (dyld error at `require()`) |
| `whisper-stt-server` | transcription and captions fail with a developer error shown to end users |
| `libggml*.dylib` | the helper dies in dyld before `main()`; STT times out with no diagnostic |
| `openscreen-screencapturekit-helper` | native screen capture unavailable |

It then applies the same staleness comparison to the **shipped** addon (the arch-tagged copy), not the dev copy under `electron/native/compositor-view/build/`, since the arch-tagged one is what electron-builder actually packages.

CI: the Windows job runs `build:win`, which rebuilds before packaging. The macOS job spells its steps out — it needs `--dir` plus a hand-rolled DMG and signing — and had drifted from the `build:mac` recipe; it now vendors the LGPL ffmpeg tree and builds the Metal addon before packing, both cached.

The check compares modification times, so `git checkout` (which restamps source files) can occasionally flag an addon that is genuinely fine. That trade is deliberate — a false alarm costs one rebuild, whereas a missed stale addon ships a broken installer. Run `node scripts/before-pack.cjs` on its own to see the verdict without packaging.

Diagnosing a suspected stale addon: serde embeds its field-name literals in the compiled binary, so `grep -c <newCamelCaseField> compositor_view.node` returning 0 means the binary predates that contract.

## Platform packaging

### Windows

The default electron-builder target is NSIS, with an assisted installer that allows users to change the installation directory. `npm run build:win:store` explicitly selects the configured `appx` target for Microsoft Store packaging. The AppX identity, publisher, capabilities, and Store languages come from `electron-builder.json5`. Release CI builds and retains both the NSIS installer and AppX package, although the GitHub release publisher currently downloads only the `openscreen-windows` NSIS artifact.

#### Store tile assets

`win.icon` covers the NSIS installer and the executable, but **not** the Store package: AppX tiles are separate PNG assets that electron-builder reads from `<buildResources>/appx/`, meaning `build/appx/` here. When that directory does not exist it substitutes its own vendored placeholders — `SampleAppx.50x50.png`, `SampleAppx.150x150.png`, `SampleAppx.44x44.png` and `SampleAppx.310x150.png` from the winCodeSign bundle, which are blank white squares. Nothing warns about it; the package builds and installs, and the tile is simply not the product's. That is what failed Store certification 10.1.1.11 "On Device Tiles" ("The available product tile icons include a default image") on the 1.9.0 submission.

`build/appx/` is therefore committed, and `npm run assets:appx` (`scripts/generate-appx-assets.mjs`) regenerates it from `icons/icons/png/1024x1024.png` — **run it whenever the app icon changes**. No build step calls it, because generated-at-build assets would go missing exactly when someone packages from a checkout that skipped the step. The script decodes and writes PNGs directly on `node:zlib` rather than pulling an image library into the dependency tree for seven static logos.

Four of the file names are load-bearing: `StoreLogo`, `Square150x150Logo`, `Square44x44Logo` and `Wide310x150Logo` are the ones electron-builder replaces with placeholders when absent. `SmallTile`, `LargeTile` and `SplashScreen` are opt-in — their `<uap:>` manifest attributes are emitted only when a matching file is present. Each logo also ships `.scale-125/150/200` variants (plus `.scale-400` on the small assets) and, for the 44x44 app-list icon, `.targetsize-*` and `.targetsize-*_altform-unplated` variants for the taskbar and Start list. Any `.scale-`/`.targetsize-` file switches electron-builder into its `makepri.exe` path, which generates `resources.pri` and packages it alongside; the unqualified 100% file of every asset is kept as the neutral fallback candidate so an unresolved qualifier still finds art. Because `appx.backgroundColor` is `transparent`, Windows paints the tile in the user's accent colour, so the tiles are drawn as a padded logo on a transparent canvas rather than full-bleed art — and the two tiles carrying `showNameOnTiles` shift their logo up to clear the name band.

### macOS

> **The macOS job is currently disabled** (`if: false` in `build.yml`) because 1.8.0 ships Windows-only. That flag is release-branch-only and must not reach `main` when promoting, or every later release becomes Windows-only too. Until it is lifted, the macOS packaging path — including the compositor and ffmpeg steps described above — is exercised only by `npm run build:mac` locally.

Electron-builder targets DMG for both `arm64` and `x64`, enables hardened runtime, and applies `macos.entitlements` to the app and inherited code. The entitlements allow Electron JIT/native library loading and audio, camera, and screen capture. The configuration itself sets `notarize: false`; release CI packages the `.app`, creates and signs the DMG manually, submits it to `notarytool`, staples the ticket, and validates Gatekeeper. Pre-release tags go through the same path as stable ones — signing alone leaves Gatekeeper at `rejected, source=Unnotarized Developer ID`, so an RC that is signed but not notarized still forces testers to clear the quarantine attribute. Missing Apple credentials produce an ad-hoc-signed artifact.

### Linux and Nix

Electron-builder produces AppImage, `.deb`, `.pacman`, and `.rpm` targets. Each fpm target carries its own `depends` list, which *replaces* electron-builder's default rather than extending it; all three package formats therefore repeat that default verbatim before adding the Vulkan ICD (`mesa-vulkan-drivers`, `vulkan-swrast` on Arch) the native compositor needs. The RPM list also restores `libsecret`, which electron-builder includes in its `deb` default but omits from its `rpm` one, and which `safeStorage` needs to encrypt LLM credentials. The flake separately supports `x86_64-linux` and `aarch64-linux`, offers NixOS and Home Manager modules, and builds a wrapper around nixpkgs' system Electron. `nix/package.nix` runs Vite directly, installs `dist/`, `dist-electron/`, production npm dependencies, wallpapers, icons, and a desktop entry; it does not invoke electron-builder. The release workflow later opens a PR to update the Nix package version and npm dependency hash after stable releases.

## Node and toolchain versions

`package.json#engines` and `.nvmrc` both pin Node.js `22.22.1`. The package manifest pins npm `10.9.4` through both `packageManager` and `engines.npm`. The Nix shell supplies Node 22, while the shared GitHub Actions setup currently requests the Node 22 release line rather than the exact patch.

TypeScript is `5.9.3`, Vite is `7.3.2`, Electron is `41.2.1`, and electron-builder is `26.8.1` in `package.json`. Native versions are controlled by their platform tools and project files rather than a single repository-wide compiler version.
