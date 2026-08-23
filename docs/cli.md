# OpenScreen CLI

Headless command-line interface for recording the screen and exporting `.openscreen`
projects — no visible windows, machine-readable output. Designed so scripts, CI
pipelines, and AI coding agents can produce polished product demos automatically:

```text
record → edit the project JSON programmatically → export → MP4/GIF
```

## Running

Development — build once per checkout:

```bash
npm run build-vite                                            # renderer + main
npm run build:native:mac                                      # capture helpers (recording)
npm run fetch:ffmpeg:mac && npm run build:native:compositor:mac  # Rust compositor (export)
bash scripts/build-whisper-stt.sh                             # STT server (captions; model downloads on first run)
```

Then:

```bash
npm run cli -- <command> [options]
# or directly:
./node_modules/.bin/electron . <command> [options]
```

Packaged app (the CLI ships inside the normal binary):

```bash
# macOS
/Applications/Openscreen.app/Contents/MacOS/Openscreen export demo.openscreen -o demo.mp4
# Windows
"C:\Program Files\Openscreen\Openscreen.exe" export demo.openscreen -o demo.mp4
```

CLI runs skip the single-instance lock, so they work while the GUI app is open.

## Commands

### `openscreen record`

Records headlessly through the same pipeline as the GUI: the native
ScreenCaptureKit helper on macOS, the WGC helper on Windows (browser capture as
fallback). Recordings land in the app's recordings directory
(`<userData>/recordings/`), exactly like GUI recordings — including the
`.cursor.json` cursor-telemetry sidecar used for editable cursors and auto-zoom.

```bash
openscreen record --duration 30 --project demo.openscreen --json
openscreen record --window "My App" --mic --system-audio
openscreen record --display 1 --cursor system
```

| Option | Meaning |
|---|---|
| `--display <n>` | Screen index to record (default 0) |
| `--window <title>` | Record the first window whose title contains `<title>` |
| `--mic` / `--mic-device <name>` | Capture microphone (optionally by device-label substring) |
| `--system-audio` | Capture system audio |
| `--cursor <editable-overlay\|system>` | Hide the system cursor and record telemetry (default), or bake it into the video |
| `--duration <seconds>` | Stop automatically |
| `--project <out.openscreen>` | Write a ready-to-export project file when done |
| `--json` | NDJSON events on stdout |

Stopping without `--duration`: send SIGINT/SIGTERM to the process, or type
`stop` + Enter on its stdin.

Platform notes:

- **macOS**: requires the Swift helper (`npm run build:native:mac`, needs Xcode)
  and the Screen Recording permission for whatever binary hosts Electron
  (your terminal during development). Webcam capture is not available in CLI
  recording on macOS (same limitation as the native helper).
- **Windows**: requires the WGC helper (`npm run build:native:win`). SIGTERM
  does not exist on Windows — stop recordings with Ctrl+C, stdin `stop`, or
  `--duration` (a hard `taskkill` loses the recording). Microphone access is
  gated by Settings → Privacy → Microphone; there is no programmatic prompt.
- **Linux**: uses the browser capture pipeline; cursor options are limited,
  matching the GUI. On Wayland, capture goes through the PipeWire portal,
  which may show a system picker dialog and requires a desktop session
  (headless/SSH sessions without a portal cannot record).

### `openscreen sources`

Lists capturable displays, windows, and microphones — the same enumeration the
GUI picker uses — so scripts and agents can choose `--display`, `--window`, and
`--mic-device` values without guesswork.

```bash
openscreen sources          # human-readable
openscreen sources --json
openscreen sources -o sources.json   # straight to a file
```

`--json` on stdout is the normal path and works: Chromium's own diagnostics go
to stderr, so a pipe carries only the CLI's output.

What the CLI cannot control is the wrapper around it. Ubuntu's `xvfb-run` — the
usual way to run a GUI binary on a headless machine — merges the command's
stderr into its stdout, and under it Chromium's startup complaints about D-Bus
and OpenGL arrive ahead of the JSON, so `openscreen sources --json | jq` fails.
Other launchers and log collectors do the same.

`-o <file>` writes the result somewhere no wrapper can redirect. It also avoids
shell quoting and encoding differences, which is worth more on Windows than on
POSIX. The file is written only on a successful run; a file left by an earlier
run is not touched when a later one fails, so check the exit code rather than the
file's presence.

**The two channels carry different shapes.** `--json` on stdout wraps the payload
in the NDJSON `done` envelope, because it is one event in a stream. `-o` writes
the payload on its own, because a file is not a stream:

```bash
openscreen sources --json | jq '.sources.displays'   # stdout: inside the envelope
openscreen sources -o s.json && jq '.displays' s.json # file: the payload itself
```

`--json` emits the payload on the final `done` event:

```json
{
  "event": "done",
  "success": true,
  "sources": {
    "displays": [{ "index": 0, "id": "screen:1:0", "name": "Entire screen" }],
    "windows": [{ "id": "window:210:0", "name": "My App" }],
    "microphones": [{ "label": "MacBook Pro Microphone (Built-in)" }],
    "microphoneLabelsUnavailable": false
  }
}
```

### `openscreen export`

Renders a project to MP4 or GIF using the app's real export pipeline (WebCodecs +
PixiJS, faster than realtime) in a hidden window. Falls back to SwiftShader when
no GPU is available (CI), and applies everything the editor would: zooms, trims,
speed regions, wallpaper/padding, annotations, cursor rendering, webcam layouts.

```bash
openscreen export demo.openscreen                    # format/quality from the project
openscreen export demo.openscreen -o out.mp4 --quality source
openscreen export demo.openscreen -o out.gif --gif-fps 20 --gif-size large
openscreen export demo.openscreen --json | while read line; do ...; done
```

