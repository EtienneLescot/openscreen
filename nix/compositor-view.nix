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
  ffmpeg-lgpl,
  symlinkJoin,
  pkg-config,
  rustfmt,
  patchelfUnstable,
  binutils,
  vulkan-loader,
}:

let
  # Was an inline `ffmpeg.override` here; moved to nix/ffmpeg-lgpl.nix once the
  # PipeWire helper became a third consumer of the same subtle pair of flags.
  ffmpegLgpl = ffmpeg-lgpl;

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

  # cleanSource is not enough here: it filters .git and editor backups and
  # honours neither crates/.gitignore nor git tracking. On any machine that has
  # run `npm run build:native:compositor` or `npm run fetch:ffmpeg`, that means
  # the local `target/` and the ~160 MB vendored `thirdparty/` land in the store,
  # the src hash changes after every cargo invocation so nothing ever caches, and
  # installPhase's `find target` can match a stale libcompositor_view.so from
  # that tree instead of the one just built.
  #
  # Same shape as nix/package.nix, including its fallback: gitTracked fails when
  # the source is already a store path (path: flake inputs).
  src =
    let
      fs = lib.fileset;
      isStorePath =
        builtins.storeDir
        == builtins.substring 0 (builtins.stringLength builtins.storeDir) (toString ../.);
      baseFiles = if isStorePath then fs.fromSource (lib.cleanSource ../.) else fs.gitTracked ../.;
    in
    fs.toSource {
      root = ../crates;
      fileset = fs.intersection baseFiles ../crates;
    };

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
    #
    # The list must hold every library crates/compositor/build.rs emits a
    # cargo:rustc-link-lib for -- all six of them, avfilter included since the
    # speed-region stretch runs through atempo. Miss one and the build either
    # dies on `cannot find -lavfilter` (no unversioned symlink is staged for it
    # below) or links the store's UN-renamed copy, and a cdylib tolerating
    # undefined symbols means the failure surfaces only at require() time as
    # "undefined symbol: osff_avfilter_graph_alloc" -- the addon then loads as a
    # no-op and preview plus every export are dead. avfilter's exports are all
    # av-prefixed (avfilter_*, av_buffersrc_*, av_buffersink_*), so the awk
    # filter here and the leak check in installPhase already cover them.
    for lib in ${ffmpegLgpl.lib}/lib/lib{avformat,avcodec,avutil,swscale,swresample,avfilter}.so.*; do
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

    # Each copy still carries the RUNPATH it inherited from the original ffmpeg
    # output, which is where the UN-renamed libraries live -- so libavcodec's own
    # osff_swr_init would resolve against a libswresample that defines swr_init.
    # It only works today because all six happen to be direct DT_NEEDED of the
    # addon, so $ORIGIN is searched first; the day --as-needed drops one the
    # loader falls through to the store copy and dlopen fails on an undefined
    # osff_ symbol. Put $ORIGIN in front so the renamed set can only resolve
    # against itself, and keep what was there for their non-ffmpeg deps (zlib,
    # openh264) -- the same reason the addon below gets --add-rpath rather than a
    # replacement.
    for so in "$out"/lib/*.so.*; do
      chmod u+w "$so"
      prev=$(patchelf --print-rpath "$so")
      patchelf --set-rpath '$ORIGIN'"''${prev:+:$prev}" "$so"
    done

    chmod u+w "$out/lib/compositor_view.node"

    # --add-rpath, not --set-rpath: the latter replaces what nixpkgs' ld-wrapper
    # computed for the addon's own dependencies -- libgcc_s.so.1 among them, which
    # a gnu-target Rust cdylib links for unwinding -- and nothing here would put it
    # back, since fixupPhase only shrinks. The reference build appends too
    # (scripts/build-linux-compositor-addon.mjs passes -Wl,-rpath,$ORIGIN at link
    # time rather than rewriting afterwards).
    patchelf --add-rpath '$ORIGIN' "$out/lib/compositor_view.node"

    # The Vulkan loader is added in postFixup, not here -- see the comment there.

    # What the reference build ends with (assertNoUnprefixedFfmpegImports in
    # scripts/build-linux-compositor-addon.mjs). preBuild's `count -eq 0` proves
    # only that the rename map was non-empty. A cdylib tolerates undefined
    # symbols, so any name bindgen declared that the map missed links fine, and
    # binds to Chromium's libffmpeg.so at dlopen -- silently, which is the whole
    # failure this scheme exists to prevent.
    leaked=$(nm -D --undefined-only "$out/lib/compositor_view.node" \
      | awk '{ n = $2; sub(/@.*/, "", n); if (n ~ /^(av|sws_|swr_)/ && n !~ /^osff_/) print n }')
    if [ -n "$leaked" ]; then
      echo "ffmpeg symbols still imported unprefixed; the addon would bind to Chromium's ffmpeg:" >&2
      echo "$leaked" >&2
      exit 1
    fi
    echo "verified: no unprefixed ffmpeg imports remain in the addon"
    runHook postInstall
  '';

  # The Vulkan loader, which nothing else pulls in: wgpu reaches Vulkan through
  # ash's dlopen("libvulkan.so.1"), never a DT_NEEDED, which is why this
  # derivation builds without it and then fails at export time. The ICD stays the
  # host's job -- forcing a rasteriser would put every user with a real GPU into
  # software rendering -- but the loader cannot be, because NixOS has no
  # ld.so.cache and /run/opengl-driver/lib carries ICDs, not libvulkan.so.1.
  #
  # postFixup, and this was in installPhase until the PipeWire helper proved why
  # that does not work: fixupPhase runs `patchelf --shrink-rpath`, which drops
  # every RPATH entry no DT_NEEDED library needs -- which is the definition of an
  # entry added for a dlopen. It was being added and then stripped, and the
  # runner never noticed because ubuntu-latest has a system libvulkan that
  # satisfies the dlopen regardless. On NixOS it would not have.
  postFixup = ''
    patchelf --force-rpath --add-rpath "${lib.makeLibraryPath [ vulkan-loader ]}" \
      "$out/lib/compositor_view.node"
  '';

  meta = {
    description = "Native compositor addon for OpenScreen";
    homepage = "https://github.com/getopenscreen/openscreen";
    license = lib.licenses.mit;
    platforms = lib.platforms.linux;
  };
}
