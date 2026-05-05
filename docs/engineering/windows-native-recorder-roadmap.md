# Windows Native Recorder Roadmap

OpenScreen's Windows recorder should be owned by one native backend. Electron capture can remain available for non-Windows platforms and temporary developer diagnostics, but Windows production recording should not silently fall back to `getDisplayMedia` / `MediaRecorder`.

## Goals

- Capture displays and windows through Windows Graphics Capture (WGC).
- Render the native Windows cursor as OpenScreen's high-quality scalable cursor overlay.
- Capture system audio through WASAPI loopback.
- Capture microphone audio through WASAPI.
- Mix system audio and microphone audio into the primary screen recording.
- Capture webcam video natively and keep it as a separate editable OpenScreen media stream.
- Keep preview/export aligned because screen video, audio, webcam, and cursor share one native timing origin.
- Keep exported MP4s Windows-friendly: H.264 video plus AAC audio. Opus-in-MP4 is not an acceptable Windows export target.
- Package the native helper with the Windows app.

## Non-Goals

- Replacing the editor/export pipeline.
- Flattening webcam into the screen recording. The editor currently treats webcam as editable picture-in-picture media, so the native recorder should preserve a separate `webcamVideoPath`.
- Adding a native fallback for macOS or Linux in this branch.

## Target Architecture

The renderer keeps the existing recording controls. On Windows, `useScreenRecorder` sends a complete recording request to Electron and does not assemble Windows `MediaStream` tracks with `MediaRecorder`.

Electron owns the native recording session:

- resolves the selected source;
- resolves output paths;
- starts cursor sampling;
- starts the helper process;
- sends pause/resume/stop/cancel commands;
- writes `RecordingSession` manifests;
- reports explicit errors when a Windows-native capability is unavailable.

The helper owns Windows media capture:

- WGC screen/window frames;
- WASAPI system loopback;
- WASAPI microphone input;
- Media Foundation webcam capture;
- Media Foundation encoding/muxing;
- stream timestamp normalization.

## Helper Contract V2

The helper receives a single JSON argument:

```json
{
  "schemaVersion": 2,
  "recordingId": 1234567890,
  "source": {
    "type": "display",
    "sourceId": "screen:0:0",
    "displayId": 123,
    "windowHandle": null,
    "bounds": { "x": 0, "y": 0, "width": 1920, "height": 1080 }
  },
  "video": {
    "fps": 60,
    "width": 1920,
    "height": 1080,
    "bitrate": 18000000
  },
  "audio": {
    "system": { "enabled": true },
    "microphone": { "enabled": true, "deviceId": "default", "gain": 1.4 }
  },
  "webcam": {
    "enabled": true,
    "deviceId": "default",
    "width": 1280,
    "height": 720,
    "fps": 30,
    "bitrate": 18000000
  },
  "outputs": {
    "screenPath": "C:\\Users\\me\\recording-123.mp4",
    "webcamPath": "C:\\Users\\me\\recording-123-webcam.mp4",
    "manifestPath": "C:\\Users\\me\\recording-123.session.json"
  }
}
```

The helper emits newline-delimited JSON events to stdout:

```json
{ "event": "ready", "schemaVersion": 2 }
{ "event": "recording-started", "timestampMs": 1234567890 }
{ "event": "warning", "code": "audio-device-unavailable", "message": "..." }
{ "event": "recording-stopped", "screenPath": "...", "webcamPath": "..." }
{ "event": "error", "code": "unsupported-window-source", "message": "..." }
```

During migration, Electron also accepts the current textual helper messages so existing display-only smoke tests keep working.

## Implementation Phases

### 1. Native Session Boundary

- Add a structured Windows native recording request type.
- Pass source kind, audio flags, microphone device, webcam flags, and output paths into the helper.
- On Windows, do not silently fall back to Electron capture. If the helper is unavailable or a native feature is missing, show a clear error.
- Keep Electron fallback only for non-Windows and optional developer diagnostics.

Acceptance:

- Display-only recording still works.
- Enabling an unsupported native feature returns an explicit native error instead of recording through Electron.

### 2. WASAPI System Audio

