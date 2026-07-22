# Hyprland cursor position telemetry

## Context

On Linux/Wayland (specifically reported on Hyprland), the mouse cursor never appears in
OpenScreen recordings, even though it renders fine live on screen during capture.

Extensive debugging (see below) ruled out several plausible causes before landing on the
real one. This spec covers the fix for that real cause.

### What was investigated and ruled out

- **App-level cursor request**: `useScreenRecorder.ts`'s Linux capture path used the legacy
  `chromeMediaSource` constraints, which have no cursor toggle at all (unlike the `cursor`
  constraint available via `getDisplayMedia`). This was fixed (Linux now requests
  `cursor: "always"` via `getDisplayMedia`, mirroring the Windows path) and is a real,
  independent improvement, but it did **not** fix the reported bug — frame extraction from
  real recordings, before and after, showed zero cursor pixels either way.
- **Hyprland hardware-cursor-plane theory**: suspected the GPU's hardware cursor overlay
  bypasses the buffer PipeWire shares for screen capture. Config (`cursor.no_hardware_cursors`)
  and env var (`WLR_NO_HARDWARE_CURSORS`) changes were tried across multiple full reboots.
  Neither took effect, and a decisive test (recording via OBS's PipeWire capture on the same
  machine, same portal) **showed the cursor correctly** — proving the system/compositor/portal
  is not at fault.
