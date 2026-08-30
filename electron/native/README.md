# Native capture helpers

## macOS

macOS native recording will use a ScreenCaptureKit helper with the same process boundary as the Windows WGC helper:

1. Electron resolves the selected source, output paths, and user-selected devices.
2. The helper receives one structured JSON request.
3. The helper owns ScreenCaptureKit/AVFoundation capture, timing, encoding, and muxing.
4. Electron persists the resulting media/session manifest and reports helper errors explicitly.

Helper locations:

1. `OPENSCREEN_SCK_CAPTURE_EXE`, for local development and diagnostics.
2. `electron/native/screencapturekit/build/openscreen-screencapturekit-helper`, for locally built Swift output.
3. `electron/native/bin/darwin-arm64/openscreen-screencapturekit-helper` or `electron/native/bin/darwin-x64/openscreen-screencapturekit-helper`, for packaged prebuilt helpers.

The macOS cursor-shape helper is resolved from `OPENSCREEN_MAC_CURSOR_HELPER_EXE` first, then the matching `openscreen-macos-cursor-helper` binary in the same local build and packaged `electron/native/bin/darwin-${arch}` directories.

Build the macOS helper with:

```bash
npm run build:native:mac
```

On non-macOS hosts this command exits successfully and does not affect Windows/Linux development. On macOS it builds the Swift package at `electron/native/screencapturekit`, writes the development binaries to `electron/native/screencapturekit/build`, and copies redistributable binaries to `electron/native/bin/darwin-${arch}`.

The current helper implementation supports display/window ScreenCaptureKit video capture, cursor exclusion through `SCStreamConfiguration.showsCursor`, H.264 encoding, MP4 muxing (with `AVAssetWriter.movieFragmentInterval` at 1s, so a helper that dies before `finishWriting()` still leaves a readable file — same reasoning as the Windows fragmented sink below), and ScreenCaptureKit system audio. It also attempts native ScreenCaptureKit microphone capture when the running macOS version exposes that capability. Webcam recording currently stays as an Electron sidecar and is attached to the same recording session after the native screen capture stops.

Electron exposes `is-native-mac-capture-available` for capability probing. It resolves the same helper locations listed above and reports `missing-helper` until a Swift helper binary is present. When available, macOS recording routes screen/window capture through the native helper so editable cursor recordings do not bake the system cursor into the video. Cursor positions are sampled in Electron; when the cursor helper is available and Accessibility is granted, samples are also tagged with link/text cursor hints such as `pointer`.

See `technical-documentation/architecture/recording.md` for the contract, rollout phases, and SSOT rules.

## Windows

Windows native recording is resolved from one of these locations:

1. `OPENSCREEN_WGC_CAPTURE_EXE`, for local development and diagnostics.
2. `electron/native/wgc-capture/build/wgc-capture.exe`, for a locally built Ninja helper.
3. `electron/native/wgc-capture/build/Release/wgc-capture.exe`, for a locally built multi-config helper.
4. `electron/native/bin/win32-x64/wgc-capture.exe` or `electron/native/bin/win32-arm64/wgc-capture.exe`, for packaged prebuilt helpers.

Build the Windows helper with:

```powershell
npm run build:native:win
```

The build writes the CMake output to `electron/native/wgc-capture/build/wgc-capture.exe` and copies the redistributable binary to `electron/native/bin/win32-x64/wgc-capture.exe`.

The helper contract is process-based: the app starts the process with one JSON argument and sends commands on stdin. `stop\n` finalizes the recording. During migration the helper prints both newline-delimited JSON events and the legacy text messages `Recording started` / `Recording stopped. Output path: <path>`.

Current V2 JSON shape:

```json
{
  "schemaVersion": 2,
  "recordingId": 123,
  "sourceType": "display",
  "sourceId": "screen:0:0",
  "displayId": 1,
  "windowHandle": null,
  "outputPath": "C:\\path\\recording-123.mp4",
  "videoWidth": 1920,
  "videoHeight": 1080,
  "fps": 60,
  "captureSystemAudio": false,
  "captureMic": false,
  "microphoneDeviceId": "default",
  "microphoneDeviceName": "Microphone (NVIDIA Broadcast)",
  "microphoneGain": 1.4,
  "webcamEnabled": true,
  "webcamDeviceId": "default",
  "webcamDeviceName": "Camera (NVIDIA Broadcast)",
  "webcamWidth": 1280,
  "webcamHeight": 720,
  "webcamFps": 30,
  "outputs": {
    "screenPath": "C:\\path\\recording-123.mp4"
  }
}
```

