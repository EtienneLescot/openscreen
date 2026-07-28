import {
	clampPlaybackSpeed,
	MAX_PLAYBACK_SPEED,
	MIN_PLAYBACK_SPEED,
	type PlaybackSpeed,
} from "./types";

export type CustomPlaybackSpeedInputResult =
	| { status: "empty"; draft: string }
	| { status: "too-fast"; draft: string }
	| { status: "too-slow"; draft: string }
	| { status: "valid"; draft: string; speed: PlaybackSpeed };

export function parseCustomPlaybackSpeedInput(draft: string): CustomPlaybackSpeedInputResult {
	const normalized = Number(draft.replace(/,/g, "."));

	if (!Number.isFinite(normalized)) {
		return { status: "empty", draft };
	}
	if (normalized > MAX_PLAYBACK_SPEED) {
		return { status: "too-fast", draft };
	}
	if (normalized < MIN_PLAYBACK_SPEED) {
		return { status: "too-slow", draft };
	}
	// Reuse the shared clamp rather than re-inlining its rounding rule: this
	// value feeds the native scene, and a second copy would drift the first time
	// the bounds or the 2-decimal step change.
	return { status: "valid", draft, speed: clampPlaybackSpeed(normalized) };
}
