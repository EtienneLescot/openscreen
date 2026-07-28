#!/usr/bin/env bash
# Builds the whisper.cpp-based `whisper-stt-server` helper and stages it (plus
# any ggml backend shared libraries) under
# `electron/native/bin/<os>-<arch>/`.
#
# The helper is a long-lived HTTP server that exposes the same
# spawn -> GET / -> POST /inference contract the previous native STT helper
# used, but links libwhisper directly and reads whisper.cpp's DTW token timestamps.
# See docs/engineering/stt-whispercpp-migration-plan.md §2.
#
# Local use:
#   bash scripts/build-whisper-stt.sh                # default backend for host
#   ENABLE_CUDA=ON bash scripts/build-whisper-stt.sh # also build CUDA variant
#   bash scripts/build-whisper-stt.sh --clean        # wipe build cache first
#
# The default backend per host:
#   macOS arm64  -> Metal
#   macOS x64    -> CPU
#   Windows x64  -> Vulkan
#   Linux x64    -> Vulkan

set -euo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly OUT_ROOT="${ROOT}/electron/native/bin"
readonly SRC_DIR="${ROOT}/electron/native/whisper-stt"

# On Windows the inner vulkan-shaders-gen sub-project hits MAX_PATH when the
# build tree is nested under the repo. Use a short root (overridable) on
# Windows; Unix hosts can keep the cached tree inside the repo.
if [[ "$(uname -s)" == MINGW* || "$(uname -s)" == CYGWIN* || "$(uname -s)" == MSYS* ]]; then
  BUILD_ROOT="${WHISPER_STT_BUILD_ROOT:-/c/wstbuild}"
else
  BUILD_ROOT="${WHISPER_STT_BUILD_ROOT:-${ROOT}/.cache/whisper-stt-build}"
fi
readonly BUILD_ROOT

