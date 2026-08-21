# The Linux capture sidecar: Wayland screen capture through xdg-desktop-portal
# and PipeWire, plus the cursor sampling the compositor cannot give us. Without
# it pipeWireCursorRecordingSession reports "Linux cursor helper is not
# available" and the app degrades to no cursor data on Wayland.
#
# Its own derivation, mirroring what the crate already is: a standalone package
# with its own [workspace] and its own Cargo.lock, deliberately outside the
# compositor workspace (see the comment at the top of its Cargo.toml). Nothing is
# shared with compositor-view.nix except the ffmpeg, and that now comes from a
# common file.
#
# NOTHING HERE NEEDS THE osff_ SYMBOL PREFIXING. That scheme exists because the
# napi addon is dlopen'd into Electron, where Chromium's own libffmpeg.so already
# holds the global symbol scope. This is a separate process spawned over stdio,
# so the flat-namespace collision cannot happen and ffmpeg links normally --
# which is also why this derivation is a fraction of its sibling's size.
{
  lib,
  rustPlatform,
  ffmpeg-lgpl,
  symlinkJoin,
  pkg-config,
  patchelfUnstable,
  pipewire,
}:

let
  # build.rs wants a single tree holding both include/ and lib/, the shape of the
  # vendored ffmpeg the Linux script downloads. nixpkgs splits ffmpeg across
  # outputs, so join them back. Unlike compositor-view.nix, both halves are used
  # as-is: no renamed copies, so no staging.
  ffmpegTree = symlinkJoin {
    name = "ffmpeg-tree-for-pipewire-helper";
    paths = [
      ffmpeg-lgpl.dev
      ffmpeg-lgpl.lib
    ];
  };
in
rustPlatform.buildRustPackage {
  pname = "openscreen-pipewire-helper";
  version = (lib.importJSON ../package.json).version;

  # gitTracked, not cleanSource, for the reason nix/package.nix spells out and
  # nix/compositor-view.nix learned the hard way: cleanSource honours neither
  # .gitignore nor git tracking, so a developer's `build/` output would land in
  # the store and move the src hash on every local cargo invocation. The vendored
  # PipeWire headers under vendor/ ARE tracked and must survive the filter --
  # build.rs asserts on pipewire/pipewire.h and fails the build without them.
  src =
    let
      fs = lib.fileset;
      isStorePath =
        builtins.storeDir
        == builtins.substring 0 (builtins.stringLength builtins.storeDir) (toString ../.);
      baseFiles = if isStorePath then fs.fromSource (lib.cleanSource ../.) else fs.gitTracked ../.;
      crate = ../electron/native/pipewire-capture;
    in
    fs.toSource {
      root = crate;
      fileset = fs.intersection baseFiles crate;
    };

  cargoLock.lockFile = ../electron/native/pipewire-capture/Cargo.lock;

  nativeBuildInputs = [
    # libclang for bindgen, which build.rs uses to read the ffmpeg headers. The
    # hook also sets BINDGEN_EXTRA_CLANG_ARGS, which is what makes build.rs's
    # freestanding_header_args() return early: that function hunts through
    # /usr/lib/gcc for a libclang missing its builtin headers, a Debian problem
    # that does not exist here and whose search would find nothing anyway.
    rustPlatform.bindgenHook
    pkg-config
    # --add-rpath arrived in 0.14 and --force-rpath predates it, but nixpkgs'
    # stable patchelf is old enough that compositor-view.nix already had to reach
    # for the unstable one; keep the two derivations on the same tool.
    patchelfUnstable
  ];

  buildInputs = [ ffmpeg-lgpl ];

  env.FFMPEG_DIR = "${ffmpegTree}";

  # There is no PipeWire build dependency by design -- csrc/pw_shim.c is compiled
  # against the vendored headers and resolves every libpipewire entry point with
  # dlsym, so a C compiler is the whole requirement. See the comment at the top of
  # that file.
  #
  # The corollary is that nothing links libpipewire, so nothing puts it on the
  # binary's RPATH, and `dlopen("libpipewire-0.3.so.0")` then fails on any host
  # without an ld.so.cache -- which is every NixOS host. Same shape as the Vulkan
  # loader in compositor-view.nix: an soname reached by dlopen is invisible to the
  # linker and has to be added deliberately.
  #
  # --force-rpath because build.rs passes -Wl,--disable-new-dtags on purpose: it
  # wants DT_RPATH rather than DT_RUNPATH, so that the entries apply to the
  # transitive ffmpeg libraries too. patchelf defaults to writing DT_RUNPATH,
  # which would silently undo that choice.
  postInstall = ''
    patchelf --force-rpath --add-rpath "${lib.makeLibraryPath [ pipewire ]}" \
      "$out/bin/openscreen-pipewire-helper"
  '';

  # The suite covers the accumulator on the TypeScript side; the crate itself has
  # no tests, and cargo test here would only rebuild it.
  doCheck = false;

  meta = {
    description = "PipeWire/portal capture helper for OpenScreen";
    homepage = "https://github.com/getopenscreen/openscreen";
    license = lib.licenses.mit;
    platforms = lib.platforms.linux;
    mainProgram = "openscreen-pipewire-helper";
  };
}
