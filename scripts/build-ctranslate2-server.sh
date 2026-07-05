#!/usr/bin/env bash
# Builds the `ctranslate2-server` variants (CUDA + CPU) and stages them under
# `electron/native/bin/<os>-<arch>/`. The CTranslate2 C++ library is pulled
# via CMake `FetchContent` (pinned in electron/native/ctranslate2-server/CMakeLists.txt)
# and statically linked into the helper. No Python runtime in the shipped
# binary — see docs/engineering/stt-ctranslate2-migration.md § Decision.
#
# This is intentionally a separate script (not `build.yml` itself) because the
# CTranslate2 build pulls a sizeable third-party tree and a CUDA toolchain;
# the produced binaries are uploaded as workflow artifacts and consumed by
# `build.yml` on tagged releases.
#
# Local use:
#   bash scripts/build-ctranslate2-server.sh                # all variants on this host
#   bash scripts/build-ctranslate2-server.sh --cpu-only     # cheap local smoke test
#   ENABLE_CUDA=ON bash scripts/build-ctranslate2-server.sh  # explicit CUDA build
#
# ponytail: skip the matrix when the host can't produce a variant (CUDA on
# a Mac, for instance) and exit 0 instead of failing CI. Mirrors the
# pre-migration `build-whisper-binaries.sh` behaviour so the matrix/skip logic
# in the companion workflow is unchanged in shape.

set -euo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly BUILD_ROOT="${ROOT}/.cache/ctranslate2-build"
readonly OUT_ROOT="${ROOT}/electron/native/bin"

CPU_ONLY=0
VARIANTS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cpu-only) CPU_ONLY=1; shift ;;
    --cuda) VARIANTS+=("ctranslate2-cuda"); shift ;;
    --cpu) VARIANTS+=("ctranslate2-cpu"); shift ;;
    -h|--help)
      cat <<-EOF
		Usage: $0 [--cpu-only | --cuda --cpu]
		Builds ctranslate2-server variants and stages them under
		\`electron/native/bin/<os>-<arch>/\`.

		Without arguments, picks variants enabled by the host's toolchain.
		EOF
      exit 0
      ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

if [[ "${#VARIANTS[@]}" -eq 0 && "${CPU_ONLY}" -eq 0 ]]; then
  case "$(uname -s):$(uname -m)" in
    Darwin:arm64|Darwin:x86_64) VARIANTS+=(ctranslate2-cpu) ;;
    Linux:x86_64|Linux:aarch64)
      if command -v nvcc >/dev/null 2>&1; then VARIANTS+=(ctranslate2-cuda); fi
      VARIANTS+=(ctranslate2-cpu)
      ;;
    MINGW*|CYGWIN*|MSYS*)
      # CUDA on Windows only ships when self-hosted GPU runners exist; the
      # workflow gates this on `ENABLE_CUDA`.
      VARIANTS+=(ctranslate2-cpu)
      ;;
    *) VARIANTS+=(ctranslate2-cpu) ;;
  esac
fi

if [[ "${CPU_ONLY}" -eq 1 ]]; then
  VARIANTS=(ctranslate2-cpu)
fi

echo "Variants to build: ${VARIANTS[*]:-none}"

if [[ "${#VARIANTS[@]}" -eq 0 ]]; then
  echo "No variants selected; nothing to do."
  exit 0
fi

os_arch_tag() {
  local os_arch
  case "$(uname -s):$(uname -m)" in
    Darwin:arm64) os_arch="darwin-arm64" ;;
    Darwin:x86_64) os_arch="darwin-x64" ;;
    Linux:x86_64) os_arch="linux-x64" ;;
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

# Single-variant build helper. The CMakeLists handles `FetchContent` for
# CTranslate2 + links it statically.
build_variant() {
  local variant="$1"
  local extra_args=("$@")
  local out_dir="${OUT_ROOT}/$(os_arch_tag)"
  mkdir -p "${out_dir}"
  local build_dir="${BUILD_ROOT}/build-${variant}"
  rm -rf "${build_dir}"
  cmake -S "${ROOT}/electron/native/ctranslate2-server" -B "${build_dir}" \
    -DCMAKE_BUILD_TYPE=Release \
    "${extra_args[@]}"
  cmake --build "${build_dir}" --config Release -j "$(nproc 2>/dev/null || echo 4)"
  local bin_name="ctranslate2-server-${variant}"
  if [[ "$(uname -s)" == MINGW* || "$(uname -s)" == CYGWIN* || "$(uname -s)" == MSYS* ]]; then
    bin_name="${bin_name}.exe"
  fi
  cp "${build_dir}/ctranslate2-server" "${out_dir}/${bin_name}"
  echo "Built ${variant} → ${out_dir}/${bin_name}"
}

for variant in "${VARIANTS[@]}"; do
  case "${variant}" in
    cuda)
      if ! command -v nvcc >/dev/null 2>&1; then
        echo "Skipping cuda: nvcc not on PATH"
        continue
      fi
      build_variant cuda -DENABLE_CUDA=ON
      ;;
    cpu)
      # ponytail: backend selection lives entirely inside CMakeLists.txt
      # now (oneDNN on Win+Linux via FetchContent, Accelerate on macOS),
      # so `cpu` here just means "build the CPU variant". Passing the old
      # `WITH_RUY=ON`/`WITH_DNNL=OFF` etc. from the previous matrix
      # explicitly would be wrong AND would be silently ignored anyway —
      # the vendor bloc in the CMakeLists has CACHE FORCE on the correct
      # names. Don't add CLI flags here unless you're overriding the
      # matrix for a one-off experiment.
      build_variant cpu
      ;;
    *)
      echo "Unknown variant: ${variant}" >&2
      exit 2
      ;;
  esac
done

echo "Done. Binaries under: ${OUT_ROOT}/$(os_arch_tag)/"