The current helper implementation supports display/window video capture, system audio loopback, selected-microphone capture, Media Foundation webcam capture, and a DirectShow webcam fallback for virtual cameras that are not exposed through Media Foundation. Webcam frames are currently composed into the primary MP4 as a bottom-right picture-in-picture overlay. Browser `deviceId` values do not always map to Media Foundation symbolic links or WASAPI endpoint IDs, so the renderer passes both browser IDs and user-visible device names. For microphones, the helper tries the requested WASAPI endpoint ID first, then resolves an active capture endpoint by `microphoneDeviceName`, then falls back to the default endpoint. For webcams, Electron resolves a matching DirectShow filter CLSID for the selected label; the helper uses Media Foundation first, then that exact DirectShow filter when the requested camera is absent from Media Foundation.

Container: recordings are written as fragmented MP4 (`MFCreateFMPEG4MediaSink` + `MFCreateSinkWriterFromMediaSink`, `MF_MPEG4SINK_MIN_FRAGMENT_DURATION` = 1s) rather than plain MP4. A plain MP4 has no index until `IMFSinkWriter::Finalize()` writes `moov` at the very end, so when the shutdown watchdog force-exits a wedged helper the file on disk holds every frame and no way to read them — that is why issues #252 / #292 / #327 cost the whole recording rather than the frozen tail of it. A fragmented MP4 writes its index up front and its samples in self-describing `moof`+`mdat` pairs, so the same kill leaves a file that plays up to the last complete fragment. This does not fix the freeze; it removes the data loss the freeze causes. Because the fragmented sink needs both output media types at construction, the sink writer is built from a media sink instead of from a URL, and the helper reads the video/audio stream positions back off the sink rather than assuming them. If any of that is unavailable on a machine, the helper retries with the plain container and says so — `container` in the `encoder-selection` event is `fragmented-mp4` or `mp4`, and it reports what was used, not what was asked for.

Encoder selection: by default the helper keeps the existing sink-writer path first. If that path fails while setting up H.264, it retries with the Microsoft software H.264 encoder (`mfh264enc.dll`). The key of this retry is registering that encoder locally in the helper process via `MFTRegisterLocalByCLSID`, which makes a software H.264 encoder available even when the machine's hardware encoders are missing or broken; hardware transforms are disabled for the retry only as a secondary guard so the sink writer prefers the locally registered software encoder, not as the fallback mechanism itself. Set `preferSoftwareEncoder: true` in the helper JSON, or set `OPENSCREEN_WGC_PREFER_SOFTWARE_ENCODER=true` before launching Electron, to force the software path from the first attempt.

