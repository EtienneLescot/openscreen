# The napi addon that carries export. Without it compositorViewService logs
# "native addon not present; running as no-op" and the app records but cannot
# render anything out, which is most of the point of a screen recorder.
#
# Built as its own derivation rather than inside the app's buildPhase: it is a
# Rust workspace with its own toolchain and its own failure modes, and keeping
# it separate means a break here is legible as a break here.
{
  lib,
  rustPlatform,
  ffmpeg,
  symlinkJoin,
  pkg-config,
  rustfmt,
  patchelfUnstable,
  binutils,
}:

let
  # nixpkgs' default ffmpeg has no H.264 encoder this project can use, which the
  # app reports precisely:
  #
  #   aucun encodeur video utilisable : libopenh264: absent de ce build ffmpeg
  #
  # withOpenh264 defaults to withFullDeps, so only ffmpeg-full carries it, while
  # withX264 is on by default and is GPL. Both halves of this override matter.
  # scripts/fetch-ffmpeg.mjs vendors BtbN's *lgpl* build and asserts the licence
  # before using it, so linking GPL x264 into an MIT application is the exact
  # thing upstream takes care to avoid -- a nix package that quietly did it would
  # be a licensing fault, not a packaging shortcut.
  ffmpegLgpl = ffmpeg.override {
    withOpenh264 = true;
    withGPL = false;
  };

  # crates/compositor/build.rs wants a single tree holding both include/ and
  # lib/, the shape of the vendored ffmpeg the Windows and Linux scripts
  # download. nixpkgs splits ffmpeg across outputs, so join them back. Only the
  # headers are taken from here; lib/ is replaced at build time by renamed
  # copies, for the reason spelled out on preBuild below.
  ffmpegTree = symlinkJoin {
    name = "ffmpeg-tree-for-build-rs";
    paths = [
      ffmpegLgpl.dev
      ffmpegLgpl.lib
    ];
  };
