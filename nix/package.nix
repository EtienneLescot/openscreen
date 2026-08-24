{
  lib,
  buildNpmPackage,
  nodejs_22,
  electron,
  ffmpeg-headless,
  compositor-view,
  pipewire-helper,
  whisper-stt,
  makeWrapper,
  makeDesktopItem,
  copyDesktopItems,
}:

let
  # nixpkgs' ffmpeg defaults to withGPL and withVersion3, so the stock
  # ffmpeg-headless is gpl3Plus -- in the runtime closure of a derivation whose
  # meta below says MIT, and on the one packaging path where scripts/
  # fetch-ffmpeg.mjs's licence gate never runs. nix/compositor-view.nix builds an
  # LGPL ffmpeg for exactly this reason and calls the alternative "a licensing
  # fault, not a packaging shortcut"; the same standard applies here. The only
  # invocation is a decode to raw PCM, so dropping GPL costs nothing.
  ffmpegLgpl = ffmpeg-headless.override { withGPL = false; };
in
buildNpmPackage {
  nodejs = nodejs_22;
  pname = "openscreen";
  # Read, not restated. A hand-copied version is one more thing to remember at
  # release time and it had already drifted two minors behind the app it names.
  # (`npmDepsHash` below still has to be updated by hand — that is Nix, not a
  # choice — but it fails loudly, where a stale version number never does.)
  version = (lib.importJSON ../package.json).version;

  src =
    let
      fs = lib.fileset;
      # gitTracked fails when source is already a store path (path: flake inputs).
      # Detect this and fall back to cleanSource which handles both cases.
      isStorePath = builtins.storeDir == builtins.substring 0 (builtins.stringLength builtins.storeDir) (toString ../.);
      baseFiles = if isStorePath then fs.fromSource (lib.cleanSource ../.) else fs.gitTracked ../.;
    in
    fs.toSource {
      root = ../.;
      fileset = fs.difference baseFiles (
        fs.unions [
          ../nix
          ../flake.nix
          ../flake.lock
          (fs.fileFilter (file: file.hasExt "md") ../.)
        ]
      );
    };

  npmDepsHash = "sha256-LkKX1edTPHZq5nQRrbLAn11oVw36kb0smNQMmVRMEPA=";

  env.ELECTRON_SKIP_BINARY_DOWNLOAD = "1";

  # electron-builder is not needed — we wrap system electron directly
  npmFlags = [ "--ignore-scripts" ];
  makeCacheWritable = true;

  # vite-plugin-electron compiles electron/ sources into dist-electron/
  # tsconfig has noEmit — tsc is type-check only
  buildPhase = ''
    runHook preBuild
    npx vite build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/lib/openscreen"

    # Renderer build output (index.html, JS chunks, copied public/ assets)
    cp -r dist "$out/lib/openscreen/"

    # Main process + preload (compiled by vite-plugin-electron)
    cp -r dist-electron "$out/lib/openscreen/"

    # Package manifest (electron reads "main" field to find entry point)
    cp package.json "$out/lib/openscreen/"

    # Strip devDependencies (electron, vitest, biome, playwright, etc.)
    npm prune --omit=dev --no-save
    cp -r node_modules "$out/lib/openscreen/"

    # Asset resolution: when app.isPackaged is false, the main process resolves
    # assets at <appPath>/public/. Place wallpapers at that root to match the
    # packaged layout (electron-builder extraResources -> resources/wallpapers).
    mkdir -p "$out/lib/openscreen/public"
    cp -r public/wallpapers "$out/lib/openscreen/public/wallpapers"

    # Wrap system electron with the app directory.
    #
    # OPENSCREEN_FFMPEG_PATH is checked before every other candidate in
    # ffmpegCandidates (electron/media/audioPeaks.ts), which is what makes this
    # a one-line answer to a problem that otherwise has none: the app normally
    # gets ffmpeg from scripts/fetch-ffmpeg.mjs, and a build-time download
    # cannot happen inside the sandbox. Without it resolveFfmpeg returns null,
    # getAudioPeaks returns null in turn, and the renderer silently falls back
    # to decoding waveforms in Chromium -- an order of magnitude slower, and
    # invisible, which is the failure mode worth removing first.
    #
    # -headless rather than the full build: the only invocation is a decode to
    # raw PCM (-i/-ac/-ar/-f), so X11 and SDL would be closure weight for
    # nothing.
    #
    # OPENSCREEN_LINUX_CURSOR_HELPER_EXE is the first candidate in
    # helperCandidates (pipeWireCursorRecordingSession.ts), and the same lookup
    # serves linuxNativeCaptureSession, so one variable covers both consumers.
    # Every other candidate is relative to APP_ROOT or resourcesPath and assumes
    # the electron-builder layout, which this package does not produce; without
    # the override the helper is simply never found and Wayland capture and
    # cursor sampling degrade silently.
    mkdir -p "$out/bin"
    makeWrapper "${electron}/bin/electron" "$out/bin/openscreen" \
      --add-flags "$out/lib/openscreen" \
      --set ELECTRON_IS_DEV 0 \
      --set OPENSCREEN_FFMPEG_PATH "${ffmpegLgpl}/bin/ffmpeg" \
      --set OPENSCREEN_COMPOSITOR_VIEW_NODE "${compositor-view}/lib/compositor_view.node" \
      --set OPENSCREEN_LINUX_CURSOR_HELPER_EXE "${lib.getExe pipewire-helper}" \
      --set OPENSCREEN_WHISPER_SERVER_EXE "${lib.getExe whisper-stt}"

    # Install icons to hicolor theme
    for size in 16 24 32 48 64 128 256 512 1024; do
      icon="icons/icons/png/''${size}x''${size}.png"
      if [ -f "$icon" ]; then
        install -Dm644 "$icon" \
          "$out/share/icons/hicolor/''${size}x''${size}/apps/openscreen.png"
      fi
    done

    runHook postInstall
  '';

  nativeBuildInputs = [
    makeWrapper
    copyDesktopItems
  ];

  desktopItems = [
    (makeDesktopItem {
      name = "openscreen";
      desktopName = "OpenScreen";
      genericName = "Screen Recorder";
      exec = "openscreen %U";
      icon = "openscreen";
      comment = "Desktop screen recorder with built-in editor";
      categories = [
        "AudioVideo"
        "Video"
        "Recorder"
      ];
      startupWMClass = "Openscreen";
      terminal = false;
    })
  ];

  meta = {
    description = "Desktop screen recorder with built-in editor";
    homepage = "https://github.com/getopenscreen/openscreen";
    license = lib.licenses.mit;
    mainProgram = "openscreen";
    platforms = lib.platforms.linux;
  };
}
