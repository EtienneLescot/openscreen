# OpenScreen standalone diagnostic tool

A small Node.js script that runs the native capture helper outside the
Electron app, captures its stdout/stderr, and writes a JSON report.

Used to capture `[stop-timing]` lines emitted by the WGC / ScreenCaptureKit
helper when a recording stop hangs, so the issue reporter can attach the
data without installing or rebuilding the full app.

## Requirements

- Node.js 22+ (OpenScreen's own engine pin)
- The native capture helper for your platform in one of:
  - the same directory as `diagnostic.mjs` (`wgc-capture.exe` on Windows,
    `openscreen-screencapturekit-helper` on macOS)
  - `helpers/<platform>-<arch>/<helper-name>` (CI artifact layout)
  - `$OPENSCREEN_HELPER_EXE` env var

Linux is not currently supported — OpenScreen has no Linux native helper.

## Usage

```text
node diagnostic.mjs --duration 10 --output ./diag.json
```

Flags:
- `-d, --duration <seconds>` recording length before sending stop (default 10)
- `-o, --output <path>` output JSON path (default `./openscreen-diagnostic-<timestamp>.json`)
- `--window` capture a window instead of the full display (default: display)
- `--system-audio` also capture system (loopback) audio
- `--mic` also capture the default microphone
- `-h, --help` show help

The audio flags matter for reproducing a stop hang. Audio and video writes take
the same sink-writer lock, so a run without audio has nothing to contend with
and can pass on a machine where the app hangs every time. If you are reporting a
hang that happens in the app but not here, re-run with whichever sources the
failing recording used: `--system-audio`, `--mic`, or both together.

Or use the bundled launcher:
- Windows: `diagnostic.bat`
- macOS / Linux: `./diagnostic.sh`

## Output

The JSON contains:
- system info (platform, arch, OS, CPU, memory)
- the helper's full stdout and stderr
- parsed `[stop-timing]` entries as a structured array
- the JSON config that was sent to the helper
- exit code / signal

Attach the JSON to a GitHub issue. Maintainers will read the
`stopTiming` array and the helper stderr to pinpoint which step of the
stop cleanup is slow.

## Layout

```text
scripts/diagnostic-tool/
  README.md
  diagnostic.mjs        # the tool
  diagnostic.bat        # Windows launcher
  diagnostic.sh         # macOS / Linux launcher
```

## CI artifacts

`.github/workflows/diagnostic-artifact.yml` builds per-platform zips
that bundle this directory with the prebuilt helper. The workflow runs on
every push to main and on manual dispatch; artifacts are retained for 14
days.