Frame input path: the helper feeds the encoder from the GPU when it can. On that path it copies the WGC frame across a keyed-mutex bridge to a second D3D11 device, converts BGRA to NV12 with the D3D11 video processor, and submits an allocator-owned DXGI sample to the hardware H.264 encoder, so no frame ever passes through system memory. The alternative is the original path: a staging texture, `Map(D3D11_MAP_READ)`, and a row-by-row copy into an `IMFMediaBuffer` — which is where a driver stall costs a recording (issue #252). The GPU path is a preference, never a requirement: it is skipped outright for `preferSoftwareEncoder` and for inline webcam PiP (both need the frame in system memory), and it degrades to the CPU path on its own if the encoding device, the NV12 video processor, the shared bridge texture, the DXGI sample allocator, or the hardware sink writer is unavailable. The GPU path is OFF by default: it fixed #252 on the machine that reproduces it and broke recording outright in #336, and its fallbacks only cover failures during `initialize()`, not one that appears once frames are flowing. Set `OPENSCREEN_WGC_ENABLE_DXGI_INPUT=1` to turn it on. Because the two paths land on different encoders and hardware MFTs default to constant bitrate, the GPU path asks for VBR through `ICodecAPI`; without it a static screen spends the full configured budget (measured 16.9 Mbps against 1.95 for the same desktop).

The helper reports the outcome through the `encoder-selection` stdout event (`video` is `default`, `software-preferred`, or `software-fallback`; `videoInput` is `dxgi-nv12` or `cpu-rgb32`; `container` is `fragmented-mp4` or `mp4`; all three report what the encoder settled on rather than what was asked for). On the GPU path the helper also prints one `[frame-drops] gpu_bridge_contended=<n>` line to stderr at stop: a frame the bridge was too busy to take is skipped rather than failing the recording, and a large count there is the first thing to look at in a report about missing frames. When the app sees `software-fallback` — the default encoder failed and the helper switched on its own — it shows a small dismissible notice in the recording HUD with a "Don't show again" option, because software encoding can raise CPU usage. An explicit `software-preferred` selection shows no notice, and the event stays available for diagnostics either way.

At startup the helper also emits `capture-adapter`, naming the GPU its D3D device landed on and the one actually driving the captured display, each with its LUID, plus one `[adapters]` line per enumerated adapter on stderr. `createD3DDevice` asks for the *default* adapter and nothing checks that it is the one driving the display; when they differ every frame crosses an adapter boundary before the caller touches it. The LUIDs are there because the descriptions are not enough to tell: an IddCx virtual display driver renders through the physical GPU and inherits its description string while being a separate DXGI adapter, so the configuration this diagnostic exists to catch is precisely the one where both names are identical and only the LUIDs differ (measured: `NVIDIA Quadro RTX 4000` at LUID `0:24084` driving the display, the same string at `0:12889146` for the virtual adapter). `monitorLookup` says which of three things happened: `ok`, `no-output-claims-it` (the enumeration finished and nothing owns the captured monitor, which is what an active virtual display looks like), or `unavailable` (`EnumOutputs` refused, as it does in session 0 — the outputs were never inspected, so the absence means nothing about the hardware).

Encoder diagnostic on final sink-writer failure: when the final sink-writer attempt fails (`MFCreateSinkWriterFromMediaSink` on the fragmented container, `MFCreateSinkWriterFromURL` on the plain one; the message names which), the helper logs the registered H.264 video encoder MFT count (via `MFTEnumEx`), the registered AAC encoder count when audio was requested, and the hex HRESULT. If no H.264 encoder is registered, it additionally emits the four-bullet actionable error (missing Media Feature Pack / GPU driver registration / empty `HKLM:\SOFTWARE\Microsoft\Windows Media Foundation\Transforms` / reboot). If an H.264 encoder IS registered but the sink writer still failed, it logs a hint pointing at invalid output path, missing MP4 mux, or GPU driver incompatibility. There is still no fail-fast pre-flight gate because `MFTEnumEx` and the sink writer can disagree about which H.264 encoders are available in non-interactive / Session 0 contexts.

Smoke-test the helper with:

```powershell
npm run test:wgc-helper:win
npm run test:wgc-window:win
npm run test:wgc-audio:win
npm run test:wgc-mic:win
npm run test:wgc-mixed-audio:win
npm run test:wgc-webcam:win
```

To validate a specific native webcam manually:

```powershell
$env:OPENSCREEN_WGC_TEST_WEBCAM_DEVICE_NAME = "NVIDIA Broadcast"
npm run test:wgc-webcam:win
Remove-Item Env:OPENSCREEN_WGC_TEST_WEBCAM_DEVICE_NAME
```

To validate a specific native microphone manually:

```powershell
$env:OPENSCREEN_WGC_TEST_MICROPHONE_DEVICE_NAME = "Microphone (NVIDIA Broadcast)"
npm run test:wgc-mic:win
Remove-Item Env:OPENSCREEN_WGC_TEST_MICROPHONE_DEVICE_NAME
```

## Linux

Linux cursor recording is handled by `openscreen-pipewire-helper`
(`electron/native/pipewire-capture`). Stage 1 emits **cursor samples only** — no
video capture, no encoding.

It exists because `screen.getCursorScreenPoint()` returns `{0,0}` under Wayland.
`TelemetryRecordingSession` therefore produced well-formed recordings whose every
cursor sample sat in the top-left corner of the screen. The ScreenCast portal's
METADATA cursor mode is the only source of a real pointer position on Wayland:
the compositor keeps the cursor out of the captured pixels and attaches it to
each frame as `SPA_META_Cursor` instead.

Helper locations, in resolution order:

1. `OPENSCREEN_LINUX_CURSOR_HELPER_EXE`, for local development and diagnostics.
2. `electron/native/pipewire-capture/build/openscreen-pipewire-helper`, for a locally built binary.
3. `electron/native/bin/linux-x64/openscreen-pipewire-helper` (or `linux-arm64`), for packaged prebuilt helpers.

Build it with:

```bash
npm run build:native:linux
```

The build needs `cargo` and a C compiler and **nothing else** — in particular not
`libpipewire-0.3-dev`, which Ubuntu does not ship by default and which needs root
to install. The C shim compiles against headers vendored in
`electron/native/pipewire-capture/vendor/` and resolves `libpipewire-0.3.so.0`
with `dlopen` at runtime. On non-Linux hosts the command exits successfully.

The contract matches the other helpers: one JSON argument, newline-delimited JSON
events on stdout, `stop\n` (or EOF) on stdin. Events are `ready`, `stream-started`,
`cursor-sample`, `warning`, `error` and `debug`, each carrying `"schemaVersion": 1`.
`ready` is emitted before the portal picker is raised, so the app's readiness
timeout does not have to accommodate a human clicking a dialog; `stream-started`
marks the point where samples begin.

### Manual verification

**This raises the GNOME/portal source picker and streams until you stop it.**

```bash
OPENSCREEN_PIPEWIRE_DEBUG=1 electron/native/bin/linux-x64/openscreen-pipewire-helper '{"sampleIntervalMs":100}'
```

Pick a monitor in the dialog, move the mouse, and `cursor-sample` lines with real
coordinates should stream out. Type `stop` and press Enter, or Ctrl-D, to end it.

`OPENSCREEN_PIPEWIRE_DEBUG=1` additionally reports stream state transitions, the
negotiated SPA buffer data type, the full list of metadata blocks that survived
negotiation, and whether `SPA_META_Cursor` carries a sprite bitmap. Every line
carries `timestampMs`, so a log shows how long the stream actually lived.

### Field notes from the first real GNOME run

Two facts, and two bugs that run exposed. Both bugs are fixed; both are pinned by
tests that run without a portal.

- **mutter negotiates `MemFd`**, not DMA-BUF, even when the helper advertises
  `MemPtr|MemFd|DmaBuf`. Worth knowing for the video stage: the pixels arrive as
  a mappable fd, so a CPU path is viable and no DMA-BUF import is required.
- **`SPA_META_Cursor` was absent from every buffer.** Producers declare
  `SPA_PARAM_META_size` as a *fixed* value — mutter 46.2 uses
  `CURSOR_META_SIZE(384, 384)` = 589872 bytes — and PipeWire intersects it with
  the consumer's declaration. The helper's range was capped at 256×256 = 262192
  bytes, so the intersection was empty, the whole `ParamMeta` object was dropped,
  and the buffers arrived with no cursor metadata. There is no error for this: the
  stream negotiates and runs perfectly while reporting nothing. The ceiling is now
  1024×1024, matching OBS. A range that does not *contain* the producer's constant
  is the failure mode to remember.
- **The stream was also dying on its own**, reporting `target not found`. That
  string comes from WirePlumber's `policy-node.lua`, in the branch taken when
  `node.dont-reconnect` is set — which `PW_STREAM_FLAG_DONT_RECONNECT` sets. That
  branch destroys the node outright, turning a transient link failure into a
  permanent, silent end of capture. The flag is gone.

To exercise everything except the picker — dlopen, D-Bus, and the portal's
cursor-mode check — run the non-interactive probe. This is also what
`npm run build:native:linux` runs after a successful build:

```bash
electron/native/bin/linux-x64/openscreen-pipewire-helper '{"probeOnly":true}'
```

### Known gaps

- **Mouse clicks need the `input` group.** Wayland exposes no portal for input
  events, so the helper reads left-button presses straight from evdev
  (`/dev/input/event*`). Those nodes are `root:input`, so a user outside the
  `input` group gets no readable device and every sample's `interactionType`
  stays `"move"` — the same as before. When a device is readable, the coinciding
  sample is tagged `"click"`. Scope is deliberately narrow: `BTN_LEFT` only,
  never keystrokes (see `pipewire-capture/src/input.rs`), and
  `OPENSCREEN_DISABLE_CLICK_CAPTURE=1` turns it off entirely.
- **The user picks a source twice.** Electron's `desktopCapturer` raises its own
  portal dialog for the video, and this helper raises a second one for the cursor.
  Collapsing them requires one portal session serving both, which is why the
  capture stage has to reuse this helper's session — `SelectSources` may only be
  called once per session.

## STT helper

The speech-to-text helper (`whisper-stt-server`) is built separately from the
capture helpers. See `technical-documentation/architecture/transcription-and-captions.md` for the architecture and
`scripts/build-whisper-stt.sh` for the build command.
