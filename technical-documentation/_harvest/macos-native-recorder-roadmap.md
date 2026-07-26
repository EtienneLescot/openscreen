# macOS Native Recorder Roadmap

OpenScreen's macOS recorder should follow the same architecture boundaries as the Windows native recorder: Electron owns session orchestration and persistence, while a platform-native helper owns capture, timing, encoding, and platform-specific permissions.

This work is intentionally scoped as a macOS-only port. Windows native capture remains owned by the WGC helper, and Linux remains on the existing Electron path.

## Goals

- Capture displays and windows through ScreenCaptureKit.
- Exclude the real system cursor during capture when using the editable OpenScreen cursor overlay.
- Preserve the current high-quality cursor overlay path in preview and export.
- Capture macOS system audio through ScreenCaptureKit on supported macOS versions.
- Capture microphone audio through the same native timing domain where the OS supports it, or through an explicit companion path until it can be moved into the helper.
- Mix system audio and microphone audio into the primary MP4 without renderer-side track assembly.
- Capture webcam video natively and compose it into the helper-owned MP4 during the native-recording migration.
- Keep screen video, audio, webcam, and cursor aligned to one native timing origin.
- Package per-architecture helper binaries with macOS builds.

## Non-Goals

- Replacing the editor/export pipeline.
- Changing Windows native capture behavior.
- Adding Linux native capture.
- Shipping a silent fallback from native macOS capture to Electron capture when the user explicitly requested a native-only feature.

## Architecture

The renderer keeps the existing recording controls. On macOS, `useScreenRecorder` should eventually send a complete recording request to Electron instead of assembling display, audio, microphone, webcam, and cursor streams in the browser.

Electron owns the native recording session:

- resolves the selected display/window source;
- resolves output paths;
- starts cursor telemetry capture when editable cursor mode is selected;
- starts the ScreenCaptureKit helper process;
- sends pause/resume/stop/cancel commands;
- writes `RecordingSession` manifests;
- reports explicit errors when a macOS-native capability is unavailable.

The helper owns macOS media capture:

- ScreenCaptureKit display/window frames;
- ScreenCaptureKit system audio where supported;
- microphone capture or helper-owned companion audio capture;
- webcam capture and initial picture-in-picture composition;
- AVFoundation/VideoToolbox encoding and muxing;
- stream timestamp normalization.

## Helper Contract V1

The helper receives a single JSON argument:

```json
{
  "schemaVersion": 1,
  "recordingId": 1234567890,
  "source": {
    "type": "display",
    "sourceId": "screen:0:0",
    "displayId": 1,
    "windowId": null,
    "bounds": { "x": 0, "y": 0, "width": 1920, "height": 1080 }
  },
  "video": {
    "fps": 60,
    "width": 1920,
    "height": 1080,
    "bitrate": 18000000,
    "hideSystemCursor": true
  },
  "audio": {
    "system": { "enabled": true },
    "microphone": {
      "enabled": true,
      "deviceId": "default",
      "deviceName": "MacBook Pro Microphone",
      "gain": 1.4
    }
  },
  "webcam": {
    "enabled": true,
    "deviceId": "default",
    "deviceName": "FaceTime HD Camera",
    "width": 1280,
    "height": 720,
    "fps": 30
  },
  "cursor": {
    "mode": "editable-overlay"
  },
  "outputs": {
    "screenPath": "/Users/me/Library/Application Support/openscreen/recordings/recording-123.mp4",
    "manifestPath": "/Users/me/Library/Application Support/openscreen/recordings/recording-123.session.json"
  }
}
```

The helper emits newline-delimited JSON events to stdout:

```json
{ "event": "ready", "schemaVersion": 1 }
{ "event": "recording-started", "timestampMs": 1234567890 }
{ "event": "warning", "code": "microphone-unavailable", "message": "..." }
{ "event": "recording-stopped", "screenPath": "..." }
{ "event": "error", "code": "screen-permission-denied", "message": "..." }
```

## Implementation Phases

