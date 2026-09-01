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

The addon pulls in six ffmpeg libraries at `require()` time — `avcodec`, `avformat`, `avutil`, `swresample`, `swscale` and `avfilter`, the exact set `crates/compositor/build.rs` emits `cargo:rustc-link-lib` lines for. (`avfilter` is the newest of them: the speed-region time stretch runs through its `atempo` filter.) Until 1.9.0 the Windows build shipped it inside `app.asar.unpacked/electron/native/compositor-view/build/`, one directory away from `electron/native/bin/win32-x64/*.dll`, and the gap was bridged at runtime by `ensureFfmpegSharedDllsOnPath` prepending the DLL directory to `PATH` before the require.

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

This shipped: the 1.9.0 Store build loaded no compositor at all, so the editor opened with a permanently blank preview while audio kept playing — audio comes from the renderer, every frame comes from the addon. It read as an application bug rather than a packaging one, because every file was present in the package and the NSIS build of the same commit was fine. `scripts/before-pack.cjs` now refuses to package unless the addon and all six of those libraries are in the same directory, on Windows as it already did on macOS. It checks one requirement **per library** rather than a count over a combined pattern, on all three platforms: several versioned copies of one library (an `avcodec-60`/`61`/`62.dll` left by an earlier fetch) would satisfy a combined count while another was missing entirely, and the addon would still fail to load.

`electron/native/bin/`, local native build directories, the compositor build output, models, and caches are gitignored. Rebuilding from a source checkout therefore requires the complete platform toolchain and third-party SDKs; running the generic `npm run build` alone does not manufacture missing native artifacts. The Windows compositor's D3D11/FFmpeg prerequisites are described by the source POC in `crates/README.md`, while capture helper lookup and output conventions are documented in `electron/native/README.md`.

### Nothing Windows ships may need the Visual C++ Redistributable

`VCRUNTIME140.dll`, `VCRUNTIME140_1.dll` and `MSVCP140.dll` are **not part of Windows**. They come from the Visual C++ Redistributable, which arrives with Visual Studio, with the Rust MSVC toolchain, and with most desktop applications — so every machine that can build this repo already has them in `System32`, and so does almost every machine anyone would test on. A binary that depends on them therefore works locally, works in CI, and works in every packaging format, while being unloadable on a clean Windows image.

That is not a theoretical image. Store certification runs on one, and it rejected 1.9.1:

```text
Error: Native Windows capture exited before recording started (code=3221225781)
```

`3221225781` is `0xC0000135`, `STATUS_DLL_NOT_FOUND`. The loader killed `wgc-capture.exe` before `main()`, so the parent only ever saw an exit code, and **screen recording was impossible on the test device** while the app itself started normally — Electron already links the CRT statically, which is why the window opened at all.

The import tables of the shipped 1.9.1 payload:

| Binary | Needed from the redistributable | Symptom on a clean machine |
|---|---|---|
| `wgc-capture.exe` | `VCRUNTIME140`, `VCRUNTIME140_1`, `MSVCP140` | recording fails instantly with an exit code |
| `cursor-sampler.exe` | `VCRUNTIME140`, `VCRUNTIME140_1`, `MSVCP140` | cursor capture unavailable |
| `compositor_view.node` | `VCRUNTIME140` | `require()` fails — blank preview, audio keeps playing |

The third row matters as much as the first. It is the *same visible symptom* as the MSIX/`PATH` bug documented above, from an unrelated cause, and colocation does nothing for it. Fixing only the helper would have failed certification a second time, on the preview, and looked like a regression of a fix that was actually correct.

The fix is to link the CRT statically, which removes the dependency instead of obliging us to redistribute Microsoft's DLLs beside our own:

- CMake helpers — `set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")` in `electron/native/wgc-capture/CMakeLists.txt`. These are standalone processes that share no CRT state with anything, so `/MT` costs about 100 KB each and nothing else.
- Rust addon — `-C target-feature=+crt-static` in `crates/.cargo/config.toml`. Safe for the napi cdylib: only opaque `napi_value`s cross the boundary, and Buffers handed to Node carry a finalizer that frees, in the addon, what the addon allocated.

