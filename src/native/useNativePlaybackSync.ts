/**
 * Mirrors the app's transport (play/pause) and playhead (scrub/step) onto the
 * active native compositor view. Mounted once in the editor shell; a no-op
 * whenever no native view is active (flag off / addon absent), so it's safe to
 * call unconditionally.
 *
 * Playback model — why we don't push a seek every frame:
 *  - Play/pause maps to native *free-run* (`setNativePlaying`). While playing,
 *    the native decoder advances its own frames sequentially (cheap).
 *  - `currentTimeSec` ticks every rAF frame during playback. Pushing
 *    `setNativeTime` per tick would force an O(n) rewind+decode seek each frame
 *    AND fight the free-run (the render thread prioritises app-requested frames
 *    over free-run). So discrete seeks are only sent while *paused* — i.e. real
 *    scrub/step interactions. Pausing also re-snaps native to the app playhead.
 *
 * Known POC limitation: during free-run the native clock and the app clock can
 * drift (independent tickers); acceptable for the fixture (~6 s loop). A pause
 * re-aligns them.
 */
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import {
	getCurrentNativeViewId,
	setNativePlaying,
	setNativeTime,
	subscribeNativeCompositor,
} from "./nativeCompositorStore";
import { resolveNativePlaybackPosition } from "./nativePlaybackPosition";

export function useNativePlaybackSync(
	playing: boolean,
	currentTimeSec: number,
	clips: readonly AxcutClip[],
): void {
	// `currentTimeSec` is the app's absolute timeline clock. Rust's live player expects the
	// active clip's source-media clock, including its source trim offset.
	const sourceTimeSec = useMemo(
		() => resolveNativePlaybackPosition(clips, currentTimeSec)?.sourceTimeSec ?? null,
		[clips, currentTimeSec],
	);
	// Reactive "is a native view active?" so activation mid-session re-pushes the
	// current transport/playhead (time & playing aren't memoised in the store).
	const active = useSyncExternalStore(
		subscribeNativeCompositor,
		() => getCurrentNativeViewId() !== null,
	);

	// Play/pause → native free-run.
	useEffect(() => {
		if (!active) {
			return;
		}
		setNativePlaying(playing);
	}, [active, playing]);

	// Scrub/step while paused → discrete seek (see header for why not during play).
	useEffect(() => {
		if (!active || playing || sourceTimeSec === null) {
			return;
		}
		setNativeTime(sourceTimeSec);
	}, [active, playing, sourceTimeSec]);
}
