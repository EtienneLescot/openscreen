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
import { resolveNativePosition } from "@/lib/ai-edition/timeline/timelineMap";
import {
	getCurrentNativeViewId,
	setNativePlaying,
	setNativeTime,
	subscribeNativeCompositor,
} from "./nativeCompositorStore";

export function useNativePlaybackSync(
	playing: boolean,
	currentTimeSec: number,
	/** Trim-compressed playback segments (`resolveVisibleClips`) — the native stream. */
	visibleSegments: readonly AxcutClip[],
	/** RAW clip layout (`document.timeline.clips`) `currentTimeSec` is expressed against. */
	rawClips: readonly AxcutClip[],
): void {
	const activePosition = useMemo(
		() => resolveNativePosition(currentTimeSec, [...visibleSegments], [...rawClips]),
		[visibleSegments, rawClips, currentTimeSec],
	);
	const activeClipId = activePosition?.clip.id ?? null;
	const sourceTimeSec = activePosition?.sourceTimeSec ?? null;
	// A freeze clip holds ONE frame for `frozenSec` of app-clock time. Free-running the
	// decoder through it would play the frames after the pause instead; the app clock
	// (which does traverse the freeze) then re-seeks on drift and stutters. Pausing the
	// decoder for the duration of the freeze is what makes the pause a pause — the
	// webcam track freezes with the screen track because both derive from the same
	// asset source clock the freeze stops advancing.
	const frozen = activePosition?.clip.frozenSec !== undefined;

	// Reactive "is a native view active?" so activation mid-session re-pushes the
	// current transport/playhead (time & playing aren't memoised in the store).
	const active = useSyncExternalStore(
		subscribeNativeCompositor,
		() => getCurrentNativeViewId() !== null,
	);

	// Play/pause → native free-run. Inside a freeze the native side is PAUSED however
	// the transport is set — the app clock advances through the created time while the
	// decoder holds the frame.
	useEffect(() => {
		if (!active) {
			return;
		}
		setNativePlaying(playing && !frozen);
	}, [active, playing, frozen]);

	// Scrub/step while paused OR periodic resync during playback when drift > 100ms
	const lastSyncedSourceTimeRef = useRef<number | null>(null);
	const lastSyncedWallTimeRef = useRef<number>(0);
	const lastActiveClipIdRef = useRef<string | null>(null);

	useEffect(() => {
		if (!active || sourceTimeSec === null || !activeClipId) {
			return;
		}
		const now = performance.now();

		// Inside a freeze while playing: the decoder is paused (see the transport
		// effect) and parked on the held frame. Refresh the drift refs every run so the
		// drift check never sees the (correctly) frozen source clock as divergence and
		// fights itself with repeated seeks.
		if (playing && frozen) {
			setNativeTime(sourceTimeSec);
			lastSyncedSourceTimeRef.current = sourceTimeSec;
			lastSyncedWallTimeRef.current = now;
			return;
		}

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
	}, [active, playing, frozen, activeClipId, sourceTimeSec]);
}
