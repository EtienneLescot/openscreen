# Vendored PipeWire headers

`pipewire-1.0.5/include/` holds the PipeWire and SPA headers `csrc/pw_shim.c`
compiles against. They are MIT (see `pipewire-1.0.5/COPYING`; every file keeps
its `SPDX-License-Identifier: MIT` line) and are copied unmodified from the
[PipeWire 1.0.5 release tarball](https://gitlab.freedesktop.org/pipewire/pipewire/-/releases/1.0.5),
with one exception noted below.

## Why they are here

`libpipewire-0.3-dev` and `libspa-0.2-dev` are not installed on a stock Ubuntu
24.04 (or in most CI images), and installing them needs root. The base system
ships only the runtime `libpipewire-0.3.so.0` — no `.so` symlink, no headers.

Vendoring the headers plus `dlopen`ing the runtime library removes the dev
package from the build entirely, and pins the ABI the helper was compiled
against, which matters because end users' distributions ship a wide spread of
PipeWire versions.

## What was copied

Exactly the transitive closure of what `csrc/pw_shim.c` and `csrc/pw_audio.c`
include — 108 files, computed with `gcc -MM` — not the whole upstream tree.
Adding a new `#include` to either may therefore need another header vendored.

The audio half accounts for 29 of those: `spa/param/audio/` arrived with
`pw_audio.c`, and `format-utils.h` drags in every codec-specific header in that
directory (`aac.h`, `flac.h`, `wma.h` …) even though the helper only ever builds
a raw F32 format. That is upstream's include graph, not a mistake here — the
closure is copied as computed rather than pruned by hand, so re-running the
command below reproduces it exactly.

To re-vendor after changing the shims' includes, or to move to a newer PipeWire:

```sh
# 1. Unpack an upstream release next to the repo, then stage its two header roots:
#      <src>/src/pipewire/*.h + extensions/  ->  $STAGE/pipewire/
#      <src>/spa/include/spa/               ->  $STAGE/spa/
# 2. Generate pipewire/version.h from version.h.in (see below).
# 3. List what the shims actually need and copy just those:
gcc -std=gnu11 -MM csrc/pw_shim.c csrc/pw_audio.c -I"$STAGE" -Icsrc \
  | tr ' ' '\n' | grep "^$STAGE" | sort -u
```

`pipewire/version.h` is the exception: upstream generates it from
`version.h.in` at configure time, so it does not exist in the tarball. It was
produced with the substitutions meson makes (`meson.build:204`,
`src/pipewire/meson.build:85`) for release 1.0.5:

| placeholder                 | value   |
| --------------------------- | ------- |
| `@PIPEWIRE_VERSION_MAJOR@`  | `1`     |
| `@PIPEWIRE_VERSION_MINOR@`  | `0`     |
| `@PIPEWIRE_VERSION_MICRO@`  | `5`     |
| `@PIPEWIRE_API_VERSION@`    | `"0.3"` |

Nothing else was edited.
