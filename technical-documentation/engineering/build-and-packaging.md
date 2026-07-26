# Build and packaging

OpenScreen builds its renderer, Electron main process, preload bridge, native helpers, and installers from the root npm scripts, `vite.config.ts`, `electron-builder.json5`, and platform-native projects under `electron/native/`. Nix provides a separate Linux package and development shell.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Starts Vite with the Electron plugin; builds and launches main/preload unless `NO_ELECTRON` is set. |
| `npm run build-vite` | Runs TypeScript checking and Vite only. It produces `dist/` and `dist-electron/` but no installer. |
| `npm run build` | Runs TypeScript checking, Vite, then unrestricted `electron-builder`. This is the full generic packaging command, but it does not proactively build platform helpers. |
| `npm run build:mac` | Builds the ScreenCaptureKit and cursor helpers, checks TypeScript, runs Vite, and packages the macOS target. |
| `npm run build:win` | Builds WGC/cursor helpers and the D3D11 compositor addon, fetches FFmpeg, checks TypeScript, runs Vite, and packages the Windows NSIS target without npm rebuild. |
| `npm run build:win:store` | Performs the Windows native and renderer build, then asks electron-builder for the configured AppX Store package. |
| `npm run build:linux` | Checks TypeScript, runs Vite, then packages AppImage, Debian, and pacman artifacts without npm rebuild. |
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
| FFmpeg runtime files | matching `electron/native/bin/<platform>-<arch>/` directory | Downloaded by `fetch:ffmpeg` for the Windows build path |

Electron-builder copies only the matching `electron/native/bin/<platform>-<arch>/` directory into each package. The compositor `.node` file is included by the Windows `files` rule and unpacked from ASAR because native addons cannot be loaded from inside the archive.

`electron/native/bin/`, local native build directories, the compositor build output, models, and caches are gitignored. Rebuilding from a source checkout therefore requires the complete platform toolchain and third-party SDKs; running the generic `npm run build` alone does not manufacture missing native artifacts. The Windows compositor's D3D11/FFmpeg prerequisites are described by the source POC in `poc-d3d/README.md`, while capture helper lookup and output conventions are documented in `electron/native/README.md`.

## Platform packaging

### Windows

The default electron-builder target is NSIS, with an assisted installer that allows users to change the installation directory. `npm run build:win:store` explicitly selects the configured `appx` target for Microsoft Store packaging. The AppX identity, publisher, capabilities, and Store languages come from `electron-builder.json5`. Release CI builds and retains both the NSIS installer and AppX package, although the GitHub release publisher currently downloads only the `openscreen-windows` NSIS artifact.

### macOS

Electron-builder targets DMG for both `arm64` and `x64`, enables hardened runtime, and applies `macos.entitlements` to the app and inherited code. The entitlements allow Electron JIT/native library loading and audio, camera, and screen capture. The configuration itself sets `notarize: false`; release CI packages the `.app`, creates and signs the DMG manually, submits stable tags to `notarytool`, staples the ticket, and validates Gatekeeper. Pre-release tags skip DMG signing/notarization, and missing Apple credentials produce an unsigned artifact.

### Linux and Nix

Electron-builder produces AppImage, `.deb`, and `.pacman` targets. The flake separately supports `x86_64-linux` and `aarch64-linux`, offers NixOS and Home Manager modules, and builds a wrapper around nixpkgs' system Electron. `nix/package.nix` runs Vite directly, installs `dist/`, `dist-electron/`, production npm dependencies, wallpapers, icons, and a desktop entry; it does not invoke electron-builder. The release workflow later opens a PR to update the Nix package version and npm dependency hash after stable releases.

## Node and toolchain versions

`package.json#engines` and `.nvmrc` both pin Node.js `22.22.1`. The package manifest pins npm `10.9.4` through both `packageManager` and `engines.npm`. The Nix shell supplies Node 22, while the shared GitHub Actions setup currently requests the Node 22 release line rather than the exact patch.

TypeScript is `5.9.3`, Vite is `7.3.2`, Electron is `41.2.1`, and electron-builder is `26.8.1` in `package.json`. Native versions are controlled by their platform tools and project files rather than a single repository-wide compiler version.
