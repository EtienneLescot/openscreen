// Shared, ref-based playback clock written by the screen preview's rAF loop
// and read directly by any other media element that needs to stay in lockstep
// with it (currently: the webcam overlay).
//
// Why this exists: previously the webcam derived its sync target from a
// `currentTimeSec` PROP that traveled screen-video-rAF -> React state
// (VirtualPreview) -> onTimeChange callback -> React state (NewEditorShell)
// -> prop drilling back down through Preview/PreviewCanvas -> WebcamOverlay.
// Each hop adds a render pass of latency and makes the exact update cadence
// dependent on React's scheduling rather than the video's actual frame rate.
// Writing to a plain ref every rAF tick and reading it from the webcam's OWN
// rAF tick removes every one of those hops — the webcam sees the same value
// the screen just computed, this frame, with no React round trip at all.
export interface PlaybackClockSnapshot {
	/** Position on the edited/virtual timeline, in seconds. */
	virtualTimeSec: number;
	/** Position in the active screen source's own media time, in seconds. */
	sourceTimeSec: number;
	isPlaying: boolean;
	/** Active `<video>.playbackRate` for the screen source (speed regions). */
	playbackRate: number;
}

export type PlaybackClockRef = { current: PlaybackClockSnapshot };

export function createPlaybackClockRef(): PlaybackClockRef {
	return {
		current: { virtualTimeSec: 0, sourceTimeSec: 0, isPlaying: false, playbackRate: 1 },
	};
}

// ponytail: mirrors main's VideoPlayback.tsx webcam-sync tolerances — tighter
// while paused (a still frame's exact position is visually obvious and a
// seek is cheap when nothing's moving) and looser while playing (a little
// slack avoids constant re-seeking/stutter that a viewer won't perceive as
// precisely during motion).
export const CAMERA_SYNC_TOLERANCE_PAUSED_SEC = 0.05;
export const CAMERA_SYNC_TOLERANCE_PLAYING_SEC = 0.15;

export interface CameraSyncTarget {
	targetTimeSec: number;
	playbackRate: number;
	isPlaying: boolean;
	toleranceSec: number;
}

/**
 * Pure core of the camera-sync tick: given this frame's clock snapshot and
 * the currently-active camera track/position (already resolved by the
 * caller from clips+assets), compute where the camera video should be and
 * how strict to be about correcting it. Kept separate from the rAF/DOM glue
 * in WebcamOverlay so the actual sync math is unit-testable without mounting
 * a component or a real <video> element.
 */
export function resolveCameraSyncTarget(
	clock: PlaybackClockSnapshot,
	cameraTrack: { startMs: number; offsetMs: number; visible: boolean } | null,
	sourceTimeSecForActiveClip: number | null,
): CameraSyncTarget | null {
	if (!cameraTrack?.visible || sourceTimeSecForActiveClip === null) return null;
	const offsetSec = (cameraTrack.startMs + cameraTrack.offsetMs) / 1000;
	return {
		targetTimeSec: Math.max(0, sourceTimeSecForActiveClip - offsetSec),
		playbackRate: clock.playbackRate,
		isPlaying: clock.isPlaying,
		toleranceSec: clock.isPlaying
			? CAMERA_SYNC_TOLERANCE_PLAYING_SEC
			: CAMERA_SYNC_TOLERANCE_PAUSED_SEC,
	};
}