`scripts/before-pack.cjs` reads the import table of every `.exe`/`.dll`/`.node` in `electron/native/bin/win32-x64/` and refuses to package a binary that needs a redistributable DLL **the package does not ship**. The `api-ms-win-crt-*` api-sets are deliberately not flagged: that is the UCRT, which does ship with Windows 10 and later.

#### `vcomp140.dll`: the member that got away

The first version of that guard matched `msvcp*`/`vcruntime*`/`concrt*` and reported the payload clean. It was not. `ggml-base.dll` and `ggml-cpu.dll` are compiled with OpenMP and import **`vcomp140.dll`** — the same redistributable, under a name starting with none of those three prefixes. So after 1.9.1 was supposed to have ended this whole class of bug, transcription and captions still failed on a clean machine, in exactly the way this section describes, and the check said nothing.

Two lessons, and the second is the useful one:

- Enumerate the **family**, not the members that happened to bite: `msvcp`, `vcruntime`, `concrt`, `vcomp`, `vcamp`, `mfc`.
- A guard is only as good as the property it actually tests. This one tested "imports a redistributable DLL" when the property that matters is "imports a redistributable DLL that will not be there". Those differ precisely when the DLL is shipped alongside — which is the remedy, so the old wording forbade its own fix.

The remedy here is to ship it: `scripts/stage-vcomp-runtime.mjs` copies `vcomp140.dll` out of the Visual Studio redistributable directory into the payload, and `win.extraResources` carries it like everything else in that folder. Shipping rather than rebuilding whisper with `-DGGML_OPENMP=OFF` is deliberate — the DLL leaves the computation identical, where dropping OpenMP swaps its scheduler for ggml's own and changes transcription throughput by an amount nobody has measured. 200 KB against that unknown is a cheap trade; measure before revisiting it.

**Local testing cannot confirm this class of fix.** This machine has the redistributable and always will, so a successful run here proves the build is not broken — it says nothing about the clean-machine behaviour. The import table is the only evidence for that half, which is why the guard reads it rather than running anything.

Everything the payload needs from outside itself is now either shipped beside it or present on every Windows edition — with one exception worth knowing: `wgc-capture.exe` imports `mf.dll`, `mfplat.dll` and `mfreadwrite.dll`, and **Media Foundation is absent from Windows N editions** unless the user installs the Media Feature Pack. Recording would fail there with the same `0xC0000135` as above. Untested and unhandled; N editions are sold in Europe.

### Verifying a package actually loads

The two failures above were found by the Store, not by us, and each was fixed with a guard aimed at the failure already understood — the colocation check would never have caught the redistributable, and the import-table check would never have caught the `PATH` bug. Both are worth keeping, and neither generalises.

`scripts/verify-appx-native.ps1` is the check that does. It registers a built `.appx` and asks the Windows loader to resolve every shipped binary from inside the package: `LoadLibraryEx` with `LOAD_WITH_ALTERED_SEARCH_PATH` for each `.dll`/`.node` — the same call Node makes for an addon — and, for each helper executable, a start with no arguments. Whatever the next unresolvable dependency turns out to be, this fails on it.

```bash
powershell -File scripts/verify-appx-native.ps1 -Appx release/1.9.1/Openscreen.Setup.1.9.1.appx
```

Add `-KeepRegistered` to leave the package installed and click through the app afterwards. Loose registration needs Developer Mode; the script will not enable it for you, because that is a machine-wide setting. The `Windows Store package` job runs the same script on every build, enabling Developer Mode on the runner it is about to discard.

Two things it deliberately does not do. It never records: a real capture needs a GPU and a desktop session that a CI runner does not usefully have, and a flaky gate gets switched off — the loader is the part that broke both times, and it can be tested without either. And it proves nothing about a machine that lacks a runtime, because every runner and every developer machine has the Visual C++ Redistributable; that half is held by the import-table check in `before-pack.cjs`.

### Verifying a Linux package resolves on a clean machine

Linux repeated the Windows lesson one release later. 1.9.1 fixed the symbol-version floor and shipped three sonames that nothing declared and nothing bundled: `libgbm.so.1` and `libasound.so.2`, needed by the Electron binary itself, so a clean Ubuntu 22.04 exited `127` before any window appeared; and `libgomp.so.1`, needed by all 32 ELFs of the STT stack, so the app started and only transcription died in `ld.so`.