CLEAN=0
CUDA_ENABLED="${ENABLE_CUDA:-OFF}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --clean) CLEAN=1; shift ;;
    --cuda)  CUDA_ENABLED=ON; shift ;;
    -h|--help)
      cat <<-EOF
		Usage: $0 [--clean] [--cuda]
		Builds whisper-stt-server and stages it under
		\`electron/native/bin/<os>-<arch>/\`.

		--clean   Wipe the build cache before configuring.
		--cuda    Also build a CUDA variant (requires nvcc on PATH).
		EOF
      exit 0
      ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

os_arch_tag() {
  local os_arch
  case "$(uname -s):$(uname -m)" in
    Darwin:arm64)  os_arch="darwin-arm64" ;;
    Darwin:x86_64) os_arch="darwin-x64" ;;
    Linux:x86_64)  os_arch="linux-x64" ;;
    Linux:aarch64) os_arch="linux-arm64" ;;
    MINGW*|CYGWIN*|MSYS*)
      local arch
      arch="$(uname -m)"
      os_arch="win32-${arch/x86_64/x64}"
      ;;
    *) echo "Unsupported host: $(uname -s):$(uname -m)" >&2; exit 1 ;;
  esac
  echo "${os_arch}"
}

readonly OS_ARCH="$(os_arch_tag)"
readonly OUT_DIR="${OUT_ROOT}/${OS_ARCH}"

# Determine the default backend flag for this host.
backend_flag_for_host() {
  case "${OS_ARCH}" in
    darwin-arm64) echo "-DOSC_ENABLE_METAL=ON" ;;
    darwin-x64)   echo "" ;;
    win32-x64|linux-x64|linux-arm64) echo "-DOSC_ENABLE_VULKAN=ON" ;;
    *) echo "Unknown os-arch: ${OS_ARCH}" >&2; exit 1 ;;
  esac
}

build_variant() {
  local variant_name="$1"
  shift
  local extra_cmake_flags=("$@")

  local build_dir="${BUILD_ROOT}/build-${OS_ARCH}-${variant_name}"
  if [[ "${CLEAN}" -eq 1 ]]; then
    rm -rf "${build_dir}"
  fi
  mkdir -p "${build_dir}" "${OUT_DIR}"

  echo "[whisper-stt] configuring ${variant_name} in ${build_dir}"
  # ponytail: macOS's default /bin/bash is 3.2 (last GPLv2 release Apple ships),
  # where `"${arr[@]}"` on a genuinely empty array trips `set -u` ("unbound
  # variable") even though bash 4+ treats it as zero words. The
  # `${arr[@]+"${arr[@]}"}` idiom expands to nothing when the array is empty
  # and to the normal quoted expansion otherwise, on both bash versions.
  cmake -S "${SRC_DIR}" -B "${build_dir}" \
    -DCMAKE_BUILD_TYPE=Release \
    ${extra_cmake_flags[@]+"${extra_cmake_flags[@]}"}

  echo "[whisper-stt] building ${variant_name}"
  cmake --build "${build_dir}" --config Release -j "$(nproc 2>/dev/null || echo 4)"

  local bin_name="whisper-stt-server"
  if [[ "${OS_ARCH}" == win32-* ]]; then
    bin_name="${bin_name}.exe"
  fi

  # If this is the primary (non-CUDA) variant, install it under the plain name.
  # CUDA is kept as a side-by-side variant with a -cuda suffix.
  local out_bin_name="${bin_name}"
  if [[ "${variant_name}" == "cuda" ]]; then
    if [[ "${OS_ARCH}" == win32-* ]]; then
      out_bin_name="whisper-stt-server-cuda.exe"
    else
      out_bin_name="whisper-stt-server-cuda"
    fi
  fi

  # CMake generator-specific output locations: Ninja drops the binary at the
  # build root and libraries under bin/; MSBuild (Visual Studio on Windows)
  # puts Release/ configurations under ${build_dir}/Release/ and bin/Release/.
  local built_exe=""
  local search_dirs=()
  if [[ "${OS_ARCH}" == win32-* ]]; then
    for cand in "${build_dir}/Release/whisper-stt-server.exe" "${build_dir}/whisper-stt-server.exe"; do
      if [[ -f "${cand}" ]]; then built_exe="${cand}"; break; fi
    done
    search_dirs=("${build_dir}/bin/Release" "${build_dir}/bin" "${build_dir}/Release")
  else
    for cand in "${build_dir}/whisper-stt-server" "${build_dir}/Release/whisper-stt-server"; do
      if [[ -f "${cand}" ]]; then built_exe="${cand}"; break; fi
    done
    search_dirs=("${build_dir}/bin" "${build_dir}")
  fi
  if [[ -z "${built_exe}" ]]; then
    echo "FATAL: could not find whisper-stt-server binary in ${build_dir}" >&2
    exit 1
  fi
  cp "${built_exe}" "${OUT_DIR}/${out_bin_name}"

  # Stage any shared libraries / backend sidecars that CMake produced.
  # Copy everything that looks like a ggml/whisper shared library, plus any
  # .metal shader files (only produced when Metal is not embedded).
  local found_libs=0
  for lib_dir in "${search_dirs[@]}"; do
    if [[ -d "${lib_dir}" ]]; then
      for f in "${lib_dir}"/*; do
        if [[ -f "${f}" ]]; then
          case "${f##*/}" in
            ggml*.*|whisper.*|whisper.dylib|whisper.dll|libwhisper.*|*.metal)
              cp "${f}" "${OUT_DIR}/"
              found_libs=1
              ;;
          esac
        fi
      done
    fi
  done

  echo "[whisper-stt] built ${variant_name} -> ${OUT_DIR}/${out_bin_name}"
  ls -la "${OUT_DIR}"
}

# ---------------------------------------------------------------------------
# Primary variant (Metal/Vulkan/CPU depending on host).
# ---------------------------------------------------------------------------
DEFAULT_FLAG="$(backend_flag_for_host)"
BUILD_FLAGS=()
if [[ -n "${DEFAULT_FLAG}" ]]; then
  BUILD_FLAGS+=("${DEFAULT_FLAG}")
fi
# See the comment in build_variant() re: bash 3.2 + `set -u` + empty arrays
# (macOS x64/CPU has no DEFAULT_FLAG, so BUILD_FLAGS is genuinely empty here).
build_variant "default" ${BUILD_FLAGS[@]+"${BUILD_FLAGS[@]}"}

# ---------------------------------------------------------------------------
# Optional CUDA variant. Kept as a side-by-side binary for hosts that want
# maximum NVIDIA performance; the default Vulkan build already covers NVIDIA.
# ---------------------------------------------------------------------------
if [[ "${CUDA_ENABLED}" == "ON" ]]; then
  if ! command -v nvcc >/dev/null 2>&1; then
    echo "Skipping CUDA variant: nvcc not on PATH" >&2
  else
    build_variant "cuda" "-DOSC_ENABLE_CUDA=ON"
  fi
fi

echo "[whisper-stt] done. Binaries under: ${OUT_DIR}"
