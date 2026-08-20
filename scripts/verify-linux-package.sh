#!/usr/bin/env bash
#
# Prove a built Linux package resolves on a machine that has nothing installed.
#
# The Linux twin of verify-appx-native.ps1, and it exists for the same reason that
# script does: every guard we have aims at a failure already understood. before-pack.cjs
# checks the symbol-version ceiling because 1.9.0 shipped GLIBC_2.38; it would never have
# caught 1.9.1, which shipped three sonames that nothing declared and nothing bundled —
# libgbm.so.1 and libasound.so.2 (needed by the Electron binary itself, so the app exited
# 127 before any window) and libgomp.so.1 (needed by all 32 ELFs of the STT stack, so
# transcription died in ld.so). A static check only ever knows about the mistakes already
# made.
#
# So ask the loader instead. This installs the package into a BARE container of the
# oldest distro the README claims and runs ldd over everything that ships. Whatever the
# next unresolvable dependency turns out to be, this fails on it.
#
# Why a container and not the runner: the runner is the problem. Every failure of this
# shape has the same cause — the machines we build on have more installed than the
# machines we ship to — so "it resolved in CI" is evidence about nothing unless CI is
# empty. The images below are chosen for what is NOT in them, which is also why nothing
# here may apt-get install a convenience: binutils would arrive with its own transitive
# closure and could mask the very thing being measured. ldd is glibc, already present.
#
# It deliberately starts no GUI. A runner has no useful GPU or desktop session, and a
# flaky gate gets switched off. The loader is what broke, and the loader can be asked
# with neither: a binary it rejects exits 127 with "error while loading shared
# libraries" and prints nothing else, while one that reaches main() prints its usage.
#
# Usage:  scripts/verify-linux-package.sh deb|rpm|pacman <package-file>
#
# To see it fail on purpose, run it against a package with a `depends` entry removed
# from electron-builder.json5 — the negative case is the one that matters, and it is
# what proved this script sees anything at all (1.9.1 fails it on all three sonames).

set -euo pipefail

FORMAT="${1:?usage: verify-linux-package.sh deb|rpm|pacman <package-file>}"
PACKAGE="${2:?usage: verify-linux-package.sh deb|rpm|pacman <package-file>}"

if [[ ! -f "$PACKAGE" ]]; then
	echo "::error::No such package: $PACKAGE"
	exit 1
fi

# Ubuntu 22.04 is the floor build.yml pins its runner to and the oldest distro the README
# claims. Fedora and Arch have no equivalent claim, so their images track a current
# release: those two lists are hand-written and, until this script, were never validated
# by anything at all.
case "$FORMAT" in
deb)
	IMAGE="docker.io/library/ubuntu:22.04"
	INSTALL='apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$PKG"'
	;;
rpm)
	IMAGE="docker.io/library/fedora:40"
	INSTALL='dnf install -y -q "$PKG"'
	;;
pacman)
	IMAGE="docker.io/library/archlinux:latest"
	INSTALL='pacman -Sy --noconfirm >/dev/null && pacman -U --noconfirm "$PKG"'
	;;
*)
	echo "::error::Unknown format '$FORMAT' (expected deb, rpm or pacman)"
	exit 1
	;;
esac

# docker on GitHub runners, podman on the machines this gets debugged from.
RUNTIME=""
for candidate in docker podman; do
	if command -v "$candidate" >/dev/null 2>&1; then
		RUNTIME="$candidate"
		break
	fi
done
if [[ -z "$RUNTIME" ]]; then
	echo "::error::Neither docker nor podman is available; cannot verify $FORMAT in a clean room"
	exit 1
fi

echo "Verifying $(basename "$PACKAGE") in a bare $IMAGE via $RUNTIME"

