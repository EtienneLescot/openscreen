# Third-party notices

OpenScreen is MIT licensed (see [LICENSE](LICENSE)). The installers additionally
bundle the pre-built native components below. This file ships inside the
application resources and satisfies the attribution and source-offer obligations
that come with them.

npm dependencies are not listed here: they are resolved from `package.json` and
distributed by their own registries, not redistributed inside our binaries.

---

## FFmpeg — shared libraries (Windows only)

- **Components**: `avcodec-*.dll`, `avformat-*.dll`, `avutil-*.dll`,
  `swresample-*.dll`, `swscale-*.dll` and their siblings, under
  `resources/electron/native/bin/win32-*/`.
- **Used by**: the native D3D11 compositor addon, which links against them at
  load time.
- **License**: **GNU Lesser General Public License v2.1 or later**
  (<https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html>). FFmpeg's own
  licensing page: <https://ffmpeg.org/legal.html>.
- **This is an LGPL build, not a GPL one.** It is configured without
  `--enable-gpl` and without `--enable-nonfree`, and links no GPL-only library
  (x264, x265, xvid, vidstab, rubberband, frei0r, …). `scripts/fetch-ffmpeg.mjs`
  verifies this before vendoring — it reads `ffmpeg -L`, `-buildconf` and
  `-encoders` and refuses any binary that reports otherwise.
- **Upstream binaries**: BtbN/FFmpeg-Builds, release
  `autobuild-2026-07-30-13-32`, the `*-lgpl-shared-8.1` assets. Pinned by
  SHA-256 in `scripts/fetch-ffmpeg.mjs`; the digests there identify the exact
  artifacts we ship.
  <https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-07-30-13-32>
- **Corresponding source**: FFmpeg n8.1.2, commit `cfa62de001`, from
  <https://github.com/FFmpeg/FFmpeg>. The build configuration and scripts that
  produced these exact binaries are published at
  <https://github.com/BtbN/FFmpeg-Builds>.
- **Relinking**: as required by the LGPL, these are dynamic libraries. You may
  replace them with your own build of the same FFmpeg version by overwriting the
  DLLs in `resources/electron/native/bin/win32-*/`.

## whisper.cpp and ggml

- **Components**: `whisper-stt-server` and its ggml backend sidecars, under
  `resources/electron/native/bin/<platform>-<arch>/`.
- **License**: MIT — <https://github.com/ggml-org/whisper.cpp> and
  <https://github.com/ggml-org/ggml>.
- Built from source by `scripts/build-whisper-stt.sh`; the pinned upstream
  revision is in `electron/native/whisper-stt/CMakeLists.txt`.
- The speech model (`ggml-*.bin`) is **not** bundled — it is downloaded into the
  user's data directory on first use by `electron/stt/modelManager.ts`.

## OpenScreen native helpers

`wgc-capture` (Windows Graphics Capture), the ScreenCaptureKit helper (macOS)
and the D3D11 compositor addon are part of this repository and are covered by
[LICENSE](LICENSE).

---

To report an omission or request source for anything bundled here, open an issue
at <https://github.com/getopenscreen/openscreen/issues>.
