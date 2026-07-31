import { getPlatform } from "@/utils/platformUtils";

/**
 * Can this platform tell us when a mouse button was pressed?
 *
 * Not a preference and not a feature flag — a hard limit of the display server.
 * On Wayland an unprivileged process cannot observe mouse buttons at all: the
 * ScreenCast portal reports pointer POSITION as frame metadata and nothing else,
 * there is no portal for input events, and `/dev/input/event*` is `root:input`.
 * So the Linux capture helper stamps every sample `interactionType: "move"`
 * (see `pipeWireCursorAccumulator.ts`), the compositor's `CursorTrack.clicks`
 * vector is always empty, and `CursorTrack::bounce()` returns exactly 1.0 —
 * which `frame_geometry.rs` multiplies the cursor size by, leaving it unchanged
 * for every possible slider value.
 *
 * macOS and Windows both read real button state in their native cursor helpers
 * (`macNativeCursorRecordingSession.ts`, `windowsNativeRecordingSession.ts`), so
 * the effect works there.
 *
 * Same shape and same intent as `supportsWebcamReactiveZoom` in
 * `compositeLayout.ts`: a control that provably cannot change a pixel is
 * dropped rather than shown doing nothing.
 */
export function supportsCursorClickEffects(): boolean {
	return getPlatform() !== "linux";
}