The symbol-version guard could not have seen it. It checks how *new* the required symbols are, not whether the libraries carrying them are ever installed — the same shape as the colocation check being blind to the redistributable. And nothing else was watching: the `deb`/`rpm`/`pacman` `depends` lists are hand-written, and electron-builder passes fpm none of `--rpm-autoreq*`, so no package format derives its own requirements.

All three hid behind the same accident. Desktop metapackages pull every one of them, `libgomp1` only via `libfftw3-single3`, `libimagequant0` and `libsoxr0` — three peripheral media libraries no desktop actually needs. Every machine anyone tested on therefore had them.

`scripts/verify-linux-package.sh` installs a built package into a **bare container** of the target distro and runs `ldd` over every ELF that ships, reporting any soname the package neither declares nor bundles. It then starts `openscreen`, `whisper-stt-server` and `openscreen-pipewire-helper`, because reaching `main()` is the part `ldd` cannot show: a binary the loader rejects exits `127` with `error while loading shared libraries`, while one that starts prints its own usage or its own structured error.

```bash
bash scripts/verify-linux-package.sh deb release/1.9.2/Openscreen-Linux-1.9.2.deb
```

The container is the point, not an implementation detail — the runner has more installed than the machines we ship to, so a check that runs on it is not a check. For the same reason the script installs no convenience tooling inside the container: `binutils` would arrive with a transitive closure that could mask what is being measured, and `ldd` is glibc, already there.

`rpm` and `pacman` are verified too, and they are the ones with no other safety net: nobody installs them often enough to report a gap quickly, and the package names genuinely differ. `libgomp.so.1` is `libgomp1` on Debian and `libgomp` on both Fedora and Arch, where it was split out of `gcc-libs` — a guess would have been wrong.

The AppImage is deliberately not covered by this check. What the check verifies is that everything a package needs is either declared or shipped, and the AppImage declares nothing — there is no manifest to verify against, so it would report every library the format legitimately expects from the host. That is the AppImage model working as intended, not a defect, and a check that cannot distinguish the two says nothing.

