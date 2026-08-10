#!/usr/bin/env bash
# Stages the whisper-stt-server binary (plus its ggml backend sidecars) into
# electron/native/bin/<tag>/ so electron-builder's extraResources picks it up.
#
# WHY THIS EXISTS. electron/native/bin/ is gitignored and build-whisper-stt.yml
# publishes the binaries as GitHub *artifacts* of its own workflow run. Nothing
# carried them into build.yml, so every installer built before this script
# shipped with no STT binary at all: resolveBinaryPath() found nothing,
# transcription and captions failed with "whisper-stt-server binary not found;
# build it via scripts/build-whisper-stt.sh" — a developer message, shown to
# end users. The model is fetched at runtime by modelManager.ts; the binary is
# not, and never was.
#
# Fails loudly on purpose. A release without STT is worse than a red build, and
# the failure mode this replaces was completely silent.
#
# Usage: bash scripts/stage-whisper-stt.sh <tag>
#   tag: darwin-arm64 | darwin-x64 | linux-x64 | win32-x64
# Requires: gh (preinstalled on GitHub runners), GH_TOKEN in the environment.

set -euo pipefail

TAG="${1:?usage: stage-whisper-stt.sh <platform-arch tag>}"
ARTIFACT="whisper-stt-${TAG}"
DEST="electron/native/bin/${TAG}"
REPO="${GITHUB_REPOSITORY:-getopenscreen/openscreen}"

# Asserts that GCC's OpenMP runtime travelled with the binaries, on Linux only.
#
# Every ELF of this stack links libgomp.so.1, and 1.9.1 shipped none of them a
# way to find it: the deb/rpm/pacman did not declare it (1.9.2 does) and the
# AppImage has no dependency mechanism at all, so on a machine without it
# whisper-stt-server dies in ld.so before main() and transcription reports a
# developer error to end users. Declaring it fixes three formats out of four;
# bundling the library fixes the fourth, which cannot be fixed any other way.
#
# This only CHECKS. build-whisper-stt.sh does the copying, on the machine that
# compiles these binaries, and build-whisper-stt.yml pins that to ubuntu-22.04.
# Copying it here instead would take it from whoever runs the packaging, and a
# 24.04 desktop's libgomp needs GLIBC_2.38 — which before-pack.cjs then refuses,
# so a developer on a current distro could not package at all. Provenance is the
# whole point: the copy that ships must come from the same machine, and the same
# glibc floor, as the binaries that load it.
#
# Nothing else is needed to make it resolve: these binaries already carry
# `RUNPATH=$ORIGIN:$ORIGIN/bin`, so a copy beside them wins over the system one.
assert_openmp_runtime_staged() {
  case "${TAG}" in linux-*) ;; *) return 0 ;; esac
  [ -f "${DEST}/libgomp.so.1" ] && return 0

  cat >&2 <<EOF

FATAL: libgomp.so.1 is missing from ${DEST}.

Every binary of this stack links it, and the AppImage has no way to declare a
dependency, so shipping without it means transcription dies in ld.so on any
machine that lacks it — silently, until a user tries to transcribe.

It is staged by scripts/build-whisper-stt.sh and travels inside the
whisper-stt artifact. An artifact built before that existed does not carry it.
Re-run the workflow against this branch, then re-run this build:

  gh workflow run build-whisper-stt.yml --repo ${REPO}
EOF
  exit 1
}

# A locally built binary wins: `npm run build:whisper-binaries` puts one here,
# and a developer testing a change should not have it silently replaced by CI's.
if compgen -G "${DEST}/whisper-stt-server*" > /dev/null; then
  echo "whisper-stt-server already present in ${DEST} — leaving it alone."
  # Checked on this path too: it is the one a developer takes, and a local
  # whisper build predating the staging change would otherwise package an
  # AppImage whose STT stack cannot load.
  assert_openmp_runtime_staged
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

echo "Fetching ${ARTIFACT} from the latest successful build-whisper-stt run..."
# No run id: gh resolves the most recent run that published this artifact.
# Artifacts expire (retention-days in build-whisper-stt.yml), so a stale branch
# can legitimately find nothing — say so in terms someone can act on.
if ! gh run download --repo "${REPO}" --name "${ARTIFACT}" --dir "${TMP}" 2>"${TMP}/err"; then
  cat "${TMP}/err" >&2
  cat >&2 <<EOF

FATAL: could not fetch ${ARTIFACT}.

The binaries come from the "Build whisper-stt binaries" workflow, and its
artifacts expire. Re-run it against this branch, then re-run this build:

  gh workflow run build-whisper-stt.yml --repo ${REPO}

Refusing to package: the installer would ship with speech-to-text silently
dead (no transcription, no captions).
EOF
  exit 1
