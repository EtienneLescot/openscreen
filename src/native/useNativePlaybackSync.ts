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
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
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
	const activePosition = useMemo(
		() => resolveNativePlaybackPosition(clips, currentTimeSec),
		[clips, currentTimeSec],
	);
	const activeClipId = activePosition?.clip.id ?? null;
	const sourceTimeSec = activePosition?.sourceTimeSec ?? null;

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

	// Scrub/step while paused OR periodic resync during playback when drift > 100ms
	const lastSyncedSourceTimeRef = useRef<number | null>(null);
	const lastSyncedWallTimeRef = useRef<number>(0);
	const lastActiveClipIdRef = useRef<string | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: ref values
	useEffect(() => {
		if (!active || sourceTimeSec === null || !activeClipId) {
			return;
		}
		const now = performance.now();

		// When clip changes, let setActiveClip handle the atomic clip-switch-and-seek.
		if (lastActiveClipIdRef.current !== activeClipId) {
			lastActiveClipIdRef.current = activeClipId;
			lastSyncedSourceTimeRef.current = sourceTimeSec;
			lastSyncedWallTimeRef.current = now;
			return;
		}

		if (!playing) {
			setNativeTime(sourceTimeSec);
			lastSyncedSourceTimeRef.current = sourceTimeSec;
			lastSyncedWallTimeRef.current = now;
			return;
		}
		// While playing: periodically verify master clock alignment to prevent drift
		if (lastSyncedSourceTimeRef.current === null || lastSyncedWallTimeRef.current === 0) {
			lastSyncedSourceTimeRef.current = sourceTimeSec;
			lastSyncedWallTimeRef.current = now;
			return;
		}
		const wallElapsedSec = (now - lastSyncedWallTimeRef.current) / 1000;
		const expectedSourceTimeSec = lastSyncedSourceTimeRef.current + wallElapsedSec;
		if (Math.abs(sourceTimeSec - expectedSourceTimeSec) > 0.1) {
			setNativeTime(sourceTimeSec);
			lastSyncedSourceTimeRef.current = sourceTimeSec;
			lastSyncedWallTimeRef.current = now;
		}
	}, [active, playing, activeClipId, sourceTimeSec]);
}