The exposure is instead handled at the source, which is the layer to prefer anyway. Of the three sonames 1.9.2 chased, exactly one may be bundled, and `scripts/build-whisper-stt.sh` now does: `libgomp.so.1` is a self-contained runtime, it is absent from [the AppImage project's excludelist](https://github.com/AppImage/pkg2appimage/blob/master/excludelist), and the STT binaries already carry `RUNPATH=$ORIGIN:$ORIGIN/bin`, so a copy beside them is found before the system one — no `patchelf`, no `AppRun` wrapper. The other two are on that excludelist and say why: `libgbm.so.1` is "part of mesa" and speaks to the host's DRM stack, `libasound.so.2` loads the host's ALSA plugins and configuration. A bundled copy of either is worse than none.

**Which script does the copying is the interesting part.** It belongs to the build, not to packaging, because provenance is what makes the bundled copy correct: `build-whisper-stt.yml` pins its Linux leg to `ubuntu-22.04`, the same floor `before-pack.cjs` enforces, so the library that ships comes from the same machine and the same glibc as the binaries that load it, and it travels inside the whisper artifact to every consumer. Copying it at packaging time instead would take it from whoever ran the build — and a 24.04 desktop's `libgomp` needs `GLIBC_2.38`, which the symbol-version guard then rejects, leaving a developer on a current distro unable to package at all. `scripts/stage-whisper-stt.sh` only asserts it arrived, and says to re-run the whisper workflow if it did not.

That last consequence — a developer on a current distro unable to package at all — has a supported way out, because the alternative is that nobody can test a packaging change without pushing and waiting for CI. `OPENSCREEN_SYMBOL_FLOOR=host` swaps the pinned ceiling for what this machine's own `libc.so.6` and `libstdc++.so.6` *define*, read straight out of the libraries node is already running against, so there is no `ldconfig` to parse and no `binutils` to require.

```bash
OPENSCREEN_SYMBOL_FLOOR=host npm run build:linux
```

It relaxes the ceiling rather than removing the guard: a payload needing something even the host lacks still fails, and the parser assertion that keeps the scan honest runs either way. What it gives up is the distro-floor promise, which is the promise a local build is not making — so the build prints the ceiling it substituted and says not to publish the result. Any value other than `host` is an error rather than a silent enforce or a silent waive, and the variable is **refused outright when `CI` is set**: an escape hatch that can reach a published artifact is a hole, and the runners are pinned to the floor so nothing on CI needs it. `scripts/before-pack.test.mjs` covers both refusals.

What remains host-supplied for the AppImage is the GTK/GLib/NSS stack, which no AppImage bundles — theme engines, GIO modules and pixbuf loaders all resolve against the host. `libvulkan.so.1` is already bundled at the AppImage root by electron-builder itself. For the Vulkan *driver*, which cannot be bundled, `d3d_linux::diagnose` names the Mesa package instead.

**One dependency class stays invisible to everything above**, and 1.9.3 adds it after #328: `xdg-desktop-portal`. All Linux capture goes through it — X11 included, the helper has no other path — but a portal is a D-Bus service, so it appears in no `DT_NEEDED` entry and `ldd` will never name it however bare the container is. Note precisely which half the check still holds: it cannot tell you the portal is *missing* from the list, but the install step does prove that a name you put there exists, which is what confirmed `xdg-desktop-portal` on all three distros. It hid behind the same metapackage accident as the three sonames, and it is now declared on `deb`, `rpm` and `pacman`. Declaring it is only half the fix: the frontend merely routes, and the ScreenCast implementation comes from a desktop-specific backend (`-gnome`, `-kde`, `-hyprland`, `-wlr`, `-gtk`) that no `depends` list here can choose without being wrong on half the machines. The other half is `portal.rs::portal_unavailable`, which names those backends in the error the user actually sees — the same answer `diagnose` gives for the Vulkan driver, and the only one that reaches the AppImage.

### Testing without the build machine's advantages

Every failure in this section shares one shape: **the machines we test on have more installed than the machines we ship to.** A developer box carries the Visual C++ Redistributable because Visual Studio put it there; a CI runner carries a newer glibc than the distros the README claims. Nothing run on either can reveal an absence, so "it works here" is not evidence about anything, however many times it is repeated.

Three layers address it, and the order matters:

1. **Remove the dependency at the source.** A statically linked CRT cannot be missing; a runner pinned to the oldest supported distro cannot bind symbols the user does not have. This is the only layer that needs no testing at all, so prefer it whenever there is a choice.
2. **Prove it automatically.** Static analysis for absences that are known and enumerable (`before-pack.cjs` reads import tables and ELF symbol-version needs), and a real load for everything else — `verify-appx-native.ps1` under package identity on Windows, `verify-linux-package.sh` in a bare container on Linux. Both exist because static analysis only ever knows about the mistakes already made.
3. **A pristine machine before a Store submission.** The only layer that catches a failure nobody has thought of yet.

For layer 3, keep a virtual machine whose entire value is what is *not* installed in it. VirtualBox and VMware Workstation both run on Windows 11 Home, which has neither Windows Sandbox nor Hyper-V; Microsoft publishes Windows 11 ISOs at no cost, and an unactivated install is fine for this.

**Snapshot it the moment Windows finishes installing, before anything else touches it.** That snapshot is the asset — the VM itself is disposable. Restore it after every test, and never install Visual Studio, the Rust toolchain, or anything that carries a redistributable, or it quietly becomes another machine that cannot tell you anything.

What to run inside it, cheapest first:

- **The `.exe` installer.** No Developer Mode, no ceremony, and it carries the same native binaries as the appx. Record something and open the editor: if recording starts and the preview renders, the missing-runtime class is clear for both Windows channels at once.
- **The appx**, for what is specific to MSIX — package-graph DLL resolution, which the `.exe` cannot exercise. Enable Developer Mode and run `verify-appx-native.ps1`, then launch the app by hand. Developer Mode installs no runtime, so it does not compromise what the VM is for.

Expect the compositor to report a software backend: a VM has no real GPU, and `probeBackend()` returning `"software"` there is correct, not a regression. Enable the hypervisor's 3D acceleration so the preview renders at all.

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
| `libavcodec/libavformat/libavutil/libavfilter/libswresample/libswscale.*.dylib` | the addon cannot load at all (dyld error at `require()`) |
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
#### Neither Windows artifact is signed

Unlike macOS, no Windows signing is configured anywhere in the repo. Both CI artifacts come out unsigned — confirmed by `Get-AuthenticodeSignature` on the 1.8.0 build:

| Artifact | Signature |
|---|---|
| `Openscreen.Setup.1.8.0.exe` | `NotSigned` |
| `Openscreen.Setup.1.8.0.appx` | `NotSigned` |

That the AppX is unsigned is not a defect: Microsoft signs Store submissions during certification, and the signed copy exists only in the Store. It is never handed back, so it cannot be redistributed. Two consequences worth knowing before anyone tries to "just ship the appx instead":

- **The AppX is not a drop-in replacement for the NSIS installer.** Windows runs an unsigned `.exe` after a SmartScreen prompt, but refuses outright to install an unsigned MSIX/AppX — sideloading requires a signature the machine already trusts. Swapping one for the other makes distribution strictly worse.
- **SmartScreen reputation is per file hash while the installer is unsigned**, so every release starts from zero and users meet the interstitial again on each new version. Signing would attach reputation to the publisher identity instead, and it would accumulate across releases.

Buying a certificate is the fix for the `.exe`, and it stays a live option (roughly €120/year for a cloud-HSM certificate an individual can buy, since the 2023 baseline requirements forbid keeping the key in a file). It was deliberately deferred: the Store route is already signed and already paid for through the developer account, so the README recommends it first and treats the `.exe` as the documented fallback.

### macOS

> **The macOS job is currently disabled** (`if: false` in `build.yml`) because 1.8.0 ships Windows-only. That flag is release-branch-only and must not reach `main` when promoting, or every later release becomes Windows-only too. Until it is lifted, the macOS packaging path — including the compositor and ffmpeg steps described above — is exercised only by `npm run build:mac` locally.

Electron-builder targets DMG for both `arm64` and `x64`, enables hardened runtime, and applies `macos.entitlements` to the app and inherited code. The entitlements allow Electron JIT/native library loading and audio, camera, and screen capture. The configuration itself sets `notarize: false`; release CI packages the `.app`, creates and signs the DMG manually, submits it to `notarytool`, staples the ticket, and validates Gatekeeper. Pre-release tags go through the same path as stable ones — signing alone leaves Gatekeeper at `rejected, source=Unnotarized Developer ID`, so an RC that is signed but not notarized still forces testers to clear the quarantine attribute. Missing Apple credentials produce an ad-hoc-signed artifact.

### Linux and Nix

Electron-builder produces AppImage, `.deb`, `.pacman`, and `.rpm` targets. Each fpm target carries its own `depends` list, which *replaces* electron-builder's default rather than extending it; all three package formats therefore repeat that default verbatim before adding the Vulkan ICD (`mesa-vulkan-drivers`, `vulkan-swrast` on Arch) the native compositor needs. The RPM list also restores `libsecret`, which electron-builder includes in its `deb` default but omits from its `rpm` one, and which `safeStorage` needs to encrypt LLM credentials. The flake separately supports `x86_64-linux` and `aarch64-linux`, offers NixOS and Home Manager modules, and builds a wrapper around nixpkgs' system Electron. `nix/package.nix` runs Vite directly, installs `dist/`, `dist-electron/`, production npm dependencies, wallpapers, icons, and a desktop entry; it does not invoke electron-builder. The release workflow later opens a PR to update the Nix package version and npm dependency hash after stable releases.

## Node and toolchain versions

`package.json#engines` and `.nvmrc` both pin Node.js `22.22.1`. The package manifest pins npm `10.9.4` through both `packageManager` and `engines.npm`. The Nix shell supplies Node 22, while the shared GitHub Actions setup currently requests the Node 22 release line rather than the exact patch.

TypeScript is `5.9.3`, Vite is `7.3.2`, Electron is `41.2.1`, and electron-builder is `26.8.1` in `package.json`. Native versions are controlled by their platform tools and project files rather than a single repository-wide compiler version.
