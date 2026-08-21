# The on-device speech-to-text server that backs captions. Without it
# resolveWhisperServer finds nothing, `openscreen captions` fails and the AI
# edition's transcription pump never starts.
#
# THE MODEL IS NOT PACKAGED, AND SHOULD NOT BE. modelManager.ts downloads a GGML
# file from HuggingFace into userData on first use, checksums it, and replaces a
# stale copy. That is a runtime concern with a cache the user owns; baking a
# multi-gigabyte blob into the store would be wrong even if the sandbox allowed
# the download, which it does not.
#
# WHAT MAKES THIS ONE AWKWARD. The CMakeLists pulls whisper.cpp, cpp-httplib and
# nlohmann/json with FetchContent at configure time, over the network, which a nix
# build does not have. Rather than patch the CMakeLists -- the pins are
# deliberate and documented there, and a nix-only fork of them would drift from
# what every other platform builds -- the three trees are fetched here and handed
# to FetchContent through FETCHCONTENT_SOURCE_DIR_<name>, which is exactly the
# override CMake provides for this. FETCHCONTENT_FULLY_DISCONNECTED then makes a
# missed one fail loudly instead of silently reaching for the network.
{
  lib,
  stdenv,
  cmake,
  fetchurl,
  shaderc,
  vulkan-headers,
  vulkan-loader,
}:

let
  # fetchurl on a pinned tag, not fetchFromGitHub, and the difference is worth
  # stating because it is a trade rather than a preference. fetchFromGitHub hashes
  # the unpacked tree, which is immune to GitHub re-compressing an archive; it
  # also cannot be computed or checked without nix. These hashes are of the
  # tarball itself, so any reviewer can verify one with curl and sha256sum, on any
  # platform -- which is the only way this file could be produced or reviewed from
  # a machine with no nix on it. If GitHub ever re-compresses a tag, the build
  # fails closed with a hash mismatch and the fix is one line.
  whisperSrc = fetchurl {
    url = "https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v1.9.1.tar.gz";
    sha256 = "147267177eef7b22ec3d2476dd514d1b12e160e176230b740e3d1bd600118447";
  };
  httplibSrc = fetchurl {
    url = "https://github.com/yhirose/cpp-httplib/archive/refs/tags/v0.18.1.tar.gz";
    sha256 = "405abd8170f2a446fc8612ac635d0db5947c0d2e156e32603403a4496255ff00";
  };
  jsonSrc = fetchurl {
    url = "https://github.com/nlohmann/json/archive/refs/tags/v3.11.3.tar.gz";
    sha256 = "0d8ef5af7f9794e3263480193c491549b2ba6cc74bb018906202ada498a79406";
  };
in
stdenv.mkDerivation {
  pname = "openscreen-whisper-stt";
  version = (lib.importJSON ../package.json).version;

  # gitTracked for the same reason as the other two native derivations: a local
  # build/ tree would otherwise land in the store and move the src hash on every
  # cmake invocation.
  src =
    let
      fs = lib.fileset;
      isStorePath =
        builtins.storeDir
        == builtins.substring 0 (builtins.stringLength builtins.storeDir) (toString ../.);
      baseFiles = if isStorePath then fs.fromSource (lib.cleanSource ../.) else fs.gitTracked ../.;
      helper = ../electron/native/whisper-stt;
    in
    fs.toSource {
      root = helper;
      fileset = fs.intersection baseFiles helper;
    };

  nativeBuildInputs = [
    cmake
    # glslc, for whisper.cpp's vulkan-shaders-gen. Only reachable with
    # OSC_ENABLE_VULKAN=ON below, and the sub-project fails at configure time
    # without it rather than degrading.
    shaderc
  ];

  buildInputs = [
    vulkan-headers
    vulkan-loader
  ];

  # OSC_ENABLE_VULKAN=ON is what scripts/build-whisper-stt.sh selects for
  # linux-x64 and linux-arm64, and matching it is the point: the alternative is a
  # CPU-only binary, which works but is the same class of silent reduction this
  # packaging exists to remove. ggml links libvulkan normally here -- unlike the
  # compositor addon and the PipeWire helper, nothing is dlopen'd by soname, so
  # the linker records it and no RPATH surgery is needed.
  #
  # OSC_NATIVE_CPU is left off, deliberately and per the CMakeLists' own warning:
  # ON would compile with -march=native for whichever machine ran the build, and
  # a nix package is precisely a thing built once and run elsewhere.
  cmakeFlags = [
    "-DCMAKE_BUILD_TYPE=Release"
    "-DOSC_ENABLE_VULKAN=ON"
    "-DFETCHCONTENT_FULLY_DISCONNECTED=ON"
  ];

  # The tarballs are unpacked before cmake runs and the flags are rewritten to
  # point at them. Done here rather than in cmakeFlags above because the paths are
  # only known once the archives are extracted, and $NIX_BUILD_TOP is not
  # available at evaluation time.
  preConfigure = ''
    deps="$NIX_BUILD_TOP/fetchcontent"
    mkdir -p "$deps"
    tar -xzf ${whisperSrc} -C "$deps"
    tar -xzf ${httplibSrc} -C "$deps"
    tar -xzf ${jsonSrc} -C "$deps"

    cmakeFlagsArray+=(
      "-DFETCHCONTENT_SOURCE_DIR_WHISPER=$deps/whisper.cpp-1.9.1"
      "-DFETCHCONTENT_SOURCE_DIR_HTTPLIB=$deps/cpp-httplib-0.18.1"
      "-DFETCHCONTENT_SOURCE_DIR_JSON=$deps/json-3.11.3"
    )

    for dir in "$deps"/whisper.cpp-1.9.1 "$deps"/cpp-httplib-0.18.1 "$deps"/json-3.11.3; do
      test -d "$dir" || {
        echo "expected unpacked source at $dir; the tarball layout changed" >&2
        exit 1
      }
    done
  '';

  # Everything in one directory, binary and shared objects together.
  #
  # Not a nix convention, and deliberate: the CMakeLists sets
  # CMAKE_INSTALL_RPATH to '$ORIGIN:$ORIGIN/bin' for Linux, so the binary looks
  # for libwhisper.so and the ggml objects beside itself. That is also exactly how
  # scripts/stage-whisper-stt.sh lays them out in electron/native/bin/linux-x64/.
  # Splitting them into $out/bin and $out/lib would mean overriding an RPATH the
  # upstream file chose on purpose, for the sake of a directory name.
  installPhase = ''
    runHook preInstall
    mkdir -p "$out/bin"
    cp whisper-stt-server "$out/bin/"
    find . -name '*.so' -o -name '*.so.*' | while read -r so; do
      cp "$so" "$out/bin/"
    done
    test -x "$out/bin/whisper-stt-server" || {
      echo "whisper-stt-server was not produced" >&2
      exit 1
    }
    runHook postInstall
  '';

  meta = {
    description = "On-device speech-to-text server for OpenScreen captions";
    homepage = "https://github.com/getopenscreen/openscreen";
    license = lib.licenses.mit;
    platforms = lib.platforms.linux;
    mainProgram = "whisper-stt-server";
  };
}