fi

# The workflow uploads one .tar.gz holding a directory of the same name.
ARCHIVE="$(find "${TMP}" -name "${ARTIFACT}.tar.gz" -print -quit)"
[ -n "${ARCHIVE}" ] || { echo "FATAL: ${ARTIFACT}.tar.gz not in the artifact" >&2; exit 1; }

tar -xzf "${ARCHIVE}" -C "${TMP}"
mkdir -p "${DEST}"
cp -v "${TMP}/${ARTIFACT}"/* "${DEST}/"

# Verify what we actually staged rather than trusting the copy: this is the
# check whose absence is the whole reason for this script.
BIN="$(find "${DEST}" -maxdepth 1 -name 'whisper-stt-server*' -print -quit)"
[ -n "${BIN}" ] || { echo "FATAL: no whisper-stt-server binary in ${DEST}" >&2; exit 1; }
[ "${TAG#win32}" = "${TAG}" ] && chmod +x "${BIN}"

# Before the load check below, not after: if libgomp did not travel with the
# artifact, the check would otherwise pass by resolving the build machine's copy
# and prove nothing about what ships.
assert_openmp_runtime_staged

# The existence check above is not enough: 1.8.0-rc.1..rc.3 staged a binary that
# was present and unrunnable. cpp-httplib had linked OpenSSL, the two
# libssl/libcrypto DLLs were never in the artifact, and Windows killed the
# process in the loader (0xC0000135) before main() — so it printed nothing and
# the app reported only "did not respond within 30000ms".
#
# So actually LOAD it. The PATH scrub is the whole point: the build runner has
# OpenSSL installed, so an unscrubbed run resolves the very DLLs the installer
# omits and the check passes on exactly the builds that are broken for users.
# Stripping PATH leaves only the OS directories plus DEST itself (the loader
# always searches the binary's own directory), which is what a user machine has.
if [ "${TAG#win32}" != "${TAG}" ]; then
  MINIMAL_PATH="/c/Windows/System32"
else
  MINIMAL_PATH="/usr/bin:/bin"
fi
# `timeout` is GNU coreutils: absent from a stock macOS runner. Unqualified, it
# made the whole check evaporate there — `env: timeout: No such file or
# directory` is itself output, so the "did it print anything" test below passed
# without ever starting the binary. Use it only when it exists.
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD="timeout 60"
else
  TIMEOUT_CMD=""
fi
# A bad --model makes it fail fast; we only care that it got far enough to speak.
set +e
# shellcheck disable=SC2086 # TIMEOUT_CMD is deliberately word-split (or empty).
LOAD_OUT="$(cd "${DEST}" && ${TIMEOUT_CMD} env PATH="${MINIMAL_PATH}" \
  "./$(basename "${BIN}")" --model "__staging_load_check__" 2>&1)"
LOAD_CODE=$?
set -e
if [ -z "${LOAD_OUT}" ]; then
  echo "FATAL: $(basename "${BIN}") produced no output (exit ${LOAD_CODE}) — it did not load." >&2
  echo "       Unresolved imports; the dependency is missing from the artifact." >&2
  echo "       Windows exit 3221225781 = 0xC0000135 STATUS_DLL_NOT_FOUND." >&2
  exit 1
fi

# "It printed something" is a Windows-shaped test: the loader there dies mute.
# dyld and ld.so are chatty, so on macOS/Linux a helper that never reached
# main() still satisfies the check above — which is exactly how a macOS build
# missing every libggml*.dylib passed staging. Demand the marker that main()
# itself prints (electron/native/whisper-stt/src/main.cpp), so the gate proves
# execution rather than mere noise.
case "${LOAD_OUT}" in
  *"[whisper-stt] boot:"*) ;;
  *)
    echo "FATAL: $(basename "${BIN}") never reached main() (exit ${LOAD_CODE})." >&2
    echo "       Expected its '[whisper-stt] boot:' line; got:" >&2
    printf '%s\n' "${LOAD_OUT}" | sed 's/^/         /' | head -n 12 >&2
    echo "       A dynamic-loader error here means a sidecar is missing from the" >&2
    echo "       artifact, or the binary carries an absolute rpath/RUNPATH into" >&2
    echo "       the build machine's tree. Both are bugs in" >&2
    echo "       scripts/build-whisper-stt.sh's staging step." >&2
    exit 1
    ;;
esac
echo "Load check OK (exit ${LOAD_CODE}): $(printf '%s' "${LOAD_OUT}" | head -n 1)"

echo "Staged $(basename "${BIN}") + $(( $(ls -1 "${DEST}" | wc -l) - 1 )) sidecar(s) -> ${DEST}"