| Option | Meaning |
|---|---|
| `-o, --out <path>` | Output file; extension picks the format. Default: next to the project |
| `--format <mp4\|gif>` | Override the project's stored format |
| `--quality <medium\|good\|source>` | MP4 quality |
| `--gif-fps <15\|20\|25\|30>`, `--gif-size <medium\|large\|original>` | GIF settings |
| `--auto-zoom` | Add automatic zooms from cursor telemetry before rendering — the same dwell-detection engine as the editor's magic wand. Existing zoom regions are kept; suggestions never overlap them |
| `--audio <file>` | Mix a voiceover file into the MP4 (mp3/wav/m4a — anything Chromium can decode; AIFF is not supported) |
| `--audio-mode <mix\|replace>` | Layer the voiceover over the recording's audio (default `mix`) or replace it |
| `--audio-offset <seconds>` | Delay before the voiceover starts (default 0) |
| `--json` | NDJSON progress + result on stdout |

`--audio` mixes after the native render: the exported file is read back, video
packets are copied untouched, and the audio is mixed offline
(OfflineAudioContext) and re-encoded to AAC before overwriting the output.
MP4 only.
In `mix` mode the original audio is ducked to 40% under the voiceover so the
sum cannot clip; use `replace` to drop the original entirely.

**Media path rule**: for safety, a project's referenced media is only auto-approved
when it lives in the app's recordings directory or **next to the project file**.
Keep `.openscreen` files beside their media (or record via the CLI, which uses
the recordings directory).

**No cancel**: the native compositor has no abort mechanism — killing the CLI
mid-export stops output but the render worker runs until process exit.

### `openscreen pack`

Copies a project and everything it references (screen/webcam video, cursor
telemetry sidecar) into one portable folder and rewrites the project's media
paths:

```bash
openscreen pack demo.openscreen --out bundle/
```

The folder survives being moved or shipped as a CI artifact: when the stored
absolute paths go stale, the loader falls back to files with the same basename
next to the project file.

### `openscreen captions`

Transcribes the project's audio with the app's on-device Whisper model (no
upload; language auto-detected) and writes the resulting caption annotations
into the project. Re-running replaces earlier auto-captions; manual annotations
are preserved.

```bash
openscreen captions demo.openscreen --min-words 2 --max-words 7
openscreen export demo.openscreen -o demo.mp4   # subtitles are burned in
```

Requires an audio track in the project's video (e.g. `record --mic`, or a
voiceover mixed in with a re-recorded source). Transcription runs on the
native whisper.cpp engine (ggml-small); the model downloads automatically on
first use.

### `openscreen info`

Prints a project summary (referenced media and whether it exists, format,
region counts). Exits non-zero if the referenced video is missing.

```bash
openscreen info demo.openscreen --json
```

## Machine-readable output (`--json`)

One JSON object per line on stdout (NDJSON). stderr carries diagnostics only.

```jsonl
{"event":"started","command":"export"}
{"event":"progress","percentage":42,"currentFrame":50,"totalFrames":120,"estimatedTimeRemaining":3}
{"event":"done","success":true,"outputPath":"/path/out.mp4","format":"mp4","width":1920,"height":1080}
```

Record emits `log` events (`Recording started`, …), `stopping`, and a final
`done` carrying `screenVideoPath`, `cursorDataPath`, `durationMs`, and
`projectPath` when `--project` was used. Exit code is 0 on success, 1 on
failure, 2 on bad arguments.

## Example: automated product demo (for scripts/agents)

```bash
# 1. Record 20 seconds of the running app
openscreen record --window "MyProduct" --duration 20 --project demo.openscreen --json

# 2. Edit the project: add a zoom and a caption (plain JSON)
node -e '
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync("demo.openscreen", "utf8"));
  p.editor.zoomRegions.push({ id: "z1", startMs: 2000, endMs: 6000, depth: 3,
    focus: { cx: 0.5, cy: 0.4 }, focusMode: "manual", source: "manual" });
  p.editor.annotationRegions.push({ id: "a1", startMs: 500, endMs: 4000,
    type: "text", content: "One-click setup", textContent: "One-click setup",
    position: { x: 8, y: 6 }, size: { width: 40, height: 12 },
    style: { fontSize: 24, color: "#fff" }, zIndex: 1 });
  fs.writeFileSync("demo.openscreen", JSON.stringify(p, null, 2));
'

# 3. Narrate with any TTS (macOS `say` shown; any engine producing mp3/wav/m4a works)
say -o voice.m4a --file-format=m4af "Welcome to my product. Here's a quick tour."

# 4. Render with auto-zooms; the voiceover replaces the recording's own audio
#    (drop --audio-mode replace to duck the original under the narration instead)
openscreen export demo.openscreen -o demo.mp4 --auto-zoom --audio voice.m4a --audio-mode replace --json
```

## Architecture

- `electron/cli/args.ts` — pure argv parser (unit-tested in `args.test.ts`).
- `electron/cli/cliMain.ts` — headless boot: no HUD/tray/menu/dock, stdio
  protocol, signal handling, exit codes. Registers the same IPC surface as the
  GUI (`registerIpcHandlers`) with inert window callbacks.
- `src/cli/CliExportRunner.tsx` / `src/cli/CliRecordRunner.tsx` — hidden-window
  runners (`?windowType=cli-export|cli-record`) that drive the existing
  exporter classes and `useScreenRecorder` hook.
- Contracts shared between main and renderer: `src/lib/cliContracts.ts`.
