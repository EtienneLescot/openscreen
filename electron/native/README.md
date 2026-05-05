# Native capture helpers

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
  "outputPath": "C:\\path\\recording-123.mp4",
  "videoWidth": 1920,
  "videoHeight": 1080,
  "fps": 60,
  "captureSystemAudio": false,
  "captureMic": false,
  "webcamEnabled": false,
  "outputs": {
    "screenPath": "C:\\path\\recording-123.mp4",
    "webcamPath": "C:\\path\\recording-123-webcam.mp4"
  }
}
```

The current helper implementation supports display video capture and system audio loopback. Microphone, webcam, and window capture now fail explicitly in the helper rather than silently falling back to Electron capture on Windows. See `docs/engineering/windows-native-recorder-roadmap.md` for the phased implementation plan.

Smoke-test the helper with:

```powershell
npm run test:wgc-helper:win
npm run test:wgc-audio:win
```