Current PR status: macOS screen/window capture routes through the ScreenCaptureKit helper when it is available so editable-cursor recordings can hide the system cursor. The helper now writes ScreenCaptureKit system audio into the primary MP4 and attempts runtime-gated native microphone capture on macOS versions that expose ScreenCaptureKit microphone output. Webcam capture is currently an Electron-recorded sidecar attached to the same recording session; native AVFoundation webcam composition remains the target end state.

### 1. Native Session Boundary

- Add a structured macOS native recording request type.
- Add a macOS helper resolver and build script placeholders.
- Keep the helper contract process-based, matching the Windows helper boundary.
- Do not route production macOS recording through this helper until the helper is available and validated.

Acceptance:

- TypeScript build passes.
- The macOS helper path and request contract are documented and testable without affecting Windows/Linux behavior.

### 2. ScreenCaptureKit Display Capture

- Implement a Swift helper using ScreenCaptureKit.
- Select display captures by `displayId`.
- Encode H.264 MP4 through AVFoundation/VideoToolbox.
- Set `showsCursor = false` when editable cursor overlay mode is selected.

Acceptance:

- Display-only recording produces a valid MP4.
- The real cursor is not baked into editable-cursor recordings.

### 3. ScreenCaptureKit Window Capture

- Resolve Electron `window:*` selections to ScreenCaptureKit window ids.
- Capture `SCContentFilter(desktopIndependentWindow:)`.
- Handle closed/minimized/protected windows with explicit errors.
- Keep window selection and capture source resolution in Electron/main, not the renderer.

Acceptance:

- Capturing a normal app window works with cursor/audio/webcam disabled.
- Unsupported windows return clear native errors.

### 4. System Audio

- Enable ScreenCaptureKit system audio on supported macOS versions.
- Keep audio format and timing owned by the helper.
- Encode or mux AAC audio into the primary MP4.

Acceptance:

- System-audio-only recordings produce a valid AAC track.
- Unsupported macOS versions return an explicit capability error.

### 5. Microphone

- Resolve the selected microphone device from the renderer-provided browser `deviceId` and user-visible label.
- Capture microphone audio in the helper timing domain.
- Apply OpenScreen microphone gain policy.
- Mix system and microphone audio before final AAC output.

Acceptance:

- Mic-only and mic-plus-system recordings produce a valid, balanced AAC track.
- Device selection honors the selected microphone, not only the default device.

### 6. Webcam Composition

- Capture the selected camera natively through AVFoundation.
- Match browser device id first where possible, then user-visible label.
- Compose an initial picture-in-picture overlay into the primary MP4.
- Hide webcam output until the first usable frame to avoid black startup flashes.

Acceptance:

- Native display/window recordings can include webcam without returning to Electron capture.
- Selected camera is honored.

### 7. Runtime Controls

- Add pause/resume commands to the helper.
- Add cancel command that removes partial outputs.
- Keep restart as stop-discard-start until the helper exposes a native restart operation.

Acceptance:

- Pause/resume keeps output duration coherent.
- Cancel leaves no stale media/session files.

### 8. Test Pipeline

- `npm run build:native:mac`: builds Swift helper binaries on macOS.
- `npm run test:sck-helper:mac`: display-only helper smoke test.
- `npm run test:sck-window:mac`: window capture smoke test.
- `npm run test:sck-audio:mac`: system audio smoke test when supported.
- `npm run test:sck-mic:mac`: microphone smoke test.
- `npm run test:sck-webcam:mac`: webcam smoke test when a webcam is available.
- Packaging check: confirms helpers are available under `electron/native/bin/darwin-${arch}` in packaged builds.

## SSOT Rules

- `src/lib/nativeMacRecording.ts` is the renderer/main TypeScript request contract.
- This document is the feature-level contract and phase checklist.
- The Swift helper owns ScreenCaptureKit/AVFoundation media timing.
- Electron owns output paths, session manifests, and selected source/device resolution.
- Renderer code must use existing hooks/client APIs and should not bind directly to helper process details.
