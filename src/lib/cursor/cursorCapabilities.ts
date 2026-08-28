/**
 * Can this platform tell us when a mouse button was pressed?
 *
 * True on every platform we support. macOS and Windows read real button state in
 * their native cursor helpers (`macNativeCursorRecordingSession.ts`,
 * `windowsNativeRecordingSession.ts`).
 *
 * On Linux/Wayland the ScreenCast portal still reports pointer POSITION as frame
 * metadata and nothing else — there is no portal for button events. But the
 * capture helper now reads left-button presses directly from `/dev/input/event*`
 * via evdev and tags the coinciding sample `interactionType: "click"` (the
 * pipewire helper's `input.rs`; the accumulator preserves the tag in
 * `pipeWireCursorAccumulator.ts`). Those clicks travel in the `.cursor.json`
 * sidecar, populate the compositor's `CursorTrack.clicks` vector (`cursor.rs`),
 * and drive `CursorTrack::bounce()` through the shared geometry in
 * `frame_geometry.rs` — the exact same path macOS and Windows take, with no
 * Linux-specific branch.
 *
 * Reading `/dev/input` requires the recording user to be in the `input` group.
 * When they are not, no click is captured and every sample stays a plain move,
 * so the effect has nothing to act on — a recording-side permission matter, not
 * a reason to hide the control (see `website/docs/installation.md`).
 */
export function supportsCursorClickEffects(): boolean {
	return true;
}