Status: initial implementation landed. The helper captures the default render endpoint with WASAPI loopback, passes the runtime mix format into `MFEncoder`, and muxes AAC audio into the primary MP4. Long-run drift correction and explicit silence insertion remain follow-up hardening work.

- Add `WasapiLoopbackCapture`.
- Capture the default render endpoint in shared loopback mode.
- Keep `WasapiLoopbackCapture` responsible only for device activation, packet capture, and packet timestamps.
- Keep `MFEncoder` responsible for all Media Foundation stream definitions and muxing.
- Feed the endpoint mix format into `MFEncoder` as the single source of truth for audio stream shape: sample rate, channel count, bits per sample, block alignment, average bytes/sec, and subtype (`PCM` or `Float`).
- Encode the primary screen MP4 with H.264 video and AAC audio through one `IMFSinkWriter`.
- Timestamp audio from the captured frame count in 100ns units. The first implementation uses the WASAPI packet timeline; later drift correction will add explicit silence or resampling if long recordings show measurable clock skew.
- Treat microphone mixing as a later phase. System loopback must land first without introducing renderer-side audio code.

Acceptance:

- Screen MP4 has an AAC audio track when system audio is enabled.
- A 5-minute recording has audio/video duration drift below one frame.

SSOT rules for this phase:

- `src/lib/nativeWindowsRecording.ts` is the renderer/main TypeScript request contract.
- `docs/engineering/windows-native-recorder-roadmap.md` is the feature-level contract and phase checklist.
- `WgcSession::captureWidth()/captureHeight()` is the encoded screen frame size until a dedicated native scaling stage exists.
- `WasapiLoopbackCapture::inputFormat()` is the runtime audio format source used by `MFEncoder`.
- No duplicated hard-coded audio format assumptions in `main.cpp`.

### 3. WASAPI Microphone

- Add microphone device enumeration and stable device-id mapping.
- Capture selected/default microphone through WASAPI.
- Apply OpenScreen's current mic gain policy.
- Mix microphone and system audio before AAC encoding.

Acceptance:

- Mic-only, system-only, and mixed audio recordings produce a valid AAC track.
- Device unplug/permission failure produces an explicit error or warning.

### 4. Webcam Capture

- Add Media Foundation webcam source reader.
- Select 1280x720/30fps or nearest supported format.
- Encode webcam to `recording-<id>-webcam.mp4`.
- Synchronize webcam timestamps to the native session clock.
- Store `webcamVideoPath` in the OpenScreen session manifest.

Acceptance:

- Editor loads the native screen recording and the native webcam recording.
- Webcam layout controls behave the same as today.

### 5. Native Window Capture

- Resolve Electron `window:*` selections to an `HWND`.
- Use WGC `CreateForWindow(HWND)`.
- Handle window close, minimize, resize, DPI scaling, and monitor moves.
- Return clear errors for unsupported protected windows.

Acceptance:

- Capturing a normal app window works with cursor/audio/mic/webcam.
- Window resize and movement do not corrupt the recording.

### 6. Runtime Controls

- Add pause/resume commands to the helper.
- Add cancel command that removes partial screen/webcam outputs.
- Keep restart as stop-discard-start from Electron until the helper supports a native restart event.

Acceptance:

- Pause/resume keeps preview duration coherent.
- Cancel leaves no stale media/session/cursor files.

### 7. Test Pipeline

- `npm run test:wgc-helper:win`: display-only helper smoke test.
- `npm run test:wgc-audio:win`: validates AAC track presence and duration.
- `npm run test:wgc-window:win`: captures a fixture window by HWND.
- `npm run test:wgc-webcam:win`: validates webcam output when a webcam is available, otherwise skips explicitly.
- Packaging check: confirms the helper is in `app.asar.unpacked`.
- Export check: exported MP4s generated from native recordings keep an AAC audio track when the source has audio.

## Ship Criteria

- Windows display capture works with cursor, system audio, microphone, and webcam.
- Windows window capture works with cursor, system audio, microphone, and webcam.
- Preview and export show no cursor position drift.
- Preview and export show no measurable audio/video/webcam drift.
- Windows production builds do not depend on Electron capture fallback.