- **DMA-BUF/EGL modifier negotiation errors** (`EGL_BAD_MATCH` in Chromium's log): real, but
  a normal/benign renegotiation that resolves after 1-2 retries at stream start. Chromium ships
  usable video either way. Not the cause.
- **`useSystemPicker` (native portal picker) toggle**: no effect, because OpenScreen's
  `setDisplayMediaRequestHandler` in `electron/main.ts` always supplies a pre-selected
  `DesktopCapturerSource` directly, so the native-picker code path never runs regardless of
  this flag.

### The actual root cause

Electron's `desktopCapturer.getSources()` creates one PipeWire ScreenCast session that is
reused for both the source-picker thumbnails *and* the later recording (confirmed via an
Electron PR description: "Chromium has been patched to use the same generic capturer to
ensure that the source IDs remain valid for `getUserMedia`"). Whatever cursor mode gets
negotiated for that shared session at thumbnail time is what the recording is stuck with —
there is no public Electron/Chromium JS API to change it per-recording. OBS works because it
opens its own dedicated ScreenCast session just for recording.

Digging further: `xdg-desktop-portal-hyprland`'s `AvailableCursorModes` is `3` (Hidden |
Embedded — no Metadata support), confirmed via a direct D-Bus query. Without Metadata mode,
there is no way to get cursor position/shape as data separate from baked-in pixels — the only
way to "read" the cursor via the portal is to decode it back out of Embedded-mode video, which
is expensive and, worse, **cannot detect a stationary cursor** (no frame-to-frame diff signal
when nothing moves).

That ruled out a portal/PipeWire-based fix entirely for this compositor. The practical
alternative: Hyprland exposes cursor position directly over its own IPC control socket
(`hyprctl cursorpos`), independent of the portal, and it reports accurate coordinates whether
the cursor is moving or sitting still (verified directly against the compositor during this
investigation).

Separately, the client-side rendering already fully supports a "position samples only, no
captured sprite" cursor overlay: `hasNativeCursorRecordingData` in `src/lib/cursor/nativeCursor.ts`
explicitly treats `provider: "none"` (today's Linux telemetry format) as valid, and draws one of
the app's existing generic pretty cursor SVGs (`src/assets/cursors/*.svg`) at the tracked
position. That path already renders correctly — it's exactly what macOS/Windows fall back to
today when they lack a captured asset. **No editor/rendering changes are needed.**

The only actual bug: `TelemetryRecordingSession` samples position via Electron's
`screen.getCursorScreenPoint()`, which returns a frozen `(0, 0)` on Hyprland (confirmed from
real recording telemetry: every sample in a captured `.webm.cursor.json` had `cx: 0, cy: 0`
for the full recording). This is a known-class Electron/wlroots limitation — unprivileged
Wayland clients generally can't query global pointer position, and `screen.getCursorScreenPoint()`
doesn't have a working fallback for wlroots compositors.

## Goal

Get an accurate cursor position stream on Hyprland, feeding the *existing*
`provider: "none"` generic-cursor overlay pipeline. No sprite/shape capture, no clicks — just
position, matching the scope of what's genuinely fixable without a portal/PipeWire-based
native module.

Out of scope, deliberately:
- Other Wayland compositors (GNOME, KDE, Sway, ...). They keep today's
  `TelemetryRecordingSession` behavior unchanged. This spec doesn't claim to fix or regress
  them — they were not part of the reported bug and weren't tested.
- Real captured cursor sprites/shapes (arrow vs. text-beam vs. resize handle, etc.) or click
  visualization on Linux. Not achievable without Metadata-mode portal support, which this
  compositor doesn't have.
- Any change to video capture itself. It already works.

## Design

### New position source: Hyprland IPC socket

Hyprland exposes a Unix domain socket for `hyprctl`-style commands at:

```
${XDG_RUNTIME_DIR}/hypr/${HYPRLAND_INSTANCE_SIGNATURE}/.socket.sock
```

Writing `j/cursorpos` to that socket and reading the response back returns JSON:
`{"x": <int>, "y": <int>}` (global/layout coordinates, i.e. same coordinate space Electron's
`screen` module uses). The server closes the connection after responding — it's one
request-response pair per connection, not a persistent session.

`HYPRLAND_INSTANCE_SIGNATURE` being set is both the detection signal ("are we running under
Hyprland?") and part of the socket path. It's already read elsewhere in this codebase
(`electron/main.ts`'s Wayland flag logic checks `XDG_SESSION_TYPE`/`WAYLAND_DISPLAY`; this is
the Hyprland-specific analogue).

### New file: `electron/native-bridge/cursor/recording/hyprlandCursorRecordingSession.ts`

Implements `CursorRecordingSession` (same interface as `TelemetryRecordingSession`,
`MacNativeCursorRecordingSession`, `WindowsNativeRecordingSession`). Shape mirrors
`TelemetryRecordingSession` closely:

- `start()`: reset sample buffer, kick off a `setInterval` at `sampleIntervalMs` (same 33ms/30Hz
  cadence already used today).
- Each tick: open a short-lived connection to the Hyprland socket, send `j/cursorpos`, parse the
  JSON response, normalize `(x, y)` against `getDisplayBounds()` into the same `cx`/`cy` (0-1
  range) format `CursorRecordingSample` already uses — reuse the exact normalization logic
  (clamp, divide by width/height) that's already in `TelemetryRecordingSession`.
- **Overlap guard**: since each sample now does socket I/O (not a synchronous call like
  `screen.getCursorScreenPoint()`), guard against a slow tick overlapping the next timer fire
  with a simple `isSampling` boolean flag — skip a tick if the previous one hasn't resolved yet,
  rather than queuing.
- **Failure handling**: if the socket connection fails or times out (Hyprland IPC hiccup, socket
  path race at startup), log a warning once and reuse the last-known good position for that
  sample rather than dropping it or crashing the recording. Recording must never fail because
  cursor telemetry hiccups.
- `stop()`: same shape as today — clear the interval, return
  `{ version: 2, provider: "none", samples, assets: [] }`.

A small internal helper (e.g. `queryHyprlandCursorPos(): Promise<{x: number, y: number} | null>`)
wraps the socket round-trip so it's independently testable (mock `net.Socket`).

### `factory.ts` change

```ts
// Linux: capture cursor positions via an interval sampler.
// Hyprland's own IPC socket gives an accurate position at any time (moving or static);
// Electron's screen.getCursorScreenPoint() is known-broken (frozen at 0,0) there. Other
// compositors don't have an equivalent IPC channel today, so they keep using the Electron API.
if (process.env.HYPRLAND_INSTANCE_SIGNATURE) {
  return new HyprlandCursorRecordingSession({ ...same options... });
}

return new TelemetryRecordingSession({ ...unchanged... });
```

No changes to `CursorRecordingSession`, `CursorRecordingData`, `CursorRecordingSample`, or any
consumer of recording data (`electron/ipc/handlers.ts`, `src/lib/cursor/nativeCursor.ts`, the
editor). The new session type produces the exact same wire format Linux already produces today
— just with real coordinates instead of frozen zeros.

## Error handling

- Socket connect/write/read errors → treated as a missed sample (reuse last known position),
  not a fatal error. Recording continues.
- `HYPRLAND_INSTANCE_SIGNATURE` set but socket missing/unreachable (e.g. mid-session Hyprland
  restart, corrupted env) → same missed-sample handling; if *every* sample fails, the recording
  still completes with a flat cursor position (current-day behavior), not a crash.
- JSON parse failure on a malformed response → treated as a missed sample.

## Testing

### Unit test

`electron/native-bridge/cursor/recording/hyprlandCursorRecordingSession.test.ts` (new), mocking
`net.createConnection` the way `useCameraDevices.test.ts` mocks `navigator.mediaDevices` — mock
socket emits a canned `{"x":100,"y":200}` response, assert the produced sample's `cx`/`cy` match
the expected normalized value against a given display-bounds rectangle. Cover: normal response,
malformed JSON, connection error (each should not throw out of `captureSample`).

### Manual test (required — no automated coverage exists for real Hyprland IPC or the video
pipeline)

1. On a Hyprland session, run OpenScreen (`npm run dev`), start a recording.
2. Move the cursor around, and also **let it sit still** for a couple of seconds in different
   spots (this is the case the old code silently failed on: diffing-based approaches lose a
   static cursor entirely).
3. Stop recording, open the result in the editor.
4. Confirm the generic cursor icon appears and tracks the recorded mouse movement, including
   staying visible/parked correctly during the still periods.
5. Inspect `<recording>.webm.cursor.json` directly if needed — samples should show varying,
   non-zero `cx`/`cy` values matching where the mouse actually was (this is exactly the file
   that proved the bug: it showed `cx: 0, cy: 0` for every sample before this fix).
