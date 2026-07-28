import { MAX_PLAYBACK_SPEED, MIN_PLAYBACK_SPEED, type PlaybackSpeed } from "./types";

export type CustomPlaybackSpeedInputResult =
	| { status: "empty"; draft: string }
	| { status: "too-fast"; draft: string }
	| { status: "too-slow"; draft: string }
	| { status: "valid"; draft: string; speed: PlaybackSpeed };

export function parseCustomPlaybackSpeedInput(
	rawValue: string | null | undefined,
): CustomPlaybackSpeedInputResult {
	const draft = rawValue ?? "";
	const normalized = Number(draft.replace(/,/g, "."));
	const n =
		Math.round(Math.min(MAX_PLAYBACK_SPEED, Math.max(MIN_PLAYBACK_SPEED, normalized)) * 100) / 100;

	if (!Number.isFinite(normalized)) {
		return { status: "empty", draft };
	}
	if (normalized > MAX_PLAYBACK_SPEED) {
		return { status: "too-fast", draft };
	}
	if (normalized < MIN_PLAYBACK_SPEED) {
		return { status: "too-slow", draft };
	}
	return { status: "valid", draft, speed: n };
}
