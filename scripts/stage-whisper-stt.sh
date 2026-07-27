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

# A locally built binary wins: `npm run build:whisper-binaries` puts one here,
# and a developer testing a change should not have it silently replaced by CI's.
if compgen -G "${DEST}/whisper-stt-server*" > /dev/null; then
  echo "whisper-stt-server already present in ${DEST} — leaving it alone."
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

echo "Staged $(basename "${BIN}") + $(( $(ls -1 "${DEST}" | wc -l) - 1 )) sidecar(s) -> ${DEST}"