in
rustPlatform.buildRustPackage {
  pname = "openscreen-compositor-view";
  version = (lib.importJSON ../package.json).version;

  src = lib.cleanSource ../crates;

  # No git dependencies in the lockfile, so this needs no hash of its own and
  # cannot go stale the way npmDepsHash did.
  cargoLock.lockFile = ../crates/Cargo.lock;

  nativeBuildInputs = [
    # Supplies libclang for bindgen, which build.rs uses to read ffmpeg headers.
    # crates/.cargo/config.toml points LIBCLANG_PATH at a Windows install; that
    # entry has no `force = true`, so the environment wins and this hook's value
    # is what applies here.
    rustPlatform.bindgenHook
    # bindgen shells out to rustfmt and merely warns when it cannot find it.
    # That warning is load-bearing here: prefix_ffmpeg_symbols in
    # crates/compositor/build.rs matches lines beginning with exactly
    # "    pub fn ", which is rustfmt's output and not bindgen's raw emission,
    # so without it nothing gets prefixed and the build.rs assertion fires.
    rustfmt
    pkg-config
    # patchelfUnstable, not patchelf: --rename-dynamic-symbols arrived in
    # 0.18 and nixpkgs' stable patchelf is 0.15.2, which does not recognise the
    # flag and quietly treats it as a filename --
    #   patchelf: getting info about '--rename-dynamic-symbols': No such file
    patchelfUnstable
    binutils # nm, for reading the ffmpeg symbol table
  ];

  buildInputs = [ ffmpegLgpl ];

  # FFMPEG_DIR is set in preBuild, once the renamed libraries exist. Same
  # reasoning as before for it winning over config.toml's [env]: that entry has
  # no `force = true`, so the environment takes precedence.
  #
  # The prefix half of the scheme. build.rs rewrites the bindgen output so the
  # Rust declarations import osff_-prefixed names, and it asserts that it renamed
  # something, so a mismatch between these two halves fails the build rather than
  # producing an addon that binds to the wrong ffmpeg.
  env.OPENSCREEN_FFMPEG_SYMBOL_PREFIX = "osff_";

  # WHY. Electron links Chromium's own stripped libffmpeg.so as a DT_NEEDED
  # dependency, so it holds the global symbol scope before any addon is
  # dlopen'd. ELF has one flat namespace, so the addon's avformat_open_input
  # binds to Chromium's build regardless of RUNPATH -- the symbol is already
  # satisfied. scripts/build-linux-compositor-addon.mjs documents this at length,
  # including why RTLD_DEEPBIND and symbol versioning were both rejected.
  #
  # I left this out of the first version on the theory that an addon which loads
  # and runs has no collision. That was wrong: loading proves nothing, because
  # the Vulkan check happens before any ffmpeg call. What it actually produced is
  # the quiet failure that comment warns about -- an addon running against an
  # ffmpeg it was not built for, reporting `libopenh264: absent de ce build
  # ffmpeg` while linked against a build that has it.
  preBuild = ''
    stage="$NIX_BUILD_TOP/ffmpeg-renamed"
    mkdir -p "$stage/lib"
    : > "$NIX_BUILD_TOP/symnames"

    # Copy each library under its soname and read its symbol table. awk rather
    # than sed with a backreference: the third field is the name, and anything
    # after an @ is the version tag.
    for lib in ${ffmpegLgpl.lib}/lib/lib{avformat,avcodec,avutil,swscale,swresample}.so.*; do
      case "$lib" in *.so.*.*) continue ;; esac
      test -f "$lib" || continue
      cp "$(readlink -f "$lib")" "$stage/lib/$(basename "$lib")"
      nm -D --defined-only "$lib" | awk '{ n = $3; sub(/@.*/, "", n); if (n ~ /^(av|sws_|swr_)/) print n }' >> "$NIX_BUILD_TOP/symnames"
    done

    map="$NIX_BUILD_TOP/symbols.map"
    sort -u "$NIX_BUILD_TOP/symnames" | awk '{ print $1 " osff_" $1 }' > "$map"
    count=$(wc -l < "$map")
    if [ "$count" -eq 0 ]; then
      echo "no ffmpeg symbols found; the addon would bind to Chromium's ffmpeg" >&2
      exit 1
    fi
    echo "renaming $count ffmpeg symbols with the osff_ prefix"

    for so in "$stage"/lib/*.so.*; do
      chmod u+w "$so"
      patchelf --rename-dynamic-symbols "$map" "$so"
      # The unversioned name the linker resolves -lavformat through. Without it
      # nothing links against these copies, and a cdylib tolerates undefined
      # symbols, so the build succeeds and dlopen fails much later with
      # "undefined symbol: osff_avformat_open_input" -- which is what happened.
      ln -sf "$(basename "$so")" "$stage/lib/$(basename "$so" | sed 's/\.so\..*/.so/')"
    done

    # Headers from the real tree, libraries from the renamed one.
    ln -s ${ffmpegTree}/include "$stage/include"
    export FFMPEG_DIR="$stage"
  '';

  # poc-d3d is in the workspace and is Direct3D, so it must not be built here.
  cargoBuildFlags = [
    "-p"
    "compositor-view-napi"
  ];

  # The suite targets Windows; running it on this platform proves nothing.
  doCheck = false;

  installPhase = ''
    runHook preInstall
    mkdir -p "$out/lib"
    # cargo emits a plain .so; the loader looks for a .node.
    find target -name 'libcompositor_view.so' -exec cp {} "$out/lib/compositor_view.node" \;
    test -f "$out/lib/compositor_view.node" || {
      echo "compositor_view.node was not produced" >&2
      exit 1
    }

    # The renamed libraries travel with the addon: nothing else on this system
    # defines osff_-prefixed symbols, so they have to sit beside it and be found
    # from there rather than through any system path.
    cp "$NIX_BUILD_TOP"/ffmpeg-renamed/lib/*.so.* "$out/lib/"
    chmod u+w "$out/lib/compositor_view.node"
    patchelf --set-rpath '$ORIGIN' "$out/lib/compositor_view.node"
    runHook postInstall
  '';

  meta = {
    description = "Native compositor addon for OpenScreen";
    homepage = "https://github.com/getopenscreen/openscreen";
    license = lib.licenses.mit;
    platforms = lib.platforms.linux;
  };
}