PROBE=$(
	cat <<'INNER'
set -uo pipefail
PKG="$1"

if ! eval "$INSTALL_CMD" >/tmp/install.log 2>&1; then
	echo "FAIL install: the declared depends could not be resolved"
	tail -20 /tmp/install.log
	exit 1
fi
echo "ok install: declared depends resolved"

ROOT=/opt/Openscreen
if [[ ! -d "$ROOT" ]]; then
	echo "FAIL layout: $ROOT does not exist after install"
	exit 1
fi

# Every ELF that ships, by magic rather than by extension: the helpers,
# whisper-stt-server and ffmpeg have none. `head -c`, not bash's `read`, which stops at
# the NUL bytes an ELF header is full of.
mapfile -t ELVES < <(
	find "$ROOT" -type f -print0 2>/dev/null | while IFS= read -r -d '' f; do
		if head -c 4 "$f" 2>/dev/null | grep -q $'^\x7fELF'; then printf '%s\n' "$f"; fi
	done
)

# The same assertion the Windows probe makes, for the same reason: a guard that silently
# stops looking reports "clean" for the rest of the project's life. This payload ships
# dozens of ELFs, so finding almost none means the scan broke, not that the package is
# pure script.
if [[ "${#ELVES[@]}" -lt 10 ]]; then
	echo "FAIL scan: found only ${#ELVES[@]} ELF files under $ROOT — the scan is broken, not the package"
	exit 1
fi

# What ships, by soname, so a bundled library is never reported as missing. This is the
# distinction that matters and it is easy to get wrong: the ffmpeg shared objects carry
# no RUNPATH of their own and find libavutil only through the binary that loads them, so
# ldd run against one of THEM reports three sonames missing that are present and fine.
# The question this script answers is narrower and is the one that broke twice — which
# sonames must the SYSTEM provide — and those are exactly the ones shipped nowhere.
declare -A SHIPPED=()
while IFS= read -r name; do SHIPPED["$name"]=1; done < <(
	find "$ROOT" -type f -name '*.so*' -printf '%f\n' 2>/dev/null
)

declare -A UNRESOLVED=()
for f in "${ELVES[@]}"; do
	while read -r soname; do
		[[ -n "${SHIPPED[$soname]:-}" ]] && continue
		UNRESOLVED["$soname"]=1
	done < <(ldd "$f" 2>/dev/null | awk '/not found/{print $1}')
done

if [[ "${#UNRESOLVED[@]}" -gt 0 ]]; then
	echo "FAIL loader: ${#UNRESOLVED[@]} soname(s) that the package neither declares nor ships:"
	printf '  %s\n' "${!UNRESOLVED[@]}"
	echo
	echo "Add the package providing each to the '$FORMAT_LABEL' depends list in electron-builder.json5."
	echo "The name differs per distro — resolve it rather than guessing:"
	echo "  deb     apt-file search <soname>"
	echo "  rpm     dnf provides '<soname>()(64bit)'"
	echo "  pacman  pacman -F usr/lib/<soname>"
	exit 1
fi
echo "ok loader: all ${#ELVES[@]} ELF files resolve"

# Reaching main() is the part ldd cannot show. A binary the loader rejects exits 127 and
# prints "error while loading shared libraries"; one that starts prints its own usage or
# its own structured error, whatever that is. Only the first case is a packaging failure
# — these are all EXPECTED to fail on a runner with no display and no PipeWire, just not
# in ld.so. `timeout` because the Electron binary is the one thing here that might not
# choose to exit.
STARTED=0
for exe in "$ROOT/openscreen" \
	"$ROOT/resources/electron/native/bin/linux-x64/whisper-stt-server" \
	"$ROOT/resources/electron/native/bin/linux-x64/openscreen-pipewire-helper"; do
	[[ -x "$exe" ]] || continue
	err=$(timeout 60 "$exe" --help 2>&1 >/dev/null || true)
	if grep -q "error while loading shared libraries" <<<"$err"; then
		echo "FAIL start: $(basename "$exe") died in ld.so"
		echo "  ${err%%$'\n'*}"
		exit 1
	fi
	STARTED=$((STARTED + 1))
	echo "ok start: $(basename "$exe") reached main()"
done

if [[ "$STARTED" -eq 0 ]]; then
	echo "FAIL start: none of the expected executables were found — the paths in this script are stale"
	exit 1
fi

echo "PASS"
INNER
)

MOUNT_DIR="$(cd "$(dirname "$PACKAGE")" && pwd)"
"$RUNTIME" run --rm \
	-v "$MOUNT_DIR:/pkg:ro" \
	-e "INSTALL_CMD=$INSTALL" \
	-e "FORMAT_LABEL=$FORMAT" \
	"$IMAGE" \
	bash -c "$PROBE" _ "/pkg/$(basename "$PACKAGE")"
