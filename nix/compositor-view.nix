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
  # download. nixpkgs splits ffmpeg across outputs, so join them back.
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
    pkg-config
  ];

  buildInputs = [ ffmpegLgpl ];

  # Same reasoning: config.toml's [env] sets FFMPEG_DIR to the vendored win64
  # tree, without force, so this overrides it rather than fighting it.
  env.FFMPEG_DIR = "${ffmpegTree}";

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
    runHook postInstall
  '';

  meta = {
    description = "Native compositor addon for OpenScreen";
    homepage = "https://github.com/getopenscreen/openscreen";
    license = lib.licenses.mit;
    platforms = lib.platforms.linux;
  };
}
